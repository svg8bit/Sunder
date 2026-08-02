const productionUrl = process.argv[2] ?? process.env.SUNDER_PRODUCTION_URL;

if (!productionUrl) {
  throw new Error("Pass the deployed HTTPS URL: npm run smoke:production -- https://your-project.vercel.app");
}

const origin = new URL(productionUrl);
if (origin.protocol !== "https:") throw new Error("Production smoke requires an HTTPS origin.");

const routes = ["/launch", "/sniper", "/swap", "/docs"];
const results = [];
for (const route of routes) {
  const response = await globalThis.fetch(new URL(route, origin), { redirect: "follow", signal: globalThis.AbortSignal.timeout(15_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}.`);
  if (!body.includes('id="root"')) throw new Error(`${route} did not return the Sunder application shell.`);
  results.push({ route, status: response.status });
  if (route === "/launch") {
    if (response.headers.get("x-content-type-options") !== "nosniff") throw new Error("Missing X-Content-Type-Options on production.");
    if (!(response.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'")) throw new Error("Missing production frame-ancestors policy.");
    const hsts = response.headers.get("strict-transport-security") ?? "";
    const maxAge = /(?:^|;)\s*max-age=(\d+)(?:;|$)/i.exec(hsts)?.[1];
    if (maxAge === undefined || Number(maxAge) < 31_536_000) {
      throw new Error("Production HSTS max-age must be at least 31536000 seconds.");
    }
  }
}

process.stdout.write(`${JSON.stringify({ origin: origin.origin, routes: results, checkedAt: new Date().toISOString() }, null, 2)}\n`);
