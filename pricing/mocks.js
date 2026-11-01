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
      identity: { branded: branded ? 'yes' : 'ambiguous', brands: branded ? [{ name: name.replace(/\s*\(.*$/, ''), owner: 'Needs checking', distributors: [], label_name: name }] : [],
        generic_equivalents: [name.replace(/[®™]/g, '').trim()], notes: 'Demo response: fixed sample data instead of a real web search.' },
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
    var cases = [{ key: 'A', label: branded ? 'Branded ingredient' : 'Generic ingredient (food grade)', type: branded ? 'branded' : 'generic', currency: 'USD', unit: unit,
      low: low, mid: mid, high: high, incoterms: 'FOB', moq: isPkg ? '10,000 ea' : '25 kg', confidence: med ? 'medium' : 'low',
      confidence_note: med ? 'Based on the spread of company purchase prices in the same category' : 'Few company data points, so the range is wide',
      basis: [med ? 'Same-category median NZD ' + med + '/' + unit + ' → converted to USD ' + mid : 'Demo default', 'Cross-checked with web B2B ranges (demo)'], grade_note: '' }];
    if (!isPkg && !branded) cases.push({ key: 'B', label: 'If high-strength or branded', type: 'branded', currency: 'USD', unit: unit,
      low: +(mid * 1.8).toFixed(1), mid: +(mid * 2.6).toFixed(1), high: +(mid * 3.5).toFixed(1), incoterms: 'FOB', moq: '5 kg', confidence: 'low',
      confidence_note: 'Before confirming branded or not', basis: ['Branded ingredients cost about 2–4× generic (demo assumption)'], grade_note: '' });
    return {
      summary: name + ': recommended ' + mid + ' USD/' + unit + ' (demo estimate)', branded: branded ? 'yes' : 'no', brand_candidates: [],
      cases: cases, recommended: 'A',
      recommendation: 'Quote on A and check with the client first whether it is a branded ingredient. (demo response)',
      db_evidence: med ? 'p25–p75 range of n company purchases in the same category' : 'Few similar items in the company DB',
      client_questions: [{ q: 'Does a specific branded ingredient need to be on the label?', why: 'A branded ingredient changes the price a lot' }],
      procurement_requests: ['Ask at least two suppliers for quotes (incl. MOQ and lead time)'],
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
