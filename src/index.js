// Thin proxy between `shario` and Upstash Redis for session-name discovery.
//
// `shario` used to hold the real Redis credential directly and talk to it
// over the raw protocol -- fine while the binary never left trusted hands,
// but a real database credential has no business being baked into something
// anyone can download. This Worker is the only thing that holds the real
// Upstash credential (as Worker secrets, never committed anywhere); `shario`
// just talks plain HTTP to it instead.
//
// Exactly three things, matching exactly what `shario` needs -- nothing else:
//   POST /sessions/:name  body = ticket bytes -> 201, or 409 if taken
//   PUT  /sessions/:name  body = ticket bytes -> 204 (unconditional update --
//        only used to refresh a session shario itself just created, once its
//        own endpoint id is known, never to claim a name)
//   GET  /sessions/:name                      -> 200 + ticket bytes, or 404
//
// Uses Upstash's REST API (not the raw Redis protocol), since Workers can't
// open raw TCP connections -- this is exactly what that REST API is for.

const SESSION_PATH = /^\/sessions\/([^/]+)$/;
const TTL_SECONDS = 86400; // matches shario's own existing session TTL

async function upstash(env, command) {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  return res.json();
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      // surface the real failure instead of Cloudflare's generic opaque
      // error page -- this is the outermost boundary, nothing above it to
      // hand a thrown error to
      return new Response(`Unhandled proxy error: ${err.stack || err}`, {
        status: 500,
      });
    }
  },
};

async function handle(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(SESSION_PATH);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const name = decodeURIComponent(match[1]);
    if (!name) {
      return new Response("Session name required", { status: 400 });
    }

    if (request.method === "POST") {
      const ticket = await request.text();
      if (!ticket) {
        return new Response("Missing ticket body", { status: 400 });
      }

      // atomic: only sets if `name` isn't already taken, with the same
      // expiry shario's own code already used -- no separate exists-then-set
      // race window like the old direct-Redis version had.
      const { result, error } = await upstash(env, [
        "SET",
        name,
        ticket,
        "NX",
        "EX",
        String(TTL_SECONDS),
      ]);

      if (error) {
        return new Response(error, { status: 502 });
      }
      if (result !== "OK") {
        return new Response("Session name already exists", { status: 409 });
      }
      return new Response(null, { status: 201 });
    }

    if (request.method === "PUT") {
      const ticket = await request.text();
      if (!ticket) {
        return new Response("Missing ticket body", { status: 400 });
      }

      // unconditional -- the caller already owns this name, just updating
      // its stored ticket, so no NX here
      const { error } = await upstash(env, [
        "SET",
        name,
        ticket,
        "EX",
        String(TTL_SECONDS),
      ]);

      if (error) {
        return new Response(error, { status: 502 });
      }
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET") {
      const { result, error } = await upstash(env, ["GET", name]);

      if (error) {
        return new Response(error, { status: 502 });
      }
      if (result === null) {
        return new Response("Session not found", { status: 404 });
      }
      return new Response(result, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405 });
}
