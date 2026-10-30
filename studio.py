"""Private, single-workspace studio storage and a provider-neutral generation queue."""
from __future__ import annotations
import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from crawler import extension
from library import connect as library_db, local_path

MAX_UPLOAD=12*1024*1024


class ModelUnavailable(ValueError):
    pass


def identifier():
    return uuid.uuid4().hex


class Studio:
    """Provider contract: models() -> capabilities; generate(spec, image_paths) -> image bytes.

    No provider is installed by default. Tests may inject an offline provider. A missing
    provider never creates a fake generation job or bills an external API.
    """
    def __init__(self, root, provider=None):
        self.library_root=Path(root).resolve()
        self.root=self.library_root/'studio'
        self.files=self.root/'files';self.files.mkdir(parents=True,exist_ok=True)
        self.provider=provider;self.lock=threading.Lock();self.pool=None
        with self.db() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,
              mime TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,
              favorite INTEGER NOT NULL DEFAULT 0,trashed INTEGER NOT NULL DEFAULT 0,created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,title TEXT NOT NULL,params TEXT NOT NULL,
              created_at REAL NOT NULL,updated_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS works(id TEXT PRIMARY KEY,title TEXT NOT NULL,source TEXT NOT NULL,
              params TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,
              params TEXT NOT NULL,status TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0,created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,position INTEGER NOT NULL,
              spec TEXT NOT NULL,status TEXT NOT NULL,asset_id TEXT,error TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS results(work_id TEXT NOT NULL,asset_id TEXT NOT NULL,position INTEGER NOT NULL,
              PRIMARY KEY(work_id,position));
            CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,
              event TEXT NOT NULL,payload TEXT NOT NULL,created_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS task_job ON tasks(job_id,position);
            CREATE INDEX IF NOT EXISTS event_job ON events(job_id,id);
            ''')
            # Local jobs cannot safely be resubmitted after an unknown provider outcome.
            db.execute("UPDATE tasks SET status='interrupted',error='服务曾中断，请确认供应商任务状态后再重试' WHERE status IN ('queued','running')")
            db.execute("UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running')")

    @contextmanager
    def db(self):
        db=sqlite3.connect(self.root/'studio.sqlite3',timeout=30);db.row_factory=sqlite3.Row
        try:
            with db:yield db
        finally:db.close()

    def models(self):
        return [] if self.provider is None else self.provider.models()

    def status(self):
        return {'storage':'server','models':self.models(),'generation_available':bool(self.models()),
                'message':'模型尚未接入，可先保存草稿、上传素材和管理作品。' if not self.models() else '',
                'max_upload_bytes':MAX_UPLOAD,'private':True}

    def asset(self,row):
        data=dict(row);data.pop('path',None);data.pop('sha256',None)
        data['favorite']=bool(data['favorite']);data['trashed']=bool(data['trashed'])
        return data

    def upload(self,kind,name,payload):
        if kind not in ('person','cloth','pose','work'):raise ValueError('无效素材类型')
        if not isinstance(name,str) or not name.strip() or len(name)>180:raise ValueError('无效文件名')
        if not payload or len(payload)>MAX_UPLOAD:raise ValueError('图片须小于 12 MB')
        ext=extension(payload)
        if ext not in ('.png','.jpg','.webp'):raise ValueError('仅支持 PNG、JPG、WebP')
        digest=hashlib.sha256(payload).hexdigest();asset_id=identifier()
        mime={'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[ext]
        with self.db() as db:
            existing=db.execute('SELECT * FROM assets WHERE kind=? AND sha256=? AND trashed=0',(kind,digest)).fetchone()
            if existing:return self.asset(existing)
        path=self.files/(asset_id+ext);temp=path.with_suffix('.part')
        try:temp.write_bytes(payload);os.replace(temp,path)
        finally:temp.unlink(missing_ok=True)
        with self.db() as db:
            db.execute('INSERT INTO assets(id,kind,name,mime,path,sha256,size,created_at) VALUES (?,?,?,?,?,?,?,?)',
                       (asset_id,kind,name,mime,path.name,digest,len(payload),time.time()))
            return self.asset(db.execute('SELECT * FROM assets WHERE id=?',(asset_id,)).fetchone())

    def file(self,asset_id):
        with self.db() as db:row=db.execute('SELECT * FROM assets WHERE id=?',(asset_id,)).fetchone()
        if not row:raise ValueError('素材不存在')
        path=(self.files/row['path']).resolve()
        if not path.is_relative_to(self.files):raise ValueError('非法文件路径')
        return path

    def assets(self,kind=''):
        if kind and kind not in ('person','cloth','pose','work'):raise ValueError('无效素材类型')
        with self.db() as db:
            return [self.asset(r) for r in db.execute('SELECT * FROM assets WHERE trashed=0'+(' AND kind=?' if kind else '')+' ORDER BY created_at DESC',([kind] if kind else []))]

    def params(self,data,for_generation=False):
        if not isinstance(data,dict):raise ValueError('无效创作参数')
        prompt=data.get('prompt','');poses=data.get('poses',[])
        if not isinstance(prompt,str) or len(prompt)>6000:raise ValueError('补充描述最多 6000 字')
        if not isinstance(poses,list) or len(poses)>20:raise ValueError('最多选择 20 个姿势视角')
        refs=[data.get('person'),data.get('cloth'),*poses]
        for ref in refs:
            if ref is None:continue
            if not isinstance(ref,dict) or ref.get('source') not in ('upload','library') or not isinstance(ref.get('id'),str) or len(ref['id'])>160:
                raise ValueError('无效参考图')
        clean_ref=lambda ref:None if ref is None else {'source':ref['source'],'id':ref['id']}
        clean_poses=[clean_ref(ref) for ref in poses]
        if any(ref is None for ref in clean_poses):raise ValueError('姿势不能为空')
        if len({(ref['source'],ref['id']) for ref in clean_poses})!=len(clean_poses):raise ValueError('请勿重复选择同一姿势视角')
        variants=data.get('variants',1);width=data.get('width',1536);height=data.get('height',2048)
        if type(variants) is not int or variants not in (1,2,4):raise ValueError('每姿势可生成 1、2、4 张')
        if any(type(n) is not int or not 256<=n<=4096 for n in (width,height)):raise ValueError('无效尺寸')
        model=data.get('model','')
        if not isinstance(model,str) or len(model)>120:raise ValueError('无效模型')
        clean={'person':clean_ref(data.get('person')),'cloth':clean_ref(data.get('cloth')),'poses':clean_poses,
               'prompt':prompt,'model':model,'width':width,'height':height,'variants':variants}
        if for_generation:
            if self.provider is None:raise ModelUnavailable('模型尚未接入，未创建生成任务。')
            capability=next((m for m in self.models() if m['id']==model),None)
            if not capability:raise ValueError('模型不可用')
            if capability.get('max_refs',3)<3:raise ValueError('模型无法同时接收人像、服装和姿势参考')
            if not all([clean['person'],clean['cloth'],poses]):raise ValueError('请选好人像、服装和姿势')
            if len(poses)*variants>min(80,capability.get('max_tasks',20)):raise ValueError('任务数量超过模型限制')
            if [width,height] not in capability['sizes']:raise ValueError('模型不支持此尺寸')
            for index,ref in enumerate(refs):
                self.reference(ref,'person' if index==0 else 'cloth' if index==1 else 'pose')
        return clean

    def reference(self,ref,kind):
        if ref['source']=='upload':
            with self.db() as db:r=db.execute('SELECT kind FROM assets WHERE id=? AND trashed=0',(ref['id'],)).fetchone()
            if not r or r['kind']!=kind:raise ValueError('参考图类型不匹配或已移除')
            return self.file(ref['id'])
        if kind=='person':raise ValueError('人像请使用私有上传')
        with library_db(self.library_root) as db:
            r=db.execute("SELECT a.path FROM assets a JOIN items i ON a.item_id=i.id WHERE i.id=? AND i.source=? AND i.trashed=0 AND a.variant='original' AND a.status='done'",
                         (ref['id'],'costume' if kind=='cloth' else 'pose')).fetchone()
        if not r:raise ValueError('参考图原图尚未下载或类型不匹配')
        path=local_path(self.library_root,r['path'])
        if not path.is_file():raise ValueError('参考图片文件缺失')
        return path

    def save_draft(self,body):
        data=self.params(body.get('params',{}));draft_id=body.get('id') or identifier()
        title=body.get('title','未命名创作')
        if not isinstance(draft_id,str) or len(draft_id)>64 or not isinstance(title,str) or len(title)>100:raise ValueError('无效草稿')
        now=time.time()
        with self.db() as db:
            db.execute('''INSERT INTO drafts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                          title=excluded.title,params=excluded.params,updated_at=excluded.updated_at''',
                       (draft_id,title,json.dumps(data,ensure_ascii=False),now,now))
        return {'id':draft_id,'title':title,'params':data,'updated_at':now}

    def drafts(self):
        with self.db() as db:
            return [{**dict(r),'params':json.loads(r['params'])} for r in db.execute('SELECT * FROM drafts ORDER BY updated_at DESC')]

    def import_work(self,body):
        ids=body.get('asset_ids',[]);title=body.get('title','导入作品')
        if not isinstance(ids,list) or not 1<=len(ids)<=20 or any(not isinstance(x,str) for x in ids):raise ValueError('每次导入 1–20 张作品')
        if not isinstance(title,str) or len(title)>100:raise ValueError('作品标题最多 100 字')
        params=self.params(body.get('params',{}));work_id=identifier()
        with self.db() as db:
            for asset_id in ids:
                row=db.execute('SELECT kind FROM assets WHERE id=? AND trashed=0',(asset_id,)).fetchone()
                if not row or row['kind']!='work':raise ValueError('请选择上传的作品图片')
            db.execute('INSERT INTO works(id,title,source,params,created_at) VALUES (?,?,?,?,?)',
                       (work_id,title,'imported',json.dumps(params,ensure_ascii=False),time.time()))
            db.executemany('INSERT INTO results VALUES (?,?,?)',[(work_id,a,i) for i,a in enumerate(ids)])
        return {'id':work_id}

    def works(self):
        with self.db() as db:
            rows=[]
            for r in db.execute('SELECT * FROM works ORDER BY created_at DESC').fetchall():
                rows.append({**dict(r),'favorite':bool(r['favorite']),'params':json.loads(r['params']),
                             'results':[dict(a) for a in db.execute('SELECT asset_id,position FROM results WHERE work_id=? ORDER BY position',(r['id'],))]})
            return rows

    def edit(self,kind,body):
        table='works' if kind=='work' else 'assets';fields={}
        for key in ('favorite','trashed') if table=='assets' else ('favorite',):
            if key in body:
                if type(body[key]) is not bool:raise ValueError('无效修改')
                fields[key]=int(body[key])
        if not fields or not isinstance(body.get('id'),str):raise ValueError('无效修改')
        with self.db() as db:
            db.execute('UPDATE '+table+' SET '+','.join(k+'=?' for k in fields)+' WHERE id=?',[*fields.values(),body['id']])
        return {'ok':True}

    def event(self,db,job_id,event,payload):
        db.execute('INSERT INTO events(job_id,event,payload,created_at) VALUES (?,?,?,?)',
                   (job_id,event,json.dumps(payload,ensure_ascii=False),time.time()))

    def create(self,body, specs=None):
        # Idempotency must be resolved before revalidating a possibly unavailable provider.
        key=body.get('idempotency_key')
        if not isinstance(key,str) or not 16<=len(key)<=100:raise ValueError('缺少幂等键')
        payload=self.params(body.get('params',{}))
        encoded=json.dumps(payload,ensure_ascii=False,sort_keys=True)
        with self.db() as db:
            old=db.execute('SELECT id,params FROM jobs WHERE request_key=?',(key,)).fetchone()
            if old:
                if old['params']!=encoded:raise ValueError('幂等键对应不同的请求参数')
                return self.job(old['id'])
        payload=self.params(payload,True)
        # Resolve immutable local paths while validating each reference.
        task_specs=specs or [{'pose':pose,'variation':variation} for pose in payload['poses'] for variation in range(payload['variants'])]
        job_id=identifier()
        with self.lock:
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                old=db.execute('SELECT id,params FROM jobs WHERE request_key=?',(key,)).fetchone()
                if old:
                    if old['params']!=encoded:raise ValueError('幂等键对应不同参数')
                    return self.job(old['id'])
                if db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]>=4:
                    raise ValueError('等待中的批次较多，请稍后再试')
                db.execute('INSERT INTO jobs(id,request_key,params,status,created_at) VALUES (?,?,?,?,?)',
                           (job_id,key,encoded,'queued',time.time()))
                db.execute('INSERT INTO works(id,title,source,params,created_at) VALUES (?,?,?,?,?)',
                           (job_id,'参考图创作','generated',encoded,time.time()))
                for pos,spec in enumerate(task_specs):
                    db.execute('INSERT INTO tasks(id,job_id,position,spec,status) VALUES (?,?,?,?,?)',
                               (identifier(),job_id,pos,json.dumps(spec,ensure_ascii=False),'queued'))
                self.event(db,job_id,'queued',{'job_id':job_id,'total':len(task_specs)})
            if self.pool is None:self.pool=ThreadPoolExecutor(max_workers=2,thread_name_prefix='studio')
            self.pool.submit(self._run,job_id)
        return self.job(job_id)

    def _run(self,job_id):
        with self.db() as db:
            params=json.loads(db.execute('SELECT params FROM jobs WHERE id=?',(job_id,)).fetchone()[0])
            tasks=db.execute('SELECT * FROM tasks WHERE job_id=? ORDER BY position',(job_id,)).fetchall()
            db.execute("UPDATE jobs SET status='running' WHERE id=?",(job_id,))
        for task in tasks:
            with self.db() as db:
                cancel=db.execute('SELECT cancel FROM jobs WHERE id=?',(job_id,)).fetchone()[0]
                if cancel:
                    db.execute("UPDATE tasks SET status='cancelled' WHERE id=?",(task['id'],))
                    self.event(db,job_id,'task',{'id':task['id'],'status':'cancelled'});continue
                db.execute("UPDATE tasks SET status='running' WHERE id=?",(task['id'],))
                self.event(db,job_id,'task',{'id':task['id'],'status':'running'})
            try:
                spec=json.loads(task['spec']);paths=[self.reference(params['person'],'person'),self.reference(params['cloth'],'cloth'),self.reference(spec['pose'],'pose')]
                content=self.provider.generate({**params,**spec},paths)
                asset=self.upload('work','生成图片',content)
                with self.db() as db:
                    db.execute("UPDATE tasks SET status='done',asset_id=? WHERE id=?",(asset['id'],task['id']))
                    db.execute('INSERT OR REPLACE INTO results VALUES (?,?,?)',(job_id,asset['id'],task['position']))
                    self.event(db,job_id,'task',{'id':task['id'],'status':'done','asset_id':asset['id']})
            except Exception:
                # Supplier exceptions can contain credentials or signed URLs: do not expose them.
                with self.db() as db:
                    db.execute("UPDATE tasks SET status='failed',error='生成未完成，请检查供应商服务状态后重试' WHERE id=?",(task['id'],))
                    self.event(db,job_id,'task',{'id':task['id'],'status':'failed'})
        with self.db() as db:
            states=[r[0] for r in db.execute('SELECT status FROM tasks WHERE job_id=?',(job_id,))]
            status='cancelled' if 'cancelled' in states else 'partial' if 'failed' in states and 'done' in states else 'failed' if 'failed' in states else 'done'
            db.execute('UPDATE jobs SET status=? WHERE id=?',(status,job_id));self.event(db,job_id,'finished',{'status':status})

    def job(self,job_id):
        with self.db() as db:
            row=db.execute('SELECT id,status,params,cancel,created_at FROM jobs WHERE id=?',(job_id,)).fetchone()
            if not row:raise ValueError('任务不存在')
            return {**dict(row),'params':json.loads(row['params']),
                    'tasks':[{**dict(t),'spec':json.loads(t['spec'])} for t in db.execute('SELECT * FROM tasks WHERE job_id=? ORDER BY position',(job_id,))]}

    def jobs(self):
        with self.db() as db:ids=[r[0] for r in db.execute('SELECT id FROM jobs ORDER BY created_at DESC LIMIT 30')]
        return [self.job(i) for i in ids]

    def cancel(self,job_id):
        self.job(job_id)
        with self.db() as db:db.execute('UPDATE jobs SET cancel=1 WHERE id=?',(job_id,))
        return {'ok':True,'message':'已停止后续排队项，在途任务可能仍会完成。'}

    def retry(self,job_id,body):
        job=self.job(job_id)
        failed=[t['spec'] for t in job['tasks'] if t['status']=='failed']
        if not failed:raise ValueError('没有可重试的失败项；中断项须先核实供应商状态')
        return self.create({'params':job['params'],'idempotency_key':body.get('idempotency_key')},failed)

    def events(self,job_id,after):
        with self.db() as db:
            return [{**dict(r),'payload':json.loads(r['payload'])} for r in db.execute('SELECT * FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 100',(job_id,after))]

    def close(self):
        if self.pool:self.pool.shutdown(wait=True,cancel_futures=True)
