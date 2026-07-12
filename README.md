# tripit-mcp

[![CI / Deploy](https://github.com/jsmarble/tripit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jsmarble/tripit-mcp/actions/workflows/ci.yml)

A public, remote [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for the [TripIt](https://www.tripit.com) travel management API, running on [Cloudflare Workers](https://developers.cloudflare.com/workers/). It lets AI assistants like Claude read and manage your TripIt trips — list and inspect trips, add flights/hotels/cars/activities, check flight status, and view loyalty program balances.

Anyone can connect. **You bring your own TripIt OAuth credentials**: the server stores no credentials, requires no login, and simply signs each TripIt request with the values you send. Unlike an API key, TripIt uses OAuth 1.0, so there are four values — but its access tokens never expire, so you mint them once (see [Getting credentials](#getting-your-tripit-credentials)).

> **You need a (free) TripIt developer API key** from [tripit.com/developer](https://www.tripit.com/developer). Real-time flight status and loyalty-program data additionally require the TripIt account to have **TripIt Pro**; everything else works on free accounts.

Built on the stateless [`createMcpHandler()`](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) pattern from the Cloudflare Agents SDK — Streamable HTTP transport, no Durable Objects, no KV, no per-session state.

## Using the server

You need two things:

1. **The server URL** — `https://mcp.joshuamarble.io/tripit` (or `https://tripit-mcp.tolvit-llc.workers.dev/mcp` as a fallback; see [Self-hosting](#self-hosting) to deploy your own)
2. **Your four TripIt OAuth values** — sent as HTTP headers on every request

Your MCP client must support custom headers on remote servers. Either form works:

| Header | Format | Notes |
|--------|--------|-------|
| `X-TripIt-Consumer-Key` | `<consumer key>` | All four `X-TripIt-*` headers together (preferred) |
| `X-TripIt-Consumer-Secret` | `<consumer secret>` | |
| `X-TripIt-Access-Token` | `<access token>` | |
| `X-TripIt-Access-Token-Secret` | `<access token secret>` | |
| `Authorization` | `Bearer <ck>:<cs>:<at>:<ats>` | Single-header alternative: the four values colon-joined |

Requests without credentials get a `401` with instructions. The values are used to sign the one TripIt request and are never logged or stored.

### Getting your TripIt credentials

1. Request an API key at [tripit.com/developer](https://www.tripit.com/developer) → you get a **consumer key** and **consumer secret**.
2. Mint your **access token** and **access token secret** once (they never expire unless revoked):

```bash
git clone https://github.com/jsmarble/tripit-mcp && cd tripit-mcp
node scripts/authorize.mjs YOUR_CONSUMER_KEY YOUR_CONSUMER_SECRET
# opens a TripIt authorization URL; approve it, and the script prints all four values
```

Keep all four values secret — together they grant full access to your TripIt account.

### Claude Code

```bash
claude mcp add --transport http tripit https://mcp.joshuamarble.io/tripit \
  --header "Authorization: Bearer CONSUMER_KEY:CONSUMER_SECRET:ACCESS_TOKEN:ACCESS_TOKEN_SECRET"
```

### Claude Desktop (and other clients without native remote MCP support)

Via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tripit": {
      "command": "npx",
      "args": [
        "mcp-remote", "https://mcp.joshuamarble.io/tripit",
        "--header", "Authorization: Bearer CONSUMER_KEY:CONSUMER_SECRET:ACCESS_TOKEN:ACCESS_TOKEN_SECRET"
      ]
    }
  }
}
```

### MCP Inspector (testing)

```bash
npx @modelcontextprotocol/inspector@latest
# Transport: Streamable HTTP → https://mcp.joshuamarble.io/tripit
# Add the four X-TripIt-* headers (or the Authorization bearer header)
```

A quick liveness check needs no credentials: `curl https://mcp.joshuamarble.io/tripit/health`

### Things to ask once connected

- *"What trips do I have coming up?"*
- *"Add my United flight SFO to Tokyo on August 3rd, flight UA837, confirmation ABC123"*
- *"Is my flight tomorrow delayed?"* (TripIt Pro)
- *"Create a trip called 'Paris Vacation' for the first week of October"*

## Tools

| Tool | TripIt endpoint | Description |
|------|-----------------|-------------|
| `tripit_list_trips` | `GET /list/trip` | List trips (upcoming by default), paginated |
| `tripit_get_trip` | `GET /get/trip/id/{id}` | One trip with all its reservations |
| `tripit_create_trip` | `POST /create` | Create a trip container |
| `tripit_update_trip` | `POST /replace/trip/id/{id}` | Replace a trip's details |
| `tripit_delete_trip` | `GET /delete/trip/id/{id}` | Permanently delete a trip |
| `tripit_list_objects` | `GET /list/object` | List reservations, filterable by type and trip |
| `tripit_get_object` | `GET /get/{type}/id/{id}` | One travel object in full detail |
| `tripit_create_flight` | `POST /create` | Add a flight (multi-segment supported) |
| `tripit_create_hotel` | `POST /create` | Add a hotel reservation |
| `tripit_create_car` | `POST /create` | Add a car rental |
| `tripit_create_activity` | `POST /create` | Add an activity/event |
| `tripit_update_object` | `POST /replace/{type}/id/{id}` | Replace any travel object |
| `tripit_delete_object` | `GET /delete/{type}/id/{id}` | Permanently delete a travel object |
| `tripit_get_flight_status` | `GET /get/air/id/{id}` | Flight with real-time status (**Pro**) |
| `tripit_list_points_programs` | `GET /list/points_program` | Loyalty balances (**Pro**) |
| `tripit_get_profile` | `GET /get/profile` | The authenticated user's profile |

Tools carry honest MCP annotations: reads are marked read-only; updates and deletes are marked destructive (TripIt's update is a full **replace** — the tools' descriptions tell the model to fetch-then-resend). All requests use TripIt's JSON format (`/format/json`) and responses are returned compact to save context tokens.

## Self-hosting

### Local development

```bash
npm install
npm run dev   # wrangler dev → http://localhost:8787/mcp
```

Point the MCP Inspector at `http://localhost:8787/mcp` with your credential headers. To skip sending headers while testing, copy `.dev.vars.example` to `.dev.vars` and set the four `TRIPIT_*` values as a local fallback.

### Deploy

```bash
npm run deploy
```

That's it — no secrets or bindings are required for a public deployment. The endpoint is `https://<worker>.<your-subdomain>.workers.dev/mcp`, or put the Worker behind a [custom domain or route](https://developers.cloudflare.com/workers/configuration/routing/).

This deployment joins a shared MCP hostname: the `seats-aero-mcp` Worker holds `mcp.joshuamarble.io` as a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), and this Worker claims the `mcp.joshuamarble.io/tripit*` [route pattern](https://developers.cloudflare.com/workers/configuration/routing/routes/), which takes precedence over the Custom Domain. Its endpoint path is the `BASE_PATH` var (`/tripit`), with the legacy `/mcp` path still answered on workers.dev.

### Configuration reference

All configuration is optional:

| Setting | Where | Effect |
|---------|-------|--------|
| `TRIPIT_CONSUMER_KEY`, `TRIPIT_CONSUMER_SECRET`, `TRIPIT_ACCESS_TOKEN`, `TRIPIT_ACCESS_TOKEN_SECRET` | secrets (`wrangler secret put`) or `.dev.vars` | Fallback credentials used when a request has no credential headers — for private single-user deployments; all four must be set together. **Leave unset on a shared/public server** (otherwise anonymous callers would act on your TripIt account). Caller headers always take precedence. |
| `ACCESS_TEAM_DOMAIN` + `ACCESS_APP_AUD` | `wrangler.jsonc` → `vars` | When **both** are set, every MCP request must carry a valid Cloudflare Access JWT. While unset — the default — the server is public. |

### Optional: restrict who can connect (Cloudflare Access)

The server is open by default; the only thing a credential-less caller can consume is the Worker invocation itself. To restrict *who can reach the server at all*, the [Cloudflare Access (Zero Trust)](https://developers.cloudflare.com/cloudflare-one/) hook is built in: create a Self-hosted Access application for the hostname, add a Service Token policy for non-interactive MCP clients, and set `ACCESS_TEAM_DOMAIN`/`ACCESS_APP_AUD` in `wrangler.jsonc`. The Worker then verifies the `Cf-Access-Jwt-Assertion` JWT (issuer, audience, expiry, signature) on every MCP request, so Access can't be bypassed via a direct URL.

## Architecture

```
MCP client ──HTTPS──▶ Worker (/tripit or /mcp)
(sends own OAuth       ├─ (optional) validates Cloudflare Access JWT
 credentials)          ├─ reads the caller's X-TripIt-* headers (401 if missing)
                       ├─ createMcpHandler() → McpServer (fresh per request)
                       └─ TripIt API v1 (OAuth 1.0 HMAC-SHA1 signed per request)
```

- [src/index.ts](src/index.ts) — Worker entry: routes, per-request credential resolution
- [src/server.ts](src/server.ts) — MCP server and 16 tool definitions (zod-validated inputs, honest annotations)
- [src/tripit-client.ts](src/tripit-client.ts) — TripIt API client with a Web Crypto OAuth 1.0 HMAC-SHA1 signer (form-body params included in the signature base string, as the spec requires), request timeouts, and distinct 401/404/429 errors
- [src/access.ts](src/access.ts) — optional Cloudflare Access JWT validation (jose, JWKS cached per isolate)
- [scripts/authorize.mjs](scripts/authorize.mjs) — one-time local helper to mint access tokens (dependency-free Node)

### Development commands

```bash
npm run dev      # local dev server (wrangler dev)
npm run lint     # lint + format check (Biome); lint:fix to apply
npm run check    # typecheck src and tests (tsc --noEmit)
npm test         # vitest suite running inside the workerd runtime
npm run types    # regenerate worker-configuration.d.ts after wrangler.jsonc changes
npm run deploy   # manual deploy to Cloudflare (CI normally does this)
```

### CI/CD

Every push and pull request runs the quality gates in [`.github/workflows/ci.yml`](.github/workflows/ci.yml): Biome lint + format check, strict typecheck of source and tests, the full test suite executed inside the real `workerd` runtime with all outbound TripIt traffic mocked (tests fail if anything tries to hit the network — including a test that recomputes the OAuth signature of captured requests), and a `wrangler deploy --dry-run` bundle check.

Pushes to `main` that pass all gates deploy automatically via [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action), followed by a smoke test against the live URL. Deploys never cancel mid-flight; queued deploys wait.

Repository secrets required for auto-deploy:

| Secret | Purpose | How to get it |
|--------|---------|---------------|
| `CLOUDFLARE_API_TOKEN` | Lets CI deploy the Worker | Cloudflare dashboard → My Profile → [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → **Edit Cloudflare Workers** template, scoped to your account. Then `gh secret set CLOUDFLARE_API_TOKEN` |
| `CLOUDFLARE_ACCOUNT_ID` | Target account | Cloudflare dashboard sidebar, or `wrangler whoami` |

While `CLOUDFLARE_API_TOKEN` is unset the deploy job is skipped (quality gates still run), so CI stays green on forks and fresh clones. Dependabot keeps npm dependencies and pinned GitHub Actions current with weekly grouped PRs.

## Privacy

- OAuth credentials are read from the request, used to sign the one TripIt API call over HTTPS, and never stored or logged by this server.
- No travel data is persisted; the server is stateless and holds nothing between requests.
- Workers observability is enabled for operational logs (request metadata); credential headers are not written to logs by the application.

## Disclaimer

This project is an independent, unofficial tool and is **not affiliated with, endorsed by, or in any way associated with TripIt or Concur Technologies**. All data is accessed through the TripIt API using each caller's own credentials.

Use of this software is subject to the [TripIt API Developer Agreement](https://www.tripit.com/developer) and TripIt's Terms of Service. You are solely responsible for ensuring your usage complies with their terms.

This software is provided "as is", without warranty of any kind. The author(s) are not liable for any damages, data loss, account suspension, or other consequences arising from the use of this software.

## Credits

Based on [caseyg/TripIt-MCP](https://github.com/caseyg/TripIt-MCP), rebuilt as a public bring-your-own-credentials stateless remote MCP server (the original stored per-user OAuth tokens in Workers KV behind a hosted OAuth flow).

## License

MIT
