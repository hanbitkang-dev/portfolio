"""Generate the synthetic dataset for the CRM demo.

Invented clients, products, sales orders, deals, activities, meetings and production
uploads. Nothing is derived from a real company's records. Deterministic.

    python tools/gen_crm_seed.py   ->  crm/_build/sales_rows.json, crm/seed_kv.js, crm/seed_d1.js
"""
import json, random, pathlib, datetime as dt

R = random.Random(42)
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'crm'
TODAY = dt.date(2026, 10, 29)
REPS = ['Alex Kim', 'Jamie Park', 'Sam Taylor']
MANAGER = 'Chris Lee'

CLIENTS = [
    # name, market, currency, size (1-5), rep
    ('Kauri Wellness Ltd', 'NZ', 'NZD', 5, 0), ('Tui Naturals Ltd', 'NZ', 'NZD', 4, 1), ('Southern Light Health', 'NZ/AU', 'NZD', 5, 2),
    ('Pohutukawa Vitality', 'NZ', 'NZD', 3, 0), ('Aroha Botanics Ltd', 'NZ', 'NZD', 3, 1), ('Harbourside Supplements Pty', 'AU', 'NZD', 4, 2),
    ('Seoul Glow Co., Ltd.', 'KR', 'USD', 4, 0), ('Jeju Daily Health', 'KR', 'USD', 3, 0), ('Lotus Bay Trading Ltd', 'HK', 'USD', 3, 1),
    ('Fernleaf Pharmacy Group', 'NZ', 'NZD', 2, 2), ('Alpine Sport Nutrition', 'NZ', 'NZD', 2, 1), ('Coastline Organics', 'NZ', 'NZD', 2, 0),
    ('Silver Tern Health', 'NZ', 'NZD', 1, 2), ('Kiwi Origin Exports', 'CN', 'USD', 3, 1), ('Bayview Naturopathics', 'NZ', 'NZD', 1, 0),
    ('Moana Marine Bio', 'NZ', 'NZD', 2, 2), ('Taipei Wellness Trading', 'TW', 'USD', 2, 0), ('Golden Fern Beauty', 'NZ', 'NZD', 1, 1),
    ('Northcape Health Foods', 'NZ', 'NZD', 2, 2), ('Riverstone Clinic Supplies', 'AU', 'NZD', 1, 1), ('Hikari Life Co.', 'JP', 'USD', 2, 0),
    ('Pacific Pet Nutrition', 'NZ', 'NZD', 1, 2),
]
PRODUCT_POOL = [
    ('Vitamin C 1000mg', 'tablet', 60), ('Magnesium Sleep', 'hard', 90), ('Omega-3 1000mg', 'soft', 180), ('Joint Support Plus', 'hard', 120),
    ('Green-Lipped Mussel 500mg', 'hard', 120), ('Krill Oil 500mg', 'soft', 60), ('Turmeric & Ginger', 'tablet', 60), ('Liver Detox', 'hard', 60),
    ('Immune Defence', 'hard', 60), ('Ashwagandha Calm', 'hard', 60), ('Collagen Beauty Powder 300g', 'powder', 1), ('Probiotic 30 Billion', 'hard', 30),
    ('Red Ginseng Energy', 'tablet', 90), ('Lutein Eye Care', 'soft', 60), ('Kiwifruit Digest', 'hard', 60), ('Manuka Propolis', 'tablet', 60),
    ('Deer Velvet 250mg', 'hard', 60), ('Colostrum Immune', 'tablet', 120), ('CoQ10 150mg', 'soft', 60), ("Women's Multi", 'tablet', 60),
    ('Vitamin D3 1000IU', 'soft', 180), ('Cranberry 25,000mg', 'hard', 90), ('Pre-Workout Powder 300g', 'powder', 1), ('Night Calm', 'hard', 60),
    ('Electrolyte Sachets 30s', 'powder', 30), ('Hemp Seed Oil 1000mg', 'liquid hard', 90), ('Fish Oil Liquid 200ml', 'liquid', 1), ('Sea Buckthorn Oil', 'soft', 60),
    ('Bilberry Vision', 'hard', 60), ('Zinc + Vitamin C Lozenge', 'tablet', 60),
]


def ds(d):
    return d.isoformat()


def main():
    rows = []
    products = []  # (client, of, name, bulk_type, units, ob)
    of_no, ob_no, so_no = 4001, 6001, 20001
    for ci, (cname, market, cur, size, rep) in enumerate(CLIENTS):
        n_prod = max(1, min(6, size + R.randint(-1, 1)))
        for p in R.sample(PRODUCT_POOL, n_prod):
            brand = cname.split()[0] if not cname.startswith('Kiwi') else 'Kiwi Origin'
            products.append(dict(client=cname, of='OF%04d' % of_no, ob='OB%04d' % ob_no, name=('%s %s %s' % (
                brand, p[0], ('%d %s' % (p[2], {'hard': 'VCaps', 'soft': 'Softgels', 'tablet': 'Tablets', 'liquid hard': 'Liquid Caps'}[p[1]]) if p[1] not in ('powder', 'liquid') else ''))).strip(),
                bulk_type=p[1], units=p[2], price=round(R.uniform(3.2, 24.0), 2), cur=cur, size=size, rep=REPS[rep]))
            of_no += 1; ob_no += 1

    for p in products:
        start = dt.date(2024, 4, 1) + dt.timedelta(days=R.randint(0, 260))
        cycle = R.randint(55, 150) - p['size'] * 5
        d = start
        while d <= TODAY:
            reg = d
            conf = reg + dt.timedelta(days=R.randint(0, 6))
            lead = {'soft': 95, 'liquid hard': 95}.get(p['bulk_type'], 80) + R.randint(-15, 15)
            req = conf + dt.timedelta(days=lead)
            qty = R.choice([1000, 1500, 2000, 2500, 3000, 5000]) * (2 if p['size'] >= 4 else 1)
            status, finish, fres, bres = 'confirm', '', None, None
            per = p['units'] if p['bulk_type'] not in ('powder', 'liquid') else (300 if 'Powder' in p['name'] else 200 if 'Liquid' in p['name'] else p['units'] * 5)
            bulk_qty = qty * per * (1.0 if p['bulk_type'] not in ('powder', 'liquid') else 1)
            late = int(R.gauss(-4, 11))
            fdate = req + dt.timedelta(days=late)
            if (TODAY - reg).days < 6 and R.random() < 0.6:
                status, conf = 'new', None
            elif fdate <= TODAY - dt.timedelta(days=2):
                status, finish, fres, bres = 'finished', fdate, qty, bulk_qty
            else:
                # in production: some bulk done
                progress = max(0.0, min(1.0, 1 - (req - TODAY).days / lead))
                bres = round(bulk_qty * (progress if R.random() < 0.7 else 0))
            if R.random() < 0.025:
                status = 'cancel'
            rows.append({
                'sales_order_no': 'SO%05d' % so_no, 'status': status, 'register_date': ds(reg), 'confirm_date': ds(conf) if conf else '',
                'client_name': p['client'], 'register_name': p['rep'], 'product_code': p['of'], 'product_name': p['name'],
                'require_date': ds(req), 'need_ed': 'yes' if R.random() < 0.3 else 'no', 'quantity': qty, 'currency': p['cur'],
                'unit_price': round(p['price'] * R.uniform(0.97, 1.05), 2), 'item_value': 0, 'finish_order_qty': qty,
                'finish_result_qty': fres if fres is not None else '', 'packing_finish_date': ds(finish) if finish else '',
                'bulk_type': p['bulk_type'], 'bulk_code': p['ob'], 'bulk_name': p['name'] + ' bulk', 'bulk_order_qty': bulk_qty,
                'bulk_result_qty': bres if bres is not None else '',
            })
            rows[-1]['item_value'] = round(rows[-1]['quantity'] * rows[-1]['unit_price'], 2)
            so_no += 1
            d = d + dt.timedelta(days=max(30, int(R.gauss(cycle, cycle * 0.25))))
    rows.sort(key=lambda r: r['register_date'])

    build = OUT / '_build'
    build.mkdir(parents=True, exist_ok=True)
    (build / 'sales_rows.json').write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')

    # ── KV seed ───────────────────────────────────────────────
    kv = {}
    put = lambda k, v: kv.__setitem__(k, json.dumps(v, ensure_ascii=False))
    put('crm:managers', [MANAGER])
    am = {}
    for cname, _, _, size, rep in CLIENTS:
        am[cname] = {'primary': REPS[rep], 'backup': REPS[(rep + 1) % 3]}
    put('crm:account_managers', am)
    fx, m = {}, dt.date(2024, 1, 1)
    rate = 1.62
    while m <= TODAY:
        rate = round(min(1.80, max(1.55, rate + R.uniform(-0.03, 0.03))), 4)
        fx[m.strftime('%Y-%m')] = rate
        m = (m.replace(day=28) + dt.timedelta(days=5)).replace(day=1)
    put('crm:fx_rates', fx)

    deal_specs = [
        ('Kauri Wellness Ltd', 'Sleep range: 3 new capsule SKUs', 'Negotiating', 'Inbound', 68000),
        ('Tui Naturals Ltd', 'Omega-3 relaunch in amber PET', 'Quoted', 'Inbound', 42000),
        ('Southern Light Health', 'Private label joint range for AU pharmacy', 'Lead', 'Outbound', 120000),
        ('Seoul Glow Co., Ltd.', 'Collagen powder sachets for KR home shopping', 'Quoted', 'Inbound', 95000),
        ('Jeju Daily Health', 'Red ginseng tablet line extension', 'Contacted', 'Outbound', 30000),
        ('Lotus Bay Trading Ltd', 'Deer velvet 500mg export SKU', 'Negotiating', 'Inbound', 54000),
        ('Harbourside Supplements Pty', 'Probiotic 50B, cold-chain shipping', 'Lead', 'Inbound', 38000),
        ('Alpine Sport Nutrition', 'Electrolyte stick packs', 'Quoted', 'Outbound', 26000),
        ('Coastline Organics', 'Organic turmeric tablets', 'Contacted', 'Outbound', 18000),
        ('Moana Marine Bio', 'Green-lipped mussel oil softgel', 'Won', 'Inbound', 47000),
        ('Kiwi Origin Exports', 'Manuka propolis tablets for CN cross-border', 'Won', 'Inbound', 61000),
        ('Fernleaf Pharmacy Group', 'Pharmacy own-brand vitamin D', 'Drop', 'Outbound', 22000),
        ('Hikari Life Co.', 'Lutein softgel, JP spec', 'Lead', 'Inbound', 33000),
        ('Taipei Wellness Trading', 'Kiwifruit digest capsules', 'Quoted', 'Inbound', 29000),
        ('Bayview Naturopathics', 'Practitioner range trial batch', 'Contacted', 'Inbound', 9000),
        ('Northcape Health Foods', 'Women\'s multi reformulation', 'Negotiating', 'Outbound', 36000),
        ('Golden Fern Beauty', 'Beauty collagen capsules', 'Drop', 'Inbound', 15000),
        ('Pohutukawa Vitality', 'Night calm 120s bigger pack', 'Won', 'Inbound', 21000),
    ]
    acts_text = {
        'Contacted': ['Intro email sent with company profile', 'Call: asked about current supplier lead times'],
        'Lead': ['Discovery call: target launch Q2, 3 SKUs', 'Sent formulation brief template'],
        'Quoted': ['Quotation sent (2 options: bottle / blister)', 'Follow-up call on MOQ and lead time'],
        'Negotiating': ['Price discussion: asked for 5% on 10k units', 'Samples dispatched for stability check'],
        'Won': ['PO received', 'Artwork approved, order confirmed'],
        'Drop': ['Client chose an in-house option', 'Budget moved to next year'],
    }
    probs = {'Contacted': 10, 'Lead': 25, 'Quoted': 45, 'Negotiating': 70, 'Won': 100, 'Drop': 0}
    for i, (cust, title, stage, typ, val) in enumerate(deal_specs):
        start = TODAY - dt.timedelta(days=R.randint(15, 160))
        did = 'deal_demo_%02d' % i
        owner = am[cust]['primary']
        entered = start + dt.timedelta(days=R.randint(3, max(4, (TODAY - start).days - 1)))
        if stage not in ('Won', 'Drop'):
            entered = max(entered, TODAY - dt.timedelta(days=R.randint(4, 24)))
        deal = {'id': did, 'title': title, 'customer': cust, 'dealType': typ, 'stage': stage, 'owner': owner,
                'unitPrice': 0, 'qty': 0, 'estValue': val, 'probability': probs[stage], 'startDate': ds(start),
                'quoteSentDate': ds(min(entered, start + dt.timedelta(days=12)) if stage in ('Won', 'Drop') else entered) if stage in ('Quoted', 'Negotiating', 'Won', 'Drop') else '',
                'closeDate': ds(TODAY + dt.timedelta(days=R.randint(10, 90))) if stage not in ('Won', 'Drop') else ds(entered),
                'linkedQuot': '', 'market': '', 'notes': '', 'created': start.isoformat() + 'T09:00:00.000Z',
                'updated': entered.isoformat() + 'T10:00:00.000Z', 'stageEnteredAt': entered.isoformat() + 'T10:00:00.000Z'}
        if i == 2:  # one long-running deal, stall reason already recorded
            entered = TODAY - dt.timedelta(days=41)
            deal['stageEnteredAt'] = entered.isoformat() + 'T10:00:00.000Z'
            deal['dwellNote'] = 'Waiting on client approval'
        if stage == 'Won':
            deal['closeReason'] = 'Price and lead time accepted'
        if stage == 'Drop':
            deal['closeReason'] = acts_text['Drop'][i % 2]
        put('crm:deal:' + did, deal)
        for j, s in enumerate(acts_text[stage]):
            a_date = start + dt.timedelta(days=5 + j * 9)
            aid = 'act_demo_%02d_%d' % (i, j)
            put('crm:act:' + aid, {'id': aid, 'dealId': did, 'actType': ['Email', 'Call', 'Meeting'][j % 3], 'summary': s,
                                   'date': ds(a_date), 'owner': owner, 'ts': a_date.isoformat() + 'T11:00:00.000Z'})

    for i, (cust, topic) in enumerate([('Kauri Wellness Ltd', 'Quarterly business review'), ('Southern Light Health', 'AU pharmacy plan'),
                                       ('Seoul Glow Co., Ltd.', 'Video call: KR launch timeline'), ('Tui Naturals Ltd', 'Factory tour'),
                                       ('Lotus Bay Trading Ltd', 'Export document checklist'), ('Moana Marine Bio', 'New SKU kickoff')]):
        mid = 'mtg_demo_%02d' % i
        d = TODAY - dt.timedelta(days=7 + i * 11)
        put('crm:meeting:' + mid, {'id': mid, 'customer': cust, 'date': ds(d), 'topic': topic, 'link': '',
                                   'loggedBy': am[cust]['primary'], 'updated': d.isoformat() + 'T12:00:00.000Z'})

    # Production tab: one upload of the same mother data (what Planning uploads weekly)
    cols = ['sales_order_no', 'status', 'register_date', 'confirm_date', 'client_name', 'register_name', 'product_code', 'product_name',
            'require_date', 'need_ed', 'quantity', 'currency', 'unit_price', 'item_value', 'finish_order_qty', 'finish_result_qty',
            'packing_finish_date', 'bulk_type', 'bulk_code', 'bulk_name', 'bulk_order_qty', 'bulk_result_qty']
    snap_date = ds(TODAY - dt.timedelta(days=1))
    recent = [r for r in rows if r['register_date'] >= '2025-06-01']
    put('crm:prod_snap:' + snap_date, {'date': snap_date, 'file': 'Sales_statistics (demo).xlsx', 'cols': cols, 'rows': [[r[c] for c in cols] for r in recent]})
    put('crm:prod_index', {'snaps': [{'date': snap_date, 'file': 'Sales_statistics (demo).xlsx', 'rows': len(recent), 'by': 'Planning (demo)', 'at': snap_date + 'T09:00:00'}],
                           'weekly': {}, 'seen': None, 'current': snap_date})

    (OUT / 'seed_kv.js').write_text('/* Synthetic CRM data (KV). Generated by tools/gen_crm_seed.py. */\nwindow.WORKER_SEED_KV = '
                                    + json.dumps(kv, ensure_ascii=False) + ';\n', encoding='utf-8')

    # Planning's weekly record before the first upload (shape of production_seed.js)
    plog, w = [], dt.date(2025, 8, 4)
    base = {'1.Hard': [2.2e6, 3e4, 4.8e6, 1.6e5], '2.soft': [1.6e6, 9e3, 1.0e6, 6e4], '3.Powder, Sachet, Liq': [1.2e5, 1e4, 2.2e5, 2e4]}
    while w <= TODAY - dt.timedelta(days=60):
        for g, b in base.items():
            f = R.uniform(0.8, 1.2)
            plog.append([ds(w), g, round(b[0] * f, -2), round(b[1] * f, -1), round(b[2] * f, -2), round(b[3] * f, -1), None])
        for g, n in [('1.Hard', 6e5), ('2.soft', 4e5), ('3.Powder, Sachet, Liq', 8e3), ('5.packing', 1.2e4)]:
            plog.append([ds(w), g, None, None, None, None, round(n * R.uniform(0.3, 1.8), -2)])
        w += dt.timedelta(days=7)
    (OUT / 'production_seed.js').write_text("/* Synthetic weekly production record (demo). Rows: [weekStart, group, waitingForProduction, "
                                            "waitingForPacking, remainingOB, remainingOF, newOrders]. */\nwindow.PRODUCTION_SEED = "
                                            + json.dumps({'plog': plog}) + ';\n', encoding='utf-8')
    print('rows', len(rows), 'products', len(products), 'kv keys', len(kv), 'plog', len(plog))


if __name__ == '__main__':
    main()
