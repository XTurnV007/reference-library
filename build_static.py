"""Export a public gallery; originals use GitHub Releases and a separate asset branch."""
from __future__ import annotations
import argparse
import json
import re
import shutil
import os
import urllib.parse
from pathlib import Path
from library import DEFAULT_DATA, connect, local_path

BASE = Path(__file__).resolve().parent


def build(root, output, repository, analytics_url=None, archive_from='d'):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('仓库格式应为 owner/repository')
    if archive_from not in ('none',*'0123456789abcdef'):
        raise ValueError('无效的原图资源分组')
    analytics_url=analytics_url if analytics_url is not None else os.environ.get('REFERENCE_LIBRARY_ANALYTICS_URL','')
    if analytics_url:
        endpoint=urllib.parse.urlsplit(analytics_url)
        if endpoint.scheme!='https' or not endpoint.netloc or endpoint.query or endpoint.fragment or endpoint.username or endpoint.password:
            raise ValueError('公开统计地址必须是 HTTPS 地址，不含查询参数、账号或密码')
    root, output = Path(root).resolve(), Path(output).resolve()
    if output == root or output.is_relative_to(root) or root.is_relative_to(output):
        raise ValueError('输出目录与数据目录不能相互包含')
    if not (root/'library.sqlite3').is_file():
        raise ValueError('未找到图库数据库，请先采集图片')
    output.mkdir(parents=True, exist_ok=True)
    html=(BASE/'static/index.html').read_text(encoding='utf-8')
    html=html.replace('href="/style.css"','href="./style.css"').replace('href="/"','href="./"')
    html=html.replace('src="/analytics.js"','src="./analytics.js"')
    html=html.replace('href="/analytics.css"','href="./analytics.css"')
    html=html.replace('<script defer src="/app.js"></script>', '<script defer src="./static-api.js"></script><script defer src="./app.js"></script>')
    html=html.replace('<button id="openSync" class="primary">＋ 采集图片</button>', '<a class="button primary" href="https://github.com/'+repository+'" target="_blank" rel="noreferrer">GitHub 项目 ↗</a>')
    html=html.replace('已下载原图','已发布原图').replace('本地图片占用','图库文件总量')
    html=html.replace('本地存储 · 离线可用','静态图库 · 持续访问')
    html=html.replace('图片只从本地读取<br>收藏、标签与备注自动持久保存','收藏、标签与备注保存在当前浏览器<br>图片公开，个人标记不上传')
    html=html.replace('服装站禁止图片数据的再分发、转载与转售。','本图库由发布者在取得授权后公开；不代表访问者取得转载授权。本项目与原站无隶属关系。')
    # Keep the shared UI's hidden sync dialog and event bindings intact.
    html=html.replace('<div class="header-actions">','<button id="openSync" hidden>采集</button><div class="header-actions">')
    (output/'index.html').write_text(html,encoding='utf-8')
    for src, name in [(BASE/'static/style.css','style.css'),(BASE/'static/app.js','app.js'),
                      (BASE/'static/analytics.js','analytics.js'),(BASE/'web/static-api.js','static-api.js')]:
        shutil.copy2(src,output/name)
    shutil.copy2(BASE/'static/analytics.css',output/'analytics.css')
    (output/'analytics-config.json').write_text(json.dumps({'base_url':analytics_url.rstrip('/')}),encoding='utf-8')
    (output/'.nojekyll').touch()
    items, originals, missing = [], {}, []
    with connect(root) as db:
        rows=db.execute('SELECT * FROM items WHERE trashed=0 ORDER BY source,remote_id').fetchall()
        for row in rows:
            # Deliberate allowlist: never publish private notes, tags, favorite flags or raw DB.
            item={k:row[k] for k in ('id','source','remote_id','title','category','system','angle','group_id','keywords')}
            item['assets']=[]
            urls={}
            assets=db.execute('SELECT * FROM assets WHERE item_id=?',(row['id'],)).fetchall()
            for asset in assets:
                if asset['status']!='done' or not asset['path']:
                    missing.append(f"{row['id']}:{asset['variant']}");continue
                path=local_path(root,asset['path'])
                if not path.is_file() or path.stat().st_size!=asset['size']:
                    missing.append(f"{row['id']}:{asset['variant']}");continue
                if asset['variant']=='original':
                    tag='originals-'+asset['sha256'][0]
                    storage='git' if archive_from!='none' and asset['sha256'][0]>=archive_from else 'release'
                    url=(f'https://raw.githubusercontent.com/{repository}/original-images/{asset["path"]}' if storage=='git'
                         else f'https://github.com/{repository}/releases/download/{tag}/{path.name}')
                    originals[path.name]={'tag':tag,'path':str(path),'sha256':asset['sha256'],'size':asset['size'],
                                          'relative':asset['path'],'storage':storage}
                else:
                    dest=output/asset['path'];dest.parent.mkdir(parents=True,exist_ok=True)
                    if not dest.exists() or dest.stat().st_size!=path.stat().st_size:shutil.copy2(path,dest)
                    url='./'+asset['path']
                urls[asset['variant']]=url
                item['assets'].append({'variant':asset['variant'],'status':'done','error':'','size':asset['size'],'path':asset['path']})
            item['preview']=urls.get('thumb') or urls.get('preview') or urls.get('original','')
            item['original']=urls.get('original','')
            item['full']=urls.get('preview') or urls.get('original') or item['preview']
            items.append(item)
    if missing:
        raise ValueError(f'有 {len(missing)} 个文件版本尚未下载完整，请先重新采集补齐。示例：'+', '.join(missing[:5]))
    if not items:raise ValueError('图库为空，未生成可发布清单')
    (output/'catalog.json').write_text(json.dumps({'version':1,'items':items},ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    # Kept outside the public directory because it contains absolute local paths.
    manifest=output.parent/'.publish-state.json'
    manifest.write_text(json.dumps({'repository':repository,'originals':list(originals.values())},indent=2),encoding='utf-8')
    size=sum(p.stat().st_size for p in output.rglob('*') if p.is_file())
    if size>=950*1024*1024:raise ValueError('静态站接近 Pages 1 GB 上限，请使用对象存储')
    print(f'静态站：{output}\n图片记录：{len(items)}，原图：{len(originals)}，站点大小：{size/1024**2:.1f} MiB')
    return manifest


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',type=Path,default=DEFAULT_DATA)
    p.add_argument('--output',type=Path,default=BASE/'site')
    p.add_argument('--repo',required=True,help='owner/repository')
    p.add_argument('--analytics-url',default=None,help='共享统计 API 的 HTTPS 基础地址')
    p.add_argument('--archive-from',default='d',choices=['none',*'0123456789abcdef'],help='此哈希首位及以后的原图改走独立 Git 资源分支，减少 API 请求')
    a=p.parse_args();build(a.data,a.output,a.repo,a.analytics_url,a.archive_from)
