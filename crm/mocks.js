/* Demo stand-in for Gemini: the Worker's AI routes (/api/ask, /api/production_insight,
   /api/pipeline_insight) get a canned answer built from the numbers in their own prompt. */
window.WORKER_GEMINI_MOCK = function (body) {
  var sys = ((body.system_instruction || {}).parts || [{}])[0].text || '';
  var turns = body.contents || [];
  var q = (((turns[turns.length - 1] || {}).parts || [{}])[0].text || '').trim();
  var count = function (re) { var m = sys.match(re); return m ? m[1] : '?'; };
  if (/production data analyst/.test(sys)) {
    return 'Demo answer (no live AI in this demo). Hard capsules carry most of the volume and grew year on year, softgels are steady, and powders are small but rising. ' +
      'Worth checking whether the powder growth comes from one or two clients before planning more line time for it.' + (q && !/initial analysis/i.test(q) ? ' Noted: "' + q.slice(0, 120) + '".' : '');
  }
  if (/[Pp]ipeline/.test(sys) && !/AI assistant for the Demo Labs CRM/.test(sys)) {
    return 'Demo answer (no live AI). Most open value sits in Quoted and Negotiating. Two deals have been in the same stage for over 30 days; a short call on each would tell you whether they are still live.';
  }
  return '**Demo answer** (a fixed reply instead of the live AI)\n\n- Open deals: ' + count(/Deals \((\d+)\)/) + '\n- Clients: ' + count(/Clients \((\d+)\)/) + '\n\n' +
    'Question: "' + q.slice(0, 160) + '"\n\nThe real version sends this data to Gemini for the answer.';
};
