import { type OAuthSigner, signOAuthParams } from "./tripit-client";

/**
 * Hosted browser flow that mints TripIt access tokens for users, so nobody
 * has to understand OAuth or run a script.
 *
 *   GET  <prefix>            — landing page with a "Connect TripIt" button
 *   POST <prefix>/start      — gets a request token, redirects to TripIt
 *   GET  <prefix>/callback   — exchanges for an access token, shows the values
 *
 * The flow is TripIt's 3-step OAuth 1.0 web dance
 * (https://tripit.github.io/api/doc/v1/ § OAuth). The Worker stays stateless:
 * the request-token secret (and, for bring-your-own-app flows, the custom
 * consumer credentials) ride between /start and /callback in a short-lived
 * AES-GCM-sealed HttpOnly cookie in the user's own browser — nothing is
 * stored server-side, and the minted tokens are only ever shown to the user.
 *
 * One-click mode requires the deployment to have a registered TripIt app
 * (TRIPIT_CONSUMER_KEY/TRIPIT_CONSUMER_SECRET secrets). Users with their own
 * TripIt app can use the advanced form instead.
 */

const REQUEST_TOKEN_URL = "https://api.tripit.com/oauth/request_token";
const AUTHORIZE_URL = "https://www.tripit.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://api.tripit.com/oauth/access_token";

const COOKIE_NAME = "tripit_connect";
const STATE_TTL_SECONDS = 600;

interface ConnectState {
  /** Custom consumer credentials (bring-your-own-app flow only). */
  ck?: string;
  cs?: string;
  /** Request token secret from step 1. */
  rts: string;
  exp: number;
}

class ConnectError extends Error {}

// ---------------------------------------------------------------------------
// TripIt token endpoints (OAuth 1.0, parameters sent as a form-encoded body)
// ---------------------------------------------------------------------------

async function tokenRequest(
  url: string,
  signer: OAuthSigner,
  extraOAuthParams: Record<string, string> = {},
): Promise<{ token: string; tokenSecret: string }> {
  const params = await signOAuthParams("POST", url, signer, extraOAuthParams);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ConnectError(
      `TripIt rejected the request (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const parsed = new URLSearchParams(text);
  const token = parsed.get("oauth_token");
  const tokenSecret = parsed.get("oauth_token_secret");
  if (!token || !tokenSecret) {
    throw new ConnectError(
      `Unexpected token response from TripIt: ${text.slice(0, 300)}`,
    );
  }
  return { token, tokenSecret };
}

// ---------------------------------------------------------------------------
// Sealed cookie state (AES-GCM keyed off the deployment's consumer secret)
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function stateKey(env: Env): Promise<CryptoKey> {
  const secret = env.TRIPIT_CONSUMER_SECRET || "tripit-connect-unconfigured";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`tripit-connect-state:${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealState(state: ConnectState, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await stateKey(env),
    new TextEncoder().encode(JSON.stringify(state)),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function openState(sealed: string, env: Env): Promise<ConnectState | null> {
  try {
    const [iv, ciphertext] = sealed.split(".");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(iv) },
      await stateKey(env),
      base64UrlDecode(ciphertext),
    );
    const state: ConnectState = JSON.parse(new TextDecoder().decode(plaintext));
    if (state.exp < Math.floor(Date.now() / 1000)) return null;
    return state;
  } catch {
    return null;
  }
}

function getCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles requests under the connect prefix (e.g. "/tripit/connect").
 * The caller has already matched the prefix.
 */
export async function handleConnect(
  request: Request,
  env: Env,
  prefix: string,
): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice(prefix.length);
  const configured = Boolean(env.TRIPIT_CONSUMER_KEY && env.TRIPIT_CONSUMER_SECRET);

  if (sub === "" && request.method === "GET") {
    return htmlResponse(connectPage(configured, prefix));
  }

  if (sub === "/start" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const customKey = form?.get("consumer_key")?.toString().trim();
    const customSecret = form?.get("consumer_secret")?.toString().trim();

    let signer: OAuthSigner;
    if (customKey || customSecret) {
      if (!customKey || !customSecret) {
        return htmlResponse(
          errorPage("Both consumer key and consumer secret are required.", prefix),
          400,
        );
      }
      signer = { consumerKey: customKey, consumerSecret: customSecret };
    } else if (configured) {
      signer = {
        // Presence is guaranteed by `configured`.
        consumerKey: env.TRIPIT_CONSUMER_KEY as string,
        consumerSecret: env.TRIPIT_CONSUMER_SECRET as string,
      };
    } else {
      return htmlResponse(
        errorPage(
          "This deployment has no shared TripIt app configured. Use the advanced form with your own consumer key and secret.",
          prefix,
        ),
        400,
      );
    }

    let requestToken: { token: string; tokenSecret: string };
    try {
      requestToken = await tokenRequest(REQUEST_TOKEN_URL, signer);
    } catch (error) {
      return htmlResponse(
        errorPage(
          error instanceof ConnectError
            ? `Could not start the TripIt authorization: ${error.message}`
            : "Could not reach TripIt. Please try again.",
          prefix,
        ),
        502,
      );
    }

    const state: ConnectState = {
      ...(customKey ? { ck: customKey, cs: customSecret } : {}),
      rts: requestToken.tokenSecret,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    };
    const callbackUrl = `${url.origin}${prefix}/callback`;
    const authorizeUrl =
      `${AUTHORIZE_URL}?oauth_token=${encodeURIComponent(requestToken.token)}` +
      `&oauth_callback=${encodeURIComponent(callbackUrl)}`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl,
        "Set-Cookie": `${COOKIE_NAME}=${await sealState(state, env)}; Max-Age=${STATE_TTL_SECONDS}; Path=${prefix}; Secure; HttpOnly; SameSite=Lax`,
      },
    });
  }

  if (sub === "/callback" && request.method === "GET") {
    const requestTokenPublic = url.searchParams.get("oauth_token");
    const sealed = getCookie(request, COOKIE_NAME);
    const state = sealed ? await openState(sealed, env) : null;
    if (!requestTokenPublic || !state) {
      return htmlResponse(
        errorPage(
          "This authorization session has expired or the browser lost its state cookie. Please start over.",
          prefix,
        ),
        400,
      );
    }

    const custom = Boolean(state.ck && state.cs);
    const signer: OAuthSigner = custom
      ? { consumerKey: state.ck as string, consumerSecret: state.cs as string }
      : {
          consumerKey: env.TRIPIT_CONSUMER_KEY ?? "",
          consumerSecret: env.TRIPIT_CONSUMER_SECRET ?? "",
        };

    let accessToken: { token: string; tokenSecret: string };
    try {
      // TripIt's step 3 wants the request token and its secret as request
      // parameters, signed with consumerSecret&requestTokenSecret.
      accessToken = await tokenRequest(
        ACCESS_TOKEN_URL,
        { ...signer, token: requestTokenPublic, tokenSecret: state.rts },
        { oauth_token_secret: state.rts },
      );
    } catch (error) {
      return htmlResponse(
        errorPage(
          `TripIt did not authorize the connection${
            error instanceof ConnectError ? ` (${error.message})` : ""
          }. If you denied access, that is expected — start over to try again.`,
          prefix,
        ),
        502,
      );
    }

    const clearCookie = `${COOKIE_NAME}=; Max-Age=0; Path=${prefix}; Secure; HttpOnly; SameSite=Lax`;
    const endpoint = url.origin + prefix.replace(/\/connect$/, "");
    return htmlResponse(
      successPage(
        {
          endpoint,
          accessToken: accessToken.token,
          accessTokenSecret: accessToken.tokenSecret,
          ...(custom
            ? { consumerKey: state.ck as string, consumerSecret: state.cs as string }
            : {}),
        },
        prefix,
      ),
      200,
      { "Set-Cookie": clearCookie },
    );
  }

  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function htmlResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 680px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.55;
    }
    h1 { font-size: 1.4rem; }
    .card {
      border: 1px solid light-dark(#ddd, #3a3a3a); border-radius: 10px;
      padding: 1rem 1.25rem; margin: 1.25rem 0;
    }
    code, pre {
      background: light-dark(#f2f2f2, #2a2a2a); border-radius: 5px;
      font-size: 0.88em;
    }
    code { padding: 2px 7px; word-break: break-all; }
    pre { padding: 0.8rem 1rem; overflow-x: auto; }
    .btn {
      display: inline-block; background: light-dark(#0057b8, #2f6fd0); color: #fff;
      border: none; border-radius: 8px; padding: 0.7rem 1.4rem; font-size: 1rem;
      cursor: pointer;
    }
    label { display: block; margin: 0.6rem 0 0.2rem; font-size: 0.9em; }
    input {
      width: 100%; box-sizing: border-box; padding: 0.5rem;
      border: 1px solid light-dark(#ccc, #555); border-radius: 6px;
      background: light-dark(#fff, #1e1e1e); color: inherit;
    }
    .muted { color: light-dark(#555, #aaa); font-size: 0.9em; }
    .value { margin: 0.5rem 0; }
    .value b { display: block; font-size: 0.85em; margin-bottom: 2px; }
    a { color: light-dark(#0057b8, #7ab4ff); }
    details { margin-top: 1rem; }
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function connectPage(configured: boolean, prefix: string): string {
  const oneClick = configured
    ? `
  <div class="card">
    <p>Link your TripIt account and get the credentials your MCP client needs — no OAuth
    knowledge required. You'll sign in on tripit.com and be sent straight back here.</p>
    <form method="post" action="${prefix}/start">
      <button class="btn" type="submit">Connect your TripIt account</button>
    </form>
    <p class="muted">This server stores nothing: the credentials TripIt issues are shown
    only to you, in your browser, at the end of this flow.</p>
  </div>`
    : `
  <div class="card">
    <p class="muted">This deployment has no shared TripIt app configured, so one-click
    connect is unavailable. Use the advanced option below with your own TripIt API
    application.</p>
  </div>`;

  return layout(
    "Connect TripIt",
    `
  <h1>Connect your TripIt account</h1>
${oneClick}
  <details${configured ? "" : " open"}>
    <summary>Advanced: use your own TripIt API application</summary>
    <div class="card">
      <p class="muted">If you registered your own application at
      <a href="https://www.tripit.com/developer">tripit.com/developer</a>, authorize with
      its credentials instead. You'll get all four values and can use this MCP server
      fully independently.</p>
      <form method="post" action="${prefix}/start">
        <label for="consumer_key">Consumer key</label>
        <input id="consumer_key" name="consumer_key" autocomplete="off">
        <label for="consumer_secret">Consumer secret</label>
        <input id="consumer_secret" name="consumer_secret" type="password" autocomplete="off">
        <p><button class="btn" type="submit">Authorize with my app</button></p>
      </form>
    </div>
  </details>`,
  );
}

interface SuccessValues {
  endpoint: string;
  accessToken: string;
  accessTokenSecret: string;
  consumerKey?: string;
  consumerSecret?: string;
}

function successPage(values: SuccessValues, prefix: string): string {
  const custom = Boolean(values.consumerKey);
  const bearer = custom
    ? `${values.consumerKey}:${values.consumerSecret}:${values.accessToken}:${values.accessTokenSecret}`
    : `${values.accessToken}:${values.accessTokenSecret}`;

  const headerRows = [
    ...(custom
      ? [
          ["X-TripIt-Consumer-Key", values.consumerKey as string],
          ["X-TripIt-Consumer-Secret", values.consumerSecret as string],
        ]
      : []),
    ["X-TripIt-Access-Token", values.accessToken],
    ["X-TripIt-Access-Token-Secret", values.accessTokenSecret],
  ]
    .map(
      ([name, value]) => `
      <div class="value"><b>${name}</b><code>${escapeHtml(value)}</code></div>`,
    )
    .join("");

  const claudeCmd = `claude mcp add --transport http tripit ${values.endpoint} \\
  --header "Authorization: Bearer ${bearer}"`;

  const desktopJson = `{
  "mcpServers": {
    "tripit": {
      "command": "npx",
      "args": [
        "mcp-remote", "${values.endpoint}",
        "--header", "Authorization: Bearer ${bearer}"
      ]
    }
  }
}`;

  return layout(
    "TripIt connected",
    `
  <h1>TripIt connected ✅</h1>
  <p>Your credentials are below. <strong>They are shown only here and only to you</strong> —
  this server keeps nothing. TripIt access tokens do not expire; you can revoke this
  connection anytime in your TripIt account settings.</p>

  <div class="card">
    <h2 style="font-size:1.05rem; margin-top:0;">Claude Code</h2>
    <pre id="claude">${escapeHtml(claudeCmd)}</pre>
    <button class="btn" onclick="copyText('claude', this)">Copy command</button>
  </div>

  <div class="card">
    <h2 style="font-size:1.05rem; margin-top:0;">Claude Desktop (via mcp-remote)</h2>
    <p class="muted">Add to <code>claude_desktop_config.json</code>:</p>
    <pre id="desktop">${escapeHtml(desktopJson)}</pre>
    <button class="btn" onclick="copyText('desktop', this)">Copy JSON</button>
  </div>

  <div class="card">
    <h2 style="font-size:1.05rem; margin-top:0;">Raw values (any other MCP client)</h2>
    <p class="muted">Send these as HTTP headers on every request to
    <code>${escapeHtml(values.endpoint)}</code>:</p>
${headerRows}
  </div>

  <p class="muted">Treat these like a password. If they leak, revoke the connection in
  TripIt and <a href="${prefix}">connect again</a> for fresh ones.</p>

  <script>
    function copyText(id, btn) {
      navigator.clipboard.writeText(document.getElementById(id).textContent).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = btn.textContent.replace("Copied!", "Copy"); }, 1500);
      });
    }
  </script>`,
  );
}

function errorPage(message: string, prefix: string): string {
  return layout(
    "TripIt connection failed",
    `
  <h1>Connection failed</h1>
  <div class="card"><p>${escapeHtml(message)}</p></div>
  <p><a href="${prefix}">Start over</a></p>`,
  );
}
