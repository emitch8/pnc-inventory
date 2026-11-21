// PNC Inventory - photo + inventory relay (Cloudflare Worker)
//
// What it does, and nothing more:
//   POST /upload      a photo from the iPad  -> Shopify Files -> public cdn.shopify.com URL
//   GET  /status?id=  finish a photo Shopify was still processing
//   GET  /items       the saved inventory (cloud copy, so the iPad can never lose it)
//   POST /items       save changed items
//   GET  /ping        check the passcode
//   POST /stock?model= the manufacturer's stock picture -> Shopify Files -> public URL
//   GET  /lookup?code= product facts for a scanned UPC or typed model number
//     Bundled Olight/Oknife list answers barcode and part number, including MSRP.
//     Never returns WRT cost or a selling price.
//   POST /catalog     load the product list (facts only: no costs, no selling prices; MSRP allowed)
//
// Every request must carry the passcode (X-Passcode header). The Shopify key lives
// only in this Worker's encrypted secrets, never in the web page.
// The Shopify app behind it should hold read_files + write_files ONLY. This code
// can only ADD files: the only Shopify operations it sends are the four below.
//
// Settings (Cloudflare dashboard -> this Worker -> Settings -> Variables and Secrets):
//   SHOP_DOMAIN     (text)    e.g. your-store.myshopify.com
//   CLIENT_ID       (secret)  from the Shopify Dev Dashboard app
//   CLIENT_SECRET   (secret)  from the Shopify Dev Dashboard app
//   PASSCODE        (secret)  the code typed once on the PNC iPad
//   ALLOWED_ORIGIN  (text)    e.g. https://emitch8.github.io
// Binding (Settings -> Bindings -> KV namespace): variable name INVENTORY

import { lookupOlightCatalog, catalogFieldsLookLikeMoney } from "./olight_catalog.js";

const API_VERSION = "2026-07";
const FILE_PREFIX = "pnc-";
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_ITEMS_BYTES = 20 * 1024 * 1024;

const STAGED_UPLOADS_CREATE = `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const FILE_CREATE = `mutation fileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id fileStatus }
    userErrors { field message }
  }
}`;

const NODE_STATUS = `query node($id: ID!) {
  node(id: $id) {
    ... on MediaImage { id fileStatus image { url } fileErrors { code message } }
  }
}`;

let cachedToken = null; // { value, expiresAt }

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (!passcodeOk(request, env)) return json({ error: "Wrong passcode" }, 401, cors);

      if (url.pathname === "/ping") return json({ ok: true }, 200, cors);
      if (url.pathname === "/upload" && request.method === "POST") return json(await upload(request, url, env), 200, cors);
      if (url.pathname === "/status" && request.method === "GET") return json(await status(url.searchParams.get("id"), env), 200, cors);
      if (url.pathname === "/items" && request.method === "GET") return json({ items: await readItems(env) }, 200, cors);
      if (url.pathname === "/items" && request.method === "POST") return json({ items: await saveItems(request, env) }, 200, cors);
      if (url.pathname === "/stock" && request.method === "POST") return json(await stock(url, env), 200, cors);
      if (url.pathname === "/lookup" && request.method === "GET") return json(await lookupProduct(url.searchParams.get("code"), env), 200, cors);
      if (url.pathname === "/catalog" && request.method === "POST") return json(await saveCatalog(request, env), 200, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err).slice(0, 300) }, err.status || 500, cors);
    }
  },
};

// ---------- guards ----------

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "").trim();
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowed ? (origin === allowed ? origin : allowed) : "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Passcode",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function passcodeOk(request, env) {
  const given = request.headers.get("X-Passcode") || "";
  const want = env.PASSCODE || "";
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------- product list (behind the passcode, never public) ----------

const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
let catalogCache = null; // { byUpc, byModel, brand }

async function loadCatalog(env) {
  if (catalogCache) return catalogCache;
  if (!env.INVENTORY) throw fail("INVENTORY storage is not connected to this Worker", 500);
  const raw = await env.INVENTORY.get("catalog");
  if (!raw) return null;
  const c = JSON.parse(raw);
  const byModel = {};
  for (const [upc, v] of Object.entries(c.items || {})) byModel[String(v[0]).toUpperCase()] = upc;
  catalogCache = { byUpc: c.items || {}, byModel, brand: c.brand || "" };
  return catalogCache;
}

async function lookupProduct(code, env) {
  const k = String(code || "").trim();
  if (!k || k.length > 40) return { found: false };
  const olight = lookupOlightCatalog(k);
  if (olight) return olight;
  const c = await loadCatalog(env);
  if (!c) return /[a-z]{3}/i.test(k) && (/olight/i.test(k) || /\s/.test(k)) ? olightFacts(k) : { found: false, reason: "No product list loaded" };
  const upc = /^\d+$/.test(k) ? k.replace(/^0+/, "") : c.byModel[k.toUpperCase()];
  const v = upc && c.byUpc[upc];
  // Not in the list and it is a typed name, not a barcode or model number: try Olight by name.
  if (!v && /[a-z]{3}/i.test(k) && (/olight/i.test(k) || /\s/.test(k))) return olightFacts(k);
  if (!v) return { found: false };
  const [model, description, length, width, height, weight, lithium] = v;
  return { found: true, brand: c.brand, upc, model, description, length, width, height, weight, lithium: !!lithium };
}

async function saveCatalog(request, env) {
  if (!env.INVENTORY) throw fail("INVENTORY storage is not connected to this Worker", 500);
  const text = await request.text();
  if (text.length > MAX_CATALOG_BYTES) throw fail("Product list too big", 413);
  let c;
  try { c = JSON.parse(text); } catch { throw fail("Bad product list"); }
  if (!c || typeof c.items !== "object") throw fail("Bad product list");
  // Facts only: refuse cost, selling price, or IMAP. MSRP (list price) is allowed.
  if (catalogFieldsLookLikeMoney(c.fields)) throw fail("Product list must not contain prices or costs");
  await env.INVENTORY.put("catalog", text);
  catalogCache = null;
  return { ok: true };
}

// ---------- inventory (cloud copy) ----------

async function readItems(env) {
  if (!env.INVENTORY) throw fail("INVENTORY storage is not connected to this Worker", 500);
  const raw = await env.INVENTORY.get("items");
  return raw ? JSON.parse(raw) : [];
}

async function saveItems(request, env) {
  const text = await request.text();
  if (text.length > MAX_ITEMS_BYTES) throw fail("Too much data in one save", 413);
  let incoming;
  try { incoming = JSON.parse(text).items; } catch { throw fail("Bad data"); }
  if (!Array.isArray(incoming)) throw fail("Bad data");

  const current = await readItems(env);
  const byId = new Map(current.map((it) => [it.id, it]));
  let changed = false;
  for (const it of incoming) {
    if (!it || typeof it.id !== "string") continue;
    const have = byId.get(it.id);
    if (!have || (it.updatedAt || 0) > (have.updatedAt || 0)) {
      byId.set(it.id, it);
      changed = true;
    }
  }
  const merged = [...byId.values()];
  if (changed) {
    await env.INVENTORY.put("items", JSON.stringify(merged));
    // One dated backup per day, kept 60 days, in case anything is ever overwritten.
    const day = new Date().toISOString().slice(0, 10);
    await env.INVENTORY.put(`backup-${day}`, JSON.stringify(merged), { expirationTtl: 60 * 86400 });
  }
  return merged;
}

// ---------- photos -> Shopify Files ----------

async function upload(request, url, env) {
  const mimeType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) throw fail("Photos only (JPEG, PNG or WebP)");
  const bytes = await request.arrayBuffer();
  return storeImage(bytes, mimeType, url, env, "");
}

// Stock picture: the manufacturer's own product picture, found by model number on
// milwaukeetool.com (the same way Forge does it), then stored in Shopify Files like any
// other photo. The Worker only ever fetches milwaukeetool.com, olight.com and
// cdn.olightstore.com for this.
const STOCK_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function stock(url, env) {
  const brand = String(url.searchParams.get("brand") || "").toLowerCase();
  const found = brand.includes("olight") ? await olightPicture(url) : await milwaukeePicture(url);
  const img = await fetch(found.src, { headers: { "User-Agent": STOCK_UA, Accept: "image/jpeg,image/png,image/webp,image/*;q=0.8" } });
  if (img.status !== 200) throw fail(`The picture answered ${img.status}`, 502);
  const mimeType = (img.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) throw fail("No usable stock picture", 404);
  const bytes = await img.arrayBuffer();
  return storeImage(bytes, mimeType, url, env, "stock-");
}

async function milwaukeePicture(url) {
  const model = String(url.searchParams.get("model") || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,24}$/.test(model)) throw fail("Enter the model number first");
  const page = await fetch(`https://www.milwaukeetool.com/Products/${encodeURIComponent(model)}`, {
    headers: { "User-Agent": STOCK_UA, Accept: "text/html" }, redirect: "follow",
  });
  if (page.status === 404) throw fail(`No stock picture found for ${model}`, 404);
  if (page.status !== 200) throw fail(`Milwaukee's site answered ${page.status}`, 502);
  const src = ogImage(await page.text(), "https://www.milwaukeetool.com");
  let u;
  try { u = new URL(src); } catch { throw fail(`No stock picture found for ${model}`, 404); }
  if (u.protocol !== "https:" || !(u.hostname === "milwaukeetool.com" || u.hostname.endsWith(".milwaukeetool.com"))) {
    throw fail(`No stock picture found for ${model}`, 404);
  }
  u.searchParams.set("w", "1200");
  u.searchParams.set("h", "1200");
  return { src: u.toString() };
}

function ogImage(html, base) {
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!m) return "";
  let src = m[1].replace(/&amp;/g, "&").trim();
  if (src.startsWith("//")) src = "https:" + src;
  if (src.startsWith("/")) src = base + src;
  return src;
}

// ---- Olight: the same way Forge finds it. The product title is matched against
// olight.com's product sitemap, then the picture comes from that product page. ----

const OLIGHT_SITEMAP = "https://www.olight.com/sitemap_listing.xml";
const OLIGHT_CDN = "https://cdn.olightstore.com/";
const OLIGHT_STOP = new Set(["olight", "the", "and", "with", "for", "edc", "light", "flashlight", "clip", "on", "a"]);
const SLUG_FILLER = new Set(["flashlight", "flashlights", "light", "lights", "led", "edc", "tactical", "rechargeable",
  "series", "flat", "unibody", "multifunctional", "floodlight", "spotlight", "red", "clip", "on", "keychain", "headlamp",
  "camping", "usb", "c", "with", "and", "the", "for", "a", "lumens", "lumen", "high", "power", "powerful", "compact", "switch", "tail"]);
let olightSitemap = null; // { urls, at }

const words = (t) => String(t).toLowerCase().match(/[a-z0-9]+/g) || [];

function olightMatch(title, urls) {
  const name = words(title).filter((t) => !OLIGHT_STOP.has(t));
  if (!name.length) return null;
  const family = name[0];
  let best = null;
  for (const url of urls) {
    const slug = url.split("/").pop().toLowerCase();
    let st = words(slug).filter((t) => !SLUG_FILLER.has(t));
    if (!st.length) st = words(slug);
    const distinct = [...new Set(st)];
    if (!distinct.length) continue;
    const hits = distinct.filter((t) => name.includes(t)).length;
    if (!hits) continue;
    // On a tie, a page that is itself a light beats an accessory page ("arkfeld-pro-clip").
    const c = { url, slug, hits, precision: hits / distinct.length, recall: hits / name.length, family: distinct.includes(family),
      isLight: /light|lantern|headlamp/.test(slug) ? 1 : 0 };
    const key = (x) => [x.hits, x.precision, x.recall, x.isLight, -x.slug.length];
    const better = !best || (() => { const a = key(c), b = key(best); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; })();
    if (better) best = c;
  }
  if (!best) return null;
  return (best.family && best.precision >= 0.5) || best.recall >= 0.5 ? best : null; // a confident wrong match is worse than none
}

function findProduct(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return null;
  if (!Array.isArray(node) && (Array.isArray(node.skuInfo) || Array.isArray(node.imageInfo))) return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = findProduct(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Finds the olight.com product page for a title and the colour / edition it names.
async function olightProduct(title) {
  if (!olightSitemap || Date.now() - olightSitemap.at > 24 * 3600 * 1000) {
    const r = await fetch(OLIGHT_SITEMAP, { headers: { "User-Agent": STOCK_UA } });
    if (r.status !== 200) throw fail(`Olight's site answered ${r.status}`, 502);
    const urls = [...(await r.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]).filter((u) => u.includes("/store/"));
    if (!urls.length) throw fail("Olight's product list was empty", 502);
    olightSitemap = { urls, at: Date.now() };
  }
  const match = olightMatch(title, olightSitemap.urls);
  if (!match) return null;
  const pu = new URL(match.url);
  if (pu.protocol !== "https:" || !(pu.hostname === "olight.com" || pu.hostname.endsWith(".olight.com"))) return null;
  const page = await fetch(pu.toString(), { headers: { "User-Agent": STOCK_UA, Accept: "text/html" } });
  if (page.status !== 200) throw fail(`Olight's site answered ${page.status}`, 502);
  const html = await page.text();
  let product = null, chosen = null, variant = "";
  const nd = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nd) {
    try {
      product = findProduct(JSON.parse(nd[1]));
      if (product) {
        const base = words(product.name || "");
        const extra = words(title).filter((t) => !OLIGHT_STOP.has(t) && !base.includes(t));
        let bestHits = 0;
        for (const sku of product.skuInfo || []) {
          if (!sku || typeof sku !== "object") continue;
          const values = (sku.specsValueRef || []).map((x) => (x && x.itemValue) || "");
          const label = `${sku.name || ""} ${values.join(" ")}`.toLowerCase();
          const hits = extra.filter((w) => label.includes(w)).length;
          if (hits > bestHits) {
            bestHits = hits; chosen = sku;
            variant = values.filter((v) => extra.some((w) => String(v).toLowerCase().includes(w))).join(" / ");
          }
        }
      }
    } catch { product = null; }
  }
  return { html, product, chosen, variant, url: pu.toString() };
}

async function olightPicture(url) {
  const title = String(url.searchParams.get("title") || "").trim().slice(0, 200);
  if (!title) throw fail("Enter the title first");
  const found = await olightProduct(title);
  if (!found) throw fail("No Olight stock picture found for this title", 404);
  const { html, product, chosen } = found;
  let path = (chosen && chosen.imgUrl) || "";
  if (!path && product) for (const e of product.imageInfo || []) if (e && e.imgUrl) { path = e.imgUrl; break; }
  let src = path ? (String(path).startsWith("https://") ? String(path) : OLIGHT_CDN + String(path).replace(/^\/+/, "")) : ogImage(html, "https://www.olight.com");
  let u;
  try { u = new URL(src); } catch { throw fail("No Olight stock picture found for this title", 404); }
  const ok = u.protocol === "https:" && (u.hostname === "cdn.olightstore.com" || u.hostname.endsWith(".olightstore.com") || u.hostname === "olight.com" || u.hostname.endsWith(".olight.com"));
  if (!ok) throw fail("No Olight stock picture found for this title", 404);
  return { src: u.toString() };
}

// A typed Olight name ("Olight Oclip Pro Zombie Green") -> the product's name, colour,
// Olight's own model code and Olight's published list price.
async function olightFacts(text) {
  let found;
  try { found = await olightProduct(text); } catch { return { found: false }; }
  if (!found || !found.product || !found.product.name) return { found: false };
  const { product, chosen, variant } = found;
  const money = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : ""; };
  const pi = chosen && chosen.priceInfo && typeof chosen.priceInfo === "object" ? chosen.priceInfo : null;
  const msrp = (pi && (money(pi.markPrice) || money(pi.price))) || money(product.minPrice);
  return {
    found: true, brand: "Olight", upc: "",
    model: chosen && chosen.sku && !String(chosen.sku).includes(",") ? String(chosen.sku).trim() : "",
    description: String(product.name).trim() + (variant ? " - " + variant : ""),
    msrp, length: "", width: "", height: "", weight: "", lithium: true, titleIsName: true,
  };
}

async function storeImage(bytes, mimeType, url, env, tag) {
  if (!bytes.byteLength) throw fail("Empty photo");
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw fail("Photo is too large", 413);

  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mimeType];
  const sku = slug(url.searchParams.get("sku") || "item", 30) || "item";
  const title = tag + slug(url.searchParams.get("title") || "", 40);
  const stamp = Date.now().toString(36);
  const filename = `${FILE_PREFIX}${sku}${title ? "-" + title : ""}-${stamp}.${ext}`;

  // 1. Ask Shopify where to put the file.
  const staged = await graphql(env, STAGED_UPLOADS_CREATE, {
    input: [{ resource: "IMAGE", filename, mimeType, httpMethod: "POST", fileSize: String(bytes.byteLength) }],
  });
  const s = staged.stagedUploadsCreate;
  if (s.userErrors && s.userErrors.length) throw fail("Shopify: " + s.userErrors.map((e) => e.message).join("; "), 502);
  const target = s.stagedTargets[0];

  // 2. Send the photo there: every signed parameter in order, the file last.
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const put = await fetch(target.url, { method: "POST", body: form });
  if (put.status < 200 || put.status >= 300) throw fail(`Photo storage answered ${put.status}`, 502);

  // 3. Register it in Shopify Files.
  const created = await graphql(env, FILE_CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", filename, alt: `${FILE_PREFIX}${sku}` }],
  });
  const c = created.fileCreate;
  if (c.userErrors && c.userErrors.length) throw fail("Shopify: " + c.userErrors.map((e) => e.message).join("; "), 502);
  const id = c.files[0].id;

  // 4. Wait (briefly) for the public URL.
  for (let i = 0; i < 12; i++) {
    const st = await status(id, env);
    if (st.url || st.error) return st;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { id, pending: true };
}

async function status(id, env) {
  if (!id || !/^gid:\/\/shopify\/MediaImage\/\d+$/.test(id)) throw fail("Bad photo id");
  const data = await graphql(env, NODE_STATUS, { id });
  const node = data.node;
  if (!node) return { id, pending: true };
  if (node.fileStatus === "READY" && node.image && node.image.url) return { id, url: node.image.url };
  if (node.fileStatus === "FAILED") {
    return { id, error: "Shopify could not process this photo: " + (node.fileErrors || []).map((e) => e.message).join("; ") };
  }
  return { id, pending: true };
}

function slug(text, limit) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit).replace(/-+$/g, "");
}

// ---------- Shopify API ----------

async function token(env, force = false) {
  const now = Date.now();
  if (!force && cachedToken && now < cachedToken.expiresAt - 5 * 60 * 1000) return cachedToken.value;
  if (!env.SHOP_DOMAIN || !env.CLIENT_ID || !env.CLIENT_SECRET) throw fail("Shopify settings are missing on the Worker", 500);
  const res = await fetch(`https://${shopDomain(env)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET }),
  });
  if (res.status !== 200) throw fail(`Shopify sign-in answered ${res.status}`, 502);
  const body = await res.json();
  if (!body.access_token) throw fail("Shopify sign-in gave no token", 502);
  cachedToken = { value: body.access_token, expiresAt: now + (Number(body.expires_in) || 86400) * 1000 };
  return cachedToken.value;
}

function shopDomain(env) {
  return String(env.SHOP_DOMAIN).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function graphql(env, query, variables, retried = false) {
  const res = await fetch(`https://${shopDomain(env)}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await token(env) },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && !retried) {
    await token(env, true);
    return graphql(env, query, variables, true);
  }
  if (res.status !== 200) throw fail(`Shopify answered ${res.status}`, 502);
  const body = await res.json();
  if (body.errors && body.errors.length) throw fail("Shopify: " + body.errors.map((e) => e.message).join("; "), 502);
  return body.data;
}
