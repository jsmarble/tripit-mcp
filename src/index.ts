import { createMcpHandler } from "agents/mcp";
import { enforceAccess } from "./access";
import { handleConnect } from "./connect";
import { buildServer } from "./server";
import type { TripItCredentials } from "./tripit-client";

// The MCP endpoint is served at both paths so the workers.dev URL (/mcp) and
// the shared MCP hostname (mcp.joshuamarble.io/tripit, via BASE_PATH) keep
// working. BASE_PATH is set in wrangler.jsonc.
const LEGACY_MCP_ROUTE = "/mcp";

const CREDENTIAL_HEADERS = {
  consumerKey: "X-TripIt-Consumer-Key",
  consumerSecret: "X-TripIt-Consumer-Secret",
  accessToken: "X-TripIt-Access-Token",
  accessTokenSecret: "X-TripIt-Access-Token-Secret",
} as const;

function credentialHelp(connectUrl: string): string {
  return (
    `Easiest: open ${connectUrl} in a browser, sign in to TripIt, and copy the ` +
    "credentials it shows you — then send them as the X-TripIt-Access-Token and " +
    "X-TripIt-Access-Token-Secret headers (or a single `Authorization: Bearer " +
    "<access_token>:<access_token_secret>`). Advanced: bring your own TripIt API app " +
    "by sending all four X-TripIt-* headers (or a four-part bearer " +
    "`<consumer_key>:<consumer_secret>:<access_token>:<access_token_secret>`). " +
    "TripIt access tokens do not expire."
  );
}

type Route = "mcp" | "health" | "index" | { connectPrefix: string } | null;

function resolveRoute(pathname: string, env: Env): Route {
  const base = env.BASE_PATH?.replace(/\/+$/, "");
  for (const prefix of [base && `${base}/connect`, "/connect"]) {
    if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      return { connectPrefix: prefix };
    }
  }
  if (pathname === LEGACY_MCP_ROUTE || (base && pathname === base)) return "mcp";
  if (pathname === "/health" || (base && pathname === `${base}/health`)) {
    return "health";
  }
  if (pathname === "/") return "index";
  return null;
}

type CredentialResult =
  | { ok: true; credentials: TripItCredentials }
  | { ok: false; message: string };

/**
 * Resolves the caller's TripIt OAuth 1.0 credentials for this request —
 * nothing is stored server-side.
 *
 * Two modes:
 * - Access-token pair only (from the hosted /connect flow): the request is
 *   signed with this deployment's registered app (TRIPIT_CONSUMER_KEY/SECRET
 *   secrets).
 * - Full four values: the caller brings their own TripIt app.
 *
 * TRIPIT_ACCESS_TOKEN/SECRET secrets additionally enable a keyless fallback
 * for private single-user deployments.
 */
function resolveCredentials(
  request: Request,
  env: Env,
  connectUrl: string,
): CredentialResult {
  const help = credentialHelp(connectUrl);
  const header = (name: string) => request.headers.get(name)?.trim() || undefined;
  const appKey = env.TRIPIT_CONSUMER_KEY?.trim();
  const appSecret = env.TRIPIT_CONSUMER_SECRET?.trim();

  const withServerApp = (
    accessToken: string,
    accessTokenSecret: string,
  ): CredentialResult => {
    if (!appKey || !appSecret) {
      return {
        ok: false,
        message:
          "This deployment has no registered TripIt app, so access-token-only " +
          `credentials cannot be used. Send all four X-TripIt-* headers instead. ${help}`,
      };
    }
    return {
      ok: true,
      credentials: {
        consumerKey: appKey,
        consumerSecret: appSecret,
        accessToken,
        accessTokenSecret,
      },
    };
  };

  const fromHeaders = {
    consumerKey: header(CREDENTIAL_HEADERS.consumerKey),
    consumerSecret: header(CREDENTIAL_HEADERS.consumerSecret),
    accessToken: header(CREDENTIAL_HEADERS.accessToken),
    accessTokenSecret: header(CREDENTIAL_HEADERS.accessTokenSecret),
  };
  const present = Object.values(fromHeaders).filter(Boolean).length;
  if (present === 4) {
    return { ok: true, credentials: fromHeaders as TripItCredentials };
  }
  if (fromHeaders.accessToken && fromHeaders.accessTokenSecret && present === 2) {
    return withServerApp(fromHeaders.accessToken, fromHeaders.accessTokenSecret);
  }
  if (present > 0) {
    const missing = (Object.keys(fromHeaders) as (keyof typeof fromHeaders)[]).filter(
      (key) => !fromHeaders[key],
    );
    return {
      ok: false,
      message: `Incomplete TripIt credentials: missing header(s) ${missing
        .map((key) => CREDENTIAL_HEADERS[key])
        .join(", ")}. ${help}`,
    };
  }

  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const parts = auth
      .slice("bearer ".length)
      .trim()
      .split(":")
      .map((part) => part.trim());
    if (parts.length === 2 && parts.every(Boolean)) {
      return withServerApp(parts[0], parts[1]);
    }
    if (parts.length === 4 && parts.every(Boolean)) {
      return {
        ok: true,
        credentials: {
          consumerKey: parts[0],
          consumerSecret: parts[1],
          accessToken: parts[2],
          accessTokenSecret: parts[3],
        },
      };
    }
    return {
      ok: false,
      message: `The Authorization bearer token must contain two colon-separated values (access token pair) or four (with your own app's consumer key and secret). ${help}`,
    };
  }

  if (appKey && appSecret && env.TRIPIT_ACCESS_TOKEN && env.TRIPIT_ACCESS_TOKEN_SECRET) {
    return {
      ok: true,
      credentials: {
        consumerKey: appKey,
        consumerSecret: appSecret,
        accessToken: env.TRIPIT_ACCESS_TOKEN.trim(),
        accessTokenSecret: env.TRIPIT_ACCESS_TOKEN_SECRET.trim(),
      },
    };
  }

  return { ok: false, message: `No TripIt credentials provided. ${help}` };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = resolveRoute(url.pathname, env);
    const base = env.BASE_PATH?.replace(/\/+$/, "") ?? "";
    const connectUrl = `${url.origin}${base}/connect`;

    if (typeof route === "object" && route !== null) {
      return handleConnect(request, env, route.connectPrefix);
    }

    if (route === "mcp") {
      const denied = await enforceAccess(request, env);
      if (denied) return denied;

      const resolved = resolveCredentials(request, env, connectUrl);
      if (!resolved.ok) {
        return Response.json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: resolved.message },
            id: null,
          },
          { status: 401 },
        );
      }

      // A fresh McpServer per request: the handler is stateless and the MCP
      // SDK forbids reconnecting an already-connected server instance.
      const server = buildServer(resolved.credentials);
      return createMcpHandler(server, { route: url.pathname })(request, env, ctx);
    }

    if (route === "health" || route === "index") {
      return Response.json({
        name: "tripit-mcp",
        status: "ok",
        endpoint: env.BASE_PATH || LEGACY_MCP_ROUTE,
        transport: "streamable-http",
        connect: connectUrl,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
