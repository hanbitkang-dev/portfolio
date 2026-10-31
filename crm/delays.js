/* Delays tab (v3.29) -- why completed orders were late, stage by stage, and the lead-time
   standard that comes out of it.

   Flow: Planning (role ops) picks review cases among the late lines, marks the stages to ask
   each department about, records the answers (typed in, or from the Kanban boards once they
   send), then confirms one verdict per line: the stage where the time went, a cause code and
   whether we could have prevented it. Those verdicts feed the stage standards.

   Data:
     host.orders()        ORDERS from build.py (the ops page gets them without money)
     GET  /api/delays     line reviews, stage dates (manual / kanban / cin7), settings, Kanban
     POST /api/delays/*   one D1 row per change (worker.js), every change audited
   Views: Review (default) · Cases · Open orders · Lead times · Sources.
   template.html's renderDelaysTab() loads delays.css and this file, then calls
   Delays.mount(el, host). The only global is window.Delays; classes and ids start with dl-. */
(function () {
  'use strict';

  /* ================= model ================= */
  // Stages (10-16 design, from the Progress Tracker prototype). pre = stages that must finish
  // first: the raw-material track (③a) and the artwork -> packaging track (③b, ③c) run side by side.
  const STEPS = [
    { id: 's1', no: '①', team: 'sales', pre: [], en: 'Order confirmed', ko: '접수·확정' },
    { id: 's2', no: '②', team: 'planning', pre: ['s1'], en: 'Plan / MO', ko: '계획·MO' },
    { id: 's3a', no: '③a', team: 'purchase', pre: ['s2'], en: 'Raw material PO → receipt', ko: '원료 발주→입고' },
    { id: 's3b', no: '③b', team: 'sales', pre: ['s2'], en: 'Artwork / label approval', ko: '아트워크·라벨 확정' },
    { id: 's3c', no: '③c', team: 'purchase', pre: ['s3b'], en: 'Packaging / label PO → receipt', ko: '부자재·라벨 발주→입고' },
    { id: 's4', no: '④', team: 'qa', pre: ['s3a', 's3c'], en: 'Incoming QC', ko: '입고 QC' },
    { id: 's5', no: '⑤', team: 'warehouse', pre: ['s4'], en: 'Material issue', ko: '자재 불출' },
    { id: 's6', no: '⑥', team: 'production', pre: ['s5'], en: 'Bulk production', ko: '벌크 생산' },
    { id: 's7', no: '⑦', team: 'production', pre: ['s6'], en: 'Packing', ko: '포장' },
    { id: 's8', no: '⑧', team: 'qa', pre: ['s7'], en: 'QA release / COA', ko: '생산 승인·COA' },
    { id: 's9', no: '⑨', team: 'warehouse', pre: ['s8'], en: 'Dispatch', ko: '출고' },
  ];
  const STEP = Object.fromEntries(STEPS.map(s => [s.id, s]));
  const STD_DRAFT = { s1: 2, s2: 3, s3a: 25, s3b: 10, s3c: 15, s4: 3, s5: 2, s6: 5, s7: 4, s8: 4, s9: 2 }; // business days, until Planning sets them
  const TYPE_DRAFT = { hard: 84, soft: 98, tablet: 84, powder: 84, liquid: 84, 'liquid hard': 98 }; // calendar days order -> packed (the old Delays tab's)
  const TYPE_DEFAULT = 84;
  const STALE_DAYS = 365; // open lines confirmed longer ago than this are left out (same as Production's staleDays)
  const TEAMS = {
    sales: ['Sales', '영업'], planning: ['Planning', '계획'], purchase: ['Purchase', '구매'], qa: ['QA', 'QA'],
    production: ['Production', '생산'], warehouse: ['Warehouse', '창고'], external: ['External', '외부'],
  };
  const CODES = [
    ['SA-1', 'sales', 'Accepted a date shorter than standard', '표준보다 짧은 납기 수락'],
    ['SA-2', 'sales', 'Spec / quantity change', '사양·수량 변경'],
    ['SA-3', 'sales', 'Customer artwork / approval late', '고객 아트워크·승인 지연'],
    ['SA-4', 'sales', 'Order registered late', '오더 등록 지연'],
    ['PL-1', 'planning', 'Production slot pushed back', '생산 순서 밀림'],
    ['PL-2', 'planning', 'Capacity shortfall', '캐파 부족'],
    ['PL-3', 'planning', 'Plan / MO late', '계획·MO 지연'],
    ['PU-1', 'purchase', 'Raw material ordered late', '원료 발주 지연'],
    ['PU-2', 'purchase', 'Raw material supplier late', '원료 공급사 지연'],
    ['PU-3', 'purchase', 'Packaging / label ordered late', '부자재·라벨 발주 지연'],
    ['PU-4', 'purchase', 'Packaging / label delivery late', '부자재·라벨 입고 지연'],
    ['PU-5', 'purchase', 'MOQ / stock shortage', 'MOQ·재고 부족'],
    ['QA-1', 'qa', 'Incoming QC queue', '입고 QC 대기'],
    ['QA-2', 'qa', 'Material out of spec / retest', '원료 부적합·재시험'],
    ['QA-3', 'qa', 'Release / COA waiting', '출하 승인·COA 대기'],
    ['QA-4', 'qa', 'New product review', '신제품 검토'],
    ['WH-1', 'warehouse', 'Receipt processing late', '입고 처리 지연'],
    ['WH-2', 'warehouse', 'Material issue late', '자재 불출 지연'],
    ['WH-3', 'warehouse', 'Dispatch / freight', '출고·운송'],
    ['PR-1', 'production', 'Equipment breakdown', '설비 고장'],
    ['PR-2', 'production', 'Staffing', '인력'],
    ['PR-3', 'production', 'Process issue / rework', '공정 문제·재작업'],
    ['PR-4', 'production', 'Yield / defects', '수율·불량'],
    ['EX-1', 'external', 'Customer asked to hold', '고객 보류 요청'],
    ['EX-2', 'external', 'Certification / regulatory', '인증·규제'],
    ['EX-3', 'external', 'Customs', '통관'],
  ].map(([c, team, en, ko]) => ({ c, team, en, ko }));
  const CODE = Object.fromEntries(CODES.map(x => [x.c, x]));
  const CTRL = { internal: ['Internal — we could have prevented it', '내부 — 우리가 막을 수 있었음'], external: ['External — supplier, regulator, freight', '외부 — 공급사·인증·운송'], customer: ['Customer — the client asked or was late', '고객 — 고객 요청·지연'] };
  // The ten cases suggested in the 10-16 design (oERP export of 15 Oct), with the stages to ask about.
  const SUGGESTED = [
    ['SO02401', 'OF1004', ['s2', 's3a', 's6'], 'All three completed lines of this SKU were late; this one 35 days despite a 94-day lead.', '같은 SKU 완료 3라인이 모두 늦음. 리드 94일을 받고도 35일 지연.'],
    ['SO02559', 'OF1039', ['s3a', 's6', 's8'], 'High-value repeat SKU for the top customer; 1 of 7 liquid-hard lines on time in 12 months.', '매출 1위 고객의 고액 반복 SKU. Liquid hard 12개월 7라인 중 1라인만 정시.'],
    ['SO02465', 'OF1128', ['s3a', 's3b', 's8'], 'First order of a new SKU and the largest line in 12 months; 137 days actual, 39 over standard.', '신규 SKU 첫 오더이자 12개월 최대 금액. 실제 137일로 표준보다 39일 김.'],
    ['SO02407', 'OF1081', ['s1', 's2', 's6'], 'Requested with a 27-day lead and took 143 days — over the 84-day standard too.', '요청 리드 27일, 실제 143일로 표준 84일보다도 59일 김.'],
    ['SO02236', 'OF1015', ['s3c', 's5', 's7'], '5 of 7 gift-pack lines were late, all with a full standard lead.', '기프트 팩 7라인 중 5라인 지연. 리드는 표준만큼 받음.'],
    ['SO02377', 'OF0947', ['s2', 's3c', 's8'], 'Late twice despite 119- and 90-day leads.', '리드 119일·90일을 받고도 두 번 지연.'],
    ['SO02326', 'OF0721', ['s3a', 's4', 's8'], 'Given a 94-day lead, took 196 days — a clean operational delay.', '리드 94일, 실제 196일. 약속 문제가 섞이지 않은 운영 지연.'],
    ['SO02547', 'OF0619', ['s1', 's3a', 's6'], 'Short leads both times, but 101 and 140 days actual — over standard too.', '두 번 다 요청 리드가 짧았지만 실제 101일·140일로 표준도 넘음.'],
    ['SO02599', 'OF0431', ['s2', 's3a'], 'The most-ordered SKU; 5–30 days late every time despite 70–111-day leads.', '가장 자주 주문되는 SKU. 매번 70–111일 리드를 받고도 5–30일 지연.'],
    ['SO02485', 'OF1127', ['s1', 's2'], 'Customer pattern: 0 of 24 lines on time, median requested lead 22 days.', '고객 패턴 케이스. 12개월 24라인 중 정시 0, 요청 리드 중앙값 22일.'],
  ];

  const DAY = 864e5;
  const dOf = iso => new Date(iso + 'T00:00:00');
  const isoOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const today = () => isoOf(new Date());
  const days = (a, b) => a && b ? Math.round((dOf(b) - dOf(a)) / DAY) : null;
  const addDays = (iso, n) => { const d = dOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
  const isWD = d => d.getDay() !== 0 && d.getDay() !== 6;
  function addWD(iso, n) {
    const d = dOf(iso);
    for (let k = n; k > 0;) { d.setDate(d.getDate() + 1); if (isWD(d)) k--; }
    return isoOf(d);
  }
  function wdBetween(a, b) {
    if (!a || !b || a === b) return a && b ? 0 : null;
    let x = dOf(a), y = dOf(b), s = 1, n = 0;
    if (x > y) { [x, y] = [y, x]; s = -1; }
    while (x < y) { x.setDate(x.getDate() + 1); if (isWD(x)) n++; }
    return n * s;
  }
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
  const quant = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const lineKey = r => r.so + '|' + r.code + '|' + (r.require_date || '');
  const typeOf = r => (r.bulk_type || '').toLowerCase().trim();
  const sev = d => d > 30 ? 'severe' : d > 14 ? 'moderate' : d > 6 ? 'mild' : 'minor';

  // oERP's confirm_date of a finished line is the invoice processing date, so a finished line
  // starts from its order date.
  const startOf = r => (r.finish_date ? r.date : r.confirm_date || r.date) || null;
  // Stage dates for one SO: manual wins over Cin7 over Kanban; oERP gives ① (confirmed) and ⑦ (packed).
  function stagesOf(so, rows, line) {
    const out = {};
    STEPS.forEach(s => { out[s.id] = { started: null, done: null, src: null, ask: false, note: null, cause: null, auto: {} }; });
    if (line) {
      out.s1.done = startOf(line); out.s1.src = 'oERP';
      if (line.finish_date) { out.s7.done = line.finish_date; out.s7.src = 'oERP'; }
    }
    ['kanban', 'cin7', 'manual'].forEach(src => (rows[so] || []).filter(r => r.src === src && out[r.step]).forEach(r => {
      const o = out[r.step];
      if (src !== 'manual') o.auto[src] = r;
      if (r.started) o.started = r.started;
      if (r.done) { o.done = r.done; o.src = src; }
      if (src === 'manual') { o.ask = !!r.ask; o.note = r.note; o.cause = r.cause; o.manual = r; }
    }));
    return out;
  }
  // Target per stage = the later of its prerequisites (actual date if done, else their target) + standard.
  function plan(st, std, start) {
    const tgt = {};
    STEPS.forEach(s => {
      const base = s.pre.length ? s.pre.map(p => st[p].done || tgt[p]).filter(Boolean).sort().pop() : start;
      tgt[s.id] = base ? addWD(base, +std[s.id] || 0) : null;
    });
    return tgt;
  }
  const answered = o => !!(o.note || o.cause || (o.done && o.src !== 'oERP') || o.started);

  /* ================= view ================= */
  const VIEWS = [['review', 'fact_check', 'Review', '완료 오더 리뷰'], ['cases', 'forum', 'Cases', '케이스'], ['open', 'pending_actions', 'Open orders', '진행 오더'], ['lead', 'timer', 'Lead times', '리드타임 표준'], ['sources', 'hub', 'Sources', '연결']];
  const VIEW_KEY = 'dl_view', LANG_KEY = 'dl_lang';
  let H = null, root = null;
  const S = { view: 'review', lang: 'ko', d: null, err: null, open: null, saving: false, hist: null };
  const F = { period: '12m', client: '', type: '', status: 'all', q: '', excl: false, oq: '', of: 'risk' };

  const T = (en, ko) => S.lang === 'en' ? en : ko;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = sel => root.querySelector(sel);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dS = iso => iso ? (+iso.slice(8, 10)) + ' ' + MON[+iso.slice(5, 7) - 1] + (iso.slice(0, 4) !== today().slice(0, 4) ? ' ' + iso.slice(0, 4) : '') : '–';
  // server timestamps are UTC ISO; show them in local time
  const dL = ts => { const d = new Date(ts || ''); return isNaN(d) ? '–' : dS(isoOf(d)); };
  const tL = ts => { const d = new Date(ts || ''); return isNaN(d) ? '' : isoOf(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
  const qs = n => { const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n)); };
  const who = s => s ? esc(String(s).split('@')[0]) : '';
  const team = k => TEAMS[k] ? T(TEAMS[k][0], TEAMS[k][1]) : k;
  const teamTag = k => '<span class="dl-team dl-team--' + esc(k) + '">' + esc(team(k)) + '</span>';
  const stepName = id => STEP[id] ? STEP[id].no + ' ' + T(STEP[id].en, STEP[id].ko) : '–';
  const codeName = c => CODE[c] ? c + ' · ' + T(CODE[c].en, CODE[c].ko) : (c || '–');
  const showMoney = () => H.role() === 'full';
  const STATUS = { open: ['', 'No verdict', '미검토'], proposed: ['s-new', 'Proposed', '제안됨'], confirmed: ['s-finished', 'Confirmed', '확정'] };
  const statusBadge = st => { const b = STATUS[st] || STATUS.open; return '<span class="badge ' + b[0] + ' dl-st">' + T(b[1], b[2]) + '</span>'; };

  function card(title, hint, body, ctl) {
    return '<section class="dl-card"><div class="dl-card__head"><h3 class="dl-card__title">' + title + '</h3>' + (ctl ? '<div class="dl-ctl">' + ctl + '</div>' : '') + '</div>' +
      (hint ? '<div class="dl-hint">' + hint + '</div>' : '') + body + '</section>';
  }
  function table(head, rows, empty, cls) {
    return '<div class="table-wrap dl-tw' + (cls ? ' ' + cls : '') + '"><table class="dl-table"><thead><tr>' + head.map(h => '<th' + (h[1] ? ' class="num"' : '') + '>' + h[0] + '</th>').join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.join('') : '<tr><td colspan="' + head.length + '" class="dl-none">' + (empty || T('Nothing to show.', '표시할 항목이 없습니다.')) + '</td></tr>') + '</tbody></table></div>';
  }
  const kpi = (lb, v, sm, cls) => '<div class="dl-kpi' + (cls ? ' ' + cls : '') + '"><div class="dl-kpi__lb">' + lb + '</div><div class="dl-kpi__v">' + v + '</div><div class="dl-kpi__sm">' + (sm || '') + '</div></div>';

  /* ---------- data ---------- */
  function api(path, body) {
    return fetch('/api/delays' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' })
      .then(r => r.json().catch(() => ({})).then(j => { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }));
  }
  function load() {
    return api('').then(d => {
      d.rv = Object.fromEntries(d.reviews.map(r => [r.key, r]));
      d.st = {};
      d.steps.forEach(r => { (d.st[r.so] = d.st[r.so] || []).push(r); });
      S.d = d; S.err = null;
    }).catch(e => { S.err = e.message; });
  }
  const stdStage = () => Object.assign({}, STD_DRAFT, (S.d && S.d.settings.lead_std || {}).v || {});
  const stdType = () => Object.assign({}, TYPE_DRAFT, (S.d && S.d.settings.lead_type || {}).v || {});
  const stdFor = r => { const t = stdType(), k = typeOf(r); return t[k] != null ? +t[k] : TYPE_DEFAULT; };

  function periodFrom() {
    const n = { '6m': 183, '12m': 365, '2y': 730 }[F.period];
    return n ? addDays(today(), -n) : '';
  }
  // Completed lines with what the review needs. Short-lead rule (same as the old tab): a line the
  // client asked for faster than standard and we still finished within standard isn't counted.
  function completed() {
    const from = periodFrom();
    return H.orders().filter(r => r.status !== 'cancel' && r.finish_date && r.require_date && r.date && (!from || r.finish_date >= from)).map(r => {
      const key = lineKey(r), rv = S.d.rv[key] || null, std = stdFor(r);
      const lead = days(r.date, r.require_date), actual = days(r.date, r.finish_date), late = r.delay_days > 0;
      let excl = late && lead < std && actual <= std ? 'short' : '';
      if (rv && rv.incl === 1) excl = ''; else if (rv && rv.incl === 0) excl = 'manual';
      return { r, key, rv, std, lead, actual, late, excl };
    });
  }

  /* ---------- shell ---------- */
  function mount(el, host) {
    H = host; root = el;
    el.classList.add('dl');
    try {
      S.view = localStorage.getItem(VIEW_KEY) || 'review';
      S.lang = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ko';
    } catch (e) { /* private mode */ }
    if (!VIEWS.some(v => v[0] === S.view)) S.view = 'review';
    el.innerHTML = '<div class="dl-head" id="dl-head"></div><div id="dl-banner"></div>' +
      VIEWS.map(v => '<section class="dl-view" data-dl-pane="' + v[0] + '"></section>').join('') +
      '<div class="dl-drawer" id="dl-drawer" hidden><div class="dl-drawer__bg" data-dl-close="1"></div><aside class="dl-drawer__panel" role="dialog" aria-modal="true" id="dl-panel"></aside></div>';
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open) closeDrawer(); });
    renderHead();
    $('[data-dl-pane="' + S.view + '"]').innerHTML = '<div class="empty">Loading…</div>';
    $('[data-dl-pane="' + S.view + '"]').classList.add('active');
    load().then(render);
  }
  function refresh() { if (root) load().then(render); }
  function renderHead() {
    const n = H.orders().length;
    $('#dl-head').innerHTML = '<div><div class="dl-eyebrow">' + T('Operations · delays', 'Operations · 납기 지연') + '</div>' +
      '<h2 class="dl-title">' + T('Delays — why orders were late', '납기 지연 — 왜 늦었나') + '</h2>' +
      '<div class="dl-sub">' + T('Order data: oERP, ', '오더 데이터: oERP, ') + n.toLocaleString() + T(' lines · verdicts and stage dates are shared (saved per change)', '라인 · 사유와 단계 날짜는 팀이 함께 씀(바꿀 때마다 저장)') + '</div></div>' +
      '<div class="dl-headctl"><div class="seg" id="dl-views">' + VIEWS.map(v => '<button type="button" data-dl-view="' + v[0] + '"' + (v[0] === S.view ? ' class="active"' : '') + '><span class="icon icon--inline">' + v[1] + '</span>' + T(v[2], v[3]) + '</button>').join('') + '</div>' +
      '<div class="seg seg--sm dl-lang">' + [['ko', '한국어'], ['en', 'EN']].map(([k, nm]) => '<button type="button" data-dl-lang="' + k + '"' + (S.lang === k ? ' class="active"' : '') + '>' + nm + '</button>').join('') + '</div></div>';
  }
  function render() {
    renderHead();
    root.querySelectorAll('.dl-view').forEach(p => p.classList.toggle('active', p.dataset.dlPane === S.view));
    $('#dl-banner').innerHTML = S.err ? '<div class="dl-alert dl-alert--red"><span class="icon">error</span><div>' + T('Could not load the Delays data: ', 'Delays 데이터를 불러오지 못했습니다: ') + esc(S.err) +
      ' <button type="button" class="btn btn--sm" data-dl-act="reload">' + T('Try again', '다시 시도') + '</button></div></div>' : '';
    const pane = $('[data-dl-pane="' + S.view + '"]');
    if (!S.d) { pane.innerHTML = ''; return; }
    ({ review: renderReview, cases: renderCases, open: renderOpen, lead: renderLead, sources: renderSources })[S.view](pane);
    if (S.open) renderDrawer();
  }

  /* ---------- Review ---------- */
  function renderReview(pane) {
    const all = completed();
    const clients = [...new Set(all.filter(x => x.late).map(x => x.r.customer))].sort();
    const types = [...new Set(all.map(x => typeOf(x.r)).filter(Boolean))].sort();
    const lateIn = all.filter(x => x.late && !x.excl);
    const q = F.q.toLowerCase();
    const shown = all.filter(x => x.late && (F.excl ? x.excl : !x.excl) && (!F.client || x.r.customer === F.client) && (!F.type || typeOf(x.r) === F.type) &&
      (F.status === 'all' || (x.rv ? x.rv.status : 'open') === F.status || (F.status === 'case' && x.rv && x.rv.is_case)) &&
      (!q || (x.r.so + ' ' + x.r.customer + ' ' + x.r.name + ' ' + x.r.code).toLowerCase().includes(q)))
      .sort((a, b) => b.r.delay_days - a.r.delay_days);
    const onTime = all.filter(x => !x.late).length;
    const conf = lateIn.filter(x => x.rv && x.rv.status === 'confirmed').length, prop = lateIn.filter(x => x.rv && x.rv.status === 'proposed').length;
    const filters = '<div class="dl-filters">' +
      sel('period', [['6m', T('Last 6 months', '최근 6개월')], ['12m', T('Last 12 months', '최근 12개월')], ['2y', T('Last 2 years', '최근 2년')], ['all', T('All time', '전체 기간')]], F.period) +
      sel('client', [['', T('All clients', '전체 고객')]].concat(clients.map(c => [c, c])), F.client) +
      sel('type', [['', T('All types', '전체 제형')]].concat(types.map(t => [t, t])), F.type) +
      sel('status', [['all', T('Any verdict', '사유 전체')], ['open', T('No verdict yet', '미검토')], ['proposed', T('Proposed', '제안됨')], ['confirmed', T('Confirmed', '확정')], ['case', T('Review cases', '리뷰 케이스')]], F.status) +
      '<input class="input input--sm" type="search" data-dl-f="q" value="' + esc(F.q) + '" placeholder="' + T('SO, client, product', 'SO, 고객, 제품') + '">' +
      '<label class="check-label"><input type="checkbox" data-dl-f="excl"' + (F.excl ? ' checked' : '') + '> ' + T('Show the lines left out instead', '제외된 라인 보기') + '</label></div>';
    const money = showMoney();
    const head = [[T('SO · client', 'SO · 고객')], [T('Product', '제품')], [T('Ordered → required', '주문 → 납기')], [T('Packed', '포장 완료'), 0], [T('Late', '지연'), 1], [T('Verdict', '사유')], [T('Status', '상태')]];
    if (money) head.splice(5, 0, [T('Value', '금액'), 1]);
    const rows = shown.slice(0, 400).map(x => {
      const r = x.r, rv = x.rv || {};
      return '<tr class="dl-row" data-dl-open="' + esc(x.key) + '" tabindex="0">' +
        '<td class="dl-cl"><b>' + esc(r.so) + '</b>' + (rv.is_case ? ' <span class="badge s-confirm">' + T('case', '케이스') + '</span>' : '') + '<div class="dl-dim">' + esc(r.customer) + '</div></td>' +
        '<td class="dl-prodcell">' + esc(r.name) + '<div class="dl-dim">' + esc(r.code) + ' · ' + esc(r.bulk_type || '–') + '</div></td>' +
        '<td class="dl-nowrap">' + dS(r.date) + ' → ' + dS(r.require_date) + '<div class="dl-dim">' + T('lead ', '리드 ') + x.lead + T(' d · standard ', '일 · 표준 ') + x.std + T(' d', '일') + '</div></td>' +
        '<td class="dl-nowrap">' + dS(r.finish_date) + '<div class="dl-dim">' + x.actual + T(' days', '일 걸림') + '</div></td>' +
        '<td class="num"><span class="dl-late dl-late--' + sev(r.delay_days) + '">+' + r.delay_days + '</span>' + (x.excl ? '<div class="dl-dim">' + (x.excl === 'short' ? T('short lead', '짧은 리드') : T('left out', '수동 제외')) + '</div>' : '') + '</td>' +
        (money ? '<td class="num dl-nowrap">' + (r.value ? (r.cur && r.cur !== 'NZD' ? esc(r.cur) + ' ' : '') + qs(r.value) : '–') + '</td>' : '') +
        '<td class="dl-verdict">' + (rv.cause ? '<b>' + esc(codeName(rv.cause)) + '</b><div class="dl-dim">' + esc(stepName(rv.step)) + (rv.ctrl ? ' · ' + esc(T(CTRL[rv.ctrl][0], CTRL[rv.ctrl][1]).split(' — ')[0]) : '') + '</div>' : '<span class="dl-dim">–</span>') + '</td>' +
        '<td>' + statusBadge(rv.status) + '</td></tr>';
    });
    pane.innerHTML =
      '<div class="dl-kpis">' +
      kpi(T('Completed lines', '완료 라인'), all.length, T('packed in the period', '기간 안에 포장 완료')) +
      kpi(T('On time', '정시'), pct(onTime, all.length), onTime + T(' lines packed by the required date', '라인이 납기 안에 포장')) +
      kpi(T('Late, counted', '지연 (집계 대상)'), lateIn.length, T('median ', '중앙값 ') + (median(lateIn.map(x => x.r.delay_days)) ?? '–') + T(' days late', '일 지연'), lateIn.length ? 'dl-kpi--warn' : '') +
      kpi(T('Left out', '제외'), all.filter(x => x.late && x.excl).length, T('short lead, finished within standard', '짧은 리드인데 표준 안에 완료')) +
      kpi(T('Verdicts', '사유 확정'), conf + ' / ' + lateIn.length, prop + T(' proposed, waiting for Planning', '건 제안됨, Planning 확정 대기')) +
      '</div>' +
      breakdown(lateIn) +
      card(T('Late lines', '지연 라인'),
        T('Click a line to record why it was late: the stage where the time went, a cause code and whether we could have prevented it. Planning confirms each verdict. Lines the client asked for faster than standard and that we still finished within standard are left out, as before.',
          '라인을 누르면 지연 사유를 적습니다: 시간이 걸린 단계, 원인 코드, 우리가 막을 수 있었는지. 각 사유는 Planning이 확정합니다. 고객이 표준보다 짧게 요청했고 실제로 표준 안에 끝낸 라인은 이전처럼 제외합니다.'),
        filters + table(head, rows, T('No late lines match.', '조건에 맞는 지연 라인이 없습니다.'), 'dl-tw--tall') +
        (shown.length > 400 ? '<div class="dl-foot">' + T('First 400 of ', '처음 400개 / 전체 ') + shown.length + '</div>' : ''));
  }
  function sel(f, opts, cur) {
    return '<select class="select select--sm" data-dl-f="' + f + '">' + opts.map(o => '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>';
  }
  function breakdown(lateIn) {
    const withV = lateIn.filter(x => x.rv && x.rv.cause);
    if (!withV.length) return '';
    const by = (fn) => { const m = {}; withV.forEach(x => { const k = fn(x); if (!k) return; (m[k] = m[k] || { n: 0, d: 0, c: 0 }); m[k].n++; m[k].d += x.r.delay_days; if (x.rv.status === 'confirmed') m[k].c++; }); return Object.entries(m).sort((a, b) => b[1].d - a[1].d); };
    const bars = (list, label) => { const max = Math.max(...list.map(e => e[1].d)); return list.slice(0, 8).map(([k, v]) => '<div class="dl-bar"><span class="dl-bar__lb">' + label(k) + '</span><span class="dl-bar__track"><i style="width:' + Math.max(3, v.d / max * 100) + '%"></i></span><span class="dl-bar__v">' + v.n + T(' lines · ', '라인 · ') + v.d + T(' d', '일') + '</span></div>').join(''); };
    const ctrl = by(x => x.rv.ctrl);
    return card(T('Where the time went', '어디서 시간이 갔나'),
      T('Lines with a verdict (proposed or confirmed), weighted by days late. ', '사유가 있는 라인(제안·확정), 지연 일수 합 기준. ') + withV.length + T(' of ', ' / ') + lateIn.length + T(' late lines so far.', '라인.'),
      '<div class="dl-grid3"><div><div class="dl-sublb">' + T('By department', '부서별') + '</div>' + bars(by(x => CODE[x.rv.cause] && CODE[x.rv.cause].team), k => teamTag(k)) + '</div>' +
      '<div><div class="dl-sublb">' + T('By stage', '단계별') + '</div>' + bars(by(x => x.rv.step), k => esc(stepName(k))) + '</div>' +
      '<div><div class="dl-sublb">' + T('By cause', '원인 코드별') + '</div>' + bars(by(x => x.rv.cause), k => esc(codeName(k))) +
      (ctrl.length ? '<div class="dl-sublb" style="margin-top:10px">' + T('Could we have prevented it?', '막을 수 있었나') + '</div>' + bars(ctrl, k => esc(T(CTRL[k][0], CTRL[k][1]).split(' — ')[0])) : '') + '</div></div>');
  }

  /* ---------- Cases ---------- */
  function caseState(x, st) {
    if (x.rv && x.rv.status === 'confirmed') return ['agreed', 's-finished', T('Agreed', '합의')];
    const asks = STEPS.filter(s => st[s.id].ask);
    if (!asks.length) return ['prep', '', T('Pick stages to ask', '물어볼 단계 고르기')];
    const open = asks.filter(s => !answered(st[s.id])).length;
    return open ? ['waiting', 's-new', T(open + ' answer' + (open > 1 ? 's' : '') + ' to come', '답변 ' + open + '건 대기')] : ['ready', 's-confirm', T('Ready to agree', '합의 준비')];
  }
  function renderCases(pane) {
    const byKey = Object.fromEntries(completed().map(x => [x.key, x]));
    const cases = S.d.reviews.filter(r => r.is_case).map(r => {
      const x = byKey[r.key] || orderLine(r.key);
      return x ? { x, st: stagesOf(x.r.so, S.d.st, x.r) } : null;
    }).filter(Boolean).sort((a, b) => (b.x.r.delay_days || 0) - (a.x.r.delay_days || 0));
    if (!cases.length) {
      pane.innerHTML = card(T('Review cases', '리뷰 케이스'),
        T('A case is a late line the departments look at together, stage by stage, to find where the time went and to set the stage standards. Mark any late line as a case from its Review panel, or start with the ten suggested in the 16 Oct design.',
          '케이스는 부서들이 단계별로 함께 들여다보는 지연 라인입니다. 어디서 시간이 갔는지 찾고 단계 표준을 정하는 데 씁니다. 완료 오더 리뷰에서 라인을 열어 케이스로 지정하거나, 10-16 설계안의 추천 10건으로 시작하세요.'),
        '<button type="button" class="btn btn--primary" data-dl-act="suggest"' + (S.saving ? ' disabled' : '') + '><span class="icon icon--inline">playlist_add</span>' + T('Load the 10 suggested cases', '추천 10건 불러오기') + '</button>');
      return;
    }
    const asksByTeam = {};
    cases.forEach(({ x, st }) => STEPS.forEach(s => { if (st[s.id].ask && !answered(st[s.id])) (asksByTeam[s.team] = asksByTeam[s.team] || []).push({ x, s }); }));
    const teamsOpen = Object.keys(asksByTeam);
    const counts = {};
    cases.forEach(c => { const k = caseState(c.x, c.st)[0]; counts[k] = (counts[k] || 0) + 1; });
    pane.innerHTML =
      '<div class="dl-kpis">' + kpi(T('Cases', '케이스'), cases.length) + kpi(T('Waiting for answers', '답변 대기'), counts.waiting || 0, '', counts.waiting ? 'dl-kpi--warn' : '') +
      kpi(T('Ready to agree', '합의 준비'), counts.ready || 0) + kpi(T('Agreed', '합의 완료'), counts.agreed || 0) + '</div>' +
      card(T('Questions to send', '보낼 질문'),
        T('Open questions per department. Copy them into the department\'s Kanban board or Chat; type the answer into the stage when it comes back (or it arrives from Kanban once that is connected).',
          '부서별로 아직 답이 없는 질문입니다. 복사해서 해당 부서 Kanban 보드나 Chat에 올리고, 답이 오면 그 단계에 적습니다(Kanban 연결 후에는 자동으로 들어옵니다).'),
        teamsOpen.length ? '<div class="dl-asks">' + teamsOpen.map(k => '<div class="dl-ask"><div class="dl-ask__head">' + teamTag(k) + ' <b>' + asksByTeam[k].length + '</b>' +
          '<button type="button" class="btn btn--sm" data-dl-copy="' + esc(k) + '"><span class="icon icon--inline">content_copy</span>' + T('Copy', '복사') + '</button></div><ul>' +
          asksByTeam[k].map(a => '<li><button type="button" class="dl-link" data-dl-open="' + esc(a.x.key) + '">' + esc(a.x.r.so) + '</button> ' + esc(a.s.no + ' ' + T(a.s.en, a.s.ko)) + ' <span class="dl-dim">' + esc(a.x.r.name) + '</span></li>').join('') + '</ul></div>').join('') + '</div>'
          : '<div class="dl-none">' + T('No open questions.', '열린 질문이 없습니다.') + '</div>') +
      '<div class="dl-cases">' + cases.map(({ x, st }) => {
        const cs = caseState(x, st), rv = x.rv || {};
        return '<article class="dl-case dl-case--' + cs[0] + '"><div class="dl-case__head"><button type="button" class="dl-link" data-dl-open="' + esc(x.key) + '"><b>' + esc(x.r.so) + '</b></button>' +
          '<span class="badge ' + cs[1] + '">' + esc(cs[2]) + '</span></div>' +
          '<div class="dl-case__t">' + esc(x.r.name) + '</div><div class="dl-dim">' + esc(x.r.customer) + ' · ' + esc(x.r.bulk_type || '') + '</div>' +
          '<div class="dl-case__nums">' + T('Lead ', '리드 ') + (x.lead ?? '–') + T(' d · took ', '일 · 실제 ') + (x.actual ?? '–') + T(' d · ', '일 · ') + '<span class="dl-late dl-late--' + sev(x.r.delay_days || 0) + '">+' + (x.r.delay_days ?? '–') + '</span></div>' +
          (rv.why ? '<div class="dl-case__why">' + esc(rv.why) + '</div>' : '') +
          '<div class="dl-case__asks">' + STEPS.filter(s => st[s.id].ask).map(s => '<span class="dl-pill' + (answered(st[s.id]) ? ' dl-pill--ok' : '') + '" title="' + esc(team(s.team)) + '">' + esc(s.no + ' ' + T(s.en, s.ko)) + '</span>').join('') + '</div>' +
          (rv.cause ? '<div class="dl-case__v"><b>' + esc(codeName(rv.cause)) + '</b> · ' + esc(stepName(rv.step)) + '</div>' : '') + '</article>';
      }).join('') + '</div>';
  }
  function orderLine(key) {
    const r = H.orders().find(o => lineKey(o) === key);
    if (!r) return null;
    return { r, key, rv: S.d.rv[key] || null, std: stdFor(r), lead: days(r.date, r.require_date), actual: days(r.date, r.finish_date), late: r.delay_days > 0, excl: '' };
  }
  function suggest() {
    const lines = [], asks = [];
    SUGGESTED.forEach(([so, code, ask, en, ko]) => {
      const r = H.orders().find(o => o.so === so && o.code === code && o.finish_date);
      if (!r) return;
      lines.push({ key: lineKey(r), so, why: T(en, ko) });
      ask.forEach(step => asks.push({ so, step }));
    });
    if (!lines.length) return alert(T('None of the suggested orders are in this data.', '추천 오더가 이 데이터에 없습니다.'));
    save(() => api('/cases', { lines, asks }));
  }
  function copyAsks(k) {
    const byKey = Object.fromEntries(completed().map(x => [x.key, x]));
    const lines = [];
    S.d.reviews.filter(r => r.is_case).forEach(rv => {
      const x = byKey[rv.key] || orderLine(rv.key);
      if (!x) return;
      const st = stagesOf(x.r.so, S.d.st, x.r);
      STEPS.filter(s => s.team === k && st[s.id].ask && !answered(st[s.id])).forEach(s => {
        lines.push('- [' + x.r.so + '] ' + x.r.name + ' (' + x.r.customer + ') — ' + s.no + ' ' + T(s.en, s.ko) + ': ' +
          T('ordered ' + x.r.date + ', required ' + x.r.require_date + ', packed ' + x.r.finish_date + ' (+' + x.r.delay_days + ' days). When did this stage start and finish, and what held it up?',
            '주문 ' + x.r.date + ', 납기 ' + x.r.require_date + ', 포장 완료 ' + x.r.finish_date + ' (+' + x.r.delay_days + '일). 이 단계가 언제 시작해 언제 끝났고, 무엇 때문에 늦어졌나요?'));
      });
    });
    const text = T('Delay review — questions for ', '납기 지연 리뷰 — 질문: ') + team(k) + '\n' + lines.join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => flash(T('Copied ', '복사함: ') + lines.length + T(' questions', '개 질문')), () => prompt(T('Copy this:', '복사하세요:'), text));
  }

  /* ---------- Open orders ---------- */
  function renderOpen(pane) {
    const t = today(), std = stdStage(), q = F.oq.toLowerCase(), staleFrom = addDays(t, -STALE_DAYS);
    const open = H.orders().filter(r => r.status === 'confirm' && !r.finish_date);
    const stale = open.filter(r => (startOf(r) || '') < staleFrom).length;
    const lines = open.filter(r => (startOf(r) || '') >= staleFrom).map(r => {
      const st = stagesOf(r.so, S.d.st, r), start = startOf(r), tgt = plan(st, std, start);
      const stdEnd = start ? addDays(start, stdFor(r)) : null;
      // without any recorded stage the current stage would only be a guess, so it isn't shown
      const cur = (S.d.st[r.so] || []).length ? STEPS.find(s => !st[s.id].done) || null : null;
      const left = days(t, r.require_date);
      const curLate = cur && tgt[cur.id] && tgt[cur.id] < t ? wdBetween(tgt[cur.id], t) : 0;
      const risk = left != null && left < 0 ? 'late' : (stdEnd && r.require_date && stdEnd > r.require_date) || (left != null && left <= 14) || curLate > 0 ? 'risk' : 'ok';
      return { r, key: lineKey(r), st, tgt, stdEnd, cur, left, curLate, risk };
    }).filter(x => (F.of === 'all' || x.risk === F.of || (F.of === 'risk' && x.risk === 'late')) && (!q || (x.r.so + ' ' + x.r.customer + ' ' + x.r.name).toLowerCase().includes(q)))
      .sort((a, b) => (a.left ?? 9999) - (b.left ?? 9999));
    const anyStage = Object.keys(S.d.st).length;
    pane.innerHTML = card(T('Open orders', '진행 오더'),
      T('Confirmed lines not packed yet. "Standard finish" = confirmed date + the standard for the type; the stage targets chain the stage standards from the actual dates recorded so far. ',
        '확정됐고 아직 포장 전인 라인입니다. "표준 완료" = 확정일 + 제형 표준 일수. 단계 목표일은 지금까지 기록된 실제 날짜에 단계 표준을 이어 붙입니다. ') +
      (anyStage ? T('The current stage shows only for orders with recorded stage dates. ', '현재 단계는 단계 날짜가 기록된 오더만 보입니다. ') : T('No stage dates are recorded yet (Cin7 and Kanban are not connected), so there is no current stage. ', '아직 기록된 단계 날짜가 없어(Cin7·Kanban 미연결) 현재 단계는 비어 있습니다. ')) +
      (stale ? T(stale + ' lines confirmed over a year ago are left out (Production › Data checks lists them).', '1년 넘은 확정 라인 ' + stale + '개는 뺐습니다(Production › 데이터 점검에 있음).') : ''),
      '<div class="dl-filters"><div class="seg seg--sm">' + [['risk', T('Late or at risk', '지연·위험')], ['late', T('Past required date', '납기 지남')], ['all', T('All', '전체')]].map(([k, n]) => '<button type="button" data-dl-of="' + k + '"' + (F.of === k ? ' class="active"' : '') + '>' + n + '</button>').join('') + '</div>' +
      '<input class="input input--sm" type="search" data-dl-f="oq" value="' + esc(F.oq) + '" placeholder="' + T('SO, client, product', 'SO, 고객, 제품') + '"></div>' +
      table([[T('SO · client', 'SO · 고객')], [T('Product', '제품')], [T('Confirmed', '확정일')], [T('Required', '납기')], [T('Days left', '남은 일수'), 1], [T('Standard finish', '표준 완료')], [T('Current stage (target)', '현재 단계 (목표일)')]],
        lines.slice(0, 300).map(x => '<tr class="dl-row" data-dl-open="' + esc(x.key) + '" tabindex="0"><td class="dl-cl"><b>' + esc(x.r.so) + '</b><div class="dl-dim">' + esc(x.r.customer) + '</div></td>' +
          '<td class="dl-prodcell">' + esc(x.r.name) + '<div class="dl-dim">' + esc(x.r.code) + ' · ' + esc(x.r.bulk_type || '–') + '</div></td>' +
          '<td class="dl-nowrap">' + dS(x.r.confirm_date || x.r.date) + '</td><td class="dl-nowrap">' + dS(x.r.require_date) + '</td>' +
          '<td class="num"><span class="' + (x.left < 0 ? 'dl-bad' : x.left <= 14 ? 'dl-warn' : '') + '">' + (x.left ?? '–') + '</span></td>' +
          '<td class="dl-nowrap">' + dS(x.stdEnd) + (x.stdEnd && x.r.require_date && x.stdEnd > x.r.require_date ? '<div class="dl-warn">' + T('after the required date by ', '납기보다 ') + days(x.r.require_date, x.stdEnd) + T(' d', '일 늦음') + '</div>' : '') + '</td>' +
          '<td>' + (x.cur ? esc(stepName(x.cur.id)) + ' ' + teamTag(x.cur.team) + '<div class="dl-dim">' + dS(x.tgt[x.cur.id]) + (x.curLate ? ' · <span class="dl-bad">' + x.curLate + T(' working days over', '영업일 초과') + '</span>' : '') + '</div>' : '<span class="dl-dim">' + T('no stage dates', '단계 기록 없음') + '</span>') + '</td></tr>'),
        T('No open lines match.', '해당하는 진행 오더가 없습니다.'), 'dl-tw--tall'));
  }

  /* ---------- Lead times ---------- */
  function renderLead(pane) {
    const ts = stdType(), ss = stdStage();
    const fin = H.orders().filter(r => r.status !== 'cancel' && r.finish_date && r.date && r.finish_date >= addDays(today(), -365));
    const types = [...new Set(Object.keys(TYPE_DRAFT).concat(fin.map(typeOf).filter(Boolean)))];
    const typeRows = types.map(k => {
      const ls = fin.filter(r => typeOf(r) === k), act = ls.map(r => days(r.date, r.finish_date)).filter(n => n != null);
      const within = act.filter(n => n <= (+ts[k] || TYPE_DEFAULT)).length, onT = ls.filter(r => !(r.delay_days > 0)).length;
      return '<tr><td><b>' + esc(k) + '</b></td><td class="num"><input class="input input--sm dl-num" type="number" min="0" max="400" data-dl-type="' + esc(k) + '" value="' + (ts[k] ?? TYPE_DEFAULT) + '"></td>' +
        '<td class="num">' + ls.length + '</td><td class="num">' + (median(act) ?? '–') + '</td><td class="num">' + (quant(act, 0.75) ?? '–') + '</td><td class="num">' + pct(within, act.length) + '</td><td class="num">' + pct(onT, ls.length) + '</td></tr>';
    });
    // actual stage durations recorded so far (start -> done, else previous stage's done -> done)
    const dur = {};
    Object.keys(S.d.st).forEach(so => {
      const st = stagesOf(so, S.d.st, null);
      STEPS.forEach(s => {
        const o = st[s.id], from = o.started || s.pre.map(p => st[p].done).filter(Boolean).sort().pop();
        if (o.done && from) (dur[s.id] = dur[s.id] || []).push(wdBetween(from, o.done));
      });
    });
    const meta = k => { const m = S.d.settings[k]; return m ? T('Last changed by ', '마지막 수정: ') + who(m.who) + ' · ' + dL(m.at) : T('Draft values from the design — not agreed yet.', '설계안의 임시값 — 아직 합의 전.'); };
    const cp = (() => { const tg = plan(Object.fromEntries(STEPS.map(s => [s.id, {}])), ss, '2026-01-05'); return wdBetween('2026-01-05', tg.s9); })();
    pane.innerHTML =
      card(T('Standard by type (calendar days, order → packed)', '제형별 표준 (주문 → 포장, 달력 일수)'),
        T('Used for the short-lead rule in Review and for "Standard finish" in Open orders. Next to it, what the last 12 months of completed lines actually took. ', '완료 오더 리뷰의 짧은 리드 규칙과 진행 오더의 "표준 완료"에 씁니다. 옆은 최근 12개월 완료 라인이 실제로 걸린 일수입니다. ') + meta('lead_type'),
        table([[T('Type', '제형')], [T('Standard', '표준'), 1], [T('Lines', '라인'), 1], [T('Median', '중앙값'), 1], [T('75th pct', '75%'), 1], [T('Within standard', '표준 안 완료'), 1], [T('By required date', '납기 안 완료'), 1]], typeRows),
        '<button type="button" class="btn btn--sm" data-dl-act="save-type">' + T('Save', '저장') + '</button>') +
      card(T('Stage standards (working days)', '단계별 표준 (영업일)'),
        T('Each stage\'s target = the later of the stages before it + this many working days. The critical path adds up to ', '각 단계 목표일 = 앞 단계 중 늦은 날 + 이 영업일 수. 지금 값의 최장 경로 합계는 ') + '<b>' + cp + T(' working days', '영업일') + '</b>. ' + meta('lead_std') + ' ' +
        T('Recorded actuals fill in as cases are answered and Kanban / Cin7 send dates.', '실제값은 케이스 답변과 Kanban·Cin7 날짜가 쌓이면서 채워집니다.'),
        table([[T('Stage', '단계')], [T('Team', '담당')], [T('Standard', '표준'), 1], [T('Recorded', '기록'), 1], [T('Median actual', '실제 중앙값'), 1]],
          STEPS.map(s => '<tr><td>' + esc(stepName(s.id)) + '</td><td>' + teamTag(s.team) + '</td><td class="num"><input class="input input--sm dl-num" type="number" min="0" max="200" data-dl-std="' + s.id + '" value="' + (ss[s.id] ?? '') + '"></td>' +
            '<td class="num">' + ((dur[s.id] || []).length || '–') + '</td><td class="num">' + (median(dur[s.id] || []) ?? '–') + '</td></tr>')),
        '<button type="button" class="btn btn--sm" data-dl-act="save-std">' + T('Save', '저장') + '</button>');
  }

  /* ---------- Sources ---------- */
  function renderSources(pane) {
    const k = S.d.kanban, src = S.d.sources, bk = (S.d.settings.backup_last || {}).v;
    const last = H.orders().reduce((m, r) => [r.date, r.confirm_date, r.finish_date].reduce((a, d) => d && d > a ? d : a, m), '');
    const rules = Object.entries(k.rules).map(([b, rs]) => rs.length ? rs.map(r => '<tr><td>' + esc(b) + '</td><td>' + (r.to ? T('moved to ', '칸 이동: ') + '<b>' + esc(r.to) + '</b>' : T('label ', '라벨: ') + '<b>' + esc(r.label) + '</b>') + '</td><td>' + esc(stepName(r.step)) + ' — ' + (r.set === 'done' ? T('done', '완료') : T('started', '시작')) + '</td></tr>').join('')
      : '<tr><td>' + esc(b) + '</td><td colspan="2" class="dl-dim">' + T('kept, not used for stages yet', '받아 두기만 함 (단계 매핑 전)') + '</td></tr>').join('');
    pane.innerHTML =
      '<div class="dl-kpis">' +
      kpi('oERP', dS(last), T('latest date in the order data (rebuilt with each export)', '오더 데이터의 최신 날짜 (내보내기마다 갱신)')) +
      kpi('Kanban', src.hook ? (k.boards.reduce((n, b) => n + b.events, 0) + T(' events', '건')) : T('Not connected', '미연결'), src.hook ? T('receiving at /api/hooks/kanban', '/api/hooks/kanban 으로 수신 중') : T('waiting for IT (question list in the design doc)', 'IT 답변 대기 (설계안 09장 질문)'), src.hook ? '' : 'dl-kpi--muted') +
      kpi('Cin7', T('Not connected', '미연결'), T('needs a read-only API key', '읽기 전용 API 키 필요'), 'dl-kpi--muted') +
      kpi(T('Backup', '백업'), bk ? dS(bk.day) : '–', bk ? bk.keys + T(' KV keys copied, kept 14 days', '개 KV 키 복사, 14일 보관') : T('runs daily at 02:30', '매일 02:30 실행')) + '</div>' +
      card(T('Kanban cards without an SO', 'SO를 못 찾은 Kanban 카드'),
        T('A card is linked to an order by "[SO-02787]" at the start of its title. Cards without one are listed here; type the SO to link them and their stage dates are recalculated.',
          '카드 제목 앞의 "[SO-02787]"로 오더와 연결합니다. 번호가 없는 카드는 여기에 모입니다. SO를 적으면 연결되고 단계 날짜를 다시 계산합니다.'),
        table([[T('Board', '보드')], [T('Card', '카드')], [T('Last change', '마지막 변경')], ['SO']], k.unmatched.map(c => '<tr><td>' + esc(c.board) + '</td><td class="dl-wrap">' + esc(c.title || c.card) + '</td><td class="dl-nowrap">' + dL(c.last_at) + '</td>' +
          '<td class="dl-nowrap"><input class="input input--sm dl-soin" placeholder="SO02787" data-dl-map="' + esc(c.board + '\n' + c.card) + '"> <button type="button" class="btn btn--sm" data-dl-act="map" data-dl-card="' + esc(c.board + '\n' + c.card) + '">' + T('Link', '연결') + '</button></td></tr>'),
          T('None.', '없습니다.'))) +
      card(T('Latest Kanban changes', '최근 Kanban 변경'), '',
        table([[T('When', '시각')], [T('Board', '보드')], ['SO'], [T('Card', '카드')], [T('Change', '변경')]], k.recent.map(e => '<tr><td class="dl-nowrap">' + esc(tL(e.at)) + '</td><td>' + esc(e.board) + '</td><td>' + esc(e.so || '–') + '</td><td class="dl-wrap">' + esc(e.title || e.card) + '</td><td class="dl-wrap">' + esc([e.from_col, e.to_col].filter(Boolean).join(' → ') || e.type || '') + '</td></tr>'),
          T('Nothing received yet.', '아직 받은 변경이 없습니다.'))) +
      card(T('How Kanban columns map to stages', 'Kanban 칸 → 단계 매핑'), T('From the boards as seen on 28 Oct; to be confirmed with IT before relying on them.', '10-28 화면 기준. IT와 확인한 뒤 확정합니다.'),
        table([[T('Board', '보드')], [T('When', '조건')], [T('Stage', '단계')]], [rules]));
  }

  /* ---------- drawer: one line ---------- */
  function openDrawer(key) { S.open = key; S.hist = null; S.drawn = null; renderDrawer(); $('#dl-drawer').hidden = false; }
  function closeDrawer() { S.open = null; S.drawn = null; $('#dl-drawer').hidden = true; }
  // Re-drawing the same line after a save keeps what is typed in the other fields (and focus).
  const fieldSig = el => (el.closest('[data-dl-step]') ? el.closest('[data-dl-step]').dataset.dlStep : '') + ':' + (el.dataset.dlV || el.dataset.dlSf);
  function renderDrawer() {
    const panel = $('#dl-panel');
    const fields = () => [...panel.querySelectorAll('[data-dl-v],[data-dl-sf]')];
    const keep = S.drawn === S.open ? fields().map(el => [fieldSig(el), el.type === 'checkbox' ? el.checked : el.value]) : null;
    const focus = keep && panel.contains(document.activeElement) && document.activeElement.matches('[data-dl-v],[data-dl-sf]') ? fieldSig(document.activeElement) : null;
    drawLine(panel);
    S.drawn = S.open;
    if (!keep) return;
    const m = new Map(keep);
    fields().forEach(el => {
      const k = fieldSig(el);
      if (m.has(k)) { if (el.type === 'checkbox') el.checked = m.get(k); else el.value = m.get(k); }
      if (k === focus) el.focus();
    });
  }
  function drawLine(panel) {
    const x = completed().find(c => c.key === S.open) || orderLine(S.open);
    if (!x) { panel.innerHTML = '<div class="dl-none">' + T('This line is not in the order data.', '이 라인은 오더 데이터에 없습니다.') + '</div>'; return; }
    const r = x.r, rv = x.rv || {}, done = !!r.finish_date;
    const st = stagesOf(r.so, S.d.st, r), tgt = plan(st, stdStage(), startOf(r));
    const others = H.orders().filter(o => o.so === r.so && lineKey(o) !== x.key);
    const codeOpts = '<option value="">—</option>' + Object.keys(TEAMS).map(k => '<optgroup label="' + esc(team(k)) + '">' + CODES.filter(c => c.team === k).map(c => '<option value="' + c.c + '"' + (rv.cause === c.c ? ' selected' : '') + '>' + esc(codeName(c.c)) + '</option>').join('') + '</optgroup>').join('');
    const stepOpts = '<option value="">—</option>' + STEPS.map(s => '<option value="' + s.id + '"' + (rv.step === s.id ? ' selected' : '') + '>' + esc(stepName(s.id)) + '</option>').join('');
    const srcTag = o => o.src ? '<span class="dl-src dl-src--' + esc(o.src) + '">' + esc(o.src) + '</span>' : '';
    panel.innerHTML =
      '<div class="dl-dr__head"><div><div class="dl-eyebrow">' + esc(r.customer) + '</div><h3 class="dl-dr__title">' + esc(r.so) + ' · ' + esc(r.name) + '</h3>' +
      '<div class="dl-dim">' + esc(r.code) + ' · ' + esc(r.bulk_type || '–') + ' · ' + (r.qty || 0).toLocaleString() + T(' units', '개') + (others.length ? T(' · same SO: ', ' · 같은 SO: ') + others.map(o => esc(o.code)).join(', ') : '') + '</div></div>' +
      '<button type="button" class="btn btn--sm" data-dl-close="1" aria-label="Close"><span class="icon">close</span></button></div>' +
      '<div class="dl-facts">' +
      fact(T('Ordered', '주문'), dS(r.date)) + (done ? '' : fact(T('Confirmed', '확정'), dS(r.confirm_date))) +
      fact(T('Required', '납기'), dS(r.require_date), x.lead != null ? T('lead ', '리드 ') + x.lead + T(' d', '일') : '') +
      fact(T('Standard', '표준'), x.std + T(' days', '일'), esc(r.bulk_type || T('default', '기본'))) +
      (done ? fact(T('Packed', '포장 완료'), dS(r.finish_date), x.actual + T(' days', '일 걸림')) + fact(T('Late', '지연'), '<span class="dl-late dl-late--' + sev(r.delay_days) + '">' + (r.delay_days > 0 ? '+' : '') + r.delay_days + '</span>', r.delay_days > 0 ? T(sev(r.delay_days), { severe: '심각', moderate: '보통', mild: '경미', minor: '미미' }[sev(r.delay_days)]) : T('on time', '정시'))
        : fact(T('Days left', '남은 일수'), String(days(today(), r.require_date)))) + '</div>' +
      (done && x.late ? '<div class="dl-countrow">' + T('Counted in the review: ', '리뷰 집계: ') + '<select class="select select--sm" data-dl-incl="1">' +
        [['', T('rule decides', '규칙대로') + (x.lead < x.std && x.actual <= x.std ? T(' (left out: short lead)', ' (제외: 짧은 리드)') : T(' (counted)', ' (집계)'))], ['1', T('always count', '항상 집계')], ['0', T('never count', '집계 안 함')]]
          .map(([v, n]) => '<option value="' + v + '"' + (String(rv.incl ?? '') === v ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></div>' : '') +
      '<h4 class="dl-dr__h">' + T('Stages', '단계') + ' <span class="dl-dim">' + T('— dates shared by every line of ', '— ') + esc(r.so) + T('', ' 의 모든 라인이 같이 씀') + '</span></h4>' +
      '<div class="table-wrap dl-tw"><table class="dl-table dl-stages"><thead><tr><th>' + T('Stage', '단계') + '</th><th>' + T('Started', '시작') + '</th><th>' + T('Done', '완료') + '</th><th class="num">' + T('Took', '걸림') + '</th><th>' + T('Target', '목표') + '</th><th>' + T('Ask', '질문') + '</th><th>' + T('Answer / note', '답변·메모') + '</th></tr></thead><tbody>' +
      STEPS.map(s => {
        const o = st[s.id], from = o.started || s.pre.map(p => st[p].done).filter(Boolean).sort().pop(), took = o.done && from ? wdBetween(from, o.done) : null, std = +stdStage()[s.id] || 0;
        const auto = Object.entries(o.auto).map(([k, a]) => '<div class="dl-dim">' + esc(k) + ': ' + (a.started ? dS(a.started) + ' → ' : '') + (a.done ? dS(a.done) : '…') + '</div>').join('');
        return '<tr data-dl-step="' + s.id + '"><td class="dl-nowrap">' + esc(s.no + ' ' + T(s.en, s.ko)) + '<div>' + teamTag(s.team) + '</div></td>' +
          '<td><input class="input input--sm dl-date" type="date" data-dl-sf="started" value="' + esc((o.manual && o.manual.started) || '') + '">' + (o.started && !(o.manual && o.manual.started) ? '<div class="dl-dim">' + dS(o.started) + '</div>' : '') + '</td>' +
          '<td><input class="input input--sm dl-date" type="date" data-dl-sf="done" value="' + esc((o.manual && o.manual.done) || '') + '">' + (o.done && !(o.manual && o.manual.done) ? '<div class="dl-dim">' + dS(o.done) + ' ' + srcTag(o) + '</div>' : '') + auto + '</td>' +
          '<td class="num">' + (took == null ? '–' : '<span class="' + (took > std ? 'dl-bad' : '') + '">' + took + '</span><div class="dl-dim">/ ' + std + '</div>') + '</td>' +
          '<td class="dl-nowrap">' + dS(tgt[s.id]) + (!done && !o.done && tgt[s.id] && tgt[s.id] < today() ? '<div class="dl-bad">' + T('overdue', '초과') + '</div>' : '') + '</td>' +
          '<td><input type="checkbox" data-dl-sf="ask"' + (o.ask ? ' checked' : '') + ' title="' + T('Ask this department', '이 부서에 질문') + '"></td>' +
          '<td><input class="input input--sm dl-note" data-dl-sf="note" value="' + esc(o.note || '') + '" maxlength="2000" placeholder="' + T('what happened', '무슨 일이 있었나') + '"></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="dl-dim dl-small">' + T('Dates typed here override Kanban / Cin7 / oERP for that stage. Changes save when you leave the field.', '여기 적은 날짜가 그 단계의 Kanban·Cin7·oERP 값보다 우선합니다. 칸을 벗어나면 저장됩니다.') + '</div>' +
      (done ? '<h4 class="dl-dr__h">' + T('Verdict', '사유') + ' ' + statusBadge(rv.status) + '</h4>' +
        '<div class="dl-form">' +
        '<label>' + T('Stage where the time went', '시간이 걸린 단계') + '<select class="select select--sm" data-dl-v="step">' + stepOpts + '</select></label>' +
        '<label>' + T('Cause', '원인 코드') + '<select class="select select--sm" data-dl-v="cause">' + codeOpts + '</select></label>' +
        '<label>' + T('Could we have prevented it?', '막을 수 있었나') + '<select class="select select--sm" data-dl-v="ctrl"><option value="">—</option>' + Object.keys(CTRL).map(k => '<option value="' + k + '"' + (rv.ctrl === k ? ' selected' : '') + '>' + esc(T(CTRL[k][0], CTRL[k][1])) + '</option>').join('') + '</select></label>' +
        '<label class="dl-wide">' + T('What happened', '무슨 일이 있었나') + '<textarea class="input" rows="2" maxlength="2000" data-dl-v="note">' + esc(rv.note || '') + '</textarea></label>' +
        '<label class="dl-wide">' + T('How to prevent it next time', '재발 방지') + '<textarea class="input" rows="2" maxlength="2000" data-dl-v="prevent">' + esc(rv.prevent || '') + '</textarea></label>' +
        '<label class="check-label"><input type="checkbox" data-dl-v="is_case"' + (rv.is_case ? ' checked' : '') + '> ' + T('Review case (departments look at it together)', '리뷰 케이스 (부서가 함께 검토)') + '</label>' +
        '<label class="dl-wide">' + T('Why it is a case', '케이스로 고른 이유') + '<input class="input input--sm" maxlength="2000" data-dl-v="why" value="' + esc(rv.why || '') + '"></label>' +
        '</div><div class="dl-btns">' +
        '<button type="button" class="btn btn--sm" data-dl-act="save-v"' + (S.saving ? ' disabled' : '') + '>' + T('Save', '저장') + '</button>' +
        (rv.status === 'confirmed' ? '<button type="button" class="btn btn--sm" data-dl-act="unconfirm"' + (S.saving ? ' disabled' : '') + '>' + T('Reopen', '확정 취소') + '</button>'
          : '<button type="button" class="btn btn--sm btn--primary" data-dl-act="confirm"' + (S.saving ? ' disabled' : '') + '>' + T('Save & confirm', '저장·확정') + '</button>') +
        '<span class="dl-dim">' + (rv.updated_by ? T('Last saved by ', '마지막 저장: ') + who(rv.updated_by) + ' · ' + dL(rv.updated_at) : '') +
        (rv.confirmed_by ? T(' · confirmed by ', ' · 확정: ') + who(rv.confirmed_by) + ' · ' + dL(rv.confirmed_at) : '') + '</span></div>' : '') +
      '<details class="dl-hist" data-dl-hist="1"' + (S.hist ? ' open' : '') + '><summary>' + T('History', '변경 기록') + '</summary>' + (S.hist ? histHtml() : '<div class="dl-dim">…</div>') + '</details>';
  }
  const fact = (lb, v, sm) => '<div class="dl-fact"><div class="dl-kpi__lb">' + lb + '</div><div class="dl-fact__v">' + v + '</div>' + (sm ? '<div class="dl-dim">' + sm + '</div>' : '') + '</div>';
  function histHtml() {
    if (!S.hist.length) return '<div class="dl-dim">' + T('No changes yet.', '아직 변경이 없습니다.') + '</div>';
    return '<ul class="dl-histlist">' + S.hist.map(h => {
      let b = {}; try { b = JSON.parse(h.body || '{}'); } catch (e) { /* raw */ }
      const n = b.new || {};
      const what = h.kind.startsWith('review') ? [n.cause && codeName(n.cause), n.step && stepName(n.step), b.status].filter(Boolean).join(' · ') : [n.started, n.done, n.note].filter(Boolean).join(' · ');
      return '<li><span class="dl-dim">' + esc(tL(h.at)) + '</span> <b>' + who(h.who) + '</b> ' + esc(h.kind) + (what ? ' — ' + esc(what) : '') + '</li>';
    }).join('') + '</ul>';
  }
  function loadHist() {
    const x = S.open;
    api('/audit?ref=' + encodeURIComponent(x) + '&so=' + encodeURIComponent(x.split('|')[0]))
      .then(h => { S.hist = h; if (S.open === x) renderDrawer(); })
      .catch(e => { S.hist = []; flash(e.message, true); });
  }
  function verdictPatch() {
    const v = k => { const el = $('[data-dl-v="' + k + '"]'); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
    const rv = S.d.rv[S.open] || {};
    return { step: v('step') || null, cause: v('cause') || null, ctrl: v('ctrl') || null, note: v('note') || null, prevent: v('prevent') || null, why: v('why') || null, is_case: v('is_case') ? 1 : 0, incl: rv.incl ?? null };
  }
  function saveReview(action, patch) {
    const key = S.open, so = key.split('|')[0];
    save(() => api('/review', { key, so, action, patch: patch || verdictPatch() }));
  }
  function saveStep(stepId) {
    const tr = $('[data-dl-step="' + stepId + '"]'), g = f => tr.querySelector('[data-dl-sf="' + f + '"]');
    const so = S.open.split('|')[0], cur = (S.d.st[so] || []).find(r => r.src === 'manual' && r.step === stepId) || {};
    save(() => api('/step', { so, step: stepId, started: g('started').value || null, done: g('done').value || null, note: g('note').value.trim() || null, ask: g('ask').checked, cause: cur.cause || null }), true);
  }
  function save(fn, quiet) {
    if (S.saving) return;
    S.saving = true;
    fn().then(() => load()).then(() => { S.saving = false; if (!quiet) flash(T('Saved', '저장됨')); render(); })
      .catch(e => { S.saving = false; flash(T('Not saved: ', '저장 안 됨: ') + e.message, true); render(); });
  }
  function flash(msg, bad) {
    let el = $('#dl-flash');
    if (!el) { el = document.createElement('div'); el.id = 'dl-flash'; root.appendChild(el); }
    el.className = 'dl-flash' + (bad ? ' dl-flash--bad' : '');
    el.textContent = msg;
    clearTimeout(flash.t); flash.t = setTimeout(() => el.remove(), bad ? 6000 : 2200);
  }

  /* ---------- events ---------- */
  function onClick(e) {
    const t = e.target.closest('[data-dl-view],[data-dl-lang],[data-dl-act],[data-dl-open],[data-dl-close],[data-dl-of],[data-dl-copy]');
    if (!t || !root.contains(t)) return;
    if (t.dataset.dlView) { S.view = t.dataset.dlView; try { localStorage.setItem(VIEW_KEY, S.view); } catch (x) { /* ignore */ } render(); return; }
    if (t.dataset.dlLang) { S.lang = t.dataset.dlLang; try { localStorage.setItem(LANG_KEY, S.lang); } catch (x) { /* ignore */ } render(); return; }
    if (t.dataset.dlOpen) { openDrawer(t.dataset.dlOpen); return; }
    if (t.dataset.dlClose) { closeDrawer(); return; }
    if (t.dataset.dlOf) { F.of = t.dataset.dlOf; render(); return; }
    if (t.dataset.dlCopy) { copyAsks(t.dataset.dlCopy); return; }
    const a = t.dataset.dlAct;
    if (a === 'reload') refresh();
    else if (a === 'suggest') suggest();
    else if (a === 'save-v') saveReview('save');
    else if (a === 'confirm') { const p = verdictPatch(); if (!p.cause || !p.step) return flash(T('Pick the stage and the cause first.', '단계와 원인 코드를 먼저 고르세요.'), true); saveReview('confirm', p); }
    else if (a === 'unconfirm') saveReview('unconfirm');
    else if (a === 'save-type' || a === 'save-std') {
      const attr = a === 'save-type' ? 'dlType' : 'dlStd', v = {};
      root.querySelectorAll(a === 'save-type' ? '[data-dl-type]' : '[data-dl-std]').forEach(i => { if (i.value !== '') v[i.dataset[attr]] = +i.value; });
      save(() => api('/setting', { k: a === 'save-type' ? 'lead_type' : 'lead_std', v }));
    } else if (a === 'map') {
      const id = t.dataset.dlCard, inp = t.parentElement.querySelector('input'), so = (inp.value || '').trim().toUpperCase().replace(/^SO-?/, 'SO');
      if (!/^SO\d{3,6}$/.test(so)) return flash(T('Type an SO like SO02787.', 'SO02787 형식으로 적으세요.'), true);
      const [board, cardId] = id.split('\n');
      save(() => api('/kanban_map', { board, card: cardId, so }));
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.dlF) { F[t.dataset.dlF] = t.type === 'checkbox' ? t.checked : t.value; if (t.dataset.dlF !== 'q' && t.dataset.dlF !== 'oq') render(); return; }
    if (t.dataset.dlSf) { saveStep(t.closest('[data-dl-step]').dataset.dlStep); return; }
    if (t.dataset.dlIncl) { const p = Object.assign(verdictPatch(), { incl: t.value === '' ? null : +t.value }); saveReview('save', p); return; }
  }
  let qTimer = null;
  function onInput(e) {
    const t = e.target;
    if (t.dataset.dlF === 'q' || t.dataset.dlF === 'oq') {
      F[t.dataset.dlF] = t.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { render(); const i = root.querySelector('[data-dl-f="' + t.dataset.dlF + '"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250);
    }
  }
  document.addEventListener('toggle', e => { if (root && e.target.dataset && e.target.dataset.dlHist && e.target.open && !S.hist && S.open) loadHist(); }, true);
  document.addEventListener('keydown', e => { if (root && e.key === 'Enter' && e.target.classList && e.target.classList.contains('dl-row')) openDrawer(e.target.dataset.dlOpen); });

  if (typeof window !== 'undefined') window.Delays = { mount, refresh, model: { STEPS, CODES, stagesOf, plan, wdBetween, addWD, lineKey } };
})();
