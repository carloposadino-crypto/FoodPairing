# Proxy Flavonomics

Architettura:

GitHub Pages → Cloudflare Worker → Flavonomics API

## 1. Deploy

Installa Wrangler e accedi a Cloudflare:

```bash
npm install -g wrangler
wrangler login
```

Dalla root del repository:

```bash
wrangler deploy
```

Il Worker userà `api/flavonomics-proxy.js`.

## 2. Imposta la chiave Flavonomics

La chiave **non va inserita in GitHub** e non va inserita nel codice JavaScript.

Impostala come secret Cloudflare:

```bash
wrangler secret put FLAVONOMICS_API_KEY
```

Quando richiesto, incolla la tua chiave Flavonomics che inizia con `flv_`.

## 3. Collega l'app

Dopo il deploy Cloudflare avrai un indirizzo simile a:

```
https://foodpairing-flavonomics-proxy.<tuo-account>.workers.dev
```

Nell'app FoodPairing inserisci quell'indirizzo nel campo **Endpoint Flavonomics sicuro** e premi **Salva endpoint**.

Poi scegli un ingrediente e premi **Consulta Flavonomics**.

## Sicurezza

Il browser chiama solo il Worker. La chiave API viene letta esclusivamente da `env.FLAVONOMICS_API_KEY` sul Worker e viene inviata a Flavonomics tramite l'header `x-api-key`.

Il Worker accetta richieste CORS dall'app GitHub Pages e dagli indirizzi localhost di sviluppo.
