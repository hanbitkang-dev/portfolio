(function() {
  "use strict";
  const STEPS = [
    { id: "s1", no: "①", team: "sales", pre: [], en: "Order confirmed", ko: "" },
    { id: "s2", no: "②", team: "planning", pre: ["s1"], en: "Plan / MO", ko: "" },
    { id: "s3a", no: "③a", team: "purchase", pre: ["s2"], en: "Raw material PO → receipt", ko: "" },
    { id: "s3b", no: "③b", team: "sales", pre: ["s2"], en: "Artwork / label approval", ko: "" },
    { id: "s3c", no: "③c", team: "purchase", pre: ["s3b"], en: "Packaging / label PO → receipt", ko: "" },
    { id: "s4", no: "④", team: "qa", pre: ["s3a", "s3c"], en: "Incoming QC", ko: "" },
    { id: "s5", no: "⑤", team: "warehouse", pre: ["s4"], en: "Material issue", ko: "" },
    { id: "s6", no: "⑥", team: "production", pre: ["s5"], en: "Bulk production", ko: "" },
    { id: "s7", no: "⑦", team: "production", pre: ["s6"], en: "Packing", ko: "" },
    { id: "s8", no: "⑧", team: "qa", pre: ["s7"], en: "QA release / COA", ko: "" },
    { id: "s9", no: "⑨", team: "warehouse", pre: ["s8"], en: "Dispatch", ko: "" }
  ];
  const STEP = Object.fromEntries(STEPS.map((s) => [s.id, s]));
  const STD_DRAFT = { s1: 2, s2: 2, s3a: 20, s3b: 8, s3c: 12, s4: 2, s5: 1, s6: 4, s7: 3, s8: 3, s9: 2 };
  const TYPE_DRAFT = { hard: 70, soft: 84, tablet: 70, powder: 63, liquid: 63, "liquid hard": 84 };
  const TYPE_DEFAULT = 70;
  const STALE_DAYS = 365;
  const TEAMS = {
    sales: ["Sales", ""],
    planning: ["Planning", ""],
    purchase: ["Purchase", ""],
    qa: ["QA", "QA"],
    production: ["Production", ""],
    warehouse: ["Warehouse", ""],
    external: ["External", ""]
  };
  const CODES = [
    ["SA-1", "sales", "Accepted a date shorter than standard", ""],
    ["SA-2", "sales", "Spec / quantity change", ""],
    ["SA-3", "sales", "Customer artwork / approval late", ""],
    ["SA-4", "sales", "Order registered late", ""],
    ["PL-1", "planning", "Production slot pushed back", ""],
    ["PL-2", "planning", "Capacity shortfall", ""],
    ["PL-3", "planning", "Plan / MO late", ""],
    ["PU-1", "purchase", "Raw material ordered late", ""],
    ["PU-2", "purchase", "Raw material supplier late", ""],
    ["PU-3", "purchase", "Packaging / label ordered late", ""],
    ["PU-4", "purchase", "Packaging / label delivery late", ""],
    ["PU-5", "purchase", "MOQ / stock shortage", ""],
    ["QA-1", "qa", "Incoming QC queue", ""],
    ["QA-2", "qa", "Material out of spec / retest", ""],
    ["QA-3", "qa", "Release / COA waiting", ""],
    ["QA-4", "qa", "New product review", ""],
    ["WH-1", "warehouse", "Receipt processing late", ""],
    ["WH-2", "warehouse", "Material issue late", ""],
    ["WH-3", "warehouse", "Dispatch / freight", ""],
    ["PR-1", "production", "Equipment breakdown", ""],
    ["PR-2", "production", "Staffing", ""],
    ["PR-3", "production", "Process issue / rework", ""],
    ["PR-4", "production", "Yield / defects", ""],
    ["EX-1", "external", "Customer asked to hold", ""],
    ["EX-2", "external", "Certification / regulatory", ""],
    ["EX-3", "external", "Customs", ""]
  ].map(([c, team2, en, ko]) => ({ c, team: team2, en, ko }));
  const CODE = Object.fromEntries(CODES.map((x) => [x.c, x]));
  const CTRL = { internal: ["Internal — we could have prevented it", ""], external: ["External — supplier, regulator, freight", ""], customer: ["Customer — the client asked or was late", ""] };
  const SUGGESTED = [];
  const DAY = 864e5;
  const dOf = (iso) =>  new Date(iso + "T00:00:00");
  const isoOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const today = () => isoOf( new Date());
  const days = (a, b) => a && b ? Math.round((dOf(b) - dOf(a)) / DAY) : null;
  const addDays = (iso, n) => {
    const d = dOf(iso);
    d.setDate(d.getDate() + n);
    return isoOf(d);
  };
  const isWD = (d) => d.getDay() !== 0 && d.getDay() !== 6;
  function addWD(iso, n) {
    const d = dOf(iso);
    for (let k = n; k > 0; ) {
      d.setDate(d.getDate() + 1);
      if (isWD(d)) k--;
    }
    return isoOf(d);
  }
  function wdBetween(a, b) {
    if (!a || !b || a === b) return a && b ? 0 : null;
    let x = dOf(a), y = dOf(b), s = 1, n = 0;
    if (x > y) {
      [x, y] = [y, x];
      s = -1;
    }
    while (x < y) {
      x.setDate(x.getDate() + 1);
      if (isWD(x)) n++;
    }
    return n * s;
  }
  const median = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const quant = (a, q) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const lineKey = (r) => r.so + "|" + r.code + "|" + (r.require_date || "");
  const typeOf = (r) => (r.bulk_type || "").toLowerCase().trim();
  const sev = (d) => d > 30 ? "severe" : d > 14 ? "moderate" : d > 6 ? "mild" : "minor";
  const startOf = (r) => (r.finish_date ? r.date : r.confirm_date || r.date) || null;
  function stagesOf(so, rows, line) {
    const out = {};
    STEPS.forEach((s) => {
      out[s.id] = { started: null, done: null, src: null, ask: false, note: null, cause: null, auto: {} };
    });
    if (line) {
      out.s1.done = startOf(line);
      out.s1.src = "ERP";
      if (line.finish_date) {
        out.s7.done = line.finish_date;
        out.s7.src = "ERP";
      }
    }
    ["kanban", "wms", "manual"].forEach((src) => (rows[so] || []).filter((r) => r.src === src && out[r.step]).forEach((r) => {
      const o = out[r.step];
      if (src !== "manual") o.auto[src] = r;
      if (r.started) o.started = r.started;
      if (r.done) {
        o.done = r.done;
        o.src = src;
      }
      if (src === "manual") {
        o.ask = !!r.ask;
        o.note = r.note;
        o.cause = r.cause;
        o.manual = r;
      }
    }));
    return out;
  }
  function plan(st, std, start) {
    const tgt = {};
    STEPS.forEach((s) => {
      const base = s.pre.length ? s.pre.map((p) => st[p].done || tgt[p]).filter(Boolean).sort().pop() : start;
      tgt[s.id] = base ? addWD(base, +std[s.id] || 0) : null;
    });
    return tgt;
  }
  const answered = (o) => !!(o.note || o.cause || o.done && o.src !== "ERP" || o.started);
  const VIEWS = [["review", "fact_check", "Review", ""], ["cases", "forum", "Cases", ""], ["open", "pending_actions", "Open orders", ""], ["lead", "timer", "Lead times", ""], ["sources", "hub", "Sources", ""]];
  const VIEW_KEY = "dl_view", LANG_KEY = "dl_lang";
  let H = null, root = null;
  const S = { view: "review", lang: "en", d: null, err: null, open: null, saving: false, hist: null };
  const F = { period: "12m", client: "", type: "", status: "all", q: "", excl: false, oq: "", of: "risk" };
  const T = (en, ko) => S.lang === "en" ? en : ko;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const $ = (sel2) => root.querySelector(sel2);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dS = (iso) => iso ? +iso.slice(8, 10) + " " + MON[+iso.slice(5, 7) - 1] + (iso.slice(0, 4) !== today().slice(0, 4) ? " " + iso.slice(0, 4) : "") : "–";
  const dL = (ts) => {
    const d = new Date(ts || "");
    return isNaN(d) ? "–" : dS(isoOf(d));
  };
  const tL = (ts) => {
    const d = new Date(ts || "");
    return isNaN(d) ? "" : isoOf(d) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "–";
  const qs = (n) => {
    const a = Math.abs(n);
    return a >= 1e6 ? (n / 1e6).toFixed(2) + "M" : a >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n));
  };
  const who = (s) => s ? esc(String(s).split("@")[0]) : "";
  const team = (k) => TEAMS[k] ? T(TEAMS[k][0], TEAMS[k][1]) : k;
  const teamTag = (k) => '<span class="dl-team dl-team--' + esc(k) + '">' + esc(team(k)) + "</span>";
  const stepName = (id) => STEP[id] ? STEP[id].no + " " + T(STEP[id].en, STEP[id].ko) : "–";
  const codeName = (c) => CODE[c] ? c + " · " + T(CODE[c].en, CODE[c].ko) : c || "–";
  const showMoney = () => H.role() === "full";
  const STATUS = { open: ["", "No verdict", ""], proposed: ["s-new", "Proposed", ""], confirmed: ["s-finished", "Confirmed", ""] };
  const statusBadge = (st) => {
    const b = STATUS[st] || STATUS.open;
    return '<span class="badge ' + b[0] + ' dl-st">' + T(b[1], b[2]) + "</span>";
  };
  function card(title, hint, body, ctl) {
    return '<section class="dl-card"><div class="dl-card__head"><h3 class="dl-card__title">' + title + "</h3>" + (ctl ? '<div class="dl-ctl">' + ctl + "</div>" : "") + "</div>" + (hint ? '<div class="dl-hint">' + hint + "</div>" : "") + body + "</section>";
  }
  function table(head, rows, empty, cls) {
    return '<div class="table-wrap dl-tw' + (cls ? " " + cls : "") + '"><table class="dl-table"><thead><tr>' + head.map((h) => "<th" + (h[1] ? ' class="num"' : "") + ">" + h[0] + "</th>").join("") + "</tr></thead><tbody>" + (rows.length ? rows.join("") : '<tr><td colspan="' + head.length + '" class="dl-none">' + (empty || T("Nothing to show.", "")) + "</td></tr>") + "</tbody></table></div>";
  }
  const kpi = (lb, v, sm, cls) => '<div class="dl-kpi' + (cls ? " " + cls : "") + '"><div class="dl-kpi__lb">' + lb + '</div><div class="dl-kpi__v">' + v + '</div><div class="dl-kpi__sm">' + (sm || "") + "</div></div>";
  function api(path, body) {
    return fetch("/api/delays" + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" }).then((r) => r.json().catch(() => ({})).then((j) => {
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }));
  }
  function load() {
    return api("").then((d) => {
      d.rv = Object.fromEntries(d.reviews.map((r) => [r.key, r]));
      d.st = {};
      d.steps.forEach((r) => {
        (d.st[r.so] = d.st[r.so] || []).push(r);
      });
      S.d = d;
      S.err = null;
    }).catch((e) => {
      S.err = e.message;
    });
  }
  const stdStage = () => Object.assign({}, STD_DRAFT, (S.d && S.d.settings.lead_std || {}).v || {});
  const stdType = () => Object.assign({}, TYPE_DRAFT, (S.d && S.d.settings.lead_type || {}).v || {});
  const stdFor = (r) => {
    const t = stdType(), k = typeOf(r);
    return t[k] != null ? +t[k] : TYPE_DEFAULT;
  };
  function periodFrom() {
    const n = { "6m": 183, "12m": 365, "2y": 730 }[F.period];
    return n ? addDays(today(), -n) : "";
  }
  function completed() {
    const from = periodFrom();
    return H.orders().filter((r) => r.status !== "cancel" && r.finish_date && r.require_date && r.date && (!from || r.finish_date >= from)).map((r) => {
      const key = lineKey(r), rv = S.d.rv[key] || null, std = stdFor(r);
      const lead = days(r.date, r.require_date), actual = days(r.date, r.finish_date), late = r.delay_days > 0;
      let excl = late && lead < std && actual <= std ? "short" : "";
      if (rv && rv.incl === 1) excl = "";
      else if (rv && rv.incl === 0) excl = "manual";
      return { r, key, rv, std, lead, actual, late, excl };
    });
  }
  function mount(el, host) {
    H = host;
    root = el;
    el.classList.add("dl");
    try {
      S.view = localStorage.getItem(VIEW_KEY) || "review";
      S.lang = "en";
    } catch (e) {
    }
    if (!VIEWS.some((v) => v[0] === S.view)) S.view = "review";
    el.innerHTML = '<div class="dl-head" id="dl-head"></div><div id="dl-banner"></div>' + VIEWS.map((v) => '<section class="dl-view" data-dl-pane="' + v[0] + '"></section>').join("") + '<div class="dl-drawer" id="dl-drawer" hidden><div class="dl-drawer__bg" data-dl-close="1"></div><aside class="dl-drawer__panel" role="dialog" aria-modal="true" id="dl-panel"></aside></div>';
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("input", onInput);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && S.open) closeDrawer();
    });
    renderHead();
    $('[data-dl-pane="' + S.view + '"]').innerHTML = '<div class="empty">Loading…</div>';
    $('[data-dl-pane="' + S.view + '"]').classList.add("active");
    load().then(render);
  }
  function refresh() {
    if (root) load().then(render);
  }
  function renderHead() {
    const n = H.orders().length;
    $("#dl-head").innerHTML = '<div><div class="dl-eyebrow">' + T("Operations · delays", "") + '</div><h2 class="dl-title">' + T("Delays — why orders were late", "") + '</h2><div class="dl-sub">' + T("Order data: ERP, ", "") + n.toLocaleString() + T(" lines · verdicts and stage dates are shared (saved per change)", "") + '</div></div><div class="dl-headctl"><div class="seg" id="dl-views">' + VIEWS.map((v) => '<button type="button" data-dl-view="' + v[0] + '"' + (v[0] === S.view ? ' class="active"' : "") + '><span class="icon icon--inline">' + v[1] + "</span>" + T(v[2], v[3]) + "</button>").join("") + "</div></div>";
  }
  function render() {
    renderHead();
    root.querySelectorAll(".dl-view").forEach((p) => p.classList.toggle("active", p.dataset.dlPane === S.view));
    $("#dl-banner").innerHTML = S.err ? '<div class="dl-alert dl-alert--red"><span class="icon">error</span><div>' + T("Could not load the Delays data: ", "") + esc(S.err) + ' <button type="button" class="btn btn--sm" data-dl-act="reload">' + T("Try again", "") + "</button></div></div>" : "";
    const pane = $('[data-dl-pane="' + S.view + '"]');
    if (!S.d) {
      pane.innerHTML = "";
      return;
    }
    ({ review: renderReview, cases: renderCases, open: renderOpen, lead: renderLead, sources: renderSources })[S.view](pane);
    if (S.open) renderDrawer();
  }
  function renderReview(pane) {
    const all = completed();
    const clients = [...new Set(all.filter((x) => x.late).map((x) => x.r.customer))].sort();
    const types = [...new Set(all.map((x) => typeOf(x.r)).filter(Boolean))].sort();
    const lateIn = all.filter((x) => x.late && !x.excl);
    const q = F.q.toLowerCase();
    const shown = all.filter((x) => x.late && (F.excl ? x.excl : !x.excl) && (!F.client || x.r.customer === F.client) && (!F.type || typeOf(x.r) === F.type) && (F.status === "all" || (x.rv ? x.rv.status : "open") === F.status || F.status === "case" && x.rv && x.rv.is_case) && (!q || (x.r.so + " " + x.r.customer + " " + x.r.name + " " + x.r.code).toLowerCase().includes(q))).sort((a, b) => b.r.delay_days - a.r.delay_days);
    const onTime = all.filter((x) => !x.late).length;
    const conf = lateIn.filter((x) => x.rv && x.rv.status === "confirmed").length, prop = lateIn.filter((x) => x.rv && x.rv.status === "proposed").length;
    const filters = '<div class="dl-filters">' + sel("period", [["6m", T("Last 6 months", "")], ["12m", T("Last 12 months", "")], ["2y", T("Last 2 years", "")], ["all", T("All time", "")]], F.period) + sel("client", [["", T("All clients", "")]].concat(clients.map((c) => [c, c])), F.client) + sel("type", [["", T("All types", "")]].concat(types.map((t) => [t, t])), F.type) + sel("status", [["all", T("Any verdict", "")], ["open", T("No verdict yet", "")], ["proposed", T("Proposed", "")], ["confirmed", T("Confirmed", "")], ["case", T("Review cases", "")]], F.status) + '<input class="input input--sm" type="search" data-dl-f="q" value="' + esc(F.q) + '" placeholder="' + T("SO, client, product", "") + '"><label class="check-label"><input type="checkbox" data-dl-f="excl"' + (F.excl ? " checked" : "") + "> " + T("Show the lines left out instead", "") + "</label></div>";
    const money = showMoney();
    const head = [[T("SO · client", "")], [T("Product", "")], [T("Ordered → required", "")], [T("Packed", ""), 0], [T("Late", ""), 1], [T("Verdict", "")], [T("Status", "")]];
    if (money) head.splice(5, 0, [T("Value", ""), 1]);
    const rows = shown.slice(0, 400).map((x) => {
      const r = x.r, rv = x.rv || {};
      return '<tr class="dl-row" data-dl-open="' + esc(x.key) + '" tabindex="0"><td class="dl-cl"><b>' + esc(r.so) + "</b>" + (rv.is_case ? ' <span class="badge s-confirm">' + T("case", "") + "</span>" : "") + '<div class="dl-dim">' + esc(r.customer) + '</div></td><td class="dl-prodcell">' + esc(r.name) + '<div class="dl-dim">' + esc(r.code) + " · " + esc(r.bulk_type || "–") + '</div></td><td class="dl-nowrap">' + dS(r.date) + " → " + dS(r.require_date) + '<div class="dl-dim">' + T("lead ", "") + x.lead + T(" d · standard ", "") + x.std + T(" d", "") + '</div></td><td class="dl-nowrap">' + dS(r.finish_date) + '<div class="dl-dim">' + x.actual + T(" days", "") + '</div></td><td class="num"><span class="dl-late dl-late--' + sev(r.delay_days) + '">+' + r.delay_days + "</span>" + (x.excl ? '<div class="dl-dim">' + (x.excl === "short" ? T("short lead", "") : T("left out", "")) + "</div>" : "") + "</td>" + (money ? '<td class="num dl-nowrap">' + (r.value ? (r.cur && r.cur !== "NZD" ? esc(r.cur) + " " : "") + qs(r.value) : "–") + "</td>" : "") + '<td class="dl-verdict">' + (rv.cause ? "<b>" + esc(codeName(rv.cause)) + '</b><div class="dl-dim">' + esc(stepName(rv.step)) + (rv.ctrl ? " · " + esc(T(CTRL[rv.ctrl][0], CTRL[rv.ctrl][1]).split(" — ")[0]) : "") + "</div>" : '<span class="dl-dim">–</span>') + "</td><td>" + statusBadge(rv.status) + "</td></tr>";
    });
    pane.innerHTML = '<div class="dl-kpis">' + kpi(T("Completed lines", ""), all.length, T("packed in the period", "")) + kpi(T("On time", ""), pct(onTime, all.length), onTime + T(" lines packed by the required date", "")) + kpi(T("Late, counted", ""), lateIn.length, T("median ", "") + (median(lateIn.map((x) => x.r.delay_days)) ?? "–") + T(" days late", ""), lateIn.length ? "dl-kpi--warn" : "") + kpi(T("Left out", ""), all.filter((x) => x.late && x.excl).length, T("short lead, finished within standard", "")) + kpi(T("Verdicts", ""), conf + " / " + lateIn.length, prop + T(" proposed, waiting for Planning", "")) + "</div>" + breakdown(lateIn) + card(
      T("Late lines", ""),
      T(
        "Click a line to record why it was late: the stage where the time went, a cause code and whether we could have prevented it. Planning confirms each verdict. Lines the client asked for faster than standard and that we still finished within standard are left out, as before.",
        ""
      ),
      filters + table(head, rows, T("No late lines match.", ""), "dl-tw--tall") + (shown.length > 400 ? '<div class="dl-foot">' + T("First 400 of ", "") + shown.length + "</div>" : "")
    );
  }
  function sel(f, opts, cur) {
    return '<select class="select select--sm" data-dl-f="' + f + '">' + opts.map((o) => '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select>";
  }
  function breakdown(lateIn) {
    const withV = lateIn.filter((x) => x.rv && x.rv.cause);
    if (!withV.length) return "";
    const by = (fn) => {
      const m = {};
      withV.forEach((x) => {
        const k = fn(x);
        if (!k) return;
        m[k] = m[k] || { n: 0, d: 0, c: 0 };
        m[k].n++;
        m[k].d += x.r.delay_days;
        if (x.rv.status === "confirmed") m[k].c++;
      });
      return Object.entries(m).sort((a, b) => b[1].d - a[1].d);
    };
    const bars = (list, label) => {
      const max = Math.max(...list.map((e) => e[1].d));
      return list.slice(0, 8).map(([k, v]) => '<div class="dl-bar"><span class="dl-bar__lb">' + label(k) + '</span><span class="dl-bar__track"><i style="width:' + Math.max(3, v.d / max * 100) + '%"></i></span><span class="dl-bar__v">' + v.n + T(" lines · ", "") + v.d + T(" d", "") + "</span></div>").join("");
    };
    const ctrl = by((x) => x.rv.ctrl);
    return card(
      T("Where the time went", ""),
      T("Lines with a verdict (proposed or confirmed), weighted by days late. ", "") + withV.length + T(" of ", " / ") + lateIn.length + T(" late lines so far.", ""),
      '<div class="dl-grid3"><div><div class="dl-sublb">' + T("By department", "") + "</div>" + bars(by((x) => CODE[x.rv.cause] && CODE[x.rv.cause].team), (k) => teamTag(k)) + '</div><div><div class="dl-sublb">' + T("By stage", "") + "</div>" + bars(by((x) => x.rv.step), (k) => esc(stepName(k))) + '</div><div><div class="dl-sublb">' + T("By cause", "") + "</div>" + bars(by((x) => x.rv.cause), (k) => esc(codeName(k))) + (ctrl.length ? '<div class="dl-sublb" style="margin-top:10px">' + T("Could we have prevented it?", "") + "</div>" + bars(ctrl, (k) => esc(T(CTRL[k][0], CTRL[k][1]).split(" — ")[0])) : "") + "</div></div>"
    );
  }
  function caseState(x, st) {
    if (x.rv && x.rv.status === "confirmed") return ["agreed", "s-finished", T("Agreed", "")];
    const asks = STEPS.filter((s) => st[s.id].ask);
    if (!asks.length) return ["prep", "", T("Pick stages to ask", "")];
    const open = asks.filter((s) => !answered(st[s.id])).length;
    return open ? ["waiting", "s-new", T(open + " answer" + (open > 1 ? "s" : "") + " to come", "" + open)] : ["ready", "s-confirm", T("Ready to agree", "")];
  }
  function renderCases(pane) {
    const byKey = Object.fromEntries(completed().map((x) => [x.key, x]));
    const cases = S.d.reviews.filter((r) => r.is_case).map((r) => {
      const x = byKey[r.key] || orderLine(r.key);
      return x ? { x, st: stagesOf(x.r.so, S.d.st, x.r) } : null;
    }).filter(Boolean).sort((a, b) => (b.x.r.delay_days || 0) - (a.x.r.delay_days || 0));
    if (!cases.length) {
      pane.innerHTML = card(
        T("Review cases", ""),
        T(
          "A case is a late line the departments look at together, stage by stage, to find where the time went and to set the stage standards. Mark any late line as a case from its Review panel, or start with the ten suggested in the 16 Oct design.",
          ""
        ),
        '<button type="button" class="btn btn--primary" data-dl-act="suggest"' + (S.saving ? " disabled" : "") + '><span class="icon icon--inline">playlist_add</span>' + T("Load the 10 suggested cases", "") + "</button>"
      );
      return;
    }
    const asksByTeam = {};
    cases.forEach(({ x, st }) => STEPS.forEach((s) => {
      if (st[s.id].ask && !answered(st[s.id])) (asksByTeam[s.team] = asksByTeam[s.team] || []).push({ x, s });
    }));
    const teamsOpen = Object.keys(asksByTeam);
    const counts = {};
    cases.forEach((c) => {
      const k = caseState(c.x, c.st)[0];
      counts[k] = (counts[k] || 0) + 1;
    });
    pane.innerHTML = '<div class="dl-kpis">' + kpi(T("Cases", ""), cases.length) + kpi(T("Waiting for answers", ""), counts.waiting || 0, "", counts.waiting ? "dl-kpi--warn" : "") + kpi(T("Ready to agree", ""), counts.ready || 0) + kpi(T("Agreed", ""), counts.agreed || 0) + "</div>" + card(
      T("Questions to send", ""),
      T(
        "Open questions per department. Copy them into the department's Kanban board or Chat; type the answer into the stage when it comes back (or it arrives from Kanban once that is connected).",
        ""
      ),
      teamsOpen.length ? '<div class="dl-asks">' + teamsOpen.map((k) => '<div class="dl-ask"><div class="dl-ask__head">' + teamTag(k) + " <b>" + asksByTeam[k].length + '</b><button type="button" class="btn btn--sm" data-dl-copy="' + esc(k) + '"><span class="icon icon--inline">content_copy</span>' + T("Copy", "") + "</button></div><ul>" + asksByTeam[k].map((a) => '<li><button type="button" class="dl-link" data-dl-open="' + esc(a.x.key) + '">' + esc(a.x.r.so) + "</button> " + esc(a.s.no + " " + T(a.s.en, a.s.ko)) + ' <span class="dl-dim">' + esc(a.x.r.name) + "</span></li>").join("") + "</ul></div>").join("") + "</div>" : '<div class="dl-none">' + T("No open questions.", "") + "</div>"
    ) + '<div class="dl-cases">' + cases.map(({ x, st }) => {
      const cs = caseState(x, st), rv = x.rv || {};
      return '<article class="dl-case dl-case--' + cs[0] + '"><div class="dl-case__head"><button type="button" class="dl-link" data-dl-open="' + esc(x.key) + '"><b>' + esc(x.r.so) + '</b></button><span class="badge ' + cs[1] + '">' + esc(cs[2]) + '</span></div><div class="dl-case__t">' + esc(x.r.name) + '</div><div class="dl-dim">' + esc(x.r.customer) + " · " + esc(x.r.bulk_type || "") + '</div><div class="dl-case__nums">' + T("Lead ", "") + (x.lead ?? "–") + T(" d · took ", "") + (x.actual ?? "–") + T(" d · ", "") + '<span class="dl-late dl-late--' + sev(x.r.delay_days || 0) + '">+' + (x.r.delay_days ?? "–") + "</span></div>" + (rv.why ? '<div class="dl-case__why">' + esc(rv.why) + "</div>" : "") + '<div class="dl-case__asks">' + STEPS.filter((s) => st[s.id].ask).map((s) => '<span class="dl-pill' + (answered(st[s.id]) ? " dl-pill--ok" : "") + '" title="' + esc(team(s.team)) + '">' + esc(s.no + " " + T(s.en, s.ko)) + "</span>").join("") + "</div>" + (rv.cause ? '<div class="dl-case__v"><b>' + esc(codeName(rv.cause)) + "</b> · " + esc(stepName(rv.step)) + "</div>" : "") + "</article>";
    }).join("") + "</div>";
  }
  function orderLine(key) {
    const r = H.orders().find((o) => lineKey(o) === key);
    if (!r) return null;
    return { r, key, rv: S.d.rv[key] || null, std: stdFor(r), lead: days(r.date, r.require_date), actual: days(r.date, r.finish_date), late: r.delay_days > 0, excl: "" };
  }
  function suggest() {
    const lines = [], asks = [];
    SUGGESTED.forEach(([so, code, ask, en, ko]) => {
      const r = H.orders().find((o) => o.so === so && o.code === code && o.finish_date);
      if (!r) return;
      lines.push({ key: lineKey(r), so, why: T(en, ko) });
      ask.forEach((step) => asks.push({ so, step }));
    });
    if (!lines.length) return alert(T("None of the suggested orders are in this data.", ""));
    save(() => api("/cases", { lines, asks }));
  }
  function copyAsks(k) {
    const byKey = Object.fromEntries(completed().map((x) => [x.key, x]));
    const lines = [];
    S.d.reviews.filter((r) => r.is_case).forEach((rv) => {
      const x = byKey[rv.key] || orderLine(rv.key);
      if (!x) return;
      const st = stagesOf(x.r.so, S.d.st, x.r);
      STEPS.filter((s) => s.team === k && st[s.id].ask && !answered(st[s.id])).forEach((s) => {
        lines.push("- [" + x.r.so + "] " + x.r.name + " (" + x.r.customer + ") — " + s.no + " " + T(s.en, s.ko) + ": " + T(
          "ordered " + x.r.date + ", required " + x.r.require_date + ", packed " + x.r.finish_date + " (+" + x.r.delay_days + " days). When did this stage start and finish, and what held it up?",
          "" + x.r.date + x.r.require_date + x.r.finish_date + " (+" + x.r.delay_days
        ));
      });
    });
    const text = T("Delay review — questions for ", "") + team(k) + "\n" + lines.join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => flash(T("Copied ", "") + lines.length + T(" questions", "")), () => prompt(T("Copy this:", ""), text));
  }
  function renderOpen(pane) {
    const t = today(), std = stdStage(), q = F.oq.toLowerCase(), staleFrom = addDays(t, -STALE_DAYS);
    const open = H.orders().filter((r) => r.status === "confirm" && !r.finish_date);
    const stale = open.filter((r) => (startOf(r) || "") < staleFrom).length;
    const lines = open.filter((r) => (startOf(r) || "") >= staleFrom).map((r) => {
      const st = stagesOf(r.so, S.d.st, r), start = startOf(r), tgt = plan(st, std, start);
      const stdEnd = start ? addDays(start, stdFor(r)) : null;
      const cur = (S.d.st[r.so] || []).length ? STEPS.find((s) => !st[s.id].done) || null : null;
      const left = days(t, r.require_date);
      const curLate = cur && tgt[cur.id] && tgt[cur.id] < t ? wdBetween(tgt[cur.id], t) : 0;
      const risk = left != null && left < 0 ? "late" : stdEnd && r.require_date && stdEnd > r.require_date || left != null && left <= 14 || curLate > 0 ? "risk" : "ok";
      return { r, key: lineKey(r), st, tgt, stdEnd, cur, left, curLate, risk };
    }).filter((x) => (F.of === "all" || x.risk === F.of || F.of === "risk" && x.risk === "late") && (!q || (x.r.so + " " + x.r.customer + " " + x.r.name).toLowerCase().includes(q))).sort((a, b) => (a.left ?? 9999) - (b.left ?? 9999));
    const anyStage = Object.keys(S.d.st).length;
    pane.innerHTML = card(
      T("Open orders", ""),
      T(
        'Confirmed lines not packed yet. "Standard finish" = confirmed date + the standard for the type; the stage targets chain the stage standards from the actual dates recorded so far. ',
        ""
      ) + (anyStage ? T("The current stage shows only for orders with recorded stage dates. ", "") : T("No stage dates are recorded yet (WMS and Kanban are not connected), so there is no current stage. ", "")) + (stale ? T(stale + " lines confirmed over a year ago are left out (Production › Data checks lists them).", "" + stale) : ""),
      '<div class="dl-filters"><div class="seg seg--sm">' + [["risk", T("Late or at risk", "")], ["late", T("Past required date", "")], ["all", T("All", "")]].map(([k, n]) => '<button type="button" data-dl-of="' + k + '"' + (F.of === k ? ' class="active"' : "") + ">" + n + "</button>").join("") + '</div><input class="input input--sm" type="search" data-dl-f="oq" value="' + esc(F.oq) + '" placeholder="' + T("SO, client, product", "") + '"></div>' + table(
        [[T("SO · client", "")], [T("Product", "")], [T("Confirmed", "")], [T("Required", "")], [T("Days left", ""), 1], [T("Standard finish", "")], [T("Current stage (target)", "")]],
        lines.slice(0, 300).map((x) => '<tr class="dl-row" data-dl-open="' + esc(x.key) + '" tabindex="0"><td class="dl-cl"><b>' + esc(x.r.so) + '</b><div class="dl-dim">' + esc(x.r.customer) + '</div></td><td class="dl-prodcell">' + esc(x.r.name) + '<div class="dl-dim">' + esc(x.r.code) + " · " + esc(x.r.bulk_type || "–") + '</div></td><td class="dl-nowrap">' + dS(x.r.confirm_date || x.r.date) + '</td><td class="dl-nowrap">' + dS(x.r.require_date) + '</td><td class="num"><span class="' + (x.left < 0 ? "dl-bad" : x.left <= 14 ? "dl-warn" : "") + '">' + (x.left ?? "–") + '</span></td><td class="dl-nowrap">' + dS(x.stdEnd) + (x.stdEnd && x.r.require_date && x.stdEnd > x.r.require_date ? '<div class="dl-warn">' + T("after the required date by ", "") + days(x.r.require_date, x.stdEnd) + T(" d", "") + "</div>" : "") + "</td><td>" + (x.cur ? esc(stepName(x.cur.id)) + " " + teamTag(x.cur.team) + '<div class="dl-dim">' + dS(x.tgt[x.cur.id]) + (x.curLate ? ' · <span class="dl-bad">' + x.curLate + T(" working days over", "") + "</span>" : "") + "</div>" : '<span class="dl-dim">' + T("no stage dates", "") + "</span>") + "</td></tr>"),
        T("No open lines match.", ""),
        "dl-tw--tall"
      )
    );
  }
  function renderLead(pane) {
    const ts = stdType(), ss = stdStage();
    const fin = H.orders().filter((r) => r.status !== "cancel" && r.finish_date && r.date && r.finish_date >= addDays(today(), -365));
    const types = [...new Set(Object.keys(TYPE_DRAFT).concat(fin.map(typeOf).filter(Boolean)))];
    const typeRows = types.map((k) => {
      const ls = fin.filter((r) => typeOf(r) === k), act = ls.map((r) => days(r.date, r.finish_date)).filter((n) => n != null);
      const within = act.filter((n) => n <= (+ts[k] || TYPE_DEFAULT)).length, onT = ls.filter((r) => !(r.delay_days > 0)).length;
      return "<tr><td><b>" + esc(k) + '</b></td><td class="num"><input class="input input--sm dl-num" type="number" min="0" max="400" data-dl-type="' + esc(k) + '" value="' + (ts[k] ?? TYPE_DEFAULT) + '"></td><td class="num">' + ls.length + '</td><td class="num">' + (median(act) ?? "–") + '</td><td class="num">' + (quant(act, 0.75) ?? "–") + '</td><td class="num">' + pct(within, act.length) + '</td><td class="num">' + pct(onT, ls.length) + "</td></tr>";
    });
    const dur = {};
    Object.keys(S.d.st).forEach((so) => {
      const st = stagesOf(so, S.d.st, null);
      STEPS.forEach((s) => {
        const o = st[s.id], from = o.started || s.pre.map((p) => st[p].done).filter(Boolean).sort().pop();
        if (o.done && from) (dur[s.id] = dur[s.id] || []).push(wdBetween(from, o.done));
      });
    });
    const meta = (k) => {
      const m = S.d.settings[k];
      return m ? T("Last changed by ", "") + who(m.who) + " · " + dL(m.at) : T("Draft values from the design — not agreed yet.", "");
    };
    const cp = (() => {
      const tg = plan(Object.fromEntries(STEPS.map((s) => [s.id, {}])), ss, "2026-01-05");
      return wdBetween("2026-01-05", tg.s9);
    })();
    pane.innerHTML = card(
      T("Standard by type (calendar days, order → packed)", ""),
      T('Used for the short-lead rule in Review and for "Standard finish" in Open orders. Next to it, what the last 12 months of completed lines actually took. ', "") + meta("lead_type"),
      table([[T("Type", "")], [T("Standard", ""), 1], [T("Lines", ""), 1], [T("Median", ""), 1], [T("75th pct", "75%"), 1], [T("Within standard", ""), 1], [T("By required date", ""), 1]], typeRows),
      '<button type="button" class="btn btn--sm" data-dl-act="save-type">' + T("Save", "") + "</button>"
    ) + card(
      T("Stage standards (working days)", ""),
      T("Each stage's target = the later of the stages before it + this many working days. The critical path adds up to ", "") + "<b>" + cp + T(" working days", "") + "</b>. " + meta("lead_std") + " " + T("Recorded actuals fill in as cases are answered and Kanban / WMS send dates.", ""),
      table(
        [[T("Stage", "")], [T("Team", "")], [T("Standard", ""), 1], [T("Recorded", ""), 1], [T("Median actual", ""), 1]],
        STEPS.map((s) => "<tr><td>" + esc(stepName(s.id)) + "</td><td>" + teamTag(s.team) + '</td><td class="num"><input class="input input--sm dl-num" type="number" min="0" max="200" data-dl-std="' + s.id + '" value="' + (ss[s.id] ?? "") + '"></td><td class="num">' + ((dur[s.id] || []).length || "–") + '</td><td class="num">' + (median(dur[s.id] || []) ?? "–") + "</td></tr>")
      ),
      '<button type="button" class="btn btn--sm" data-dl-act="save-std">' + T("Save", "") + "</button>"
    );
  }
  function renderSources(pane) {
    const k = S.d.kanban, src = S.d.sources, bk = (S.d.settings.backup_last || {}).v;
    const last = H.orders().reduce((m, r) => [r.date, r.confirm_date, r.finish_date].reduce((a, d) => d && d > a ? d : a, m), "");
    const rules = Object.entries(k.rules).map(([b, rs]) => rs.length ? rs.map((r) => "<tr><td>" + esc(b) + "</td><td>" + (r.to ? T("moved to ", "") + "<b>" + esc(r.to) + "</b>" : T("label ", "") + "<b>" + esc(r.label) + "</b>") + "</td><td>" + esc(stepName(r.step)) + " — " + (r.set === "done" ? T("done", "") : T("started", "")) + "</td></tr>").join("") : "<tr><td>" + esc(b) + '</td><td colspan="2" class="dl-dim">' + T("kept, not used for stages yet", "") + "</td></tr>").join("");
    pane.innerHTML = '<div class="dl-kpis">' + kpi("ERP", dS(last), T("latest date in the order data (rebuilt with each export)", "")) + kpi("Kanban", src.hook ? k.boards.reduce((n, b) => n + b.events, 0) + T(" events", "") : T("Not connected", ""), src.hook ? T("receiving at /api/hooks/kanban", "") : T("waiting for IT (question list in the design doc)", ""), src.hook ? "" : "dl-kpi--muted") + kpi("WMS", T("Not connected", ""), T("needs a read-only API key", ""), "dl-kpi--muted") + kpi(T("Backup", ""), bk ? dS(bk.day) : "–", bk ? bk.keys + T(" KV keys copied, kept 14 days", "") : T("runs daily at 02:30", "")) + "</div>" + card(
      T("Kanban cards without an SO", ""),
      T(
        'A card is linked to an order by "[SO-02787]" at the start of its title. Cards without one are listed here; type the SO to link them and their stage dates are recalculated.',
        ""
      ),
      table(
        [[T("Board", "")], [T("Card", "")], [T("Last change", "")], ["SO"]],
        k.unmatched.map((c) => "<tr><td>" + esc(c.board) + '</td><td class="dl-wrap">' + esc(c.title || c.card) + '</td><td class="dl-nowrap">' + dL(c.last_at) + '</td><td class="dl-nowrap"><input class="input input--sm dl-soin" placeholder="SO02787" data-dl-map="' + esc(c.board + "\n" + c.card) + '"> <button type="button" class="btn btn--sm" data-dl-act="map" data-dl-card="' + esc(c.board + "\n" + c.card) + '">' + T("Link", "") + "</button></td></tr>"),
        T("None.", "")
      )
    ) + card(
      T("Latest Kanban changes", ""),
      "",
      table(
        [[T("When", "")], [T("Board", "")], ["SO"], [T("Card", "")], [T("Change", "")]],
        k.recent.map((e) => '<tr><td class="dl-nowrap">' + esc(tL(e.at)) + "</td><td>" + esc(e.board) + "</td><td>" + esc(e.so || "–") + '</td><td class="dl-wrap">' + esc(e.title || e.card) + '</td><td class="dl-wrap">' + esc([e.from_col, e.to_col].filter(Boolean).join(" → ") || e.type || "") + "</td></tr>"),
        T("Nothing received yet.", "")
      )
    ) + card(
      T("How Kanban columns map to stages", ""),
      T("From the boards as seen on 28 Oct; to be confirmed with IT before relying on them.", ""),
      table([[T("Board", "")], [T("When", "")], [T("Stage", "")]], [rules])
    );
  }
  function openDrawer(key) {
    S.open = key;
    S.hist = null;
    S.drawn = null;
    renderDrawer();
    $("#dl-drawer").hidden = false;
  }
  function closeDrawer() {
    S.open = null;
    S.drawn = null;
    $("#dl-drawer").hidden = true;
  }
  const fieldSig = (el) => (el.closest("[data-dl-step]") ? el.closest("[data-dl-step]").dataset.dlStep : "") + ":" + (el.dataset.dlV || el.dataset.dlSf);
  function renderDrawer() {
    const panel = $("#dl-panel");
    const fields = () => [...panel.querySelectorAll("[data-dl-v],[data-dl-sf]")];
    const keep = S.drawn === S.open ? fields().map((el) => [fieldSig(el), el.type === "checkbox" ? el.checked : el.value]) : null;
    const focus = keep && panel.contains(document.activeElement) && document.activeElement.matches("[data-dl-v],[data-dl-sf]") ? fieldSig(document.activeElement) : null;
    drawLine(panel);
    S.drawn = S.open;
    if (!keep) return;
    const m = new Map(keep);
    fields().forEach((el) => {
      const k = fieldSig(el);
      if (m.has(k)) {
        if (el.type === "checkbox") el.checked = m.get(k);
        else el.value = m.get(k);
      }
      if (k === focus) el.focus();
    });
  }
  function drawLine(panel) {
    const x = completed().find((c) => c.key === S.open) || orderLine(S.open);
    if (!x) {
      panel.innerHTML = '<div class="dl-none">' + T("This line is not in the order data.", "") + "</div>";
      return;
    }
    const r = x.r, rv = x.rv || {}, done = !!r.finish_date;
    const st = stagesOf(r.so, S.d.st, r), tgt = plan(st, stdStage(), startOf(r));
    const others = H.orders().filter((o) => o.so === r.so && lineKey(o) !== x.key);
    const codeOpts = '<option value="">—</option>' + Object.keys(TEAMS).map((k) => '<optgroup label="' + esc(team(k)) + '">' + CODES.filter((c) => c.team === k).map((c) => '<option value="' + c.c + '"' + (rv.cause === c.c ? " selected" : "") + ">" + esc(codeName(c.c)) + "</option>").join("") + "</optgroup>").join("");
    const stepOpts = '<option value="">—</option>' + STEPS.map((s) => '<option value="' + s.id + '"' + (rv.step === s.id ? " selected" : "") + ">" + esc(stepName(s.id)) + "</option>").join("");
    const srcTag = (o) => o.src ? '<span class="dl-src dl-src--' + esc(o.src) + '">' + esc(o.src) + "</span>" : "";
    panel.innerHTML = '<div class="dl-dr__head"><div><div class="dl-eyebrow">' + esc(r.customer) + '</div><h3 class="dl-dr__title">' + esc(r.so) + " · " + esc(r.name) + '</h3><div class="dl-dim">' + esc(r.code) + " · " + esc(r.bulk_type || "–") + " · " + (r.qty || 0).toLocaleString() + T(" units", "") + (others.length ? T(" · same SO: ", "") + others.map((o) => esc(o.code)).join(", ") : "") + '</div></div><button type="button" class="btn btn--sm" data-dl-close="1" aria-label="Close"><span class="icon">close</span></button></div><div class="dl-facts">' + fact(T("Ordered", ""), dS(r.date)) + (done ? "" : fact(T("Confirmed", ""), dS(r.confirm_date))) + fact(T("Required", ""), dS(r.require_date), x.lead != null ? T("lead ", "") + x.lead + T(" d", "") : "") + fact(T("Standard", ""), x.std + T(" days", ""), esc(r.bulk_type || T("default", ""))) + (done ? fact(T("Packed", ""), dS(r.finish_date), x.actual + T(" days", "")) + fact(T("Late", ""), '<span class="dl-late dl-late--' + sev(r.delay_days) + '">' + (r.delay_days > 0 ? "+" : "") + r.delay_days + "</span>", r.delay_days > 0 ? T(sev(r.delay_days), { severe: "", moderate: "", mild: "", minor: "" }[sev(r.delay_days)]) : T("on time", "")) : fact(T("Days left", ""), String(days(today(), r.require_date)))) + "</div>" + (done && x.late ? '<div class="dl-countrow">' + T("Counted in the review: ", "") + '<select class="select select--sm" data-dl-incl="1">' + [["", T("rule decides", "") + (x.lead < x.std && x.actual <= x.std ? T(" (left out: short lead)", "") : T(" (counted)", ""))], ["1", T("always count", "")], ["0", T("never count", "")]].map(([v, n]) => '<option value="' + v + '"' + (String(rv.incl ?? "") === v ? " selected" : "") + ">" + esc(n) + "</option>").join("") + "</select></div>" : "") + '<h4 class="dl-dr__h">' + T("Stages", "") + ' <span class="dl-dim">' + T("— dates shared by every line of ", "— ") + esc(r.so) + T("", "") + '</span></h4><div class="table-wrap dl-tw"><table class="dl-table dl-stages"><thead><tr><th>' + T("Stage", "") + "</th><th>" + T("Started", "") + "</th><th>" + T("Done", "") + '</th><th class="num">' + T("Took", "") + "</th><th>" + T("Target", "") + "</th><th>" + T("Ask", "") + "</th><th>" + T("Answer / note", "") + "</th></tr></thead><tbody>" + STEPS.map((s) => {
      const o = st[s.id], from = o.started || s.pre.map((p) => st[p].done).filter(Boolean).sort().pop(), took = o.done && from ? wdBetween(from, o.done) : null, std = +stdStage()[s.id] || 0;
      const auto = Object.entries(o.auto).map(([k, a]) => '<div class="dl-dim">' + esc(k) + ": " + (a.started ? dS(a.started) + " → " : "") + (a.done ? dS(a.done) : "…") + "</div>").join("");
      return '<tr data-dl-step="' + s.id + '"><td class="dl-nowrap">' + esc(s.no + " " + T(s.en, s.ko)) + "<div>" + teamTag(s.team) + '</div></td><td><input class="input input--sm dl-date" type="date" data-dl-sf="started" value="' + esc(o.manual && o.manual.started || "") + '">' + (o.started && !(o.manual && o.manual.started) ? '<div class="dl-dim">' + dS(o.started) + "</div>" : "") + '</td><td><input class="input input--sm dl-date" type="date" data-dl-sf="done" value="' + esc(o.manual && o.manual.done || "") + '">' + (o.done && !(o.manual && o.manual.done) ? '<div class="dl-dim">' + dS(o.done) + " " + srcTag(o) + "</div>" : "") + auto + '</td><td class="num">' + (took == null ? "–" : '<span class="' + (took > std ? "dl-bad" : "") + '">' + took + '</span><div class="dl-dim">/ ' + std + "</div>") + '</td><td class="dl-nowrap">' + dS(tgt[s.id]) + (!done && !o.done && tgt[s.id] && tgt[s.id] < today() ? '<div class="dl-bad">' + T("overdue", "") + "</div>" : "") + '</td><td><input type="checkbox" data-dl-sf="ask"' + (o.ask ? " checked" : "") + ' title="' + T("Ask this department", "") + '"></td><td><input class="input input--sm dl-note" data-dl-sf="note" value="' + esc(o.note || "") + '" maxlength="2000" placeholder="' + T("what happened", "") + '"></td></tr>';
    }).join("") + '</tbody></table></div><div class="dl-dim dl-small">' + T("Dates typed here override Kanban / WMS / ERP for that stage. Changes save when you leave the field.", "") + "</div>" + (done ? '<h4 class="dl-dr__h">' + T("Verdict", "") + " " + statusBadge(rv.status) + '</h4><div class="dl-form"><label>' + T("Stage where the time went", "") + '<select class="select select--sm" data-dl-v="step">' + stepOpts + "</select></label><label>" + T("Cause", "") + '<select class="select select--sm" data-dl-v="cause">' + codeOpts + "</select></label><label>" + T("Could we have prevented it?", "") + '<select class="select select--sm" data-dl-v="ctrl"><option value="">—</option>' + Object.keys(CTRL).map((k) => '<option value="' + k + '"' + (rv.ctrl === k ? " selected" : "") + ">" + esc(T(CTRL[k][0], CTRL[k][1])) + "</option>").join("") + '</select></label><label class="dl-wide">' + T("What happened", "") + '<textarea class="input" rows="2" maxlength="2000" data-dl-v="note">' + esc(rv.note || "") + '</textarea></label><label class="dl-wide">' + T("How to prevent it next time", "") + '<textarea class="input" rows="2" maxlength="2000" data-dl-v="prevent">' + esc(rv.prevent || "") + '</textarea></label><label class="check-label"><input type="checkbox" data-dl-v="is_case"' + (rv.is_case ? " checked" : "") + "> " + T("Review case (departments look at it together)", "") + '</label><label class="dl-wide">' + T("Why it is a case", "") + '<input class="input input--sm" maxlength="2000" data-dl-v="why" value="' + esc(rv.why || "") + '"></label></div><div class="dl-btns"><button type="button" class="btn btn--sm" data-dl-act="save-v"' + (S.saving ? " disabled" : "") + ">" + T("Save", "") + "</button>" + (rv.status === "confirmed" ? '<button type="button" class="btn btn--sm" data-dl-act="unconfirm"' + (S.saving ? " disabled" : "") + ">" + T("Reopen", "") + "</button>" : '<button type="button" class="btn btn--sm btn--primary" data-dl-act="confirm"' + (S.saving ? " disabled" : "") + ">" + T("Save & confirm", "") + "</button>") + '<span class="dl-dim">' + (rv.updated_by ? T("Last saved by ", "") + who(rv.updated_by) + " · " + dL(rv.updated_at) : "") + (rv.confirmed_by ? T(" · confirmed by ", "") + who(rv.confirmed_by) + " · " + dL(rv.confirmed_at) : "") + "</span></div>" : "") + '<details class="dl-hist" data-dl-hist="1"' + (S.hist ? " open" : "") + "><summary>" + T("History", "") + "</summary>" + (S.hist ? histHtml() : '<div class="dl-dim">…</div>') + "</details>";
  }
  const fact = (lb, v, sm) => '<div class="dl-fact"><div class="dl-kpi__lb">' + lb + '</div><div class="dl-fact__v">' + v + "</div>" + (sm ? '<div class="dl-dim">' + sm + "</div>" : "") + "</div>";
  function histHtml() {
    if (!S.hist.length) return '<div class="dl-dim">' + T("No changes yet.", "") + "</div>";
    return '<ul class="dl-histlist">' + S.hist.map((h) => {
      let b = {};
      try {
        b = JSON.parse(h.body || "{}");
      } catch (e) {
      }
      const n = b.new || {};
      const what = h.kind.startsWith("review") ? [n.cause && codeName(n.cause), n.step && stepName(n.step), b.status].filter(Boolean).join(" · ") : [n.started, n.done, n.note].filter(Boolean).join(" · ");
      return '<li><span class="dl-dim">' + esc(tL(h.at)) + "</span> <b>" + who(h.who) + "</b> " + esc(h.kind) + (what ? " — " + esc(what) : "") + "</li>";
    }).join("") + "</ul>";
  }
  function loadHist() {
    const x = S.open;
    api("/audit?ref=" + encodeURIComponent(x) + "&so=" + encodeURIComponent(x.split("|")[0])).then((h) => {
      S.hist = h;
      if (S.open === x) renderDrawer();
    }).catch((e) => {
      S.hist = [];
      flash(e.message, true);
    });
  }
  function verdictPatch() {
    const v = (k) => {
      const el = $('[data-dl-v="' + k + '"]');
      return el ? el.type === "checkbox" ? el.checked : el.value : null;
    };
    const rv = S.d.rv[S.open] || {};
    return { step: v("step") || null, cause: v("cause") || null, ctrl: v("ctrl") || null, note: v("note") || null, prevent: v("prevent") || null, why: v("why") || null, is_case: v("is_case") ? 1 : 0, incl: rv.incl ?? null };
  }
  function saveReview(action, patch) {
    const key = S.open, so = key.split("|")[0];
    save(() => api("/review", { key, so, action, patch: patch || verdictPatch() }));
  }
  function saveStep(stepId) {
    const tr = $('[data-dl-step="' + stepId + '"]'), g = (f) => tr.querySelector('[data-dl-sf="' + f + '"]');
    const so = S.open.split("|")[0], cur = (S.d.st[so] || []).find((r) => r.src === "manual" && r.step === stepId) || {};
    save(() => api("/step", { so, step: stepId, started: g("started").value || null, done: g("done").value || null, note: g("note").value.trim() || null, ask: g("ask").checked, cause: cur.cause || null }), true);
  }
  function save(fn, quiet) {
    if (S.saving) return;
    S.saving = true;
    fn().then(() => load()).then(() => {
      S.saving = false;
      if (!quiet) flash(T("Saved", ""));
      render();
    }).catch((e) => {
      S.saving = false;
      flash(T("Not saved: ", "") + e.message, true);
      render();
    });
  }
  function flash(msg, bad) {
    let el = $("#dl-flash");
    if (!el) {
      el = document.createElement("div");
      el.id = "dl-flash";
      root.appendChild(el);
    }
    el.className = "dl-flash" + (bad ? " dl-flash--bad" : "");
    el.textContent = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => el.remove(), bad ? 6e3 : 2200);
  }
  function onClick(e) {
    const t = e.target.closest("[data-dl-view],[data-dl-lang],[data-dl-act],[data-dl-open],[data-dl-close],[data-dl-of],[data-dl-copy]");
    if (!t || !root.contains(t)) return;
    if (t.dataset.dlView) {
      S.view = t.dataset.dlView;
      try {
        localStorage.setItem(VIEW_KEY, S.view);
      } catch (x) {
      }
      render();
      return;
    }
    if (t.dataset.dlLang) {
      S.lang = t.dataset.dlLang;
      try {
        localStorage.setItem(LANG_KEY, S.lang);
      } catch (x) {
      }
      render();
      return;
    }
    if (t.dataset.dlOpen) {
      openDrawer(t.dataset.dlOpen);
      return;
    }
    if (t.dataset.dlClose) {
      closeDrawer();
      return;
    }
    if (t.dataset.dlOf) {
      F.of = t.dataset.dlOf;
      render();
      return;
    }
    if (t.dataset.dlCopy) {
      copyAsks(t.dataset.dlCopy);
      return;
    }
    const a = t.dataset.dlAct;
    if (a === "reload") refresh();
    else if (a === "suggest") suggest();
    else if (a === "save-v") saveReview("save");
    else if (a === "confirm") {
      const p = verdictPatch();
      if (!p.cause || !p.step) return flash(T("Pick the stage and the cause first.", ""), true);
      saveReview("confirm", p);
    } else if (a === "unconfirm") saveReview("unconfirm");
    else if (a === "save-type" || a === "save-std") {
      const attr = a === "save-type" ? "dlType" : "dlStd", v = {};
      root.querySelectorAll(a === "save-type" ? "[data-dl-type]" : "[data-dl-std]").forEach((i) => {
        if (i.value !== "") v[i.dataset[attr]] = +i.value;
      });
      save(() => api("/setting", { k: a === "save-type" ? "lead_type" : "lead_std", v }));
    } else if (a === "map") {
      const id = t.dataset.dlCard, inp = t.parentElement.querySelector("input"), so = (inp.value || "").trim().toUpperCase().replace(/^SO-?/, "SO");
      if (!/^SO\d{3,6}$/.test(so)) return flash(T("Type an SO like SO02787.", ""), true);
      const [board, cardId] = id.split("\n");
      save(() => api("/kanban_map", { board, card: cardId, so }));
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.dlF) {
      F[t.dataset.dlF] = t.type === "checkbox" ? t.checked : t.value;
      if (t.dataset.dlF !== "q" && t.dataset.dlF !== "oq") render();
      return;
    }
    if (t.dataset.dlSf) {
      saveStep(t.closest("[data-dl-step]").dataset.dlStep);
      return;
    }
    if (t.dataset.dlIncl) {
      const p = Object.assign(verdictPatch(), { incl: t.value === "" ? null : +t.value });
      saveReview("save", p);
      return;
    }
  }
  let qTimer = null;
  function onInput(e) {
    const t = e.target;
    if (t.dataset.dlF === "q" || t.dataset.dlF === "oq") {
      F[t.dataset.dlF] = t.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        render();
        const i = root.querySelector('[data-dl-f="' + t.dataset.dlF + '"]');
        if (i) {
          i.focus();
          i.setSelectionRange(i.value.length, i.value.length);
        }
      }, 250);
    }
  }
  document.addEventListener("toggle", (e) => {
    if (root && e.target.dataset && e.target.dataset.dlHist && e.target.open && !S.hist && S.open) loadHist();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (root && e.key === "Enter" && e.target.classList && e.target.classList.contains("dl-row")) openDrawer(e.target.dataset.dlOpen);
  });
  if (typeof window !== "undefined") window.Delays = { mount, refresh, model: { STEPS, CODES, stagesOf, plan, wdBetween, addWD, lineKey } };
})();
