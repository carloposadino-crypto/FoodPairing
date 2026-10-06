const DATABASE_URL = "https://raw.githubusercontent.com/carloposadino-crypto/FoodPairing/main/database.json";

let cache = { data: null, expires: 0 };

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

  return Math.max(0, ...[
    pa && scoreData(db[pa], b),
    pa && scoreData(db[b], pa),
    pb && scoreData(db[a], pb),
    pb && scoreData(db[pb], a),
    pa && pb && scoreData(db[pa], pb),
    pa && pb && scoreData(db[pb], pa)
  ].filter(v => typeof v === "number"));
}

function findKey(db, query) {
  const q = norm(query);
  if (!q) return null;

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

  const response = await fetch(DATABASE_URL);
  if (!response.ok) {
    throw new Error("Database non disponibile: HTTP " + response.status);
  }

  const raw = await response.json();
  const db = { ...raw };
  delete db._metadata;
  delete db._pairing_types;

  cache = { data: db, expires: now + 60000 };
  return db;
}

function pairResult(db, a, b) {
  const score = inheritedScore(db, a, b);
  const profilesA = Array.isArray(db[a]?.profilo) ? db[a].profilo.map(norm) : [];
  const profilesB = Array.isArray(db[b]?.profilo) ? db[b].profilo.map(norm) : [];

  return {
    a: publicIngredient(db, a),
    b: publicIngredient(db, b),
    score,
    max_score: 5,
    source: score ? "FoodPairing database + inheritance" : "none",
    shared_profile: profilesA.filter(x => profilesB.includes(x))
  };
}

function combination(db, keys) {
  if (keys.length !== 4 || new Set(keys).size !== 4) return null;

  const pairs = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      pairs.push(pairResult(db, keys[i], keys[j]));
    }
  }

  const scores = pairs.map(p => p.score);
  const positive = scores.filter(s => s > 0);
  const average = positive.length
    ? positive.reduce((a, b) => a + b, 0) / positive.length
    : 0;

  return {
    ingredients: keys.map(k => publicIngredient(db, k)),
    pairs,
    score: {
      min: positive.length ? Math.min(...positive) : 0,
      average: Number(average.toFixed(2))
    },
    complete: positive.length === 6
  };
}

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(body);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return send(res, 204, {});
  }

  if (req.method !== "GET") {
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    const db = await loadDatabase();
    const action = norm(req.query?.action || "help");

    if (action === "help") {
      return send(res, 200, {
        name: "FoodPairing API",
        version: "1.0",
        database: "FoodPairing",
        status: "online",
        endpoints: [
          "/api/foodpairing?action=ingredient&name=mela",
          "/api/foodpairing?action=pair&a=mela&b=maiale",
          "/api/foodpairing?action=pairings&ingredient=mela&limit=10",
          "/api/foodpairing?action=combination&ingredients=mela,maiale,timo,senape"
        ]
      });
    }

    if (action === "ingredient") {
      const key = findKey(db, req.query?.name);
      if (!key) return send(res, 404, { error: "Ingrediente non trovato o ambiguo" });
      return send(res, 200, publicIngredient(db, key));
    }

    if (action === "pair") {
      const a = findKey(db, req.query?.a);
      const b = findKey(db, req.query?.b);

      if (!a || !b) return send(res, 404, { error: "Ingredienti non trovati o ambigui" });
      if (a === b) return send(res, 400, { error: "Gli ingredienti devono essere diversi" });

      return send(res, 200, pairResult(db, a, b));
    }

    if (action === "pairings") {
      const key = findKey(db, req.query?.ingredient);
      if (!key) return send(res, 404, { error: "Ingrediente non trovato o ambiguo" });

      const requested = Number(req.query?.limit);
      const limit = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? requested : 10, 1), 50);

      const rows = Object.keys(db)
        .filter(k => k !== key)
        .map(k => ({ key: k, score: inheritedScore(db, key, k) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || db[a.key].nome.localeCompare(db[b.key].nome, "it"))
        .slice(0, limit)
        .map(x => ({
          ...publicIngredient(db, x.key),
          score: x.score,
          max_score: 5
        }));

      return send(res, 200, {
        ingredient: publicIngredient(db, key),
        count: rows.length,
        pairings: rows
      });
    }

    if (action === "combination") {
      const names = String(req.query?.ingredients || "")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

      if (names.length !== 4) {
        return send(res, 400, { error: "Servono esattamente 4 ingredienti" });
      }

      const keys = names.map(name => findKey(db, name));
      if (keys.some(k => !k)) {
        return send(res, 404, {
          error: "Uno o più ingredienti non sono stati trovati",
          ingredients: names
        });
      }

      return send(res, 200, combination(db, keys));
    }

    return send(res, 400, { error: "Azione non riconosciuta" });
  } catch (error) {
    return send(res, 500, {
      error: error?.message || "Errore interno"
    });
  }
};
