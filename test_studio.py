"""Offline storage/queue/HTTP regressions; no real generation calls."""
import base64
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from library import init
from studio import Studio,ModelUnavailable
from server import Handler

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FkAAAAASUVORK5CYII=')


class OfflineProvider:
    def __init__(self):self.failed=False
    def models(self):return [{'id':'offline-test','label':'Offline fixture','sizes':[[768,1024]],'max_refs':3,'max_tasks':20}]
    def generate(self,spec,paths):
        if spec['variation']==0 and not self.failed:
            self.failed=True;raise RuntimeError('do-not-leak-provider-secret')
        return PNG


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);init(self.root)
        self.studio=Studio(self.root);self.addCleanup(self.studio.close)

    def refs(self,studio=None):
        service=studio or self.studio
        refs={kind:{'source':'upload','id':service.upload(kind,kind+'.png',PNG)['id']} for kind in ('person','cloth','pose')}
        return {'person':refs['person'],'cloth':refs['cloth'],'poses':[refs['pose']],
                'prompt':'自然光','width':768,'height':1024,'variants':2,'model':'offline-test'}

    def wait_job(self,service,job_id):
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            job=service.job(job_id)
            if job['status'] not in ('queued','running'):return job
            time.sleep(.03)
        self.fail('offline queue did not finish')

    def test_upload_privacy_dedup_and_validation(self):
        asset=self.studio.upload('person','../../portrait.png',PNG)
        self.assertNotIn('path',asset)
        self.assertTrue(self.studio.file(asset['id']).is_relative_to(self.studio.files))
        self.assertEqual(asset['id'],self.studio.upload('person','again.png',PNG)['id'])
        for kind,data in [('person',b'<svg/>'),('invalid',PNG)]:
            with self.assertRaises(ValueError):self.studio.upload(kind,'bad.png',data)
        self.studio.edit('asset',{'id':asset['id'],'favorite':True})
        self.assertTrue(self.studio.assets('person')[0]['favorite'])
        self.studio.edit('asset',{'id':asset['id'],'trashed':True})
        self.assertEqual(self.studio.assets('person'),[])
        self.assertTrue(self.studio.file(asset['id']).exists())

    def test_drafts_persist_and_extra_reference_fields_are_removed(self):
        params=self.refs();params['person']['unexpected']='discard'
        saved=self.studio.save_draft({'id':'draft-one','title':'角色 A','params':params})
        restored=Studio(self.root);self.addCleanup(restored.close)
        self.assertEqual(restored.drafts()[0]['title'],'角色 A')
        self.assertNotIn('unexpected',saved['params']['person'])
        params['poses']*=2
        with self.assertRaises(ValueError):self.studio.save_draft({'params':params})

    def test_no_model_means_no_fake_job(self):
        self.assertFalse(self.studio.status()['generation_available'])
        with self.assertRaises(ModelUnavailable):self.studio.create({'params':self.refs(),'idempotency_key':'a'*32})
        self.assertEqual(self.studio.jobs(),[])
        self.assertEqual(self.studio.works(),[])

    def test_import_work_kind_and_snapshot(self):
        params=self.refs();asset=self.studio.upload('work','result.png',PNG)
        work_id=self.studio.import_work({'title':'已有作品','asset_ids':[asset['id']],'params':params})['id']
        work=self.studio.works()[0]
        self.assertEqual((work['id'],work['source']),(work_id,'imported'))
        self.assertEqual(work['results'][0]['asset_id'],asset['id'])
        self.studio.edit('work',{'id':work_id,'favorite':True})
        self.assertTrue(self.studio.works()[0]['favorite'])
        with self.assertRaises(ValueError):self.studio.import_work({'asset_ids':[params['person']['id']]})
        self.assertEqual(len(self.studio.works()),1)

    def test_idempotency_failure_retry_and_durable_events(self):
        service=Studio(self.root,OfflineProvider());self.addCleanup(service.close)
        params=self.refs(service);body={'params':params,'idempotency_key':'b'*32}
        first=service.create(body);again=service.create(body)
        self.assertEqual(first['id'],again['id'])
        finished=self.wait_job(service,first['id'])
        self.assertEqual(finished['status'],'partial')
        self.assertEqual(len(service.works()[0]['results']),1)
        self.assertNotIn('do-not-leak-provider-secret',json.dumps(finished))
        with self.assertRaises(ValueError):service.create({**body,'params':{**params,'prompt':'changed'}})
        retry=service.retry(first['id'],{'idempotency_key':'c'*32})
        retried=self.wait_job(service,retry['id'])
        self.assertEqual(len(retried['tasks']),1)
        self.assertEqual(retried['status'],'done')
        events=service.events(first['id'],0)
        self.assertEqual(events[-1]['event'],'finished')
        self.assertEqual(service.events(first['id'],events[-1]['id']),[])

    def test_restart_marks_unknown_outcomes_interrupted(self):
        with self.studio.db() as db:
            db.execute("INSERT INTO jobs(id,request_key,params,status,created_at) VALUES ('old',?,'{}','running',?)",('d'*32,time.time()))
            db.execute("INSERT INTO tasks(id,job_id,position,spec,status) VALUES ('old-task','old',0,'{}','running')")
        reopened=Studio(self.root);self.addCleanup(reopened.close)
        self.assertEqual(reopened.job('old')['status'],'interrupted')
        self.assertEqual(reopened.job('old')['tasks'][0]['status'],'interrupted')

    def test_http_upload_and_unavailable_generation(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        server.data_root=self.root;server.studio_service=self.studio
        base=f'http://127.0.0.1:{server.server_port}'
        server.allowed_hosts={f'127.0.0.1:{server.server_port}'}
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            request=urllib.request.Request(base+'/api/studio/uploads?kind=person&name=portrait.png',data=PNG,
                headers={'Origin':base,'Content-Type':'image/png'})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status,201);asset=json.load(response)
            with urllib.request.urlopen(base+'/api/studio/files/'+asset['id']) as response:self.assertEqual(response.read(),PNG)
            request.add_header('Origin','https://evil.example')
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request)
            self.assertEqual(error.exception.code,403)
            request=urllib.request.Request(base+'/api/studio/generations',data=json.dumps({'params':self.refs(),'idempotency_key':'e'*32}).encode(),headers={'Origin':base,'Content-Type':'application/json'})
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request)
            self.assertEqual(error.exception.code,503)
            with urllib.request.urlopen(base+'/') as response:self.assertIn(b'platform.js',response.read())
            with urllib.request.urlopen(base+'/gallery.html') as response:self.assertIn(b'analytics.js',response.read())
        finally:server.shutdown();server.server_close();thread.join(timeout=2)


if __name__=='__main__':unittest.main()
