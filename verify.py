"""Audit saved images against stored SHA-256; optionally mark damaged objects for retry."""
import argparse
from pathlib import Path
from library import DEFAULT_DATA, connect, crawl_lock, file_hash, init, local_path


def verify(root, repair=False):
    broken, checked = [], {}
    with connect(root) as db:
        assets = db.execute("SELECT * FROM assets WHERE status='done'").fetchall()
    for asset in assets:
        relative = asset['path']
        if relative not in checked:
            try:
                checked[relative] = file_hash(local_path(root, relative))
            except (OSError, ValueError):
                checked[relative] = None
        if checked[relative] != asset['sha256']:
            broken.append((asset['item_id'], asset['variant']))
            print('损坏或缺失:', asset['item_id'], asset['variant'])
    if repair:
        with connect(root) as db:
            db.executemany("UPDATE assets SET status='failed',error='校验失败，请重新采集' WHERE item_id=? AND variant=?", broken)
    print(f'校验 {len(assets)} 条文件引用 / {len(checked)} 个唯一文件，异常 {len(broken)} 条')
    return len(broken)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=DEFAULT_DATA)
    parser.add_argument('--repair', action='store_true', help='将损坏记录标记为失败，下次采集重新下载')
    args = parser.parse_args()
    init(args.data)
    with crawl_lock(args.data):
        result = verify(args.data, args.repair)
    raise SystemExit(1 if result else 0)
