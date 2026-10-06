const DATABASE_URL = "https://raw.githubusercontent.com/carloposadino-crypto/FoodPairing/main/database.json";

let cache = { data: null, expires: 0 };

function cors(origin) {
  const allowed = [
    "https://carloposadino-crypto.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ];
  const value = allowed.includes(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors(origin)
  });
}

function norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function scoreData(a, b) {
  if (!a?.pairing) return 0;
  const v = a.pairing[b];
  if (typeof v === "number") return v;
  if (v && typeof v.score === "number") return v.score;
  return 0;
}

function parentKey(db, key) {
  const p = db[key]?.parent;
  return p && db[p] ? p : null;
}

function inheritedScore(db, a, b) {
  const direct = Math.max(scoreData(db[a], b), scoreData(db[b], a));
  if (direct) return direct;

  const pa = parentKey(db, a);
  const pb = parentKey(db, b);
  const candidates = [
    pa && scoreData(db[pa], b),
    pa && scoreData(db[b], pa),
    pb && scoreData(db[a], pb),
    pb && scoreData(db[pb], a),
    pa && pb && scoreData(db[pa], pb),
    pa && pb && scoreData(db[pb], pa)
  ];
  return Math.max(0, ...candidates.filter(v => typeof v === "number"));
}

function findKey(db, query) {
  const q = norm(query);
  if (!q) return null;

  if (db[q]) return q;

  const exact = Object.keys(db).find(k =>
    norm(k) === q || norm(db[k]?.nome) === q
  );
  if (exact) return exact;

  const partial = Object.keys(db).filter(k =>
    norm(k).includes(q) || norm(db[k]?.nome).includes(q)
  );

  return partial.length === 1 ? partial[0] : null;
}

function publicIngredient(db, key) {
  const d = db[key];
  return {
    key,
    nome: d.nome,
    categoria: d.categoria || null,
    famiglia: d.famiglia || null,
    profilo: Array.isArray(d.profilo) ? d.profilo : [],
    tipo_record: d.tipo_record || null,
    parent: d.parent || null,
    varieta: d.varieta || null,
    tipologia: d.tipologia || null,
    stagionatura: d.stagionatura || null
  };
}

async function loadDatabase() {
  const now = Date.now();
  if (cache.data && cache.expires > now) return cache.data;

  const response = await fetch(DATABASE_URL, { cf: { cacheTtl: 60 } });
  if (!response.ok) throw new Error("Database non disponibile");
  const raw = await response.json();

  const db = { ...raw };
  delete db._metadata;
  delete db._pairing_types;

  cache = { data: db, expires: now + 60_000 };
  return db;
}

function pairResult(db, a, b) {
  const score = inheritedScore(db, a, b);
  const profilesA = Array.isArray(db[a]?.profilo) ? db[a].profilo.map(norm) : [];
  const profilesB = Array.isArray(db[b]?.profilo) ? db[b].profilo.map(norm) : [];
  const shared = profilesA.filter(x => profilesB.includes(x));

  return {
    a: publicIngredient(db, a),
    b: publicIngredient(db, b),
    score,
    max_score: 5,
    source: score ? "FoodPairing database + inheritance" : "none",
    shared_profile: shared
  };
}

function combination(db, keys) {
  if (keys.length !== 4 || new Set(keys).size !== 4) return null;

  const pairs = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      pairs.push(pairResult(db, keys[i], keys[j]));
    }
  }

  const scores = pairs.map(p => p.score);
  const positive = scores.filter(s => s > 0);
  const min = positive.length ? Math.min(...positive) : 0;
  const avg = positive.length ? positive.reduce((a,b) => a+b, 0) / positive.length : 0;

  const profiles = keys.map(k => Array.isArray(db[k]?.profilo) ? db[k].profilo.map(norm) : []);
  let profile = 0;
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      profile += profiles[i].filter(x => profiles[j].includes(x)).length;
    }
  }

  return {
    ingredients: keys.map(k => publicIngredient(db, k)),
    pairs,
    score: { min, average: Number(avg.toFixed(2)), profile },
    complete: positive.length === 6
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    try {
      const db = await loadDatabase();
      const url = new URL(request.url);
      const action = norm(url.searchParams.get("action") || "help");

      if (action === "help") {
        return json({
          name: "FoodPairing API",
          version: "1.0",
          endpoints: [
            "?action=ingredient&name=mela",
            "?action=pair&a=mela&b=maiale",
            "?action=pairings&ingredient=mela&limit=10",
            "?action=combination&ingredients=mela,maiale,timo,senape"
          ]
        }, 200, origin);
      }

      if (action === "ingredient") {
        const key = findKey(db, url.searchParams.get("name"));
        if (!key) return json({ error: "Ingrediente non trovato o ambiguo" }, 404, origin);
        return json(publicIngredient(db, key), 200, origin);
      }

      if (action === "pair") {
        const a = findKey(db, url.searchParams.get("a"));
        const b = findKey(db, url.searchParams.get("b"));
        if (!a || !b) return json({ error: "Ingredienti non trovati o ambigui" }, 404, origin);
        if (a === b) return json({ error: "Gli ingredienti devono essere diversi" }, 400, origin);
        return json(pairResult(db, a, b), 200, origin);
      }

      if (action === "pairings") {
        const key = findKey(db, url.searchParams.get("ingredient"));
        if (!key) return json({ error: "Ingrediente non trovato o ambiguo" }, 404, origin);

        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 50);
        const rows = Object.keys(db)
          .filter(k => k !== key)
          .map(k => ({ key: k, score: inheritedScore(db, key, k) }))
          .filter(x => x.score > 0)
          .sort((a,b) => b.score - a.score || db[a.key].nome.localeCompare(db[b.key].nome, "it"))
          .slice(0, limit)
          .map(x => ({
            ...publicIngredient(db, x.key),
            score: x.score,
            max_score: 5
          }));

        return json({
          ingredient: publicIngredient(db, key),
          count: rows.length,
          pairings: rows
        }, 200, origin);
      }

      if (action === "combination") {
        const names = String(url.searchParams.get("ingredients") || "")
          .split(",").map(x => x.trim()).filter(Boolean);

        if (names.length !== 4) {
          return json({ error: "Servono esattamente 4 ingredienti" }, 400, origin);
        }

        const keys = names.map(name => findKey(db, name));
        if (keys.some(k => !k)) {
          return json({ error: "Uno o più ingredienti non sono stati trovati", ingredients: names }, 404, origin);
        }

        const result = combination(db, keys);
        return json(result, 200, origin);
      }

      return json({ error: "Azione non riconosciuta" }, 400, origin);
    } catch (error) {
      return json({ error: error.message || "Errore interno" }, 500, origin);
    }
  }
};
