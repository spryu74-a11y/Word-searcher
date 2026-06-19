from __future__ import annotations

import argparse
from collections import OrderedDict, deque
import json
import mimetypes
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
API_ENDPOINT = "https://opendict.korean.go.kr/api/search"
API_KEY_ENV = "OPENDICT_API_KEY"
HANGUL_RE = re.compile(r"^[\uac00-\ud7a3]{1,50}$")
METHODS = {"exact", "start"}

UPSTREAM_TIMEOUT_SECONDS = 8
CACHE_TTL_SECONDS = 5 * 60
CACHE_MAX_SIZE = 256
RATE_LIMIT_WINDOW_SECONDS = 10
RATE_LIMIT_MAX_REQUESTS = 30
UPSTREAM_CONCURRENCY = 4

ResponseCacheValue = tuple[float, str, bytes]
RESPONSE_CACHE: OrderedDict[tuple[str, str, int], ResponseCacheValue] = OrderedDict()
CACHE_LOCK = threading.Lock()
RATE_LIMIT_BUCKETS: dict[str, deque[float]] = {}
RATE_LIMIT_LOCK = threading.Lock()
UPSTREAM_SEMAPHORE = threading.BoundedSemaphore(UPSTREAM_CONCURRENCY)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory or str(ROOT), **kwargs)

    def do_OPTIONS(self) -> None:
        if self.path.startswith("/api/opendict/search"):
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", self._allowed_origin())
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Accept, X-Trace-Id")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
            return
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/opendict/search":
            self.handle_opendict(parsed)
            return
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        if self.path.startswith("/api/opendict/search"):
            return
        super().log_message(format, *args)

    def handle_opendict(self, parsed: urllib.parse.ParseResult) -> None:
        request_started = time.perf_counter()
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
        request_id = self._request_id(query)
        client_key = self.client_address[0] if self.client_address else "unknown"

        if not allow_request(client_key):
            self.write_json(
                HTTPStatus.TOO_MANY_REQUESTS,
                {"error": {"message": "Too many OpenDict requests."}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "rate_limited", request_started)
            return

        parse_started = time.perf_counter()
        api_key = os.environ.get(API_KEY_ENV, "").strip() or first(query, "key")
        if not api_key:
            self.write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": {"message": f"Set {API_KEY_ENV} or provide a key parameter."}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "missing_key", request_started)
            return

        word = first(query, "q")
        method = first(query, "method") or "exact"
        num = clamp_int(first(query, "num"), 1, 100, 20)
        parse_ms = elapsed_ms(parse_started)
        if not HANGUL_RE.fullmatch(word or "") or method not in METHODS:
            self.write_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "Invalid query."}, "requestId": request_id},
                request_id=request_id,
                server_timing=f"parse;dur={parse_ms}",
            )
            self.log_api(request_id, "bad_request", request_started, parse_ms=parse_ms)
            return

        cache_key = (word, method, num)
        cached = get_cached_response(cache_key)
        if cached:
            content_type, content = cached
            self.write_bytes(
                HTTPStatus.OK,
                content_type,
                content,
                request_id=request_id,
                cache_status="HIT",
                server_timing=f"parse;dur={parse_ms}, cache;desc=hit",
            )
            self.log_api(request_id, "cache_hit", request_started, parse_ms=parse_ms)
            return

        if not UPSTREAM_SEMAPHORE.acquire(timeout=0.25):
            self.write_json(
                HTTPStatus.TOO_MANY_REQUESTS,
                {"error": {"message": "OpenDict proxy is busy."}, "requestId": request_id},
                request_id=request_id,
                server_timing=f"parse;dur={parse_ms}",
            )
            self.log_api(request_id, "busy", request_started, parse_ms=parse_ms)
            return

        upstream_started = time.perf_counter()
        try:
            content_type, content = fetch_opendict(api_key, word, method, num)
        except urllib.error.HTTPError as error:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": f"OpenDict HTTP {error.code}"}, "requestId": request_id},
                request_id=request_id,
                server_timing=f"parse;dur={parse_ms}, upstream;dur={elapsed_ms(upstream_started)}",
            )
            self.log_api(request_id, f"upstream_http_{error.code}", request_started, parse_ms=parse_ms)
            return
        except urllib.error.URLError as error:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": f"OpenDict request failed: {error.reason}"}, "requestId": request_id},
                request_id=request_id,
                server_timing=f"parse;dur={parse_ms}, upstream;dur={elapsed_ms(upstream_started)}",
            )
            self.log_api(request_id, "upstream_url_error", request_started, parse_ms=parse_ms)
            return
        finally:
            UPSTREAM_SEMAPHORE.release()

        upstream_ms = elapsed_ms(upstream_started)
        set_cached_response(cache_key, content_type, content)
        self.write_bytes(
            HTTPStatus.OK,
            content_type,
            content,
            request_id=request_id,
            cache_status="MISS",
            server_timing=f"parse;dur={parse_ms}, upstream;dur={upstream_ms}",
        )
        self.log_api(request_id, "ok", request_started, parse_ms=parse_ms, upstream_ms=upstream_ms)

    def write_json(
        self,
        status: HTTPStatus,
        body: dict,
        *,
        request_id: str = "",
        server_timing: str = "",
    ) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.write_bytes(
            status,
            "application/json; charset=UTF-8",
            payload,
            request_id=request_id,
            cache_status="BYPASS",
            server_timing=server_timing,
        )

    def write_bytes(
        self,
        status: HTTPStatus,
        content_type: str,
        content: bytes,
        *,
        request_id: str,
        cache_status: str,
        server_timing: str,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/json; charset=UTF-8")
        self.send_header("Cache-Control", "private, max-age=300")
        self.send_header("Access-Control-Allow-Origin", self._allowed_origin())
        self.send_header("X-Request-ID", request_id)
        self.send_header("X-Cache", cache_status)
        if server_timing:
            self.send_header("Server-Timing", server_timing)
        self.end_headers()
        self.wfile.write(content)

    def _allowed_origin(self) -> str:
        return self.headers.get("Origin", "*") or "*"

    def _request_id(self, query: dict[str, list[str]]) -> str:
        header_value = (self.headers.get("X-Trace-Id") or "").strip()
        query_value = first(query, "traceId")
        value = header_value or query_value
        if value and re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", value):
            return value
        return uuid.uuid4().hex[:12]

    def log_api(
        self,
        request_id: str,
        status: str,
        started: float,
        *,
        parse_ms: float = 0,
        upstream_ms: float = 0,
    ) -> None:
        print(
            json.dumps(
                {
                    "requestId": request_id,
                    "path": "/api/opendict/search",
                    "status": status,
                    "totalMs": elapsed_ms(started),
                    "parseMs": parse_ms,
                    "upstreamMs": upstream_ms,
                    "cacheSize": cache_size(),
                },
                ensure_ascii=False,
            )
        )


def fetch_opendict(api_key: str, word: str, method: str, num: int) -> tuple[str, bytes]:
    params = {
        "key": api_key,
        "q": word,
        "req_type": "json",
        "part": "word",
        "sort": "dict",
        "advanced": "y",
        "target": "1",
        "method": method,
        "type1": "word",
        "type3": "all",
        "start": "1",
        "num": str(num),
    }
    url = f"{API_ENDPOINT}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Connection": "close",
        },
    )
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
        content = response.read()
        content_type = response.headers.get("Content-Type", "application/json; charset=UTF-8")
    return content_type, content


def get_cached_response(cache_key: tuple[str, str, int]) -> tuple[str, bytes] | None:
    now = time.monotonic()
    with CACHE_LOCK:
        cached = RESPONSE_CACHE.get(cache_key)
        if not cached:
            return None
        expires_at, content_type, content = cached
        if expires_at <= now:
            RESPONSE_CACHE.pop(cache_key, None)
            return None
        RESPONSE_CACHE.move_to_end(cache_key)
        return content_type, content


def set_cached_response(cache_key: tuple[str, str, int], content_type: str, content: bytes) -> None:
    expires_at = time.monotonic() + CACHE_TTL_SECONDS
    with CACHE_LOCK:
        RESPONSE_CACHE[cache_key] = (expires_at, content_type, content)
        RESPONSE_CACHE.move_to_end(cache_key)
        while len(RESPONSE_CACHE) > CACHE_MAX_SIZE:
            RESPONSE_CACHE.popitem(last=False)


def cache_size() -> int:
    with CACHE_LOCK:
        return len(RESPONSE_CACHE)


def allow_request(client_key: str) -> bool:
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    with RATE_LIMIT_LOCK:
        bucket = RATE_LIMIT_BUCKETS.setdefault(client_key, deque())
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
            return False
        bucket.append(now)
        for key, other_bucket in list(RATE_LIMIT_BUCKETS.items()):
            while other_bucket and other_bucket[0] < cutoff:
                other_bucket.popleft()
            if key != client_key and not other_bucket:
                RATE_LIMIT_BUCKETS.pop(key, None)
        return True


def first(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return values[0].strip() if values else ""


def clamp_int(value: str, minimum: int, maximum: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8787)))
    args = parser.parse_args()

    mimetypes.add_type("text/javascript; charset=UTF-8", ".js")
    mimetypes.add_type("text/css; charset=UTF-8", ".css")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving app at http://{args.host}:{args.port}/")
    print(f"Using {API_KEY_ENV} from this process environment.")
    server.serve_forever()


if __name__ == "__main__":
    main()
