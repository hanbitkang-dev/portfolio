"""Build the CRM demo from the real Cloudflare Worker app.

    python tools/build_crm.py <path-to>/<crm-repo>/preview

  1. Turns the synthetic sales rows (tools/gen_crm_seed.py) into ORDERS / CUSTS / REPS
     exactly as the real build.py does from the ERP export.
  2. Copies template.html, worker.js and the tab modules, removing confidential content:
     names from tools/scrub_rules.local.json, plus every real client and outreach-prospect
     name read from the private source (kept in memory, never written out).
  3. Replaces outreach_data.js with invented data (tools/make_outreach_demo.js).
  4. Puts the Worker emulator, KV / D1 seed and an AI mock in front of the page.
  5. Fails if any denied term is left in the output.
"""
import json, pathlib, re, subprocess, sys
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'crm'
RULES = json.loads((ROOT / 'tools' / 'scrub_rules.local.json').read_text(encoding='utf-8'))
TAB_FILES = ['worker.js', 'production.js', 'production.css', 'delays.js', 'delays.css', 'outreach.js', 'outreach.css']


# ── ORDERS / CUSTS / REPS, same rules as the real build.py ─────────────
def to_date(v):
    s = str(v or '')[:10]
    if len(s) != 10 or s[4] != '-':
        return ''
    try:
        datetime.strptime(s, '%Y-%m-%d')
    except ValueError:
        return ''
    return s


def to_num(v):
    return float(v) if v not in ('', None) else None


def classify_type(bt, name):
    bt = (bt or '').strip().lower()
    m = {'hard': 'H', 'soft': 'S', 'tablet': 'T', 'liquid hard': 'L', 'liquid': 'O'}
    if bt in m:
        return m[bt]
    if bt == 'powder':
        n = (name or '').lower()
        if 'sachet' in n or re.search(r"\d+'?s(?![a-z0-9])", n):
            return 'PS'
        if re.search(r'\d+\s*k?g(?![a-z0-9])', n):
            return 'P'
    return None


def build_data(rows):
    orders = []
    for r in rows:
        reg, conf = to_date(r['register_date']), to_date(r['confirm_date'])
        cands = [d for d in (reg, conf) if d]
        req, fin = to_date(r['require_date']), to_date(r['packing_finish_date'])
        delay = (datetime.strptime(fin, '%Y-%m-%d') - datetime.strptime(req, '%Y-%m-%d')).days if req and fin else None
        bt = r['bulk_type'] or ''
        orders.append({
            'so': r['sales_order_no'], 'date': min(cands) if cands else '', 'confirm_date': conf, 'require_date': req, 'finish_date': fin,
            'delay_days': delay, 'customer': r['client_name'], 'code': r['product_code'], 'name': r['product_name'],
            'qty': int(r['quantity'] or 0), 'finish_qty': int(r['finish_result_qty']) if to_num(r['finish_result_qty']) is not None else None,
            'price': round(float(r['unit_price'] or 0), 2), 'value': round(float(r['item_value'] or 0), 2), 'cur': r['currency'],
            'status': str(r['status']).lower(), 'bulk': bool(r['bulk_code']), 'bulk_type': bt, 'is_blister': 'blister' in r['product_name'].lower(),
            'finish_order_qty': int(r['finish_order_qty']) if to_num(r['finish_order_qty']) is not None else None,
            'bulk_order_qty': to_num(r['bulk_order_qty']), 'bulk_result_qty': to_num(r['bulk_result_qty']),
            'register_name': r['register_name'], 'need_ed': str(r['need_ed']).strip().lower() == 'yes', 'type_code': classify_type(bt, r['product_name']),
        })
    by = {}
    for r in rows:
        by.setdefault(r['client_name'], []).append(r)
    custs = []
    for client, grp in sorted(by.items()):
        dates = sorted(d for d in (to_date(x['register_date']) for x in grp) if d)
        last = sorted(grp, key=lambda x: to_date(x['register_date']))[-1]
        custs.append({'name': client, 'rep': last['register_name'], 'orders': len({x['sales_order_no'] for x in grp}), 'lines': len(grp),
                      'nzd': round(sum(float(x['item_value']) for x in grp if x['currency'] == 'NZD'), 2),
                      'usd': round(sum(float(x['item_value']) for x in grp if x['currency'] == 'USD'), 2),
                      'first': dates[0] if dates else '', 'last': dates[-1] if dates else '', 'status': '', 'notes': ''})
    reps = sorted({r['register_name'] for r in rows if r['register_name']})
    return orders, custs, reps


# ── scrubbing ─────────────────────────────────────────────────────────
def private_names(src):
    """Real client names (data_custs.js) and outreach prospects/contacts (outreach_data.js), read in memory only."""
    js = r"""
    global.window = global; const fs = require('fs'), path = require('path'); const src = process.argv[1];
    const cust = JSON.parse(fs.readFileSync(path.join(src, 'data_custs.js'), 'utf8').match(/\[.*\]/s)[0]).map(c => c.name);
    require(path.join(src, 'outreach_data.js')); const D = window.OUTREACH_DATA; const S = D.strategy;
    const pros = [].concat(D.targets.map(t => t.name), D.targets.flatMap(t => (t.contacts || []).map(c => c.name)),
      D.market.map(m => m.name), S.backlog.map(b => b.name), S.koImporters.rows.map(r => r.importer),
      S.koImporters.competitors.map(c => c.name), Object.keys(S.koImporters).filter(k => /Buyers$/.test(k)).flatMap(k => S.koImporters[k]));
    console.log(JSON.stringify({ cust, pros }));
    """
    out = subprocess.run(['node', '-e', js, str(src)], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    strip = lambda n: re.sub(r'\s*(\(.*?\)|,?\s*(ltd\.?|limited|co\.?,?\s*ltd\.?|pty|inc\.?|llc))+\s*$', '', n, flags=re.I).strip()
    names = set()
    for n in d['cust'] + d['pros']:
        if not n:
            continue
        for v in {n.strip(), strip(n)}:
            if len(v) >= 5 and not v.startswith('일반 문의'):
                names.add(v)
    ignore = {x.lower() for x in RULES.get('names_ignore', [])}
    return sorted((n for n in names if n.lower() not in ignore), key=len, reverse=True)


def make_scrub(names):
    rules = [(re.compile(p, re.I if 'i' in f else 0), rep) for p, rep, f in RULES.get('crm_replace', []) + RULES['replace']]
    name_res = [re.compile(r'(?<![\w])' + re.escape(n) + r'(?![\w])') for n in names]

    def scrub(text, names_too=True):
        for rx, rep in rules:
            text = rx.sub(rep, text)
        if names_too:
            for rx in name_res:
                text = rx.sub('a client', text)
        return text
    return scrub


def demo_reviews_sql(orders):
    """A few delay verdicts so the Delays tab shows the review flow with data in it."""
    late = sorted((o for o in orders if o['finish_date'] and (o['delay_days'] or 0) > 10), key=lambda o: o['finish_date'], reverse=True)[:9]
    verdicts = [('s3a', 'PU-2', 'external', 'Raw material arrived 3 weeks after the supplier date.', 'Ask for a second source on this ingredient.'),
                ('s3b', 'SA-3', 'customer', 'Client approved the label artwork late.', 'Send artwork with the order confirmation.'),
                ('s6', 'PL-1', 'internal', 'Slot pushed back for a larger order.', 'Flag short-lead orders in the weekly plan.'),
                ('s4', 'QA-2', 'external', 'Material failed incoming QC and was retested.', ''),
                ('s3c', 'PU-4', 'external', 'Bottles delivered late by the supplier.', 'Keep two weeks of bottle stock.'),
                ('s7', 'PL-2', 'internal', 'Packing line short-staffed for a week.', '')]
    q = lambda v: 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"
    out = []
    for i, o in enumerate(late):
        st, cause, ctrl, note, prev = verdicts[i % len(verdicts)]
        status = 'confirmed' if i < 4 else 'proposed' if i < 7 else 'open'
        key = '%s|%s|%s' % (o['so'], o['code'], o['require_date'])
        at = o['finish_date'] + 'T03:00:00.000Z'
        out.append('INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES '
                   '(%s, %s, %s, %s, %s, %s, %s, NULL, %d, NULL, %s, %s, %s, %s, %s);' % (
                       q(key), q(o['so']), q(st if status != 'open' else None), q(cause if status != 'open' else None), q(ctrl if status != 'open' else None),
                       q(note if status != 'open' else None), q(prev or None), 1 if i < 3 else 0, q(status), q('planner@example.com'), q(at),
                       q('planner@example.com' if status == 'confirmed' else None), q(at if status == 'confirmed' else None)))
    return '\n'.join(out) + '\n'


SYNTH_DEPOSIT = """var DEFAULT_CLIENT_DEPOSIT_SEED={
  'Seoul Glow Co., Ltd.':50,
  'Jeju Daily Health':50,
  'Lotus Bay Trading Ltd':30,
  'Kiwi Origin Exports':50,
  'Taipei Wellness Trading':50,
  'Hikari Life Co.':30,
  'Fernleaf Pharmacy Group':{default:20,brands:{'Fernleaf Own':10}}
};"""

HEAD = '''<!-- demo runtime: Worker emulator + synthetic data (see README) -->
<script>window.DEMO_TODAY = '2026-10-29';</script>
<script src="../shared/demo-clock.js"></script>
<script>
window.WORKER_DEMO = { key: 'crm-demo', email: 'demo.user@example.com', accessTeam: 'https://demo-team.cloudflareaccess.com', workerUrl: 'worker.js', vendor: '../shared/vendor/' };
try { if (!localStorage.getItem('crmdemo_last_author')) localStorage.setItem('crmdemo_last_author', 'Jamie Park'); } catch (e) {}
</script>
<script src="seed_kv.js"></script>
<script src="seed_d1.js"></script>
<script>try { if (!localStorage.getItem('crmdemo_fx_rates')) localStorage.setItem('crmdemo_fx_rates', window.WORKER_SEED_KV['crm:fx_rates']); } catch (e) {}</script>
<script src="mocks.js"></script>
<script src="../shared/worker-emulator.js"></script>
<link rel="stylesheet" href="../shared/demo-badge.css">
'''


def main():
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '')
    if not (src / 'template.html').exists():
        sys.exit('usage: build_crm.py <crm-repo>/preview folder')
    names = private_names(src)
    scrub = make_scrub(names)

    rows = json.loads((OUT / '_build' / 'sales_rows.json').read_text(encoding='utf-8'))
    orders, custs, reps = build_data(rows)

    t = (src / 'template.html').read_text(encoding='utf-8-sig')
    t, n = re.subn(r'var DEFAULT_CLIENT_DEPOSIT_SEED=\{.*?\n\};', lambda m: SYNTH_DEPOSIT, t, count=1, flags=re.S)
    assert n == 1, 'deposit seed block not found'
    t = t.replace('<script src="https://accounts.google.com/gsi/client" async></script>', '')
    t = t.replace('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', '../shared/vendor/chart.umd.js')
    t, n = re.subn(r'https://script\.google\.com/[^"]*\?page=pricing" target="_blank"', '../pricing/" target="_self"', t)
    assert n == 1, 'pricing link not found'
    t = scrub(t)
    for ph, val in [('CUSTS_DATA', json.dumps(custs, ensure_ascii=False)), ('ORDERS_DATA', json.dumps(orders, ensure_ascii=False)),
                    ('REPS_DATA', json.dumps(reps, ensure_ascii=False)),
                    ('REPS_OPTIONS', '\n'.join('<option value="%s">%s</option>' % (r, r) for r in reps))]:
        assert ph in t or ph == 'REPS_OPTIONS', ph
        t = t.replace(ph, val)
    t = re.sub(r'<head>', '<head>\n' + HEAD, t, count=1, flags=re.I)
    t = re.sub(r'</body>', '<script src="../shared/demo-badge.js"></script>\n</body>', t, count=1, flags=re.I)
    (OUT / 'index.html').write_text(t, encoding='utf-8')

    for f in TAB_FILES:
        (OUT / f).write_text(scrub((src / f).read_text(encoding='utf-8-sig')), encoding='utf-8')

    tmp = OUT / '_build' / 'outreach_data.raw.js'
    subprocess.run(['node', str(ROOT / 'tools' / 'make_outreach_demo.js'), str(src / 'outreach_data.js'), str(tmp)], check=True)
    (OUT / 'outreach_data.js').write_text(scrub(tmp.read_text(encoding='utf-8')), encoding='utf-8')
    tmp.unlink()

    sql = (src / 'migrations' / '0001_delays.sql').read_text(encoding='utf-8')
    sql += '\n' + demo_reviews_sql(orders)
    (OUT / 'seed_d1.js').write_text('/* D1 schema for the demo database (migrations/0001_delays.sql). */\nwindow.WORKER_SEED_SQL = '
                                    + json.dumps(sql) + ';\n', encoding='utf-8')

    bad = []
    for p in list(OUT.glob('*.js')) + list(OUT.glob('*.html')) + list(OUT.glob('*.css')):
        low = p.read_text(encoding='utf-8', errors='ignore').lower()
        for term in RULES['deny'] + [n.lower() for n in names]:
            for m in re.finditer(r'(?<![\w])' + re.escape(term.lower()) + r'(?![\w])', low):
                bad.append('%s: %r near %r' % (p.name, term, low[max(0, m.start() - 50):m.end() + 50]))
    if bad:
        print('\n'.join(bad[:60]))
        sys.exit('DENIED TERMS FOUND (%d)' % len(bad))
    print('built crm/index.html: %d order lines, %d clients, %d reps; %d private names checked; deny check clean' % (len(orders), len(custs), len(reps), len(names)))


if __name__ == '__main__':
    main()
