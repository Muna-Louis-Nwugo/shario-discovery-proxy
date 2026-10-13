# shario-discovery-proxy

A tiny Cloudflare Worker that stands between `shario` and Upstash Redis for
session-name discovery. `shario` used to hold the real Upstash credential
directly and talk to Redis over its raw protocol — fine while the binary
never left trusted hands, but a real database credential has no business
being baked into a binary anyone can download. This Worker is the only
thing that holds that credential now; `shario` just talks plain HTTP to it.

It does exactly two things, matching exactly what `shario` needs:

- `POST /sessions/:name` (body = ticket bytes) — registers a new session.
  `201` if the name was free, `409` if it's already taken.
- `GET /sessions/:name` — looks up an existing session. `200` + ticket bytes,
  or `404` if it doesn't exist.

Nothing else is exposed. See `src/index.js` for the whole implementation —
it's short on purpose.

## Setup

```sh
npm install
```

You'll need your Upstash **REST** URL and token (not the `redis://`/`rediss://`
connection string `shario` used before) — find them on your database's page
in the Upstash console, under "REST API". Set them as Worker secrets, never
in a committed file:

```sh
npx wrangler login
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

## Deploy

```sh
npm run deploy
```

This prints the Worker's live URL (something like
`https://shario-discovery-proxy.<your-subdomain>.workers.dev`). Put that in
`shario`'s own `.env` as `DISCOVERY_PROXY_URL` — see `shario`'s README.

## Local dev

```sh
npm run dev
```

Runs the Worker locally via `wrangler dev` against the same secrets (reads
them from `.dev.vars` if present — see Wrangler's own docs for that file's
format — or falls back to the deployed secrets). Useful for testing against
a local `shario` build before deploying for real.
