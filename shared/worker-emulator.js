/* ==================================================================
   Worker Emulator — runs an unmodified Cloudflare Worker (worker.js)
   in the browser, behind the page's own fetch() calls.

   What it replaces
     env.CRM_KV (KV)     key/value map saved to localStorage, with list({prefix, cursor})
     env.DB (D1)         SQLite compiled to WASM (sql.js), saved to localStorage
     Cloudflare Access   a real RS256 token, signed in the browser with a key made at
                         start-up; the Worker verifies it against a mocked certs URL
     env.ASSETS          the static files next to the page
     fetch() to Gemini   window.WORKER_GEMINI_MOCK(body) -> canned answer

   Page setup (classic scripts, before any page script):
     <script>window.WORKER_DEMO = { key, email, accessTeam, workerUrl, seedKv, seedSql, vendor }</script>
     <script src="../shared/worker-emulator.js"></script>
   Every fetch to "<anything>/api/..." on this origin waits until the Worker is ready,
   then goes to worker.fetch(request, env) exactly as on Cloudflare.
   ================================================================== */
(function () {
  'use strict';
  var CFG = window.WORKER_DEMO || {};
  var realFetch = window.fetch.bind(window);
  var readyResolve, readyReject;
  var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });
  var KEY = (CFG.key || 'workerdemo') + ':v1';

  // ── fetch router (installed synchronously) ───────────────────────
  window.fetch = function (input, init) {
    var raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    var url;
    try { url = new URL(raw, location.href); } catch (e) { return realFetch(input, init); }
    if (url.origin === location.origin) {
      var i = url.pathname.indexOf('/api/');
      if (i !== -1) return ready.then(function (h) { return h.api(url.pathname.slice(i) + url.search, input, init); });
    }
    if (/generativelanguage\.googleapis\.com$/.test(url.hostname)) return ready.then(function (h) { return h.gemini(url, init); });
    if (/\/cdn-cgi\/access\/certs$/.test(url.pathname)) return ready.then(function (h) { return h.certs(); });
    return realFetch(input, init);
  };

  // ── storage helpers ───────────────────────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { console.warn('[worker-emulator] could not save', k, e); return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function b64u(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64uStr(s) { return b64u(new TextEncoder().encode(s)); }

  // ── KV ────────────────────────────────────────────────────────────
  function makeKv() {
    var data = null;
    var stored = lsGet(KEY + ':kv');
    if (stored) { try { data = JSON.parse(stored); } catch (e) { data = null; } }
    if (!data) data = Object.assign({}, window.WORKER_SEED_KV || {});
    var timer = null;
    function persist() { clearTimeout(timer); timer = setTimeout(function () { lsSet(KEY + ':kv', JSON.stringify(data)); }, 50); }
    return {
      get: function (k, opt) {
        var v = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
        if (v != null && (opt === 'json' || (opt && opt.type === 'json'))) v = JSON.parse(v);
        return Promise.resolve(v);
      },
      put: function (k, v) { data[k] = typeof v === 'string' ? v : String(v); persist(); return Promise.resolve(); },
      delete: function (k) { delete data[k]; persist(); return Promise.resolve(); },
      list: function (o) {
        o = o || {};
        var names = Object.keys(data).filter(function (k) { return !o.prefix || k.indexOf(o.prefix) === 0; }).sort();
        var start = o.cursor ? parseInt(o.cursor, 10) : 0, lim = o.limit || 1000;
        var page = names.slice(start, start + lim);
        var done = start + lim >= names.length;
        return Promise.resolve({ keys: page.map(function (n) { return { name: n }; }), list_complete: done, cursor: done ? undefined : String(start + lim) });
      },
      _flush: function () { clearTimeout(timer); lsSet(KEY + ':kv', JSON.stringify(data)); },
    };
  }

  // ── D1 on sql.js ──────────────────────────────────────────────────
  function makeD1(SQL) {
    var saved = lsGet(KEY + ':d1');
    var db;
    if (saved) { try { db = new SQL.Database(unb64(saved)); } catch (e) { db = null; } }
    if (!db) { db = new SQL.Database(); if (window.WORKER_SEED_SQL) db.exec(window.WORKER_SEED_SQL); }
    function persist() { lsSet(KEY + ':d1', b64(db.export())); }
    function norm(v) { return v === undefined ? null : v === true ? 1 : v === false ? 0 : v; }
    function exec(sql, params) {
      var st = db.prepare(sql);
      try {
        if (params && params.length) st.bind(params.map(norm));
        var rows = [];
        while (st.step()) rows.push(st.getAsObject());
        return { results: rows, success: true, meta: { changes: db.getRowsModified(), last_row_id: (db.exec('SELECT last_insert_rowid()')[0] || { values: [[0]] }).values[0][0] } };
      } finally { st.free(); }
    }
    function Stmt(sql, params) { this.sql = sql; this.params = params || []; }
    Stmt.prototype.bind = function () { return new Stmt(this.sql, [].slice.call(arguments)); };
    Stmt.prototype.all = function () { var r = exec(this.sql, this.params); if (!/^\s*select/i.test(this.sql)) persist(); return Promise.resolve(r); };
    Stmt.prototype.run = Stmt.prototype.all;
    Stmt.prototype.first = function (col) { var r = exec(this.sql, this.params).results[0] || null; return Promise.resolve(r && col ? r[col] : r); };
    Stmt.prototype.raw = function () { var r = exec(this.sql, this.params).results; return Promise.resolve(r.map(function (o) { return Object.keys(o).map(function (k) { return o[k]; }); })); };
    return {
      prepare: function (sql) { return new Stmt(sql); },
      batch: function (stmts) {
        db.exec('BEGIN');
        try {
          var out = stmts.map(function (s) { return exec(s.sql, s.params); });
          db.exec('COMMIT'); persist();
          return Promise.resolve(out);
        } catch (e) { db.exec('ROLLBACK'); return Promise.reject(e); }
      },
      exec: function (sql) { db.exec(sql); persist(); return Promise.resolve({ count: 1 }); },
    };
  }

  // ── Cloudflare Access: real RS256 token, verified by the Worker ───
  function makeAccess() {
    return crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
      .then(function (kp) {
        return crypto.subtle.exportKey('jwk', kp.publicKey).then(function (jwk) {
          jwk.kid = 'demo-key'; jwk.alg = 'RS256'; jwk.use = 'sig';
          var now = Math.floor(Date.now() / 1000);
          var head = b64uStr(JSON.stringify({ alg: 'RS256', kid: 'demo-key', typ: 'JWT' }));
          var body = b64uStr(JSON.stringify({ iss: CFG.accessTeam, aud: ['demo-aud'], email: CFG.email || 'demo.user@example.com', iat: now, exp: now + 7 * 86400, sub: 'demo' }));
          return crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(head + '.' + body))
            .then(function (sig) { return { jwk: jwk, token: head + '.' + body + '.' + b64u(new Uint8Array(sig)) }; });
        });
      });
  }

  function jsonResponse(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }

  // ── start ─────────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('could not load ' + src)); }; document.head.appendChild(s); });
  }
  var vendor = CFG.vendor || '../shared/vendor/';
  Promise.all([
    import(new URL(CFG.workerUrl || 'worker.js', location.href).href),
    loadScript(vendor + 'sql-wasm.js').then(function () { return window.initSqlJs({ locateFile: function (f) { return vendor + f; } }); }),
    makeAccess(),
  ]).then(function (r) {
    var worker = r[0].default, SQL = r[1], access = r[2];
    var kv = makeKv();
    var env = {
      CRM_KV: kv,
      DB: makeD1(SQL),
      GEMINI_API_KEY: 'demo-key-not-real',
      ASSETS: { fetch: function (req) { var u = new URL(req.url); return realFetch(u.pathname.replace(/^\//, '')); } },
    };
    readyResolve({
      api: function (path, input, init) {
        init = init || {};
        var method = (init.method || (input && input.method) || 'GET').toUpperCase();
        var headers = new Headers(init.headers || (input && input.headers) || {});
        headers.set('cf-access-jwt-assertion', access.token);
        var req = new Request(location.origin + path, { method: method, headers: headers, body: method === 'GET' || method === 'HEAD' ? undefined : init.body });
        return worker.fetch(req, env).catch(function (e) { console.error('[worker-emulator]', path, e); return jsonResponse({ error: e.message }, 500); });
      },
      certs: function () { return Promise.resolve(jsonResponse({ keys: [access.jwk] })); },
      gemini: function (url, init) {
        var body = {}; try { body = JSON.parse(init && init.body || '{}'); } catch (e) {}
        var text = window.WORKER_GEMINI_MOCK ? window.WORKER_GEMINI_MOCK(body) : 'This demo has no live AI.';
        return Promise.resolve(jsonResponse({ candidates: [{ content: { parts: [{ text: text }] }, finishReason: 'STOP' }] }));
      },
    });
  }).catch(function (e) { console.error('[worker-emulator] start failed', e); readyReject(e); });

  window.WorkerDemo = {
    ready: ready,
    reset: function () { lsDel(KEY + ':kv'); lsDel(KEY + ':d1'); location.reload(); },
  };
  // the shared demo badge calls GasDemo.reset(); give it the same entry point
  window.GasDemo = window.GasDemo || { reset: window.WorkerDemo.reset };
})();
