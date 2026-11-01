# Internal tools portfolio

Working demos of the internal sales and operations tools I built for a dietary-supplement
contract manufacturer. Everything runs as a static site on synthetic data.

| Tool | Stack | Demo |
|---|---|---|
| Pricing Tool (quote calculator, saved quotes, GM analysis, procurement, sourcing check) | Google Apps Script, Sheets, vanilla JS, Gemini | `pricing/` |
| CRM (clients, pipeline, weekly sales, production, delays, outreach) | Cloudflare Workers, KV, D1, Access, Gemini | `crm/` |
| R&D Toolkit (product search, AI formula review, AI recommendations) | Google Apps Script, Sheets, Gemini | `rd/` |

## How the Pricing demo runs without Google

The production app is a Google Apps Script web app. The demo keeps both halves of it:

- **Front end**: the real page templates (`Pricing.html`, `GM.html`, ...).
- **Back end**: the real `Code.js`, loaded as a normal script in the browser.

`shared/gas-emulator.js` sits between them and provides the Google services the back end uses:

| Apps Script service | Demo replacement |
|---|---|
| `SpreadsheetApp` | in-memory spreadsheets (2D arrays) saved to `localStorage` |
| `PropertiesService`, `CacheService` | key/value stores |
| `UrlFetchApp` | synchronous mocks (`pricing/mocks.js`): fixed FX rates, canned Gemini answers |
| `Session`, `Utilities`, `Logger`, ... | small stand-ins |
| `google.script.run` | async proxy that calls the server function, with JSON round-trip like the real thing |

## How the CRM demo runs without Cloudflare

The production CRM is one page (`template.html` + tab modules) served by a Cloudflare Worker
(`worker.js`) with KV, a D1 database and Cloudflare Access in front. The demo runs the same
`worker.js`, unchanged, inside the browser. `shared/worker-emulator.js`:

| Cloudflare piece | Demo replacement |
|---|---|
| `fetch()` to `/api/*` | routed to `worker.fetch(request, env)` |
| KV (`env.CRM_KV`) | key/value map in `localStorage`, with prefix listing and cursors |
| D1 (`env.DB`) | SQLite compiled to WebAssembly (sql.js), same schema migration, saved in `localStorage` |
| Cloudflare Access | an RS256 token signed in the browser; the Worker checks the signature against a mocked certs endpoint, as it does in production |
| Gemini | canned answers (`crm/mocks.js`) |

`shared/demo-clock.js` runs the pages as if it were the day the synthetic data was made, so
"this week", overdue and stalled views stay meaningful whenever the demo is opened.

## Build

```
python tools/gen_pricing_seed.py                          # synthetic data  -> pricing/seed.js
python tools/build_pricing.py <path>/sales_toolkit        # real source     -> pricing/*.html, code.js
python tools/build_rd.py <path>/rd_toolkit                # real source     -> rd/*.html, code.js
python tools/gen_crm_seed.py                              # synthetic data  -> crm/seed_kv.js, production_seed.js
python tools/build_crm.py <path>/<crm-repo>/preview          # real source     -> crm/index.html, worker.js, tab modules
python tools/translate_en.py apply                        # Korean UI text -> English (run after the builds)
```

The tools were built for a team that works in Korean and English. The demo shows English only:
`tools/translate_en.py` replaces each piece of Korean text from the dictionary in
`tools/i18n/en.json` and fails if any visible Korean is left (`todo` lists what is missing,
`merge` adds new translations). The Delays and Production tabs already carry English next to
Korean, so they are pinned to English and their language toggle is removed. The AI prompts are
translated too, and the demo AI mocks (`*/mocks.js`) read the English prompts. Apart from the
text, the code is unchanged.

`build_crm.py` also reads every real client and outreach-prospect name from the private source,
in memory only, replaces them, and fails the build if any is left. The Outreach tab's data file is
rebuilt from invented companies by `tools/make_outreach_demo.js`; only its email templates are reused.

Both builds replace names, emails and IDs listed in `tools/scrub_rules.local.json`
(kept out of git), alters business constants (processing price tiers, labour model,
freight and customs defaults), fills the HtmlService template tags, and stops the build if any
denied term is left in the output.

`tools/make_seed_quotes.js` drives the real UI with Playwright to create the saved quotes in the
seed, so they have the exact shape the app writes.

Third-party code in `shared/vendor/`: sql.js (MIT) and Chart.js (MIT), with their licences.

## Run locally

```
python -m http.server 8000
```

then open http://localhost:8000/.
