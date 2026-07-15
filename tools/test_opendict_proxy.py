from __future__ import annotations

from email.message import Message
import http.client
from http import HTTPStatus
import json
import os
import socket
import threading
import unittest
from unittest import mock
import urllib.parse

from tools import opendict_proxy as proxy


class QueryValidationTests(unittest.TestCase):
    def test_accepts_client_contract_and_preserves_pagination_start(self) -> None:
        query = proxy.parse_api_query(
            "q=%EA%B0%80&method=start&num=100&start=401&req_type=json&part=word&"
            "sort=dict&advanced=y&target=1&type1=word&type3=all"
        )

        self.assertEqual(query.word, "\uac00")
        self.assertEqual(query.method, "start")
        self.assertEqual(query.num, 100)
        self.assertEqual(query.start, 401)

    def test_rejects_all_client_side_secret_parameter_spellings(self) -> None:
        for name in ("key", "KEY", "api_key", "apiKey", "token", "access_token"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(proxy.RequestValidationError, "must not be sent"):
                    proxy.parse_api_query(f"q=%EA%B0%80&{name}=secret")

    def test_rejects_duplicates_unknowns_and_invalid_fixed_values(self) -> None:
        invalid_queries = (
            "q=%EA%B0%80&q=%EB%82%98",
            "q=%EA%B0%80&unexpected=1",
            "q=%EA%B0%80&req_type=xml",
            "q=%EA%B0%80&method=contains",
            "q=%EA%B0%80&num=0",
            "q=%EA%B0%80&num=",
            "q=%EA%B0%80&num=101",
            "q=%EA%B0%80&start=0",
            "q=%EA%B0%80&start=",
            "q=%EA%B0%80&start=1001",
            "q=%EA%B0%80&start=01",
            "q=%ZZ",
        )
        for raw_query in invalid_queries:
            with self.subTest(raw_query=raw_query):
                with self.assertRaises(proxy.RequestValidationError):
                    proxy.parse_api_query(raw_query)


class StaticPathTests(unittest.TestCase):
    def test_allows_only_required_public_web_assets(self) -> None:
        allowed = (
            "/",
            "/index.html",
            "/app.js",
            "/assets/fonts/NanumGothic.clean.ttf",
            "/data/default-dictionary.txt",
            "/data/search-index-manifest.json",
            "/data/search-index-shards/ac00.json",
        )
        for path in allowed:
            with self.subTest(path=path):
                self.assertTrue(proxy.static_path_is_allowed(path))

    def test_blocks_repository_secrets_tools_directories_and_traversal(self) -> None:
        denied = (
            "/.git/config",
            "/%2egit/config",
            "/.env",
            "/tools/opendict_proxy.py",
            "/docs/failure-cases.md",
            "/DATA_SOURCES.md",
            "/assets/",
            "/data/",
            "/data/korean_words_opendict_extra.txt",
            "/data/search-index.json",
            "/assets/../.git/config",
            "/assets/file.txt",
            "/assets/image.png::$DATA",
            "/assets/CON.png",
        )
        for path in denied:
            with self.subTest(path=path):
                self.assertFalse(proxy.static_path_is_allowed(path))

    def test_allows_only_a_single_safe_cache_buster(self) -> None:
        self.assertTrue(proxy.static_path_is_allowed("/app.js", "v=release-1"))
        self.assertFalse(proxy.static_path_is_allowed("/app.js", "debug=1"))
        self.assertFalse(proxy.static_path_is_allowed("/app.js", "v=ok&v=again"))

    def test_static_target_cannot_escape_the_public_subtree(self) -> None:
        private_target = (proxy.ROOT / ".git" / "config").resolve()
        self.assertFalse(proxy.static_target_is_safe("/assets/preview.png", private_target))
        self.assertFalse(proxy.static_target_is_safe("/index.html", private_target))


class TrustedProxyTests(unittest.TestCase):
    def test_ignores_forwarded_ip_from_untrusted_peer(self) -> None:
        networks = proxy.parse_trusted_proxy_cidrs("10.0.0.0/8")
        client = proxy.resolve_client_ip("203.0.113.8", "198.51.100.9", networks)
        self.assertEqual(client, "203.0.113.8")

    def test_walks_trusted_proxy_chain_from_the_socket_peer(self) -> None:
        networks = proxy.parse_trusted_proxy_cidrs("127.0.0.0/8,10.0.0.0/8")
        client = proxy.resolve_client_ip(
            "127.0.0.1", "198.51.100.9, 10.20.30.40", networks
        )
        self.assertEqual(client, "198.51.100.9")

    def test_discards_a_malformed_forwarded_chain(self) -> None:
        networks = proxy.parse_trusted_proxy_cidrs("127.0.0.0/8")
        client = proxy.resolve_client_ip("127.0.0.1", "not-an-ip", networks)
        self.assertEqual(client, "127.0.0.1")


class MemoryBoundTests(unittest.TestCase):
    def test_rate_limiter_bounds_bucket_count_and_per_bucket_events(self) -> None:
        limiter = proxy.BoundedRateLimiter(maximum=2, window_seconds=10, max_buckets=3)
        self.assertTrue(limiter.allow("a", now=1))
        self.assertTrue(limiter.allow("a", now=2))
        self.assertFalse(limiter.allow("a", now=3))
        self.assertTrue(limiter.allow("b", now=3))
        self.assertTrue(limiter.allow("c", now=3))
        self.assertTrue(limiter.allow("d", now=3))
        self.assertLessEqual(limiter.size(), 3)

    def test_rate_limiter_expires_old_events(self) -> None:
        limiter = proxy.BoundedRateLimiter(maximum=1, window_seconds=10, max_buckets=3)
        self.assertTrue(limiter.allow("client", now=1))
        self.assertFalse(limiter.allow("client", now=2))
        self.assertTrue(limiter.allow("client", now=11))


class FakeResponse:
    def __init__(self, body: bytes, *, content_type: str = "application/json", content_length: str | None = None):
        self._body = body
        self._offset = 0
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        if content_length is not None:
            self.headers["Content-Length"] = content_length

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:  # noqa: ANN001
        return None

    def read1(self, size: int) -> bytes:
        chunk = self._body[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    read = read1


class FakeOpener:
    def __init__(self, response: FakeResponse):
        self.response = response
        self.request = None
        self.timeout = None

    def open(self, request, timeout=None):  # noqa: ANN001
        self.request = request
        self.timeout = timeout
        return self.response


class UpstreamTests(unittest.TestCase):
    def test_forwards_start_and_keeps_key_only_in_upstream_https_url(self) -> None:
        opener = FakeOpener(FakeResponse(b'{"channel":{"item":[]}}'))
        with mock.patch.object(proxy, "UPSTREAM_OPENER", opener):
            content_type, body = proxy.fetch_opendict("a" * 32, "\uac00", "start", 100, 401)

        self.assertEqual(content_type, "application/json; charset=UTF-8")
        self.assertEqual(json.loads(body), {"channel": {"item": []}})
        parsed = urllib.parse.urlsplit(opener.request.full_url)
        params = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(params["start"], ["401"])
        self.assertEqual(params["key"], ["a" * 32])

    def test_rejects_oversized_or_non_json_upstream_responses(self) -> None:
        oversized = FakeOpener(
            FakeResponse(b"{}", content_length=str(proxy.UPSTREAM_MAX_RESPONSE_BYTES + 1))
        )
        with mock.patch.object(proxy, "UPSTREAM_OPENER", oversized):
            with self.assertRaises(proxy.UpstreamResponseTooLarge):
                proxy.fetch_opendict("a" * 32, "\uac00", "exact", 20, 1)

        wrong_type = FakeOpener(FakeResponse(b"<html></html>", content_type="text/html"))
        with mock.patch.object(proxy, "UPSTREAM_OPENER", wrong_type):
            with self.assertRaises(proxy.InvalidUpstreamResponse):
                proxy.fetch_opendict("a" * 32, "\uac00", "exact", 20, 1)


class HttpIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = proxy.BoundedThreadingHTTPServer(("127.0.0.1", 0), proxy.Handler, max_connections=8)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host, cls.port = cls.server.server_address

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def setUp(self) -> None:
        proxy.API_RATE_LIMITER.clear()
        proxy.STATIC_RATE_LIMITER.clear()
        with proxy.CACHE_LOCK:
            proxy.RESPONSE_CACHE.clear()
            proxy.CACHE_BYTES = 0

    def request(self, method: str, path: str, *, headers: dict[str, str] | None = None, body=None):  # noqa: ANN001
        connection = http.client.HTTPConnection(self.host, self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response_body = response.read()
        result = response.status, dict(response.getheaders()), response_body
        connection.close()
        return result

    def raw_request(self, payload: bytes) -> bytes:
        connection = socket.create_connection((self.host, self.port), timeout=3)
        try:
            connection.sendall(payload)
            chunks: list[bytes] = []
            while True:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            connection.close()

    def test_static_response_has_security_headers_without_server_version_leak(self) -> None:
        status, headers, body = self.request("HEAD", "/")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertNotIn("Python", headers["Server"])

    def test_sensitive_repository_paths_and_directory_listings_are_not_served(self) -> None:
        for path in ("/.git/config", "/tools/opendict_proxy.py", "/assets/"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, HTTPStatus.NOT_FOUND)

    def test_api_rejects_client_key_before_reading_server_configuration(self) -> None:
        status, _, body = self.request("GET", "/api/opendict/search?q=%EA%B0%80&key=secret")
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertIn("must not be sent", json.loads(body)["error"]["message"])

    def test_api_rejects_unlisted_cors_origin(self) -> None:
        status, headers, _ = self.request(
            "GET",
            "/api/opendict/search?q=%EA%B0%80",
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(status, HTTPStatus.FORBIDDEN)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_api_rejects_cross_site_subresource_requests(self) -> None:
        status, _, _ = self.request(
            "GET",
            "/api/opendict/search?q=%EA%B0%80",
            headers={"Sec-Fetch-Site": "cross-site"},
        )
        self.assertEqual(status, HTTPStatus.FORBIDDEN)

    def test_api_rejects_same_site_subresource_requests_without_an_allowlist(self) -> None:
        status, _, _ = self.request(
            "GET",
            "/api/opendict/search?q=%EA%B0%80",
            headers={"Sec-Fetch-Site": "same-site"},
        )
        self.assertEqual(status, HTTPStatus.FORBIDDEN)

    def test_api_rejects_non_fetch_destinations(self) -> None:
        status, _, _ = self.request(
            "GET",
            "/api/opendict/search?q=%EA%B0%80",
            headers={"Sec-Fetch-Dest": "image"},
        )
        self.assertEqual(status, HTTPStatus.FORBIDDEN)

    def test_explicit_cors_allowlist_controls_preflight(self) -> None:
        with mock.patch.object(proxy, "ALLOWED_ORIGINS", frozenset({"https://client.example"})):
            status, headers, _ = self.request(
                "OPTIONS",
                "/api/opendict/search",
                headers={
                    "Origin": "https://client.example",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "X-Trace-Id",
                },
            )
        self.assertEqual(status, HTTPStatus.NO_CONTENT)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://client.example")
        self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, OPTIONS")

    def test_start_reaches_upstream_and_distinguishes_cache_pages(self) -> None:
        response = ("application/json; charset=UTF-8", b'{"channel":{"item":[]}}')
        with mock.patch.dict(os.environ, {proxy.API_KEY_ENV: "a" * 32}):
            with mock.patch.object(proxy, "fetch_opendict", return_value=response) as fetch:
                status, headers, _ = self.request(
                    "GET", "/api/opendict/search?q=%EA%B0%80&method=start&num=100&start=401"
                )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(headers["X-Cache"], "MISS")
        fetch.assert_called_once_with("a" * 32, "\uac00", "start", 100, 401)
        self.assertIn(("\uac00", "start", 100, 401), proxy.RESPONSE_CACHE)

    def test_request_bodies_and_unsupported_methods_are_rejected(self) -> None:
        status, _, _ = self.request(
            "GET",
            "/api/opendict/search?q=%EA%B0%80",
            headers={"Content-Length": "1"},
        )
        self.assertEqual(status, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        status, headers, _ = self.request("POST", "/api/opendict/search", body=b"x")
        self.assertEqual(status, HTTPStatus.METHOD_NOT_ALLOWED)
        self.assertEqual(headers["Allow"], "GET, OPTIONS")

    def test_oversized_request_target_and_header_are_rejected_early(self) -> None:
        long_target_response = self.raw_request(
            b"GET /" + b"a" * (proxy.MAX_REQUEST_LINE_BYTES + 1) + b" HTTP/1.1\r\nHost: test\r\n\r\n"
        )
        self.assertTrue(long_target_response.startswith(b"HTTP/1.1 414 "))

        long_header_response = self.raw_request(
            b"GET / HTTP/1.1\r\nHost: test\r\nX-Oversized: "
            + b"a" * (proxy.MAX_HEADER_LINE_BYTES + 1)
            + b"\r\n\r\n"
        )
        self.assertTrue(long_header_response.startswith(b"HTTP/1.1 431 "))


if __name__ == "__main__":
    unittest.main()
