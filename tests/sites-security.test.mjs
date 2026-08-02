import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

const assets = {
  fetch: async (request) => {
    const pathname = new URL(request.url).pathname;
    return new Response(pathname === "/index.html" ? "app" : "asset", { status: 200 });
  },
};

test("adds defensive headers to static assets", async () => {
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), { ASSETS: assets });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("adds privacy headers to SPA route fallbacks", async () => {
  const response = await worker.fetch(new Request("https://example.test/sniper", { headers: { accept: "text/html" } }), { ASSETS: assets });
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=()");
});
