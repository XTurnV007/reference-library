"""Offline analytics regressions; no source-site or GitHub requests."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime,timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from analytics import Analytics,TZ,RateLimited
from analytics_server import Handler,import_catalog
from crawler import parse_catalog
from library import connect,init,upsert_items


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);init(self.root)
        pose={'id':'P001_front','体系':'全身','姿势编号':'P001','分类':'站姿','姿势名称':'站立',
              '角度':'正面','缩略图':'thumbs/a.jpg','原图':'img/a.png'}
        rows=[pose,{**pose,'id':'P001_back','角度':'背面'}]
        self.items=parse_catalog('pose',json.dumps(rows));upsert_items(self.root,self.items)
        self.store=Analytics(self.root,cache_seconds=0)
        self.now=datetime.now(TZ).replace(hour=12,minute=0,second=0,microsecond=0)
        self.ts=self.now.timestamp()

    def event(self,item=0,kind='view',visitor='a'*32,when=None):
        return self.store.record({'visitor':visitor,'item_id':self.items[item]['id'],
                                  'kind':kind,'dwell_ms':2000},self.ts if when is None else when)

    def test_sliding_window_and_group_dedup_across_angles(self):
        self.assertTrue(self.event()['group_counted'])
        self.assertFalse(self.event(when=self.ts+1799)['counted'])
        result=self.event(item=1,when=self.ts+10)
        self.assertTrue(result['counted']);self.assertFalse(result['group_counted'])
        self.assertTrue(self.event(when=self.ts+1800)['counted'])
        board=self.store.leaderboard('week',now=self.now)
        self.assertEqual(board['entries'][0]['views'],2)
        with connect(self.root) as db:
            self.assertEqual(db.execute('SELECT sum(views) FROM analytics_daily').fetchone()[0],3)
            visitors=[r[0] for r in db.execute('SELECT visitor FROM analytics_seen')]
            self.assertTrue(all(v!='a'*32 for v in visitors))

    def test_short_views_unknown_items_and_download_clicks(self):
        with self.assertRaises(ValueError):self.store.record({'visitor':'a'*32,'item_id':self.items[0]['id'],'kind':'view','dwell_ms':1999})
        with self.assertRaises(ValueError):self.store.record({'visitor':'a'*32,'item_id':'pose:missing','kind':'download'})
        self.event(kind='download');self.event(kind='download')
        result=self.store.item(self.items[0]['id'],self.now)
        self.assertEqual(result['total_views'],0);self.assertEqual(result['download_clicks'],1)
        self.assertEqual(self.store.leaderboard(now=self.now)['entries'],[])

    def test_midnight_does_not_reset_dedup(self):
        late=(self.now.replace(hour=0)-timedelta(minutes=1)).timestamp()
        self.event(when=late)
        self.assertFalse(self.event(when=late+120)['counted'])
        trend=self.store.trends(now=self.now)
        self.assertEqual(len(trend['daily']),30)
        self.assertEqual(trend['daily'][-1]['views'],0)
        self.assertEqual(trend['daily'][-2]['views'],1)

    def test_rising_threshold_periods_and_category_trends(self):
        group=self.items[0]['group_id'];today=self.now.date()
        with connect(self.root) as db:
            db.executemany('INSERT INTO analytics_groups(day,group_id,views) VALUES (?,?,?)',
                [(today.isoformat(),group,20),((today-timedelta(days=7)).isoformat(),group,8)])
        result=self.store.leaderboard('rising',now=self.now)['entries'][0]
        self.assertEqual((result['views'],result['previous'],result['delta']),(20,8,12))
        self.assertEqual(self.store.leaderboard('all',now=self.now)['entries'][0]['views'],28)
        trends=self.store.trends(source='pose',category='站姿',now=self.now)
        self.assertEqual(trends['category'][0]['views'],20)
        self.assertEqual(trends['category'][0]['previous'],8)
        self.assertEqual(self.store.leaderboard(category='坐姿',now=self.now)['entries'],[])
        with connect(self.root) as db:db.execute('UPDATE analytics_groups SET views=19 WHERE day=?',(today.isoformat(),))
        self.assertEqual(self.store.leaderboard('rising',now=self.now)['entries'],[])

    def test_persistence_rate_limit_and_cached_reads(self):
        self.event();again=Analytics(self.root,cache_seconds=300)
        self.assertFalse(again.record({'visitor':'a'*32,'item_id':self.items[0]['id'],'kind':'view','dwell_ms':2000},self.ts+1)['counted'])
        again.rate_limit('test',1,self.ts)
        with self.assertRaises(RateLimited):again.rate_limit('test',1,self.ts)
        first=again.read('/api/analytics/leaderboard',{'period':'all'})
        self.event(visitor='b'*32)
        self.assertEqual(again.read('/api/analytics/leaderboard',{'period':'all'}),first)
        again.cache.clear()
        self.assertEqual(again.read('/api/analytics/leaderboard',{'period':'all'})['entries'][0]['views'],2)

    def test_catalog_sync_retains_counts_and_hides_removed_items(self):
        self.event()
        path=self.root/'catalog.json';path.write_text(json.dumps({'items':[self.items[1]]}),encoding='utf-8')
        import_catalog(self.root,path)
        board=self.store.leaderboard(now=self.now)
        self.assertEqual(board['entries'][0]['id'],self.items[1]['id'])
        self.assertEqual(board['entries'][0]['views'],1)
        with self.assertRaises(ValueError):self.event(item=0,visitor='b'*32)

    def test_public_api_cors_and_management_isolation(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        server.analytics=self.store;server.origins={'https://example.github.io'}
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        try:
            payload=json.dumps({'visitor':'c'*32,'item_id':self.items[0]['id'],'kind':'view','dwell_ms':2000}).encode()
            request=urllib.request.Request(base+'/api/analytics/events',data=payload,
                headers={'Content-Type':'application/json','Origin':'https://example.github.io'})
            with urllib.request.urlopen(request) as response:
                self.assertTrue(json.load(response)['counted'])
                self.assertEqual(response.headers['Access-Control-Allow-Origin'],'https://example.github.io')
            request.add_header('Origin','https://evil.example')
            with self.assertRaises(urllib.error.HTTPError) as exc:urllib.request.urlopen(request)
            self.assertEqual(exc.exception.code,403)
            for path in ['/api/edit','/api/crawl','/api/items','/library.sqlite3']:
                with self.assertRaises(urllib.error.HTTPError) as exc:urllib.request.urlopen(base+path)
                self.assertEqual(exc.exception.code,404)
            request=urllib.request.Request(base+'/api/analytics/events',method='OPTIONS',headers={'Origin':'https://example.github.io'})
            with urllib.request.urlopen(request) as response:self.assertEqual(response.status,204)
        finally:server.shutdown();server.server_close();thread.join(timeout=2)


if __name__=='__main__':unittest.main()
