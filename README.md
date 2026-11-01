# Sales and operations tool demos

Working demos of three tools I designed and built for a manufacturing business's sales and
operations team. Everything runs as a static site on synthetic data: every company, person,
product and number in it is invented.

Live: https://hanbitkang-dev.github.io/portfolio/

| Tool | Stack | Demo |
|---|---|---|
| Pricing Tool (quote calculator, saved quotes, GM analysis, procurement, ingredient check) | Google Apps Script, Sheets, vanilla JS, Gemini | `pricing/` |
| CRM (clients, pipeline, weekly sales, production, delays, credit, forecast) | Cloudflare Workers, KV, D1, Access, Gemini | `crm/` |
| R&D Toolkit (product search, AI formula review, AI recommendations) | Google Apps Script, Sheets, Gemini | `rd/` |

## How the Pricing and R&D demos run without Google

Both tools are Google Apps Script web apps. In the demo, the server code (`code.js`) runs as a
normal script in the browser, and `shared/gas-emulator.js` provides the Google services it uses:

| Apps Script service | Demo replacement |
|---|---|
| `SpreadsheetApp` | in-memory spreadsheets (2D arrays) saved to `localStorage` |
| `PropertiesService`, `CacheService` | key/value stores |
| `UrlFetchApp` | synchronous mocks (`*/mocks.js`): fixed FX rates, fixed Gemini answers |
| `Session`, `Utilities`, `Logger`, ... | small stand-ins |
| `google.script.run` | async proxy that calls the server function, with a JSON round-trip like the real thing |

## How the CRM demo runs without Cloudflare

The CRM is one page plus tab modules, served by a Cloudflare Worker (`worker.js`) with KV, a D1
database and Cloudflare Access in front. The demo runs `worker.js` inside the browser.
`shared/worker-emulator.js`:

| Cloudflare piece | Demo replacement |
|---|---|
| `fetch()` to `/api/*` | routed to `worker.fetch(request, env)` |
| KV (`env.CRM_KV`) | key/value map in `localStorage`, with prefix listing and cursors |
| D1 (`env.DB`) | SQLite compiled to WebAssembly (sql.js), saved in `localStorage` |
| Cloudflare Access | an RS256 token signed in the browser; the Worker checks the signature against a mocked certs endpoint |
| Gemini | fixed answers (`crm/mocks.js`) |

`shared/demo-clock.js` runs the pages as if it were the day the synthetic data was made, so
"this week", overdue and stalled views stay meaningful whenever the demo is opened.

Third-party code in `shared/vendor/`: sql.js (MIT) and Chart.js (MIT), with their licences.

## Run locally

```
python -m http.server 8000
```

then open http://localhost:8000/.
