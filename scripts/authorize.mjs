#!/usr/bin/env node
/**
 * One-time local helper to mint TripIt OAuth access tokens.
 *
 * TripIt uses OAuth 1.0 (HMAC-SHA1) and its access tokens do not expire, so
 * you run this once and keep the four resulting values for your MCP client
 * headers. Nothing here touches the deployed server.
 *
 * Usage:
 *   node scripts/authorize.mjs <consumer_key> <consumer_secret>
 * or with env vars:
 *   TRIPIT_CONSUMER_KEY=... TRIPIT_CONSUMER_SECRET=... node scripts/authorize.mjs
 *
 * Get a consumer key/secret from https://www.tripit.com/developer
 */

import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const REQUEST_TOKEN_URL = "https://api.tripit.com/oauth/request_token";
const AUTHORIZE_URL = "https://www.tripit.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://api.tripit.com/oauth/access_token";
const CALLBACK_PORT = 8976;

const consumerKey = process.argv[2] || process.env.TRIPIT_CONSUMER_KEY;
const consumerSecret = process.argv[3] || process.env.TRIPIT_CONSUMER_SECRET;

if (!consumerKey || !consumerSecret) {
  console.error(
    "Usage: node scripts/authorize.mjs <consumer_key> <consumer_secret>\n" +
      "Get a consumer key from https://www.tripit.com/developer",
  );
  process.exit(1);
}

function percentEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function signedRequestParams(url, { token = "", tokenSecret = "", extra = {} } = {}) {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(token ? { oauth_token: token } : {}),
    ...extra,
  };
  const paramString = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)])
    .sort(([ak, av], [bk, bv]) =>
      ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk),
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseString = ["POST", percentEncode(url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  params.oauth_signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
  return params;
}

async function tokenRequest(url, options) {
  const params = signedRequestParams(url, options);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} failed (HTTP ${response.status}): ${text}`);
  }
  const parsed = new URLSearchParams(text);
  const token = parsed.get("oauth_token");
  const tokenSecret = parsed.get("oauth_token_secret");
  if (!token || !tokenSecret) throw new Error(`Unexpected token response: ${text}`);
  return { token, tokenSecret };
}

console.log("Requesting a temporary token from TripIt...");
const requestToken = await tokenRequest(REQUEST_TOKEN_URL);

const callbackUrl = `http://localhost:${CALLBACK_PORT}/callback`;
const authorizeUrl =
  `${AUTHORIZE_URL}?oauth_token=${percentEncode(requestToken.token)}` +
  `&oauth_callback=${percentEncode(callbackUrl)}`;

console.log("\nOpen this URL in your browser and approve access:\n");
console.log(`  ${authorizeUrl}\n`);
console.log(`Waiting for TripIt to redirect to ${callbackUrl} ...`);

// TripIt is OAuth 1.0: the callback carries oauth_token (and no verifier),
// but accept oauth_verifier defensively if one is ever sent.
const verifier = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("TripIt authorization received. You can close this tab.");
    server.close();
    resolve(url.searchParams.get("oauth_verifier") || undefined);
  });
  server.on("error", reject);
  server.listen(CALLBACK_PORT);
});

console.log("Exchanging for a permanent access token...");
const accessToken = await tokenRequest(ACCESS_TOKEN_URL, {
  token: requestToken.token,
  tokenSecret: requestToken.tokenSecret,
  extra: verifier ? { oauth_verifier: verifier } : {},
});

console.log(`
Done. Your TripIt MCP credentials (access tokens do not expire):

  X-TripIt-Consumer-Key:         ${consumerKey}
  X-TripIt-Consumer-Secret:      ${consumerSecret}
  X-TripIt-Access-Token:         ${accessToken.token}
  X-TripIt-Access-Token-Secret:  ${accessToken.tokenSecret}

Single-header form:

  Authorization: Bearer ${consumerKey}:${consumerSecret}:${accessToken.token}:${accessToken.tokenSecret}

Keep these secret — together they grant full access to your TripIt account.
`);
