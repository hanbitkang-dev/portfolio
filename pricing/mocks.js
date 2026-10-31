/* Demo stand-ins for the external APIs the backend calls with UrlFetchApp.
   - exchangerate-api.com  -> fixed demo rates
   - Gemini generateContent -> a canned two-step answer built from the prompt itself,
                               so the "AI estimate" flow runs end to end without a key. */
(function () {
  function between(s, a, b) { var i = s.indexOf(a); if (i < 0) return ''; i += a.length; var j = s.indexOf(b, i); return s.slice(i, j < 0 ? undefined : j); }
  function num(s) { var m = /(-?\d+(?:\.\d+)?)/.exec(s || ''); return m ? parseFloat(m[1]) : null; }

  function research(prompt) {
    var name = between(prompt, 'ITEM: "', '"');
    var isPkg = /packaging component/.test(prompt);
    var branded = /[®™]/.test(name);
    return {
      identity: { branded: branded ? 'yes' : 'ambiguous', brands: branded ? [{ name: name.replace(/\s*\(.*$/, ''), owner: '확인 필요', distributors: [], label_name: name }] : [],
        generic_equivalents: [name.replace(/[®™]/g, '').trim()], notes: '데모 응답: 실제 웹 검색 대신 고정 예시 데이터입니다.' },
      dose_mg_per_day: { value: null, basis: '' },
      retail_products: [],
      b2b_listings: [{ source: 'Demo B2B listing', grade: 'food', price_low: isPkg ? 0.05 : 18, price_high: isPkg ? 0.12 : 46, currency: 'USD', unit: isPkg ? 'ea' : 'kg', incoterms: 'FOB', moq: isPkg ? '10,000 ea' : '25 kg', note: 'demo' }],
      price_signals: [], other_facts: [],
    };
  }

  function reasoning(prompt) {
    var isPkg = /priced per each/.test(prompt);
    var unit = isPkg ? 'ea' : 'kg';
    var med = num(between(prompt, 'median ', ' '));
    var p25 = num(between(prompt, 'p25 ', ' '));
    var p75 = num(between(prompt, 'p75 ', '\n'));
    var fx = num(between(prompt, '1 NZD = ', ' USD')) || 0.6;
    var name = between(prompt, '- Name: ', '\n').replace(/\s*\(internal code.*$/, '');
    var branded = /[®™]/.test(name);
    var mid = med ? +(med * fx).toFixed(isPkg ? 4 : 1) : (isPkg ? 0.08 : 32);
    var low = p25 ? +(p25 * fx).toFixed(isPkg ? 4 : 1) : +(mid * 0.75).toFixed(isPkg ? 4 : 1);
    var high = p75 ? +(p75 * fx).toFixed(isPkg ? 4 : 1) : +(mid * 1.4).toFixed(isPkg ? 4 : 1);
    var cases = [{ key: 'A', label: branded ? '브랜드 원료' : '일반 원료 (식품 등급)', type: branded ? 'branded' : 'generic', currency: 'USD', unit: unit,
      low: low, mid: mid, high: high, incoterms: 'FOB', moq: isPkg ? '10,000 ea' : '25 kg', confidence: med ? 'medium' : 'low',
      confidence_note: med ? '사내 같은 분류 구매가 분포를 기준으로 함' : '사내 근거가 적어 범위가 넓음',
      basis: [med ? '같은 분류 중앙값 NZD ' + med + '/' + unit + ' → USD 환산 ' + mid : '데모 기본값', '웹 B2B 범위와 교차 확인 (데모)'], grade_note: '' }];
    if (!isPkg && !branded) cases.push({ key: 'B', label: '고함량·브랜드일 경우', type: 'branded', currency: 'USD', unit: unit,
      low: +(mid * 1.8).toFixed(1), mid: +(mid * 2.6).toFixed(1), high: +(mid * 3.5).toFixed(1), incoterms: 'FOB', moq: '5 kg', confidence: 'low',
      confidence_note: '브랜드 여부 확인 전', basis: ['브랜드 원료는 일반 원료의 2~4배 수준 (데모 가정)'], grade_note: '' });
    return {
      summary: name + ': 추천 ' + mid + ' USD/' + unit + ' (데모 추정)', branded: branded ? 'yes' : 'no', brand_candidates: [],
      cases: cases, recommended: 'A',
      recommendation: 'A 기준으로 견적하고, 고객에게 브랜드 원료 여부를 먼저 확인하세요. (데모 응답)',
      db_evidence: med ? '같은 분류 사내 구매 n건의 p25~p75 범위' : '사내 유사 품목 부족',
      client_questions: [{ q: '특정 브랜드 원료를 라벨에 표기해야 하나요?', why: '브랜드 원료면 단가가 크게 달라짐' }],
      procurement_requests: ['공급사 2곳 이상 견적 요청 (MOQ·리드타임 포함)'],
    };
  }

  window.GAS_FETCH_MOCKS = [
    { match: /exchangerate-api\.com/, respond: function () {
      return { body: { base: 'NZD', rates: { NZD: 1, USD: 0.598, KRW: 826.4, AUD: 0.902 } } };
    } },
    { match: /generativelanguage\.googleapis\.com/, respond: function (url, opts) {
      var body = JSON.parse(opts.payload || '{}');
      var prompt = (((body.contents || [])[0] || {}).parts || [{}])[0].text || '';
      var isResearch = /Use Google Search/.test(prompt);
      var json = isResearch ? research(prompt) : reasoning(prompt);
      return { body: { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP',
        groundingMetadata: isResearch ? { webSearchQueries: ['(demo) ' + between(prompt, 'ITEM: "', '"') + ' price per kg'],
          groundingChunks: [{ web: { uri: 'https://example.com/demo-listing', title: 'Demo listing (no live search in the demo)' } }] } : {} }] } };
    } },
  ];
})();
