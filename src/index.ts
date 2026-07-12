import { createMcpHandler } from "agents/mcp";
import { enforceAccess } from "./access";
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

const CREDENTIAL_HELP =
  "Send all four TripIt OAuth values as headers: X-TripIt-Consumer-Key, " +
  "X-TripIt-Consumer-Secret, X-TripIt-Access-Token, X-TripIt-Access-Token-Secret " +
  "(or a single `Authorization: Bearer <consumer_key>:<consumer_secret>:<access_token>:<access_token_secret>`). " +
  "Get a consumer key/secret at https://www.tripit.com/developer and mint access " +
  "tokens once with scripts/authorize.mjs from the repo — they do not expire.";

type Route = "mcp" | "health" | "index" | null;

function resolveRoute(pathname: string, env: Env): Route {
  const base = env.BASE_PATH?.replace(/\/+$/, "");
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
 * Resolves the caller's TripIt OAuth 1.0 credentials for this request.
 * Callers supply their own four values per-request — nothing is stored
 * server-side. The TRIPIT_* secrets, if all set, are a fallback for private
 * single-user deployments.
 */
function resolveCredentials(request: Request, env: Env): CredentialResult {
  const header = (name: string) => request.headers.get(name)?.trim() || undefined;

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
  if (present > 0) {
    const missing = (Object.keys(fromHeaders) as (keyof typeof fromHeaders)[]).filter(
      (key) => !fromHeaders[key],
    );
    return {
      ok: false,
      message: `Incomplete TripIt credentials: missing header(s) ${missing
        .map((key) => CREDENTIAL_HEADERS[key])
        .join(", ")}. ${CREDENTIAL_HELP}`,
    };
  }

  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const parts = auth
      .slice("bearer ".length)
      .trim()
      .split(":")
      .map((part) => part.trim());
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
      message: `The Authorization bearer token must contain exactly four colon-separated values. ${CREDENTIAL_HELP}`,
    };
  }

  if (
    env.TRIPIT_CONSUMER_KEY &&
    env.TRIPIT_CONSUMER_SECRET &&
    env.TRIPIT_ACCESS_TOKEN &&
    env.TRIPIT_ACCESS_TOKEN_SECRET
  ) {
    return {
      ok: true,
      credentials: {
        consumerKey: env.TRIPIT_CONSUMER_KEY.trim(),
        consumerSecret: env.TRIPIT_CONSUMER_SECRET.trim(),
        accessToken: env.TRIPIT_ACCESS_TOKEN.trim(),
        accessTokenSecret: env.TRIPIT_ACCESS_TOKEN_SECRET.trim(),
      },
    };
  }

  return { ok: false, message: `No TripIt credentials provided. ${CREDENTIAL_HELP}` };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = resolveRoute(url.pathname, env);

    if (route === "mcp") {
      const denied = await enforceAccess(request, env);
      if (denied) return denied;

      const resolved = resolveCredentials(request, env);
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
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
