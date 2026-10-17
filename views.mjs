// Private view counter for mystrymart.com, stored in Netlify Blobs (no outside services).
// POST  /.netlify/functions/views   {page, src, unique}  -> records one page view
// GET   /.netlify/functions/views?days=30  (header x-stats-key) -> totals for the dashboard at /site-stats
// Each view is saved as its own tiny entry whose name holds the details, so nothing is ever overwritten.
// No IP addresses or personal details are stored: only page, traffic source, city/country and device type.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

// SHA-256 of the dashboard password (the password itself is not in this file)
const KEY_HASH = "a6e326998491256216869429e58b4dd525046908f667d71db8096bc291c5ccaa";
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|monitor/i;
const clean = (v, n = 60) => String(v || "").replace(/[~\/\n\r]/g, " ").trim().slice(0, n) || "-";
const day = (d) => d.toISOString().slice(0, 10);

export default async (req, context) => {
  const store = getStore("site-views");

  if (req.method === "POST") {
    const ua = req.headers.get("user-agent") || "";
    if (BOT.test(ua)) return new Response(null, { status: 204 });
    let b = {};
    try { b = await req.json(); } catch {}
    const g = context.geo || {};
    const device = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|iPhone|Android/i.test(ua) ? "Phone" : "Computer";
    const parts = [
      clean(b.page, 80),
      clean(b.src, 40),
      clean(g.city, 40),
      clean(g.country && g.country.name, 40),
      device,
      b.unique ? "1" : "0",
    ].map(encodeURIComponent);
    const key = `v/${day(new Date())}/${parts.join("~")}~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    await store.set(key, "1");
    return new Response(null, { status: 204 });
  }

  if (req.method === "GET") {
    const pass = req.headers.get("x-stats-key") || "";
    if (createHash("sha256").update(pass).digest("hex") !== KEY_HASH) return new Response("Wrong password", { status: 401 });
    const days = Math.min(365, Math.max(1, parseInt(new URL(req.url).searchParams.get("days") || "30", 10)));
    const rows = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = day(new Date(Date.now() - i * 86400000));
      const { blobs } = await store.list({ prefix: `v/${d}/` });
      for (const { key } of blobs) {
        const [page, src, city, country, device, unique] = key.slice(13).split("~").map(decodeURIComponent);
        rows.push({ d, page, src, city, country, device, u: unique === "1" });
      }
    }
    return Response.json({ days, rows }, { headers: { "Cache-Control": "no-store" } });
  }

  return new Response("Method not allowed", { status: 405 });
};
