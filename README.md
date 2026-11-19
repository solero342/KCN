# KCN

Koffie op kantoor: bonen-check, wie er gehaald heeft, voorraad en koffie-aanbiedingen.
Draait als Cloudflare Worker (`npx wrangler deploy`).

- `public/index.html`: de pagina
- `src/worker.js`: login en opslag (D1-koppeling `DB`, geheim `SITE_PASSWORD`)
- `lib/state.js`: regels voor de gegevens
- `wrangler.jsonc`: instellingen voor Cloudflare
- `aanbiedingen.json`: wordt dagelijks automatisch ververst
