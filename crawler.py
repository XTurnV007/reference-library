"""Fetch full public catalogues and their image variants, without executing remote JS."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from pathlib import Path

from library import DEFAULT_DATA, connect, crawl_lock, init, local_path, upsert_items

SOURCES = {'pose': 'https://ai-pose-gallery.anhao.app/',
           'costume': 'https://ai-costume-gallery.pages.dev/'}
AGENT = 'LocalReferenceLibrary/1.0'
LOG = logging.getLogger('crawler')


def image_url(base, path):
    url = urllib.parse.urljoin(base, str(path))
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != 'https' or parts.netloc != urllib.parse.urlsplit(base).netloc:
        raise ValueError(f'清单中包含非本站图片地址: {url}')
    return url


def parse_catalog(source, document):
    if source == 'pose':
        rows = json.loads(document)
    else:
        match = re.search(r'\bconst\s+D\s*=\s*', document)
        if not match:
            raise ValueError('服装清单 const D 未找到，站点结构可能已变化')
        rows, _ = json.JSONDecoder().raw_decode(document[match.end():].lstrip())
    if not isinstance(rows, list) or not rows:
        raise ValueError('清单为空或格式已变化，未修改已有数据')
    items, seen = [], set()
    for row in rows:
        rid = str(row['id'])
        if not re.fullmatch(r'[A-Za-z0-9_-]+', rid) or rid in seen:
            raise ValueError(f'无效或重复的图片 ID: {rid}')
        seen.add(rid)
        if source == 'pose':
            assets = {'original': row['原图'], 'thumb': row['缩略图']}
            title, category = row['姿势名称'], row['分类']
            system, angle = row['体系'], row['角度']
            group = f"pose:{system}:{row.get('姿势编号') or rid}"
            keywords = row.get('检索', '')
        else:
            assets = {'original': row['原寸'], 'preview': row['画像'], 'thumb': row['サムネ']}
            title, category = rid, row['カテゴリ']
            system, angle, group = '', '', f'costume:{rid}'
            keywords = row.get('キーワード', '')
        items.append(dict(id=f'{source}:{rid}', source=source, remote_id=rid,
                          title=title, category=category, system=system, angle=angle,
                          group_id=group, keywords=keywords,
                          metadata=json.dumps(row, ensure_ascii=False),
                          assets={v: image_url(SOURCES[source], p) for v, p in assets.items()}))
    return items


class Client:
    def __init__(self, delay=0.5, retries=3):
        self.delay, self.retries = delay, retries
        self.lock = threading.Lock()
        self.last = 0.0
        self.robots = None

    def request(self, url, max_bytes):
        last_error = None
        for attempt in range(self.retries + 1):
            with self.lock:
                time.sleep(max(0, self.delay - (time.monotonic() - self.last)))
                self.last = time.monotonic()
            request = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Referer': url,
                                                          'Accept-Encoding': 'identity'})
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    if urllib.parse.urlsplit(response.url).netloc != urllib.parse.urlsplit(url).netloc:
                        raise ValueError('拒绝跨站重定向')
                    payload = response.read(max_bytes + 1)
                    if len(payload) > max_bytes:
                        raise ValueError('响应超过大小限制')
                    return payload, response.headers.get('Content-Type', '')
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code not in (429, 500, 502, 503, 504) or attempt == self.retries:
                    raise
                retry = exc.headers.get('Retry-After', '')
                time.sleep(min(120, int(retry)) if retry.isdigit() else 2 ** (attempt + 1))
            except (OSError, urllib.error.URLError) as exc:
                last_error = exc
                if attempt == self.retries:
                    raise
                time.sleep(2 ** (attempt + 1))
        raise RuntimeError(str(last_error))

    def load_robots(self, base):
        try:
            payload, content_type = self.request(base + 'robots.txt', 2 * 1024 * 1024)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return
            raise
        text = payload.decode('utf-8-sig')
        # Some SPA hosts serve index.html for missing robots.txt.
        if 'text/html' in content_type or text.lstrip().startswith('<'):
            return
        robots = urllib.robotparser.RobotFileParser()
        robots.parse(text.splitlines())
        self.robots = robots
        self.delay = max(self.delay, robots.crawl_delay(AGENT) or robots.crawl_delay('*') or 0)

    def get(self, url, max_bytes=128 * 1024 * 1024):
        if self.robots and not self.robots.can_fetch(AGENT, url):
            raise ValueError(f'robots.txt 禁止采集 {url}')
        return self.request(url, max_bytes)[0]


def extension(payload):
    if payload.startswith(b'\x89PNG\r\n\x1a\n'):
        return '.png'
    if payload.startswith(b'\xff\xd8\xff'):
        return '.jpg'
    if payload[:4] == b'RIFF' and payload[8:12] == b'WEBP':
        return '.webp'
    if payload[:6] in (b'GIF87a', b'GIF89a'):
        return '.gif'
    raise ValueError('响应不是支持的图片，可能是错误页')


def download(root, client, asset):
    item_id, variant = asset['item_id'], asset['variant']
    try:
        if asset['status'] == 'done' and asset['path']:
            path = local_path(root, asset['path'])
            if path.is_file() and path.stat().st_size == asset['size']:
                return True
        payload = client.get(asset['url'])
        ext = extension(payload)
        digest = hashlib.sha256(payload).hexdigest()
        relative = f'images/{digest[:2]}/{digest}{ext}'
        target = local_path(root, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Different variants/items with identical content share one object.
        temp = target.with_name(target.name + f'.{threading.get_ident()}.part')
        try:
            temp.write_bytes(payload)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        with connect(root) as db:
            db.execute('''UPDATE assets SET path=?,sha256=?,size=?,status='done',error=''
                          WHERE item_id=? AND variant=?''',
                       (relative, digest, len(payload), item_id, variant))
        return True
    except Exception as exc:
        LOG.warning('%s %s: %s', item_id, variant, exc)
        with connect(root) as db:
            db.execute("UPDATE assets SET status='failed',error=? WHERE item_id=? AND variant=?",
                       (str(exc)[:1000], item_id, variant))
        return False


def crawl(root=DEFAULT_DATA, source='all', workers=3, delay=0.5, originals_only=False):
    root = Path(root).resolve()
    init(root)
    failures = 0
    with crawl_lock(root):
        with connect(root) as db:
            db.execute("UPDATE runs SET status='interrupted',message='上次进程中断，可重新采集续传',finished_at=CURRENT_TIMESTAMP WHERE status='running'")
        for name in SOURCES if source == 'all' else [source]:
            with connect(root) as db:
                run_id = db.execute('INSERT INTO runs(source) VALUES (?)', (name,)).lastrowid
            try:
                client = Client(delay)
                client.load_robots(SOURCES[name])
                url = SOURCES[name] + ('data/pose-zh.json' if name == 'pose' else '')
                document = client.get(url, 16 * 1024 * 1024).decode('utf-8-sig')
                items = parse_catalog(name, document)
                snapshots = root / 'catalogs'
                snapshots.mkdir(exist_ok=True)
                (snapshots / f'{name}.json').write_text(
                    json.dumps(items, ensure_ascii=False, indent=2), encoding='utf-8')
                upsert_items(root, items)
                # Process only this snapshot; retain previously indexed items and annotations.
                current_ids = {item['id'] for item in items}
                with connect(root) as db:
                    assets = [dict(a) for a in db.execute('''SELECT a.* FROM assets a
                        JOIN items i ON i.id=a.item_id WHERE i.source=?''', (name,))
                              if a['item_id'] in current_ids and (not originals_only or a['variant'] == 'original')]
                    db.execute('UPDATE runs SET total=?,message=? WHERE id=?',
                               (len(assets), f'已解析 {len(items)} 条图片记录', run_id))
                completed, failed = 0, 0
                pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
                try:
                    futures = [pool.submit(download, root, client, a) for a in assets]
                    for future in concurrent.futures.as_completed(futures):
                        if not future.result():
                            failed += 1
                        completed += 1
                        with connect(root) as db:
                            db.execute('UPDATE runs SET completed=?,failed=? WHERE id=?',
                                       (completed, failed, run_id))
                        if completed % 50 == 0 or completed == len(assets):
                            LOG.info('%s %d/%d，失败 %d', name, completed, len(assets), failed)
                finally:
                    # Ctrl+C cancels queued files instead of draining the entire catalogue.
                    pool.shutdown(wait=True, cancel_futures=True)
                failures += failed
                with connect(root) as db:
                    db.execute('''UPDATE runs SET status=?,message=?,finished_at=CURRENT_TIMESTAMP WHERE id=?''',
                               ('partial' if failed else 'done', '重新采集可跳过已完成文件并补漏', run_id))
            except BaseException as exc:
                with connect(root) as db:
                    db.execute("UPDATE runs SET status='failed',message=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",
                               (str(exc) or type(exc).__name__, run_id))
                if not isinstance(exc, Exception):
                    raise
                failures += 1
                LOG.exception('%s 采集失败', name)
    return failures


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=['all', *SOURCES], default='all')
    parser.add_argument('--data', type=Path, default=DEFAULT_DATA)
    parser.add_argument('--workers', type=int, choices=range(1, 9), default=3)
    parser.add_argument('--delay', type=float, default=0.5, help='请求间隔秒，至少 0.2')
    parser.add_argument('--originals-only', action='store_true', help='仅下载原图；默认保存全部图片版本')
    args = parser.parse_args()
    if args.delay < 0.2:
        parser.error('--delay 至少 0.2 秒')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    raise SystemExit(1 if crawl(args.data, args.source, args.workers, args.delay, args.originals_only) else 0)
