"""Build the R&D Toolkit demo from the real Apps Script source.

    python tools/build_rd.py <path-to>/raw_data_analytics/rd_toolkit

Same approach as build_pricing.py. It shares the Pricing demo's synthetic data
(pricing/seed.js has the OB product master and OB_BOM sheets this tool reads).
"""
import pathlib, re, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build_pricing as bp

OUT = bp.ROOT / 'rd'
PAGES = {'Index.html': ('index.html', 'Product Search'), 'Recommend.html': ('recommend.html', 'AI Recommend')}
VARS = {'searchUrl': 'index.html', 'recommendUrl': 'recommend.html', 'pricingUrl': '../pricing/', 'gmUrl': '../pricing/gm.html',
        'guideUrl': '../pricing/guide.html', 'userEmail': 'demo.user@example.com', 'userInitials': 'DU'}
HEAD = bp.HEAD_INJECT.replace("'pricing-demo'", "'rd-demo'").replace('src="seed.js"', 'src="../pricing/seed.js"')


def main():
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '')
    code = (src / 'Code.js').read_text(encoding='utf-8-sig')
    version = re.search(r"var APP_VERSION = '([^']+)'", code).group(1)
    OUT.mkdir(exist_ok=True)
    (OUT / 'code.js').write_text('/* Apps Script backend (Code.js), unchanged apart from removed confidential values. */\n' + bp.scrub(code), encoding='utf-8')
    for tpl, (out, title) in PAGES.items():
        html = (src / tpl).read_text(encoding='utf-8-sig')
        html = re.sub(r'<\?\s*if\s*\(hasPricingUrl\)\s*\{\s*\?>|<\?\s*\}\s*\?>', '', html)   # the demo always has the Pricing pages
        vals = dict(VARS, appVersion=version + ' demo')
        html = re.sub(r'<\?=\s*([A-Za-z_]+)\s*\?>', lambda m: vals[m.group(1)], html)
        if '<?' in html:
            sys.exit('unhandled scriptlet in ' + tpl)
        html = bp.scrub(html)
        if not re.search(r'<title>', html, re.I):
            html = re.sub(r'<head>', '<head>\n<title>%s · Demo</title>' % title, html, count=1, flags=re.I)
        html = re.sub(r'<head>', '<head>\n' + HEAD, html, count=1, flags=re.I)
        html = re.sub(r'</body>', bp.BODY_INJECT + '</body>', html, count=1, flags=re.I)
        (OUT / out).write_text(html, encoding='utf-8')
    bad = []
    for p in OUT.glob('*'):
        t = p.read_text(encoding='utf-8', errors='ignore').lower()
        for term in bp.RULES['deny']:
            if re.search(r'\b' + re.escape(term) + r'\b', t):
                bad.append('%s: %s' % (p.name, term))
    if bad:
        sys.exit('DENIED TERMS FOUND: ' + ', '.join(bad))
    print('built rd/ (2 pages + code.js), version', version, '- deny check clean')


if __name__ == '__main__':
    main()
