"""English-only demo: replace the Korean UI text in the built demo files with English.

    python tools/translate_en.py todo    # list Korean segments with no translation -> tools/i18n/todo.tsv
    python tools/translate_en.py merge   # add tools/i18n/tr/*.tsv (todo line no. <TAB> English) to en.json
    python tools/translate_en.py apply   # apply tools/i18n/en.json; fails if visible Korean is left

Run `apply` after the build_*.py scripts. A segment is a run of text between quotes, tags,
braces or line ends that contains Hangul. Code comments are left alone (not shown on screen).
A dictionary value equal to its key marks a segment that must stay as is (e.g. a regex class).
"""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DICT = ROOT / 'tools' / 'i18n' / 'en.json'
TODO = ROOT / 'tools' / 'i18n' / 'todo.tsv'
HANGUL = re.compile('[가-힣ㄱ-ㆎ]')
SEG = re.compile("[^\"'`<>\\n{}$\\\\]*[가-힣ㄱ-ㆎ][^\"'`<>\\n{}$\\\\]*")
DIRS = ('pricing', 'crm', 'rd', 'shared')


# These tabs already carry English next to Korean (T(en, ko)); the demo pins them to English
# instead, so their Korean is never shown and is not translated here.
BILINGUAL = {'crm/delays.js', 'crm/production.js'}


def files():
    for d in DIRS:
        for p in sorted((ROOT / d).rglob('*')):
            if p.suffix in ('.html', '.js') and 'vendor' not in p.parts and '_build' not in p.parts \
                    and p.relative_to(ROOT).as_posix() not in BILINGUAL:
                yield p


def strip_comments(t):
    t = re.sub(r'<!--.*?-->', '', t, flags=re.S)
    t = re.sub(r'/\*.*?\*/', '', t, flags=re.S)
    return re.sub(r'(?m)(^|[\s;{}(,])//[^\n]*', r'\1', t)


def visible_segments(text):
    return [s.strip() for s in SEG.findall(strip_comments(text)) if HANGUL.search(s)]


def load_dict():
    return json.loads(DICT.read_text(encoding='utf-8')) if DICT.exists() else {}


def todo():
    d = load_dict()
    seen, rows = set(), []
    for p in files():
        for s in visible_segments(p.read_text(encoding='utf-8')):
            if s not in d and s not in seen:
                seen.add(s)
                rows.append('%s\t%s' % (p.relative_to(ROOT).as_posix(), s))
    TODO.parent.mkdir(exist_ok=True)
    TODO.write_text('\n'.join(rows) + '\n', encoding='utf-8')
    print('%d untranslated segments -> %s' % (len(rows), TODO.relative_to(ROOT)))


def apply():
    d = load_dict()
    # a segment sits inside a JS string or HTML text whose delimiter we don't know, so
    # translations may not contain quotes, tags, braces or escapes (use ’ for apostrophes)
    bad = [k for k, v in d.items() if v != k and re.search(r"[\"'`<>{}$\\\n]", v)]
    if bad:
        sys.exit('UNSAFE CHARACTERS in translations of: ' + ', '.join(bad[:20]))

    def sub(m):
        raw = m.group(0)
        s = raw.strip()
        if s not in d:
            return raw
        lead = raw[:len(raw) - len(raw.lstrip())]
        trail = raw[len(raw.rstrip()):]
        return lead + d[s] + trail

    changed, left = 0, []
    for p in files():
        t = p.read_text(encoding='utf-8')
        n = SEG.sub(sub, t)
        if n != t:
            p.write_text(n, encoding='utf-8', newline='')
            changed += 1
        for s in visible_segments(n):
            if d.get(s) != s:
                left.append('%s: %s' % (p.relative_to(ROOT).as_posix(), s))
    print('translated %d files' % changed)
    if left:
        print('\n'.join(left[:40]))
        sys.exit('KOREAN TEXT LEFT (%d). Run `todo`, add translations to tools/i18n/en.json.' % len(left))
    print('no visible Korean left')


def merge():
    """Add translations from tools/i18n/tr/*.tsv (line number in todo.tsv <TAB> English) to en.json."""
    todo_rows = TODO.read_text(encoding='utf-8').split('\n')
    d = load_dict()
    added = 0
    for f in sorted((DICT.parent / 'tr').glob('*.tsv')):
        for line in f.read_text(encoding='utf-8').split('\n'):
            if not line.strip():
                continue
            n, _, en = line.partition('\t')   # no tab = translate to nothing (a dropped particle)
            ko = todo_rows[int(n) - 1].split('\t', 1)[1]
            if ko not in d:
                added += 1
            d[ko] = en
    DICT.write_text(json.dumps(d, ensure_ascii=False, indent=0, sort_keys=True) + '\n', encoding='utf-8')
    print('merged %d new translations; dictionary has %d' % (added, len(d)))


if __name__ == '__main__':
    {'todo': todo, 'apply': apply, 'merge': merge}[sys.argv[1] if len(sys.argv) > 1 else 'todo']()
