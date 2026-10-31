"""Build the Pricing Tool demo from the real Apps Script source.

    python tools/build_pricing.py <path-to>/raw_data_analytics/sales_toolkit

What it does
  1. Copies Code.js and the page templates (Pricing.html, GM.html, ...).
  2. Removes confidential content: names, emails and IDs from
     tools/scrub_rules.local.json (local only, never committed), and
     replaces business constants (processing price tiers, labour model,
     freight/customs defaults) with altered demo values.
  3. Fills the HtmlService template tags (<?= appVersion ?> ...) the way doGet would.
  4. Adds the GAS emulator, synthetic seed and API mocks in front of the page scripts.
  5. Fails if any denied term is still present in the output.
"""
import json, pathlib, random, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'pricing'
RULES = json.loads((ROOT / 'tools' / 'scrub_rules.local.json').read_text(encoding='utf-8'))

PAGES = {  # template file -> (output file, ?page= value, title)
    'Pricing.html': ('index.html', 'pricing', 'Pricing Tool'),
    'Library.html': ('library.html', 'library', 'Pricing Library'),
    'GM.html': ('gm.html', 'gm', 'GM Analysis'),
    'Procurement.html': ('procurement.html', 'procurement', 'Procurement'),
    'Sourcing.html': ('sourcing.html', 'sourcing', 'Ingredient check'),
    'Upload.html': ('upload.html', 'upload', 'Data upload'),
    'Classify.html': ('classify.html', 'classify', 'Classification'),
    'Guide.html': ('guide.html', 'guide', 'User Guide'),
    'Changelog.html': ('changelog.html', 'changelog', 'Changelog'),
}
URL_VARS = {'pricingUrl': 'index.html', 'libraryUrl': 'library.html', 'gmUrl': 'gm.html', 'procurementUrl': 'procurement.html',
            'sourcingUrl': 'sourcing.html', 'uploadUrl': 'upload.html', 'classifyUrl': 'classify.html', 'guideUrl': 'guide.html',
            'changelogUrl': 'changelog.html', 'searchUrl': '../#rd-toolkit', 'recommendUrl': '../#rd-toolkit'}

# Business constants to alter: (file, start marker, end marker, mode)
PERTURB = [
    ('Code.js', 'var PRICING_SETTINGS_DEFAULTS = {', '};', 'all'),
    ('Code.js', 'var DEFAULT_ENCAP_LABOR = {', '\n};', 'all'),
    ('Code.js', 'var DEFAULT_TEST_COST_RULES = [', '];', 'all'),
    ('Pricing.html', 'var TEST_COST_RULES = [', '];', 'all'),
    ('Pricing.html', 'var SETTINGS_META = [', '];', 'all'),
    ('Pricing.html', 'var ENCAP_LABOR_DEFAULT = {', '};', 'all'),
    ('Pricing.html', 'var DEFAULT_PROC_TIERS = {', '};', 'tier'),
    ('Pricing.html', 'var PACKAGING_PROC = {', '};', 'all'),
]
LITERALS = [  # scattered fallbacks of the same constants
    ('Pricing.html', '|| 6.5;', '|| 5.9;'), ('Pricing.html', '|| 2.3968;', '|| 2.15;'),
    ('Pricing.html', 'batches <= 3 ? 350 : 300', 'batches <= 3 ? 320 : 280'),
]

rnd = random.Random(7)


def scale(m):
    s = m.group(0)
    v = float(s)
    if v in (0, 1):
        return s
    f = rnd.uniform(0.82, 1.18)
    dec = len(s.split('.')[1]) if '.' in s else 0
    nv = v * f
    if dec == 0:
        mag = 10 ** max(0, len(str(int(v))) - 2)
        return str(int(round(nv / mag) * mag))
    return ('%.' + str(dec) + 'f') % nv


NUM = re.compile(r'(?<![\w.])\d+(?:\.\d+)?(?![\w])')


def perturb(text, start, end, mode, fname):
    i = text.find(start)
    if i < 0:
        sys.exit('perturb marker not found in %s: %s' % (fname, start))
    j = text.find(end, i + len(start))
    block = text[i + len(start):j]
    if mode == 'tier':
        block = re.sub(r'\[(\d+|null),\s*(\d+(?:\.\d+)?)\]', lambda m: '[%s,%s]' % (m.group(1), NUM.sub(scale, m.group(2))), block)
    else:
        # leave identifiers like 'sgc_3oval' alone: only numbers after ':' , '[' , ',' or '='
        block = re.sub(r'([:\[,=]\s*)(\d+(?:\.\d+)?)', lambda m: m.group(1) + NUM.sub(scale, m.group(2)), block)
    return text[:i + len(start)] + block + text[j:]


def scrub(text):
    for pat, rep, flags in RULES.get('crm_replace', []) + RULES['replace']:
        text = re.sub(pat, rep, text, flags=re.I if 'i' in flags else 0)
    return text


def fill_template(html, version):
    vals = dict(URL_VARS, appVersion=version, userEmail='demo.user@example.com', userInitials='DU', loadId='')
    def sub(m):
        key = m.group(1).strip()
        if key not in vals:
            sys.exit('unknown template var: ' + key)
        return vals[key]
    html = re.sub(r'<\?=\s*([A-Za-z_]+)\s*\?>', sub, html)
    if '<?' in html:
        sys.exit('unhandled scriptlet left in a template')
    return html


HEAD_INJECT = '''<!-- demo runtime: GAS emulator + synthetic data (see README) -->
<script>window.DEMO_TODAY = '2026-10-29';</script>
<script src="../shared/demo-clock.js"></script>
<script>window.GAS_DEMO_KEY = 'pricing-demo'; try { sessionStorage.setItem('pricingAuth', '1'); } catch (e) {} /* demo: skip the old password gate */</script>
<script src="../shared/gas-emulator.js"></script>
<script src="seed.js"></script>
<script src="mocks.js"></script>
<script src="code.js"></script>
<link rel="stylesheet" href="../shared/demo-badge.css">
'''
BODY_INJECT = '<script src="../shared/demo-badge.js"></script>\n'


def main():
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '')
    if not (src / 'Code.js').exists():
        sys.exit('usage: build_pricing.py <sales_toolkit folder>')
    files = {p.name: p.read_text(encoding='utf-8-sig') for p in [src / 'Code.js'] + [src / n for n in PAGES]}

    for fname, a, b, mode in PERTURB:
        files[fname] = perturb(files[fname], a, b, mode, fname)
    for fname, a, b in LITERALS:
        if a not in files[fname]:
            sys.exit('literal not found in %s: %s' % (fname, a))
        files[fname] = files[fname].replace(a, b)

    version = re.search(r"var APP_VERSION = '([^']+)'", files['Code.js']).group(1)
    OUT.mkdir(exist_ok=True)
    (OUT / 'code.js').write_text('/* Apps Script backend (Code.js), unchanged apart from removed confidential values. */\n'
                                  + scrub(files['Code.js']), encoding='utf-8')
    for tpl, (out, page, title) in PAGES.items():
        html = scrub(fill_template(files[tpl], version + ' demo'))
        html = re.sub(r'<head>', '<head>\n' + ('' if re.search(r'<title>', html, re.I) else '<title>%s · Demo</title>\n' % title) + HEAD_INJECT, html, count=1, flags=re.I)
        html = re.sub(r'</body>', BODY_INJECT + '</body>', html, count=1, flags=re.I)
        (OUT / out).write_text(html, encoding='utf-8')

    bad = []
    for p in OUT.glob('*'):
        t = p.read_text(encoding='utf-8', errors='ignore').lower()
        for term in RULES['deny']:
            for m in re.finditer(r'\b' + re.escape(term) + r'\b', t):
                bad.append('%s: %r near %r' % (p.name, term, t[max(0, m.start() - 40):m.end() + 40]))
    if bad:
        print('\n'.join(bad[:40]))
        sys.exit('DENIED TERMS FOUND (%d). Add replace rules.' % len(bad))
    print('built', len(PAGES), 'pages + code.js, version', version, '- deny check clean')


if __name__ == '__main__':
    main()
