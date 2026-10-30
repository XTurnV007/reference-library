"""Offline regression checks. Run with: python3 -m unittest -v"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock

from crawler import download, parse_catalog
from library import connect, init, local_path, upsert_items
from server import Handler, filters, validate_edit
from verify import verify
from build_static import build

POSE = {'id':'full_P001_front','体系':'全身','姿势编号':'P001','分类':'站姿',
        '姿势名称':'侧站','角度':'正面','缩略图':'thumbs/a.jpg','原图':'img/a.png'}
COSTUME = {'id':'SPR-0001','カテゴリ':'春','キーワード':'white coat',
           'サムネ':'thumbs/a.webp','画像':'img/a.webp','原寸':'png/a.png'}
PNG = b'\x89PNG\r\n\x1a\n' + b'test-payload'


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        init(self.root)

    def items(self):
        return parse_catalog('pose', json.dumps([POSE]))

    def assets(self):
        with connect(self.root) as db:
            return [dict(r) for r in db.execute('SELECT * FROM assets ORDER BY variant')]

    def test_real_catalogue_shapes_and_untrusted_urls(self):
        pose = self.items()[0]
        costume = parse_catalog('costume', '<script>const D = '+json.dumps([COSTUME])+'; alert(1)</script>')[0]
        self.assertEqual(len(pose['assets']), 2)
        self.assertEqual(len(costume['assets']), 3)
        self.assertEqual(pose['group_id'], 'pose:全身:P001')
        for document in ('const D=[];', 'const OTHER=[];'):
            with self.assertRaises(ValueError):
                parse_catalog('costume', document)
        with self.assertRaises(ValueError):
            parse_catalog('pose', json.dumps([{**POSE, '原图':'https://example.com/a.png'}]))
        with self.assertRaises(ValueError):
            parse_catalog('pose', json.dumps([POSE, POSE]))

    def test_refresh_preserves_user_annotations_and_invalidates_changed_url(self):
        items = self.items()
        upsert_items(self.root, items)
        with connect(self.root) as db:
            db.execute("UPDATE items SET favorite=1,tags='[\"角色A\"]',note='提示词',trashed=1")
            db.execute("UPDATE assets SET status='done',path='images/fake.png'")
        items[0]['title'] = '新标题'
        items[0]['assets']['original'] += '?v=2'
        upsert_items(self.root, items)
        with connect(self.root) as db:
            item = db.execute('SELECT * FROM items').fetchone()
            self.assertEqual((item['title'],item['favorite'],item['note'],item['trashed']), ('新标题',1,'提示词',1))
            self.assertEqual(json.loads(item['tags']), ['角色A'])
        assets = {a['variant']:a for a in self.assets()}
        self.assertEqual(assets['original']['status'], 'pending')
        self.assertIsNone(assets['original']['path'])
        self.assertEqual(assets['thumb']['status'], 'done')

    def test_dedup_resume_missing_file_and_integrity_repair(self):
        upsert_items(self.root, self.items())
        client = Mock(); client.get.return_value = PNG
        for asset in self.assets():
            self.assertTrue(download(self.root,client,asset))
        assets = self.assets()
        self.assertEqual(assets[0]['path'], assets[1]['path'])
        self.assertEqual(client.get.call_count, 2)
        self.assertTrue(download(self.root,client,assets[0]))
        self.assertEqual(client.get.call_count, 2)
        local_path(self.root, assets[0]['path']).unlink()
        self.assertTrue(download(self.root,client,assets[0]))
        self.assertEqual(client.get.call_count, 3)
        local_path(self.root, assets[0]['path']).write_bytes(b'broken')
        self.assertEqual(verify(self.root, repair=True), 2)
        self.assertTrue(all(a['status']=='failed' for a in self.assets()))
        self.assertTrue(download(self.root,client,self.assets()[0]))

    def test_error_page_is_recorded_and_retry_recovers(self):
        upsert_items(self.root, self.items())
        client = Mock(); client.get.return_value = b'<html>rate limited</html>'
        self.assertFalse(download(self.root,client,self.assets()[0]))
        asset = self.assets()[0]
        self.assertEqual(asset['status'], 'failed')
        self.assertFalse(list(self.root.glob('images/**/*.*')))
        client.get.return_value = PNG
        self.assertTrue(download(self.root,client,asset))

    def test_search_treats_sql_wildcards_literally_and_matches_tags(self):
        upsert_items(self.root, self.items())
        with connect(self.root) as db:
            db.execute('UPDATE items SET note=?,tags=?', ('100% 完成', '["角色A"]'))
            for params, expected in [({'q':'100%'},1),({'q':'100_'},0),({'tag':'角色A'},1),({'tag':'角色'},0)]:
                where, values = filters(params)
                count = db.execute('SELECT count(*) FROM items i WHERE '+where,values).fetchone()[0]
                self.assertEqual(count, expected)

    def test_edit_validation_and_path_boundaries(self):
        for changes in ({'metadata':'x'}, {'favorite':'yes'}, {'tags':['a'*51]}, {'note':False}):
            with self.assertRaises(ValueError):
                validate_edit({'ids':['pose:x'], 'changes':changes})
        ids, changes = validate_edit({'ids':['pose:x'], 'changes':{'tags':[' a ','a','']}})
        self.assertEqual(json.loads(changes['tags']), ['a'])
        with self.assertRaises(ValueError):
            local_path(self.root, '../private.txt')

    def test_http_listing_edit_media_and_origin_checks(self):
        upsert_items(self.root, self.items())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        port = server.server_address[1]
        server.data_root = self.root
        server.allowed_hosts = {f'127.0.0.1:{port}'}
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{port}'
        try:
            with urllib.request.urlopen(base+'/api/items') as response:
                self.assertEqual(json.load(response)['total'], 1)
            payload = json.dumps({'ids':[self.items()[0]['id']], 'changes':{'favorite':True}}).encode()
            request = urllib.request.Request(base+'/api/edit', data=payload,
                                             headers={'Content-Type':'application/json', 'Origin':base})
            with urllib.request.urlopen(request) as response:
                self.assertTrue(json.load(response)['ok'])
            with urllib.request.urlopen(base+'/api/stats') as response:
                self.assertEqual(json.load(response)['favorites'], 1)
            request.add_header('Origin', 'https://example.com')
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 403)
            with urllib.request.urlopen(base+'/') as response:
                self.assertIn(b'<!doctype html>', response.read())
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(base+'/media/pose:full_P001_front/original')
            self.assertEqual(error.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_static_export_excludes_private_annotations_and_uses_relative_assets(self):
        root=self.root/'data'
        init(root)
        upsert_items(root,self.items())
        client=Mock();client.get.return_value=PNG
        with connect(root) as db:
            assets=[dict(a) for a in db.execute('SELECT * FROM assets')]
            db.execute('UPDATE items SET favorite=1,tags=?,note=?',('["private-tag"]','private-note'))
        for asset in assets:self.assertTrue(download(root,client,asset))
        output=self.root/'site'
        manifest=build(root,output,'example/reference-library')
        raw=(output/'catalog.json').read_text(encoding='utf-8')
        self.assertNotIn('private-note',raw)
        self.assertNotIn('private-tag',raw)
        item=json.loads(raw)['items'][0]
        self.assertNotIn('favorite',item)
        self.assertTrue(item['preview'].startswith('./images/'))
        self.assertTrue(item['original'].startswith(('https://github.com/example/reference-library/releases/download/originals-',
                                                     'https://raw.githubusercontent.com/example/reference-library/original-images/')))
        html=(output/'gallery.html').read_text(encoding='utf-8')
        self.assertIn('src="./static-api.js"',html)
        self.assertIn('src="./analytics.js"',html)
        self.assertIn('href="./analytics.css"',html)
        self.assertNotIn('href="/style.css"',html)
        self.assertTrue((output/'analytics-config.json').is_file())
        self.assertFalse((output/'analytics-secret.bin').exists())
        platform=(output/'index.html').read_text(encoding='utf-8')
        self.assertIn('data-runtime="browser"',platform)
        self.assertIn('platform.js',platform)
        self.assertIn('image-provider.js',platform)
        self.assertTrue((output/'image-provider.js').is_file())
        self.assertIn('id="apiKey"',platform)
        self.assertTrue((output/'studio.html').is_file())
        self.assertTrue(manifest.is_file())
        self.assertFalse((output/'.publish-state.json').exists())
        with connect(root) as db:
            db.execute("UPDATE assets SET status='failed' WHERE variant='original'")
        with self.assertRaises(ValueError):build(root,self.root/'incomplete-site','example/reference-library')


if __name__ == '__main__':
    unittest.main()
