const API_BASE = "https://api.tripit.com/v1";

/**
 * The four OAuth 1.0 values a caller must supply. TripIt signs every API
 * request with HMAC-SHA1 over consumer key/secret + access token/secret;
 * access tokens do not expire unless revoked.
 */
export interface TripItCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** Error thrown for non-2xx responses from the TripIt API. */
export class TripItApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TripItApiError";
  }
}

// RFC 3986 percent-encoding as required by the OAuth 1.0 signature spec
// (encodeURIComponent leaves !'()* unescaped).
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Builds an OAuth 1.0 HMAC-SHA1 Authorization header for one request.
 * `bodyParams` must contain any application/x-www-form-urlencoded POST body
 * parameters — the OAuth spec includes them in the signature base string.
 */
export async function buildOAuthHeader(
  method: string,
  url: string,
  credentials: TripItCredentials,
  bodyParams: Record<string, string> = {},
): Promise<string> {
  const parsed = new URL(url);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const paramString = [
    ...Object.entries(oauthParams),
    ...parsed.searchParams.entries(),
    ...Object.entries(bodyParams),
  ]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(`${parsed.origin}${parsed.pathname}`),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(
    credentials.accessTokenSecret,
  )}`;
  const signature = await hmacSha1(signingKey, baseString);

  const header = Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${percentEncode(value)}"`)
    .join(", ");
  return `OAuth ${header}`;
}

/**
 * Appends TripIt-style path-segment filters to a base path:
 * filterPath("/list/object", { type: "air", past: true }) →
 * "/list/object/type/air/past/true". Undefined/empty values are skipped.
 */
export function filterPath(
  base: string,
  filters: Record<string, string | number | boolean | undefined>,
): string {
  let path = base;
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") {
      path += `/${key}/${encodeURIComponent(String(value))}`;
    }
  }
  return path;
}

interface RequestOptions {
  method?: "GET" | "POST";
  /** JSON payload for create/replace; sent as the `json` form parameter. */
  jsonBody?: unknown;
  timeoutMs?: number;
}

/**
 * Minimal fetch-based client for the TripIt API v1.
 * https://tripit.github.io/api/doc/v1/
 *
 * TripIt encodes parameters as path segments and returns XML unless the
 * request path ends in /format/json; JSON create/replace payloads go in the
 * `json` form field of a form-encoded POST body.
 */
export class TripItClient {
  constructor(private readonly credentials: TripItCredentials) {}

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const { method = "GET", jsonBody, timeoutMs = 30_000 } = options;

    const url = `${API_BASE}${path}/format/json`;
    const bodyParams = jsonBody ? { json: JSON.stringify(jsonBody) } : undefined;
    const authorization = await buildOAuthHeader(
      method,
      url,
      this.credentials,
      bodyParams ?? {},
    );

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(bodyParams ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(bodyParams ? { body: new URLSearchParams(bodyParams).toString() } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    return response.json();
  }

  private async toApiError(response: Response): Promise<TripItApiError> {
    const status = response.status;
    const text = await response.text().catch(() => "");
    const detail = text.slice(0, 500);

    if (status === 401 || status === 403) {
      return new TripItApiError(
        `TripIt rejected the OAuth credentials (HTTP ${status}). Verify all four values sent in the X-TripIt-Consumer-Key, X-TripIt-Consumer-Secret, X-TripIt-Access-Token, and X-TripIt-Access-Token-Secret headers are correct and that the authorization has not been revoked. ${detail}`,
        status,
      );
    }

    if (status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : undefined;
      return new TripItApiError(
        `TripIt rate limit exceeded (HTTP 429).${
          retryAfterSeconds ? ` Retry after ${retryAfterSeconds}s.` : ""
        } ${detail}`,
        status,
        retryAfterSeconds,
      );
    }

    if (status === 404) {
      return new TripItApiError(
        `TripIt object not found (HTTP 404). Check the object type and ID. ${detail}`,
        status,
      );
    }

    return new TripItApiError(
      `TripIt API error (HTTP ${status}): ${detail || response.statusText}`,
      status,
    );
  }
}
