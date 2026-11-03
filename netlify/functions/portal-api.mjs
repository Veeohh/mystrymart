// Mystry Mart artist portal + team HQ backend.
// One function, called as /.netlify/functions/portal-api?a=<action>
// Data lives in Netlify Blobs (store "portal"). Emails go out through Resend.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   RESEND_API_KEY   API key from resend.com (required to send any email, including login links)
//   ADMIN_EMAILS     comma-separated team emails allowed into /hq, e.g. "info@mystrymart.com,you@gmail.com"
//   MAIL_FROM        optional, default "Mystry Mart <orders@mystrymart.com>" (domain must be verified in Resend)
//   TEAM_EMAIL       optional, where "tracking received" alerts go, default info@mystrymart.com
//   DEV_SHOW_LINKS   optional, set to 1 ONLY while testing without Resend: login links are shown on screen
//   INBOUND_DOMAIN   optional, domain that receives email through Resend (e.g. "in.mystrymart.com"). When set, each
//                    order gets its own reply address (t-<code>@INBOUND_DOMAIN) and replies/label emails add tracking.
//   RESEND_WEBHOOK_SECRET  signing secret ("whsec_...") of the Resend webhook that posts email.received to ?a=inbound
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const QTY = 50;
const LOGIN_MIN = 15;
const SESSION_DAYS = 30;
const COOKIE = "mm_portal";

const env = (k) => {
  try { const v = globalThis.Netlify?.env?.get?.(k); if (v != null) return v; } catch {}
  return process.env[k] || "";
};
const store = () => getStore({ name: "portal", consistency: "strong" });
const views = () => getStore({ name: "site-views", consistency: "strong" });
const h = (s) => createHash("sha256").update(String(s)).digest("hex");
const tok = () => randomBytes(32).toString("base64url");
const now = () => Date.now();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cleanEmail = (e) => String(e || "").trim().toLowerCase().slice(0, 200);
const site = () => (env("SITE_URL") || env("URL") || "https://mystrymart.com").replace(/\/+$/, "");
const admins = () => env("ADMIN_EMAILS").split(",").map(cleanEmail).filter(Boolean);
const safeId = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

async function getJ(key) { return (await store().get(key, { type: "json" })) || null; }
async function setJ(key, v) { await store().setJSON(key, v); }
async function del(key) { await store().delete(key); }
async function listJ(prefix) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const out = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" }).then((v) => (v ? { ...v, _key: b.key } : null))));
  return out.filter(Boolean);
}
const artists = () => listJ("artist/");
const orders = () => listJ("order/");

/* ---------------- email ---------------- */
async function sendMail(to, subject, lines, button, opts = {}) {
  const key = env("RESEND_API_KEY");
  if (!key || !to) return false;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#141418">
    <div style="font-weight:800;font-size:20px;color:#BE3F6B;margin-bottom:16px">MYSTRY MART</div>
    ${lines.map((l) => `<p style="font-size:16px;line-height:1.5;margin:0 0 14px">${esc(l)}</p>`).join("")}
    ${button ? `<p style="margin:22px 0"><a href="${esc(button.href)}" style="background:#D9F53B;color:#141418;border:3px solid #141418;border-radius:10px;padding:12px 20px;font-weight:800;text-decoration:none;display:inline-block">${esc(button.label)}</a></p>` : ""}
    ${opts.extraHtml || ""}
    <p style="font-size:12px;color:#77727E;margin-top:28px">Mystry Mart · mystrymart.com · ${esc(opts.footer || "Questions? Reply to this email.")}</p></div>`;
  const text = lines.join("\n\n") + (button ? `\n\n${button.label}: ${button.href}` : "") + (opts.extraText ? "\n\n" + opts.extraText : "");
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env("MAIL_FROM") || "Mystry Mart <orders@mystrymart.com>", to: [to], subject, html, text, reply_to: opts.replyTo || env("TEAM_EMAIL") || "info@mystrymart.com" }),
    });
    return r.ok;
  } catch { return false; }
}

async function addAlert(a, kind, order) {
  const subj = kind === "order" ? `New Mystry Mart order: ${QTY} pieces` : kind === "received" ? "Your pieces arrived" : "Tracking number received";
  const via = order?.via ? ` (${order.via})` : "";
  const body =
    kind === "order"
      ? `We placed an order for ${QTY} pieces${order.lines?.length ? ` (${order.lines.map((l) => l.qty).join(" + ")})` : ", your choice of pieces"}. Please ship within 14 days and send us your tracking number.`
      : kind === "received"
      ? `We received your ${QTY} pieces. Thank you! They will go into the machine soon.`
      : `${a.name} sent tracking for their ${QTY}-piece order: ${order.carrier} ${order.tracking}${via}.`;
  let emailed = false;
  if (kind === "tracking") {
    emailed = await sendMail(env("TEAM_EMAIL") || "info@mystrymart.com", `Tracking from ${a.name}`, [body], { label: "Open HQ", href: site() + "/hq/" });
  } else {
    if (kind === "order" && order.tk) {
      const addr = inboxFor(order);
      const how = addr
        ? [`Three easy ways to send your tracking number, no login needed:`,
           `1. Reply to this email with the tracking number.`,
           `2. When you buy your label on Pirate Ship (or any label site), put ${addr} as the recipient's email. Your tracking gets to us automatically.`,
           `3. Tap the button below and paste it in.`]
        : [`When it ships, tap the button below and paste in your tracking number. No login needed.`];
      emailed = await sendMail(a.email, subj, [`Hi ${String(a.name).split(" ")[0]},`, body, ...how],
        { label: "Add tracking number", href: `${site()}/portal/?track=${order.tk}` },
        { replyTo: addr || undefined, footer: addr ? "Replies to this email go to this order. Questions? Write to info@mystrymart.com." : undefined,
          extraHtml: `<p style="font-size:14px;color:#77727E;margin:0">You can also see all your orders in your <a href="${esc(site() + "/portal/")}" style="color:#BE3F6B">artist portal</a>.</p>`,
          extraText: `Your artist portal: ${site()}/portal/` });
    } else {
      emailed = await sendMail(a.email, subj, [`Hi ${String(a.name).split(" ")[0]},`, body], { label: "Open your artist portal", href: site() + "/portal/" });
    }
  }
  const id = `${now().toString(36)}${randomBytes(3).toString("hex")}`;
  const al = { id, artist: a.id, artistName: a.name, email: kind === "tracking" ? "team" : a.email, kind, subj, body, t: now(), emailed, forTeam: kind === "tracking", order: order?.id || null };
  await setJ(`alert/${id}`, al);
  return al;
}

/* ---------------- tracking by email / one-tap link ---------------- */
const inboxFor = (o) => (env("INBOUND_DOMAIN") && o.tk ? `t-${o.tk}@${env("INBOUND_DOMAIN").replace(/^@/, "")}` : "");
async function orderByTk(tk) {
  tk = String(tk || "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(tk)) return null;
  const idx = await getJ(`tk/${tk}`);
  return idx ? await getJ(`order/${idx.order}`) : null;
}
const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Other"];
function guessCarrier(n, ctx = "") {
  if (/^1Z/i.test(n)) return "UPS";
  if (/^[A-Z]{2}\d{9}US$/i.test(n) || /^9\d{19,21}$/.test(n) || /^\d{26}$/.test(n)) return "USPS";
  if (/fedex/i.test(ctx) && /^\d{12,15}$/.test(n)) return "FedEx";
  if (/dhl/i.test(ctx) && /^\d{10,11}$/.test(n)) return "DHL";
  if (/^\d{12}$|^\d{15}$/.test(n)) return "FedEx";
  if (/usps|postal/i.test(ctx)) return "USPS";
  return "Other";
}
function htmlToText(h) {
  return String(h || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>/gi, " $1 ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&[a-z]+;/g, " ");
}
// Only the new part of a reply: drop quoted lines and everything after "On ... wrote:" / forwarded-original markers.
function newPart(txt) {
  const lines = String(txt || "").split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*On .{4,200}wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^\s*From:\s.*mystrymart/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n");
}
function findTracking(text, subject = "") {
  const ctx = subject + "\n" + text;
  const cands = [];
  const add = (raw, w) => { const n = raw.replace(/[\s-]/g, "").toUpperCase(); if (!cands.some((c) => c.n === n)) cands.push({ n, w }); };
  for (const m of ctx.matchAll(/(?:tLabels|tracknumbers|trackingnumber|tracknum|tracking_?number|trknbr|track(?:ing)?\/?)=?([A-Z0-9]{10,34})/gi)) add(m[1], 9);
  for (const m of ctx.matchAll(/\b1Z[0-9A-Z]{16}\b/gi)) add(m[0], 8);
  for (const m of ctx.matchAll(/\b[A-Z]{2}\d{9}US\b/g)) add(m[0], 7);
  for (const m of ctx.matchAll(/\b9\d{3}(?:[ -]?\d{4}){4}(?:[ -]?\d{2,4})?\b/g)) add(m[0], 7);
  for (const m of ctx.matchAll(/\b9\d{19,25}\b/g)) add(m[0], 6);
  for (const m of ctx.matchAll(/\b\d{12}\b|\b\d{15}\b/g)) add(m[0], /fedex/i.test(ctx) ? 5 : 2);
  for (const m of ctx.matchAll(/\b\d{10}\b/g)) if (/dhl/i.test(ctx)) add(m[0], 4);
  const ok = cands.filter((c) => c.n.length >= 10 && c.n.length <= 34 && !/^0+$/.test(c.n) && (/\d{8}/.test(c.n) || /^1Z/.test(c.n)));
  ok.sort((a, b) => b.w - a.w);
  const best = ok[0];
  return best ? { tracking: best.n, carrier: guessCarrier(best.n, ctx) } : null;
}
async function applyTracking(o, carrier, tracking, via) {
  const art = (await getJ(`artist/${o.artist}`)) || { id: o.artist, name: o.artistName, email: "" };
  let tn = String(tracking).trim().slice(0, 80);
  const f = findTracking(tn);
  if (f) { tn = f.tracking; if (f.carrier !== "Other") carrier = f.carrier; }
  else { const sq = tn.replace(/[\s-]/g, ""); if (/^[A-Z0-9]+$/i.test(sq)) tn = sq.toUpperCase(); }
  Object.assign(o, { status: "transit", carrier: CARRIERS.includes(carrier) ? carrier : "Other", tracking: tn, shipped: now(), via });
  await setJ(`order/${o.id}`, o);
  await addAlert(art, "tracking", o);
  return o;
}
function svixOk(req, raw) {
  const secret = env("RESEND_WEBHOOK_SECRET");
  if (!secret) return false;
  const id = req.headers.get("svix-id"), ts = req.headers.get("svix-timestamp"), sigs = req.headers.get("svix-signature") || "";
  if (!id || !ts || Math.abs(now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const want = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  return sigs.split(" ").some((s) => {
    const [v, b64] = s.split(","); if (v !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
async function forwardToTeam(subject, lines) {
  return sendMail(env("TEAM_EMAIL") || "info@mystrymart.com", subject, lines, { label: "Open HQ", href: site() + "/hq/" });
}
async function handleInbound(req) {
  const raw = await req.text();
  if (!svixOk(req, raw)) return fail("Bad signature", 401);
  let ev; try { ev = JSON.parse(raw); } catch { return fail("Bad body"); }
  if (ev.type !== "email.received" || !ev.data?.email_id) return json({ ok: true, skipped: true });
  const d = ev.data;
  const seen = `inb/${safeId(d.email_id)}`;
  if (await getJ(seen)) return json({ ok: true, dup: true });
  await setJ(seen, { t: now() });
  let full = {};
  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(d.email_id)}`, { headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}` } });
    if (r.ok) full = await r.json();
  } catch {}
  const bare = (s) => { s = String(s || ""); const m = s.match(/<([^>]+)>/); return cleanEmail(m ? m[1] : s); };
  const from = bare(d.from) || bare(full.from);
  const subject = String(full.subject || d.subject || "");
  const body = full.text || htmlToText(full.html);
  const addrs = [...(d.to || []), ...(d.received_for || []), ...(full.to || []), ...(d.cc || [])].map(String);
  let o = null;
  for (const ad of addrs) { const m = ad.match(/t-([0-9a-f]{12})@/i); if (m) { o = await orderByTk(m[1]); if (o) break; } }
  if (!o && from) {
    const art = (await artists()).find((x) => cleanEmail(x.email) === from);
    if (art) o = (await orders()).filter((x) => x.artist === art.id && x.status === "ordered").sort((a, b) => b.placed - a.placed)[0] || null;
  }
  const snippet = newPart(body).replace(/\s+/g, " ").trim().slice(0, 600);
  if (!o) {
    const known = addrs.some((ad) => /t-[0-9a-f]{12}@/i.test(ad)) || (from && (await artists()).some((x) => cleanEmail(x.email) === from));
    if (!known) return json({ ok: true, ignored: true });
    await forwardToTeam(`Email we couldn't match to an order: ${subject}`.slice(0, 120), [`From: ${from}`, `Subject: ${subject}`, snippet || "(no text)"]);
    return json({ ok: true, matched: false });
  }
  const found = findTracking(newPart(body), subject);
  if (o.status !== "ordered") {
    if (!found || found.tracking !== o.tracking) await forwardToTeam(`Email about ${o.artistName}'s order`, [`From: ${from}`, `Subject: ${subject}`, `This order already has tracking (${o.carrier} ${o.tracking}).`, snippet || "(no text)"]);
    return json({ ok: true, matched: true, already: true });
  }
  if (!found) {
    await forwardToTeam(`${o.artistName} emailed about their order (no tracking number found)`, [`From: ${from}`, `Subject: ${subject}`, snippet || "(no text)", "Add the tracking from HQ if needed, or reply to them."]);
    return json({ ok: true, matched: true, tracking: false });
  }
  const isLabelSite = !!(from && !(await artists()).some((x) => cleanEmail(x.email) === from));
  await applyTracking(o, found.carrier, found.tracking, isLabelSite ? `by email from ${from.split("@")[1] || "label site"}` : "by email reply");
  return json({ ok: true, matched: true, tracking: found.tracking });
}

/* ---------------- sessions ---------------- */
function readCookie(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : "";
}
async function session(req) {
  const sid = readCookie(req);
  if (!sid) return null;
  const s = await getJ(`sess/${h(sid)}`);
  if (!s || s.exp < now()) return null;
  if (s.role === "team" && !admins().includes(s.email)) return null;
  if (s.role === "artist") {
    const a = await getJ(`artist/${s.artistId}`);
    if (!a || a.active === false || cleanEmail(a.email) !== s.email) return null;
    s.artist = a;
  }
  return s;
}
const cookie = (v, maxAge) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function rateOk(email) {
  const key = `rl/${h(email)}`;
  const r = (await getJ(key)) || { t: [] };
  const recent = r.t.filter((x) => x > now() - 3600e3);
  if (recent.length >= 5) return false;
  recent.push(now());
  await setJ(key, { t: recent });
  return true;
}

/* ---------------- clicks from the site view counter ---------------- */
async function clickCounts() {
  const cached = await getJ("cache/clicks");
  if (cached && cached.t > now() - 10 * 60e3) return cached.c;
  const c = {};
  try {
    const s = views();
    for (let i = 0; i < 30; i++) {
      const d = new Date(now() - i * 864e5).toISOString().slice(0, 10);
      const { blobs } = await s.list({ prefix: `v/${d}/` });
      for (const { key } of blobs) {
        const page = decodeURIComponent(key.slice(13).split("~")[0] || "");
        if (page.startsWith("artist: ")) { const sl = page.slice(8).trim().toLowerCase(); if (sl) c[sl] = (c[sl] || 0) + 1; }
      }
    }
  } catch {}
  await setJ("cache/clicks", { t: now(), c });
  return c;
}

/* ---------------- payloads ---------------- */
const publicArtist = (a) => ({ id: a.id, name: a.name, studio: a.studio || "", handle: a.handle || "", price: a.price, deal: a.deal, photo: a.photo || "", works: a.works || [] });

async function hqPayload() {
  const [as, os, als, clicks, pays] = await Promise.all([artists(), orders(), listJ("alert/"), clickCounts(), listJ("payout/")]);
  for (const a of as) { a.clicks = clicks[a.id] || 0; (a.aliases || []).forEach((s) => (a.clicks += clicks[s] || 0)); delete a._key; }
  os.forEach((o) => delete o._key);
  return { artists: as, orders: os, alerts: als.sort((x, y) => y.t - x.t).slice(0, 300).map(({ _key, ...r }) => r), payouts: pays.map(({ _key, ...r }) => r), qty: QTY };
}
async function portalPayload(s) {
  const a = s.artist;
  const os = (await orders()).filter((o) => o.artist === a.id).map(({ _key, ...r }) => r);
  const als = (await listJ("alert/")).filter((x) => x.artist === a.id && !x.forTeam).sort((x, y) => y.t - x.t).slice(0, 50).map(({ _key, email, ...r }) => r);
  return { artist: { ...publicArtist(a), email: a.email }, orders: os, alerts: als, qty: QTY };
}

/* ---------------- handler ---------------- */
export default async (req) => {
  const url = new URL(req.url);
  const a = url.searchParams.get("a") || "";
  let b = {};
  if (a === "inbound" && req.method === "POST") return handleInbound(req);
  if (req.method === "POST") {
    if (req.headers.get("x-mm") !== "1") return fail("Bad request", 400); // blocks cross-site form posts
    try { b = await req.json(); } catch { b = {}; }
  }

  // ---- login ----
  if (a === "login" && req.method === "POST") {
    const email = cleanEmail(b.email);
    const role = b.as === "team" ? "team" : "artist";
    const ok = { ok: true, message: "If that email is on our list, a login link is on its way. It works for 15 minutes." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email address.");
    if (!(await rateOk(email))) return fail("Too many login emails. Try again in an hour.", 429);
    let artistId = null;
    if (role === "team") { if (!admins().includes(email)) return json(ok); }
    else {
      const match = (await artists()).find((x) => x.active !== false && cleanEmail(x.email) === email);
      if (!match) return json(ok);
      artistId = match.id;
    }
    const t = tok();
    await setJ(`login/${h(t)}`, { email, role, artistId, exp: now() + LOGIN_MIN * 60e3 });
    const link = `${site()}/${role === "team" ? "hq" : "portal"}/?login=${t}`;
    const sent = await sendMail(email, "Your Mystry Mart login link", [
      role === "team" ? "Here's your link to Mystry Mart HQ." : "Here's your link to the Mystry Mart artist portal.",
      `It works once and expires in ${LOGIN_MIN} minutes. If you didn't ask for it, you can ignore this email.`,
    ], { label: "Log in", href: link });
    if (!sent && env("DEV_SHOW_LINKS") === "1") return json({ ...ok, devLink: link });
    return json(ok);
  }
  if (a === "track-get") {
    const o = await orderByTk(url.searchParams.get("t"));
    if (!o) return fail("This link isn't active anymore. Check your latest order email or log in to your portal.", 404);
    return json({ artist: String(o.artistName || "").split(" ")[0], qty: o.qty || QTY, placed: o.placed, status: o.status, carrier: o.carrier || "", tracking: o.tracking || "", shipBy: o.placed + 14 * 864e5 });
  }
  if (a === "track-set" && req.method === "POST") {
    const o = await orderByTk(b.t);
    if (!o) return fail("This link isn't active anymore. Check your latest order email or log in to your portal.", 404);
    if (o.status !== "ordered") return fail("This order already has a tracking number.");
    const tracking = String(b.tracking || "").trim().slice(0, 80);
    if (tracking.replace(/[\s-]/g, "").length < 6) return fail("Enter the full tracking number.");
    await applyTracking(o, b.carrier, tracking, "by one-tap link");
    return json({ ok: true, status: "transit", carrier: o.carrier, tracking: o.tracking });
  }
  if (a === "verify" && req.method === "POST") {
    const key = `login/${h(b.token || "")}`;
    const l = await getJ(key);
    if (!l || l.exp < now()) return fail("This login link has expired or was already used. Request a new one.", 401);
    await del(key);
    const sid = tok();
    await setJ(`sess/${h(sid)}`, { email: l.email, role: l.role, artistId: l.artistId, exp: now() + SESSION_DAYS * 864e5 });
    return json({ ok: true, role: l.role }, 200, { "Set-Cookie": cookie(sid, SESSION_DAYS * 86400) });
  }
  if (a === "logout" && req.method === "POST") {
    const sid = readCookie(req);
    if (sid) await del(`sess/${h(sid)}`);
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  }

  const s = await session(req);
  if (a === "me") return s ? json({ email: s.email, role: s.role, artistId: s.artistId || null }) : fail("Not logged in", 401);
  if (!s) return fail("Not logged in", 401);

  // ---- artist ----
  if (a === "portal" && s.role === "artist") return json(await portalPayload(s));
  if (a === "tracking" && s.role === "artist" && req.method === "POST") {
    const o = await getJ(`order/${safeId(b.orderId)}`);
    if (!o || o.artist !== s.artist.id) return fail("Order not found.", 404);
    if (o.status !== "ordered") return fail("This order already has a tracking number.");
    const tracking = String(b.tracking || "").trim().slice(0, 80);
    const carrier = ["USPS", "UPS", "FedEx", "DHL", "Other"].includes(b.carrier) ? b.carrier : "Other";
    if (tracking.length < 6) return fail("Enter the full tracking number.");
    await applyTracking(o, carrier, tracking, "in the portal");
    return json(await portalPayload(s));
  }

  // ---- team ----
  if (s.role !== "team") return fail("Not allowed", 403);
  if (a === "hq") return json(await hqPayload());
  if (req.method !== "POST") return fail("Not allowed", 405);

  if (a === "artist-save") {
    const f = b.artist || {};
    const name = String(f.name || "").trim().slice(0, 80);
    const email = cleanEmail(f.email);
    const price = Math.round(parseFloat(f.price) * 100) / 100;
    if (!name || !email || !(price >= 0)) return fail("Fill in the name, email and price.");
    const id = safeId(f.id) || safeId(f.slug) || `${safeId(name) || "artist"}-${now().toString(36)}`;
    const old = (await getJ(`artist/${id}`)) || { active: true, added: now() };
    const works = (Array.isArray(f.works) ? f.works : []).filter((w) => typeof w === "string" && w.startsWith("data:image/")).slice(0, 4);
    const photo = typeof f.photo === "string" && (f.photo === "" || f.photo.startsWith("data:image/")) ? f.photo : old.photo || "";
    let handle = String(f.handle || "").trim().slice(0, 60);
    if (handle && !handle.startsWith("@")) handle = "@" + handle;
    const rec = { ...old, id, name, studio: String(f.studio || "").trim().slice(0, 80), email, handle, price, deal: f.deal === "Wholesale" ? "Wholesale" : "Consignment", photo, works, updated: now() };
    await setJ(`artist/${id}`, rec);
    return json(await hqPayload());
  }
  if (a === "artist-price") {
    const r = await getJ(`artist/${safeId(b.id)}`); if (!r) return fail("Artist not found.", 404);
    const price = Math.round(parseFloat(b.price) * 100) / 100; if (!(price >= 0)) return fail("Enter a price like 7.50.");
    r.price = price; r.updated = now(); await setJ(`artist/${r.id}`, r); return json(await hqPayload());
  }
  if (a === "artist-deal") {
    const r = await getJ(`artist/${safeId(b.id)}`); if (!r) return fail("Artist not found.", 404);
    r.deal = b.deal === "Wholesale" ? "Wholesale" : "Consignment"; await setJ(`artist/${r.id}`, r); return json(await hqPayload());
  }
  if (a === "artist-active") {
    const r = await getJ(`artist/${safeId(b.id)}`); if (!r) return fail("Artist not found.", 404);
    r.active = !!b.active; await setJ(`artist/${r.id}`, r); return json(await hqPayload());
  }
  if (a === "order") {
    const art = await getJ(`artist/${safeId(b.artistId)}`);
    if (!art || art.active === false) return fail("Artist not found.", 404);
    const open = (await orders()).find((o) => o.artist === art.id && o.status !== "received");
    if (open) return fail(`${art.name} already has an open order.`);
    const picks = (Array.isArray(b.works) ? b.works : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < (art.works || []).length);
    const n = picks.length, base = n ? Math.floor(QTY / n) : 0, rem = n ? QTY - base * n : 0;
    const id = `o-${now().toString(36)}${randomBytes(3).toString("hex")}`;
    const tk = randomBytes(6).toString("hex");
    const o = { id, artist: art.id, artistName: art.name, qty: QTY, price: art.price, deal: art.deal, lines: picks.map((w, i) => ({ work: w, qty: base + (i < rem ? 1 : 0) })), status: "ordered", placed: now(), by: s.email, tk };
    await setJ(`order/${id}`, o);
    await setJ(`tk/${tk}`, { order: id });
    await addAlert(art, "order", o);
    return json(await hqPayload());
  }
  if (a === "received") {
    const o = await getJ(`order/${safeId(b.orderId)}`); if (!o) return fail("Order not found.", 404);
    if (o.status === "received") return json(await hqPayload());
    Object.assign(o, { status: "received", received: now(), receivedBy: s.email });
    await setJ(`order/${o.id}`, o);
    const art = (await getJ(`artist/${o.artist}`)) || { id: o.artist, name: o.artistName, email: "" };
    await addAlert(art, "received", o);
    return json(await hqPayload());
  }
  if (a === "cancel") {
    const o = await getJ(`order/${safeId(b.orderId)}`); if (!o) return fail("Order not found.", 404);
    await del(`order/${o.id}`);
    if (o.tk) await del(`tk/${o.tk}`);
    const t0 = (o.placed || 0) - 5000, t1 = (o.received || o.shipped || o.placed || 0) + 5000;
    for (const al of await listJ("alert/")) {
      if (al.order === o.id || (!al.order && al.artist === o.artist && al.t >= t0 && al.t <= t1)) await del(al._key);
    }
    let emailed = false;
    if (b.notify) {
      const art = await getJ(`artist/${o.artist}`);
      const d = new Date(o.placed).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
      if (art?.email) emailed = await sendMail(art.email, "Please disregard our order email", [
        `Hi ${String(art.name).split(" ")[0]},`,
        `Our order email from ${d} was sent by mistake while we were testing our new artist portal. There's no order right now, so please don't ship anything.`,
        "Sorry for the mix-up, and thank you for being part of Mystry Mart!",
      ]);
    }
    return json({ emailed, ...(await hqPayload()) });
  }
  if (a === "order-paid") {
    const o = await getJ(`order/${safeId(b.orderId)}`); if (!o) return fail("Order not found.", 404);
    o.paid = !!b.paid; o.paidAt = b.paid ? now() : null; await setJ(`order/${o.id}`, o); return json(await hqPayload());
  }
  if (a === "payout") {
    const month = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month : null;
    const id = safeId(b.artistId);
    if (!month || !id) return fail("Pick a month and artist.");
    const key = `payout/${month}/${id}`;
    const p = (await getJ(key)) || { month, artist: id };
    if (b.sold != null) p.sold = Math.max(0, Math.min(10000, parseInt(b.sold, 10) || 0));
    if (b.paid != null) { p.paid = !!b.paid; p.paidAt = b.paid ? now() : null; }
    await setJ(key, p);
    return json(await hqPayload());
  }
  if (a === "import") {
    const list = Array.isArray(b.artists) ? b.artists : [];
    const existing = new Set((await artists()).map((x) => x.id));
    let added = 0;
    for (const f of list.slice(0, 500)) {
      const id = safeId(f.id); if (!id || existing.has(id) || !f.name || !f.email) continue;
      await setJ(`artist/${id}`, { id, name: String(f.name).slice(0, 80), studio: String(f.studio || "").slice(0, 80), email: cleanEmail(f.email), handle: String(f.handle || "").slice(0, 60),
        price: Number(f.price) || 0, deal: f.deal === "Wholesale" ? "Wholesale" : "Consignment", photo: typeof f.photo === "string" ? f.photo : "",
        works: Array.isArray(f.works) ? f.works.filter((w) => typeof w === "string").slice(0, 4) : [], active: f.active !== false, added: now() });
      added++;
    }
    return json({ added, ...(await hqPayload()) });
  }
  return fail("Unknown action", 404);
};
