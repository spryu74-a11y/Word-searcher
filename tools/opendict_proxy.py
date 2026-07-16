from __future__ import annotations

import argparse
from collections import OrderedDict, deque
from dataclasses import dataclass
import http.client
import ipaddress
import json
import mimetypes
import os
import re
import signal
import socket
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
ROOT_RESOLVED = ROOT.resolve()
API_PATH = "/api/opendict/search"
API_ENDPOINT = "https://opendict.korean.go.kr/api/search"
API_KEY_ENV = "OPENDICT_API_KEY"


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.environ.get(name, "").strip()
    if not raw_value:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def env_bool(name: str, default: bool = False) -> bool:
    raw_value = os.environ.get(name, "").strip().lower()
    if not raw_value:
        return default
    if raw_value in {"1", "true", "yes", "on"}:
        return True
    if raw_value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


UPSTREAM_TIMEOUT_SECONDS = env_int("OPENDICT_UPSTREAM_TIMEOUT", 8, 1, 30)
UPSTREAM_MAX_RESPONSE_BYTES = env_int(
    "OPENDICT_UPSTREAM_MAX_BYTES", 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024
)
UPSTREAM_CONCURRENCY = env_int("OPENDICT_UPSTREAM_CONCURRENCY", 4, 1, 32)
UPSTREAM_QUEUE_WAIT_SECONDS = 0.25

MAX_ACTIVE_CONNECTIONS = env_int("OPENDICT_MAX_CONNECTIONS", 64, 8, 512)
LISTEN_BACKLOG = env_int("OPENDICT_LISTEN_BACKLOG", 128, 8, 1024)
CLIENT_SOCKET_TIMEOUT_SECONDS = env_int("OPENDICT_CLIENT_TIMEOUT", 10, 2, 60)
MAX_REQUEST_LINE_BYTES = env_int("OPENDICT_MAX_REQUEST_LINE", 4096, 512, 16384)
MAX_URI_BYTES = env_int("OPENDICT_MAX_URI", 2048, 256, MAX_REQUEST_LINE_BYTES)
MAX_HEADER_BYTES = env_int("OPENDICT_MAX_HEADERS", 16 * 1024, 4096, 64 * 1024)
MAX_HEADER_LINE_BYTES = min(4096, MAX_HEADER_BYTES)
MAX_QUERY_FIELDS = 16
MAX_FORWARDED_HOPS = 20
MAX_FORWARDED_HEADER_BYTES = 1024

CACHE_TTL_SECONDS = env_int("OPENDICT_CACHE_TTL", 5 * 60, 0, 3600)
CACHE_MAX_SIZE = env_int("OPENDICT_CACHE_ENTRIES", 256, 1, 4096)
CACHE_MAX_BYTES = env_int("OPENDICT_CACHE_MAX_BYTES", 16 * 1024 * 1024, 1024 * 1024, 128 * 1024 * 1024)

RATE_LIMIT_WINDOW_SECONDS = env_int("OPENDICT_RATE_WINDOW", 10, 1, 3600)
RATE_LIMIT_MAX_REQUESTS = env_int("OPENDICT_RATE_REQUESTS", 30, 1, 10000)
STATIC_RATE_LIMIT_WINDOW_SECONDS = 60
STATIC_RATE_LIMIT_MAX_REQUESTS = env_int("STATIC_RATE_REQUESTS", 300, 30, 10000)
RATE_LIMIT_MAX_BUCKETS = env_int("OPENDICT_RATE_BUCKETS", 10000, 128, 100000)

MAX_START = 1000
MAX_NUM = 100
HANGUL_RE = re.compile(r"^[\uac00-\ud7a3]{1,50}$")
API_KEY_RE = re.compile(r"^[0-9a-fA-F]{32}$")
TRACE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")
VERSION_TOKEN_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
SAFE_STATIC_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHARD_PATH_RE = re.compile(r"^/data/search-index-shards/[0-9a-f]{4}\.json$")
METHODS = frozenset({"exact", "start"})

API_QUERY_KEYS = frozenset(
    {
        "q",
        "method",
        "num",
        "start",
        "traceId",
        "req_type",
        "part",
        "sort",
        "advanced",
        "target",
        "type1",
        "type3",
    }
)
FORBIDDEN_SECRET_QUERY_KEYS = frozenset({"key", "api_key", "apikey", "token", "access_token"})
FIXED_API_QUERY_VALUES = {
    "req_type": "json",
    "part": "word",
    "sort": "dict",
    "advanced": "y",
    "target": "1",
    "type1": "word",
    "type3": "all",
}

STATIC_ROOT_FILES = frozenset({"/index.html", "/app.js", "/styles.css", "/search-worker.js"})
STATIC_DATA_FILES = frozenset(
    {
        "/data/default-dictionary.js",
        "/data/default-dictionary.txt",
        "/data/default-dictionary-meta.json",
        "/data/search-index-manifest.json",
    }
)
STATIC_ASSET_EXTENSIONS = frozenset({".png", ".woff", ".ttf"})
WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{number}" for number in range(1, 10)}
    | {f"LPT{number}" for number in range(1, 10)}
)

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "base-uri 'none'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "script-src 'self'; "
    "script-src-attr 'none'; "
    "style-src 'self' 'unsafe-inline'; "
    "font-src 'self'; "
    "img-src 'self' data:; "
    "worker-src 'self'; "
    "connect-src 'self' https://wordrow.kr "
    "https://r.jina.ai https://ko.wiktionary.org; "
    "manifest-src 'self'; "
    "media-src 'none'; "
    "upgrade-insecure-requests; "
    "require-trusted-types-for 'script'"
)


class RequestValidationError(ValueError):
    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.public_message = message
        self.status = status


class UpstreamResponseTooLarge(Exception):
    pass


class InvalidUpstreamResponse(Exception):
    pass


@dataclass(frozen=True)
class ApiQuery:
    word: str
    method: str
    num: int
    start: int
    trace_id: str = ""


def normalize_origin(value: str) -> str | None:
    value = value.strip()
    if not value or value == "null" or len(value) > 512:
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        return None
    try:
        host = parsed.hostname.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None
    if ":" in host:
        host = f"[{host}]"
    scheme = parsed.scheme.lower()
    if port is not None and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    return f"{scheme}://{host}"


def normalize_host(value: str) -> str | None:
    value = value.strip()
    if not value or len(value) > 255 or any(character.isspace() for character in value):
        return None
    if any(character in value for character in "/\\@?#"):
        return None
    try:
        parsed = urllib.parse.urlsplit(f"//{value}")
        port = parsed.port
    except ValueError:
        return None
    if not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.path:
        return None
    try:
        host = parsed.hostname.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None
    if ":" in host:
        host = f"[{host}]"
    if port is not None:
        host = f"{host}:{port}"
    return host


def parse_allowed_origins(raw_value: str) -> frozenset[str]:
    origins: set[str] = set()
    for raw_origin in raw_value.split(","):
        if not raw_origin.strip():
            continue
        origin = normalize_origin(raw_origin)
        if not origin:
            raise ValueError("OPENDICT_ALLOWED_ORIGINS contains an invalid origin")
        origins.add(origin)
    return frozenset(origins)


def parse_allowed_hosts(raw_value: str) -> frozenset[str]:
    hosts: set[str] = set()
    for raw_host in raw_value.split(","):
        if not raw_host.strip():
            continue
        host = normalize_host(raw_host)
        if not host:
            raise ValueError("OPENDICT_ALLOWED_HOSTS contains an invalid host")
        hosts.add(host)
    return frozenset(hosts)


def parse_trusted_proxy_cidrs(raw_value: str) -> tuple[ipaddress._BaseNetwork, ...]:
    networks: list[ipaddress._BaseNetwork] = []
    for raw_network in raw_value.split(","):
        if not raw_network.strip():
            continue
        try:
            networks.append(ipaddress.ip_network(raw_network.strip(), strict=False))
        except ValueError as error:
            raise ValueError("OPENDICT_TRUSTED_PROXY_CIDRS contains an invalid network") from error
    return tuple(networks)


# Render supplies the service's canonical public host and URL automatically.
# Keep explicit application settings authoritative, while using those trusted
# platform values as safe defaults so a Render web service can start without
# duplicating its generated hostname in the dashboard.
RENDER_EXTERNAL_HOSTNAME = os.environ.get("RENDER_EXTERNAL_HOSTNAME", "").strip()
RENDER_EXTERNAL_URL = os.environ.get("RENDER_EXTERNAL_URL", "").strip()
ALLOWED_ORIGINS = parse_allowed_origins(
    os.environ.get("OPENDICT_ALLOWED_ORIGINS", "").strip() or RENDER_EXTERNAL_URL
)
ALLOWED_HOSTS = parse_allowed_hosts(
    os.environ.get("OPENDICT_ALLOWED_HOSTS", "").strip() or RENDER_EXTERNAL_HOSTNAME
)
TRUSTED_PROXY_NETWORKS = parse_trusted_proxy_cidrs(os.environ.get("OPENDICT_TRUSTED_PROXY_CIDRS", ""))
ENABLE_HSTS = env_bool("OPENDICT_ENABLE_HSTS", False)


def canonical_ip(value: str) -> str | None:
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return str(address.ipv4_mapped)
    return str(address)


def ip_is_trusted(value: str, networks: Iterable[ipaddress._BaseNetwork]) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return any(address.version == network.version and address in network for network in networks)


def resolve_client_ip(
    peer_ip: str,
    forwarded_for: str,
    trusted_networks: Iterable[ipaddress._BaseNetwork] = (),
) -> str:
    peer = canonical_ip(peer_ip) or "unknown"
    networks = tuple(trusted_networks)
    if peer == "unknown" or not networks or not ip_is_trusted(peer, networks):
        return peer
    if not forwarded_for or len(forwarded_for.encode("utf-8", errors="ignore")) > MAX_FORWARDED_HEADER_BYTES:
        return peer
    raw_hops = [part.strip() for part in forwarded_for.split(",")]
    if not raw_hops or len(raw_hops) > MAX_FORWARDED_HOPS:
        return peer
    hops = [canonical_ip(raw_hop) for raw_hop in raw_hops]
    if any(hop is None for hop in hops):
        return peer
    chain = [hop for hop in hops if hop is not None] + [peer]
    while len(chain) > 1 and ip_is_trusted(chain[-1], networks):
        chain.pop()
    return chain[-1]


def parse_strict_positive_int(value: str, name: str, maximum: int) -> int:
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise RequestValidationError(f"Invalid {name}.")
    number = int(value)
    if number > maximum:
        raise RequestValidationError(f"Invalid {name}.")
    return number


def parse_api_query(raw_query: str) -> ApiQuery:
    if len(raw_query.encode("utf-8", errors="ignore")) > MAX_URI_BYTES:
        raise RequestValidationError("Query string is too long.", HTTPStatus.REQUEST_URI_TOO_LONG)
    if re.search(r"%(?![0-9A-Fa-f]{2})", raw_query):
        raise RequestValidationError("Invalid query encoding.")
    try:
        pairs = urllib.parse.parse_qsl(
            raw_query,
            keep_blank_values=True,
            strict_parsing=True,
            encoding="utf-8",
            errors="strict",
            max_num_fields=MAX_QUERY_FIELDS,
        )
    except (UnicodeDecodeError, ValueError) as error:
        raise RequestValidationError("Invalid query string.") from error

    values: dict[str, str] = {}
    for key, value in pairs:
        if key.casefold() in FORBIDDEN_SECRET_QUERY_KEYS:
            raise RequestValidationError("API keys must not be sent in query parameters.")
        if key not in API_QUERY_KEYS:
            raise RequestValidationError("Unknown query parameter.")
        if key in values:
            raise RequestValidationError("Duplicate query parameter.")
        values[key] = value.strip()

    for key, expected_value in FIXED_API_QUERY_VALUES.items():
        if key in values and values[key] != expected_value:
            raise RequestValidationError(f"Invalid {key}.")

    word = unicodedata.normalize("NFC", values.get("q", ""))
    method = values.get("method", "exact")
    num = parse_strict_positive_int(values["num"], "num", MAX_NUM) if "num" in values else 20
    start = (
        parse_strict_positive_int(values["start"], "start", MAX_START)
        if "start" in values
        else 1
    )
    trace_id = values.get("traceId", "")

    if not HANGUL_RE.fullmatch(word):
        raise RequestValidationError("Invalid q.")
    if method not in METHODS:
        raise RequestValidationError("Invalid method.")
    if trace_id and not TRACE_ID_RE.fullmatch(trace_id):
        raise RequestValidationError("Invalid traceId.")
    return ApiQuery(word=word, method=method, num=num, start=start, trace_id=trace_id)


def decode_static_path(raw_path: str) -> str | None:
    try:
        decoded_path = urllib.parse.unquote_to_bytes(raw_path).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None
    if not decoded_path.startswith("/") or "\\" in decoded_path or "\x00" in decoded_path or "//" in decoded_path:
        return None
    if decoded_path == "/":
        return decoded_path
    segments = decoded_path.split("/")[1:]
    if any(
        not SAFE_STATIC_SEGMENT_RE.fullmatch(segment)
        or segment in {".", ".."}
        or segment.startswith(".")
        or segment.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES
        for segment in segments
    ):
        return None
    return decoded_path


def static_path_is_allowed(raw_path: str, raw_query: str = "") -> bool:
    decoded_path = decode_static_path(raw_path)
    if decoded_path is None:
        return False
    if raw_query:
        try:
            pairs = urllib.parse.parse_qsl(
                raw_query,
                keep_blank_values=True,
                strict_parsing=True,
                encoding="ascii",
                errors="strict",
                max_num_fields=1,
            )
        except (UnicodeDecodeError, ValueError):
            return False
        if len(pairs) != 1 or pairs[0][0] != "v" or not VERSION_TOKEN_RE.fullmatch(pairs[0][1]):
            return False
    if decoded_path == "/" or decoded_path in STATIC_ROOT_FILES or decoded_path in STATIC_DATA_FILES:
        return True
    if SHARD_PATH_RE.fullmatch(decoded_path):
        return True
    if decoded_path.startswith("/assets/"):
        suffix = Path(decoded_path).suffix.lower()
        return suffix in STATIC_ASSET_EXTENSIONS
    return False


def path_has_symlink_component(path: Path, root: Path = ROOT_RESOLVED) -> bool:
    """Return True when resolving *path* would follow a filesystem link.

    SimpleHTTPRequestHandler follows symlinks by default.  URL allowlisting
    alone is therefore insufficient: an attacker who can place a link under
    ``assets/`` could make an apparently safe ``.png`` URL disclose a private
    repository file.  Treat link components as untrusted even when they still
    resolve below the repository root.
    """
    try:
        relative = path.absolute().relative_to(root.absolute())
    except ValueError:
        return True
    current = root
    for component in relative.parts:
        current /= component
        try:
            if current.is_symlink():
                return True
        except OSError:
            return True
    return False


def static_target_is_safe(decoded_path: str, resolved_target: Path) -> bool:
    """Ensure a URL maps to the intended public tree, not just ROOT."""
    resolved_target = resolved_target.resolve(strict=False)
    if decoded_path == "/":
        return resolved_target == ROOT_RESOLVED
    if decoded_path in STATIC_ROOT_FILES or decoded_path in STATIC_DATA_FILES:
        return resolved_target == (ROOT / decoded_path.lstrip("/")).resolve(strict=False)
    if SHARD_PATH_RE.fullmatch(decoded_path):
        shard_root = (ROOT / "data" / "search-index-shards").resolve(strict=False)
        try:
            resolved_target.relative_to(shard_root)
        except ValueError:
            return False
        return resolved_target.suffix.lower() == ".json"
    if decoded_path.startswith("/assets/"):
        asset_root = (ROOT / "assets").resolve(strict=False)
        try:
            resolved_target.relative_to(asset_root)
        except ValueError:
            return False
        return resolved_target.suffix.lower() in STATIC_ASSET_EXTENSIONS
    return False


class BoundedRateLimiter:
    def __init__(self, maximum: int, window_seconds: float, max_buckets: int):
        self.maximum = maximum
        self.window_seconds = window_seconds
        self.max_buckets = max_buckets
        self._buckets: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        cutoff = current - self.window_seconds
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                self._prune_expired(cutoff, limit=64)
                while len(self._buckets) >= self.max_buckets:
                    self._buckets.popitem(last=False)
                bucket = deque()
                self._buckets[key] = bucket
            else:
                self._buckets.move_to_end(key)
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= self.maximum:
                return False
            bucket.append(current)
            return True

    def _prune_expired(self, cutoff: float, limit: int) -> None:
        for key in list(self._buckets.keys())[:limit]:
            bucket = self._buckets.get(key)
            if bucket is None:
                continue
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if not bucket:
                self._buckets.pop(key, None)

    def size(self) -> int:
        with self._lock:
            return len(self._buckets)

    def clear(self) -> None:
        with self._lock:
            self._buckets.clear()


API_RATE_LIMITER = BoundedRateLimiter(
    RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_MAX_BUCKETS
)
STATIC_RATE_LIMITER = BoundedRateLimiter(
    STATIC_RATE_LIMIT_MAX_REQUESTS, STATIC_RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_MAX_BUCKETS
)
UPSTREAM_SEMAPHORE = threading.BoundedSemaphore(UPSTREAM_CONCURRENCY)

ResponseCacheKey = tuple[str, str, int, int]
ResponseCacheValue = tuple[float, str, bytes]
RESPONSE_CACHE: OrderedDict[ResponseCacheKey, ResponseCacheValue] = OrderedDict()
CACHE_LOCK = threading.Lock()
CACHE_BYTES = 0
LOG_LOCK = threading.Lock()


def get_cached_response(cache_key: ResponseCacheKey) -> tuple[str, bytes] | None:
    global CACHE_BYTES
    now = time.monotonic()
    with CACHE_LOCK:
        cached = RESPONSE_CACHE.get(cache_key)
        if not cached:
            return None
        expires_at, content_type, content = cached
        if expires_at <= now:
            RESPONSE_CACHE.pop(cache_key, None)
            CACHE_BYTES -= len(content)
            return None
        RESPONSE_CACHE.move_to_end(cache_key)
        return content_type, content


def set_cached_response(cache_key: ResponseCacheKey, content_type: str, content: bytes) -> None:
    global CACHE_BYTES
    if CACHE_TTL_SECONDS <= 0 or len(content) > CACHE_MAX_BYTES:
        return
    expires_at = time.monotonic() + CACHE_TTL_SECONDS
    with CACHE_LOCK:
        previous = RESPONSE_CACHE.pop(cache_key, None)
        if previous:
            CACHE_BYTES -= len(previous[2])
        RESPONSE_CACHE[cache_key] = (expires_at, content_type, content)
        CACHE_BYTES += len(content)
        while len(RESPONSE_CACHE) > CACHE_MAX_SIZE or CACHE_BYTES > CACHE_MAX_BYTES:
            _, removed = RESPONSE_CACHE.popitem(last=False)
            CACHE_BYTES -= len(removed[2])


def cache_size() -> int:
    with CACHE_LOCK:
        return len(RESPONSE_CACHE)


def load_api_key() -> str:
    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        return ""
    if not API_KEY_RE.fullmatch(api_key):
        raise ValueError(f"{API_KEY_ENV} must be exactly 32 hexadecimal characters")
    return api_key


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


UPSTREAM_OPENER = urllib.request.build_opener(NoRedirectHandler())


def fetch_opendict(api_key: str, word: str, method: str, num: int, start: int) -> tuple[str, bytes]:
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
        "start": str(start),
        "num": str(num),
    }
    url = f"{API_ENDPOINT}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Connection": "close",
            "User-Agent": "KkungOpenDictProxy/1",
        },
        method="GET",
    )
    deadline = time.monotonic() + UPSTREAM_TIMEOUT_SECONDS
    with UPSTREAM_OPENER.open(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
        declared_length = response.headers.get("Content-Length", "").strip()
        if declared_length:
            try:
                parsed_length = int(declared_length)
                if parsed_length < 0:
                    raise InvalidUpstreamResponse
                if parsed_length > UPSTREAM_MAX_RESPONSE_BYTES:
                    raise UpstreamResponseTooLarge
            except ValueError as error:
                raise InvalidUpstreamResponse from error
        media_type = response.headers.get_content_type().lower()
        if media_type not in {"application/json", "text/json"} and not media_type.endswith("+json"):
            raise InvalidUpstreamResponse
        chunks: list[bytes] = []
        total = 0
        while True:
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise socket.timeout("upstream deadline exceeded")
            response_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
            if response_socket is not None:
                response_socket.settimeout(max(0.1, remaining_seconds))
            read_size = min(64 * 1024, UPSTREAM_MAX_RESPONSE_BYTES + 1 - total)
            read_method = getattr(response, "read1", response.read)
            chunk = read_method(read_size)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > UPSTREAM_MAX_RESPONSE_BYTES:
                raise UpstreamResponseTooLarge
        content = b"".join(chunks)
    try:
        json.loads(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InvalidUpstreamResponse from error
    return "application/json; charset=UTF-8", content


class HeaderLimitReader:
    def __init__(self, raw_reader):  # noqa: ANN001
        self.raw_reader = raw_reader
        self.total = 0

    def readline(self, size: int = -1) -> bytes:
        remaining = MAX_HEADER_BYTES - self.total
        if remaining <= 0:
            raise http.client.LineTooLong("header section")
        requested = MAX_HEADER_LINE_BYTES + 1
        if size >= 0:
            requested = min(requested, size)
        requested = min(requested, remaining + 1)
        line = self.raw_reader.readline(requested)
        self.total += len(line)
        if len(line) > MAX_HEADER_LINE_BYTES or self.total > MAX_HEADER_BYTES:
            raise http.client.LineTooLong("header section")
        return line


def safe_log(event: dict) -> None:
    # Deliberately log no URL query, headers, API key, word, referrer, or user agent.
    with LOG_LOCK:
        print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "KkungProxy"
    sys_version = ""

    def __init__(self, *args, directory: str | None = None, **kwargs):
        self._cors_origin_value = ""
        self._default_cache_control = "no-store"
        super().__init__(*args, directory=directory or str(ROOT), **kwargs)

    def setup(self) -> None:
        self.request.settimeout(CLIENT_SOCKET_TIMEOUT_SECONDS)
        super().setup()

    def parse_request(self) -> bool:
        if len(self.raw_requestline) > MAX_REQUEST_LINE_BYTES:
            self.requestline = ""
            self.request_version = ""
            self.command = None
            self.send_error(HTTPStatus.REQUEST_URI_TOO_LONG)
            return False
        raw_reader = self.rfile
        self.rfile = HeaderLimitReader(raw_reader)
        try:
            parsed = super().parse_request()
        finally:
            self.rfile = raw_reader
        if not parsed:
            return False
        if self.request_version not in {"HTTP/1.0", "HTTP/1.1"}:
            self.send_error(HTTPStatus.HTTP_VERSION_NOT_SUPPORTED)
            return False
        if len(self.path.encode("utf-8", errors="ignore")) > MAX_URI_BYTES:
            self.send_error(HTTPStatus.REQUEST_URI_TOO_LONG)
            return False
        return True

    def handle_expect_100(self) -> bool:
        self.send_error(HTTPStatus.EXPECTATION_FAILED)
        return False

    def do_OPTIONS(self) -> None:
        if not self._validate_request_envelope():
            return
        parsed = self._parse_target()
        if not parsed or parsed.path != API_PATH or parsed.query:
            self._write_method_not_allowed("GET, HEAD")
            return
        if not self._authorize_origin(require_explicit=True):
            return
        if not self._allow_rate_limited(API_RATE_LIMITER, RATE_LIMIT_WINDOW_SECONDS):
            return
        requested_method = (self.headers.get("Access-Control-Request-Method") or "").strip().upper()
        if requested_method != "GET":
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid preflight method."}})
            return
        raw_headers = self.headers.get("Access-Control-Request-Headers", "")
        requested_headers = {header.strip().lower() for header in raw_headers.split(",") if header.strip()}
        if not requested_headers.issubset({"accept", "x-trace-id"}):
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid preflight headers."}})
            return
        self.write_bytes(
            HTTPStatus.NO_CONTENT,
            "application/json; charset=UTF-8",
            b"",
            request_id=uuid.uuid4().hex[:12],
            cache_status="BYPASS",
            extra_headers={
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Accept, X-Trace-Id",
                "Access-Control-Max-Age": "600",
            },
        )

    def do_GET(self) -> None:
        if not self._validate_request_envelope():
            return
        parsed = self._parse_target()
        if not parsed:
            return
        if parsed.path == API_PATH:
            self.handle_opendict(parsed)
            return
        self._serve_static(parsed, head_only=False)

    def do_HEAD(self) -> None:
        if not self._validate_request_envelope():
            return
        parsed = self._parse_target()
        if not parsed:
            return
        if parsed.path == API_PATH:
            self._write_method_not_allowed("GET, OPTIONS")
            return
        self._serve_static(parsed, head_only=True)

    def do_POST(self) -> None:
        self._reject_method()

    def do_PUT(self) -> None:
        self._reject_method()

    def do_PATCH(self) -> None:
        self._reject_method()

    def do_DELETE(self) -> None:
        self._reject_method()

    def do_TRACE(self) -> None:
        self._reject_method()

    def do_CONNECT(self) -> None:
        self._reject_method()

    def _reject_method(self) -> None:
        self.close_connection = True
        parsed = urllib.parse.urlsplit(self.path)
        allow = "GET, OPTIONS" if parsed.path == API_PATH else "GET, HEAD"
        self._write_method_not_allowed(allow)

    def _write_method_not_allowed(self, allow: str) -> None:
        self.write_json(
            HTTPStatus.METHOD_NOT_ALLOWED,
            {"error": {"message": "Method not allowed."}},
            extra_headers={"Allow": allow},
        )

    def _validate_request_envelope(self) -> bool:
        for _, value in self.headers.items():
            if "\r" in value or "\n" in value or "\x00" in value:
                self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid headers."}})
                return False
        if self.headers.get("Transfer-Encoding"):
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Transfer-Encoding is not accepted."}})
            return False
        content_lengths = self.headers.get_all("Content-Length") or []
        if len(content_lengths) > 1:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid Content-Length."}})
            return False
        if content_lengths:
            content_length = content_lengths[0].strip()
            if not re.fullmatch(r"0+", content_length):
                status = HTTPStatus.REQUEST_ENTITY_TOO_LARGE if content_length.isdigit() else HTTPStatus.BAD_REQUEST
                self.write_json(status, {"error": {"message": "Request bodies are not accepted."}})
                return False
        if self.headers.get("Expect"):
            self.write_json(HTTPStatus.EXPECTATION_FAILED, {"error": {"message": "Expect is not supported."}})
            return False
        host_headers = self.headers.get_all("Host") or []
        if self.request_version == "HTTP/1.1" and len(host_headers) != 1:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid Host header."}})
            return False
        if len(host_headers) > 1:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid Host header."}})
            return False
        if host_headers:
            host = normalize_host(host_headers[0])
            if not host:
                self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid Host header."}})
                return False
            if ALLOWED_HOSTS and host not in ALLOWED_HOSTS:
                self.write_json(HTTPStatus.MISDIRECTED_REQUEST, {"error": {"message": "Host is not allowed."}})
                return False
        for header_name in ("Origin", "X-Forwarded-For"):
            if len(self.headers.get_all(header_name) or []) > 1:
                self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Duplicate security header."}})
                return False
        return True

    def _parse_target(self) -> urllib.parse.SplitResult | None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
        except ValueError:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid request target."}})
            return None
        if parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith("/"):
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Invalid request target."}})
            return None
        return parsed

    def _authorize_origin(self, *, require_explicit: bool = False) -> bool:
        fetch_site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if fetch_site in {"cross-site", "same-site"}:
            self.write_json(
                HTTPStatus.FORBIDDEN,
                {"error": {"message": "Cross-site requests are not allowed."}},
            )
            return False
        if fetch_site and fetch_site not in {"same-origin", "none"}:
            self.write_json(
                HTTPStatus.FORBIDDEN,
                {"error": {"message": "Unsupported fetch context."}},
            )
            return False
        fetch_dest = (self.headers.get("Sec-Fetch-Dest") or "").strip().lower()
        if fetch_dest and fetch_dest != "empty":
            self.write_json(
                HTTPStatus.FORBIDDEN,
                {"error": {"message": "Non-fetch requests are not allowed."}},
            )
            return False
        raw_origin = (self.headers.get("Origin") or "").strip()
        if not raw_origin:
            if require_explicit:
                self.write_json(HTTPStatus.FORBIDDEN, {"error": {"message": "Origin is required."}})
                return False
            return True
        origin = normalize_origin(raw_origin)
        if not origin:
            self.write_json(HTTPStatus.FORBIDDEN, {"error": {"message": "Origin is not allowed."}})
            return False
        if origin in ALLOWED_ORIGINS:
            self._cors_origin_value = origin
            return True
        host = normalize_host(self.headers.get("Host") or "")
        origin_host = normalize_host(urllib.parse.urlsplit(origin).netloc)
        if not require_explicit and host and origin_host == host:
            # Same-origin requests require no CORS response header.
            return True
        self.write_json(HTTPStatus.FORBIDDEN, {"error": {"message": "Origin is not allowed."}})
        return False

    def _client_key(self) -> str:
        peer_ip = self.client_address[0] if self.client_address else "unknown"
        forwarded_for = self.headers.get("X-Forwarded-For", "")
        return resolve_client_ip(peer_ip, forwarded_for, TRUSTED_PROXY_NETWORKS)

    def _allow_rate_limited(self, limiter: BoundedRateLimiter, window: int) -> bool:
        if limiter.allow(self._client_key()):
            return True
        self.write_json(
            HTTPStatus.TOO_MANY_REQUESTS,
            {"error": {"message": "Too many requests."}},
            extra_headers={"Retry-After": str(max(1, window))},
        )
        return False

    def _serve_static(self, parsed: urllib.parse.SplitResult, *, head_only: bool) -> None:
        if not self._allow_rate_limited(STATIC_RATE_LIMITER, STATIC_RATE_LIMIT_WINDOW_SECONDS):
            return
        if not static_path_is_allowed(parsed.path, parsed.query):
            self.write_json(HTTPStatus.NOT_FOUND, {"error": {"message": "Not found."}})
            return
        self._default_cache_control = (
            "no-cache" if parsed.path in {"/", "/index.html"} else "public, max-age=3600"
        )
        if head_only:
            super().do_HEAD()
        else:
            super().do_GET()

    def handle_opendict(self, parsed: urllib.parse.SplitResult) -> None:
        request_started = time.perf_counter()
        if not self._authorize_origin():
            self.log_api("", "origin_rejected", request_started)
            return
        if not self._allow_rate_limited(API_RATE_LIMITER, RATE_LIMIT_WINDOW_SECONDS):
            self.log_api("", "rate_limited", request_started)
            return

        parse_started = time.perf_counter()
        try:
            query = parse_api_query(parsed.query)
        except RequestValidationError as error:
            request_id = self._request_id("")
            self.write_json(
                error.status,
                {"error": {"message": error.public_message}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "bad_request", request_started, parse_ms=elapsed_ms(parse_started))
            return
        request_id = self._request_id(query.trace_id)
        parse_ms = elapsed_ms(parse_started)

        try:
            api_key = load_api_key()
        except ValueError:
            self.write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": {"message": "OpenDict proxy is not configured."}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "invalid_configuration", request_started, parse_ms=parse_ms)
            return
        if not api_key:
            self.write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": {"message": "OpenDict proxy is not configured."}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "missing_key", request_started, parse_ms=parse_ms)
            return

        cache_key = (query.word, query.method, query.num, query.start)
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

        if not UPSTREAM_SEMAPHORE.acquire(timeout=UPSTREAM_QUEUE_WAIT_SECONDS):
            self.write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": {"message": "OpenDict proxy is busy."}, "requestId": request_id},
                request_id=request_id,
                extra_headers={"Retry-After": "1"},
            )
            self.log_api(request_id, "busy", request_started, parse_ms=parse_ms)
            return

        upstream_started = time.perf_counter()
        try:
            content_type, content = fetch_opendict(
                api_key, query.word, query.method, query.num, query.start
            )
        except urllib.error.HTTPError as error:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": "OpenDict upstream rejected the request."}, "requestId": request_id},
                request_id=request_id,
                server_timing=f"parse;dur={parse_ms}, upstream;dur={elapsed_ms(upstream_started)}",
            )
            status_code = error.code if isinstance(error.code, int) and 100 <= error.code <= 599 else 0
            self.log_api(request_id, f"upstream_http_{status_code}", request_started, parse_ms=parse_ms)
            return
        except (urllib.error.URLError, socket.timeout, TimeoutError):
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": "OpenDict upstream is unavailable."}, "requestId": request_id},
                request_id=request_id,
                server_timing=f"parse;dur={parse_ms}, upstream;dur={elapsed_ms(upstream_started)}",
            )
            self.log_api(request_id, "upstream_unavailable", request_started, parse_ms=parse_ms)
            return
        except UpstreamResponseTooLarge:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": "OpenDict response was too large."}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "upstream_too_large", request_started, parse_ms=parse_ms)
            return
        except InvalidUpstreamResponse:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": "OpenDict returned an invalid response."}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "upstream_invalid", request_started, parse_ms=parse_ms)
            return
        except Exception:
            self.write_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": "OpenDict request failed."}, "requestId": request_id},
                request_id=request_id,
            )
            self.log_api(request_id, "upstream_error", request_started, parse_ms=parse_ms)
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
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        request_id = request_id or uuid.uuid4().hex[:12]
        body.setdefault("requestId", request_id)
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.write_bytes(
            status,
            "application/json; charset=UTF-8",
            payload,
            request_id=request_id,
            cache_status="BYPASS",
            server_timing=server_timing,
            extra_headers=extra_headers,
        )

    def write_bytes(
        self,
        status: HTTPStatus,
        content_type: str,
        content: bytes,
        *,
        request_id: str,
        cache_status: str,
        server_timing: str = "",
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/json; charset=UTF-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "private, max-age=300" if status == HTTPStatus.OK else "no-store")
        self.send_header("X-Request-ID", request_id)
        self.send_header("X-Cache", cache_status)
        self.send_header("Vary", "Origin")
        if self._cors_origin_value:
            self.send_header("Access-Control-Allow-Origin", self._cors_origin_value)
        if server_timing:
            self.send_header("Server-Timing", server_timing)
        for name, value in (extra_headers or {}).items():
            if re.fullmatch(r"[A-Za-z0-9-]+", name) and "\r" not in value and "\n" not in value:
                self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and status not in {HTTPStatus.NO_CONTENT, HTTPStatus.NOT_MODIFIED}:
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                self.close_connection = True

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        del message, explain
        if code == HTTPStatus.NOT_IMPLEMENTED:
            code = HTTPStatus.METHOD_NOT_ALLOWED
        try:
            status = HTTPStatus(code)
        except ValueError:
            status = HTTPStatus.INTERNAL_SERVER_ERROR
        public_message = "Request could not be processed."
        if status == HTTPStatus.NOT_FOUND:
            public_message = "Not found."
        elif status == HTTPStatus.METHOD_NOT_ALLOWED:
            public_message = "Method not allowed."
        elif status == HTTPStatus.REQUEST_URI_TOO_LONG:
            public_message = "Request target is too long."
        elif status == HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE:
            public_message = "Request headers are too large."
        self.write_json(status, {"error": {"message": public_message}})

    def end_headers(self) -> None:
        self.close_connection = True
        if not self._header_was_sent("Cache-Control"):
            self.send_header("Cache-Control", self._default_cache_control)
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Permitted-Cross-Domain-Policies", "none")
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        if ENABLE_HSTS:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        super().end_headers()

    def _header_was_sent(self, name: str) -> bool:
        prefix = name.lower().encode("ascii") + b":"
        return any(header.lower().startswith(prefix) for header in getattr(self, "_headers_buffer", []))

    def translate_path(self, path: str) -> str:
        parsed = urllib.parse.urlsplit(path)
        decoded_path = decode_static_path(parsed.path)
        if decoded_path is None:
            return str(ROOT / "__blocked__")
        if decoded_path == "/":
            target = ROOT
        else:
            target = ROOT.joinpath(*decoded_path.lstrip("/").split("/"))
        try:
            if path_has_symlink_component(target):
                return str(ROOT / "__blocked__")
            resolved = target.resolve()
            resolved.relative_to(ROOT_RESOLVED)
            if not static_target_is_safe(decoded_path, resolved):
                return str(ROOT / "__blocked__")
        except (OSError, ValueError):
            return str(ROOT / "__blocked__")
        return str(resolved)

    def list_directory(self, path: str):  # noqa: ANN001
        del path
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        del code, size

    def log_message(self, format: str, *args) -> None:
        del format, args

    def log_api(
        self,
        request_id: str,
        status: str,
        started: float,
        *,
        parse_ms: float = 0,
        upstream_ms: float = 0,
    ) -> None:
        safe_log(
            {
                "requestId": request_id or uuid.uuid4().hex[:12],
                "path": API_PATH,
                "status": status,
                "totalMs": elapsed_ms(started),
                "parseMs": parse_ms,
                "upstreamMs": upstream_ms,
                "cacheSize": cache_size(),
            }
        )

    def _request_id(self, query_value: str) -> str:
        header_value = (self.headers.get("X-Trace-Id") or "").strip()
        value = header_value or query_value
        if value and TRACE_ID_RE.fullmatch(value):
            return value
        return uuid.uuid4().hex[:12]


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False
    block_on_close = True
    request_queue_size = LISTEN_BACKLOG

    def __init__(self, server_address, request_handler_class, max_connections: int = MAX_ACTIVE_CONNECTIONS):
        self._connection_slots = threading.BoundedSemaphore(max_connections)
        super().__init__(server_address, request_handler_class)

    def get_request(self):  # noqa: ANN001
        request, client_address = super().get_request()
        request.settimeout(CLIENT_SOCKET_TIMEOUT_SECONDS)
        return request, client_address

    def process_request(self, request, client_address) -> None:  # noqa: ANN001
        if not self._connection_slots.acquire(blocking=False):
            self._reject_over_capacity(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._connection_slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:  # noqa: ANN001
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_slots.release()

    def _reject_over_capacity(self, request) -> None:  # noqa: ANN001
        response = (
            b"HTTP/1.1 503 Service Unavailable\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: 46\r\n"
            b"Cache-Control: no-store\r\n"
            b"X-Content-Type-Options: nosniff\r\n"
            b"Referrer-Policy: no-referrer\r\n"
            b"Connection: close\r\n"
            b"Retry-After: 1\r\n\r\n"
            b'{"error":{"message":"Server is at capacity."}}'
        )
        try:
            request.settimeout(0.25)
            request.sendall(response)
        except OSError:
            pass
        finally:
            self.shutdown_request(request)

    def handle_error(self, request, client_address) -> None:  # noqa: ANN001
        del request, client_address
        safe_log({"event": "request_handler_error"})


def elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Hardened static site and OpenDict API proxy")
    # Loopback is the safe default; put this behind a trusted edge and opt in
    # explicitly to a public bind (for example, --host 0.0.0.0).
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8787)))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if args.host.strip().lower() in {"0.0.0.0", "::", "::0"}:
        if not ALLOWED_HOSTS:
            parser.error("public binds require OPENDICT_ALLOWED_HOSTS")
        if not ALLOWED_ORIGINS:
            parser.error("public binds require OPENDICT_ALLOWED_ORIGINS")

    try:
        configured_key = load_api_key()
    except ValueError as error:
        parser.error(str(error))

    mimetypes.add_type("text/javascript; charset=UTF-8", ".js")
    mimetypes.add_type("text/css; charset=UTF-8", ".css")
    mimetypes.add_type("application/json; charset=UTF-8", ".json")

    server = BoundedThreadingHTTPServer((args.host, args.port), Handler)
    server.timeout = 0.5
    stop_event = threading.Event()

    def request_stop(signum, frame) -> None:  # noqa: ANN001
        del signum, frame
        stop_event.set()

    handled_signals = [signal.SIGINT]
    if hasattr(signal, "SIGTERM"):
        handled_signals.append(signal.SIGTERM)
    previous_handlers = {handled_signal: signal.getsignal(handled_signal) for handled_signal in handled_signals}
    for handled_signal in handled_signals:
        signal.signal(handled_signal, request_stop)

    safe_log(
        {
            "event": "server_started",
            "address": args.host,
            "port": args.port,
            "apiKeyConfigured": bool(configured_key),
            "allowedOrigins": len(ALLOWED_ORIGINS),
            "trustedProxyNetworks": len(TRUSTED_PROXY_NETWORKS),
            "maxConnections": MAX_ACTIVE_CONNECTIONS,
        }
    )
    try:
        while not stop_event.is_set():
            server.handle_request()
    finally:
        server.server_close()
        for handled_signal, previous_handler in previous_handlers.items():
            signal.signal(handled_signal, previous_handler)
        safe_log({"event": "server_stopped"})


if __name__ == "__main__":
    main()
