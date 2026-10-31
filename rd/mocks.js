/* Demo stand-in for Gemini in the R&D Toolkit. The real app sends the client brief plus the
   whole ingredient DB to Gemini; here the answer is picked from the same DB lines in the prompt
   by simple keyword matching, so it only ever recommends items that exist in the demo data. */
(function () {
  var KEYWORDS = {
    '면역': ['vitamin c', 'zinc', 'elderberry', 'echinacea', 'propolis', 'colostrum', 'vitamin d3', 'beta-glucan', 'lactoferrin'],
    '수면': ['magnesium', 'theanine', '5-htp', 'ashwagandha', 'melatonin'],
    '관절': ['glucosamine', 'chondroitin', 'msm', 'mussel', 'turmeric', 'hyaluronic', 'collagen'],
    '피부': ['collagen', 'hyaluronic', 'vitamin c', 'astaxanthin', 'grape seed', 'biotin'],
    '장': ['lactobacillus', 'bifidobacterium', 'inulin', 'kiwifruit'],
    '눈': ['lutein', 'bilberry', 'astaxanthin', 'beta-carotene'],
    '피로': ['ginseng', 'rhodiola', 'b12', 'coenzyme', 'iron', 'carnitine'],
    '심혈관': ['fish oil', 'krill', 'coenzyme', 'vitamin k2', 'grape seed'],
    '간': ['milk thistle', 'cysteine', 'lipoic'],
  };
  function lines(prompt, header) {
    var i = prompt.indexOf(header); if (i < 0) return [];
    var body = prompt.slice(prompt.indexOf('\n', i) + 1);
    var end = body.indexOf('\n\n'); if (end >= 0) body = body.slice(0, end);
    return body.split('\n').map(function (l) { return l.split(' | '); }).filter(function (p) { return p.length >= 3; });
  }
  // one row per code (the DB has a row per price update), one ingredient per keyword first
  function pick(rows, words, n) {
    var seen = {}, uniq = rows.filter(function (r) { if (seen[r[0]]) return false; seen[r[0]] = 1; return true; });
    var out = [];
    words.forEach(function (w) {
      var r = uniq.find(function (x) { return out.indexOf(x) === -1 && x[1].toLowerCase().indexOf(w) !== -1; });
      if (r) out.push(r);
    });
    uniq.forEach(function (r) {
      if (out.indexOf(r) === -1 && words.some(function (w) { return r[1].toLowerCase().indexOf(w) !== -1; })) out.push(r);
    });
    return out.slice(0, n);
  }
  function price(s) { var m = /^(\w+)\s+(.+)$/.exec((s || '').trim()); return m ? { currency: m[1], salesPrice: m[2] } : { currency: '', salesPrice: s }; }
  function wordsFor(text) {
    var w = [];
    Object.keys(KEYWORDS).forEach(function (k) { if (text.indexOf(k) !== -1) w = w.concat(KEYWORDS[k]); });
    return w.length ? w : KEYWORDS['면역'];
  }
  function recommend(prompt) {
    var benefit = (/타겟 효능: (.*)/.exec(prompt) || [])[1] || '';
    var form = (/제형: (.*)/.exec(prompt) || [])[1] || '';
    var or = pick(lines(prompt, '=== 원료 DB'), wordsFor(benefit), 6);
    var op = lines(prompt, '=== 부자재 DB').filter(function (r) { return /bottle|cap|label|desiccant|seal|pouch|sachet|capsule|shell/i.test(r[1]); });
    if (/소프트|soft/i.test(form)) op = op.filter(function (r) { return !/HPMC/i.test(r[1]); });
    op = op.slice(0, 4);
    return {
      summary: '[데모 응답] "' + benefit + '" 효능에 맞춰 원료 DB에서 관련 원료 ' + or.length + '개와 ' + (form || '선택한 제형') + '에 쓰는 부자재 ' + op.length + '개를 골랐습니다. 실제 버전은 Gemini가 같은 DB를 보고 근거와 함께 추천합니다.',
      orItems: or.map(function (r) { var p = price(r[2]); return { code: r[0], name: r[1], salesPrice: p.salesPrice, currency: p.currency, supplier: r[3] || '', reason: '타겟 효능(' + benefit + ')과 관련된 원료 (데모 매칭)' }; }),
      opItems: op.map(function (r) { var p = price(r[3]); return { code: r[0], name: r[1], pkgType: r[2], salesPrice: p.salesPrice, currency: p.currency, supplier: r[4] || '', reason: '제형·포장에 맞는 기본 부자재 (데모)' }; }),
    };
  }
  function upgrade(prompt) {
    var benefit = (/타겟 효능: (.*)/.exec(prompt) || [])[1] || '';
    var bom = lines(prompt, '=== 현재 원료 구성');
    var db = lines(prompt, '=== 원료 DB');
    var inBom = bom.map(function (b) { return b[0]; });
    var minor = bom.slice(1).filter(function (b) { return /cellulose|stearate|flour|dioxide|dicalcium|maltodextrin/i.test(b[1]); }).slice(0, 2);
    var alt = db.filter(function (r) { return /rice flour|silicon|sunflower lecithin|inulin/i.test(r[1]) && inBom.indexOf(r[0]) === -1; });
    var add = pick(db.filter(function (r) { return inBom.indexOf(r[0]) === -1; }), wordsFor(benefit), 3);
    return {
      summary: '[데모 응답] 주원료는 유지하고, 부형제 일부를 클린 라벨 원료로 바꾸고 효능(' + benefit + ')을 보강할 원료를 더하는 방향입니다.',
      replaceItems: minor.map(function (b, i) { var r = alt[i] || alt[0]; if (!r) return null; var p = price(r[2]); return { currentCode: b[0], currentName: b[1], newCode: r[0], newName: r[1], salesPrice: p.salesPrice, currency: p.currency, supplier: r[3] || '', reason: '클린 라벨 부형제로 교체 (데모)' }; }).filter(Boolean),
      addItems: add.map(function (r) { var p = price(r[2]); return { code: r[0], name: r[1], salesPrice: p.salesPrice, currency: p.currency, supplier: r[3] || '', reason: '효능 시너지 (데모 매칭)' }; }),
    };
  }
  window.GAS_FETCH_MOCKS = [{
    match: /generativelanguage\.googleapis\.com/, respond: function (url, opts) {
      var body = JSON.parse(opts.payload || '{}');
      var prompt = (((body.contents || [])[0] || {}).parts || [{}])[0].text || '';
      var out = /업그레이드/.test(prompt) ? upgrade(prompt) : recommend(prompt);
      return { body: { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }] } };
    },
  }];
})();
