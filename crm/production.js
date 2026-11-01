/* Production tab -- one mother data set, three reports (+ the old output view).

   The mother data is the oERP export (Sales_statistics.xlsx), uploaded in the tab's
   Data view by whoever runs the weekly update -- no deploy needed. Every view reads
   the same upload:
     Production      Planning / Production team: line load and gap warnings, monthly new
                     orders vs target, the weekly status table, readiness + client hold
     Sales           what to win to keep each line busy, client holds to chase, backlog
                     and forecast, the order list
     Output history  the old Production tab (output by type / month / client), unchanged
     Data            upload, changes since the last upload, data checks, settings

   template.html's renderProductionTab() loads production.css, production_seed.js
   (window.PRODUCTION_SEED: Planning's weekly record from before the first upload) and
   this file the first time the tab opens, then calls Production.mount(el, host). host
   hands over the CRM's own pieces (kvGet / kvPut, profile, FX, deposits, account
   managers, the old output view), so the only global here is window.Production.

   KV -- one blob per collection (free-tier PUT limit, see CLAUDE.md):
     crm:prod_index        uploads, frozen weekly numbers, first-seen dates   1 PUT per upload
     crm:prod_snap:<date>  the raw rows of one upload                         1 PUT per upload
     crm:prod_lines        manual line states (ready / remaining / client hold), re-read and
                           merged before every write                          1 PUT per change
     crm:prod_settings     capacities, targets, rule numbers                  1 PUT per save

   Production.model has no DOM access, so every number can be checked in Node. */
(function () {
  'use strict';

  /* ================= model (pure) ================= */
  const GROUPS = ['1.Hard', '1.Hard-tablet', '2.soft', '3.Powder, Sachet, Liq', '4.liquid hard'];
  const PACK = '5.packing';
  const GSHORT = { '1.Hard': 'Hard', '1.Hard-tablet': 'Tablet', '2.soft': 'Softgel', '3.Powder, Sachet, Liq': 'Powder · liquid', '4.liquid hard': 'Liquid hard', '5.packing': 'Packing' };
  const GUNIT = { '1.Hard': 'caps', '1.Hard-tablet': 'tabs', '2.soft': 'softgels', '3.Powder, Sachet, Liq': 'units', '4.liquid hard': 'caps', '5.packing': 'bottles' };
  // The CRM's product-type colours (template.html :root --c-*); Chart.js can't read CSS vars.
  const GHEX = { '1.Hard': '#2f6b5e', '1.Hard-tablet': '#8a6a9a', '2.soft': '#4f6d8f', '3.Powder, Sachet, Liq': '#c0892f', '4.liquid hard': '#7b5577', '5.packing': '#66706a' };
  const TYPE2G = { hard: '1.Hard', tablet: '1.Hard-tablet', soft: '2.soft', powder: '3.Powder, Sachet, Liq', liquid: '3.Powder, Sachet, Liq', 'liquid hard': '4.liquid hard' };
  const STAGES = { 0: 'Cancelled', 1: 'Bulk not ordered', 2: 'Waiting for bulk', 3: 'Bulk in production', 4: 'Waiting for packing', 5: 'Packing', 6: 'Packed, to invoice', 7: 'Closed' };
  const LETTERS = [
    ['H', 'Hard capsule'], ['S', 'Softgel'], ['T', 'Tablet'], ['L', 'Liquid-filled hard'],
    ['P', 'Powder pot'], ['PS', 'Powder sachet'], ['LQ', 'Liquid'], ['PK', 'Packing only']
  ];
  const HOLD_REASONS = { design: 'Artwork / label sign-off', material: 'Client-supplied material', formula: 'Formula / ingredient sign-off', payment: 'Deposit / payment', other: 'Other' };
  const OWN_RE = /^demo (labs|outlet)(?![a-z])/i; // our own brands (Demo Labs, Demo Labs Korea, Demo Outlet)
  const REP_NAME_MAP = { 'Taylor Reid': 'Taylor Reid', 'Jamie Park': 'Jamie Park', 'Alex Kim': 'Alex Kim' }; // same as build.py
  const NEED = ['sales_order_no', 'status', 'register_date', 'confirm_date', 'client_name', 'register_name', 'product_code', 'product_name', 'require_date', 'quantity', 'currency', 'unit_price', 'item_value', 'finish_order_qty', 'finish_result_qty', 'packing_finish_date', 'bulk_type', 'bulk_code', 'bulk_order_qty', 'bulk_result_qty'];
  const DEFAULTS = {
    includeNew: false,    // count unconfirmed (new) orders in Planning numbers
    staleDays: 365,       // open lines older than this go to Data checks instead of the reports
    readyDays: 49,        // materials lead time: confirmed this long ago = ready to produce, and how long a new order takes to reach the line
    horizonDays: 30,      // gap warning looks this far past the materials lead time
    lagMonths: 3,         // orders won in month M fill the line in month M + this (new-order outlook)
    holdCandDays: 90,     // confirmed this long ago and bulk not started = ask whether it is a client hold
    packedDays: 30,       // packed this long ago and still not invoiced = stalled (out of the active backlog)
    riskDays: 30,         // delivery risk: bulk not started and due within this many days
    doneRatio: 0.95,      // a bulk / packing quantity this close to the order counts as done
    salesLeadDays: 70,    // sales forecast for lines with no required date
    workDays: 21,         // production days per month
    fx: 0,                // USD -> NZD; 0 = the CRM's monthly FX rates
    capDay: { '1.Hard': 240000, '1.Hard-tablet': 240000, '2.soft': 400000, '4.liquid hard': 160000 },
    monthCap: {}          // planned monthly capacity = monthly new-order target; blank = 12-month actual output
  };

  function isoOf(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
    if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
    const s = String(v).trim();
    if (!s || s.startsWith('0000')) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    return null;
  }
  const dnum = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
  const diff = (a, b) => dnum(b) - dnum(a);
  const addDays = (iso, n) => new Date((dnum(iso) + Math.round(n)) * 864e5).toISOString().slice(0, 10);
  const weekStart = iso => addDays(iso, -((new Date(dnum(iso) * 864e5).getUTCDay() + 6) % 7));
  const monthOf = iso => iso.slice(0, 7);
  function addMonths(ym, n) {
    let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  const num = v => (v == null || v === '' || isNaN(+v)) ? null : +v;
  const DAYS_PER_MONTH = 30.44;

  function repOf(v) {
    const s = String(v || '').trim();
    return REP_NAME_MAP[s] || s || '(none)';
  }
  function perPackOf(name) {
    const t = String(name || '').toLowerCase();
    const re = /(\d+)\s*(?:'s|’s|s\b|caps\b|tabs\b|vc\b|vcaps|softgels?|capsules|tablets|sachets)/g;
    let m, last = null;
    while ((m = re.exec(t))) last = +m[1];
    return last;
  }
  function letterOf(l) {
    const nm = l.name.toLowerCase();
    if (/packing only/.test(nm)) return 'PK';
    const t = l.btype;
    return t === 'hard' ? 'H' : t === 'soft' ? 'S' : t === 'tablet' ? 'T' : t === 'liquid hard' ? 'L' : t === 'liquid' ? 'LQ'
      : /sachet|stick/.test(nm) ? 'PS' : 'P';
  }

  // Raw oERP rows -> order lines. Throws when a needed column is missing.
  function normalize(cols, rows) {
    const ix = {};
    cols.forEach((c, i) => { ix[String(c).trim()] = i; });
    const missing = NEED.filter(c => !(c in ix));
    if (missing.length) throw new Error('Missing columns: ' + missing.join(', '));
    const G = (r, k) => r[ix[k]];
    const lines = [];
    for (const r of rows) {
      if (!r) continue;
      const so = G(r, 'sales_order_no');
      if (!so) continue;
      const code = String(G(r, 'product_code') || '').trim();
      const l = {
        so: String(so).trim(),
        status: String(G(r, 'status') || '').trim().toLowerCase(),
        reg: isoOf(G(r, 'register_date')), conf: isoOf(G(r, 'confirm_date')), req: isoOf(G(r, 'require_date')),
        client: String(G(r, 'client_name') || '').trim(), rep: repOf(G(r, 'register_name')),
        code, name: String(G(r, 'product_name') || '').trim(),
        kind: /^(OF|OB|OC)/.test(code) ? code.slice(0, 2) : 'OF',
        qty: num(G(r, 'quantity')) || 0, cur: String(G(r, 'currency') || 'NZD').trim().toUpperCase(),
        price: num(G(r, 'unit_price')) || 0, value: num(G(r, 'item_value')) || 0,
        fo: num(G(r, 'finish_order_qty')), fr: num(G(r, 'finish_result_qty')), pf: isoOf(G(r, 'packing_finish_date')),
        btype: String(G(r, 'bulk_type') || '').trim().toLowerCase(), bcode: String(G(r, 'bulk_code') || '').trim(),
        bo: num(G(r, 'bulk_order_qty')), br: num(G(r, 'bulk_result_qty'))
      };
      if (!l.reg) l.reg = l.conf;
      l.own = OWN_RE.test(l.client);
      l.group = TYPE2G[l.btype] || '3.Powder, Sachet, Liq';
      l.perPack = perPackOf(l.name);
      l.letter = letterOf(l);
      lines.push(l);
    }
    // so + code repeats when one product ships in two batches; the 2nd gets #2. The key
    // leaves out require_date on purpose: holds often move the date, and the line's
    // state must survive that.
    const seen = {};
    for (const l of lines) {
      const k = l.so + '|' + l.code;
      seen[k] = (seen[k] || 0) + 1;
      l.key = seen[k] > 1 ? k + '#' + seen[k] : k;
    }
    // Bulk quantity: one count per SO + bulk code (bulk_order_qty repeats on every line
    // sharing the bulk); otherwise packs x count per pack from the product name.
    const isOpen = s => s === 'confirm' || s === 'new';
    const covered = new Set(lines.filter(l => l.bo != null && isOpen(l.status)).map(l => l.bcode));
    const bseen = new Set();
    for (const l of lines) {
      const bk = l.so + '|' + l.bcode;
      const loose = l.btype === 'powder' || l.btype === 'liquid';
      if (l.bo != null) { const d = bseen.has(bk); l.bulkQty = d ? 0 : l.bo; l.bulkSrc = d ? 'dup' : 'order'; bseen.add(bk); }
      else if (l.kind === 'OB') { l.bulkQty = l.qty; l.bulkSrc = 'qty'; }
      else if (isOpen(l.status) && covered.has(l.bcode)) { l.bulkQty = 0; l.bulkSrc = 'shared'; }
      else if (loose) { l.bulkQty = l.qty * (/sachet/i.test(l.name) && l.perPack ? l.perPack : 1); l.bulkSrc = 'qty'; }
      else if (l.perPack) { l.bulkQty = l.qty * l.perPack; l.bulkSrc = 'name'; }
      else { l.bulkQty = 0; l.bulkSrc = 'none'; }
    }
    return lines;
  }

  function stageOf(l, done) {
    if (l.status === 'finished') return 7;
    if (l.status === 'cancel') return 0;
    const br = l.br || 0, fr = l.fr || 0;
    if (l.kind === 'OB') {
      if (l.bo == null && !br) return 1;
      if (br <= 0) return 2;
      return br < done * (l.bo || 0) ? 3 : 6;
    }
    if (l.fo != null && l.fo > 0 && fr >= done * l.fo) return 6;
    if (fr > 0) return 5;
    if (br > 0) return 4;
    if (l.bo == null && l.fo == null) return 1;
    return 2;
  }

  // When was each line first seen? From the first-seen map saved at the last upload;
  // the very first upload has none, so it uses the register date (or the confirm date
  // when the order was re-registered more than a week after confirming).
  function applyFirstSeen(lines, seen, date) {
    for (const l of lines) {
      if (seen) l.firstSeen = seen[l.key] || date;
      else l.firstSeen = (l.conf && l.reg && diff(l.conf, l.reg) > 7) ? l.conf : (l.reg || date);
    }
  }

  function mergeSettings(s) {
    s = s || {};
    return Object.assign({}, DEFAULTS, s, {
      capDay: Object.assign({}, DEFAULTS.capDay, s.capDay || {}),
      monthCap: Object.assign({}, s.monthCap || {})
    });
  }

  // host: fx(dateIso) -> NZD per USD, deposit(client, product) -> % or null, owner(client, rep) -> name
  function derive(lines, asOf, set, states, host) {
    const fx = set.fx || host.fx(asOf);
    for (const l of lines) {
      l.stage = stageOf(l, set.doneRatio);
      l.age = l.reg ? diff(l.reg, asOf) : 0;
      l.nzd = l.cur === 'USD' ? l.value * fx : l.value;
      const open = l.status === 'confirm' || (set.includeNew && l.status === 'new');
      l.isOpen = open && l.age <= set.staleDays;
      l.isBacklog = l.status === 'confirm' && l.age <= set.staleDays;
      l.stale = open && l.age > set.staleDays;
      l.packsLeft = l.kind === 'OB' ? 0 : Math.max(0, (l.fo != null ? l.fo : l.qty) - (l.fr || 0));
      l.bulkLeft = l.stage === 3 && l.bulkSrc === 'order' ? Math.max(0, (l.bo || 0) - (l.br || 0)) : l.bulkQty;
      l.preBulk = l.stage >= 1 && l.stage <= 2;
      l.confAge = diff(l.conf || l.reg || asOf, asOf);
      const st = states[l.key] || null;
      l.st = st;
      l.hold = !!st && st.s === 'hold' && l.stage >= 1 && l.stage <= 5;
      l.readyAuto = l.confAge >= set.readyDays;
      l.ready = !l.hold && (st && (st.s === 'ready' || st.s === 'remain') ? st.s === 'ready' : l.readyAuto);
      l.holdCand = !st && l.isOpen && l.preBulk && l.bulkLeft > 0 && l.confAge > set.holdCandDays;
      // packed but still not invoiced (no packing date: required date, then confirm date)
      l.packedAge = l.stage === 6 ? diff(l.pf || l.req || l.conf || l.reg || asOf, asOf) : 0;
      // stalled = not moving and not explained: Hold? candidates and long-unbilled packed lines
      l.stalled = !l.hold && (l.holdCand || l.packedAge > set.packedDays);
      const dep = host.deposit(l.client, l.name);
      l.deposit = dep == null ? 0 : dep / 100;
      l.owner = host.owner(l.client, l.rep) || l.rep;
    }
  }

  /* ---------- Planning numbers ---------- */
  function emptyM() {
    const m = {};
    for (const g of [...GROUPS, PACK]) m[g] = { nw: 0, wp: 0, rob: 0, hold: 0, wpk: 0, rof: 0 };
    return m;
  }
  // The Planning pivot for one week. 1-4 in bulk units, 5.packing in bottles.
  // Client-hold lines are counted in `hold` only, never in what the factory can make.
  function weekMetrics(lines, asOf) {
    const wk = weekStart(asOf), m = emptyM();
    for (const l of lines) {
      if (l.firstSeen && weekStart(l.firstSeen) === wk && l.status !== 'cancel') {
        m[l.group].nw += l.bulkQty;
        if (l.kind !== 'OB') m[PACK].nw += l.qty;
      }
      if (!l.isOpen) continue;
      if (l.stage >= 1 && l.stage <= 3) {
        if (l.hold) m[l.group].hold += l.bulkLeft;
        else if (l.ready || l.stage === 3) m[l.group].wp += l.bulkLeft;
        else m[l.group].rob += l.bulkLeft;
      }
      if (l.kind !== 'OB' && l.stage >= 1 && l.stage <= 5) {
        if (l.hold) m[PACK].hold += l.packsLeft;
        else {
          m[PACK].rof += l.packsLeft;
          if (l.stage === 4) m[PACK].wpk += l.packsLeft;
        }
      }
    }
    return m;
  }
  // Weeks from Planning's own record (before the first upload), weeks frozen at each
  // upload, then this week live. plog rows: [weekStart, group, wp, wpk, rob, rof, nw].
  // Weeks after Planning's record with no upload of their own get New orders from the
  // lines' first-seen dates; the other columns are a point in time nobody saved, so null.
  function weeklySeries(plog, frozen, liveWk, live, lines) {
    const map = new Map();
    for (const [wk, g, wp, wpk, rob, rof, nw] of plog || []) {
      if (!map.has(wk)) map.set(wk, { wk, m: emptyM(), computed: false });
      const e = map.get(wk).m[g];
      if (!e) continue;
      // Planning's sheet has the odd week twice; add the parts rather than overwrite
      [['wp', wp], ['wpk', wpk], ['rob', rob], ['rof', rof], ['nw', nw]].forEach(([k, v]) => { if (v != null) e[k] += v; });
    }
    for (const wk of Object.keys(frozen || {})) map.set(wk, { wk, m: frozen[wk], computed: true });
    if (live) map.set(liveWk, { wk: liveWk, m: live, computed: true, live: true });
    const lastLog = (plog || []).reduce((a, r) => (r[0] > a ? r[0] : a), '');
    if (lastLog && lines) {
      for (let wk = addDays(lastLog, 7); wk < liveWk; wk = addDays(wk, 7)) {
        if (map.has(wk)) continue;
        const m = emptyM();
        for (const g in m) m[g] = { nw: 0, wp: null, rob: null, hold: null, wpk: null, rof: null };
        map.set(wk, { wk, m, computed: true, filled: true });
      }
      for (const l of lines) {
        const w = l.firstSeen && l.status !== 'cancel' && map.get(weekStart(l.firstSeen));
        if (!w || !w.filled) continue;
        w.m[l.group].nw += l.bulkQty;
        if (l.kind !== 'OB') w.m[PACK].nw += l.qty;
      }
    }
    return [...map.values()].sort((a, b) => (a.wk < b.wk ? -1 : 1));
  }
  // New orders per month (bulk units), from the weekly series; a week belongs to the month it starts in (as Planning's pivot does).
  function monthlyIntake(series, months) {
    const out = {};
    for (const g of GROUPS) out[g] = {};
    const has = {};
    for (const w of series) {
      const m = monthOf(w.wk);
      if (months.indexOf(m) === -1) continue;
      has[m] = true;
      for (const g of GROUPS) out[g][m] = (out[g][m] || 0) + (w.m[g] ? w.m[g].nw : 0);
    }
    return { out, has };
  }
  // Orders won in month M fill the line around month M + lag (Production team, 27 Oct), so
  // each recent month's intake against the target previews that later month. The current
  // month counts what is in so far; `short` is what still has to be won to fill its month.
  function intakeOutlook(series, curM, load, lag) {
    const from = [];
    for (let i = 1 - lag; i <= 0; i++) from.push(addMonths(curM, i));
    const mi = monthlyIntake(series, from), out = [];
    for (const g of GROUPS) {
      const t = load[g].monthCap;
      if (!t) continue;
      out.push({ g, t, cells: from.map(m => {
        const c = { m, prodM: addMonths(m, lag), open: m === curM };
        if (!mi.has[m]) return c;
        c.v = mi.out[g][m] || 0; c.cover = c.v / t; c.short = Math.max(0, t - c.v); c.shortNzd = c.short * load[g].unitNzd;
        return c;
      }) });
    }
    return out;
  }
  // Average bulk output per month over the last 12 full months -- bulk_result_qty by the
  // month packing finished (bulk is made a little earlier, so this is a proxy).
  function actualOutput(lines, asOf) {
    const curM = monthOf(asOf), from = addMonths(curM, -12), seen = new Set(), sum = {};
    for (const l of lines) {
      const k = l.so + '|' + l.bcode;
      if (!(l.br > 0) || !l.pf || seen.has(k)) continue;
      seen.add(k);
      const m = monthOf(l.pf);
      if (m < from || m >= curM) continue;
      sum[l.group] = (sum[l.group] || 0) + l.br;
    }
    const avg = {};
    for (const g of GROUPS) avg[g] = (sum[g] || 0) / 12;
    return avg;
  }
  // Line load per formulation: how long the order book keeps each line busy, and what
  // has to be won (and by when) so it doesn't run dry. Orders confirmed today only reach
  // the line after the materials lead time (readyDays), so the warning has to come
  // earlier than that.
  function lineLoad(lines, asOf, set, actual) {
    const out = {};
    for (const g of GROUPS) {
      const open = lines.filter(l => l.group === g && l.isOpen && l.stage >= 1 && l.stage <= 3);
      const sum = f => open.reduce((s, l) => s + f(l), 0);
      const ready = sum(l => (!l.hold && (l.ready || l.stage === 3)) ? l.bulkLeft : 0);
      const remain = sum(l => (!l.hold && !(l.ready || l.stage === 3)) ? l.bulkLeft : 0);
      const hold = sum(l => l.hold ? l.bulkLeft : 0);
      const producible = ready + remain;
      const nominal = set.capDay[g] ? set.capDay[g] * set.workDays : null;
      // Fallbacks only for lines counted in pieces (they have a daily capacity): powder
      // output mixes pots and sachets, so it needs a planned number to get a warning.
      // Liquid hard has no bulk_result_qty in oERP at all, so it lands on nominal.
      let monthCap = null, capSrc = null;
      if (set.monthCap[g] > 0) { monthCap = set.monthCap[g]; capSrc = 'planned'; }
      else if (nominal && actual[g] > 0) { monthCap = actual[g]; capSrc = 'actual'; }
      else if (nominal) { monthCap = nominal; capSrc = 'nominal'; }
      const back = lines.filter(l => l.group === g && l.isBacklog && l.bulkQty > 0);
      const bq = back.reduce((s, l) => s + l.bulkQty, 0);
      const unitNzd = bq ? back.reduce((s, l) => s + l.nzd, 0) / bq : 0;
      const r = { g, ready, remain, hold, producible, nominal, monthCap, capSrc, actual: actual[g] || 0, unitNzd, status: 'na' };
      if (monthCap) {
        const lead = set.readyDays, horizon = set.horizonDays;
        r.runwayDays = producible / monthCap * DAYS_PER_MONTH;
        r.runOut = addDays(asOf, r.runwayDays);
        r.workDaysLeft = producible / (monthCap / set.workDays);
        r.status = r.runwayDays < lead ? 'red' : r.runwayDays < lead + horizon ? 'amber' : 'green';
        r.reachLine = addDays(asOf, lead);               // when an order confirmed today reaches the line
        r.fullUntil = addDays(asOf, lead + horizon);     // the warning horizon
        r.need = Math.max(0, monthCap * (lead + horizon) / DAYS_PER_MONTH - producible);
        r.needNzd = r.need * unitNzd;
        r.winBy = addDays(r.runOut, -lead);              // last confirm date that still reaches the line before it runs dry
        r.gapDays = Math.max(0, lead - r.runwayDays);    // idle days even if orders come in today
      }
      out[g] = r;
    }
    return out;
  }
  function onTime(lines, asOf) {
    const by = {};
    for (const l of lines) {
      if (l.status !== 'finished' || !l.pf || !l.req) continue;
      const ago = diff(l.pf, asOf);
      if (ago < 0 || ago > 365) continue;
      const g = by[l.group] || (by[l.group] = { n: 0, ok: 0, late: [], d: [] });
      const d = diff(l.req, l.pf);
      g.n++; g.d.push(d);
      if (d <= 0) g.ok++; else g.late.push(d);
    }
    return by;
  }

  /* ---------- Sales numbers ---------- */
  function salesModel(lines, asOf, set, ot) {
    const curM = monthOf(asOf);
    const shift = {};
    for (const g in ot) shift[g] = Math.max(0, median(ot[g].d) || 0);
    const back = lines.filter(l => l.isBacklog);
    for (const l of back) {
      let em;
      if (l.hold) em = 'hold';
      else if (l.stalled) em = 'stalled';
      else if (l.stage === 6) em = curM;
      else {
        const base = l.req ? addDays(l.req, shift[l.group] || 0) : addDays(l.reg || asOf, set.salesLeadDays);
        em = base < asOf ? (l.stage >= 4 ? curM : addMonths(curM, 1)) : monthOf(base);
      }
      l.expMonth = em;
      l.remain = l.nzd * (1 - (l.deposit || 0));
    }
    const months = [];
    for (let i = -12; i <= 3; i++) months.push(addMonths(curM, i));
    const actual = {}, intake = {}, fc = {};
    for (const l of lines) {
      if (l.status === 'finished') {
        const d = l.pf || l.conf;
        if (d) actual[monthOf(d)] = (actual[monthOf(d)] || 0) + l.nzd;
      }
      if (l.status !== 'cancel' && l.reg) intake[monthOf(l.reg)] = (intake[monthOf(l.reg)] || 0) + l.nzd;
    }
    let later = 0;
    const lastM = addMonths(curM, 3);
    for (const l of back) {
      if (l.expMonth === 'hold' || l.expMonth === 'stalled') continue;
      if (l.expMonth > lastM) later += l.nzd;
      else fc[l.expMonth] = (fc[l.expMonth] || 0) + l.nzd;
    }
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const past = months.slice(0, 12);
    // active = what is moving: client holds and stalled lines are shown on their own
    const active = back.filter(l => !l.hold && !l.stalled);
    const inv = active.filter(l => l.stage === 6);
    const held = back.filter(l => l.hold);
    const stalled = back.filter(l => l.stalled);
    const pipe = lines.filter(l => l.status === 'new' && l.age <= set.staleDays);
    const activeTotal = sum(active, l => l.nzd);
    return {
      curM, months, actual, intake, fc, later, shift, back, active, inv, held, stalled, pipe,
      total: sum(back, l => l.nzd), activeTotal, third: activeTotal / 3,
      remain: sum(active, l => l.remain),
      invTotal: sum(inv, l => l.nzd),
      heldTotal: sum(held, l => l.nzd),
      stalledTotal: sum(stalled, l => l.nzd),
      pipeTotal: sum(pipe, l => l.nzd),
      avg12: sum(past, m => actual[m] || 0) / 12
    };
  }
  function byLetter(back) {
    const rows = {};
    for (const [L] of LETTERS) rows[L] = { lines: 0, packs: 0, bulk: 0, value: 0, ofValue: 0 };
    for (const l of back) {
      const r = rows[l.letter] || (rows[l.letter] = { lines: 0, packs: 0, bulk: 0, value: 0, ofValue: 0 });
      r.lines++; r.bulk += l.bulkQty; r.value += l.nzd;
      if (l.kind !== 'OB') { r.packs += l.qty; r.ofValue += l.nzd; }
    }
    return rows;
  }

  /* ---------- Data checks ---------- */
  function checks(lines) {
    return {
      staleConfirm: lines.filter(l => l.stale && l.status === 'confirm'),
      staleNew: lines.filter(l => l.stale && l.status === 'new'),
      zeroValue: lines.filter(l => l.isBacklog && !l.nzd),
      packedOld: lines.filter(l => l.isBacklog && l.stalled && !l.holdCand),
      bulkGuess: lines.filter(l => l.isOpen && (l.bulkSrc === 'name' || l.bulkSrc === 'none')),
      finNoPf: lines.filter(l => l.status === 'finished' && !l.pf)
    };
  }
  function diffLines(prev, cur, done) {
    const out = { added: [], finished: [], cancelled: [], changed: [], removed: [] };
    if (!prev) return out;
    const pm = new Map(prev.map(l => [l.key, l])), cm = new Set(cur.map(l => l.key));
    for (const l of cur) {
      const p = pm.get(l.key);
      if (!p) { out.added.push(l); continue; }
      if (p.status !== l.status) {
        if (l.status === 'finished') out.finished.push(l);
        else if (l.status === 'cancel') out.cancelled.push(l);
        else out.changed.push({ l, what: 'Status ' + p.status + ' → ' + l.status });
        continue;
      }
      const ch = [];
      if (p.qty !== l.qty) ch.push('Qty ' + p.qty + ' → ' + l.qty);
      if (p.req !== l.req) ch.push('Required ' + (p.req || '–') + ' → ' + (l.req || '–'));
      if (p.price !== l.price) ch.push('Price ' + p.price + ' → ' + l.price);
      const ps = stageOf(p, done), cs = stageOf(l, done);
      if (ps !== cs) ch.push(STAGES[ps] + ' → ' + STAGES[cs]);
      if (ch.length) out.changed.push({ l, what: ch.join(' · ') });
    }
    for (const p of prev) if (!cm.has(p.key)) out.removed.push(p);
    return out;
  }

  // Everything the views need, from one snapshot.
  function build(snap, idx, states, setRaw, host, plog) {
    const set = mergeSettings(setRaw);
    const asOf = snap.date;
    const lines = normalize(snap.cols, snap.rows);
    applyFirstSeen(lines, idx && idx.seen, asOf);
    derive(lines, asOf, set, states || {}, host);
    const week = weekMetrics(lines, asOf);
    const actual = actualOutput(lines, asOf);
    const ot = onTime(lines, asOf);
    return {
      asOf, set, lines, week, actual, ot,
      load: lineLoad(lines, asOf, set, actual),
      series: weeklySeries(plog, idx && idx.weekly, weekStart(asOf), week, lines),
      sales: salesModel(lines, asOf, set, ot)
    };
  }

  const model = {
    GROUPS, PACK, GSHORT, GUNIT, STAGES, LETTERS, HOLD_REASONS, DEFAULTS,
    isoOf, diff, addDays, addMonths, weekStart, monthOf, median,
    normalize, stageOf, applyFirstSeen, mergeSettings, derive, weekMetrics, weeklySeries, monthlyIntake, intakeOutlook,
    actualOutput, lineLoad, onTime, salesModel, byLetter, checks, diffLines, build
  };

  /* ================= view ================= */
  const K = { index: 'crm:prod_index', lines: 'crm:prod_lines', settings: 'crm:prod_settings', notes: 'crm:prod_notes', snap: d => 'crm:prod_snap:' + d };
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const VIEW_KEY = 'pd_view', LANG_KEY = 'pd_lang';
  const VIEWS = [['production', 'precision_manufacturing', 'Production', '생산'], ['sales', 'payments', 'Sales', '영업'], ['history', 'bar_chart', 'Output history', '생산 실적'], ['data', 'database', 'Data', '데이터·설정']];

  let H = null, root = null, R = null;
  const S = { idx: null, snap: null, states: {}, notes: {}, setRaw: null, view: 'production', lang: 'en', upload: null, edit: null, charts: {}, busy: false };
  const UI = { metric: 'nw', range: 26, rg: 'all', rs: 'pre', rf: 'all', rq: '', sOwner: 'all', sLetter: 'all', sStage: 'all', sQuery: '', noOwn: false };

  // Korean first -- the Production team reads it more easily -- with an EN switch in the tab
  // header (remembered per browser). Line names, Ready / Remaining / Client hold, Planning's
  // pivot column names, dates and amounts stay in English on purpose.
  const T = (en, ko) => S.lang === 'en' ? en : ko;
  const STAGES_KO = { 0: '취소', 1: '벌크 오더 전', 2: '벌크 생산 대기', 3: '벌크 생산 중', 4: '포장 대기', 5: '포장 중', 6: '포장 완료·인보이스 대기', 7: '종결' };
  const HOLD_REASONS_KO = { design: '디자인·라벨 컨펌', material: '고객 공급 자재', formula: '성분·배합 컨펌', payment: '디파짓·결제', other: '기타' };
  const stg = k => T(STAGES[k], STAGES_KO[k]);
  const reason = k => k && HOLD_REASONS[k] ? T(HOLD_REASONS[k], HOLD_REASONS_KO[k]) : 'Client hold';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = sel => root.querySelector(sel);
  const fmt = n => n == null || isNaN(n) ? '–' : Math.round(n).toLocaleString('en-NZ');
  const qs = n => { if (n == null || isNaN(n)) return '–'; const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M' : a >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n)); };
  const money = n => 'NZD ' + qs(n);
  const pct = x => Math.round(x * 100) + '%';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dShort = iso => iso ? (+iso.slice(8, 10)) + ' ' + MON[+iso.slice(5, 7) - 1] : '–';
  const dLong = iso => iso ? dShort(iso) + ' ' + iso.slice(0, 4) : '–';
  const mLabel = ym => ym; // 2026-10, never 'Oct 26' (reads as a day)
  const dIso = iso => iso || '–'; // table cells: 2026-09-29
  const dSay = iso => iso && R && iso.slice(0, 4) !== R.asOf.slice(0, 4) ? dLong(iso) : dShort(iso); // sentences: year only when it isn't this year's
  const unitPrice = l => l.price ? (l.cur !== 'NZD' ? l.cur + ' ' : '') + (l.price < 1 ? +l.price.toFixed(4) : l.price.toFixed(2)) : '–';
  const gdot = g => '<span class="pd-dot" style="background:' + GHEX[g] + '"></span>';
  const gname = g => gdot(g) + esc(GSHORT[g]);
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const who = () => (H.user && H.user()) || '';
  const months = n => n < 1 ? Math.round(n * DAYS_PER_MONTH / 7) + T(' wks', '주') : n.toFixed(1) + T(' mo', '개월');
  const nLines = n => T(n + ' line' + (n === 1 ? '' : 's'), n + '라인');
  const nDays = n => T(n + ' days', n + '일');
  // host.views() may narrow the views for a role (the Production team has no Sales view)
  const allowedViews = () => { const v = H && H.views ? H.views() : null; return v ? VIEWS.filter(x => v.indexOf(x[0]) !== -1) : VIEWS; };
  const STATUS_BADGE = { red: ['s-cancel', 'Gap risk', '공백 위험'], amber: ['s-new', 'Win more', '수주 필요'], green: ['s-finished', 'Booked', '충분'], na: ['', 'No capacity set', '캐파 미설정'] };
  const badge = (cls, txt) => '<span class="badge ' + cls + '">' + esc(txt) + '</span>';
  const sbadge = st => { const b = STATUS_BADGE[st]; return badge(b[0], T(b[1], b[2])); };
  // achievement pill: green from 100%, amber from 70%
  const ach = (p, title, label) => '<span class="pd-ach pd-ach--' + (p >= 1 ? 'ok' : p >= 0.7 ? 'mid' : 'low') + '" title="' + esc(title) + '">' + label + ' <small>' + pct(p) + '</small></span>';
  const SEARCH_PH = () => T('SO, client, product', 'SO, 고객, 제품');

  function card(title, hint, body, opts) {
    opts = opts || {};
    return '<section class="pd-card' + (opts.cls ? ' ' + opts.cls : '') + '"' + (opts.id ? ' id="' + opts.id + '"' : '') + '>' +
      '<div class="pd-card__head"><h3 class="pd-card__title">' + title + '</h3>' + (opts.ctl ? '<div class="pd-ctl">' + opts.ctl + '</div>' : '') + '</div>' +
      (hint ? '<div class="pd-hint">' + hint + '</div>' : '') + body + '</section>';
  }
  function table(head, rows, opts) {
    opts = opts || {};
    return '<div class="table-wrap pd-tw' + (opts.tall ? ' pd-tw--tall' : '') + '"><table class="pd-table"><thead><tr>' +
      head.map(h => '<th' + (h.num ? ' class="num"' : '') + '>' + h.t + '</th>').join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.join('') : '<tr><td colspan="' + head.length + '" class="pd-none">' + (opts.empty || T('Nothing to show.', '표시할 항목이 없습니다.')) + '</td></tr>') +
      '</tbody></table></div>';
  }
  const H_ = (t, num) => ({ t, num });

  /* ---------- load / save ---------- */
  async function load() {
    const [idx, states, set, notes] = await Promise.all([H.kvGet(K.index), H.kvGet(K.lines), H.kvGet(K.settings), H.kvGet(K.notes)]);
    S.notes = notes && typeof notes === 'object' ? notes : {};
    S.idx = idx && Array.isArray(idx.snaps) ? idx : { snaps: [], weekly: {}, seen: null, current: null };
    S.states = states && typeof states === 'object' ? states : {};
    S.setRaw = set && typeof set === 'object' ? set : {};
    S.snap = S.idx.current ? await H.kvGet(K.snap(S.idx.current)) : null;
    recompute();
  }
  function recompute() {
    R = null;
    if (!S.snap) return;
    try { R = build(S.snap, S.idx, S.states, S.setRaw, H, (window.PRODUCTION_SEED || {}).plog); }
    catch (e) { R = null; S.err = e.message; }
  }
  // Line states: re-read, change one line, write back -- two people can edit at once.
  async function saveState(key, val) {
    const cur = (await H.kvGet(K.lines)) || {};
    if (val) cur[key] = val; else delete cur[key];
    S.states = cur;
    await H.kvPut(K.lines, cur);
    recompute(); render();
  }
  async function setLineState(key, s, extra) {
    const prev = S.states[key] || null, now = today();
    let val;
    if (!s) val = null;
    else val = Object.assign({}, prev && prev.s === s ? prev : {}, { s, by: who() || (prev && prev.by) || '', at: new Date().toISOString() }, extra || {});
    // keep each finished hold (from-to) so Delays can later count client days
    const hist = (prev && prev.hist) || [];
    if (prev && prev.s === 'hold' && (!val || val.s !== 'hold')) hist.push({ from: prev.since, to: now, reason: prev.reason, by: prev.by });
    if (val && hist.length) val.hist = hist;
    if (!val && hist.length) val = { hist };
    await saveState(key, val);
  }

  /* ---------- shell ---------- */
  function mount(el, host) {
    H = host; root = el;
    el.classList.add('pd');
    try {
      S.view = localStorage.getItem(VIEW_KEY) || 'production';
      S.lang = 'en';
    } catch (e) { /* private mode */ }
    if (!VIEWS.some(v => v[0] === S.view)) S.view = 'production';
    el.innerHTML = '<div class="pd-head" id="pd-head"></div><div id="pd-banner"></div>' +
      VIEWS.map(v => '<section class="pd-view" data-pd-pane="' + v[0] + '"></section>').join('');
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    renderHead();
    el.querySelector('[data-pd-pane="' + S.view + '"]').innerHTML = '<div class="empty">Loading…</div>';
    el.querySelector('[data-pd-pane="' + S.view + '"]').classList.add('active');
    load().then(render).catch(e => { el.querySelector('#pd-banner').innerHTML = '<div class="pd-alert pd-alert--red">' + T('Could not load the production data: ', '생산 데이터를 불러오지 못했습니다: ') + esc(e.message) + '</div>'; });
  }
  function renderHead() {
    const last = S.idx && S.idx.snaps.find(s => s.date === S.idx.current);
    const src = R ? T('Data as of <b>' + dLong(R.asOf) + '</b>', '<b>' + dLong(R.asOf) + '</b> 기준') + ' · ' + esc(last ? last.file : '') +
      (last && last.by ? T(' · uploaded by ', ' · 업로드 ') + esc(last.by) : '') + ' · <button type="button" class="pd-link" data-pd-view="data">' + T('update', '업데이트') + '</button>'
      : S.idx ? T('No mother data yet', '아직 데이터 없음') : '';
    $('#pd-head').innerHTML = '<div><div class="pd-eyebrow">' + T('Operations · one mother data set', 'Operations · mother data 하나로') + '</div>' +
      '<h2 class="pd-title">' + (allowedViews().some(v => v[0] === 'sales') ? T('Production &amp; sales report', '생산·매출 리포트') : T('Production report', '생산 리포트')) + '</h2><div class="pd-sub">' + src + '</div></div>' +
      '<div class="pd-headctl"><div class="seg" id="pd-views">' + allowedViews().map(v => '<button type="button" data-pd-view="' + v[0] + '"' + (v[0] === S.view ? ' class="active"' : '') + '><span class="icon icon--inline">' + v[1] + '</span>' + T(v[2], v[3]) + '</button>').join('') + '</div>' +
      '</div>';
  }
  function render() {
    const av = allowedViews();
    if (!av.some(v => v[0] === S.view)) S.view = av[0][0];
    renderHead();
    root.querySelectorAll('.pd-view').forEach(p => p.classList.toggle('active', p.dataset.pdPane === S.view));
    $('#pd-banner').innerHTML = !R ? '<div class="pd-alert pd-alert--amber">' + (S.err ? T('The saved upload could not be read (' + esc(S.err) + '). ', '저장된 업로드를 읽지 못했습니다 (' + esc(S.err) + '). ') : '') +
      T('Upload the latest oERP export (Sales_statistics.xlsx) in <button type="button" class="pd-link" data-pd-view="data">Data</button> to start.',
        '<button type="button" class="pd-link" data-pd-view="data">데이터·설정</button>에서 최신 oERP 파일(Sales_statistics.xlsx)을 올리면 시작됩니다.') + '</div>' : '';
    Object.values(S.charts).forEach(c => { try { c.destroy(); } catch (e) { /* already gone */ } });
    S.charts = {};
    const pane = root.querySelector('[data-pd-pane="' + S.view + '"]');
    if (S.view === 'data') return renderData(pane);
    if (S.view === 'history') return renderHistory(pane);
    if (!R) { pane.innerHTML = ''; return; }
    if (S.view === 'production') renderProduction(pane);
    else renderSales(pane);
  }

  /* ---------- Production view ---------- */
  function gapSentence(r, forSales) {
    const g = GSHORT[r.g], amt = '<b>' + qs(r.need) + ' ' + GUNIT[r.g] + '</b> (≈ ' + money(r.needNzd) + ')';
    const runway = months(r.runwayDays / DAYS_PER_MONTH);
    if (r.status === 'red') return T(
      '<b>' + g + '</b> — order book runs out around <b>' + dSay(r.runOut) + '</b> (' + runway + '). Orders confirmed today reach the line around ' + dSay(r.reachLine) +
        ', so the line sits idle for about <b>' + Math.round(r.gapDays) + ' days</b>. ' + (forSales ? 'Chase client holds and ask clients to bring orders forward; ' : 'Pull orders forward and release client holds; ') +
        'win ' + amt + ' to keep it full to ' + dSay(r.fullUntil) + '.',
      '<b>' + g + '</b> — 확정 오더가 <b>' + dSay(r.runOut) + '</b>경 바닥(' + runway + '). 오늘 확정한 오더는 ' + dSay(r.reachLine) + '경에야 라인에 올라와 약 <b>' + Math.round(r.gapDays) + '일</b> 라인이 빕니다. ' +
        (forSales ? 'Client hold 팔로업과 고객사 오더 앞당기기를 요청하고, ' : '오더 앞당기기와 Client hold 해제를 챙기고, ') + dSay(r.fullUntil) + '까지 채우려면 ' + amt + '를 더 수주해야 합니다.');
    if (r.status === 'amber') return T(
      '<b>' + g + '</b> — booked to about <b>' + dSay(r.runOut) + '</b> (' + runway + '). Win ' + amt + ', confirmed by <b>' + dSay(r.winBy) + '</b>, to keep the line full to ' + dSay(r.fullUntil) + '.',
      '<b>' + g + '</b> — 확정 오더로 <b>' + dSay(r.runOut) + '</b>경까지 가동(' + runway + '). ' + dSay(r.fullUntil) + '까지 라인을 채우려면 ' + amt + '를 <b>' + dSay(r.winBy) + '</b>까지 확정받아야 합니다.');
    return '';
  }
  const capCaveat = r => r.capSrc === 'planned' ? '' : ' <span class="pd-dim">(' + T(capNote(r).toLowerCase() + ' — until Planning sets a planned capacity', capNote(r) + ' 기준 — Planning이 계획 캐파를 넣기 전까지') + ')</span>';
  function gapAlerts(forSales) {
    const rows = GROUPS.map(g => R.load[g]).filter(r => r.status === 'red' || r.status === 'amber')
      .sort((a, b) => a.runwayDays - b.runwayDays);
    const until = dSay(addDays(R.asOf, R.set.readyDays + R.set.horizonDays));
    if (!rows.length) return '<div class="pd-alert pd-alert--ok">' + T('Every line with a capacity is booked past ' + until + '.', '캐파가 있는 모든 라인이 ' + until + ' 이후까지 차 있습니다.') + '</div>';
    return rows.map(r => '<div class="pd-alert pd-alert--' + r.status + '"><span class="icon">' + (r.status === 'red' ? 'error' : 'warning') + '</span><div>' + gapSentence(r, forSales) + capCaveat(r) + '</div></div>').join('');
  }
  function capNote(r) {
    if (!r.monthCap) return T('No capacity set', '캐파 미설정');
    return { planned: T('Planned capacity', '계획 캐파'), actual: T('12-mo actual output', '12개월 실제 생산'), nominal: T('Nominal capacity', '명목 캐파') }[r.capSrc] + ' ' + qs(r.monthCap) + T('/mo', '/월');
  }
  function renderProduction(pane) {
    const m = R.week, set = R.set;
    let tiles = '';
    for (const g of GROUPS) {
      const r = R.load[g], tot = r.ready + r.remain;
      tiles += '<div class="pd-tile pd-tile--' + r.status + '"><div class="pd-tile__lb">' + gname(g) + (r.status !== 'na' ? sbadge(r.status) : '') + '</div>' +
        '<div class="pd-tile__big">' + qs(tot) + '<small>' + GUNIT[g] + '</small></div>' +
        '<div class="pd-split" title="Ready / Remaining"><span style="width:' + (tot ? r.ready / tot * 100 : 0).toFixed(1) + '%"></span></div>' +
        '<div class="pd-tile__sm">Ready ' + qs(r.ready) + ' · Remaining ' + qs(r.remain) + '</div>' +
        (r.hold ? '<div class="pd-tile__sm pd-warn">+ ' + qs(r.hold) + T(' on client hold (not counted)', ' Client hold (제외)') + '</div>' : '') +
        '<div class="pd-tile__sm">' + (r.monthCap ? T('Booked to <b>' + dSay(r.runOut) + '</b>', '<b>' + dSay(r.runOut) + '</b>까지 가동') + ' · ' + months(r.runwayDays / DAYS_PER_MONTH) : '–') + '</div>' +
        '<div class="pd-tile__cap">' + capNote(r) + '</div></div>';
    }
    tiles += '<div class="pd-tile"><div class="pd-tile__lb">' + gname(PACK) + '</div><div class="pd-tile__big">' + qs(m[PACK].rof) + '<small>bottles</small></div>' +
      '<div class="pd-split"><span style="width:' + (m[PACK].rof ? m[PACK].wpk / m[PACK].rof * 100 : 0).toFixed(1) + '%"></span></div>' +
      '<div class="pd-tile__sm">Waiting for packing ' + qs(m[PACK].wpk) + '</div>' +
      (m[PACK].hold ? '<div class="pd-tile__sm pd-warn">+ ' + qs(m[PACK].hold) + ' Client hold</div>' : '') + '<div class="pd-tile__cap">' + T('Bulk done, packing left', '벌크 완료, 포장 남음') + '</div></div>';

    // monthly new orders vs target
    const curM = monthOf(R.asOf), mlist = [];
    for (let i = -5; i <= 0; i++) mlist.push(addMonths(curM, i));
    const mi = monthlyIntake(R.series, mlist);
    // the current month is compared with the share of the target due by the data date (27 Oct = 27/31)
    const day = +R.asOf.slice(8, 10), dim = new Date(Date.UTC(+curM.slice(0, 4), +curM.slice(5, 7), 0)).getUTCDate();
    const elapsed = Math.min(1, day / dim), elapsedTxt = (elapsed * 100).toFixed(1) + '%';
    const tRows = GROUPS.filter(g => R.load[g].monthCap).map(g => {
      const t = R.load[g].monthCap;
      return '<tr><td class="pd-nowrap">' + gname(g) + '</td><td class="num">' + qs(t) + '</td>' + mlist.map(mm => {
        if (!mi.has[mm]) return '<td class="num pd-dim">–</td>';
        const v = mi.out[g][mm] || 0, tt = mm === curM ? t * elapsed : t;
        return '<td class="num">' + ach(v / tt, fmt(v) + ' / ' + fmt(tt) + (mm === curM ? T(' (target to ' + dShort(R.asOf) + ')', ' (' + dShort(R.asOf) + '까지 목표)') : ''), qs(v)) + '</td>';
      }).join('') + '</tr>';
    });
    const intakeCard = card('<span class="icon icon--inline">flag</span>' + T('New orders vs monthly target', '월 신규오더 vs 목표'),
      T('Target = each line\'s monthly capacity (set in Data › Settings). ' + mLabel(curM) + ' runs to the data date, ' + dShort(R.asOf) + ', so it is compared with ' + day + '/' + dim + ' = <b>' + elapsedTxt + '</b> of the target. A week counts in the month it starts, as in Planning\'s pivot.',
        '목표 = 라인별 월 캐파(데이터·설정 › 설정). ' + mLabel(curM) + '은 데이터 기준일(' + dShort(R.asOf) + ')까지 누적이라 목표의 ' + day + '/' + dim + ' = <b>' + elapsedTxt + '</b>와 비교합니다. 주는 시작한 달에 넣습니다(Planning 피벗과 같음).'),
      table([H_(T('Line', '라인')), H_(T('Target / mo', '목표/월'), 1)].concat(mlist.map(mm => H_(mLabel(mm) + (mm === curM ? T(' (to ' + day + '/' + dim + ')', ' (누적 ' + day + '/' + dim + '일)') : ''), 1))), tRows));

    // new-order outlook: this and the last months' intake -> the line `lagMonths` later
    const lag = set.lagMonths || 3, ol = intakeOutlook(R.series, curM, R.load, lag);
    const olRows = ol.map(o => '<tr><td class="pd-nowrap">' + gname(o.g) + '</td><td class="num">' + qs(o.t) + '</td>' + o.cells.map(c => {
      if (c.v == null) return '<td class="num pd-dim">–</td>';
      return '<td class="num">' + ach(c.cover, fmt(c.v) + ' / ' + fmt(o.t), qs(c.v)) +
        '<div class="pd-olsub">' + (c.short ? (c.open ? T('win ', '더 수주 ') : T('short ', '부족 ')) + '<b>' + qs(c.short) + '</b> ' + GUNIT[o.g] + (c.shortNzd ? ' <span class="pd-dim">≈ ' + money(c.shortNzd) + '</span>' : '') : T('full', '충분')) + '</div></td>';
    }).join('') + '</tr>');
    const olCard = card('<span class="icon icon--inline">event_upcoming</span>' + T('Line outlook from new orders · ' + lag + ' months ahead', '신규오더로 본 ' + lag + '개월 뒤 라인'),
      T('Orders won in a month reach the line about ' + lag + ' months later, so each month\'s new orders against the target preview that later month: under 100% means the line will be short then unless other orders fill it. ' + mLabel(curM) + ' is still open — "win" is what still has to come in this month to fill ' + mLabel(addMonths(curM, lag)) + '. NZD at each line\'s average backlog price. The gap warnings above use the actual confirmed backlog instead.',
        '한 달에 딴 오더는 약 ' + lag + '개월 뒤 라인에 올라오므로, 월 신규오더를 목표와 비교하면 그때 라인이 얼마나 찰지 미리 보입니다. 100% 미만이면 다른 오더로 채우지 않는 한 그달 라인이 빕니다. ' + mLabel(curM) + '은 진행 중이라 "더 수주"는 ' + mLabel(addMonths(curM, lag)) + '을 채우려면 이번 달에 더 따야 할 양입니다. 금액은 라인별 평균 단가로 환산. 위의 공백 경고는 실제 확정 잔고 기준입니다.'),
      table([H_(T('Line', '라인')), H_(T('Target / mo', '목표/월'), 1)].concat(ol.length ? ol[0].cells.map(c => H_('<b>' + mLabel(c.prodM) + '</b><br><span class="pd-dim">← ' + mLabel(c.m) + T(' orders', ' 수주') + (c.open ? T(' (so far)', ' (진행 중)') : '') + '</span>', 1)) : []), olRows,
        { empty: T('Set a capacity in Data › Settings first.', '데이터·설정에서 캐파를 먼저 넣어 주세요.') }));

    // weekly status table (Planning's pivot + client hold)
    let rows = '';
    for (const g of [...GROUPS, PACK]) {
      const isP = g === PACK, r = R.load[g], x = m[g];
      const days = !isP && r.monthCap ? (x.wp + x.rob) / (r.monthCap / set.workDays) : null;
      rows += '<tr><td class="pd-nowrap">' + gname(g) + ' <span class="pd-dim">' + GUNIT[g] + '</span></td><td class="num">' + fmt(x.nw) + '</td>' +
        '<td class="num">' + (isP ? '–' : fmt(x.wp)) + '</td><td class="num">' + (isP ? '–' : fmt(x.rob)) + '</td>' +
        '<td class="num">' + (isP ? '–' : fmt(x.hold)) + '</td>' +
        '<td class="num">' + (isP ? fmt(x.wpk) : '–') + '</td><td class="num">' + (isP ? fmt(x.rof) : '–') + '</td><td class="num">' + (isP ? fmt(x.hold) : '–') + '</td>' +
        '<td class="num">' + (days != null ? days.toFixed(1) : '–') + '</td></tr>';
    }
    const wk = weekStart(R.asOf);
    const statusCard = card('<span class="icon icon--inline">table_chart</span>' + T('Production status · week of ' + dShort(wk), '생산대기 현황 · ' + dShort(wk) + ' 주'),
      T('Same layout as Planning\'s pivot. Client hold is split out and left out of the backlog. Backlog days = (Waiting + Remaining) ÷ (monthly capacity ÷ ' + set.workDays + ' production days).',
        'Planning 피벗과 같은 구성입니다. Client hold는 따로 빼고 잔량에서도 뺍니다. 밀린 생산일수 = (Waiting + Remaining) ÷ (월 캐파 ÷ ' + set.workDays + ' 생산일).'),
      table([H_(T('Line', '라인')), H_('New orders', 1), H_('Waiting for production', 1), H_('Remaining – OB', 1), H_('Client hold – bulk', 1), H_('Waiting for packing', 1), H_('Remaining – OF', 1), H_('Client hold – packing', 1), H_(T('Backlog days', '밀린 생산일수'), 1)], [rows]));

    const METRICS = { nw: 'New orders', wp: 'Waiting for production', rob: 'Remaining – OB', all: T('To produce (Waiting + Remaining)', '미생산 합계 (Waiting + Remaining)'), hold: 'Client hold – bulk', wpk: 'Waiting for packing', rof: 'Remaining – OF' };
    const weeklyCard = card('<span class="icon icon--inline">stacked_bar_chart</span>' + T('Weekly record', '주간 기록'),
      T('Weeks up to the first upload come from Planning\'s sheet; later weeks are saved at each upload, and this week is live.', '첫 업로드 이전 주는 Planning 시트 기록, 이후는 업로드할 때마다 저장되고 이번 주는 실시간입니다.'),
      '<div class="pd-chart"><canvas id="pd-wkChart" height="240"></canvas></div><details class="pd-details"><summary>' + T('Table', '표') + '</summary><div id="pd-wkTable"></div></details>',
      { ctl: '<select class="select select--sm" data-pd-ui="metric">' + Object.entries(METRICS).map(([k, n]) => '<option value="' + k + '"' + (UI.metric === k ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>' +
        '<select class="select select--sm" data-pd-ui="range" data-num="1">' + [12, 26, 52].map(n => '<option value="' + n + '"' + (UI.range === n ? ' selected' : '') + '>' + T('Last ' + n + ' weeks', '최근 ' + n + '주') + '</option>').join('') + '</select>' });

    // delivery risk (factory side) -- client holds are listed under Sales instead
    const riskAll = R.lines.filter(l => l.isOpen && l.preBulk && l.bulkLeft > 0 && l.req && diff(R.asOf, l.req) <= set.riskDays);
    const risk = riskAll.filter(l => !l.hold).sort((a, b) => (a.req < b.req ? -1 : 1));
    const heldOut = riskAll.length - risk.length;
    const riskRows = risk.slice(0, 80).map(l => {
      const d = diff(R.asOf, l.req);
      return '<tr><td class="mono pd-nowrap">' + dIso(l.req) + ' ' + (d < 0 ? badge('s-cancel', T((-d) + ' d late', (-d) + '일 지남')) : badge('s-new', 'D-' + d)) + '</td>' +
        '<td class="mono">' + esc(l.so) + '</td><td class="pd-cl">' + esc(l.client) + '</td><td class="pd-nowrap">' + gname(l.group) + '</td><td class="num">' + fmt(l.bulkLeft) + '</td>' +
        '<td>' + (l.ready ? '<span class="tag tag--new">Ready</span>' : '<span class="tag">Remaining</span>') + (l.holdCand ? ' <span class="tag pd-tag-cand" title="' + T('Confirmed ' + l.confAge + ' days ago, bulk not started', '확정 후 ' + l.confAge + '일, 벌크 미착수') + '">Hold?</span>' : '') + '</td></tr>';
    });
    const riskCard = card('<span class="icon icon--inline">schedule</span>' + T('Delivery risk · factory', '납기 위험 · 공장') + ' ' + badge('s-cancel', nLines(risk.length)),
      T('Bulk not started and due within ' + set.riskDays + ' days, or already late.', '벌크 생산 전인데 납기가 ' + set.riskDays + '일 안이거나 이미 지난 라인.') +
        (heldOut ? T(' <b>' + heldOut + '</b> client-hold line' + (heldOut > 1 ? 's are' : ' is') + ' left out (Sales › Client hold).', ' Client hold <b>' + heldOut + '</b>라인은 뺐습니다(영업 › Client hold).') : ''),
      table([H_(T('Required', '납기')), H_('SO'), H_(T('Client', '고객')), H_(T('Line', '라인')), H_(T('Bulk', '벌크'), 1), H_(T('State', '상태'))], riskRows, { tall: 1, empty: T('No lines at risk.', '위험 라인이 없습니다.') }));

    const otRows = [];
    for (const g of GROUPS) {
      const o = R.ot[g];
      otRows.push('<tr><td class="pd-nowrap">' + gname(g) + '</td><td class="num">' + (o ? o.n : 0) + '</td><td class="num">' + (o ? pct(o.ok / o.n) : '–') + '</td><td class="num">' + (o && o.late.length ? nDays(Math.round(median(o.late))) : '–') + '</td></tr>');
    }
    const otCard = card('<span class="icon icon--inline">verified</span>' + T('On time · last 12 months', '납기 준수 · 최근 12개월'),
      T('Packed on or before the required date. Late lines get their reasons in the Delays tab.', '포장 완료일이 납기 이내인 비율. 늦은 건의 사유는 Delays 탭에서 다룹니다.'),
      table([H_(T('Line', '라인')), H_(T('Finished lines', '완료 라인'), 1), H_(T('On time', '납기 내'), 1), H_(T('Median days late', '지연 중앙값'), 1)], otRows));

    pane.innerHTML =
      card('<span class="icon icon--inline">notifications_active</span>' + T('Line gap warnings', '라인 공백 경고'),
        T('How long confirmed orders keep each line busy. Orders confirmed today reach the line after about ' + set.readyDays + ' days (materials), so a line booked for less than that will run dry whatever Sales wins now.',
          '확정 오더로 라인이 언제까지 돌아가는지 보여줍니다. 오늘 확정한 오더도 자재 때문에 약 ' + set.readyDays + '일 뒤에야 라인에 올라오므로, 그보다 짧게 남은 라인은 지금 수주해도 비게 됩니다.'), gapAlerts(false)) +
      '<div class="pd-tiles">' + tiles + '</div>' +
      intakeCard + olCard + statusCard + weeklyCard +
      card('<span class="icon icon--inline">fact_check</span>' + T('Readiness &amp; client hold', '생산 준비 · Client hold'),
        T('Every open line. <b>Ready</b> = materials in, can be scheduled. <b>Remaining</b> = waiting on our side (materials, planning). <b>Client hold</b> = waiting on the client (artwork, client-supplied material, formula sign-off, deposit) — left out of the backlog and the factory delivery risk, and listed for Sales to chase. Lines you haven\'t set are Ready ' + set.readyDays + ' days after confirmation. <span class="tag pd-tag-cand">Hold?</span> = confirmed over ' + set.holdCandDays + ' days ago and bulk not started. <b>To set a client hold</b>: the Client hold button in State, or "set client hold" next to Hold? — then the reason, since date and a note for Sales.',
          '진행 중인 모든 라인입니다. <b>Ready</b> = 자재 입고, 생산 일정 가능. <b>Remaining</b> = 우리 쪽 대기(자재·계획). <b>Client hold</b> = 고객 쪽 대기(디자인·고객 공급 자재·성분 컨펌·디파짓) — 잔량과 공장 납기 위험에서 빠지고 영업 팔로업 목록으로 갑니다. 손대지 않은 라인은 확정 ' + set.readyDays + '일 후 자동으로 Ready입니다. <span class="tag pd-tag-cand">Hold?</span> = 확정 후 ' + set.holdCandDays + '일이 넘었는데 벌크 미착수. <b>Client hold 입력</b>: 상태 열의 Client hold 버튼, 또는 Hold? 옆 "Client hold 입력" → 사유·시작일·영업팀 메모.'),
        '<div class="pd-filters">' +
        '<select class="select select--sm" data-pd-ui="rg"><option value="all">' + T('All lines', '전체 라인') + '</option>' + GROUPS.map(g => '<option value="' + g + '"' + (UI.rg === g ? ' selected' : '') + '>' + GSHORT[g] + '</option>').join('') + '</select>' +
        '<select class="select select--sm" data-pd-ui="rs">' + [['pre', 'Before bulk', '벌크 전'], ['bulk', 'Bulk in production', '벌크 생산 중'], ['pack', 'Packing', '포장'], ['open', 'All open', '전체 진행']].map(([k, en, ko]) => '<option value="' + k + '"' + (UI.rs === k ? ' selected' : '') + '>' + T(en, ko) + '</option>').join('') + '</select>' +
        '<select class="select select--sm" data-pd-ui="rf">' + [['all', 'Any state', '전체 상태'], ['ready', 'Ready', 'Ready'], ['remain', 'Remaining', 'Remaining'], ['hold', 'Client hold', 'Client hold'], ['cand', 'Hold? (to review)', 'Hold? (검토 필요)'], ['manual', 'Set by hand', '수동 지정']].map(([k, en, ko]) => '<option value="' + k + '"' + (UI.rf === k ? ' selected' : '') + '>' + T(en, ko) + '</option>').join('') + '</select>' +
        '<input class="input input--sm" type="search" data-pd-ui="rq" placeholder="' + SEARCH_PH() + '" value="' + esc(UI.rq) + '"></div><div id="pd-ready"></div>', { id: 'pd-readyCard' }) +
      '<div class="pd-grid2">' + riskCard + otCard + '</div>';
    renderWeekly();
    renderReady();
  }

  function renderWeekly() {
    const k = UI.metric;
    const series = (k === 'wpk' || k === 'rof') ? [PACK] : GROUPS;
    const weeks = R.series.slice(-UI.range);
    const val = (w, g) => k === 'all' ? (w.m[g].wp == null ? null : w.m[g].wp + w.m[g].rob) : (w.m[g] ? w.m[g][k] : 0);
    const tbl = $('#pd-wkTable');
    if (tbl) tbl.innerHTML = table([H_(T('Week', '주'))].concat(series.map(g => H_(GSHORT[g], 1))), weeks.slice().reverse().map(w =>
      '<tr><td class="mono">' + w.wk + (w.live ? ' <span class="tag tag--new">' + T('live', '실시간') + '</span>' : w.filled ? ' <span class="tag" title="' + T('No upload that week: New orders from the export, the rest unknown', '그 주 업로드 없음: 신규오더만 파일에서, 나머지는 알 수 없음') + '">' + T('from export', '파일 기준') + '</span>' : w.computed ? ' <span class="tag">' + T('upload', '업로드') + '</span>' : '') + '</td>' + series.map(g => '<td class="num">' + fmt(val(w, g)) + '</td>').join('') + '</tr>'), { tall: 1 });
    const cv = $('#pd-wkChart');
    if (!cv || !window.Chart) { if (cv) cv.parentNode.innerHTML = '<div class="pd-hint">' + T('Chart library not loaded — see the table.', '차트를 불러오지 못했습니다 — 표를 보세요.') + '</div>'; return; }
    if (S.charts.wk) S.charts.wk.destroy();
    S.charts.wk = new window.Chart(cv, {
      type: 'bar',
      data: { labels: weeks.map(w => dShort(w.wk)), datasets: series.map(g => ({ label: GSHORT[g], data: weeks.map(w => val(w, g)), backgroundColor: GHEX[g], borderRadius: 3, stack: 's' })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + fmt(c.parsed.y) } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true } }, y: { stacked: true, ticks: { font: { size: 10 }, callback: v => qs(v) }, grid: { color: '#e8ece9' } } }
      }
    });
  }

  function stateCell(l) {
    const s = l.hold ? 'hold' : l.preBulk ? (l.ready ? 'ready' : 'remain') : 'active';
    const opts = l.preBulk ? [['ready', 'Ready'], ['remain', 'Remaining'], ['hold', 'Client hold']] : [['active', T('Active', '진행')], ['hold', 'Client hold']];
    const manual = l.st && (l.st.s === 'ready' || l.st.s === 'remain');
    const meta = manual ? T('set by ', '지정 ') + esc(l.st.by || '?') + ' · <button type="button" class="pd-link" data-pd-act="auto" data-key="' + esc(l.key) + '">' + T('back to auto', '자동으로') + '</button>'
      : !l.hold && l.preBulk ? T('auto', '자동') : '';
    return '<div class="seg seg--sm pd-state">' + opts.map(([k, n]) => '<button type="button" class="' + (s === k ? 'active pd-s-' + k : '') + '" data-pd-act="state" data-key="' + esc(l.key) + '" data-s="' + k + '">' + n + '</button>').join('') + '</div>' +
      (meta ? '<div class="pd-state__meta">' + meta + '</div>' : '');
  }
  function holdInfo(l) {
    if (!l.hold) return l.holdCand ? '<button type="button" class="pd-holdinfo" data-pd-act="edit" data-key="' + esc(l.key) + '"><span class="tag pd-tag-cand" title="' + T('Confirmed ' + l.confAge + ' days ago, bulk not started', '확정 후 ' + l.confAge + '일, 벌크 미착수') + '">Hold?</span> <span class="pd-link">' + T('set client hold', 'Client hold 입력') + '</span></button>' : '';
    const st = l.st, days = st.since ? diff(st.since, R.asOf) : null;
    return '<button type="button" class="pd-holdinfo" data-pd-act="edit" data-key="' + esc(l.key) + '" title="' + T('Edit hold', 'Hold 수정') + '"><span class="tag pd-tag-hold">' + esc(reason(st.reason)) + '</span>' +
      '<span class="pd-dim">' + (days != null ? T(' since ' + dIso(st.since) + ' (' + days + ' d)', ' ' + dIso(st.since) + '부터 (' + days + '일)') : '') + (st.by ? ' · ' + esc(st.by) : '') + '</span>' + (st.note ? '<div class="pd-note">' + esc(st.note) + '</div>' : '') + '</button>';
  }
  function holdEditor(l) {
    const st = l.st && l.st.s === 'hold' ? l.st : { reason: '', since: R.asOf > today() ? R.asOf : today(), note: '', by: who() };
    return '<tr class="pd-editrow"><td colspan="9"><div class="pd-editor" data-key="' + esc(l.key) + '">' +
      '<div class="pd-editor__title">Client hold · ' + esc(l.so) + ' · ' + esc(l.client) + '</div>' +
      '<label>' + T('Waiting on', '대기 사유') + '<select class="select select--sm" data-f="reason"><option value="">' + T('Choose…', '선택…') + '</option>' + Object.keys(HOLD_REASONS).map(k => '<option value="' + k + '"' + (st.reason === k ? ' selected' : '') + '>' + esc(reason(k)) + '</option>').join('') + '</select></label>' +
      '<label>' + T('Since', '시작일') + '<input class="input input--sm" type="date" data-f="since" value="' + esc(st.since || '') + '"></label>' +
      '<label class="pd-grow">' + T('Note for Sales', '영업팀 메모') + '<input class="input input--sm" type="text" data-f="note" maxlength="200" value="' + esc(st.note || '') + '" placeholder="' + T('e.g. label artwork sent 3 Oct, no reply', '예: 10/3 라벨 디자인 전달, 회신 없음') + '"></label>' +
      '<label>' + T('Your name', '이름') + '<input class="input input--sm" type="text" data-f="by" value="' + esc(st.by || who()) + '" placeholder="' + T('Name', '이름') + '"></label>' +
      '<div class="pd-editor__btns"><button type="button" class="btn btn--sm btn--primary" data-pd-act="saveHold">' + T('Save hold', 'Hold 저장') + '</button>' +
      (l.hold ? '<button type="button" class="btn btn--sm" data-pd-act="release">' + T('Released', '해제') + '</button>' : '') +
      '<button type="button" class="btn btn--sm btn--ghost" data-pd-act="cancelEdit">' + T('Cancel', '취소') + '</button><span class="pd-editor__err"></span></div></div></td></tr>';
  }
  function renderReady() {
    const box = $('#pd-ready'); if (!box) return;
    const q = UI.rq.trim().toLowerCase();
    const list = R.lines.filter(l => {
      if (!l.isOpen || l.stage < 1 || l.stage > 5) return false;
      if (UI.rs === 'pre' && !l.preBulk) return false;
      if (UI.rs === 'bulk' && l.stage !== 3) return false;
      if (UI.rs === 'pack' && (l.stage < 4 || l.stage > 5)) return false;
      if (UI.rs === 'pre' && !(l.bulkLeft > 0)) return false;
      if (UI.rg !== 'all' && l.group !== UI.rg) return false;
      if (UI.rf === 'ready' && !(l.ready && !l.hold && l.preBulk)) return false;
      if (UI.rf === 'remain' && !(!l.ready && !l.hold && l.preBulk)) return false;
      if (UI.rf === 'hold' && !l.hold) return false;
      if (UI.rf === 'cand' && !l.holdCand) return false;
      if (UI.rf === 'manual' && !(l.st && l.st.s)) return false;
      if (q && (l.so + ' ' + l.client + ' ' + l.name).toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort((a, b) => (b.hold - a.hold) || (b.holdCand - a.holdCand) || (GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)) || ((a.conf || a.reg || '') < (b.conf || b.reg || '') ? -1 : 1));
    const sum = f => list.reduce((s, l) => s + (f(l) ? (l.preBulk || l.stage === 3 ? l.bulkLeft : 0) : 0), 0);
    const rows = [];
    for (const l of list) {
      const qtyCell = l.stage <= 3 ? fmt(l.bulkLeft) + ' <span class="pd-dim">' + GUNIT[l.group] + '</span>' + (l.bulkSrc === 'name' || l.bulkSrc === 'none' ? '<span class="pd-dim" title="' + T('Packs × count in the product name (bulk_order_qty is blank)', '병 수 × 제품명의 정수 (bulk_order_qty 없음)') + '">*</span>' : '')
        : fmt(l.packsLeft) + ' <span class="pd-dim">bottles</span>';
      rows.push('<tr' + (l.hold ? ' class="pd-row-hold"' : '') + '><td>' + stateCell(l) + '</td><td class="pd-nowrap">' + gname(l.group) + '</td>' +
        '<td class="mono">' + esc(l.so) + (l.status === 'new' ? ' <span class="badge s-new">new</span>' : '') + '</td><td class="pd-cl">' + esc(l.client) + '<div class="pd-dim pd-prod">' + esc(l.code) + ' · ' + esc(l.name) + '</div>' + (S.notes[l.key] ? '<div class="pd-note">' + T('Memo: ', '메모: ') + esc(S.notes[l.key].t) + '</div>' : '') + '</td>' +
        '<td class="num">' + qtyCell + '</td><td class="mono pd-nowrap">' + dIso(l.conf || l.reg) + ' <span class="pd-dim">(' + T(l.confAge + ' d', l.confAge + '일') + ')</span></td><td class="mono pd-nowrap">' + dIso(l.req) + '</td>' +
        '<td>' + esc(stg(l.stage)) + '</td><td class="pd-holdcell">' + holdInfo(l) + '</td></tr>');
      if (S.edit === l.key) rows.push(holdEditor(l));
    }
    box.innerHTML = '<div class="pd-sum">' + nLines(list.length) + ' · Ready <b>' + qs(sum(l => l.ready && !l.hold)) + '</b> · Remaining <b>' + qs(sum(l => !l.ready && !l.hold)) + '</b> · Client hold <b>' + qs(sum(l => l.hold)) + '</b> <span class="pd-dim">(' + T('bulk units', '벌크 단위') + ')</span></div>' +
      table([H_(T('State', '상태')), H_(T('Line', '라인')), H_('SO'), H_(T('Client · product', '고객 · 제품')), H_(T('Left', '남은 수량'), 1), H_(T('Confirmed', '확정')), H_(T('Required', '납기')), H_(T('Stage', '단계')), H_('Client hold')], rows, { tall: 1, empty: T('No lines match.', '조건에 맞는 라인이 없습니다.') }) +
      '<div class="pd-foot">' + T('* bulk_order_qty is blank, so packs × the count in the product name.', '* bulk_order_qty가 비어 병 수 × 제품명의 정수로 추정한 값.') + '</div>';
  }

  /* ---------- Sales view ---------- */
  // Sales numbers, without our own brands when the switch is on (line capacity always counts them)
  const salesLines = () => UI.noOwn ? R.lines.filter(l => !l.own) : R.lines;
  const salesNow = () => UI.noOwn ? salesModel(salesLines(), R.asOf, R.set, R.ot) : R.sales;
  function renderSales(pane) {
    const s = salesNow(), set = R.set, lines = salesLines();
    const ownBar = '<div class="pd-ownbar"><label class="check-label"><input type="checkbox" data-pd-ui="noOwn"' + (UI.noOwn ? ' checked' : '') + '> ' + T('Leave out our own brands', '자사 브랜드 제외') + '</label>' +
      '<span class="pd-dim">' + T('Demo Labs, Demo Labs Korea, Demo Outlet — out of the backlog, forecast and order list below. "What to win" still counts them: they use the line too.', 'Demo Labs · Demo Labs Korea · Demo Outlet — 아래 잔고·예상·오더 목록에서 뺍니다. "더 따야 할 양"은 라인을 쓰므로 그대로 포함.') + '</span></div>';
    // what to win, per line
    const gapRows = GROUPS.map(g => R.load[g]).filter(r => r.monthCap).sort((a, b) => a.runwayDays - b.runwayDays).map(r =>
      '<tr><td class="pd-nowrap">' + gname(r.g) + '</td><td class="mono">' + dIso(r.runOut) + ' <span class="pd-dim">(' + months(r.runwayDays / DAYS_PER_MONTH) + ')</span></td><td>' + sbadge(r.status) + '</td>' +
        '<td class="num">' + (r.need ? fmt(r.need) + ' <span class="pd-dim">' + GUNIT[r.g] + '</span>' : '–') + '</td><td class="num">' + (r.need ? money(r.needNzd) : '–') + '</td>' +
        '<td class="mono">' + (r.status === 'red' ? '<span class="pd-bad">' + T('too late for a gap-free line', '공백 없이 채우기엔 늦음') + '</span>' : r.status === 'amber' ? dIso(r.winBy) : '–') + '</td>' +
        '<td class="pd-dim pd-nowrap">' + capNote(r) + '</td></tr>');
    const fullUntil = dSay(addDays(R.asOf, set.readyDays + set.horizonDays));
    const gapCard = card('<span class="icon icon--inline">target</span>' + T('What to win to keep each line busy', '라인을 채우려면 더 따야 할 양'),
      T('Lines are booked until confirmed orders run out (client holds not counted). A new order reaches the line about ' + set.readyDays + ' days after confirmation, so "Confirm by" is the last day an order still arrives before the line runs dry. "To win" keeps the line full to ' + fullUntil + '; NZD at each line\'s average backlog price.',
        '확정 오더(Client hold 제외)가 떨어지는 날까지 라인이 돌아갑니다. 신규 오더는 확정 후 약 ' + set.readyDays + '일 뒤 라인에 올라오므로, "확정 기한"은 라인이 비기 전에 도착할 수 있는 마지막 확정일입니다. "더 따야 할 양"은 ' + fullUntil + '까지 라인을 채우는 양이고, 금액은 라인별 평균 단가로 환산했습니다.'),
      gapAlerts(true) + table([H_(T('Line', '라인')), H_(T('Booked until', '가동 가능일')), H_(T('Status', '상태')), H_(T('To win', '더 따야 할 양'), 1), H_(T('≈ value', '≈ 금액'), 1), H_(T('Confirm by', '확정 기한')), H_(T('Capacity used', '기준 캐파'))], gapRows));

    // client hold follow-up, by owner
    const held = lines.filter(l => l.hold && l.isOpen);
    const owners = {};
    held.forEach(l => { (owners[l.owner] = owners[l.owner] || []).push(l); });
    const cand = lines.filter(l => l.holdCand);
    let holdBody = '';
    Object.keys(owners).sort().forEach(o => {
      const ls = owners[o].sort((a, b) => ((a.st.since || '') < (b.st.since || '') ? -1 : 1));
      holdBody += '<div class="pd-owner"><div class="pd-owner__head"><b>' + esc(o) + '</b><span class="pd-dim">' + nLines(ls.length) + ' · ' + money(ls.reduce((x, l) => x + l.nzd, 0)) + '</span></div>' +
        table([H_('SO'), H_(T('Client · product', '고객 · 제품')), H_(T('Waiting on', '대기 사유')), H_(T('On hold', 'Hold 기간'), 1), H_(T('Required', '납기')), H_(T('Value', '금액'), 1), H_(T('Note', '메모'))], ls.map(l => {
          const days = l.st.since ? diff(l.st.since, R.asOf) : null, d = l.req ? diff(R.asOf, l.req) : null;
          return '<tr><td class="mono">' + esc(l.so) + '</td><td class="pd-cl">' + esc(l.client) + '<div class="pd-dim pd-prod">' + esc(l.name) + '</div></td><td><span class="tag pd-tag-hold">' + esc(reason(l.st.reason)) + '</span></td>' +
            '<td class="num">' + (days != null ? '<span class="' + (days > 14 ? 'pd-bad' : '') + '">' + nDays(days) + '</span>' : '–') + '</td><td class="mono pd-nowrap">' + dIso(l.req) + (d != null && d < 0 ? ' ' + badge('s-cancel', T('late', '지남')) : '') + '</td>' +
            '<td class="num">' + fmt(l.nzd) + '</td><td class="pd-notecell">' + esc(l.st.note || '') + (l.st.by ? ' <span class="pd-dim">— ' + esc(l.st.by) + '</span>' : '') + '</td></tr>';
        })) + '</div>';
    });
    const candNzd = money(cand.reduce((x, l) => x + l.nzd, 0));
    const holdCard = card('<span class="icon icon--inline">pan_tool</span>' + T('Client hold — follow up', 'Client hold — 영업 팔로업') + ' ' + badge(held.length ? 's-cancel' : 's-finished', nLines(held.length)),
      T('Orders waiting on the client, set by Planning / Production in Production › Readiness. They are left out of the factory backlog and delivery risk; the owner is the client\'s account manager (Clients tab), else whoever registered the order. Over 14 days on hold is red.',
        '고객 쪽을 기다리는 오더입니다. Planning·Production이 생산 › 생산 준비에서 표시합니다. 공장 잔량과 납기 위험에서 빠지며, 담당자는 Clients 탭의 account manager(없으면 오더 등록자)입니다. Hold 14일이 넘으면 빨간색.'),
      (holdBody || '<div class="pd-none">' + T('No orders on client hold.', 'Client hold 오더가 없습니다.') + '</div>') +
      (cand.length ? '<div class="pd-alert pd-alert--amber"><span class="icon">help</span><div>' +
        T('<b>' + cand.length + ' lines</b> were confirmed over ' + set.holdCandDays + ' days ago and bulk hasn\'t started (' + candNzd + '). Planning to confirm whether they are client holds: in the list, press <b>set client hold</b> (reason, since date, note) or mark them Ready / Remaining if they are waiting on us.',
          '<b>' + cand.length + '라인</b>이 확정 후 ' + set.holdCandDays + '일이 넘었는데 벌크를 시작하지 않았습니다(' + candNzd + '). Client hold인지 Planning 확인이 필요합니다: 목록에서 <b>Client hold 입력</b>(사유·시작일·메모)을 누르거나, 우리 쪽 대기면 Ready / Remaining으로 지정하세요.') +
        ' <button type="button" class="btn btn--sm" data-pd-act="reviewCand">' + T('Open the list', '검토 목록 열기') + '</button></div></div>' : ''));

    const kpi = (lb, v, sm, cls, act) => '<div class="pd-kpi' + (cls ? ' ' + cls : '') + '"' + (act ? ' data-pd-act="' + act + '" role="button" tabindex="0"' : '') + '><div class="pd-kpi__lb">' + lb + '</div><div class="pd-kpi__v">' + v + '</div><div class="pd-kpi__sm">' + sm + '</div></div>';
    const fcThis = s.fc[s.curM] || 0;
    const nCand = s.stalled.filter(l => l.holdCand).length, nPack = s.stalled.length - nCand;
    const kpis = '<div class="pd-kpis">' +
      kpi(T('Confirmed backlog · active', '확정 수주잔고 · 진행 중'), money(s.activeTotal), T(s.active.length + ' lines · ' + money(s.total) + ' in all', s.active.length + '라인 · 전체 ' + money(s.total) + ' 중')) +
      kpi(T('Stalled?', '정체 의심'), money(s.stalledTotal), T(nCand + ' Hold? · ' + nPack + ' packed ' + set.packedDays + 'd+ not invoiced', 'Hold? ' + nCand + '라인 · 포장 후 ' + set.packedDays + '일+ 미청구 ' + nPack + '라인'), s.stalled.length ? 'pd-kpi--warn' : '', s.stalled.length ? 'showStalled' : '') +
      kpi('Client hold', money(s.heldTotal), T(s.held.length + ' lines · month unknown', s.held.length + '라인 · 시점 미정'), s.held.length ? 'pd-kpi--warn' : '') +
      kpi(T('1/3 rule · per month', '1/3 규칙 · 월'), money(s.third), T('Active backlog ÷ 3 (3-month lead time)', '진행 중 잔고 ÷ 3 (리드타임 3개월)')) +
      kpi(T('Forecast · ', '예상 매출 · ') + mLabel(s.curM), money(fcThis), T('Required date + each line\'s median delay', '납기 + 제형별 지연 중앙값')) +
      kpi(T('Ready to invoice', '인보이스 대기'), money(s.invTotal), T(s.inv.length + ' lines packed in the last ' + set.packedDays + ' days', '최근 ' + set.packedDays + '일 내 포장 완료 ' + s.inv.length + '라인')) +
      kpi(T('Still to bill', '청구 잔액'), money(s.remain), T('Active backlog after deposits (Clients tab)', '진행 중 잔고, 디파짓 차감 후 (Clients 탭)')) +
      kpi(T('Unconfirmed (new)', '미확정 (new)'), money(s.pipeTotal), T(s.pipe.length + ' lines, not in backlog', s.pipe.length + '라인, 잔고 제외')) + '</div>';

    const lt = byLetter(s.back);
    const ltRows = LETTERS.map(([L, n]) => { const r = lt[L]; return '<tr><td><b>' + L + '</b> <span class="pd-dim">' + n + '</span></td><td class="num">' + r.lines + '</td><td class="num">' + fmt(r.packs) + '</td><td class="num">' + fmt(r.bulk) + '</td><td class="num">' + fmt(r.value) + '</td><td class="num">' + fmt(r.ofValue) + '</td></tr>'; });
    const owners2 = [...new Set(lines.map(l => l.owner))].sort();
    const q = UI.sQuery.trim().toLowerCase();
    const list = s.back.filter(l => (UI.sOwner === 'all' || l.owner === UI.sOwner) && (UI.sLetter === 'all' || l.letter === UI.sLetter) &&
      (UI.sStage === 'all' || (UI.sStage === 'hold' ? l.hold : UI.sStage === 'stalled' ? l.stalled : String(l.stage) === UI.sStage)) && (!q || (l.so + ' ' + l.client + ' ' + l.name + ' ' + l.code).toLowerCase().indexOf(q) !== -1))
      .sort((a, b) => (a.expMonth < b.expMonth ? -1 : a.expMonth > b.expMonth ? 1 : (a.req || '') < (b.req || '') ? -1 : 1));
    const stageCell = l => l.hold ? '<span class="tag pd-tag-hold">Client hold</span>' : esc(stg(l.stage)) +
      (l.holdCand ? ' <span class="tag pd-tag-cand">Hold?</span>' : l.stalled ? ' <span class="tag pd-tag-cand" title="' + T('Packed, not invoiced', '포장 완료, 미청구') + '">' + T(l.packedAge + 'd not invoiced', '미청구 ' + l.packedAge + '일') + '</span>' : '');
    const listRows = list.slice(0, 300).map(l => '<tr><td class="mono">' + esc(l.so) + '</td><td class="pd-cl">' + esc(l.client) + '<div class="pd-dim pd-prod">' + esc(l.name) + '</div></td><td class="mono">' + esc(l.code) + '</td><td><b>' + l.letter + '</b></td>' +
      '<td class="pd-stagecell">' + stageCell(l) + '</td><td class="num">' + fmt(l.qty) + '</td><td class="num pd-nowrap">' + unitPrice(l) + '</td><td class="num">' + fmt(l.nzd) + '</td>' +
      '<td class="mono pd-nowrap">' + dIso(l.req) + '</td><td class="mono pd-nowrap">' + (l.expMonth === 'hold' || l.expMonth === 'stalled' ? '<span class="pd-dim">' + T('unknown', '미정') + '</span>' : mLabel(l.expMonth)) + '</td><td class="pd-nowrap">' + esc(l.owner) + '</td>' +
      '<td class="pd-memocell">' + memoCell(l.key) + '</td></tr>');
    const later = s.later ? T(' · ' + money(s.later) + ' expected after ' + mLabel(addMonths(s.curM, 3)), ' · ' + money(s.later) + '는 ' + mLabel(addMonths(s.curM, 3)) + ' 이후 예상') : '';

    pane.innerHTML = ownBar + gapCard + holdCard + kpis +
      card('<span class="icon icon--inline">monitoring</span>' + T('Monthly sales · actual and forecast', '월 매출 · 실적과 예상'),
        T('<b>How to read it</b><ul><li><b>Dark bars (actual)</b> — orders finished that month, by packing-finish month: the last 12 months of real sales.</li>' +
          '<li><b>Light bars (forecast)</b> — the active backlog not billed yet, placed in the month it should come in (required date + each line\'s usual delay; packed lines this month). Client holds and stalled lines have no month, so they are not in it.</li>' +
          '<li><b>Orange line (intake)</b> — orders registered that month. When it stays under the actual bars, sales drop two to three months later.</li>' +
          '<li><b>Grey dashed line (1/3 rule)</b> — active backlog ÷ 3: with a 3-month lead time, roughly what each month should bill. A forecast bar under it is a thin month.</li></ul>' +
          '12-month actual average ' + money(s.avg12) + '/mo' + later + '.',
          '<b>읽는 법</b><ul><li><b>진한 막대 (실적)</b> — 그 달에 포장 완료된 오더 금액. 지난 12개월 실제 매출입니다.</li>' +
          '<li><b>연한 막대 (예상)</b> — 아직 청구 전인 진행 중 확정 오더를 들어올 달에 배치(납기 + 제형별 평소 지연, 이미 포장된 건은 이번 달). Client hold·정체 의심은 시점을 알 수 없어 빠집니다.</li>' +
          '<li><b>주황 선 (수주)</b> — 그 달에 새로 등록된 오더 금액. 수주 선이 실적 막대보다 계속 낮으면 2–3개월 뒤 매출이 줄어듭니다.</li>' +
          '<li><b>회색 점선 (1/3 규칙)</b> — 진행 중 잔고 ÷ 3. 리드타임이 3개월이면 매달 대략 이만큼 청구되는 게 정상이라는 기준선이고, 예상 막대가 점선보다 낮은 달은 매출이 비는 달입니다.</li></ul>' +
          '12개월 실적 평균 ' + money(s.avg12) + '/월' + later + '.'),
        '<div class="pd-chart"><canvas id="pd-salesChart" height="260"></canvas></div>') +
      card('<span class="icon icon--inline">category</span>' + T('Backlog by type', '타입별 잔고'), T('Same columns as the Sales Summary sheet: the whole confirmed backlog (stalled and client hold included). Bulk in units (capsules, tablets…), value in NZD.', 'Sales Summary 시트와 같은 구성: 확정 잔고 전체(정체 의심·Client hold 포함). 벌크는 개수(캡슐·정제…), 금액은 NZD.'),
        table([H_(T('Type', '타입')), H_(T('Lines', '라인'), 1), H_(T('Packs', '병 수'), 1), H_(T('Bulk', '벌크'), 1), H_(T('Value', '금액'), 1), H_(T('Value – OF only', '금액 – OF만'), 1)], ltRows)) +
      card('<span class="icon icon--inline">list_alt</span>' + T('Confirmed orders', '확정 오더'), (list.length > 300 ? T('Showing 300 of ' + list.length + ' — narrow the filters. ', list.length + '건 중 300건 — 필터로 좁혀 주세요. ') : '') +
          T('Memo: press it to write a note on that line (Enter saves); everyone sees it.', '메모: 눌러서 줄마다 메모를 남깁니다(Enter로 저장). 모두에게 보입니다.'),
        '<div class="pd-filters"><select class="select select--sm" data-pd-ui="sOwner"><option value="all">' + T('All owners', '전체 담당자') + '</option>' + owners2.map(o => '<option' + (UI.sOwner === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>' +
        '<select class="select select--sm" data-pd-ui="sLetter"><option value="all">' + T('All types', '전체 타입') + '</option>' + LETTERS.map(([L, n]) => '<option value="' + L + '"' + (UI.sLetter === L ? ' selected' : '') + '>' + L + ' · ' + n + '</option>').join('') + '</select>' +
        '<select class="select select--sm" data-pd-ui="sStage"><option value="all">' + T('All stages', '전체 단계') + '</option><option value="hold"' + (UI.sStage === 'hold' ? ' selected' : '') + '>Client hold</option><option value="stalled"' + (UI.sStage === 'stalled' ? ' selected' : '') + '>' + T('Stalled? (Hold? · not invoiced)', '정체 의심 (Hold? · 미청구)') + '</option>' + [1, 2, 3, 4, 5, 6].map(k => '<option value="' + k + '"' + (UI.sStage === String(k) ? ' selected' : '') + '>' + stg(k) + '</option>').join('') + '</select>' +
        '<input class="input input--sm" type="search" data-pd-ui="sQuery" placeholder="' + T('SO, client, product, code', 'SO, 고객, 제품, 코드') + '" value="' + esc(UI.sQuery) + '"></div>' +
        table([H_('SO'), H_(T('Client · product', '고객 · 제품')), H_(T('Code', '제품 코드')), H_(T('Type', '타입')), H_(T('Stage', '단계')), H_(T('Qty', '수량'), 1), H_(T('Unit price', '단가'), 1), H_('NZD', 1), H_(T('Required', '납기')), H_(T('Expected', '예상 월')), H_(T('Owner', '담당자')), H_(T('Memo', '메모'))], listRows, { tall: 1 }), { id: 'pd-orders' });
    renderSalesChart();
  }
  // per-line memo (crm:prod_notes), edited in place so the list keeps its scroll position
  function memoCell(key) {
    const n = S.notes[key];
    return '<button type="button" class="pd-memo__btn" data-pd-act="memoEdit" data-key="' + esc(key) + '">' +
      (n ? esc(n.t) + (n.by ? ' <span class="pd-dim">— ' + esc(n.by) + '</span>' : '') : '<span class="pd-dim">+ ' + T('memo', '메모') + '</span>') + '</button>';
  }
  function memoEditor(key) {
    const n = S.notes[key];
    return '<div class="pd-memo" data-key="' + esc(key) + '"><input class="input input--sm" type="text" maxlength="300" data-pd-memo value="' + esc(n ? n.t : '') + '" placeholder="' + T('Note for this line', '이 줄 메모') + '">' +
      '<button type="button" class="btn btn--sm btn--primary" data-pd-act="memoSave">' + T('Save', '저장') + '</button><button type="button" class="btn btn--sm btn--ghost" data-pd-act="memoCancel">' + T('Cancel', '취소') + '</button></div>';
  }
  async function saveMemo(box) {
    const key = box.dataset.key, t = box.querySelector('[data-pd-memo]').value.trim();
    box.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const cur = (await H.kvGet(K.notes)) || {}; // re-read: someone else may have written a memo
      if (t) cur[key] = { t, by: who(), at: new Date().toISOString() }; else delete cur[key];
      await H.kvPut(K.notes, cur);
      S.notes = cur;
      box.parentNode.innerHTML = memoCell(key);
    } catch (e) {
      box.querySelectorAll('button').forEach(b => { b.disabled = false; });
      box.insertAdjacentHTML('beforeend', '<span class="pd-editor__err">' + esc(e.message) + '</span>');
    }
  }
  function renderSalesChart() {
    const cv = $('#pd-salesChart'), s = R.sales;
    if (!cv || !window.Chart) { if (cv) cv.parentNode.innerHTML = '<div class="pd-hint">' + T('Chart library not loaded.', '차트를 불러오지 못했습니다.') + '</div>'; return; }
    const past = s.months.map(m => m <= s.curM);
    S.charts.sales = new window.Chart(cv, {
      data: {
        labels: s.months.map(mLabel),
        datasets: [
          { type: 'bar', label: T('Actual', '실적'), data: s.months.map((m, i) => past[i] ? Math.round(s.actual[m] || 0) : null), backgroundColor: '#2f6b5e', borderRadius: 3, stack: 'a' },
          { type: 'bar', label: T('Forecast (backlog)', '예상 (잔고)'), data: s.months.map(m => m >= s.curM ? Math.round(s.fc[m] || 0) : null), backgroundColor: '#9cc6b8', borderRadius: 3, stack: 'a' },
          { type: 'line', label: T('Intake', '수주'), stack: 'intake', data: s.months.map((m, i) => past[i] ? Math.round(s.intake[m] || 0) : null), borderColor: '#c0892f', backgroundColor: '#c0892f', borderWidth: 2, pointRadius: 3, tension: 0.25 },
          { type: 'line', label: T('1/3 rule', '1/3 규칙'), stack: 'third', data: s.months.map(m => m >= s.curM ? Math.round(s.third) : null), borderColor: '#66706a', borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: c => c.parsed.y == null ? null : c.dataset.label + ': ' + money(c.parsed.y) } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } }, y: { stacked: true, ticks: { font: { size: 10 }, callback: v => qs(v) }, grid: { color: '#e8ece9' } } }
      }
    });
  }

  /* ---------- Output history (the old Production tab) ---------- */
  function renderHistory(pane) {
    if (H.renderHistory) {
      if (!pane.querySelector('#productionContent')) pane.innerHTML = '<div class="prod-wrap pd-history" id="productionContent"></div>';
      H.renderHistory();
      return;
    }
    pane.innerHTML = card('<span class="icon icon--inline">bar_chart</span>' + T('Output history', '생산 실적'), '',
      '<div class="pd-none">' + T('The current Production tab (production by type, monthly trend, year-over-year, by client, AI insight) moves here unchanged. It is not part of this prototype.',
        '기존 Production 탭 화면(타입별·월별·연도별·고객사별 생산, AI insight)이 그대로 여기로 옵니다. 이 프로토타입에는 들어 있지 않습니다.') + '</div>');
  }

  /* ---------- Data view ---------- */
  function renderData(pane) {
    const idx = S.idx || { snaps: [] };
    const last = idx.snaps.find(s => s.date === idx.current);
    const set = R ? R.set : mergeSettings(S.setRaw);
    let html = card('<span class="icon icon--inline">upload_file</span>Mother data',
      T('One oERP export (Sales_statistics.xlsx) feeds Production and Sales. Upload the newest export each week: the previous one is compared and kept, and the week\'s numbers are saved for the weekly record. Line states and holds carry over.',
        'oERP 추출 파일(Sales_statistics.xlsx) 하나가 생산·영업 화면을 모두 채웁니다. 매주 최신 파일을 올리면 이전 파일과 비교해 보관하고, 그 주 숫자를 주간 기록에 저장합니다. 라인 상태와 Hold는 그대로 이어집니다.'),
      '<div class="pd-mother">' + (last ? '<div><div class="pd-kpi__lb">' + T('Current', '현재') + '</div><div class="pd-mother__v">' + esc(last.file) + '</div><div class="pd-dim">' +
        T('Data as of ' + dLong(last.date), dLong(last.date) + ' 기준') + ' · ' + T(fmt(last.rows) + ' rows', fmt(last.rows) + '행') + ' · ' + (last.by ? esc(last.by) + ' · ' : '') + (last.at ? last.at.slice(0, 10) : '') + '</div></div>'
        : '<div class="pd-dim">' + T('Nothing uploaded yet.', '아직 업로드한 파일이 없습니다.') + '</div>') +
      '<label class="btn btn--primary pd-upload"><span class="icon">upload</span>' + T('Upload oERP export', 'oERP 파일 업로드') + '<input type="file" accept=".xlsx,.xls,.csv" data-pd-act="file" hidden></label></div>' +
      '<div id="pd-uploadBox">' + uploadPreview() + '</div>');

    if (R) {
      const prevDate = idx.snaps.filter(s => s.date < idx.current).map(s => s.date).sort().pop();
      html += card('<span class="icon icon--inline">compare_arrows</span>' + T('Changes since the previous upload', '지난 업로드 대비 변경'),
        prevDate ? T('Compared with ' + dLong(prevDate) + '.', dLong(prevDate) + ' 파일과 비교.') : T('Shown after the second upload.', '두 번째 업로드부터 보입니다.'), '<div id="pd-diffBox">' + (prevDate ? '<div class="empty">Loading…</div>' : '') + '</div>');
      const c = checks(R.lines);
      const chk = (title, list, cols, why) => '<details class="pd-details"><summary><b>' + title + '</b> <span class="badge ' + (list.length ? 's-new' : 's-finished') + '">' + list.length + '</span> <span class="pd-dim">' + why + '</span></summary>' +
        table(cols.map(x => H_(x[0], x[2])), list.slice(0, 200).map(l => '<tr>' + cols.map(x => '<td' + (x[2] ? ' class="num"' : '') + '>' + x[1](l) + '</td>').join('') + '</tr>'), { tall: 1 }) + '</details>';
      const base = [['SO', l => '<span class="mono">' + esc(l.so) + '</span>'], [T('Client', '고객'), l => esc(l.client)], [T('Product', '제품'), l => esc(l.name)]];
      html += card('<span class="icon icon--inline">rule</span>' + T('Data checks', '데이터 점검'), T('Lines the reports skip or estimate. Fix them in oERP; the next upload picks it up.', '리포트에서 빠지거나 추정한 라인입니다. oERP에서 고치면 다음 업로드에 반영됩니다.'),
        chk(T('Open over ' + set.staleDays + ' days', set.staleDays + '일 넘게 열린 오더'), c.staleConfirm.concat(c.staleNew), base.concat([[T('Status', '상태'), l => esc(l.status)], [T('Registered', '등록'), l => dIso(l.reg)], ['NZD', l => fmt(l.nzd), 1]]), T('left out of the reports', '리포트에서 제외')) +
        chk(T('Confirmed with no value', '금액 0 확정 오더'), c.zeroValue, base.concat([[T('Qty', '수량'), l => fmt(l.qty), 1]]), T('count in production, not in sales', '생산엔 포함, 매출엔 제외')) +
        chk(T('Packed, not invoiced over ' + set.packedDays + ' days', '포장 후 ' + set.packedDays + '일+ 미청구'), c.packedOld, base.concat([[T('Packed', '포장 완료'), l => dIso(l.pf)], [T('Required', '납기'), l => dIso(l.req)], ['NZD', l => fmt(l.nzd), 1]]), T('out of the active backlog — invoice or close in oERP', '진행 중 잔고에서 제외 — oERP에서 청구·완료 처리 확인')) +
        chk(T('Bulk quantity estimated', '벌크 수량 추정'), c.bulkGuess, base.concat([[T('Packs', '병 수'), l => fmt(l.qty), 1], [T('Bulk', '벌크'), l => fmt(l.bulkQty), 1]]), T('bulk_order_qty blank; packs × count in the name', 'bulk_order_qty 없음 — 병 수 × 제품명의 정수')) +
        chk(T('Finished with no packing date', '포장 완료일 없는 완료 오더'), c.finNoPf, base.concat([[T('Confirm date', '확정일'), l => dIso(l.conf)]]), T('sales month falls back to the oERP finish date', '매출 월은 oERP 완료 처리일로 대체')));
    }

    html += settingsCard(set);
    if (idx.snaps.length) html += card('<span class="icon icon--inline">history</span>' + T('Uploads', '업로드 기록'), '',
      table([H_(T('Data as of', '기준일')), H_(T('File', '파일')), H_(T('Rows', '행'), 1), H_(T('Uploaded by', '올린 사람')), H_(T('When', '업로드 시각'))], idx.snaps.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map(s =>
        '<tr><td class="mono">' + s.date + (s.date === idx.current ? ' <span class="tag tag--new">' + T('current', '현재') + '</span>' : '') + '</td><td>' + esc(s.file) + '</td><td class="num">' + fmt(s.rows) + '</td><td>' + esc(s.by || '–') + '</td><td class="mono">' + esc((s.at || '').replace('T', ' ').slice(0, 16)) + '</td></tr>')));
    html += rulesCard(set);
    pane.innerHTML = html;
    if (R && $('#pd-diffBox') && $('#pd-diffBox').firstChild) loadDiff();
  }
  async function loadDiff() {
    const idx = S.idx, prevDate = idx.snaps.filter(s => s.date < idx.current).map(s => s.date).sort().pop();
    const box = $('#pd-diffBox');
    try {
      const prev = await H.kvGet(K.snap(prevDate));
      if (!box.isConnected) return;
      box.innerHTML = prev ? diffHtml(diffLines(normalize(prev.cols, prev.rows), R.lines, R.set.doneRatio)) : '<div class="pd-none">' + T('Previous upload not found.', '이전 업로드를 찾지 못했습니다.') + '</div>';
    } catch (e) { box.innerHTML = '<div class="pd-none">' + esc(e.message) + '</div>'; }
  }
  function diffHtml(d) {
    const sec = (title, list, f) => '<details class="pd-details"' + (list.length && list.length <= 15 ? ' open' : '') + '><summary><b>' + title + '</b> <span class="badge s-confirm">' + list.length + '</span></summary>' +
      (list.length ? table([H_('SO'), H_(T('Client', '고객')), H_(T('Product', '제품')), H_(T('Detail', '내용'))], list.slice(0, 200).map(x => { const l = x.l || x; return '<tr><td class="mono">' + esc(l.so) + '</td><td>' + esc(l.client) + '</td><td class="pd-prod">' + esc(l.name) + '</td><td>' + f(x) + '</td></tr>'; }), { tall: 1 }) : '') + '</details>';
    return sec(T('New lines', '신규 라인'), d.added, x => esc(x.status) + ' · ' + fmt(x.qty)) + sec(T('Finished', '완료'), d.finished, x => dIso(x.pf)) + sec(T('Cancelled', '취소'), d.cancelled, () => '') +
      sec(T('Changed', '변경'), d.changed, x => esc(x.what)) + sec(T('No longer in the export', '파일에서 빠짐'), d.removed, x => esc(x.status));
  }
  function uploadPreview() {
    const u = S.upload;
    if (!u) return '';
    if (u.error) return '<div class="pd-alert pd-alert--red"><span class="icon">error</span><div>' + esc(u.error) + '</div></div>';
    if (u.loading) return '<div class="empty">' + T('Reading ' + esc(u.file) + '…', esc(u.file) + ' 읽는 중…') + '</div>';
    const d = u.diff, cur = S.idx && S.idx.current;
    const older = cur && u.date < cur;
    const nConf = u.lines.filter(l => l.status === 'confirm').length;
    return '<div class="pd-uprev"><div class="pd-uprev__head"><b>' + esc(u.file) + '</b> · ' + T(fmt(u.rows.length) + ' rows · ' + nConf + ' confirmed lines', fmt(u.rows.length) + '행 · 확정 ' + nConf + '라인') + '</div>' +
      '<div class="pd-uprev__row"><label>' + T('Data as of', '기준일') + '<input class="input input--sm" type="date" data-pd-ui="upDate" value="' + esc(u.date) + '"></label>' +
      '<label>' + T('Your name', '이름') + '<input class="input input--sm" type="text" data-pd-ui="upBy" value="' + esc(u.by || who()) + '" placeholder="' + T('Name', '이름') + '"></label>' +
      '<button type="button" class="btn btn--sm btn--primary" data-pd-act="saveUpload"' + (older ? ' disabled' : '') + '>' + T('Save as mother data', 'Mother data로 저장') + '</button>' +
      '<button type="button" class="btn btn--sm btn--ghost" data-pd-act="cancelUpload">' + T('Cancel', '취소') + '</button></div>' +
      (older ? '<div class="pd-alert pd-alert--red">' + T('This date is older than the current data (' + dLong(cur) + ').', '현재 데이터(' + dLong(cur) + ')보다 이전 날짜입니다.') + '</div>' : '') +
      (u.date === cur ? '<div class="pd-alert pd-alert--amber">' + T('Same date as the current data — saving replaces it.', '현재 데이터와 같은 날짜입니다 — 저장하면 덮어씁니다.') + '</div>' : '') +
      (d ? '<div class="pd-uprev__diff">' + T('Against the current data: <b>' + d.added.length + '</b> new · <b>' + d.finished.length + '</b> finished · <b>' + d.cancelled.length + '</b> cancelled · <b>' + d.changed.length + '</b> changed · <b>' + d.removed.length + '</b> gone',
        '현재 데이터 대비: 신규 <b>' + d.added.length + '</b> · 완료 <b>' + d.finished.length + '</b> · 취소 <b>' + d.cancelled.length + '</b> · 변경 <b>' + d.changed.length + '</b> · 빠짐 <b>' + d.removed.length + '</b>') + '</div>' : '') + '</div>';
  }
  async function readUpload(file) {
    S.upload = { file: file.name, loading: true };
    renderUploadBox();
    try {
      await H.loadScript(XLSX_URL);
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets.Sales_statistics || wb.Sheets[wb.SheetNames[0]];
      const aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      if (!aoa.length) throw new Error(T('The sheet is empty.', '시트가 비어 있습니다.'));
      const cols = aoa[0].map(c => String(c == null ? '' : c).trim());
      const rows = aoa.slice(1).filter(r => r && r.some(v => v != null && v !== ''));
      const lines = normalize(cols, rows);
      const lm = new Date(file.lastModified || Date.now());
      const date = lm.getFullYear() + '-' + String(lm.getMonth() + 1).padStart(2, '0') + '-' + String(lm.getDate()).padStart(2, '0');
      S.upload = { file: file.name, cols, rows, lines, date, by: who(), diff: R ? diffLines(R.lines, lines, R.set.doneRatio) : null };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      S.upload = { file: file.name, error: msg.replace(/^Missing columns: /, T('Missing columns: ', '필수 컬럼이 없습니다: ')) };
    }
    renderUploadBox();
  }
  function renderUploadBox() { const b = $('#pd-uploadBox'); if (b) b.innerHTML = uploadPreview(); }
  async function saveUpload() {
    const u = S.upload; if (!u || !u.lines || S.busy) return;
    if (!u.by) { renderUploadBox(); const i = root.querySelector('[data-pd-ui="upBy"]'); if (i) { i.focus(); i.classList.add('pd-invalid'); } return; }
    S.busy = true;
    const idx = JSON.parse(JSON.stringify(S.idx || { snaps: [], weekly: {}, seen: null, current: null }));
    idx.weekly = idx.weekly || {};
    // freeze the outgoing week (with today's line states) so the weekly record keeps it
    if (R && weekStart(R.asOf) !== weekStart(u.date)) idx.weekly[weekStart(R.asOf)] = R.week;
    // first-seen dates carry over; a line not in the previous export is new as of this one
    if (R) {
      const prevSeen = {}; R.lines.forEach(l => { prevSeen[l.key] = l.firstSeen; });
      const seen = {}; u.lines.forEach(l => { seen[l.key] = prevSeen[l.key] || u.date; });
      idx.seen = seen;
    }
    idx.snaps = idx.snaps.filter(s => s.date !== u.date).concat([{ date: u.date, file: u.file, rows: u.rows.length, by: u.by, at: new Date().toISOString() }]);
    idx.current = u.date;
    try {
      await H.kvPut(K.snap(u.date), { date: u.date, file: u.file, cols: u.cols, rows: u.rows });
      await H.kvPut(K.index, idx);
      S.idx = idx; S.snap = { date: u.date, file: u.file, cols: u.cols, rows: u.rows }; S.upload = null; S.err = null;
      recompute(); render();
    } finally { S.busy = false; }
  }

  function settingsCard(set) {
    const actual = R ? R.actual : {};
    const rows = GROUPS.map(g => {
      const nominal = set.capDay[g] ? set.capDay[g] * set.workDays : null, a = actual[g] || 0;
      const fallback = !nominal ? T('blank = no warning', '경고 없음') : a > 0 ? T('blank = 12-mo actual (' + qs(a) + ')', '12개월 실제 (' + qs(a) + ')') : T('blank = nominal (' + qs(nominal) + ')', '명목 (' + qs(nominal) + ')');
      return '<tr><td class="pd-nowrap">' + gname(g) + ' <span class="pd-dim">' + GUNIT[g] + '</span></td>' +
        '<td class="num"><input class="input input--sm pd-numin" type="number" min="0" step="1000" data-set="capDay" data-g="' + g + '" value="' + (set.capDay[g] || '') + '"></td>' +
        '<td class="num">' + (nominal ? qs(nominal) : '–') + '</td><td class="num">' + (a ? qs(a) : '–') + '</td>' +
        '<td class="num"><input class="input input--sm pd-numin" type="number" min="0" step="10000" data-set="monthCap" data-g="' + g + '" value="' + (set.monthCap[g] || '') + '"></td><td class="pd-dim">' + esc(fallback) + '</td></tr>';
    });
    const nums = [
      ['workDays', 'Production days / month', '월 생산일수', 1],
      ['readyDays', 'Materials lead time (days) — confirm → ready, and how long a new order takes to reach the line', '자재 리드타임(일) — 확정 → Ready, 신규 오더가 라인에 올라오기까지', 1],
      ['horizonDays', 'Gap warning: days past the lead time to keep booked', '공백 경고: 리드타임 이후 채워둘 일수', 1],
      ['lagMonths', 'Months from order to production (new-order outlook)', '수주 → 생산 개월 수 (신규오더로 본 라인 전망)', 1],
      ['holdCandDays', '"Hold?" flag after (days since confirmed, bulk not started)', '"Hold?" 표시 기준 (확정 후 일수, 벌크 미착수)', 1],
      ['packedDays', 'Stalled: packed this many days and still not invoiced', '정체 의심: 포장 후 이 일수가 지나도 미청구', 1],
      ['riskDays', 'Delivery risk: due within (days)', '납기 위험: 납기까지 남은 일수', 1],
      ['salesLeadDays', 'Sales forecast for lines with no required date (days after registering)', '납기 없는 라인의 매출 예상 (등록 후 일수)', 1],
      ['staleDays', 'Leave out open lines older than (days)', '이보다 오래 열린 라인은 제외 (일)', 1],
      ['doneRatio', 'Counts as done at (share of the order)', '완료로 보는 비율 (오더 대비)', 0.01],
      ['fx', 'USD → NZD (0 = the CRM\'s monthly FX rates)', 'USD → NZD (0 = CRM 월별 환율)', 0.01]];
    return card('<span class="icon icon--inline">tune</span>' + T('Settings', '설정'),
      T('<b>Capacity used</b> is the monthly capacity behind the gap warnings, the monthly new-order target and the 3-month outlook. For each line it is: ① <b>planned capacity / mo</b>, when Planning has entered one; else ② the <b>12-month actual</b> average (bulk finished, by packing-finish month); else ③ <b>nominal</b> (daily capacity × production days). Powder · liquid mixes pots and sachets, so it only gets a warning once ① is entered. "Capacity used" on each screen says which one it is. Planning owns these numbers; saving applies them for everyone.',
        '<b>기준 캐파</b>는 라인 공백 경고·월 신규오더 목표·3개월 뒤 전망에 쓰는 월 캐파입니다. 라인별로 ① Planning이 넣은 <b>계획 캐파/월</b>이 있으면 그 값, ② 없으면 <b>최근 12개월 실제 생산</b> 평균(벌크 완료 수량, 포장 완료 월 기준), ③ 그것도 없으면 <b>명목 캐파</b>(일 캐파 × 월 생산일)를 씁니다. Powder · liquid는 통·포가 섞여 ①을 넣어야 경고가 나옵니다. 화면마다 "기준 캐파"에 어느 값을 썼는지 표시됩니다. 이 숫자는 Planning이 관리하고, 저장하면 모두에게 적용됩니다.'),
      table([H_(T('Line', '라인')), H_(T('Daily capacity (nominal)', '일 캐파 (명목)'), 1), H_(T('× days = nominal / mo', '× 생산일 = 명목/월'), 1), H_(T('12-mo actual / mo', '12개월 실제/월'), 1), H_(T('Planned capacity / mo = target', '계획 캐파/월 = 목표'), 1), H_(T('If blank', '비워두면'))], rows) +
      '<div class="pd-setgrid">' + nums.map(([k, en, ko, st]) => '<label><span>' + T(en, ko) + '</span><input class="input input--sm pd-numin" type="number" min="0" step="' + st + '" data-set="' + k + '" value="' + set[k] + '"></label>').join('') +
      '<label class="check-label"><input type="checkbox" data-set="includeNew"' + (set.includeNew ? ' checked' : '') + '> ' + T('Count unconfirmed (new) orders in Planning numbers', '미확정(new) 오더도 Planning 숫자에 포함') + '</label></div>' +
      '<div class="pd-editor__btns"><button type="button" class="btn btn--sm btn--primary" data-pd-act="saveSettings">' + T('Save settings', '설정 저장') + '</button><button type="button" class="btn btn--sm btn--ghost" data-pd-act="resetSettings">' + T('Back to defaults', '기본값으로') + '</button><span class="pd-dim" id="pd-setMsg"></span></div>');
  }
  function rulesCard(set) {
    const NEW = T('New — Morgan 19 Oct', '신규 — Morgan 10/19'), NEW2 = T('New — Morgan 27 Oct', '신규 — Morgan 10/27'), NEW3 = T('New — Alex 28 Oct', '신규 — Alex 10/28'), OK = T('Reviewed', '검토됨');
    const both = T('Both', '공통');
    const R_ = [
      ['Planning', 'Waiting for production', T('Bulk not finished and Ready (set by hand, or ' + set.readyDays + ' days after confirmation), plus bulk already in production.', '벌크 미완료 + Ready(수동 지정, 또는 확정 ' + set.readyDays + '일 후) + 벌크 생산 중.'), OK],
      ['Planning', 'Remaining – OB', T('Bulk not started and not Ready yet (waiting on our side).', '벌크 미착수, 아직 Ready 아님(우리 쪽 대기).'), OK],
      ['Planning', 'Client hold', T('Set by hand with what we are waiting on. Left out of backlog days, gap warnings and factory delivery risk; listed in Sales › Client hold. Each hold\'s from–to is kept for Delays.', '대기 사유와 함께 라인별로 수동 지정. 밀린 생산일수·공백 경고·공장 납기 위험에서 빠지고 영업 › Client hold에 나옵니다. Hold 기간(시작–해제)은 Delays용으로 보관.'), NEW],
      ['Planning', T('Monthly target', '월 목표'), T('Planned monthly capacity per line. Until Planning sets it: 12-month actual output, else nominal (daily × days).', '라인별 계획 월 캐파. Planning이 넣기 전까지는 12개월 실제 생산, 없으면 명목(일 캐파 × 생산일).'), NEW],
      ['Planning', T('This month vs target', '이번 달 vs 목표'), T('New orders to the data date against the share of the month gone: data as of 27 Oct → 27/31 = 87.1% of the monthly target.', '데이터 기준일까지의 신규오더를 지난 날짜 비율만큼의 목표와 비교: 10/27 기준 → 월 목표의 27/31 = 87.1%.'), NEW2],
      ['Planning', T('Line outlook', '라인 전망'), T('New orders of month M against the target preview the line in month M + ' + set.lagMonths + '; the open month shows what still has to be won.', 'M월 신규오더 ÷ 목표 = M+' + set.lagMonths + '월 라인이 찰 비율; 진행 중인 달은 더 따야 할 양을 표시.'), NEW2],
      ['Planning', T('Gap warning', '공백 경고'), T('Red when the confirmed (non-hold) backlog lasts less than the materials lead time; amber when less than lead time + ' + set.horizonDays + ' days.', '확정(Hold 제외) 잔고가 자재 리드타임보다 짧으면 빨강, 리드타임 + ' + set.horizonDays + '일보다 짧으면 주황.'), NEW],
      ['Planning', 'New orders', T('Bulk units of lines first seen in that week\'s upload (weeks before the first upload: Planning\'s record).', '그 주 업로드에서 처음 보인 라인의 벌크 수량(첫 업로드 이전 주는 Planning 기록).'), OK],
      [both, T('Which orders count', '집계 대상'), T('Confirmed only' + (set.includeNew ? ' plus unconfirmed (setting on)' : '') + '; open lines older than ' + set.staleDays + ' days go to Data checks.', '확정(confirm)만' + (set.includeNew ? ' + 미확정(설정 켬)' : '') + '; ' + set.staleDays + '일 넘게 열린 라인은 데이터 점검으로.'), OK],
      [both, T('Bulk quantity', '벌크 수량'), T('bulk_order_qty once per SO + bulk code; blank → packs × the count in the product name.', 'SO + 벌크 코드당 bulk_order_qty 한 번; 비어 있으면 병 수 × 제품명의 정수.'), OK],
      ['Sales', T('Sales month', '매출 시점'), T('Packing-finish date; the oERP finish date when that is blank.', '포장 완료일; 없으면 oERP 완료 처리일.'), OK],
      ['Sales', T('Forecast', '예상 매출'), T('Required date + the line\'s median delay over 12 months; overdue lines move to this or next month; client holds have no month.', '납기 + 최근 12개월 제형별 지연 중앙값; 납기 지난 라인은 이번 달 또는 다음 달; Client hold는 시점 미정.'), OK],
      ['Sales', T('1/3 rule', '1/3 규칙'), T('Active backlog ÷ 3, shown next to the forecast.', '진행 중 잔고 ÷ 3, 예상 매출 옆에 표시.'), OK],
      ['Sales', T('Active backlog', '진행 중 잔고'), T('Confirmed backlog without client holds and stalled lines: Hold? candidates, and lines packed over ' + set.packedDays + ' days ago and still not invoiced. Stalled lines have no forecast month until they move.', '확정 잔고에서 Client hold와 정체 의심(Hold? 후보, 포장 후 ' + set.packedDays + '일 넘게 미청구)을 뺀 값. 정체 의심은 움직이기 전까지 예상 월이 없습니다.'), NEW3],
      ['Sales', T('Own brands', '자사 브랜드'), T('Clients whose name starts with Demo Labs or Demo Outlet. The Sales switch leaves them out of the Sales numbers, not out of line capacity.', '고객명이 Demo Labs / Demo Outlet으로 시작하는 오더. 영업 화면 스위치로 영업 숫자에서만 빼고, 라인 캐파 계산에는 그대로 둡니다.'), NEW3]
    ];
    return card('<span class="icon icon--inline">gavel</span>' + T('Rules in use', '적용 기준'),
      T('What each number means. "New" rules come from the teams\' feedback (19, 27 and 28 Oct) and need sign-off.', '숫자별 계산 기준입니다. "신규"는 팀 피드백(10/19, 10/27, 10/28)에서 온 것으로 확정이 필요합니다.'),
      table([H_(T('Team', '팀')), H_(T('Number', '항목')), H_(T('Rule', '기준')), H_(T('Status', '상태'))], R_.map(r => '<tr><td>' + esc(r[0]) + '</td><td class="pd-nowrap"><b>' + esc(r[1]) + '</b></td><td class="pd-wrap">' + esc(r[2]) + '</td><td>' + (r[3] === OK ? '<span class="tag">' + OK + '</span>' : '<span class="tag tag--new">' + esc(r[3]) + '</span>') + '</td></tr>')));
  }
  async function saveSettings() {
    const s = {}; const capDay = {}, monthCap = {};
    root.querySelectorAll('[data-set]').forEach(i => {
      const k = i.dataset.set;
      if (k === 'includeNew') { s.includeNew = i.checked; return; }
      const v = parseFloat(i.value);
      if (k === 'capDay' || k === 'monthCap') { if (isFinite(v) && v > 0) (k === 'capDay' ? capDay : monthCap)[i.dataset.g] = v; return; }
      if (isFinite(v) && v >= 0) s[k] = v;
    });
    s.capDay = capDay; s.monthCap = monthCap;
    if (!(s.doneRatio > 0 && s.doneRatio <= 1)) s.doneRatio = DEFAULTS.doneRatio;
    if (!(s.workDays > 0)) s.workDays = DEFAULTS.workDays;
    s.by = who(); s.at = new Date().toISOString();
    await H.kvPut(K.settings, s);
    S.setRaw = s; recompute(); render();
    const m = $('#pd-setMsg'); if (m) m.textContent = T('Saved.', '저장했습니다.');
  }

  /* ---------- events ---------- */
  function onClick(e) {
    const lg = e.target.closest('[data-pd-lang]');
    if (lg) { S.lang = lg.dataset.pdLang; try { localStorage.setItem(LANG_KEY, S.lang); } catch (x) { /* private mode */ } render(); return; }
    const v = e.target.closest('[data-pd-view]');
    if (v) { if (!allowedViews().some(x => x[0] === v.dataset.pdView)) return; S.view = v.dataset.pdView; try { localStorage.setItem(VIEW_KEY, S.view); } catch (x) { /* private mode */ } render(); root.scrollTop = 0; return; }
    const a = e.target.closest('[data-pd-act]');
    if (!a) return;
    const act = a.dataset.pdAct, key = a.dataset.key;
    if (act === 'state') {
      const s = a.dataset.s, l = R.lines.find(x => x.key === key);
      if (s === 'hold') { S.edit = key; renderReady(); const ed = root.querySelector('.pd-editor select'); if (ed) ed.focus(); return; }
      S.edit = null;
      if (a.classList.contains('active') && !(l && l.hold)) return; // already in that state -- no KV write
      setLineState(key, s === 'active' ? null : s);
    } else if (act === 'auto') { S.edit = null; setLineState(key, null); }
    else if (act === 'edit') { S.edit = S.edit === key ? null : key; renderReady(); }
    else if (act === 'cancelEdit') { S.edit = null; renderReady(); }
    else if (act === 'saveHold' || act === 'release') {
      const ed = a.closest('.pd-editor'), k = ed.dataset.key;
      if (act === 'release') { S.edit = null; setLineState(k, null); return; }
      const f = n => ed.querySelector('[data-f="' + n + '"]').value.trim();
      const rs = f('reason'), by = f('by');
      if (!rs || !by) { ed.querySelector('.pd-editor__err').textContent = !rs ? T('Choose what we are waiting on.', '대기 사유를 고르세요.') : T('Add your name.', '이름을 입력하세요.'); return; }
      try { localStorage.setItem('crmdemo_last_author', by); } catch (x) { /* private mode */ }
      S.edit = null;
      setLineState(k, 'hold', { reason: rs, since: f('since') || today(), note: f('note'), by });
    } else if (act === 'saveUpload') saveUpload();
    else if (act === 'cancelUpload') { S.upload = null; renderUploadBox(); }
    else if (act === 'saveSettings') saveSettings();
    else if (act === 'reviewCand') {
      Object.assign(UI, { rg: 'all', rs: 'pre', rf: 'cand', rq: '' });
      S.view = 'production'; try { localStorage.setItem(VIEW_KEY, S.view); } catch (x) { /* private mode */ }
      render(); const c = $('#pd-readyCard'); if (c) c.scrollIntoView({ block: 'start' });
    } else if (act === 'showStalled') { UI.sStage = 'stalled'; render(); const c = $('#pd-orders'); if (c) c.scrollIntoView({ block: 'start' }); }
    else if (act === 'memoEdit') { const td = a.parentNode; td.innerHTML = memoEditor(key); const i = td.querySelector('input'); i.focus(); i.select(); }
    else if (act === 'memoCancel') { const box = a.closest('.pd-memo'); box.parentNode.innerHTML = memoCell(box.dataset.key); }
    else if (act === 'memoSave') saveMemo(a.closest('.pd-memo'));
    else if (act === 'resetSettings') { root.querySelectorAll('[data-set]').forEach(i => { i.value = ''; }); H.kvPut(K.settings, {}).then(() => { S.setRaw = {}; recompute(); render(); }); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.pdAct === 'file' && t.files && t.files[0]) { readUpload(t.files[0]); t.value = ''; return; }
    const k = t.dataset.pdUi;
    if (!k || k === 'rq' || k === 'sQuery') return;
    if (k === 'upDate') { if (S.upload) { S.upload.date = t.value; renderUploadBox(); } return; }
    if (k === 'upBy') { if (S.upload) S.upload.by = t.value.trim(); return; }
    UI[k] = t.type === 'checkbox' ? t.checked : t.dataset.num ? +t.value : t.value;
    if (k === 'metric' || k === 'range') renderWeekly();
    else if (k === 'rg' || k === 'rs' || k === 'rf') renderReady();
    else render();
  }
  function onKey(e) {
    if (e.target.dataset && e.target.dataset.pdMemo != null) {
      if (e.key === 'Enter') { e.preventDefault(); saveMemo(e.target.closest('.pd-memo')); }
      else if (e.key === 'Escape') { const box = e.target.closest('.pd-memo'); box.parentNode.innerHTML = memoCell(box.dataset.key); }
    } else if (e.key === 'Enter' && e.target.matches('.pd-kpi[data-pd-act]')) e.target.click();
  }
  let qTimer = null;
  function onInput(e) {
    const k = e.target.dataset.pdUi;
    if (k === 'upBy' && S.upload) { S.upload.by = e.target.value.trim(); return; }
    if (k !== 'rq' && k !== 'sQuery') return;
    UI[k] = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      if (k === 'rq') renderReady();
      else { const pos = e.target.selectionStart; render(); const i = root.querySelector('[data-pd-ui="sQuery"]'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
    }, 250);
  }

  // Re-render after the CRM learns the signed-in person's role (template.html applyRole)
  function refresh() { if (root && S.idx) render(); }

  if (typeof window !== 'undefined') window.Production = { mount, refresh, model };
  if (typeof module !== 'undefined') module.exports = { model };
})();
