const dns = require("dns").promises;
const net = require("net");

const ALLOWED_ORIGINS = new Set([
  "https://carloposadino-crypto.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10000;

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
    (p[0] >= 224);
}
function isPrivateIPv6(ip) {
  const x = ip.toLowerCase().split("%")[0];
  if (x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") ||
      /^fe[89ab]/.test(x) || x.startsWith("ff")) return true;
  const mapped = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}
function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return !isPrivateIPv4(ip);
  if (v === 6) return !isPrivateIPv6(ip);
  return false;
}
async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("URL non valida."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Sono ammessi solo link HTTP o HTTPS.");
  if (url.username || url.password) throw new Error("I link con credenziali incorporate non sono ammessi.");
  if (!url.hostname || url.hostname.length > 253) throw new Error("Nome host non valido.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".example")) {
    throw new Error("Sono ammessi solo siti pubblici.");
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error("Gli indirizzi IP privati o riservati non sono ammessi.");
  } else {
    let addresses;
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error("Il dominio non è raggiungibile o non esiste."); }
    if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) {
      throw new Error("Il dominio non risolve esclusivamente verso indirizzi pubblici.");
    }
  }
  url.hash = "";
  return url;
}
function decodeEntities(s) {
  return String(s).replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(0x10ffff, parseInt(n, 16))));
}
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<(script|style|noscript|svg|canvas|iframe|nav|footer|header|form|button)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s).replace(/[\t\r\f\v ]+/g, " ").replace(/\n[ \t]+/g, "\n");
  return s.split("\n").map(x => x.trim()).filter(Boolean).join("\n").slice(0, 30000);
}
function titleFromHtml(html, fallback) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim().slice(0, 180) : fallback;
}
async function fetchPublicPage(initialUrl) {
  let url = await validatePublicUrl(initialUrl);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetch(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": "FoodPairingSourceReader/1.0 (+https://github.com/carloposadino-crypto/FoodPairing)",
        "Accept": "text/html, text/plain;q=0.9"
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 3) throw new Error("La pagina ha troppi reindirizzamenti.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Reindirizzamento senza destinazione.");
      url = await validatePublicUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error("Il sito ha risposto HTTP " + response.status + ".");
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!(type.includes("text/html") || type.includes("text/plain") || type.includes("application/xhtml+xml"))) {
      throw new Error("Il link non punta a una pagina HTML o testo. Per PDF e foto usa i relativi campi di caricamento.");
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) throw new Error("La pagina è troppo grande (limite 2 MB).");
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    let raw = "";
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("La pagina supera il limite di 2 MB."); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } else {
      raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw new Error("La pagina supera il limite di 2 MB.");
    }
    const title = type.includes("text/plain") ? url.hostname : titleFromHtml(raw, url.hostname);
    const text = type.includes("text/plain") ? raw.slice(0, 30000) : htmlToText(raw);
    if (text.trim().length < 40) throw new Error("Non è stato possibile estrarre testo utile. La pagina potrebbe richiedere JavaScript o un accesso autenticato.");
    return { title, text, url: url.href, contentType: type };
  }
  throw new Error("Impossibile recuperare la pagina.");
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://carloposadino-crypto.github.io";
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Metodo non consentito." });
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: "Origine non autorizzata." });
  const raw = String(req.query?.url || "");
  if (!raw || raw.length > 2048) return res.status(400).json({ error: "Inserisci un URL valido (massimo 2048 caratteri)." });
  try {
    const page = await fetchPublicPage(raw);
    return res.status(200).json({ title: page.title, text: page.text, url: page.url, contentType: page.contentType });
  } catch (error) {
    const message = error && error.name === "TimeoutError" ? "Il sito non ha risposto entro 10 secondi." : (error.message || "Errore durante il recupero della pagina.");
    return res.status(422).json({ error: message });
  }
};
