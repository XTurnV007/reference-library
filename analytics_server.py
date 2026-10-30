"""Public read/event API only; no gallery editing, files, crawling or administration."""
from __future__ import annotations
import argparse
import json
import logging
import urllib.parse
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from analytics import Analytics,RateLimited
from library import connect,init


def import_catalog(root,path):
    document=json.loads(Path(path).read_text(encoding='utf-8'))
    rows=document.get('items')
    if not isinstance(rows,list) or not rows:raise ValueError('公开图片清单为空')
    seen=set()
    with connect(root) as db:
        for row in rows:
            keys=('id','source','remote_id','title','category','system','angle','group_id','keywords')
            if any(not isinstance(row.get(k),str) or len(row[k])>1000 for k in keys):raise ValueError('清单字段无效')
            if row['source'] not in ('pose','costume') or row['id'] in seen:raise ValueError('清单 ID 重复或来源无效')
            seen.add(row['id'])
        # Removed catalogue entries stop appearing publicly; historical counters remain intact.
        db.execute('UPDATE items SET trashed=1')
        for row in rows:
            db.execute('''INSERT INTO items(id,source,remote_id,title,category,system,angle,group_id,keywords,metadata)
                 VALUES (?,?,?,?,?,?,?,?,?,'{}') ON CONFLICT(id) DO UPDATE SET
                 source=excluded.source,remote_id=excluded.remote_id,title=excluded.title,category=excluded.category,
                 system=excluded.system,angle=excluded.angle,group_id=excluded.group_id,keywords=excluded.keywords,trashed=0''',
                 [row[k] for k in keys])


class Handler(BaseHTTPRequestHandler):
    server_version='GalleryAnalytics/1.0'
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self,format,*args):
        # Avoid writing visitor IPs, tokens or query strings into application logs.
        logging.info('analytics response')

    def trusted_origin(self):
        return self.headers.get('Origin') in self.server.origins

    def cors_headers(self):
        if self.trusted_origin():
            self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
        self.send_header('Vary','Origin')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')

    def reply(self,data,status=200):
        payload=json.dumps(data,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status);self.cors_headers()
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(payload)))
        if status==429:self.send_header('Retry-After','60')
        self.end_headers();self.wfile.write(payload)

    def do_OPTIONS(self):
        if self.path!='/api/analytics/events' or not self.trusted_origin():return self.reply({'error':'来源不受信任'},403)
        self.send_response(204);self.cors_headers()
        self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Content-Type')
        self.send_header('Access-Control-Max-Age','600')
        self.send_header('Content-Length','0');self.end_headers()

    def do_GET(self):
        try:
            if self.headers.get('Origin') and not self.trusted_origin():return self.reply({'error':'来源不受信任'},403)
            self.server.analytics.rate_limit('read:'+self.client_address[0],600)
            url=urllib.parse.urlsplit(self.path)
            if url.path not in ('/api/analytics/leaderboard','/api/analytics/trends','/api/analytics/item'):
                return self.reply({'error':'接口不存在'},404)
            params={k:v[0] for k,v in urllib.parse.parse_qs(url.query).items()}
            self.reply(self.server.analytics.read(url.path,params))
        except RateLimited as exc:self.reply({'error':str(exc)},429)
        except (ValueError,TypeError) as exc:self.reply({'error':str(exc)},400)
        except (BrokenPipeError,ConnectionResetError):pass
        except Exception:
            logging.exception('统计读取失败');self.reply({'error':'统计暂时不可用'},503)

    def do_POST(self):
        try:
            if self.path!='/api/analytics/events':return self.reply({'error':'接口不存在'},404)
            if not self.trusted_origin() or self.headers.get('Content-Type','').split(';')[0]!='application/json':
                return self.reply({'error':'来源或请求格式不受信任'},403)
            self.server.analytics.rate_limit('write:'+self.client_address[0],1000)
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=2048:raise ValueError('无效事件大小')
            self.reply(self.server.analytics.record(json.loads(self.rfile.read(length))))
        except RateLimited as exc:self.reply({'error':str(exc)},429)
        except (ValueError,TypeError) as exc:self.reply({'error':str(exc)},400)
        except (BrokenPipeError,ConnectionResetError):pass
        except Exception:
            logging.exception('统计写入失败');self.reply({'error':'统计暂时不可用'},503)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',type=Path,required=True,help='build_static.py 生成的 site/catalog.json')
    parser.add_argument('--data',type=Path,default=Path(__file__).parent/'analytics-data')
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=8766)
    parser.add_argument('--allow-origin',action='append',required=True,help='例如 https://xturnv007.github.io，可重复')
    args=parser.parse_args()
    for origin in args.allow_origin:
        url=urllib.parse.urlsplit(origin)
        if url.scheme not in ('http','https') or not url.netloc or url.path or url.query or url.fragment:
            parser.error('--allow-origin 必须是精确 origin，不含路径或末尾斜杠')
    init(args.data);import_catalog(args.data,args.catalog)
    service=ThreadingHTTPServer((args.host,args.port),Handler)
    service.origins=set(args.allow_origin);service.analytics=Analytics(args.data)
    logging.basicConfig(level=logging.INFO)
    logging.info('统计 API 已启动，时区 UTC+08:00；生产环境请通过 HTTPS 反向代理访问')
    try:service.serve_forever()
    except KeyboardInterrupt:pass
    finally:service.server_close()
