"""Optional loopback relay for the public Pages client. Standard library only.

No API key is configured here: each request carries the user's key in memory.
The upstream host and path are fixed; this is not an arbitrary URL proxy.
"""
from __future__ import annotations
import argparse
import http.client
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

UPSTREAM_HOST = 'ai.cursorai.art'
EDIT_PATH = '/v1/images/edits'
MAX_REQUEST = 51 * 1024**2
MAX_RESPONSE = 73 * 1024**2


class RelayHandler(BaseHTTPRequestHandler):
    server_version = 'ReferenceImageRelay/1'

    def log_message(self, *_):
        pass  # Never log headers, credentials, prompts, or upstream responses.

    def allowed(self, require_origin=True):
        port = self.server.server_port
        if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            return False
        origin = self.headers.get('Origin')
        return origin in self.server.origins or (not require_origin and origin is None)

    def reply(self, status, value=None, raw=None):
        data = raw if raw is not None else json.dumps(value or {}, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin in self.server.origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def do_OPTIONS(self):
        if not self.allowed() or self.path not in (EDIT_PATH, '/health'):
            return self.reply(403, {'error': '来源或路径未获允许'})
        return self.reply(204, raw=b'')

    def do_GET(self):
        if not self.allowed(False):
            return self.reply(403, {'error': '来源未获允许'})
        if self.path != '/health':
            return self.reply(404, {'error': '接口不存在'})
        return self.reply(200, {'ok': True, 'upstream': UPSTREAM_HOST, 'stores_key': False})

    def do_POST(self):
        if not self.allowed():
            return self.reply(403, {'error': '来源未获允许'})
        if self.path != EDIT_PATH:
            return self.reply(404, {'error': '接口不存在'})
        content_type = self.headers.get('Content-Type', '')
        if not re.fullmatch(r'multipart/form-data;\s*boundary=[A-Za-z0-9_\-".+=]{1,200}', content_type):
            return self.reply(400, {'error': '需要 multipart/form-data 图片请求'})
        authorization = self.headers.get('Authorization', '')
        if not authorization.startswith('Bearer ') or not authorization[7:].strip() or len(authorization) > 4103:
            return self.reply(401, {'error': '请填写有效 API Key'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.reply(400, {'error': '无效的请求长度'})
        if not 0 < length <= MAX_REQUEST or self.headers.get('Transfer-Encoding'):
            return self.reply(413, {'error': '请求超出大小限制'})
        if not self.server.slots.acquire(blocking=False):
            return self.reply(429, {'error': '本机转发繁忙，请稍后重试'})
        conn = None
        try:
            self.connection.settimeout(60)
            body = self.rfile.read(length)
            if len(body) != length:
                return self.reply(400, {'error': '请求未完整接收'})
            conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=900)
            conn.request('POST', EDIT_PATH, body, {
                'Accept': 'application/json', 'Authorization': authorization,
                'Content-Type': content_type, 'Content-Length': str(length),
            })
            response = conn.getresponse()
            if not 200 <= response.status < 300:
                # Do not forward diagnostic bodies that might echo a credential.
                return self.reply(response.status if 400 <= response.status < 600 else 502,
                                  {'error': '供应商拒绝请求，请查看供应商后台', 'upstream_status': response.status})
            result = response.read(MAX_RESPONSE + 1)
            if len(result) > MAX_RESPONSE:
                return self.reply(502, {'error': '供应商响应超过限制，请核对后台结果'})
            try:
                parsed = json.loads(result)
            except (ValueError, UnicodeError):
                return self.reply(502, {'error': '供应商返回非 JSON 响应，请核对后台结果'})
            if not isinstance(parsed, dict):
                return self.reply(502, {'error': '供应商响应结构无效，请核对后台结果'})
            return self.reply(200, raw=result)
        except (OSError, http.client.HTTPException):
            try:
                self.reply(502, {'error': '转发中断，供应商可能已受理。请先核对结果，勿自动重试'})
            except OSError:
                pass
        finally:
            if conn is not None:
                conn.close()
            self.server.slots.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', action='append', default=[], help='允许的其他网页来源，例如 https://your-domain.com')
    args = parser.parse_args()
    origins = {'https://xturnv007.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'}
    for origin in args.origin:
        parts = urlsplit(origin)
        if parts.scheme != 'https' or not parts.hostname or parts.path or parts.query or parts.fragment or parts.username or parts.password:
            parser.error('--origin 必须是无路径和账号密码的 HTTPS 来源')
        origins.add(origin)
    server = ThreadingHTTPServer(('127.0.0.1', 8766), RelayHandler)
    server.origins = origins
    server.slots = threading.BoundedSemaphore(2)
    print('图像转发已启动：http://127.0.0.1:8766/health', flush=True)
    print('在 GitHub 网站设置中选择「本机转发」并填写 API Key。请保持本终端打开。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
