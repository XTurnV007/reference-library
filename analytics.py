"""Anonymous, deduplicated gallery counters. Calendar days use UTC+08:00."""
from __future__ import annotations
import hashlib
import hmac
import math
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from library import connect

TZ = timezone(timedelta(hours=8))
WINDOW = 1800


class RateLimited(ValueError):
    pass


class Analytics:
    def __init__(self, root, cache_seconds=300):
        self.root = Path(root)
        self.cache_seconds = cache_seconds
        self.lock = threading.Lock()
        self.cache = {}
        self.rates = {}
        key = self.root / 'analytics-secret.bin'
        try:
            with key.open('xb') as stream:
                stream.write(secrets.token_bytes(32))
            key.chmod(0o600)
        except FileExistsError:
            pass
        self.secret = key.read_bytes()
        if len(self.secret) != 32:
            raise ValueError('统计服务密钥格式错误')
        with connect(self.root) as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS analytics_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS analytics_daily(
                day TEXT NOT NULL,item_id TEXT NOT NULL,views INTEGER NOT NULL DEFAULT 0,
                downloads INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,item_id));
              CREATE TABLE IF NOT EXISTS analytics_groups(
                day TEXT NOT NULL,group_id TEXT NOT NULL,views INTEGER NOT NULL DEFAULT 0,
                downloads INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,group_id));
              CREATE TABLE IF NOT EXISTS analytics_seen(
                visitor TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,last REAL NOT NULL,
                PRIMARY KEY(visitor,target,kind));
              CREATE INDEX IF NOT EXISTS analytics_seen_time ON analytics_seen(last);
              CREATE INDEX IF NOT EXISTS analytics_item_days ON analytics_daily(item_id,day);
              CREATE INDEX IF NOT EXISTS analytics_group_days ON analytics_groups(group_id,day);
            ''')
            db.execute("INSERT OR IGNORE INTO analytics_meta VALUES ('started_at',?)",
                       (datetime.now(TZ).isoformat(timespec='seconds'),))

    def rate_limit(self, key, limit, now=None):
        now = time.time() if now is None else now
        bucket = int(now // 60)
        with self.lock:
            if len(self.rates) > 10000:
                self.rates = {k:v for k,v in self.rates.items() if v[0] == bucket}
                if len(self.rates) > 10000:
                    raise RateLimited('请求过于频繁，请稍后重试')
            old_bucket, count = self.rates.get(key, (bucket, 0))
            count = count + 1 if old_bucket == bucket else 1
            self.rates[key] = (bucket, count)
            if count > limit:
                raise RateLimited('请求过于频繁，请稍后重试')

    def record(self, body, now=None):
        now = time.time() if now is None else now
        if not isinstance(body, dict):
            raise ValueError('无效统计事件')
        token, item_id, kind = body.get('visitor'), body.get('item_id'), body.get('kind')
        if not isinstance(token,str) or not re.fullmatch(r'[a-f0-9]{32}',token):
            raise ValueError('无效匿名访客标识')
        if not isinstance(item_id,str) or len(item_id)>160 or kind not in ('view','download'):
            raise ValueError('无效统计事件')
        if kind == 'view':
            dwell = body.get('dwell_ms')
            if type(dwell) not in (int,float) or not math.isfinite(dwell) or not 2000 <= dwell <= 3600000:
                raise ValueError('有效浏览需要至少 2 秒可见停留')
        visitor = hmac.new(self.secret,token.encode(),hashlib.sha256).hexdigest()
        self.rate_limit('visitor:'+visitor,60,now)
        day = datetime.fromtimestamp(now,TZ).date().isoformat()
        column = 'views' if kind == 'view' else 'downloads'
        with connect(self.root) as db:
            db.execute('BEGIN IMMEDIATE')
            item = db.execute('SELECT group_id FROM items WHERE id=? AND trashed=0',(item_id,)).fetchone()
            if not item:
                raise ValueError('图片不存在或未公开')
            db.execute('DELETE FROM analytics_seen WHERE last<?',(now-WINDOW,))
            accepted = {}
            for scope, target, table, field in (
                ('item','item:'+item_id,'analytics_daily','item_id'),
                ('group','group:'+item['group_id'],'analytics_groups','group_id')):
                seen = db.execute('SELECT last FROM analytics_seen WHERE visitor=? AND target=? AND kind=?',
                                  (visitor,target,kind)).fetchone()
                accepted[scope] = not seen or now-seen['last'] >= WINDOW
                if accepted[scope]:
                    db.execute('''INSERT INTO analytics_seen VALUES (?,?,?,?) ON CONFLICT(visitor,target,kind)
                                  DO UPDATE SET last=excluded.last''',(visitor,target,kind,now))
                    value = item_id if scope=='item' else item['group_id']
                    db.execute(f'''INSERT INTO {table}(day,{field},{column}) VALUES (?,?,1)
                        ON CONFLICT(day,{field}) DO UPDATE SET {column}={column}+1''',(day,value))
        # Public reads intentionally remain cached for up to five minutes.
        return {'ok':True,'counted':accepted['item'],'group_counted':accepted['group']}

    def cached(self, key, loader):
        stamp = time.time()
        with self.lock:
            found = self.cache.get(key)
            if found and stamp-found[0] < self.cache_seconds:
                return found[1]
        result = loader()
        with self.lock:
            if len(self.cache)>128:
                self.cache.clear()
            self.cache[key] = (stamp,result)
        return result

    def read(self, path, params):
        source, category = params.get('source',''), params.get('category','')
        if source not in ('','pose','costume') or len(category)>100:
            raise ValueError('无效统计筛选')
        if path == '/api/analytics/leaderboard':
            period = params.get('period','week')
            if period not in ('today','week','all','rising'):
                raise ValueError('无效榜单')
            limit = max(1,min(5000,int(params.get('limit','60'))))
            result = self.cached(('board',period,source,category),lambda:self.leaderboard(period,source,category))
            return {**result,'entries':result['entries'][:limit]}
        if path == '/api/analytics/trends':
            return self.cached(('trends',source,category),lambda:self.trends(source,category))
        if path == '/api/analytics/item':
            item_id = params.get('id','')
            if len(item_id)>160:raise ValueError('无效图片')
            return self.cached(('item',item_id),lambda:self.item(item_id))
        raise ValueError('无效统计接口')

    @staticmethod
    def selection(source, category, alias='i'):
        clauses, args = [f'{alias}.trashed=0'], []
        for key,value in [('source',source),('category',category)]:
            if value:
                clauses.append(f'{alias}.{key}=?');args.append(value)
        return ' AND '.join(clauses),args

    def info(self, db):
        return {'started_at':db.execute("SELECT value FROM analytics_meta WHERE key='started_at'").fetchone()[0],
                'timezone':'UTC+08:00','cache_seconds':self.cache_seconds,
                'updated_at':datetime.now(TZ).isoformat(timespec='seconds')}

    def leaderboard(self, period='week', source='', category='', now=None):
        today=(now or datetime.now(TZ)).date()
        start=today-timedelta(days=0 if period=='today' else 6)
        previous=start-timedelta(days=1 if period=='today' else 7)
        where,args=self.selection(source,category)
        with connect(self.root) as db:
            rows=db.execute(f'''SELECT i.group_id,min(i.id) AS id,
              coalesce(sum(CASE WHEN a.day BETWEEN ? AND ? THEN a.views ELSE 0 END),0) AS views,
              coalesce(sum(CASE WHEN a.day BETWEEN ? AND ? THEN a.views ELSE 0 END),0) AS previous,
              coalesce(sum(CASE WHEN a.day BETWEEN ? AND ? THEN a.downloads ELSE 0 END),0) AS downloads
              FROM (SELECT group_id,coalesce(min(CASE WHEN angle='正面' THEN id END),min(id)) AS id
                    FROM items i WHERE {where} GROUP BY group_id) r
              JOIN items i ON i.id=r.id LEFT JOIN analytics_groups a ON a.group_id=i.group_id
              GROUP BY i.group_id''',
                [('0000-01-01' if period=='all' else start.isoformat()),today.isoformat(),
                 previous.isoformat(),(start-timedelta(days=1)).isoformat(),
                 ('0000-01-01' if period=='all' else start.isoformat()),today.isoformat(),*args]).fetchall()
            entries=[]
            for row in rows:
                entry=dict(row);entry['delta']=entry['views']-entry['previous']
                if not entry['views']:continue
                if period=='rising' and (entry['views']<20 or entry['delta']<=0):continue
                entries.append(entry)
            entries.sort(key=lambda e:(-e['delta'] if period=='rising' else -e['views'],-e['views'],e['id']))
            for index,entry in enumerate(entries,1):entry['rank']=index
            return {**self.info(db),'period':period,'entries':entries,'minimum_rising_views':20}

    def trends(self, source='', category='', now=None):
        today=(now or datetime.now(TZ)).date()
        since=(today-timedelta(days=29)).isoformat()
        where,args=self.selection(source,category)
        with connect(self.root) as db:
            join=f'''FROM analytics_groups a JOIN (SELECT group_id,min(id) id FROM items i
                     WHERE {where} GROUP BY group_id) r ON r.group_id=a.group_id JOIN items i ON i.id=r.id
                     WHERE a.day BETWEEN ? AND ?'''
            values=[*args,since,today.isoformat()]
            rows=db.execute('SELECT a.day,sum(a.views) views,sum(a.downloads) downloads '+join+' GROUP BY a.day',values).fetchall()
            by_day={r['day']:dict(r) for r in rows}
            days=[(today-timedelta(days=n)).isoformat() for n in range(29,-1,-1)]
            breakdown=[]
            for field in ('category','source'):
                parts=db.execute(f'''SELECT i.{field} value,
                  sum(CASE WHEN a.day>=? THEN a.views ELSE 0 END) views,
                  sum(CASE WHEN a.day>=? AND a.day<? THEN a.views ELSE 0 END) previous
                  '''+join+f' GROUP BY i.{field} ORDER BY views DESC LIMIT 12',
                  [(today-timedelta(days=6)).isoformat(),(today-timedelta(days=13)).isoformat(),
                   (today-timedelta(days=6)).isoformat(),*values]).fetchall()
                breakdown.append((field,[dict(p) for p in parts]))
            angle_where,angle_args=self.selection(source,category)
            angles=[dict(r) for r in db.execute(f'''SELECT i.angle value,sum(a.views) views FROM analytics_daily a
                JOIN items i ON i.id=a.item_id WHERE {angle_where} AND i.angle!='' AND a.day BETWEEN ? AND ?
                GROUP BY i.angle ORDER BY views DESC''',[*angle_args,(today-timedelta(days=6)).isoformat(),today.isoformat()])]
            return {**self.info(db),'daily':[by_day.get(d,{'day':d,'views':0,'downloads':0}) for d in days],
                    **dict(breakdown),'angles':angles}

    def item(self,item_id,now=None):
        today=(now or datetime.now(TZ)).date()
        week=(today-timedelta(days=6)).isoformat()
        with connect(self.root) as db:
            row=db.execute('SELECT group_id,source,category FROM items WHERE id=? AND trashed=0',(item_id,)).fetchone()
            if not row:raise ValueError('图片不存在或未公开')
            totals=dict(db.execute('''SELECT coalesce(sum(views),0) total_views,coalesce(sum(downloads),0) download_clicks,
                coalesce(sum(CASE WHEN day>=? THEN views ELSE 0 END),0) week_views FROM analytics_daily WHERE item_id=?''',(week,item_id)).fetchone())
            rows=db.execute('SELECT day,views,downloads FROM analytics_daily WHERE item_id=? AND day>=?',
                            (item_id,(today-timedelta(days=13)).isoformat())).fetchall()
            by_day={r['day']:dict(r) for r in rows}
            daily=[by_day.get((today-timedelta(days=n)).isoformat(),
                             {'day':(today-timedelta(days=n)).isoformat(),'views':0,'downloads':0}) for n in range(13,-1,-1)]
            group_views=db.execute('SELECT coalesce(sum(views),0) FROM analytics_groups WHERE group_id=?',(row['group_id'],)).fetchone()[0]
            info=self.info(db)
        board=self.leaderboard('week',row['source'],row['category'],now)
        rank=next((e['rank'] for e in board['entries'] if e['group_id']==row['group_id']),None)
        return {**info,**totals,'group_views':group_views,'week_category_rank':rank,'daily':daily}
