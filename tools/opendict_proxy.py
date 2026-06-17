from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
API_ENDPOINT = "https://opendict.korean.go.kr/api/search"
API_KEY_ENV = "OPENDICT_API_KEY"
HANGUL_RE = re.compile(r"^[가-힣]{1,50}$")
METHODS = {"exact", "start"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory or str(ROOT), **kwargs)

    def do_OPTIONS(self) -> None:
        if self.path.startswith("/api/opendict/search"):
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", self._allowed_origin())
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Accept")
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
            print(f"{self.address_string()} - API {self.command} {urllib.parse.urlparse(self.path).path}")
            return
        super().log_message(format, *args)

    def handle_opendict(self, parsed: urllib.parse.ParseResult) -> None:
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
        api_key = os.environ.get(API_KEY_ENV, "").strip() or first(query, "key")
        if not api_key:
            self.write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": {"message": f"Set {API_KEY_ENV} or provide a key parameter."}},
            )
            return

        word = first(query, "q")
        method = first(query, "method") or "exact"
        num = clamp_int(first(query, "num"), 1, 100, 20)
        if not HANGUL_RE.fullmatch(word or "") or method not in METHODS:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid query."}})
            return

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
        request = urllib.request.Request(url, headers={"Accept": "application/json"})

        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                content = response.read()
                content_type = response.headers.get("Content-Type", "application/json; charset=UTF-8")
        except urllib.error.HTTPError as error:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": f"OpenDict HTTP {error.code}"}},
            )
            return
        except urllib.error.URLError as error:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": f"OpenDict request failed: {error.reason}"}},
            )
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", self._allowed_origin())
        self.end_headers()
        self.wfile.write(content)

    def write_json(self, status: HTTPStatus, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=UTF-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", self._allowed_origin())
        self.end_headers()
        self.wfile.write(payload)

    def _allowed_origin(self) -> str:
        return self.headers.get("Origin", "*") or "*"


def first(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return values[0].strip() if values else ""


def clamp_int(value: str, minimum: int, maximum: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


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
