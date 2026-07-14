# tripit-mcp

[![CI / Deploy](https://github.com/jsmarble/tripit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jsmarble/tripit-mcp/actions/workflows/ci.yml)

A remote [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for the [TripIt](https://www.tripit.com) travel management API, running on [Cloudflare Workers](https://developers.cloudflare.com/workers/). It lets AI assistants like Claude read and manage TripIt trips — list and inspect trips, add flights/hotels/cars/activities, check flight status, and view loyalty program balances.

> ## ⚠️ Parked: TripIt closed its public API to new integrations
>
> As of early 2026, **TripIt no longer issues API credentials**. Per TripIt's own [support article](https://help.tripit.com/en/support/solutions/articles/103000391296-tripit-public-api) (Feb 2026): *"The TripIt public API is no longer available for new integrations. Existing API connections will continue to function normally."* The developer registration page (`tripit.com/developer/create`) has been taken down, and TripIt support has [confirmed](https://github.com/tripit/api/issues/288) they are not issuing new consumer keys.
>
> **What this means:** this server is built on TripIt's OAuth 1.0 API, which requires a consumer key/secret that **can no longer be obtained**. It remains fully functional **only for holders of a legacy (pre-2026) consumer key** — if you have one, set it as described under [Advanced: bring your own TripIt app](#advanced-bring-your-own-tripit-app) and everything below works. For everyone else, there is currently no supported way to get credentials, so the project is **parked as a reference implementation**.
>
> The only known way to reach TripIt data for a *new* user today is to impersonate the mobile app's OAuth 2.0 client with a username/password login (see [`dvcrn/mcp-server-tripit`](https://github.com/dvcrn/mcp-server-tripit)) — a reverse-engineered, unofficial approach this project deliberately does **not** adopt.

This code is a clean, tested [`createMcpHandler()`](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) implementation (Streamable HTTP transport, no Durable Objects, no KV, no per-session state, bring-your-own-credentials). The rest of this README describes how it works for the legacy-key case.

> Real-time flight status and loyalty-program data require the TripIt account to have **TripIt Pro**; everything else works on free accounts.

Built on the stateless [`createMcpHandler()`](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) pattern from the Cloudflare Agents SDK — Streamable HTTP transport, no Durable Objects, no KV, no per-session state.

## Using the server

> The one-click `/connect` flow below requires the **deployment** to hold a legacy TripIt consumer key (the `TRIPIT_CONSUMER_KEY`/`TRIPIT_CONSUMER_SECRET` secrets). Since new keys can no longer be issued (see the notice above), on a deployment without one, `/connect` shows only the advanced bring-your-own-app form — which itself needs a legacy key.

1. **Get credentials**: visit [`https://mcp.joshuamarble.io/tripit/connect`](https://mcp.joshuamarble.io/tripit/connect), click **Connect your TripIt account**, and sign in on tripit.com. The success page shows your **access token** and **access token secret** — plus copy-paste-ready configs for Claude Code and Claude Desktop with the values already filled in.
2. **Connect your MCP client** to `https://mcp.joshuamarble.io/tripit` with those values as headers (your client must support custom headers on remote servers):

| Header | Format | Notes |
|--------|--------|-------|
| `X-TripIt-Access-Token` | `<access token>` | Both `X-TripIt-Access-Token*` headers together |
| `X-TripIt-Access-Token-Secret` | `<access token secret>` | |
| `Authorization` | `Bearer <access_token>:<access_token_secret>` | Single-header alternative |

Requests without credentials get a `401` with instructions. Credentials are used to sign the one TripIt request and are never logged or stored; revoke the connection anytime in your TripIt account settings and reconnect for fresh tokens.

### Claude Code

```bash
claude mcp add --transport http tripit https://mcp.joshuamarble.io/tripit \
  --header "Authorization: Bearer ACCESS_TOKEN:ACCESS_TOKEN_SECRET"
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
        "--header", "Authorization: Bearer ACCESS_TOKEN:ACCESS_TOKEN_SECRET"
      ]
    }
  }
}
```

### MCP Inspector (testing)

```bash
npx @modelcontextprotocol/inspector@latest
# Transport: Streamable HTTP → https://mcp.joshuamarble.io/tripit
# Add the two X-TripIt-Access-Token* headers (or the Authorization bearer header)
```

A quick liveness check needs no credentials: `curl https://mcp.joshuamarble.io/tripit/health`

### Advanced: bring your own TripIt app

The access-token pair above is bound to this deployment's registered TripIt application (the server signs requests with its consumer key). To be fully independent, register your own application at [tripit.com/developer](https://www.tripit.com/developer) and either use the **advanced form** on the [connect page](https://mcp.joshuamarble.io/tripit/connect) or mint tokens locally:

```bash
git clone https://github.com/jsmarble/tripit-mcp && cd tripit-mcp
node scripts/authorize.mjs YOUR_CONSUMER_KEY YOUR_CONSUMER_SECRET
```

Then send **all four** values: `X-TripIt-Consumer-Key`, `X-TripIt-Consumer-Secret`, `X-TripIt-Access-Token`, `X-TripIt-Access-Token-Secret` headers (or `Authorization: Bearer <ck>:<cs>:<at>:<ats>`). Four-value requests are signed entirely with your app — the deployment's app is not involved. Keep all four secret; together they grant full access to your TripIt account.

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
| `TRIPIT_CONSUMER_KEY` + `TRIPIT_CONSUMER_SECRET` | secrets (`wrangler secret put`) or `.dev.vars` | The deployment's registered TripIt application ([register one](https://www.tripit.com/developer)). Enables the one-click `/connect` flow and lets callers authenticate with just an access-token pair. Without them, callers must bring their own app (four values), and `/connect` only offers the advanced form. |
| `TRIPIT_ACCESS_TOKEN` + `TRIPIT_ACCESS_TOKEN_SECRET` | secrets or `.dev.vars` | Fallback access-token pair (used with the consumer secrets above) for private single-user deployments: keyless requests then act on that TripIt account. **Leave unset on a shared/public server.** Caller headers always take precedence. |
| `ACCESS_TEAM_DOMAIN` + `ACCESS_APP_AUD` | `wrangler.jsonc` → `vars` | When **both** are set, every MCP request must carry a valid Cloudflare Access JWT. While unset — the default — the server is public. |

### Optional: restrict who can connect (Cloudflare Access)

The server is open by default; the only thing a credential-less caller can consume is the Worker invocation itself. To restrict *who can reach the server at all*, the [Cloudflare Access (Zero Trust)](https://developers.cloudflare.com/cloudflare-one/) hook is built in: create a Self-hosted Access application for the hostname, add a Service Token policy for non-interactive MCP clients, and set `ACCESS_TEAM_DOMAIN`/`ACCESS_APP_AUD` in `wrangler.jsonc`. The Worker then verifies the `Cf-Access-Jwt-Assertion` JWT (issuer, audience, expiry, signature) on every MCP request, so Access can't be bypassed via a direct URL.

## Architecture

```
Browser ──▶ /tripit/connect ── OAuth 1.0 dance with tripit.com ──▶ shows the
            (state rides in an AES-GCM-sealed 10-min cookie)       user their tokens

MCP client ──HTTPS──▶ Worker (/tripit or /mcp)
(sends token pair      ├─ (optional) validates Cloudflare Access JWT
 or full four          ├─ reads the caller's X-TripIt-* headers (401 if missing)
 values)               ├─ createMcpHandler() → McpServer (fresh per request)
                       └─ TripIt API v1 (OAuth 1.0 HMAC-SHA1 signed per request;
                          token-pair requests are signed with the deployment's app)
```

- [src/index.ts](src/index.ts) — Worker entry: routes, per-request credential resolution
- [src/connect.ts](src/connect.ts) — hosted OAuth flow: connect page, TripIt redirect, callback that shows the minted tokens; stateless via a sealed short-lived cookie
- [src/server.ts](src/server.ts) — MCP server and 16 tool definitions (zod-validated inputs, honest annotations)
- [src/tripit-client.ts](src/tripit-client.ts) — TripIt API client with a Web Crypto OAuth 1.0 HMAC-SHA1 signer (form-body params included in the signature base string, as the spec requires), request timeouts, and distinct 401/404/429 errors
- [src/access.ts](src/access.ts) — optional Cloudflare Access JWT validation (jose, JWKS cached per isolate)
- [scripts/authorize.mjs](scripts/authorize.mjs) — CLI alternative to the hosted flow for own-app users (dependency-free Node)

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
- The `/connect` flow is stateless too: the in-flight request-token secret lives only in an encrypted, HttpOnly, 10-minute cookie in your browser, and the minted tokens appear once, in your browser, and nowhere else.
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
