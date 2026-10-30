"""Loopback-only local gallery server. Run behind an SSH tunnel for remote storage."""
from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import threading
import urllib.parse
from datetime import datetime,timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from crawler import SOURCES, crawl
from analytics import Analytics, RateLimited, TZ
from library import DEFAULT_DATA, connect, crawl_lock, init, local_path, serialize_item

STATIC = Path(__file__).parent / 'static'
JOB_LOCK = threading.Lock()


def filters(params):
    clauses, values = ['i.trashed=?'], [1 if params.get('trash') == '1' else 0]
    for key in ('source', 'category', 'system', 'angle', 'group_id'):
        if params.get(key):
            clauses.append(f'i.{key}=?')
            values.append(params[key])
    if params.get('favorite') == '1':
        clauses.append('i.favorite=1')
    if params.get('tag'):
        clauses.append('EXISTS(SELECT 1 FROM json_each(i.tags) WHERE value=?)')
        values.append(params['tag'])
    for word in params.get('q', '').split():
        clauses.append("lower(i.title||' '||i.remote_id||' '||i.category||' '||i.system||' '||i.angle||' '||i.keywords||' '||i.tags||' '||i.note) LIKE ? ESCAPE '\\'")
        escaped = word.lower().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        values.append('%' + escaped + '%')
    state = params.get('state')
    if state == 'downloaded':
        clauses.append("EXISTS(SELECT 1 FROM assets a WHERE a.item_id=i.id AND a.variant='original' AND a.status='done')")
    elif state == 'failed':
        clauses.append("EXISTS(SELECT 1 FROM assets a WHERE a.item_id=i.id AND a.status='failed')")
    elif state == 'pending':
        clauses.append("EXISTS(SELECT 1 FROM assets a WHERE a.item_id=i.id AND a.status='pending')")
    return ' AND '.join(clauses), values


def validate_edit(body):
    ids = body.get('ids')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500 or any(not isinstance(i, str) for i in ids):
        raise ValueError('每次请选择 1–500 张图片')
    changes = body.get('changes')
    if not isinstance(changes, dict) or not changes or set(changes) - {'favorite', 'trashed', 'tags', 'note'}:
        raise ValueError('无效的修改字段')
    result = {}
    for key, value in changes.items():
        if key in ('favorite', 'trashed'):
            if not isinstance(value, bool):
                raise ValueError('收藏和回收站字段必须是布尔值')
            result[key] = int(value)
        elif key == 'tags':
            if not isinstance(value, list) or len(value) > 30 or any(not isinstance(t, str) or len(t) > 50 for t in value):
                raise ValueError('最多 30 个标签，每个不超过 50 字')
            result[key] = json.dumps(list(dict.fromkeys(t.strip() for t in value if t.strip())), ensure_ascii=False)
        elif key == 'note':
            if not isinstance(value, str) or len(value) > 10000:
                raise ValueError('备注最多 10000 字')
            result[key] = value
    return ids, result


class Handler(BaseHTTPRequestHandler):
    server_version = 'ReferenceLibrary/1.0'

    def reply(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(payload)

    def trusted_host(self):
        return self.headers.get('Host', '') in self.server.allowed_hosts

    def do_GET(self):
        if not self.trusted_host():
            return self.reply({'error': '仅允许本机地址访问'}, 403)
        try:
            self.get()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except RateLimited as exc:
            self.reply({'error':str(exc)},429)
        except (ValueError, KeyError) as exc:
            self.reply({'error': str(exc)}, 400)
        except Exception:
            logging.exception('GET 请求失败')
            self.reply({'error': '服务器读取失败，请查看终端日志'}, 500)

    def get(self):
        url = urllib.parse.urlsplit(self.path)
        params = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        root = self.server.data_root
        if url.path.startswith('/api/analytics/'):
            if not hasattr(self.server,'analytics'):
                self.server.analytics = Analytics(root)
            self.server.analytics.rate_limit('read:'+self.client_address[0],600)
            return self.reply(self.server.analytics.read(url.path,params))
        if url.path in ('/api/items', '/api/export'):
            where, values = filters(params)
            page = max(1, int(params.get('page', 1)))
            limit = 60
            with connect(root) as db:
                count = db.execute('SELECT count(*) FROM items i WHERE ' + where, values).fetchone()[0]
                sql = 'SELECT i.* FROM items i WHERE ' + where + ' ORDER BY i.source,i.remote_id'
                ordering=params.get('sort','default')
                if ordering in ('week','all'):
                    if not hasattr(self.server,'analytics'):
                        self.server.analytics=Analytics(root)
                    since='0000-01-01' if ordering=='all' else (datetime.now(TZ).date()-timedelta(days=6)).isoformat()
                    sql = 'SELECT i.* FROM items i WHERE '+where+''' ORDER BY
                        coalesce((SELECT sum(a.views) FROM analytics_groups a
                        WHERE a.group_id=i.group_id AND a.day>=?),0) DESC,i.source,i.remote_id'''
                    values=[*values,since]
                if url.path == '/api/items':
                    rows = db.execute(sql + ' LIMIT ? OFFSET ?', [*values, limit, (page - 1) * limit]).fetchall()
                    return self.reply({'items': [serialize_item(db, r) for r in rows], 'total': count,
                                       'page': page, 'pages': (count + limit - 1) // limit})
                data = [serialize_item(db, r) for r in db.execute(sql, values).fetchall()]
                return self.reply({'version': 1, 'items': data})
        if url.path == '/api/stats':
            with connect(root) as db:
                result = dict(db.execute('''SELECT count(*) AS total,coalesce(sum(favorite),0) AS favorites,
                    coalesce(sum(trashed),0) AS trashed FROM items''').fetchone())
                result['downloaded'] = db.execute("SELECT count(*) FROM assets WHERE variant='original' AND status='done'").fetchone()[0]
                result['failed'] = db.execute("SELECT count(*) FROM assets WHERE status='failed'").fetchone()[0]
                result['bytes'] = db.execute('SELECT coalesce(sum(size),0) FROM (SELECT max(size) size FROM assets WHERE status=\'done\' GROUP BY path)').fetchone()[0]
                for field in ('source', 'category', 'system', 'angle'):
                    result[field] = [dict(r) for r in db.execute(
                        f"SELECT {field} AS value,count(*) AS count FROM items WHERE trashed=0 AND {field}!='' GROUP BY {field} ORDER BY {field}")]
                result['tags'] = [dict(r) for r in db.execute('''SELECT j.value,count(*) AS count FROM items i,
                     json_each(i.tags) j WHERE i.trashed=0 GROUP BY j.value ORDER BY j.value''')]
                result['runs'] = [dict(r) for r in db.execute('SELECT * FROM runs ORDER BY id DESC LIMIT 8')]
            return self.reply(result)
        if url.path.startswith('/api/item/'):
            item_id = urllib.parse.unquote(url.path[len('/api/item/'):])
            with connect(root) as db:
                row = db.execute('SELECT * FROM items WHERE id=?', (item_id,)).fetchone()
                if not row:
                    return self.reply({'error': '图片不存在'}, 404)
                item = serialize_item(db, row)
                item['siblings'] = [serialize_item(db, r) for r in db.execute(
                    'SELECT * FROM items WHERE group_id=? AND trashed=0 ORDER BY remote_id', (row['group_id'],)).fetchall()]
                return self.reply(item)
        if url.path.startswith('/media/'):
            parts = url.path.split('/')
            if len(parts) != 4:
                return self.reply({'error': '无效文件地址'}, 404)
            item_id, variant = map(urllib.parse.unquote, parts[2:])
            with connect(root) as db:
                asset = db.execute("SELECT * FROM assets WHERE item_id=? AND variant=? AND status='done'", (item_id, variant)).fetchone()
            if not asset:
                return self.reply({'error': '图片尚未下载'}, 404)
            path = local_path(root, asset['path'])
            return self.send_file(path, download=params.get('download') == '1',
                                  filename=item_id.replace(':', '_') + path.suffix)
        files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css',
                 '/analytics.js':'analytics.js','/analytics.css':'analytics.css'}
        if url.path not in files:
            return self.reply({'error': '页面不存在'}, 404)
        self.send_file(STATIC / files[url.path])

    def send_file(self, path, download=False, filename='image'):
        try:
            stream = path.open('rb')
        except FileNotFoundError:
            return self.reply({'error': '本地文件缺失，请重新采集补齐'}, 404)
        with stream:
            size = path.stat().st_size
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(size))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
            if download:
                self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.end_headers()
            while block := stream.read(256 * 1024):
                self.wfile.write(block)

    def do_POST(self):
        origin = self.headers.get('Origin')
        if (not self.trusted_host() or (origin and origin != 'http://' + self.headers.get('Host', ''))
                or self.headers.get('Sec-Fetch-Site') == 'cross-site'
                or self.headers.get('Content-Type', '').split(';')[0] != 'application/json'):
            return self.reply({'error': '请求来源不受信任'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 256 * 1024:
                raise ValueError('请求大小无效')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('请求必须是 JSON 对象')
            if self.path == '/api/analytics/events':
                if not hasattr(self.server,'analytics'):
                    self.server.analytics = Analytics(self.server.data_root)
                self.server.analytics.rate_limit('write:'+self.client_address[0],1000)
                return self.reply(self.server.analytics.record(body))
            if self.path == '/api/edit':
                ids, changes = validate_edit(body)
                assignments = ','.join(f'{key}=?' for key in changes)
                with connect(self.server.data_root) as db:
                    db.execute('UPDATE items SET ' + assignments + ',updated_at=CURRENT_TIMESTAMP WHERE id IN ('
                               + ','.join('?' for _ in ids) + ')', [*changes.values(), *ids])
                return self.reply({'ok': True})
            if self.path == '/api/crawl':
                source = body.get('source', 'all')
                if source not in ('all', *SOURCES):
                    raise ValueError('无效图库')
                if not JOB_LOCK.acquire(blocking=False):
                    return self.reply({'error': '采集正在进行'}, 409)
                try:
                    with crawl_lock(self.server.data_root):
                        pass
                except RuntimeError as exc:
                    JOB_LOCK.release()
                    return self.reply({'error': str(exc)}, 409)
                except Exception:
                    JOB_LOCK.release()
                    raise
                def work():
                    try:
                        crawl(self.server.data_root, source)
                    except Exception:
                        logging.exception('无法启动采集')
                    finally:
                        JOB_LOCK.release()
                threading.Thread(target=work, daemon=True).start()
                return self.reply({'ok': True, 'message': '采集任务已提交，进度稍后显示'}, 202)
            self.reply({'error': '接口不存在'}, 404)
        except RateLimited as exc:
            self.reply({'error':str(exc)},429)
        except (ValueError, KeyError, TypeError) as exc:
            self.reply({'error': str(exc)}, 400)
        except Exception:
            logging.exception('POST 请求失败')
            self.reply({'error': '保存失败，请查看终端日志'}, 500)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=DEFAULT_DATA)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    init(args.data)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.data_root = args.data.resolve()
    server.analytics = Analytics(server.data_root)
    server.allowed_hosts = {f'localhost:{args.port}', f'127.0.0.1:{args.port}'}
    logging.info('打开 http://127.0.0.1:%d ，数据目录 %s', args.port, server.data_root)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
