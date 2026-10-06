const DATABASE_URL = "https://raw.githubusercontent.com/carloposadino-crypto/FoodPairing/main/database.json";

let cache = { data: null, expires: 0 };

function norm(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
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

function inheritedScoreData(db, a, b) {
  const directA = scoreData(db[a], b);
  const directB = scoreData(db[b], a);
  if (directA || directB) return { score: Math.max(directA, directB), source: "database_direct" };

  const pa = parentKey(db, a), pb = parentKey(db, b);
  const candidates = [
    [pa && scoreData(db[pa], b), "parent_a"],
    [pa && scoreData(db[b], pa), "parent_a_reverse"],
    [pb && scoreData(db[a], pb), "parent_b"],
    [pb && scoreData(db[pb], a), "parent_b_reverse"],
    [pa && pb && scoreData(db[pa], pb), "parents"],
    [pa && pb && scoreData(db[pb], pa), "parents_reverse"]
  ].filter(x => typeof x[0] === "number" && x[0] > 0);

  if (!candidates.length) return { score: 0, source: "none" };
  candidates.sort((x, y) => y[0] - x[0]);
  return { score: candidates[0][0], source: "database_inherited" };
}

function profileInference(db, a, b) {
  const pa = Array.isArray(db[a]?.profilo) ? db[a].profilo.map(norm) : [];
  const pb = Array.isArray(db[b]?.profilo) ? db[b].profilo.map(norm) : [];
  const shared = pa.filter(x => pb.includes(x));
  if (!shared.length) return { score: 0, shared_profile: [] };
  const score = Math.min(3, 1 + Math.min(2, shared.length * 0.5));
  return { score, shared_profile: shared };
}

function pairEvidence(db, a, b) {
  const local = inheritedScoreData(db, a, b);
  if (local.score > 0) {
    return {
      score: local.score,
      max_score: 5,
      source: local.source,
      confidence: local.source === "database_direct" ? "alta" : "media",
      explanation: local.source === "database_direct"
        ? "Abbinamento presente direttamente nel database FoodPairing."
        : "Abbinamento ereditato dalla relazione con l'ingrediente padre."
    };
  }

  const inferred = profileInference(db, a, b);
  if (inferred.score > 0) {
    return {
      score: inferred.score,
      max_score: 5,
      source: "profile_inference",
      confidence: "bassa",
      shared_profile: inferred.shared_profile,
      explanation: "Non esiste un legame esplicito; la compatibilità è stimata dai profili aromatici condivisi."
    };
  }

  return {
    score: 0,
    max_score: 5,
    source: "none",
    confidence: "nessuna",
    explanation: "Nessuna evidenza disponibile nel database."
  };
}

function findKey(db, query) {
  const q = norm(query);
  if (!q) return null;
  const exact = Object.keys(db).find(k => norm(k) === q || norm(db[k]?.nome) === q);
  if (exact) return exact;
  const partial = Object.keys(db).filter(k => norm(k).includes(q) || norm(db[k]?.nome).includes(q));
  return partial.length === 1 ? partial[0] : null;
}

function publicIngredient(db, key) {
  const d = db[key];
  return {
    key, nome: d.nome, categoria: d.categoria || null, famiglia: d.famiglia || null,
    profilo: Array.isArray(d.profilo) ? d.profilo : [], tipo_record: d.tipo_record || null,
    parent: d.parent || null, varieta: d.varieta || null, tipologia: d.tipologia || null,
    stagionatura: d.stagionatura || null
  };
}

async function loadDatabase() {
  const now = Date.now();
  if (cache.data && cache.expires > now) return cache.data;
  const response = await fetch(DATABASE_URL);
  if (!response.ok) throw new Error("Database non disponibile: HTTP " + response.status);
  const raw = await response.json();
  const db = { ...raw };
  delete db._metadata;
  delete db._pairing_types;
  cache = { data: db, expires: now + 60000 };
  return db;
}

function pairResult(db, a, b) {
  const evidence = pairEvidence(db, a, b);
  return {
    a: publicIngredient(db, a),
    b: publicIngredient(db, b),
    score: Number(evidence.score.toFixed(2)),
    max_score: 5,
    source: evidence.source,
    confidence: evidence.confidence,
    explanation: evidence.explanation,
    shared_profile: evidence.shared_profile || []
  };
}

function combination(db, keys) {
  if (keys.length !== 4 || new Set(keys).size !== 4) return null;
  const pairs = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) pairs.push(pairResult(db, keys[i], keys[j]));

  const scores = pairs.map(p => p.score);
  const positive = scores.filter(s => s > 0);
  const average = positive.length ? positive.reduce((a, b) => a + b, 0) / positive.length : 0;
  const min = positive.length ? Math.min(...positive) : 0;

  return {
    ingredients: keys.map(k => publicIngredient(db, k)),
    pairs,
    score: { min: Number(min.toFixed(2)), average: Number(average.toFixed(2)), coverage: Number((positive.length / 6).toFixed(2)) },
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
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });

  try {
    const db = await loadDatabase();
    const action = norm(req.query?.action || "help");

    if (action === "help") return send(res, 200, {
      name: "FoodPairing API", version: "1.1", database: "FoodPairing", status: "online",
      capabilities: ["ingredient", "pair", "pairings", "combination", "evidence", "profile inference"],
      endpoints: [
        "/api/foodpairing?action=ingredient&name=mela",
        "/api/foodpairing?action=pair&a=mela&b=maiale",
        "/api/foodpairing?action=pairings&ingredient=mela&limit=10",
        "/api/foodpairing?action=combination&ingredients=mela,maiale,timo,senape"
      ]
    });

    if (action === "ingredient") {
      const key = findKey(db, req.query?.name);
      if (!key) return send(res, 404, { error: "Ingrediente non trovato o ambiguo" });
      return send(res, 200, publicIngredient(db, key));
    }

    if (action === "pair") {
      const a = findKey(db, req.query?.a), b = findKey(db, req.query?.b);
      if (!a || !b) return send(res, 404, { error: "Ingredienti non trovati o ambigui" });
      if (a === b) return send(res, 400, { error: "Gli ingredienti devono essere diversi" });
      return send(res, 200, pairResult(db, a, b));
    }

    if (action === "pairings") {
      const key = findKey(db, req.query?.ingredient);
      if (!key) return send(res, 404, { error: "Ingrediente non trovato o ambiguo" });
      const requested = Number(req.query?.limit);
      const limit = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? requested : 10, 1), 50);

      const rows = Object.keys(db).filter(k => k !== key).map(k => {
        const e = pairEvidence(db, key, k);
        return { key: k, ...e };
      }).filter(x => x.score > 0).sort((a,b) => b.score-a.score || db[a.key].nome.localeCompare(db[b.key].nome, "it")).slice(0, limit)
        .map(x => ({ ...publicIngredient(db, x.key), score:Number(x.score.toFixed(2)), max_score:5, source:x.source, confidence:x.confidence, explanation:x.explanation, shared_profile:x.shared_profile||[] }));

      return send(res, 200, { ingredient: publicIngredient(db, key), count: rows.length, pairings: rows });
    }

    if (action === "combination") {
      const names = String(req.query?.ingredients || "").split(",").map(x => x.trim()).filter(Boolean);
      if (names.length !== 4) return send(res, 400, { error: "Servono esattamente 4 ingredienti" });
      const keys = names.map(name => findKey(db, name));
      if (keys.some(k => !k)) return send(res, 404, { error: "Uno o più ingredienti non sono stati trovati", ingredients: names });
      return send(res, 200, combination(db, keys));
    }

    return send(res, 400, { error: "Azione non riconosciuta" });
  } catch (error) {
    return send(res, 500, { error: error?.message || "Errore interno" });
  }
};