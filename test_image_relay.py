"""Loopback HTTP regression tests with a mocked upstream; no paid calls."""
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch
from image_relay import RelayHandler, MAX_REQUEST


class ImageRelayTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), RelayHandler)
        self.server.origins = {'https://xturnv007.github.io'}
        self.server.slots = threading.BoundedSemaphore(2)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path='/v1/images/edits', body=None, **headers):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        self.addCleanup(conn.close)
        conn.request(method, path, body, headers={'Origin': 'https://xturnv007.github.io', **headers})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def test_preflight_explicitly_allows_authorization(self):
        status, headers, _ = self.request('OPTIONS')
        self.assertEqual(status, 204)
        self.assertIn('Authorization', headers['Access-Control-Allow-Headers'])
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'https://xturnv007.github.io')

    @patch('image_relay.http.client.HTTPSConnection')
    def test_untrusted_origin_and_host_cannot_reach_provider(self, upstream):
        self.assertEqual(self.request('POST', Origin='https://untrusted.example')[0], 403)
        self.assertEqual(self.request('POST', Host='untrusted.example')[0], 403)
        upstream.assert_not_called()

    @patch('image_relay.http.client.HTTPSConnection')
    def test_forwards_multipart_bytes_without_rebuilding_images(self, upstream):
        output = json.dumps({'data': {'b64_json': 'fixture'}}).encode()
        response = Mock(status=200)
        response.read.return_value = output
        upstream.return_value.getresponse.return_value = response
        body = b'--fixture\r\nContent-Disposition: form-data; name="image"; filename="one.png"\r\n\r\nfixture\r\n--fixture--\r\n'
        status, _, result = self.request('POST', body=body, **{'Content-Type': 'multipart/form-data; boundary=fixture', 'Authorization': 'Bearer offline-secret'})
        self.assertEqual(status, 200)
        self.assertEqual(result, output)
        args = upstream.return_value.request.call_args.args
        self.assertEqual(args[:3], ('POST', '/v1/images/edits', body))
        self.assertEqual(args[3]['Authorization'], 'Bearer offline-secret')
        upstream.assert_called_once_with('ai.cursorai.art', timeout=900)

    @patch('image_relay.http.client.HTTPSConnection')
    def test_rejects_oversize_and_missing_credentials_before_provider(self, upstream):
        content_type = 'multipart/form-data; boundary=fixture'
        self.assertEqual(self.request('POST', **{'Content-Type': content_type})[0], 401)
        self.assertEqual(self.request('POST', **{'Content-Type': content_type, 'Authorization': 'Bearer offline-secret', 'Content-Length': str(MAX_REQUEST + 1)})[0], 413)
        upstream.assert_not_called()

    @patch('image_relay.http.client.HTTPSConnection')
    def test_provider_error_does_not_echo_secret(self, upstream):
        upstream.return_value.getresponse.return_value = Mock(status=401)
        status, _, body = self.request('POST', body=b'fixture', **{'Content-Type': 'multipart/form-data; boundary=fixture', 'Authorization': 'Bearer offline-secret'})
        self.assertEqual(status, 401)
        self.assertNotIn(b'offline-secret', body)


if __name__ == '__main__':
    unittest.main()
