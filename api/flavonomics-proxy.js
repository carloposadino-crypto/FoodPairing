/**
 * FoodPairing - proxy sicuro Flavonomics
 *
 * Deploy come Cloudflare Worker.
 * Imposta il secret:
 *   FLAVONOMICS_API_KEY = flv_...
 *
 * Il browser NON riceve mai la chiave API.
 */
const API_BASE = "https://api.flavonomics.com/v1";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = new Set([
      "https://carloposadino-crypto.github.io",
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ]);

    if (origin && !allowedOrigins.has(origin)) {
      return new Response(JSON.stringify({error:"Origin not allowed"}), {
        status:403,
        headers:{
          "Content-Type":"application/json",
          "Vary":"Origin"
        }
      });
    }

    const corsOrigin = origin || "https://carloposadino-crypto.github.io";
    const headers = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {status:204, headers});
    }

    if (request.method !== "GET") {
      return new Response(JSON.stringify({error:"Method not allowed"}), {
        status:405,
        headers:{...headers,"Content-Type":"application/json"}
      });
    }

    const url = new URL(request.url);
    const ingredient = String(url.searchParams.get("ingredient") || "").trim();

    if (!ingredient) {
      return new Response(JSON.stringify({error:"Missing ingredient"}), {
        status:400,
        headers:{...headers,"Content-Type":"application/json"}
      });
    }

    if (!env.FLAVONOMICS_API_KEY) {
      return new Response(JSON.stringify({error:"Proxy not configured"}), {
        status:500,
        headers:{...headers,"Content-Type":"application/json"}
      });
    }

    const target = API_BASE + "/ingredients/" + encodeURIComponent(ingredient) + "/pairings";

    try {
      const upstream = await fetch(target, {
        headers: {
          "Accept": "application/json",
          "x-api-key": env.FLAVONOMICS_API_KEY
        }
      });

      const body = await upstream.text();

      return new Response(body, {
        status: upstream.status,
        headers: {
          ...headers,
          "Content-Type": upstream.headers.get("Content-Type") || "application/json",
          "Cache-Control": "public, max-age=300"
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error:"Flavonomics upstream request failed"
      }), {
        status:502,
        headers:{...headers,"Content-Type":"application/json"}
      });
    }
  }
};
