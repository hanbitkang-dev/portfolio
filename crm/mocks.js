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
  if (/[Pp]ipeline/.test(sys) && !/CRM 전용 AI/.test(sys)) {
    return 'Demo answer (no live AI). Most open value sits in Quoted and Negotiating. Two deals have been in the same stage for over 30 days; a short call on each would tell you whether they are still live.';
  }
  return '**데모 응답** (실제 AI 대신 고정 답변입니다)\n\n- 진행 중인 딜: ' + count(/딜 현황 \((\d+)건\)/) + '건\n- 고객사: ' + count(/고객사 현황 \((\d+)개사\)/) + '곳\n\n' +
    '질문: "' + q.slice(0, 160) + '"\n\n실제 버전에서는 이 데이터를 Gemini에 보내 답을 받습니다.';
};
