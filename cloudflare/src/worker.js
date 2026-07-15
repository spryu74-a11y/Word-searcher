const API_PATH = "/api/opendict/search";
const API_PREFIX = "/api/";
const OPENDICT_ENDPOINT = "https://opendict.korean.go.kr/api/search";

const MAX_URL_LENGTH = 2_048;
const MAX_QUERY_LENGTH = 768;
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 7_000;
const CACHE_TTL_SECONDS = 300;
const MAX_IN_FLIGHT_KEYS = 32;

const HANGUL_RE = /^[\uac00-\ud7a3]{1,50}$/u;
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const API_KEY_RE = /^[0-9a-f]{32}$/i;
const INTEGER_RE = /^[1-9][0-9]*$/;
const ALLOWED_METHODS = new Set(["exact", "start"]);
const ALLOWED_QUERY_KEYS = new Set([
  "q",
  "method",
  "num",
  "start",
  "req_type",
  "part",
  "sort",
  "advanced",
  "target",
  "type1",
  "type3"
]);
const FIXED_QUERY_VALUES = new Map([
  ["req_type", "json"],
  ["part", "word"],
  ["sort", "dict"],
  ["advanced", "y"],
  ["target", "1"],
  ["type1", "word"],
  ["type3", "all"]
]);

const IN_FLIGHT = new Map();

class UpstreamFailure extends Error {
  constructor(kind) {
    super(kind);
    this.name = "UpstreamFailure";
    this.kind = kind;
  }
}

export default {
  async fetch(request, env, ctx) {
    const cache = globalThis.caches && globalThis.caches.default
      ? globalThis.caches.default
      : null;
    return handleRequest(request, env, ctx, {
      fetchImpl: globalThis.fetch,
      cache
    });
  }
};

export async function handleRequest(request, env = {}, ctx = {}, dependencies = {}) {
  const url = new URL(request.url);

  if (url.pathname !== API_PATH) {
    if (url.pathname.startsWith(API_PREFIX)) {
      return jsonError(404, "Not found.", request, url);
    }
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      const asset = await env.ASSETS.fetch(request);
      return secureAssetResponse(asset);
    }
    return jsonError(404, "Not found.", request, url);
  }

  const requestId = getRequestId(request);
  const originError = validateSameOrigin(request, url);
  if (originError) {
    return jsonError(403, originError, request, url, requestId);
  }

  if (request.method === "OPTIONS") {
    return handlePreflight(request, url, requestId);
  }
  if (request.method !== "GET") {
    return jsonError(405, "Method not allowed.", request, url, requestId, {
      Allow: "GET, OPTIONS"
    });
  }

  if (request.url.length > MAX_URL_LENGTH || url.search.length > MAX_QUERY_LENGTH) {
    return jsonError(414, "Request URL is too long.", request, url, requestId);
  }

  const contentLength = parseNonNegativeInteger(request.headers.get("Content-Length"));
  if (request.headers.has("Content-Length") && contentLength === null) {
    return jsonError(400, "Invalid Content-Length.", request, url, requestId);
  }
  if (request.body !== null || contentLength > 0) {
    return jsonError(413, "Request body is not accepted.", request, url, requestId);
  }

  const validation = validateSearchParams(url.searchParams);
  if (!validation.ok) {
    return jsonError(400, "Invalid query.", request, url, requestId);
  }

  const rateLimitResponse = await enforceRateLimits(request, env, url, requestId);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const cache = dependencies.cache || null;
  const cacheKey = createCacheKey(url, validation.value);
  if (cache && typeof cache.match === "function") {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return successResponse(cached.body, request, url, requestId, "HIT", cached.headers.get("Content-Type"));
      }
    } catch {
      // Cache failures must not make the API unavailable.
    }
  }

  const apiKey = String(env.OPENDICT_API_KEY || "").trim();
  if (!API_KEY_RE.test(apiKey)) {
    return jsonError(503, "OpenDict service is not configured.", request, url, requestId);
  }

  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return jsonError(503, "OpenDict service is unavailable.", request, url, requestId);
  }

  let upstreamPromise = IN_FLIGHT.get(cacheKey.url);
  if (!upstreamPromise) {
    if (IN_FLIGHT.size >= MAX_IN_FLIGHT_KEYS) {
      return jsonError(503, "OpenDict proxy is busy.", request, url, requestId, {
        "Retry-After": "5"
      });
    }
    upstreamPromise = fetchOpenDict(validation.value, apiKey, fetchImpl);
    IN_FLIGHT.set(cacheKey.url, upstreamPromise);
    upstreamPromise.then(
      () => IN_FLIGHT.delete(cacheKey.url),
      () => IN_FLIGHT.delete(cacheKey.url)
    );
  }

  let upstream;
  try {
    upstream = await upstreamPromise;
  } catch (error) {
    const status = error instanceof UpstreamFailure && error.kind === "timeout" ? 504 : 502;
    return jsonError(status, "OpenDict upstream request failed.", request, url, requestId);
  }

  if (cache && typeof cache.put === "function") {
    const cacheResponse = new Response(upstream.body.slice(), {
      status: 200,
      headers: {
        "Content-Type": upstream.contentType,
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "X-Content-Type-Options": "nosniff"
      }
    });
    const write = Promise.resolve(cache.put(cacheKey, cacheResponse)).catch(() => undefined);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(write);
    } else {
      await write;
    }
  }

  return successResponse(upstream.body, request, url, requestId, "MISS", upstream.contentType);
}

function secureAssetResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  if ((headers.get("Content-Type") || "").toLowerCase().startsWith("text/html")) {
    headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'self' https://r.jina.ai https://wordrow.kr https://ko.wiktionary.org; manifest-src 'self'; media-src 'none'; upgrade-insecure-requests");
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function validateSearchParams(searchParams) {
  const counts = new Map();
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      return { ok: false };
    }
    counts.set(key, (counts.get(key) || 0) + 1);
    if (counts.get(key) > 1) {
      return { ok: false };
    }
  }

  for (const [key, expected] of FIXED_QUERY_VALUES) {
    if (searchParams.has(key) && searchParams.get(key) !== expected) {
      return { ok: false };
    }
  }

  const rawQuery = searchParams.get("q") || "";
  const query = rawQuery.normalize("NFC");
  const method = searchParams.get("method") || "exact";
  const num = parseBoundedInteger(searchParams.get("num"), 1, 100, 20);
  const start = parseBoundedInteger(searchParams.get("start"), 1, 1_000, 1);

  if (!HANGUL_RE.test(query) || !ALLOWED_METHODS.has(method) || num === null || start === null) {
    return { ok: false };
  }

  return {
    ok: true,
    value: { query, method, num, start }
  };
}

async function enforceRateLimits(request, env, url, requestId) {
  const clientLimiter = env.OPENDICT_RATE_LIMITER;
  const globalLimiter = env.OPENDICT_GLOBAL_RATE_LIMITER;
  if (!clientLimiter || typeof clientLimiter.limit !== "function" ||
      !globalLimiter || typeof globalLimiter.limit !== "function") {
    return jsonError(503, "Rate limiting is not configured.", request, url, requestId);
  }

  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    const clientResult = await clientLimiter.limit({ key: `opendict:${clientIp}` });
    if (!clientResult || clientResult.success !== true) {
      return jsonError(429, "Too many requests.", request, url, requestId, {
        "Retry-After": "10"
      });
    }

    const globalResult = await globalLimiter.limit({ key: "opendict:global" });
    if (!globalResult || globalResult.success !== true) {
      return jsonError(429, "OpenDict capacity limit reached.", request, url, requestId, {
        "Retry-After": "60"
      });
    }
  } catch {
    return jsonError(503, "Rate limiting is temporarily unavailable.", request, url, requestId, {
      "Retry-After": "5"
    });
  }

  return null;
}

async function fetchOpenDict(query, apiKey, fetchImpl) {
  const upstreamUrl = new URL(OPENDICT_ENDPOINT);
  upstreamUrl.search = new URLSearchParams({
    key: apiKey,
    q: query.query,
    req_type: "json",
    part: "word",
    sort: "dict",
    advanced: "y",
    target: "1",
    method: query.method,
    type1: "word",
    type3: "all",
    start: String(query.start),
    num: String(query.num)
  }).toString();

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

  let response;
  try {
    response = await fetchImpl(upstreamUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
  } catch {
    throw new UpstreamFailure(timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status !== 200) {
    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new UpstreamFailure("status");
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (!/^(?:application\/(?:[a-z0-9.+-]*\+)?json)(?:\s*;|$)/i.test(contentType)) {
    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new UpstreamFailure("content_type");
  }

  const declaredLength = parseNonNegativeInteger(response.headers.get("Content-Length"));
  if (declaredLength > MAX_UPSTREAM_RESPONSE_BYTES) {
    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new UpstreamFailure("too_large");
  }

  const body = await readLimitedBody(response.body, MAX_UPSTREAM_RESPONSE_BYTES);
  if (body.byteLength === 0) {
    throw new UpstreamFailure("empty");
  }

  return {
    body,
    contentType: "application/json; charset=UTF-8"
  };
}

async function readLimitedBody(stream, maximumBytes) {
  if (!stream) {
    return new Uint8Array();
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamFailure("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function handlePreflight(request, url, requestId) {
  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (requestedMethod && requestedMethod !== "GET") {
    return jsonError(403, "CORS preflight rejected.", request, url, requestId);
  }

  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((value) => value !== "accept" && value !== "x-trace-id")) {
    return jsonError(403, "CORS preflight rejected.", request, url, requestId);
  }

  const headers = apiHeaders(request, url, requestId);
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept, X-Trace-Id");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 204, headers });
}

function validateSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) {
    return "Cross-origin requests are not allowed.";
  }
  const fetchSite = (request.headers.get("Sec-Fetch-Site") || "").trim().toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return "Cross-site requests are not allowed.";
  }
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return "Unsupported fetch context.";
  }
  const fetchDest = (request.headers.get("Sec-Fetch-Dest") || "").trim().toLowerCase();
  if (fetchDest && fetchDest !== "empty") {
    return "Non-fetch requests are not allowed.";
  }
  return "";
}

function createCacheKey(url, query) {
  const keyUrl = new URL(API_PATH, url.origin);
  keyUrl.search = new URLSearchParams({
    q: query.query,
    method: query.method,
    start: String(query.start),
    num: String(query.num)
  }).toString();
  return new Request(keyUrl.toString(), { method: "GET" });
}

function successResponse(body, request, url, requestId, cacheStatus, contentType) {
  const headers = apiHeaders(request, url, requestId);
  headers.set("Content-Type", contentType || "application/json; charset=UTF-8");
  headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`);
  headers.set("X-Cache", cacheStatus);
  return new Response(body, { status: 200, headers });
}

function jsonError(status, message, request, url, requestId = getRequestId(request), extraHeaders = {}) {
  const headers = apiHeaders(request, url, requestId);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  const payload = JSON.stringify({
    error: { message },
    requestId
  });
  return new Response(payload, { status, headers });
}

function apiHeaders(request, url, requestId) {
  const requestOrigin = request.headers.get("Origin");
  const headers = new Headers({
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Request-ID": requestId
  });
  if (requestOrigin === url.origin) {
    headers.set("Access-Control-Allow-Origin", requestOrigin);
  }
  return headers;
}

function getRequestId(request) {
  const supplied = String(request.headers.get("X-Trace-Id") || "").trim();
  if (TRACE_ID_RE.test(supplied)) {
    return supplied;
  }
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

function parseBoundedInteger(value, minimum, maximum, fallback) {
  if (value === null || value === "") {
    return fallback;
  }
  if (!INTEGER_RE.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseNonNegativeInteger(value) {
  if (value === null || value === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^[0-9]+$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}
