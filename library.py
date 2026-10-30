"""Shared storage for the local reference library (Python 3.10+, stdlib only)."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DEFAULT_DATA = Path(os.environ.get('REFERENCE_LIBRARY_DATA', Path(__file__).parent / 'data')).resolve()


@contextmanager
def connect(root=DEFAULT_DATA):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'library.sqlite3', timeout=60)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=60000')
    try:
        with db:
            yield db
    finally:
        db.close()


def init(root=DEFAULT_DATA):
    with connect(root) as db:
        # DELETE journal works on local disks as well as filesystems without WAL support.
        db.executescript('''
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, remote_id TEXT NOT NULL,
          title TEXT NOT NULL, category TEXT NOT NULL, system TEXT NOT NULL,
          angle TEXT NOT NULL, group_id TEXT NOT NULL, keywords TEXT NOT NULL,
          metadata TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
          tags TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
          trashed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS assets (
          item_id TEXT NOT NULL REFERENCES items(id), variant TEXT NOT NULL,
          url TEXT NOT NULL, path TEXT, sha256 TEXT, size INTEGER,
          status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(item_id, variant)
        );
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running', total INTEGER NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
          message TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS item_filters ON items(source, category, trashed);
        CREATE INDEX IF NOT EXISTS item_groups ON items(group_id);
        CREATE INDEX IF NOT EXISTS asset_status ON assets(status);
        ''')


@contextmanager
def crawl_lock(root):
    """OS advisory lock is released even if a crawler is killed. Never delete the lockfile."""
    path = Path(root) / 'crawl.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open('a+b')
    handle.seek(0)
    if handle.read(1) == b'':
        handle.write(b'0')
        handle.flush()
    handle.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RuntimeError('已有采集程序正在运行，请等待完成后重试。') from None
    try:
        yield
    finally:
        handle.close()


def upsert_items(root, items):
    with connect(root) as db:
        for item in items:
            record = {k: item[k] for k in ('id', 'source', 'remote_id', 'title', 'category',
                                         'system', 'angle', 'group_id', 'keywords', 'metadata')}
            db.execute('''INSERT INTO items
                (id,source,remote_id,title,category,system,angle,group_id,keywords,metadata)
                VALUES (:id,:source,:remote_id,:title,:category,:system,:angle,:group_id,:keywords,:metadata)
                ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,
                system=excluded.system,angle=excluded.angle,group_id=excluded.group_id,
                keywords=excluded.keywords,metadata=excluded.metadata,updated_at=CURRENT_TIMESTAMP''', record)
            for variant, url in item['assets'].items():
                db.execute('''INSERT INTO assets(item_id,variant,url) VALUES (?,?,?)
                  ON CONFLICT(item_id,variant) DO UPDATE SET url=excluded.url,
                  status=CASE WHEN assets.url=excluded.url THEN assets.status ELSE 'pending' END,
                  path=CASE WHEN assets.url=excluded.url THEN assets.path ELSE NULL END,
                  sha256=CASE WHEN assets.url=excluded.url THEN assets.sha256 ELSE NULL END,
                  size=CASE WHEN assets.url=excluded.url THEN assets.size ELSE NULL END,
                  error=CASE WHEN assets.url=excluded.url THEN assets.error ELSE '' END''',
                           (item['id'], variant, url))


def local_path(root, relative):
    if not relative:
        raise ValueError('没有本地文件')
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root / 'images'):
        raise ValueError('非法图片路径')
    return path


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def serialize_item(db, row):
    item = dict(row)
    item['tags'] = json.loads(item['tags'])
    item['favorite'] = bool(item['favorite'])
    item['trashed'] = bool(item['trashed'])
    assets = [dict(a) for a in db.execute(
        'SELECT variant,status,error,size FROM assets WHERE item_id=? ORDER BY variant', (item['id'],))]
    item['assets'] = assets
    available = {a['variant'] for a in assets if a['status'] == 'done'}
    item['preview'] = next((f'/media/{item["id"]}/{v}' for v in ('thumb', 'preview', 'original') if v in available), '')
    item['original'] = f'/media/{item["id"]}/original' if 'original' in available else ''
    return item
