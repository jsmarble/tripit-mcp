import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Defense-in-depth validation of the Cloudflare Access JWT.
 *
 * Cloudflare Access injects a `Cf-Access-Jwt-Assertion` header on every
 * request that passes its policy checks. Validating it inside the Worker
 * ensures requests cannot bypass Access (e.g. via a direct workers.dev URL
 * or a misconfigured route), per Cloudflare's guidance:
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

// Module-scoped JWKS cache so keys are fetched once per isolate, not per request.
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksIssuer: string | undefined;

function getJwks(issuer: string) {
  if (!cachedJwks || cachedJwksIssuer !== issuer) {
    cachedJwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    cachedJwksIssuer = issuer;
  }
  return cachedJwks;
}

function unauthorized(message: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    },
    { status: 401 },
  );
}

/**
 * Returns a 401 Response if the request fails Cloudflare Access validation,
 * or null if the request is allowed to proceed.
 *
 * Enforcement requires both ACCESS_TEAM_DOMAIN and ACCESS_APP_AUD to be set;
 * when unset (local development), validation is skipped.
 */
export async function enforceAccess(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_APP_AUD) {
    return null;
  }

  // Accept "myteam" or "myteam.cloudflareaccess.com".
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\.cloudflareaccess\.com$/, "");
  const issuer = `https://${teamDomain}.cloudflareaccess.com`;

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    getCookie(request, "CF_Authorization");

  if (!token) {
    return unauthorized(
      "Missing Cloudflare Access token. This server must be reached through Cloudflare Access.",
    );
  }

  try {
    await jwtVerify(token, getJwks(issuer), {
      issuer,
      audience: env.ACCESS_APP_AUD,
    });
    return null;
  } catch {
    return unauthorized("Invalid Cloudflare Access token.");
  }
}

function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
