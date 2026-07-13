import { SELF } from "cloudflare:test";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "./server";

const MCP_URL = "https://example.com/mcp";
const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const TEST_CREDENTIALS = {
  "X-TripIt-Consumer-Key": "test-ck",
  "X-TripIt-Consumer-Secret": "test-cs",
  "X-TripIt-Access-Token": "test-at",
  "X-TripIt-Access-Token-Secret": "test-ats",
};

const ALL_TOOLS = [
  "tripit_list_trips",
  "tripit_get_trip",
  "tripit_create_trip",
  "tripit_update_trip",
  "tripit_delete_trip",
  "tripit_list_objects",
  "tripit_get_object",
  "tripit_create_flight",
  "tripit_create_hotel",
  "tripit_create_car",
  "tripit_create_activity",
  "tripit_update_object",
  "tripit_delete_object",
  "tripit_get_flight_status",
  "tripit_list_points_programs",
  "tripit_get_profile",
];

function rpc(method: string, params?: unknown, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

/** The subset of JSON-RPC result shapes these tests assert on. */
interface RpcEnvelope {
  result: {
    serverInfo: { name: string };
    tools: { name: string }[];
    content: { type: "text"; text: string }[];
    isError?: boolean;
  };
}

/** MCP responses over Streamable HTTP arrive as SSE; extract the JSON payload. */
async function readRpcResult(response: Response): Promise<RpcEnvelope> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`No SSE data line in response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  credentials: Record<string, string> = TEST_CREDENTIALS,
): Promise<RpcEnvelope> {
  const response = await SELF.fetch(MCP_URL, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...credentials },
    body: rpc("tools/call", { name, arguments: args }),
  });
  expect(response.status).toBe(200);
  return readRpcResult(response);
}

function parseOAuthHeader(header: string): Record<string, string> {
  expect(header.startsWith("OAuth ")).toBe(true);
  const params: Record<string, string> = {};
  for (const part of header.slice("OAuth ".length).split(", ")) {
    const [key, quoted] = part.split("=");
    params[key] = decodeURIComponent(quoted.replaceAll('"', ""));
  }
  return params;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Recomputes the expected HMAC-SHA1 signature for a captured request. */
async function expectedSignature(
  method: string,
  url: string,
  oauthParams: Record<string, string>,
  bodyParams: Record<string, string>,
  secrets: { consumerSecret: string; tokenSecret: string } = {
    consumerSecret: "test-cs",
    tokenSecret: "test-ats",
  },
): Promise<string> {
  const parsed = new URL(url);
  const paramString = [
    ...Object.entries(oauthParams).filter(([key]) => key !== "oauth_signature"),
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
  const signingKey = `${percentEncode(secrets.consumerSecret)}&${percentEncode(
    secrets.tokenSecret,
  )}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

describe("routing", () => {
  it("serves a health check without credentials", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, string>>();
    expect(body.status).toBe("ok");
    expect(body.endpoint).toBe("/tripit");
  });

  it("returns 404 for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/nope");
    expect(response.status).toBe(404);
  });

  it("serves an index at the hostname root", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, string>>();
    expect(body.endpoint).toBe("/tripit");
  });

  it("serves health under the base path", async () => {
    const response = await SELF.fetch("https://example.com/tripit/health");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, string>>();
    expect(body.status).toBe("ok");
  });

  it("serves the MCP endpoint at the base path", async () => {
    const response = await SELF.fetch("https://example.com/tripit", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...TEST_CREDENTIALS },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(200);
    const result = await readRpcResult(response);
    expect(result.result.tools.length).toBe(16);
  });

  it("keeps the legacy /mcp endpoint working alongside the base path", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...TEST_CREDENTIALS },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(200);
  });
});

describe("credential handling", () => {
  it("rejects /mcp requests without credentials", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: JSON_HEADERS,
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(401);
    const body = await response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain("/tripit/connect");
    expect(body.error.message).toContain("X-TripIt-Access-Token");
  });

  it("rejects incomplete credential headers, naming the missing ones", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        "X-TripIt-Consumer-Key": "test-ck",
        "X-TripIt-Access-Token": "test-at",
      },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(401);
    const body = await response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain("X-TripIt-Consumer-Secret");
    expect(body.error.message).toContain("X-TripIt-Access-Token-Secret");
  });

  it("accepts all four values via Authorization: Bearer", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: "Bearer test-ck:test-cs:test-at:test-ats",
      },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(200);
  });

  it("rejects a bearer token that is not two or four colon-separated values", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer just-one-value" },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(401);
    const body = await response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain("two colon-separated values");
  });

  it("accepts an access-token pair via headers, signed with the server's app", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.tripit.com/v1/get/profile/format/json", ({ request }) => {
        seenAuth = request.headers.get("Authorization");
        seenUrl = request.url;
        return HttpResponse.json({ Profile: {} });
      }),
    );

    const result = await callTool(
      "tripit_get_profile",
      {},
      {
        "X-TripIt-Access-Token": "user-at",
        "X-TripIt-Access-Token-Secret": "user-ats",
      },
    );
    expect(result.result.isError).toBeUndefined();

    const oauth = parseOAuthHeader(seenAuth as unknown as string);
    expect(oauth.oauth_consumer_key).toBe("server-ck");
    expect(oauth.oauth_token).toBe("user-at");
    expect(oauth.oauth_signature).toBe(
      await expectedSignature(
        "GET",
        seenUrl as unknown as string,
        oauth,
        {},
        {
          consumerSecret: "server-cs",
          tokenSecret: "user-ats",
        },
      ),
    );
  });

  it("accepts an access-token pair via a two-part bearer token", async () => {
    server.use(
      http.get("https://api.tripit.com/v1/get/profile/format/json", () =>
        HttpResponse.json({ Profile: {} }),
      ),
    );
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer user-at:user-ats" },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(200);
  });
});

describe("hosted connect flow", () => {
  it("serves the connect page under the base path and legacy path", async () => {
    for (const path of ["/tripit/connect", "/connect"]) {
      const response = await SELF.fetch(`https://example.com${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Connect your TripIt account");
      expect(html).toContain("tripit.com/developer");
    }
  });

  it("runs the full authorize round-trip and shows the minted tokens", async () => {
    let requestTokenBody: string | null = null;
    let accessTokenBody: string | null = null;
    server.use(
      http.post("https://api.tripit.com/oauth/request_token", async ({ request }) => {
        requestTokenBody = await request.text();
        return HttpResponse.text("oauth_token=rt-token&oauth_token_secret=rt-secret");
      }),
      http.post("https://api.tripit.com/oauth/access_token", async ({ request }) => {
        accessTokenBody = await request.text();
        return HttpResponse.text(
          "oauth_token=minted-token&oauth_token_secret=minted-secret",
        );
      }),
    );

    // Step 1+2: /start gets a request token and redirects to TripIt.
    const start = await SELF.fetch("https://example.com/tripit/connect/start", {
      method: "POST",
      redirect: "manual",
    });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://www.tripit.com");
    expect(location.pathname).toBe("/oauth/authorize");
    expect(location.searchParams.get("oauth_token")).toBe("rt-token");
    expect(location.searchParams.get("oauth_callback")).toBe(
      "https://example.com/tripit/connect/callback",
    );
    const startParams = new URLSearchParams(requestTokenBody as unknown as string);
    expect(startParams.get("oauth_consumer_key")).toBe("server-ck");

    const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0];
    expect(cookie).toContain("tripit_connect=");

    // Step 3: TripIt sends the user back; we exchange for an access token.
    const callback = await SELF.fetch(
      "https://example.com/tripit/connect/callback?oauth_token=rt-token",
      { headers: { Cookie: cookie } },
    );
    expect(callback.status).toBe(200);
    const html = await callback.text();
    expect(html).toContain("minted-token");
    expect(html).toContain("minted-secret");
    expect(html).toContain("Bearer minted-token:minted-secret");
    expect(html).toContain("https://example.com/tripit");

    const exchangeParams = new URLSearchParams(accessTokenBody as unknown as string);
    expect(exchangeParams.get("oauth_token")).toBe("rt-token");
    expect(exchangeParams.get("oauth_token_secret")).toBe("rt-secret");
    expect(exchangeParams.get("oauth_consumer_key")).toBe("server-ck");
    expect(exchangeParams.get("oauth_signature")).toBeTruthy();

    // The one-shot state cookie is cleared.
    expect(callback.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("uses custom app credentials from the advanced form", async () => {
    server.use(
      http.post("https://api.tripit.com/oauth/request_token", async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        expect(params.get("oauth_consumer_key")).toBe("my-own-ck");
        return HttpResponse.text("oauth_token=rt2&oauth_token_secret=rts2");
      }),
      http.post("https://api.tripit.com/oauth/access_token", () =>
        HttpResponse.text("oauth_token=at2&oauth_token_secret=ats2"),
      ),
    );

    const form = new URLSearchParams({
      consumer_key: "my-own-ck",
      consumer_secret: "my-own-cs",
    });
    const start = await SELF.fetch("https://example.com/tripit/connect/start", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(start.status).toBe(302);
    const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0];

    const callback = await SELF.fetch(
      "https://example.com/tripit/connect/callback?oauth_token=rt2",
      { headers: { Cookie: cookie } },
    );
    expect(callback.status).toBe(200);
    const html = await callback.text();
    // Bring-your-own-app flow shows all four values.
    expect(html).toContain("my-own-ck");
    expect(html).toContain("X-TripIt-Consumer-Secret");
    expect(html).toContain("Bearer my-own-ck:my-own-cs:at2:ats2");
  });

  it("rejects a callback without a valid state cookie", async () => {
    const response = await SELF.fetch(
      "https://example.com/tripit/connect/callback?oauth_token=rt-token",
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expired");
  });
});

describe("MCP protocol", () => {
  it("completes the initialize handshake", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...TEST_CREDENTIALS },
      body: rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    });
    expect(response.status).toBe(200);
    const result = await readRpcResult(response);
    expect(result.result.serverInfo.name).toBe("tripit");
  });

  it("lists all sixteen TripIt tools", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...TEST_CREDENTIALS },
      body: rpc("tools/list"),
    });
    const result = await readRpcResult(response);
    const names = result.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(ALL_TOOLS);
  });

  it("rejects invalid tool arguments before calling TripIt", async () => {
    const result = await callTool("tripit_create_trip", {
      display_name: "Tokyo",
      start_date: "June 2026",
      end_date: "2026-06-20",
    });
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain("YYYY-MM-DD");
  });
});

describe("TripIt integration", () => {
  it("signs GET requests with the caller's OAuth credentials", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.tripit.com/v1/list/trip/format/json", ({ request }) => {
        seenAuth = request.headers.get("Authorization");
        seenUrl = request.url;
        return HttpResponse.json({ Trip: [] });
      }),
    );

    const result = await callTool("tripit_list_trips", {});
    expect(result.result.isError).toBeUndefined();
    expect(seenAuth).not.toBeNull();
    expect(seenUrl).not.toBeNull();

    const oauth = parseOAuthHeader(seenAuth as unknown as string);
    expect(oauth.oauth_consumer_key).toBe("test-ck");
    expect(oauth.oauth_token).toBe("test-at");
    expect(oauth.oauth_signature_method).toBe("HMAC-SHA1");
    expect(oauth.oauth_signature).toBe(
      await expectedSignature("GET", seenUrl as unknown as string, oauth, {}),
    );
  });

  it("builds path-segment filters for object listing", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.tripit.com/v1/list/object/*", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ AirObject: [] });
      }),
    );

    const result = await callTool("tripit_list_objects", {
      object_type: "air",
      trip_id: "12345",
    });
    expect(result.result.isError).toBeUndefined();
    expect(seenUrl).toBe(
      "https://api.tripit.com/v1/list/object/trip_id/12345/type/air/format/json",
    );
  });

  it("sends creates as form-encoded POSTs with a signed json parameter", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    let seenBody: string | null = null;
    server.use(
      http.post("https://api.tripit.com/v1/create/format/json", async ({ request }) => {
        seenAuth = request.headers.get("Authorization");
        seenUrl = request.url;
        seenBody = await request.text();
        return HttpResponse.json({ Trip: { id: "999" } });
      }),
    );

    const result = await callTool("tripit_create_trip", {
      display_name: "Tokyo Trip",
      start_date: "2026-08-01",
      end_date: "2026-08-10",
    });
    expect(result.result.isError).toBeUndefined();

    const body = new URLSearchParams(seenBody as unknown as string);
    const payload = JSON.parse(body.get("json") ?? "{}");
    expect(payload.Trip).toMatchObject({
      display_name: "Tokyo Trip",
      start_date: "2026-08-01",
      end_date: "2026-08-10",
    });

    // The form body parameter must be part of the OAuth signature.
    const oauth = parseOAuthHeader(seenAuth as unknown as string);
    expect(oauth.oauth_signature).toBe(
      await expectedSignature("POST", seenUrl as unknown as string, oauth, {
        json: body.get("json") ?? "",
      }),
    );
  });

  it("surfaces upstream auth failures as tool errors, not crashes", async () => {
    server.use(
      http.get("https://api.tripit.com/v1/get/profile/format/json", () =>
        HttpResponse.text("invalid signature", { status: 401 }),
      ),
    );

    const result = await callTool("tripit_get_profile", {});
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain("rejected the OAuth credentials");
  });

  it("surfaces rate limiting with retry guidance", async () => {
    server.use(
      http.get("https://api.tripit.com/v1/get/profile/format/json", () =>
        HttpResponse.text("slow down", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      ),
    );

    const result = await callTool("tripit_get_profile", {});
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain("rate limit");
    expect(result.result.content[0].text).toContain("30");
  });
});
