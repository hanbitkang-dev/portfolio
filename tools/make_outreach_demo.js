/* Build a synthetic outreach_data.js for the CRM demo.

   node tools/make_outreach_demo.js <real outreach_data.js> <out file>

   Only the CODE parts of the real file are reused: the email/call templates and hooks
   (functions) and the generic playbook steps. Every company, person, address, finding,
   score and decision below is invented. The build then runs its usual scrub on the output. */
const fs = require('fs');
const [, , SRC, OUT] = process.argv;
global.window = global;
require(require('path').resolve(SRC));
const REAL = window.OUTREACH_DATA;

const facts = {
  est: '2012', facility: 'a 3,000m² facility in Auckland, New Zealand', certs: 'GMP and HACCP certified, with an export Risk Management Programme',
  partners: 'New Zealand and Asia', certsShort: 'GMP and HACCP certified', brands: 'around 40 brands across New Zealand and Asia',
  refLine: 'including a leading Asian supplement brand and one of New Zealand\'s longest-standing natural health brands',
  quote: 'quotations within a week for confirmed formulations', leadTime: 'production and dispatch typically within 10–12 weeks of order confirmation',
  innovation: 'new formats such as liquid-filled capsules and stick packs', company: 'Demo Labs', site: 'example.com',
};

const T = (key, name, sub, formats, size, pain, hook, contactName, contactTitle, email, findings, approach, extra) => Object.assign({
  key, checkedAt: '2026-10-20', priority: 1, rank: '1단계 · 소형·독립 브랜드', name, sub, formats, painPoint: pain,
  riskLevel: { tone: 'ok', label: '낮음' }, revenueEstimate: '~NZ$1M (가상 추정)', opportunity: { tone: 'ok', label: '높음' },
  opportunityTip: '첫 통화에서 다음 출시 계획과 현재 리드타임 불만을 먼저 듣는다.',
  findings: findings.map(t => ({ text: t, sources: [{ label: name + ' 웹사이트 (가상)', url: 'https://example.com/' }] })),
  gaps: '구매·NPD 담당자 미확인 (가상 데이터).',
  contacts: [
    { name: contactName, title: contactTitle, source: 'LinkedIn (가상)', linkedin: null, email: null, recommended: true },
    { name: '일반 문의', title: 'Customer Service', source: '공식 Contact 페이지 (가상)', sourceUrl: 'https://example.com/contact', linkedin: null, email, phone: '+64 9 000 0000' },
  ],
  contactStatus: '공개 메일함으로 첫 메일 예정', todoNote: '데모 데이터: 실제 회사가 아닙니다.',
  emailRoute: { to: email, kind: 'shared', attn: contactName + ', ' + contactTitle, why: '회사가 공개한 대표 메일함 (가상).', alt: [], sourceUrl: 'https://example.com/contact' },
  reasoning: contactTitle + '가 실질적인 의사결정자로 보임 (가상).', approach,
  presetLabel: name + ' (데모)',
  draft: { companyName: name, contact: contactName + ', ' + contactTitle, email, phone: '+64 9 000 0000', mfgSetup: 'outsourced', hook,
    products: formats.indexOf('파우더/사셰') !== -1 ? ['p_powder', 'p_sachet'] : ['p_hardcap', 'p_tablet'], skus: 'core capsule and tablet range',
    size, productStatus: 'existing', note: 'Demo target. All details are invented.', contactAlt: 'Internal note (demo): no NPD contact yet.' },
}, extra || {});

const targets = [
  T('harbourleaf', 'Harbourleaf Naturals', '법인명: Harbourleaf Naturals Ltd (가상)', ['하드캡슐', '타블렛'], 'sme', '해외 제조사 리드타임이 길다는 리뷰가 반복됨', 'leadtime',
    'Olivia Grant', 'Managing Director', 'hello@harbourleaf.example',
    ['2015년 설립, 10명 규모 NZ 브랜드 (가상).', '캡슐·정제 18종, 약국과 온라인 판매 (가상).', '최근 아시아 수출 페이지 개설 (가상).'],
    ['NZ 생산으로 재입고 주기를 줄이는 이야기로 시작.', '공장 투어 제안.']),
  T('peakform', 'Peakform Sport', '법인명: Peakform Sport NZ Ltd (가상)', ['파우더/사셰'], 'sme', '맛 개선 요구가 많은 단백질·전해질 라인', 'portfolio',
    'Ben Walsh', 'Head of Product', 'team@peakform.example',
    ['전해질 스틱·단백질 파우더 중심 (가상).', '호주 진출 준비 중 (가상).'],
    ['맛 테스트 샘플 제안.', '300kg 배치로 작게 시작하는 파일럿.'], { priority: 2 }),
  T('kowhai', 'Kōwhai Botanics', '법인명: Kowhai Botanics Ltd (가상)', ['하드캡슐', '소프트젤'], 'micro', 'NZ 원료 스토리를 쓰지만 제조는 해외', 'sourcing',
    'Mere Thompson', 'Founder', 'kiaora@kowhai.example',
    ['NZ 원료 강조 브랜드, 직원 5명 (가상).', '소프트젤 2종 신규 출시 예정 (가상).'],
    ['"NZ sourced, NZ made" 완결 프레이밍.'], { priority: 3 }),
  T('lumen', 'Lumen Wellness', '법인명: Lumen Wellness Ltd (가상)', ['타블렛', '하드캡슐'], 'sme', '공급망 이중화 필요', 'supplyrisk',
    'Daniel Cho', 'Operations Manager', 'info@lumen.example',
    ['오너가 한국계 (가상 공개 인터뷰).', '중국 역직구 채널 판매 (가상).'],
    ['한국어·영어 병행 소통 강점.'], { priority: 4 }),
  T('tidewater', 'Tidewater Health', '법인명: Tidewater Health Ltd (가상)', ['하드캡슐'], 'sme', '과거 거래 후 재연결 필요', 'trust',
    'Sophie Martin', 'Brand Manager', 'wholesale@tidewater.example',
    ['2023년 1회 주문 이력 (가상 CRM).'], ['Reconnect 템플릿으로 근황 공유.'],
    { priority: 5, crm: { name: 'Tidewater Health Ltd', orders: 1, last: '2023-08-08', rep: 'Sam Taylor' } }),
];
targets[4].draft.template = 'reconnect';
targets[3].draft.template = 'asia';

const market = [
  ['Harbourleaf Naturals', 'NZ', 'no', '약국, 온라인', '캡슐, 타블렛', ['하드캡슐', '타블렛'], '소형(10명)', 'harbourleaf'],
  ['Peakform Sport', 'NZ', 'no', '온라인, 체육관', '파우더', ['파우더/사셰'], '소형(15명)', 'peakform'],
  ['Kōwhai Botanics', 'NZ', 'no', '온라인', '캡슐, 소프트젤', ['하드캡슐', '소프트젤'], '초소형(5명)', 'kowhai'],
  ['Lumen Wellness', 'NZ', 'no', '역직구, 온라인', '정제, 캡슐', ['타블렛', '하드캡슐'], '소형(12명)', 'lumen'],
  ['Tidewater Health', 'NZ', 'no', '약국', '캡슐', ['하드캡슐'], '소형(20명)', 'tidewater'],
  ['Summit Daily', 'NZ', 'yes', '수퍼마켓', '캡슐, 구미', ['하드캡슐', '구미'], '대형(300명)', null],
  ['Bluebay Nutrition', 'AU', 'unknown', '약국', '캡슐', ['하드캡슐'], '중형(80명)', null],
  ['Orchard Kids', 'NZ', 'no', '수퍼마켓', '구미', ['구미'], '소형(8명)', null],
].map(r => ({ name: r[0], market: r[1], parent: '-', medsafe: 'unknown', medsafeSrc: 'https://example.com/', ownFactory: r[2], factorySrc: 'https://example.com/',
  mlm: 'no', channel: r[3], formats: r[4], formatTags: r[5], scale: r[6], hwOverlap: null, ...(r[7] ? { key: r[7] } : {}) }));

const strategy = {
  asOf: '2026-10-20', title: 'Outreach Playbook (demo)',
  statusHtml: '<strong>데모 데이터.</strong> 실제 전략 문서의 구조만 보여 줍니다. 회사·사람·수치는 모두 가상입니다.',
  thesisHtml: '대형 제조사에게는 작은 고객이고, 포장만 하는 업체는 개발을 못 하는 <strong>NZ 성장 브랜드</strong>에게, 개발부터 생산까지 한 곳에서 해 주는 중간 포지션으로 접근한다.',
  position: { cols: ['Pack-only packers', 'Demo Labs', 'Large manufacturers'], rows: [
    ['What they do', '벌크를 받아 포장만', '원료 소싱 · 포뮬레이션 · 생산 · 포장', '대량 생산, 전 제형'],
    ['Product development', '거의 없음', '컨셉 단계부터 시작 가능 (가상 조건)', '큰 고객 우선'],
    ['Volume', '작음', '협의 가능 (가상)', '고정 MOQ, 큼'],
  ], note: '데모용 비교표.' },
  strengths: [
    { title: 'Trusted by established brands', status: 'ok', say: 'We manufacture for ' + facts.brands + '.', proof: '가상 근거.', todo: '' },
    { title: 'Fast quotes', status: 'ok', say: 'We send ' + facts.quote + '.', proof: '가상 근거.', todo: '' },
    { title: 'Lead time', status: 'ok', say: facts.leadTime + '.', proof: '가상 근거.', todo: '' },
    { title: 'Innovation', status: 'check', say: 'We develop ' + facts.innovation + '.', proof: '숫자 확인 필요 (가상).', todo: '사례 2개 정리' },
  ],
  gaps: [
    { title: 'No pharma licence', impact: '의약품 등록 제품은 불가 (가상).', answer: '먼저 말하고 건강기능식품에 집중한다고 설명.', script: 'We focus on dietary supplements rather than registered medicines.' },
    { title: 'No gummies', impact: '구미 중심 브랜드는 대상 아님.', answer: '다른 제형을 제안.', script: 'We don\'t make gummies, but we can offer chewable tablets or powders.' },
  ],
  icp: {
    fit: [
      { tier: 'A1', title: 'NZ growth brands', who: '직원 5~50명, 자체 공장 없음, 우리 제형.', why: '중간 포지션이 정확히 맞음.', eg: 'Harbourleaf · Kōwhai · Tidewater' },
      { tier: 'A2', title: 'Powder & liquid brands', who: '단백질·전해질 파우더 브랜드.', why: '맛 개발이 강점.', eg: 'Peakform' },
      { tier: 'A3', title: 'Asian-owned NZ brands', who: '아시아 시장으로 NZ 제품을 파는 곳.', why: '언어·네트워크.', eg: 'Lumen Wellness' },
    ],
    avoid: [['구미 중심 브랜드', '생산 불가'], ['자체 공장이 있는 브랜드', '외주 수요 없음'], ['CRM에 이미 있는 고객', '담당자와 상의 후 Reconnect']],
    nextPool: ['NZ 스포츠 파우더 브랜드 (A2)', 'NZ 원료 스토리를 쓰는 브랜드'],
  },
  criteria: REAL.strategy.criteria.map(c => ({ ...c })),
  picks: [
    { keys: ['harbourleaf'], wave: 1, s: { fit: 3, email: 2, speed: 3, match: 3, risk: 3 }, note: '캡슐·정제 겹침, 오너가 직접 결정 (가상).' },
    { keys: ['peakform'], wave: 1, s: { fit: 3, email: 2, speed: 2, match: 2, risk: 2 }, note: '파우더 파일럿 후보 (가상).' },
    { keys: ['kowhai'], wave: 1, s: { fit: 2, email: 2, speed: 3, match: 2, risk: 3 }, note: 'NZ 원료 스토리 (가상).' },
    { keys: ['lumen'], wave: 2, s: { fit: 2, email: 1, speed: 2, match: 3, risk: 2, asia: 1 }, asiaBasis: '오너 인터뷰 (가상 출처)', note: '아시아 채널 (가상).' },
    { keys: ['tidewater'], wave: 2, s: { fit: 2, email: 2, speed: 2, match: 2, risk: 3 }, note: '과거 고객, Reconnect (가상).' },
  ],
  koImporters: {
    asOf: '2026-10-20', range: '2024-10 ~ 2026-10 (가상)', total: 5, source: '공개 수입식품 조회 (데모에서는 가상 데이터)',
    method: ['구분 = 건강기능식품, 국가 = 뉴질랜드', '수입업체·제조사·제품명을 시트로 정리', '매달 지난 1개월분 추가'],
    law: '정보통신망법 제50조: 광고성 메일은 (광고) 표기와 수신거부 방법을 넣는다.', lawSource: 'https://example.com/law',
    competitors: [{ name: 'Maker A (demo)', n: 40, demolabs: false, customer: false }, { name: 'Demo Labs Limited', n: 25, demolabs: true, customer: false }, { name: 'Maker B (demo)', n: 12, demolabs: false, customer: true }],
    houseBuyers: ['(주)데모수입 (가상)', '샘플헬스 (가상)'],
    rows: [
      { importer: '(주)한빛무역 (가상)', records: 12, last: '2026-09-30', tier: 'A', note: '캡슐 위주 (가상)', makers: [{ name: 'Maker A (demo)', n: 12 }], products: ['오메가3 (가상)', '비타민D (가상)'], no: 1, ceo: { v: 'go', note: '컨택 진행 (가상)', date: '2026-10-20' }, forms: ['p_softgel'], web: { contact: 'https://example.com/', brand: 'own', match: 'high', note: '가상 메모', checked: '2026-10-20' } },
      { importer: '그린트리헬스 (가상)', records: 7, last: '2026-08-12', tier: 'B', note: '파우더 (가상)', makers: [{ name: 'Maker B (demo)', n: 7 }], products: ['프로틴 파우더 (가상)'], no: 2, ceo: { v: 'check', note: '제3자 브랜드인지 확인 (가상)', date: '2026-10-20' }, web: { contact: 'https://example.com/', brand: 'unclear', match: 'low', note: '가상 메모', checked: '2026-10-20' } },
      { importer: '바다생활 (가상)', records: 4, last: '2026-05-02', tier: 'B', note: '', makers: [{ name: 'Maker A (demo)', n: 4 }], products: ['초록입홍합 (가상)'], no: 3 },
    ],
  },
  backlog: [{ name: 'Harbour Kids (demo)', why: '캡슐 전용, 외주 생산 (가상)', need: '공개 메일 없음 (가상)', url: 'https://example.com/' }],
  excludedNote: '구미·의약품 중심 브랜드는 제외 (데모).',
  waves: REAL.strategy.waves,
  sequence: REAL.strategy.sequence,
  rules: REAL.strategy.rules,
  call: REAL.strategy.call,
  decisions: [
    { topic: 'Standard lead time', proposal: '제형별 표준 리드타임을 메일에 쓴다.', why: '숫자가 있어야 설득력이 있음.', status: 'agreed', decision: '10–12주로 표기 (가상 결정).' },
    { topic: 'First email attachment', proposal: '회사 소개서 1개만 첨부.', why: '첫 메일은 가볍게.', status: 'agreed', decision: '소개서만 (가상 결정).' },
    { topic: 'LinkedIn', proposal: 'LinkedIn은 마지막 단계에서만.', why: '스팸 인상 방지.', status: 'open', decision: '' },
  ],
};

const tracker = {
  owners: ['Jamie', 'Sam', 'Alex'], stages: REAL.tracker.stages,
  seed: {
    'nz-harbourleaf': { stage: 'meeting', owner: 'Jamie', next: { action: 'Factory tour, 10am', date: '2026-11-05' },
      log: [{ d: '2026-10-14', type: 'email1', note: '메일1 → hello@ (가상)' }, { d: '2026-10-15', type: 'reply', note: 'MD 답장 — 신규 라인 관심 (가상)' }] },
    'nz-peakform': { stage: 'emailed', owner: 'Sam', next: { action: 'Email 2 (same thread)', date: '2026-11-02' }, log: [{ d: '2026-10-26', type: 'email1', note: '메일1 → team@ (가상)' }] },
    'nz-kowhai': { stage: 'ready', owner: 'Jamie', next: { action: 'Send email 1', date: '2026-10-30' }, log: [] },
  },
};

const out = {
  researchAsOf: '2026-10-20', contactsCheckedAt: '2026-10-20', facts,
  defaultSender: { name: 'Jamie Park', title: 'Sales Team Leader', phone: '+64 9 000 0000' },
  tracker, hooks: REAL.hooks, templates: REAL.templates, koPoints: REAL.koPoints,
  attachments: [
    { id: 'profile', name: 'Company profile (demo).pdf', driveId: '', rule: 'always', phrase: 'company profile', phraseKo: '회사 소개서', reason: 'Sent with the first email (demo rule).' },
    { id: 'brochure', name: 'Brochure (demo).pdf', driveId: '', rule: 'optional', phrase: 'brochure', phraseKo: '브로슈어', reason: 'Demo attachment.' },
    { id: 'pdr', name: 'Product development request (demo).xlsx', driveId: '', rule: 'newProduct', phrase: 'product development request form', phraseKo: '제품 개발 요청서',
      reason: 'For brands that need a new product developed.', reasonNo: { large: 'Established brand with its own SKUs.', other: 'Only once a new product is being scoped.' } },
  ],
  methodologyHtml: '<p>공개된 정보만 사용해 회사를 고르고 점수를 매깁니다. <strong>데모에서는 모든 회사가 가상입니다.</strong></p>',
  closingHtml: '<p>데모 데이터입니다.</p>', researchNoteHtml: '<p>가상 리서치 메모.</p>', marketNoteHtml: '<p>가상 시장 스크리닝.</p>',
  strategy, targets, market,
};

// serialise, keeping the template/hook functions as code
function ser(v, ind) {
  ind = ind || '';
  if (typeof v === 'function') return v.toString();
  if (Array.isArray(v)) return '[' + v.map(x => ser(x, ind + ' ')).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).map(k => JSON.stringify(k) + ':' + ser(v[k], ind + ' ')).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
fs.writeFileSync(OUT, '/* Outreach tab data for the demo: invented companies and people. Generated by tools/make_outreach_demo.js. */\nwindow.OUTREACH_DATA = ' + ser(out) + ';\n');
console.log('outreach demo data', fs.statSync(OUT).size, 'bytes,', targets.length, 'targets');
