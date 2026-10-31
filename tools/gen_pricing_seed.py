"""Generate the synthetic dataset for the Pricing Tool demo.

Everything here is invented: ingredient prices, suppliers, clients, brands,
sales and factory costs. Nothing is derived from a real company's data.
Deterministic (fixed random seed), so the demo looks the same on every build.

    python tools/gen_pricing_seed.py   ->  pricing/seed.js
"""
import json, random, pathlib, datetime as dt

R = random.Random(20261029)
OUT = pathlib.Path(__file__).resolve().parent.parent / 'pricing' / 'seed.js'
TODAY = dt.date(2026, 10, 29)

FX_NZD = {'NZD': 1.0, 'USD': 0.598, 'AUD': 0.902, 'KRW': 826.0}   # 1 NZD = x


def d(y, m, day):
    return {'$d': dt.datetime(y, m, day, 10, 0).isoformat() + 'Z'}


def rand_date(start, end):
    span = (end - start).days
    x = start + dt.timedelta(days=R.randint(0, span))
    return d(x.year, x.month, x.day), x


SUPPLIERS = [
    ('Meridian Ingredients (demo)', 'USD', 'FOB', 'Sea'),
    ('Kestrel Biotech (demo)', 'USD', 'FCA', 'Air'),
    ('Evergreen Naturals (demo)', 'USD', 'CIF', 'Sea'),
    ('Silverleaf Trading NZ (demo)', 'NZD', 'Local', ''),
    ('Bluewave Marine Extracts (demo)', 'AUD', 'DAP', 'Sea'),
    ('Hanbat Bio Materials (demo)', 'KRW', 'FOB', 'Air'),
    ('Orchid Valley Botanicals (demo)', 'USD', 'EXW', 'Air'),
    ('Summit Nutrition Supply (demo)', 'NZD', 'Local', ''),
]

# name, base price in USD/kg (rough market-like magnitude, invented)
INGREDIENTS = [
    ('Vitamin C (Ascorbic Acid)', 7.5), ('Sodium Ascorbate', 9.0), ('Vitamin D3 100,000 IU/g', 140),
    ('Vitamin E (d-alpha Tocopheryl Acetate) 50%', 32), ('Vitamin B12 (Methylcobalamin) 1%', 210),
    ('Vitamin B6 (Pyridoxine HCl)', 38), ('Folic Acid 10%', 95), ('Biotin 1%', 120), ('Niacinamide', 14),
    ('Vitamin K2 (MK-7) 0.2%', 260), ('Beta-Carotene 10%', 85), ('Riboflavin', 60), ('Thiamine HCl', 48),
    ('Zinc Bisglycinate', 21), ('Zinc Gluconate', 11), ('Magnesium Glycinate', 12.6), ('Magnesium Citrate', 7.8),
    ('Magnesium Oxide Heavy', 3.1), ('Calcium Carbonate', 1.4), ('Calcium Citrate', 4.2), ('Iron Bisglycinate', 34),
    ('Selenium (L-Selenomethionine) 0.5%', 72), ('Chromium Picolinate', 55), ('Potassium Iodide 1%', 40),
    ('Fish Oil 18/12 Concentrate', 9.5), ('Fish Oil 50% EPA/DHA', 28), ('Krill Oil', 95), ('Flaxseed Oil', 6.2),
    ('Evening Primrose Oil', 18), ('Marine Collagen Peptide', 21), ('Bovine Collagen Peptide', 12),
    ('Hydrolysed Whey Protein', 16), ('Royal Jelly Powder 6% 10-HDA', 160), ('Propolis Extract 20%', 120),
    ('Manuka Honey Powder', 58), ('Green-Lipped Mussel Powder', 48), ('Deer Velvet Powder', 380),
    ('Colostrum Powder 30% IgG', 70), ('Lactoferrin 95%', 520), ('Glucosamine Sulfate 2KCl', 9.5),
    ('Chondroitin Sulfate 90%', 45), ('MSM (Methylsulfonylmethane)', 6.5), ('Hyaluronic Acid (Food Grade)', 280),
    ('Coenzyme Q10', 210), ('Alpha Lipoic Acid', 65), ('N-Acetyl L-Cysteine', 32), ('L-Theanine', 85),
    ('Melatonin', 300), ('5-HTP 98%', 230), ('Taurine', 5.5), ('L-Carnitine Tartrate', 26), ('Creatine Monohydrate', 6.0),
    ('Turmeric Extract 95% Curcuminoids', 48), ('Ginger Root Extract 5% Gingerols', 55), ('Ashwagandha Root Extract 5%', 42),
    ('Milk Thistle Extract 80% Silymarin', 36), ('Grape Seed Extract 95% OPC', 52), ('Green Tea Extract 50% EGCG', 38),
    ('Bilberry Extract 25% Anthocyanidins', 190), ('Elderberry Extract 10:1', 44), ('Echinacea Extract 4% Phenolics', 46),
    ('Ginkgo Biloba Extract 24/6', 95), ('Korean Red Ginseng Extract 8% Ginsenosides', 170), ('Rhodiola Extract 3% Rosavins', 120),
    ('Saw Palmetto Extract 45%', 75), ('Cranberry Extract 25% PAC', 210), ('Olive Leaf Extract 20% Oleuropein', 58),
    ('Lutein 20%', 160), ('Astaxanthin 5%', 1300), ('Quercetin Dihydrate', 40), ('Resveratrol 98%', 220),
    ('Berberine HCl 97%', 60), ('Spirulina Powder', 9.0), ('Chlorella Powder', 14), ('Beetroot Powder', 6.8),
    ('Kiwifruit Powder', 32), ('Blackcurrant Powder', 44), ('Kale Powder', 12),
    ('Lactobacillus rhamnosus 100B CFU/g', 900), ('Bifidobacterium lactis 100B CFU/g', 820), ('Inulin (Chicory)', 5.2),
    ('Microcrystalline Cellulose', 2.8), ('Magnesium Stearate', 4.6), ('Silicon Dioxide', 5.5), ('Rice Flour', 2.2),
    ('Maltodextrin', 1.5), ('Dicalcium Phosphate', 1.9), ('Croscarmellose Sodium', 7.0), ('Natural Berry Flavour', 26),
    ('Stevia Extract 97% RebA', 60), ('Citric Acid Anhydrous', 1.6), ('Sunflower Lecithin', 4.1), ('Glycerin', 1.8),
    ('Beeswax', 11), ('Soybean Oil', 2.1),
]

PACKAGING = [
    # name, packaging_type, NZD/ea
    ('HDPE Bottle 150cc White', 'Bottle', 0.21), ('HDPE Bottle 250cc White', 'Bottle', 0.27),
    ('PET Bottle 200cc Amber', 'Bottle', 0.31), ('Glass Jar 120ml Amber', 'Bottle', 0.78),
    ('PP Cap 38mm CRC White', 'Lid', 0.075), ('PP Cap 45mm Flip-top', 'Lid', 0.095), ('Aluminium Cap 53mm', 'Lid', 0.22),
    ('Induction Seal Liner 38mm', 'Seal', 0.018), ('Desiccant Canister 1g', 'Desiccant', 0.035), ('Cotton Coil 1.5g', 'Filler', 0.012),
    ('Front Label 60x150 Gloss', 'Label', 0.065), ('Wrap Label 90x200 Matte', 'Label', 0.09), ('Shrink Sleeve PVC', 'Sleeve', 0.045),
    ('Unit Carton 1-up 300gsm', 'Carton', 0.24), ('Unit Carton Blister 3x10', 'Carton', 0.19), ('Leaflet A6', 'Leaflet', 0.03),
    ('Shipper Box 48-up', 'Shipper Box', 1.65), ('Shipper Box 96-up', 'Shipper Box', 2.10),
    ('Blister Foil Alu 20mic', 'Blister', 0.022), ('PVC/PVDC Film 250mic', 'Blister', 0.028),
    ('Sachet Film PET/AL/PE', 'Sachet', 0.04), ('Stick Pack Film 20mm', 'Pouch', 0.035), ('Stand-up Pouch 250g Zip', 'Pouch', 0.42),
    ('Powder Scoop 5ml', 'Scoop', 0.025), ('Gelatin Softgel Shell (bovine)', 'Shell (F)', 0.0062),
    ('Gelatin Softgel Shell (fish)', 'Shell (F)', 0.0081), ('Plant Softgel Shell (carrageenan)', 'Shell (F)', 0.0105),
]

CLIENTS = [
    # company, brand, market
    ('Kauri Wellness Ltd', 'Kauri Wellness', 'NZ'), ('Tui Naturals Ltd', 'Tui Naturals', 'NZ'),
    ('Southern Light Health', 'Southern Light', 'NZ/AU'), ('Pohutukawa Vitality', 'Pohu Vita', 'NZ'),
    ('Aroha Botanics Ltd', 'Aroha', 'NZ'), ('Harbourside Supplements', 'Harbourside', 'AU'),
    ('Seoul Glow Co.', 'Seoul Glow', 'KR'), ('Jeju Daily Health', 'Jeju Daily', 'KR'),
    ('Lotus Bay Trading', 'Lotus Bay', 'CN/HK'), ('Demo Labs (in-house)', 'Demo Labs', 'NZ'),
]

FORMS = {
    # itemType, line type in finish_BOM, units per pack choices, bulk lines template
    'hard':   ('hard', [60, 90, 120]),
    'soft':   ('soft', [60, 90, 180]),
    'tablet': ('tablet', [60, 90, 120]),
    'powder': ('powder', [1]),
}

PRODUCTS = [
    # (brand idx, product, form, [(ingredient name, mg)])
    (0, 'Vitamin C 1000mg + Zinc', 'tablet', [('Vitamin C (Ascorbic Acid)', 1000), ('Zinc Gluconate', 70), ('Microcrystalline Cellulose', 180), ('Magnesium Stearate', 10)]),
    (0, 'Magnesium Sleep Formula', 'hard', [('Magnesium Glycinate', 400), ('L-Theanine', 100), ('Rice Flour', 40), ('Magnesium Stearate', 5)]),
    (1, 'Omega-3 1000mg', 'soft', [('Fish Oil 18/12 Concentrate', 1000), ('Vitamin E (d-alpha Tocopheryl Acetate) 50%', 4)]),
    (1, 'Joint Support Plus', 'hard', [('Glucosamine Sulfate 2KCl', 500), ('Chondroitin Sulfate 90%', 200), ('MSM (Methylsulfonylmethane)', 100), ('Silicon Dioxide', 5)]),
    (2, 'Green-Lipped Mussel 500mg', 'hard', [('Green-Lipped Mussel Powder', 500), ('Rice Flour', 30)]),
    (2, 'Krill Oil 500mg', 'soft', [('Krill Oil', 500)]),
    (3, 'Turmeric & Ginger', 'tablet', [('Turmeric Extract 95% Curcuminoids', 400), ('Ginger Root Extract 5% Gingerols', 100), ('Dicalcium Phosphate', 150), ('Croscarmellose Sodium', 15), ('Magnesium Stearate', 8)]),
    (3, 'Liver Detox', 'hard', [('Milk Thistle Extract 80% Silymarin', 250), ('N-Acetyl L-Cysteine', 200), ('Alpha Lipoic Acid', 50), ('Microcrystalline Cellulose', 40)]),
    (4, 'Immune Defence', 'hard', [('Elderberry Extract 10:1', 300), ('Echinacea Extract 4% Phenolics', 150), ('Vitamin C (Ascorbic Acid)', 100), ('Zinc Bisglycinate', 50)]),
    (4, 'Ashwagandha Calm', 'hard', [('Ashwagandha Root Extract 5%', 500), ('Rice Flour', 20)]),
    (5, 'Collagen Beauty Powder', 'powder', [('Marine Collagen Peptide', 5000), ('Hyaluronic Acid (Food Grade)', 60), ('Vitamin C (Ascorbic Acid)', 80), ('Natural Berry Flavour', 300), ('Stevia Extract 97% RebA', 20)]),
    (5, 'Probiotic 30 Billion', 'hard', [('Lactobacillus rhamnosus 100B CFU/g', 150), ('Bifidobacterium lactis 100B CFU/g', 150), ('Inulin (Chicory)', 100), ('Microcrystalline Cellulose', 50)]),
    (6, 'Red Ginseng Energy', 'tablet', [('Korean Red Ginseng Extract 8% Ginsenosides', 300), ('Vitamin B12 (Methylcobalamin) 1%', 10), ('Microcrystalline Cellulose', 200), ('Magnesium Stearate', 6)]),
    (6, 'Lutein Eye Care', 'soft', [('Lutein 20%', 100), ('Bilberry Extract 25% Anthocyanidins', 40), ('Soybean Oil', 350), ('Beeswax', 15)]),
    (7, 'Kiwifruit Digest', 'hard', [('Kiwifruit Powder', 450), ('Inulin (Chicory)', 50)]),
    (7, 'Manuka Propolis', 'tablet', [('Propolis Extract 20%', 100), ('Manuka Honey Powder', 300), ('Dicalcium Phosphate', 150), ('Magnesium Stearate', 6)]),
    (8, 'Deer Velvet 250mg', 'hard', [('Deer Velvet Powder', 250), ('Rice Flour', 60)]),
    (8, 'Colostrum Immune', 'tablet', [('Colostrum Powder 30% IgG', 500), ('Lactoferrin 95%', 20), ('Maltodextrin', 150), ('Magnesium Stearate', 6)]),
    (9, 'CoQ10 150mg', 'soft', [('Coenzyme Q10', 150), ('Soybean Oil', 300), ('Sunflower Lecithin', 20)]),
    (9, 'Women\'s Multi', 'tablet', [('Calcium Carbonate', 300), ('Magnesium Oxide Heavy', 150), ('Iron Bisglycinate', 60), ('Vitamin D3 100,000 IU/g', 10), ('Folic Acid 10%', 4), ('Biotin 1%', 3), ('Microcrystalline Cellulose', 120), ('Magnesium Stearate', 8)]),
    (0, 'Vitamin D3 1000IU', 'soft', [('Vitamin D3 100,000 IU/g', 10), ('Soybean Oil', 280)]),
    (1, 'Cranberry 25,000mg', 'hard', [('Cranberry Extract 25% PAC', 250), ('Vitamin C (Ascorbic Acid)', 30)]),
    (2, 'Beetroot Pre-Workout Powder', 'powder', [('Beetroot Powder', 4000), ('Creatine Monohydrate', 3000), ('Taurine', 1000), ('Citric Acid Anhydrous', 200), ('Natural Berry Flavour', 400)]),
    (4, 'Night Calm Melatonin-free', 'hard', [('5-HTP 98%', 50), ('L-Theanine', 200), ('Magnesium Citrate', 150)]),
]


def main():
    sheets = {}

    # ── raw_cost ─────────────────────────────────────────────
    raw_head = ['code', 'name', 'currency', 'unit_price', 'final_price', 'custom', 'oversea_freight',
                'shipping_method', 'incoterms', 'status', 'register_date', 'supplier_name', 'is_default', 'sales_price']
    raw_rows, raw_by_name = [], {}
    for i, (name, usd) in enumerate(INGREDIENTS):
        code = 'OR%04d' % (101 + i)
        sup = R.choice(SUPPLIERS)
        cur = sup[1]
        price_nzd_base = usd / FX_NZD['USD']
        n_rows = R.choice([1, 1, 2, 2, 3])
        stale = R.random() < 0.12
        for k in range(n_rows):
            if stale:
                ddate, _ = rand_date(dt.date(2023, 6, 1), dt.date(2025, 3, 1))
            else:
                ddate, _ = rand_date(dt.date(2025, 5, 15) + dt.timedelta(days=180 * k), dt.date(2025, 10, 1) + dt.timedelta(days=180 * k))
            drift = 1 + (k * R.uniform(-0.04, 0.12))
            unit = round(price_nzd_base * FX_NZD[cur] * drift * R.uniform(0.9, 1.1), 2 if cur != 'KRW' else 0)
            custom = 0 if cur == 'NZD' else round(R.choice([0, 0, 0.3, 0.5]), 2)
            freight = 0 if sup[2] in ('CIF', 'DAP', 'Local') else round(R.uniform(0.2, 1.2), 2)
            final_nzd = round(unit / FX_NZD[cur] * 1.06 + (custom + freight) / FX_NZD['USD'], 2)
            raw_rows.append([code, name, cur, unit, final_nzd, custom, freight, sup[3], sup[2],
                             'approve' if R.random() > 0.04 else 'pending', ddate, sup[0], 1, round(final_nzd * 1.25, 2)])
        raw_by_name[name] = code
    sheets['raw_cost'] = [raw_head] + raw_rows

    # ── packaging_cost ───────────────────────────────────────
    pkg_head = ['code', 'name', 'packaging_type', 'currency', 'unit_price', 'final_price', 'status', 'register_date', 'supplier_name', 'is_default', 'sales_price']
    pkg_rows, pkg_by_name = [], {}
    for i, (name, ptype, nzd) in enumerate(PACKAGING):
        code = 'OP%04d' % (201 + i)
        ddate, _ = rand_date(dt.date(2025, 1, 1), dt.date(2026, 9, 30))
        cur = 'NZD' if R.random() < 0.6 else 'USD'
        unit = round(nzd * FX_NZD[cur] * R.uniform(0.92, 1.08), 4)
        pkg_rows.append([code, name, ptype, cur, unit, round(unit / FX_NZD[cur], 4), 'approve', ddate, R.choice(SUPPLIERS)[0], 1, round(unit / FX_NZD[cur] * 1.2, 4)])
        pkg_by_name[name] = code
    # the HPMC capsule shell (the tool counts it per capsule, code listed in PKG_CAP_QTY_CODES)
    pkg_rows.append(['OP0104', 'HPMC Capsule Size 0 Clear', 'Capsule', 'USD', 0.0058, 0.0097, 'approve', d(2026, 3, 12), 'Kestrel Biotech (demo)', 1, 0.0117])
    pkg_by_name['HPMC Capsule Size 0 Clear'] = 'OP0104'

    # ── BOMs ─────────────────────────────────────────────────
    bom_head = ['BOM Code', 'Item Description', 'Item Type', 'Line Type', 'Object CodeItem', 'Object Description', 'Quantity', 'Unit']
    finish, bulk = [bom_head], [bom_head]
    products = []
    for pi, (bi, pname, form, ings) in enumerate(PRODUCTS):
        company, brand, market = CLIENTS[bi]
        ob = 'OB%04d' % (2101 + pi)
        of = 'OF%04d' % (3101 + pi)
        item_type, packs = FORMS[form]
        n = R.choice(packs)
        unit_word = {'hard': 'VCaps', 'soft': 'Softgels', 'tablet': 'Tablets', 'powder': ''}[form]
        full = '%s %s %s' % (brand, pname, ('%d %s' % (n, unit_word)) if unit_word else '300g')
        bulk_name = '%s %s bulk' % (brand, pname)
        for ing, mg in ings:
            bulk.append([ob, bulk_name, item_type, 'ingredient', raw_by_name[ing], ing, mg, 'mg'])
        if form == 'soft':
            shell = R.choice(['Gelatin Softgel Shell (bovine)', 'Gelatin Softgel Shell (fish)', 'Plant Softgel Shell (carrageenan)'])
            bulk.append([ob, bulk_name, item_type, 'shell', pkg_by_name[shell], shell, round(sum(m for _, m in ings) * 0.45), 'mg'])
        if form == 'hard':
            bulk.append([ob, bulk_name, item_type, 'packaging', 'OP0104', 'HPMC Capsule Size 0 Clear', 1, 'ea'])
        finish.append([of, full, item_type, item_type, ob, bulk_name, n if form != 'powder' else 300, 'ea' if form != 'powder' else 'g'])
        if form == 'powder':
            pk = ['Stand-up Pouch 250g Zip', 'Powder Scoop 5ml', 'Front Label 60x150 Gloss', 'Shipper Box 48-up']
        else:
            pk = [R.choice(['HDPE Bottle 150cc White', 'HDPE Bottle 250cc White', 'PET Bottle 200cc Amber']),
                  R.choice(['PP Cap 38mm CRC White', 'PP Cap 45mm Flip-top']), 'Induction Seal Liner 38mm',
                  R.choice(['Front Label 60x150 Gloss', 'Wrap Label 90x200 Matte']), 'Desiccant Canister 1g',
                  R.choice(['Shipper Box 48-up', 'Shipper Box 96-up'])]
            if R.random() < 0.5:
                pk.append('Unit Carton 1-up 300gsm')
        for p in pk:
            finish.append([of, full, item_type, 'packaging', pkg_by_name[p], p, 1, 'ea'])
        products.append(dict(of=of, ob=ob, name=full, company=company, brand=brand, market=market, form=form, n=n, ings=ings))
    sheets['finish_BOM'], sheets['bulk_BOM'] = finish, bulk

    # ── rough factory cost per pack (used for GM + previous prices) ─────
    raw_price = {r[0]: r[4] for r in raw_rows}
    for p in products:
        caps = p['n'] if p['form'] != 'powder' else 1
        mat = sum(raw_price[raw_by_name[i]] * mg * (60 if p['form'] == 'powder' else 1) for i, mg in p['ings']) * caps / 1e6 * 1.08
        p['cost'] = round(mat + R.uniform(1.6, 3.2) + caps * 0.012, 2)
        p['price'] = round(p['cost'] / (1 - R.uniform(0.16, 0.34)), 2)

    # ── Supply_Price (previous selling prices) ─────────────────
    sp = [['product_code', 'register_date', 'unit_price', 'product_name', 'status']]
    for p in products:
        price = p['price'] * R.uniform(0.9, 0.97)
        for k in range(R.randint(1, 3)):
            ddate, _ = rand_date(dt.date(2024, 10, 1) + dt.timedelta(days=230 * k), dt.date(2025, 3, 1) + dt.timedelta(days=230 * k))
            sp.append([p['of'], ddate, round(price, 2), p['name'], R.choice(['confirm', 'confirm', 'finished', 'new'])])
            price *= R.uniform(1.0, 1.06)

    # ── GM_CostMaster / GM_Sales ──────────────────────────────
    cm = [['of_code', 'ob_code', 'product_name', 'client_name', 'unit_cost']]
    for p in products:
        cm.append([p['of'], p['ob'], p['name'], p['company'], p['cost']])
    gs = [['sales_order_no', 'register_date', 'status', 'client_name', 'product_code', 'product_name', 'bulk_code', 'quantity', 'unit_price', 'item_value']]
    so = 1001
    for p in products:
        for _ in range(R.randint(2, 7)):
            ddate, _ = rand_date(dt.date(2025, 1, 10), dt.date(2026, 10, 20))
            qty = R.choice([1000, 1500, 2000, 3000, 5000, 8000])
            up = round(p['price'] * R.uniform(0.95, 1.05), 2)
            gs.append(['SO%05d' % so, ddate, 'cancel' if R.random() < 0.05 else R.choice(['confirm', 'finished', 'finished']),
                       p['company'], p['of'], p['name'], p['ob'], qty, up, round(qty * up, 2)])
            so += 1

    # ── Pricing_Classification ────────────────────────────────
    pc = [['of_code', 'company', 'brand', 'market', 'in_house']]
    for p in products:
        pc.append([p['of'], p['company'], p['brand'], p['market'], 'Y' if p['brand'] == 'Demo Labs' else ''])

    # ── Procurement snapshot ──────────────────────────────────
    pl_keys = ['progress', 'requestType', 'date', 'requestedBy', 'code', 'name', 'materialType', 'askFor', 'qtyRequired',
               'category', 'brand', 'obCode', 'targetMarket', 'requesterRemark', 'updatedBy', 'result', 'procRemark']
    pl = [pl_keys]
    reqs = [
        ('Done', 'New material', 'ORXXXX', 'Shilajit Extract 50% Fulvic', 'Raw', 'Price + MOQ', '20kg', 'Sports', 'Harbourside', 'Quoted USD 145/kg FOB, MOQ 25kg'),
        ('Done', 'Price check', 'OR0161', 'Ashwagandha Root Extract 5%', 'Raw', 'Updated price', '100kg', 'Stress', 'Aroha', '$39.50/kg FCA, valid to Mar-27'),
        ('In progress', 'New material', 'ORXXXX', 'Sea Buckthorn Oil', 'Raw', 'Price + COA', '30kg', 'Beauty', 'Seoul Glow', ''),
        ('Done', 'New packaging', 'OPXXXX', 'PET Bottle 300cc Amber', 'Packaging', 'Price per 10k', '20,000 ea', 'Bottle', 'Tui Naturals', 'NZD 0.36/ea, MOQ 10k'),
        ('Waiting supplier', 'New material', 'ORXXXX', 'Tart Cherry Extract 10:1', 'Raw', 'Price + lead time', '50kg', 'Sleep', 'Kauri Wellness', ''),
        ('Done', 'Alternative supplier', 'OR0128', 'Fish Oil 50% EPA/DHA', 'Raw', 'Second source', '500kg', 'Omega', 'Southern Light', 'USD 26.80/kg CIF Auckland'),
        ('Done', 'New material', 'ORXXXX', 'Saffron Extract 2% Safranal', 'Raw', 'Price', '5kg', 'Mood', 'Pohu Vita', 'USD 1,850/kg EXW'),
    ]
    for i, r in enumerate(reqs):
        dd, _ = rand_date(dt.date(2026, 5, 1), dt.date(2026, 10, 20))
        pl.append([r[0], r[1], dd, R.choice(['Sales A', 'Sales B', 'Sales C']), r[2], r[3], r[4], r[5], r[6], r[7], r[8],
                   '', 'NZ', '', 'Procurement', r[9], ''])
    pu_keys = ['date', 'category', 'code', 'description', 'supplier', 'currentPrice', 'currentCurr', 'currentTerm',
               'previousPrice', 'previousCurr', 'previousTerm', 'validPeriod', 'currentNzdKg', 'previousNzdKg', 'variance', 'reason', 'remark', 'updatedBy']
    pu = [pu_keys]
    for code_name in ['Magnesium Glycinate', 'Vitamin C (Ascorbic Acid)', 'Marine Collagen Peptide', 'Coenzyme Q10']:
        row = next(r for r in raw_rows if r[1] == code_name)
        prev = row[3]; cur = round(prev * R.uniform(1.03, 1.12), 2)
        dd, _ = rand_date(dt.date(2026, 6, 1), dt.date(2026, 10, 15))
        pu.append([dd, 'Raw', row[0], code_name, row[11], cur, row[2], row[8], prev, row[2], row[8], d(2027, 3, 31),
                   round(cur / FX_NZD[row[2]], 2), round(prev / FX_NZD[row[2]], 2), '%+.1f%%' % ((cur / prev - 1) * 100), 'Supplier price increase', '', 'Procurement'])

    # R&D Toolkit: product master (OB) and its BOM, from the same bulk products
    BENEFIT = {'Vitamin C': '면역, 항산화', 'Magnesium': '수면, 근육 이완', 'Omega': '혈행, 심혈관', 'Joint': '관절, 연골', 'Mussel': '관절',
               'Krill': '혈행, 심혈관', 'Turmeric': '항염, 관절', 'Liver': '간 건강', 'Immune': '면역', 'Ashwagandha': '스트레스, 수면',
               'Collagen': '피부, 미용', 'Probiotic': '장 건강', 'Ginseng': '피로 회복, 활력', 'Lutein': '눈 건강', 'Kiwifruit': '장 건강, 소화',
               'Propolis': '면역, 구강', 'Velvet': '활력, 면역', 'Colostrum': '면역', 'CoQ10': '항산화, 심혈관', 'Multi': '종합 영양',
               'D3': '뼈 건강, 면역', 'Cranberry': '요로 건강', 'Beetroot': '운동 수행', 'Night': '수면'}
    ob = [['status', 'type', 'code', 'name', 'gross_weight', 'color', 'register_date', 'target_benefit']]
    obb = [['BOM Code', 'Object CodeItem', 'Object Description', 'Quantity', 'Unit']]
    for p in products:
        mg = sum(m for _, m in p['ings'])
        ben = next((v for k, v in BENEFIT.items() if k.lower() in p['name'].lower()), '일반 건강')
        dd, _ = rand_date(dt.date(2024, 3, 1), dt.date(2026, 9, 30))
        ob.append([R.choice(['approve', 'approve', 'approve', 'develop']), p['form'], p['ob'], p['name'].rsplit(' ', 2)[0] + ' bulk',
                   round(mg * 1.1) if p['form'] != 'powder' else round(mg), R.choice(['White', 'Clear', 'Amber', 'Light brown', 'Yellow']), dd, ben])
        for ing, m in p['ings']:
            obb.append([p['ob'], raw_by_name[ing], ing, m, 'mg'])

    main_ss = {'name': 'Pricing Demo Data', 'sheets': []}
    def add(ss, name, rows):
        ss['sheets'].append({'name': name, 'id': len(ss['sheets']) + 1, 'rows': rows, 'frozen': 1})
    add(main_ss, 'raw_cost', sheets['raw_cost'])
    add(main_ss, 'Supply_Price', sp)
    add(main_ss, 'GM_CostMaster', cm)
    add(main_ss, 'GM_Sales', gs)
    add(main_ss, 'Pricing_Classification', pc)
    add(main_ss, 'Procurement_List', pl)
    add(main_ss, 'Procurement_PriceUpdate', pu)
    add(main_ss, 'OB', ob)
    add(main_ss, 'OB_BOM', obb)
    # saved quotes: made by driving the real UI over this data (tools/make_seed_quotes.js), then stored here
    qf = OUT.parent.parent / 'tools' / 'seed_quotes.json'
    if qf.exists():
        for sh in json.loads(qf.read_text(encoding='utf-8')):
            add(main_ss, sh['name'], sh['rows'])
    pkg_ss = {'name': 'packaging_cost (demo)', 'sheets': []}
    add(pkg_ss, 'packaging_cost', [pkg_head] + pkg_rows)
    bom_ss = {'name': 'BOM (demo)', 'sheets': []}
    add(bom_ss, 'finish_BOM', finish)
    add(bom_ss, 'bulk_BOM', bulk)
    add(bom_ss, 'indv_BOM', [bom_head])

    props = {
        'SPREADSHEET_ID': 'demo_main', 'RAW_COST_SPREADSHEET_ID': 'demo_main', 'PKG_COST_SPREADSHEET_ID': 'demo_pkg',
        'BOM_SPREADSHEET_ID': 'demo_bom', 'SUPPLY_PRICE_SPREADSHEET_ID': 'demo_main', 'RD_TOOLKIT_URL': '#',
        'GEMINI_API_KEY': 'demo-key-not-real', 'ALLOWED_USERS': 'demo.user@example.com',
        'GM_COST_UPDATED': '2026-10-20 09:12', 'GM_SALES_UPDATED': '2026-10-27 16:40', 'RAW_COST_UPDATED': '2026-10-21 11:05',
        'PROCUREMENT_META': json.dumps({'updatedAt': '2026-10-24 14:30', 'fileName': 'Procurement - Sourcing & Updates (demo).xlsx',
                                        'listCount': len(pl) - 1, 'puCount': len(pu) - 1,
                                        'fxStandard': [{'currency': 'USD', 'rate': 0.6, 'date': '2026-10-01'},
                                                       {'currency': 'AUD', 'rate': 0.9, 'date': '2026-10-01'}]}),
    }
    seed = {'spreadsheets': {'demo_main': main_ss, 'demo_pkg': pkg_ss, 'demo_bom': bom_ss}, 'properties': props}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text('/* Synthetic demo data. Generated by tools/gen_pricing_seed.py. No real company data. */\n'
                   'window.GAS_SEED = ' + json.dumps(seed, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print('wrote', OUT, OUT.stat().st_size, 'bytes;', len(raw_rows), 'raw rows,', len(products), 'products,', len(gs) - 1, 'sales lines')


if __name__ == '__main__':
    main()
