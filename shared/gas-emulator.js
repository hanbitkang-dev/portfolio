/* ==================================================================
   GAS Emulator — runs an unmodified Google Apps Script backend
   (Code.js) in the browser.

   What it replaces
     SpreadsheetApp      in-memory spreadsheets (2D arrays), saved to localStorage
     PropertiesService   key/value store, saved to localStorage
     CacheService        in-memory, 6h TTL ignored
     Session / Utilities / Logger / ContentService / HtmlService / ScriptApp
     UrlFetchApp         routed to window.GAS_FETCH_MOCKS (synchronous, like GAS)
     google.script.run   async proxy that calls the global server function

   Load order on a page:
     gas-emulator.js  →  seed.js (window.GAS_SEED)  →  code.js (the GAS backend)
   ================================================================== */
(function (global) {
  'use strict';

  var STORE_KEY = (global.GAS_DEMO_KEY || 'gasdemo') + ':v1';
  var TZ = 'Pacific/Auckland';
  var USER = global.GAS_DEMO_USER || 'demo.user@example.com';

  // ── persistence (Dates survive JSON as {"$d": iso}) ─────────────────
  function enc(v) {
    return JSON.stringify(v, function (k, x) {
      var raw = this[k];
      return raw instanceof Date ? { $d: raw.toISOString() } : x;
    });
  }
  function dec(s) {
    return JSON.parse(s, function (k, x) {
      return x && typeof x === 'object' && typeof x.$d === 'string' ? new Date(x.$d) : x;
    });
  }
  function reviveSeed(seed) { return dec(enc(seed || {})); }

  var state = null;
  function load() {
    try { var s = localStorage.getItem(STORE_KEY); if (s) { state = dec(s); return; } } catch (e) { /* private mode */ }
    var seed = reviveSeed(global.GAS_SEED);
    state = { spreadsheets: seed.spreadsheets || {}, properties: seed.properties || {} };
  }
  var dirty = false;
  function markDirty() { dirty = true; }
  function save() {
    if (!dirty) return;
    dirty = false;
    try { localStorage.setItem(STORE_KEY, enc(state)); } catch (e) { console.warn('[gas-emulator] could not save', e); }
  }
  function ensure() { if (!state) load(); }

  // ── helpers ─────────────────────────────────────────────────────────
  function clone(v) { return v instanceof Date ? new Date(v.getTime()) : v; }
  function a1ToRC(a1) {
    var m = /^([A-Z]+)(\d+)$/i.exec(String(a1).trim());
    if (!m) throw new Error('Unsupported A1 notation: ' + a1);
    var c = 0; m[1].toUpperCase().split('').forEach(function (ch) { c = c * 26 + (ch.charCodeAt(0) - 64); });
    return [parseInt(m[2], 10), c];
  }

  // ── Range ───────────────────────────────────────────────────────────
  function Range(sheet, row, col, nr, nc) { this._s = sheet; this._r = row; this._c = col; this._nr = nr; this._nc = nc; }
  Range.prototype._grid = function () { return this._s._d.rows; };
  Range.prototype._ensure = function () {
    var g = this._grid(), lastR = this._r + this._nr - 1, lastC = this._c + this._nc - 1;
    while (g.length < lastR) g.push([]);
    for (var i = 0; i < g.length; i++) while (g[i].length < lastC) g[i].push('');
  };
  Range.prototype.getValues = function () {
    var g = this._grid(), out = [];
    for (var i = 0; i < this._nr; i++) {
      var src = g[this._r - 1 + i] || [], row = [];
      for (var j = 0; j < this._nc; j++) { var v = src[this._c - 1 + j]; row.push(v === undefined || v === null ? '' : clone(v)); }
      out.push(row);
    }
    return out;
  };
  Range.prototype.getDisplayValues = function () {
    return this.getValues().map(function (r) { return r.map(function (v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v); }); });
  };
  Range.prototype.getValue = function () { return this.getValues()[0][0]; };
  Range.prototype.setValues = function (vals) {
    if (!vals || vals.length !== this._nr) throw new Error('setValues: row count ' + (vals && vals.length) + ' does not match range ' + this._nr);
    this._ensure();
    var g = this._grid();
    for (var i = 0; i < this._nr; i++) {
      if (vals[i].length !== this._nc) throw new Error('setValues: column count ' + vals[i].length + ' does not match range ' + this._nc);
      for (var j = 0; j < this._nc; j++) g[this._r - 1 + i][this._c - 1 + j] = clone(vals[i][j]);
    }
    this._s._trim(); markDirty(); return this;
  };
  Range.prototype.setValue = function (v) {
    var vals = []; for (var i = 0; i < this._nr; i++) { var r = []; for (var j = 0; j < this._nc; j++) r.push(v); vals.push(r); }
    return this.setValues(vals);
  };
  Range.prototype.clearContent = function () {
    var g = this._grid();
    for (var i = 0; i < this._nr; i++) { var r = g[this._r - 1 + i]; if (!r) continue; for (var j = 0; j < this._nc; j++) if (this._c - 1 + j < r.length) r[this._c - 1 + j] = ''; }
    this._s._trim(); markDirty(); return this;
  };
  Range.prototype.clearContents = Range.prototype.clearContent;
  Range.prototype.clear = Range.prototype.clearContent;
  Range.prototype.getRow = function () { return this._r; };
  Range.prototype.getColumn = function () { return this._c; };
  Range.prototype.getNumRows = function () { return this._nr; };
  Range.prototype.getNumColumns = function () { return this._nc; };
  Range.prototype.getHeight = Range.prototype.getNumRows;
  Range.prototype.getWidth = Range.prototype.getNumColumns;
  ['setNumberFormat', 'setFontWeight', 'setBackground', 'setFontColor', 'setWrap', 'setHorizontalAlignment', 'setBorder', 'setNote']
    .forEach(function (m) { Range.prototype[m] = function () { return this; }; });

  // ── Sheet ───────────────────────────────────────────────────────────
  function Sheet(ss, d) { this._ss = ss; this._d = d; }
  Sheet.prototype._trim = function () {
    var g = this._d.rows;
    var blank = function (r) { return !r || r.every(function (v) { return v === '' || v === null || v === undefined; }); };
    while (g.length && blank(g[g.length - 1])) g.pop();
  };
  Sheet.prototype.getName = function () { return this._d.name; };
  Sheet.prototype.setName = function (n) { this._d.name = n; markDirty(); return this; };
  Sheet.prototype.getSheetId = function () { return this._d.id; };
  Sheet.prototype.getLastRow = function () { this._trim(); return this._d.rows.length; };
  Sheet.prototype.getLastColumn = function () {
    var m = 0;
    this._d.rows.forEach(function (r) { for (var j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] !== null && r[j] !== undefined) { if (j + 1 > m) m = j + 1; break; } });
    return m;
  };
  Sheet.prototype.getMaxRows = function () { return Math.max(1000, this._d.rows.length); };
  Sheet.prototype.getMaxColumns = function () { return Math.max(26, this.getLastColumn()); };
  Sheet.prototype.getDataRange = function () {
    var nr = Math.max(1, this.getLastRow()), nc = Math.max(1, this.getLastColumn());
    return new Range(this, 1, 1, nr, nc);
  };
  Sheet.prototype.getRange = function (a, b, c, d) {
    if (typeof a === 'string') {
      var parts = a.split(':'), p1 = a1ToRC(parts[0]), p2 = parts[1] ? a1ToRC(parts[1]) : p1;
      return new Range(this, p1[0], p1[1], p2[0] - p1[0] + 1, p2[1] - p1[1] + 1);
    }
    return new Range(this, a, b, c || 1, d || 1);
  };
  Sheet.prototype.appendRow = function (vals) {
    this._trim();
    this._d.rows.push(vals.map(clone)); markDirty(); return this;
  };
  Sheet.prototype.deleteRow = function (n) { this._d.rows.splice(n - 1, 1); markDirty(); return this; };
  Sheet.prototype.deleteRows = function (n, k) { this._d.rows.splice(n - 1, k); markDirty(); return this; };
  Sheet.prototype.insertRowsAfter = function (n, k) { var a = []; for (var i = 0; i < k; i++) a.push([]); Array.prototype.splice.apply(this._d.rows, [n, 0].concat(a)); markDirty(); return this; };
  Sheet.prototype.clear = function () { this._d.rows = []; markDirty(); return this; };
  Sheet.prototype.clearContents = Sheet.prototype.clear;
  Sheet.prototype.sort = function (colIdx, asc) {
    var head = this._d.rows.slice(0, this._d.frozen || 0), body = this._d.rows.slice(this._d.frozen || 0);
    var up = asc !== false;
    body.sort(function (x, y) { var a = x[colIdx - 1], b = y[colIdx - 1]; if (a instanceof Date) a = a.getTime(); if (b instanceof Date) b = b.getTime(); return (a > b ? 1 : a < b ? -1 : 0) * (up ? 1 : -1); });
    this._d.rows = head.concat(body); markDirty(); return this;
  };
  Sheet.prototype.setFrozenRows = function (n) { this._d.frozen = n; markDirty(); return this; };
  Sheet.prototype.getFrozenRows = function () { return this._d.frozen || 0; };
  ['setColumnWidth', 'setColumnWidths', 'autoResizeColumns', 'hideSheet', 'showSheet', 'activate', 'setTabColor']
    .forEach(function (m) { Sheet.prototype[m] = function () { return this; }; });
  Sheet.prototype.getParent = function () { return this._ss; };

  // ── Spreadsheet ─────────────────────────────────────────────────────
  var nextSheetId = 1000;
  function Spreadsheet(id) { this._id = id; this._d = state.spreadsheets[id]; }
  Spreadsheet.prototype.getId = function () { return this._id; };
  Spreadsheet.prototype.getName = function () { return this._d.name; };
  Spreadsheet.prototype.getUrl = function () { return '#spreadsheet/' + this._id; };
  Spreadsheet.prototype.getSheets = function () { var self = this; return this._d.sheets.map(function (d) { return new Sheet(self, d); }); };
  Spreadsheet.prototype.getSheetByName = function (n) {
    for (var i = 0; i < this._d.sheets.length; i++) if (this._d.sheets[i].name === n) return new Sheet(this, this._d.sheets[i]);
    return null;
  };
  Spreadsheet.prototype.insertSheet = function (n) {
    if (this.getSheetByName(n)) throw new Error('A sheet with the name "' + n + '" already exists.');
    var d = { name: n, id: nextSheetId++, rows: [], frozen: 0 };
    this._d.sheets.push(d); markDirty(); return new Sheet(this, d);
  };
  Spreadsheet.prototype.deleteSheet = function (sh) { this._d.sheets = this._d.sheets.filter(function (d) { return d !== sh._d; }); markDirty(); };
  Spreadsheet.prototype.getActiveSheet = function () { return new Sheet(this, this._d.sheets[0]); };

  var SpreadsheetApp = {
    openById: function (id) {
      ensure();
      if (!id || !state.spreadsheets[id]) throw new Error('Unexpected error while getting the method or property openById on object SpreadsheetApp. (id ' + id + ')');
      return new Spreadsheet(id);
    },
    create: function (name) {
      ensure();
      var id = 'ss_' + Math.random().toString(36).slice(2, 10);
      state.spreadsheets[id] = { name: name, sheets: [{ name: 'Sheet1', id: nextSheetId++, rows: [], frozen: 0 }] };
      markDirty(); return new Spreadsheet(id);
    },
    flush: function () { save(); },
  };

  // ── Properties / Cache ──────────────────────────────────────────────
  var scriptProps = {
    getProperty: function (k) { ensure(); var v = state.properties[k]; return v === undefined ? null : String(v); },
    setProperty: function (k, v) { ensure(); state.properties[k] = String(v); markDirty(); return scriptProps; },
    deleteProperty: function (k) { ensure(); delete state.properties[k]; markDirty(); return scriptProps; },
    getProperties: function () { ensure(); return Object.assign({}, state.properties); },
    setProperties: function (o) { ensure(); for (var k in o) state.properties[k] = String(o[k]); markDirty(); return scriptProps; },
    getKeys: function () { ensure(); return Object.keys(state.properties); },
  };
  var cache = {};
  var scriptCache = {
    get: function (k) { return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : null; },
    put: function (k, v) { cache[k] = String(v); },
    remove: function (k) { delete cache[k]; },
    getAll: function (ks) { var o = {}; ks.forEach(function (k) { if (k in cache) o[k] = cache[k]; }); return o; },
    putAll: function (o) { for (var k in o) cache[k] = String(o[k]); },
  };

  // ── Utilities.formatDate (SimpleDateFormat subset) ──────────────────
  function partsIn(date, tz) {
    var f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
    var o = {}; f.formatToParts(date).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function formatDate(date, tz, pattern) {
    if (!(date instanceof Date)) date = new Date(date);
    if (isNaN(date.getTime())) throw new Error('Invalid date passed to Utilities.formatDate');
    var p = partsIn(date, tz);
    return String(pattern).replace(/yyyy|yy|MMM|MM|dd|HH|mm|ss|EEE|'[^']*'/g, function (t) {
      switch (t) {
        case 'yyyy': return p.year; case 'yy': return p.year.slice(2);
        case 'MMM': return MON[parseInt(p.month, 10) - 1]; case 'MM': return p.month;
        case 'dd': return p.day; case 'HH': return p.hour; case 'mm': return p.minute; case 'ss': return p.second;
        case 'EEE': return p.weekday;
        default: return t.slice(1, -1);
      }
    });
  }
  var Utilities = {
    formatDate: formatDate,
    sleep: function () { /* no-op in the browser */ },
    getUuid: function () { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); },
    base64Encode: function (s) { return btoa(unescape(encodeURIComponent(s))); },
    base64Decode: function (s) { return decodeURIComponent(escape(atob(s))); },
    newBlob: function (data) { return { getDataAsString: function () { return String(data); }, getBytes: function () { return data; } }; },
    parseCsv: function (s) { return String(s).split(/\r?\n/).filter(Boolean).map(function (l) { return l.split(','); }); },
  };

  // ── UrlFetchApp (synchronous, mock handlers) ────────────────────────
  function HttpResponse(code, body) { this._c = code; this._b = typeof body === 'string' ? body : JSON.stringify(body); }
  HttpResponse.prototype.getResponseCode = function () { return this._c; };
  HttpResponse.prototype.getContentText = function () { return this._b; };
  HttpResponse.prototype.getHeaders = function () { return { 'Content-Type': 'application/json' }; };
  var UrlFetchApp = {
    fetch: function (url, opts) {
      var mocks = global.GAS_FETCH_MOCKS || [];
      for (var i = 0; i < mocks.length; i++) {
        if (mocks[i].match.test(url)) {
          var r = mocks[i].respond(url, opts || {});
          return new HttpResponse(r.code || 200, r.body);
        }
      }
      return new HttpResponse(404, { error: { code: 404, message: 'Demo: no mock for ' + url } });
    },
  };

  // ── small services ──────────────────────────────────────────────────
  var Session = {
    getActiveUser: function () { return { getEmail: function () { return USER; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return USER; } }; },
    getScriptTimeZone: function () { return TZ; },
  };
  var Logger = { log: function () { if (global.GAS_DEMO_DEBUG) console.debug.apply(console, ['[GAS]'].concat([].slice.call(arguments))); } };
  function TextOutput(t) { this._t = t; }
  TextOutput.prototype.setMimeType = function () { return this; };
  TextOutput.prototype.getContent = function () { return this._t; };
  var ContentService = { createTextOutput: function (t) { return new TextOutput(t); }, MimeType: { JSON: 'json', TEXT: 'text' } };
  var HtmlService = { XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' }, createTemplateFromFile: function () { throw new Error('HtmlService is not used in the browser demo'); } };
  var ScriptApp = { getService: function () { return { getUrl: function () { return location.href.split('?')[0]; } }; } };
  var LockService = { getScriptLock: function () { return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {} }; } };

  global.SpreadsheetApp = SpreadsheetApp;
  global.PropertiesService = { getScriptProperties: function () { return scriptProps; }, getUserProperties: function () { return scriptProps; } };
  global.CacheService = { getScriptCache: function () { return scriptCache; }, getUserCache: function () { return scriptCache; } };
  global.Utilities = Utilities;
  global.UrlFetchApp = UrlFetchApp;
  global.Session = Session;
  global.Logger = Logger;
  global.ContentService = ContentService;
  global.HtmlService = HtmlService;
  global.ScriptApp = ScriptApp;
  global.LockService = LockService;

  // ── google.script.run ───────────────────────────────────────────────
  // Like the real thing: async, arguments and results pass through a
  // serialisation step (Dates become strings), errors reach the failure handler.
  function wire(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function runner(ok, fail, uo) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return runner(f, fail, uo); };
        if (name === 'withFailureHandler') return function (f) { return runner(ok, f, uo); };
        if (name === 'withUserObject') return function (o) { return runner(ok, fail, o); };
        return function () {
          var args = [].slice.call(arguments).map(wire);
          var delay = (global.GAS_DEMO_LATENCY != null ? global.GAS_DEMO_LATENCY : 120) + Math.random() * 120;
          setTimeout(function () {
            var fn = global[name];
            try {
              if (typeof fn !== 'function') throw new Error('Script function not found: ' + String(name));
              ensure();
              var res = wire(fn.apply(null, args));
              save();
              if (ok) ok(res, uo);
            } catch (e) {
              save();
              console.error('[gas-emulator] ' + String(name) + ':', e);
              if (fail) fail(e, uo);
            }
          }, delay);
        };
      },
    });
  }
  global.google = global.google || {};
  global.google.script = global.google.script || {};
  global.google.script.run = runner(null, null, undefined);
  global.google.script.host = { close: function () {}, setHeight: function () {}, setWidth: function () {}, origin: location.origin };
  global.google.script.url = { getLocation: function (cb) { var p = {}; new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; }); cb({ parameter: p, hash: location.hash.slice(1) }); } };

  global.GasDemo = {
    reset: function () { try { localStorage.removeItem(STORE_KEY); } catch (e) {} state = null; location.reload(); },
    state: function () { ensure(); return state; },
    exportJson: function () { ensure(); return enc(state); },
  };
})(window);
