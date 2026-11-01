/* Outreach tab (CRM v3.2, Strategy view v3.3) -- Project WhaleHunting cold-outreach toolkit.

   Moved into the CRM from the retired public Worker (outreach/). template.html's
   renderOutreachTab() loads outreach.css and outreach_data.js (window.OUTREACH_DATA)
   the first time the tab opens, then this file, then calls Outreach.mount().

   Views: Strategy (the agreed plan: positioning, top picks, email-first sequence, call
   method, open decisions) · Research & approach · Draft generator · Market screening.
   Email comes first everywhere: contacts list email before phone and LinkedIn, and the
   generator writes the whole sequence (first email, two follow-ups, break-up).

   Self-contained on purpose: CSS classes and element ids start with "or-", the only
   global is window.Outreach, and nothing is written to KV -- the sender signature is
   kept in this browser's localStorage. Generic pieces (.btn, .seg, .chip, .tag,
   .table-wrap, .icon) are the CRM's own.

   Outreach.compose(form) has no DOM access, so the email / call copy can be checked
   in Node (see CLAUDE.md, "Outreach tab"). */
(function () {
  'use strict';

  const FORMAT_EN = { 'Hard capsules': 'Hard capsule', 'Tablets': 'Tablet', 'Softgels': 'Softgel', 'Powder/sachets': 'Powder / sachet',
    'Liquids': 'Liquid', 'Gummies': 'Gummy', 'Bars': 'Bar', 'Honey': 'Honey', 'Herbal tea': 'Herbal tea' };
  const PRODUCTS = { p_hardcap: ['Hard capsule', 'hard capsules', 'Hard capsules'], p_tablet: ['Tablet', 'tablets', 'tablets'], p_softgel: ['Softgel', 'softgel capsules', 'Softgels'],
    p_powder: ['Powder / sachet', 'powders and sachets', 'powder · sticks'], p_liquid: ['Liquid', 'liquids', 'liquids'] };
  // Korean particle after a word: a when the last syllable has a final consonant, else b (을/를, 과/와).
  const josa = (w, a, b) => { const ch = String(w).charCodeAt(String(w).length - 1); return ch >= 0xAC00 && ch <= 0xD7A3 && (ch - 0xAC00) % 28 ? a : b; };
  // Local parts that mean a shared inbox rather than a person.
  const SHARED_INBOX = /^(info|office|hello|admin|enquir(y|ies)|inquir(y|ies)|contact|sales|support|wholesale|customer[._-]?service|cs|team|mail|general|reception)$/i;
  const MAIN_LINE = /^(0800|0508|1800)/;
  const SENDER_KEY = 'or_sender';
  const STALE_DAYS = 30;
  // NZ Unsolicited Electronic Messages Act 2007: commercial email needs a way to opt out.
  const OPT_OUT = `If this isn't relevant for you, just reply and let me know and I won't follow up.`;
  const DEFAULT_CTA = `Would you be open to a 15-minute call, or to visiting our facility to see production and our quality process first-hand? Whatever suits you best.`;
  // Short format names for the "good fit" list (sachets go in the packaging part).
  const FIT_FORMATS = { p_hardcap: ['hard capsules'], p_softgel: ['softgels'], p_tablet: ['tablets'], p_powder: ['powders'], p_liquid: ['liquids'] };
  // The email sequence, in sending order (Strategy view > Email-first sequence).
  const EMAIL_STEPS = [
    ['first', '1', 'Day 0', 'First email'],
    ['fu1', '2', 'Day 3–4', 'Follow-up'],
    ['fu2', '3', 'Day 8–10', 'Follow-up'],
    ['breakup', '4', 'Day 21+', 'Break-up']
  ];

  let D = null, root = null;
  const state = { view: 'tracker', researchGroup: 'all', presetGroup: 'all', presetKey: null, outTab: 'email', emailStep: 'first', attachTicks: {}, mx: null, mxPreset: 'all',
    coList: 'nz', krF: 'all', trk: null, trkErr: '', trkOpen: null, trkF: { list: 'all', stage: 'active', owner: '', due: false, q: '' } };

  // ---------- small helpers ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = sel => root.querySelector(sel);
  const $$ = sel => Array.from(root.querySelectorAll(sel));
  const pad = n => String(n).padStart(2, '0');
  const target = key => D.targets.find(t => t.key === key);
  const byPriority = () => [...D.targets].sort((a, b) => a.priority - b.priority);
  // Contact order: the Strategy view's Top picks (wave, then score); old priority without it.
  function ordered() {
    if (!D.strategy) return byPriority();
    const keys = scoredPicks().flatMap(p => p.keys);
    return keys.map(target).filter(Boolean).concat(byPriority().filter(t => !keys.includes(t.key)));
  }
  const pickOf = key => D.strategy ? scoredPicks().find(p => p.keys.includes(key)) : null;
  const isGeneralContact = c => /^General enquiry/.test((c && c.name) || '');
  const formatGroup = t => t.formats.every(f => f === 'Powder/sachets') ? 'powder' : 'capsule';
  const isSharedInbox = email => SHARED_INBOX.test(String(email || '').split('@')[0]);
  const isMainLine = phone => MAIN_LINE.test(String(phone || '').replace(/[\s()-]/g, ''));
  function joinList(items) {
    if (items.length < 2) return items[0] || '';
    const last = items[items.length - 1];
    if (last.includes(' and ')) return items.join(', ');
    // Oxford comma when an earlier item has its own "and" ("softgels such as CoQ10 and D3, and tablets").
    return items.slice(0, -1).join(', ') + (items.slice(0, -1).some(x => x.includes(' and ')) ? ', and ' : ' and ') + last;
  }
  // "the CEO Stobie, CEO" -> {name, title, first}; null when it isn't a person.
  function splitContact(contact) {
    const s = String(contact || '').trim();
    if (!s || /^(general|customer service)/i.test(s)) return null;
    const i = s.indexOf(',');
    const name = (i < 0 ? s : s.slice(0, i)).trim();
    return { name, title: i < 0 ? '' : s.slice(i + 1).trim(), first: name.split(/\s+/)[0] };
  }
  // "Jamie Park" -> "Jamie Park": the name used when introducing yourself.
  const introName = n => String(n || '').replace(/^(\S+)\s*\(([^)]+)\)\s*(.*)$/, '$2 $3').trim();
  // Email copy marks a few phrases **like this**: bold in the preview and in the copied body
  // (rich clipboard), plain everywhere else.
  const boldHtml = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const plainText = t => String(t == null ? '' : t).replace(/\*\*(.+?)\*\*/g, '$1');
  function loadSender() {
    try {
      const s = JSON.parse(localStorage.getItem(SENDER_KEY) || 'null');
      // Alex's signature was the default until v3.9 -- a browser that only ever kept it gets Jamie's
      if (s && s.name === 'Alex Kim' && s.title === 'Sales Representative') return { ...D.defaultSender };
      if (s && s.name) return s;
    } catch (e) { /* private mode etc. */ }
    return { ...D.defaultSender };
  }
  function saveSender(s) { try { localStorage.setItem(SENDER_KEY, JSON.stringify(s)); } catch (e) { /* keeps working for this session */ } }

  // ---------- copy generation (pure) ----------
  // form: {company, contact, email, phone, generalInbox, generalLine, mfgSetup, hook, template,
  //        products[], skus, size, productStatus, note, attachments[] (ids), sender}
  // Returns the first email (to/subject/body), the follow-ups in steps.fu1 / fu2 / breakup
  // (sent as replies in the same thread), the call script, an optional LinkedIn note
  // ('' when there is no named person), lang and warnings for the screen only.
  // The template (D.templates) picks the language and, except "standard", the opening.
  // The "Why we think we could be a good fit" list in email 1 (standard template). Claims come
  // from D.facts, agreed 2026-10-20 (Strategy > Proof points / Decisions).
  // vegeCaps (draft.vegeCaps): the brand's capsules are vegetable capsules, which we also make.
  function fitPoints(products, sameFormats, refLine, vegeCaps) {
    const facts = D.facts;
    const names = products.flatMap(p => FIT_FORMATS[p] || [])
      .map(n => vegeCaps && n === 'hard capsules' ? 'hard capsules (including vegetable capsules)' : n);
    if (products.includes('p_hardcap')) names.push('liquid-filled capsules');
    const list = names.length < 2 ? (names[0] || '') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    const powderOnly = products.every(p => p === 'p_powder' || p === 'p_liquid');
    const hasPowder = products.includes('p_powder');
    const packs = powderOnly ? 'in sachets, pouches or bottles' : hasPowder ? 'in bottles, aluminium blisters, sachets or pouches' : 'in bottles or aluminium blisters';
    return [
      `**Trusted by established brands** — we manufacture for ${facts.brands}, ${refLine}.`,
      `**15+ years in the industry** — established in ${facts.est}, manufacturing since 2015, and in our purpose-built Auckland facility since 2020. ${facts.certsShort}.`,
      `**Fast turnaround** — ${facts.quote}, and ${facts.leadTime}.`,
      `${list.charAt(0).toUpperCase() + list.slice(1)}${names.length > 1 ? ', ' : ' '}${packs}${sameFormats}.`,
      `**Innovative product development** — ${facts.innovation}`
    ];
  }

  function compose(f) {
    const T = D.templates || {};
    const tpl = T[f.template] || T.standard || { lang: 'en' };
    if (tpl.lang === 'ko') return composeKo(f, tpl);
    const hook = D.hooks[f.hook] || D.hooks.supplyrisk;
    const ctx = { generalInbox: !!f.generalInbox };
    const s = f.sender || D.defaultSender;
    const me = introName(s.name);
    const facts = D.facts;
    const person = splitContact(f.contact);
    const products = f.products && f.products.length ? f.products : ['p_hardcap'];
    const productList = joinList(products.map(p => PRODUCTS[p][1]));
    const skus = joinList(String(f.skus || '').split(',').map(x => x.trim()).filter(Boolean));
    const sameFormats = skus ? ` — the same formats as your ${skus}` : '';
    const callHook = typeof hook.callHook === 'function' ? hook.callHook(f.note, ctx) : hook.callHook;
    const signature = `Best regards,\n${s.name}\n${s.title} | ${facts.company}\nP. ${s.phone}\n${facts.site}`;

    // Email 1
    // v3.8 (2026-10-20): a named person is greeted by name even at a shared inbox (the
    // subject already says "Attn: <name>"); the pass-it-on request moves to the end, next to
    // the opt-out line, so the email doesn't open with a request to the gatekeeper.
    const greeting = person
      ? `Hi ${person.first},`
      : (f.generalInbox ? `Hello ${f.company ? f.company + ' team' : 'there'},` : 'Hi there,');
    const passOn = !f.generalInbox ? ''
      : person ? `If someone else on your team looks after manufacturing and supply, I'd be grateful if you could pass this on.`
      : `Could you please pass this on to whoever looks after manufacturing and supply? Thank you.`;
    const closing = passOn ? `${passOn} And if it isn't relevant, just reply and let me know and I won't follow up.` : OPT_OUT;
    // Templates other than "standard" bring their own subject, opening, pitch and CTA.
    const own = typeof tpl.opening === 'function';
    const c = { company: f.company, person, productList, skus, sender: s, me, facts, generalInbox: !!f.generalInbox };
    // v3.10: f.email1 = the company's approved email 1 (targets[].draft.email1), used as written;
    // {me} becomes the sender's short name and the signature is added below. f.refLine =
    // the company's own reference line (draft.refLine), for email 1 and the call script.
    const fixed = f.email1;
    const refLine = f.refLine || facts.refLine;
    // A shared inbox is triaged by subject line, so the person's name goes up front.
    const subject = fixed ? fixed.subject
      : (f.generalInbox && person ? `Attn: ${person.name} — ` : '') + (own ? tpl.subject(f.company) : hook.subject(f.company));
    const ticked = D.attachments.filter(a => a.rule !== 'never' && (f.attachments || []).includes(a.id));
    // Standard pitch (v3.8): who we are + the hook in one paragraph, then the "good fit" list
    // built from the agreed strengths (Strategy > Proof points; wording in D.facts).
    const standardPitch = () => [
      `I'm ${me} from ${facts.company.replace(/ Ltd$/, '')}, a supplement manufacturer based in Auckland, Auckland. ${hook.emailHook(f.company, f.note, ctx)}`,
      `Why we think we could be a good fit:\n` + fitPoints(products, sameFormats, refLine, f.vegeCaps).map(x => '- ' + x).join('\n'),
      `We're happy to work under NDA and share COAs and batch records so you can evaluate us directly, with no need to tell us anything about your current arrangements.`
    ];
    const pitch = typeof tpl.pitch === 'function' ? tpl.pitch(c) : standardPitch();
    const body = fixed ? fixed.body.replace(/\{me\}/g, me) + '\n\n' + signature : [
      greeting,
      own ? tpl.opening(c) : '',
      ...pitch,
      ticked.length ? `I've attached our ${joinList(ticked.map(a => a.phrase))} for a quick overview.` : '',
      (own ? tpl.cta : hook.cta) || DEFAULT_CTA,
      closing,
      signature
    ].filter(Boolean).join('\n\n');

    // Emails 2-4: replies in the same thread, so the subject stays "Re: <email 1>".
    const re = 'Re: ' + subject;
    const passTo = person ? person.name : 'whoever looks after manufacturing and supply';
    const startSmall = f.productStatus === 'new'
      ? 'we can start from a full formula, a few key ingredients or just a concept'
      : 'most partnerships with us start small — a single SKU, as a second source';
    const fuFormats = joinList(products.flatMap(p => FIT_FORMATS[p] || []).map(n => f.vegeCaps && n === 'hard capsules' ? 'hard capsules (including vegetable capsules)' : n));
    const tasteMatters = products.some(p => p === 'p_powder' || p === 'p_liquid');
    // f.email2 = the company's approved email 2 (draft.email2), used as written like email 1.
    const steps = {
      fu1: { subject: re, body: f.email2 ? f.email2.body.replace(/\{me\}/g, me) + '\n\n' + signature : [
        greeting,
        `Just bringing my note below back to the top of your inbox${!f.generalInbox ? '' : person ? ` — and if someone else on your team looks after manufacturing and supply, it would be great if this could reach them` : ` — and if it could reach ${passTo}, that would be much appreciated`}.`,
        `In short: we're a GMP-certified manufacturer in Auckland making ${fuFormats}${skus ? `, the same formats as your ${skus}` : ''}. ${startSmall.charAt(0).toUpperCase() + startSmall.slice(1)}. If a call isn't convenient, I'm happy to answer two or three questions by email instead.`,
        OPT_OUT,
        signature
      ].join('\n\n') },
      fu2: { subject: re, body: [
        greeting,
        `A quick follow-up with the things brands usually ask us first:`,
        [`- **Speed:** ${facts.quote}, and ${facts.leadTime}.`,
          `- **Flexibility:** we can work from a full formula, a few key ingredients or just a concept, and agree target volumes to fit your situation.`,
          `- **Range:** hard capsules (including liquid-filled), tablets, softgels, powders and liquids, with premium packaging such as alu-alu blisters and in-house packaging design.`,
          tasteMatters ? `- **Taste:** for powders and liquids, taste is where products win or lose — it's where our brand partners give us some of our best feedback, and we're happy to send samples.` : '',
          `- **Proof:** we manufacture for ${facts.brands}; under NDA we'll share COAs and batch records, show you products we've made, and you're welcome to visit our factory.`].filter(Boolean).join('\n'),
        f.generalInbox ? `If someone else ${person ? 'on your team ' : ''}looks after manufacturing and supply, I'd be grateful if you could pass this on.` : '',
        `Would a 15-minute call in the next couple of weeks be useful?`,
        OPT_OUT,
        signature
      ].filter(Boolean).join('\n\n') },
      breakup: { subject: re, body: [
        greeting,
        `I haven't heard back, so I'll assume the timing isn't right and won't follow up again.`,
        `If anything changes — a new SKU, a supply hiccup, or a product you'd like made in New Zealand — I'd be glad to help. ${s.phone ? `You can reach me directly on ${s.phone}.` : 'Just reply to this email any time.'}`,
        `All the best,\n${s.name}\n${s.title} | ${facts.company}\n${facts.site}`
      ].join('\n\n') }
    };

    // LinkedIn connection note: optional, after email and call (LinkedIn caps it at 300 characters).
    const linkedin = person
      ? `Hi ${person.first}, I'm ${me} from Demo Labs — a GMP-certified supplement manufacturer in Auckland. I emailed ${f.company || 'your team'} recently about manufacturing support. Happy to connect in case it's useful down the track.`
      : '';

    // Call script -- a warm call: it comes after two emails (Strategy > Cold-call method).
    const askFor = person ? person.name + (person.title ? ` (${person.title})` : '') : 'whoever looks after manufacturing or supply';
    const C = (D.strategy && D.strategy.call) || {};
    const fill = t => String(t || '').replace(/\{name\}/g, person ? person.first : '[Name]').replace(/\{sender\}/g, me)
      .replace(/\{company\}/g, f.company || 'your team').replace(/\{phone\}/g, s.phone || '[your number]');
    const call = [
      `To: ${f.contact || '[Name]'}${f.phone ? ' — ' + f.phone + (f.generalLine ? ' (main line / reception)' : '') : ' — [no phone confirmed, see contact channels]'}`,
      f.generalLine ? `RECEPTION (10 sec)\n"Hi, this is ${me.split(/\s+/)[0]} from Demo Labs — we're a supplement manufacturer in Auckland. Could I please speak with ${askFor}?"\nIf asked what it's about: "I'm following up an email I sent last week — we'd like to be considered as a second manufacturing source. If it's easier, I'm happy to email instead. Who should I address it to?"` : '',
      `OPENING (15 sec)\n"Hi ${person ? person.first : '[Name]'}, this is ${me} calling from ${facts.company} — we're a New Zealand-based supplement manufacturer in Auckland, Auckland. I sent you a short email last week. ${callHook} Do you have a couple of minutes?"`,
      C.questions && C.questions.length ? `DISCOVERY (ask 2–3, then listen)\n${C.questions.map(q => '- ' + q).join('\n')}` : '',
      `KEY TALKING POINTS\n- NZ-based (Auckland, Auckland), ${facts.certs}.\n- Manufacturing capability: ${productList}${sameFormats}.\n- We manufacture for ${facts.brands}, ${refLine}.\n- Turnaround: ${facts.quote}; ${facts.leadTime}.\n- Everything under NDA — happy to share COA and batch data once that's in place.`,
      `LIKELY OBJECTION -> RESPONSE\n${hook.objection}`,
      ...((C.objections || []).filter(o => /TGA/.test(o[0])).map(o => `If asked "${o[0]}" -> "${o[1]}"`)),
      `Fallback: "Send me something in writing." -> "Of course — I'll follow up by email right after this call with our profile and certifications so you have it on hand."`,
      `CLOSE / NEXT STEP\n"Would it make sense to set up a short call with your ${f.productStatus === 'new' ? 'product development' : 'sourcing or operations'} team, or should I send our profile over first and follow up in a couple of weeks?"`,
      C.voicemail ? `VOICEMAIL (20 sec)\n"${fill(C.voicemail)}"` : ''
    ].filter(Boolean).join('\n\n');

    // Warnings shown next to the draft -- never part of the copied text.
    const warnings = [];
    if (fixed) warnings.push(['info', `Email 1 is the approved draft for ${f.company || 'this company'} (${fixed.ver}), used as written — the form fields don't change it. Follow-ups, the call script and the LinkedIn note are still built from the form.`]);
    if (f.email2) warnings.push(['info', `Email 2 is the written draft for ${f.company || 'this company'} (${f.email2.ver}), used as written — the form fields don't change it.`]);
    if (f.mfgSetup === 'own') warnings.push(['warn', 'Flagged as having its own factory / in-house GMP — conversion odds are low. Treat it as an overflow-capacity conversation or deprioritise it.']);
    if (!f.email) warnings.push(['warn', 'No send-to email yet — add one in "Send-to email". Email is the first channel: use a published address only, never a guessed one.']);
    if (f.generalInbox) warnings.push(['info', person
      ? `Goes to a shared inbox, so the subject starts "Attn: ${person.name}" and the email asks them to pass it on.`
      : 'Goes to a shared inbox with no named contact, so the email asks them to pass it to the right person.']);
    return { to: f.email, subject, body, steps, linkedin, call, warnings, lang: 'en' };
  }

  // Korean templates: the same sequence, call script and LinkedIn note, written in Korean.
  // adLabel templates go to recipients in Korea: "(ad)" leads every subject and every email
  // carries a 수신거부 line and the company address (정보통신망법 제50조).
  function composeKo(f, tpl) {
    const s = f.sender || D.defaultSender;
    const me = introName(s.name);
    const facts = D.facts;
    const person = splitContact(f.contact);
    const products = f.products && f.products.length ? f.products : ['p_hardcap'];
    const productList = products.map(p => PRODUCTS[p][2]).join('·');
    const skus = String(f.skus || '').split(',').map(x => x.trim()).filter(Boolean).join(', ');
    const honor = person ? person.name + (/CEO|Founder|Owner|Managing Director|\bMD\b|President/i.test(person.title) ? ' ' : '') : '';
    const c = { company: f.company, person, productList, skus, sender: s, facts, generalInbox: !!f.generalInbox };
    const named = !f.generalInbox && person;
    const greeting = named ? `${honor}, hello.` : `${f.company ? f.company + ' ' : ''}To the person in charge,`;
    const passTo = person ? `${honor}` : 'To the manufacturing / supply contact';
    const routing = f.generalInbox ? `${passTo} Please pass this on. Thank you.` : '';
    const hello = `${named ? '' : 'Hello. '}This is ${me}at Demo Labs, a health supplement manufacturer in Auckland, New Zealand.`;
    const ad = tpl.adLabel ? '(ad) ' : '';
    const attn = f.generalInbox && person ? `[${honor} ] ` : '';
    const subject = ad + attn + tpl.subject(f.company);
    const ticked = D.attachments.filter(a => a.rule !== 'never' && (f.attachments || []).includes(a.id));
    const optOut = tpl.adLabel
      ? `[Unsubscribe] If you don’t want these emails, just reply with "unsubscribe"and we’ll stop at once and not contact you again.
[Unsubscribe] If you do not wish to receive these emails, reply "Unsubscribe" and we will stop immediately.`
      : `If this isn’t relevant, let us know by reply and we won’t contact you again.`;
    const signature = ['Thank you.', `${s.name} `, `${s.title ? s.title + ' | ' : ''}Demo Labs (${facts.company})`,
      tpl.adLabel ? '44 Westpoint Drive, Auckland, Auckland 0618, New Zealand' : '', `T. ${s.phone}`, facts.site].filter(Boolean).join('\n');
    const points = (D.koPoints || []).map(x => '- ' + x).join('\n');
    // A template with its own pitch (ko_importer, v3.13) follows the harbourleaf email: the
    // formats line names their products, and the pass-it-on request moves to the end.
    const own = typeof tpl.pitch === 'function';
    c.formatLine = `${productList}${products.includes('p_hardcap') ? '(incl. liquid-filled capsules)' : ''} — the same dosage form as the ${skus ? skus + josa(skus, 'and', 'and') : 'products'} you import now.`;
    const pitch = own ? tpl.pitch(c) : [];
    const body = [
      greeting,
      own ? '' : routing,
      own ? hello + ' ' + pitch[0] : hello,
      ...(own ? pitch.slice(1) : [
        ...tpl.intro(c),
        `What the brands we work with usually look at:\n${points}`,
        'Under an NDA we can show COA samples and products we have made (liquid hard capsules, etc.).'
      ]),
      ticked.length ? `Company profile (${ticked.map(a => a.phraseKo || a.phrase).join(', ')}) attached.` : '',
      tpl.cta,
      own && f.generalInbox ? 'If someone else handles manufacturing and supply, please pass this on.' : '',
      optOut,
      signature
    ].filter(Boolean).join('\n\n');

    const re = ad + 'RE: ' + attn + tpl.subject(f.company);
    const tasteMatters = products.some(p => p === 'p_powder' || p === 'p_liquid');
    const steps = {
      fu1: { subject: re, body: [
        greeting,
        `Bringing my last email back to the top${f.generalInbox ? ` — ${passTo} I’d be grateful if you could pass it on` : ''}.`,
        `We are a GMP-certified manufacturer in Auckland making ${productList}${josa(productList, '', '')} , and we usually start small with one product. If a call is hard, send two or three questions by email and we’ll answer straight away.`,
        optOut,
        signature
      ].join('\n\n') },
      fu2: { subject: re, body: [
        greeting,
        'The questions brand owners ask us first:',
        ['- Lead time: made in our own factory in New Zealand, with no wait for overseas freight.',
          '- Flexibility: start from a finished formula, key ingredients or just a concept; production quantities agreed to suit you.',
          '- Forms and packaging: hard capsules (incl. liquid-filled), tablets, softgels, powders, liquids, and premium packaging such as alu-alu blisters.',
          tasteMatters ? '- Taste: taste matters for powders and liquids, and it is something our clients rate highly. We can send samples.' : '',
          '- Proof: under an NDA we share COA samples and batch records and show products we have made. Factory visits are welcome.'].filter(Boolean).join('\n'),
        f.generalInbox ? `If someone else handles manufacturing and supply, ${passTo} please pass this on.` : '',
        'Could we have a 15-minute call in the next two weeks?',
        optOut,
        signature
      ].filter(Boolean).join('\n\n') },
      breakup: { subject: re, body: [
        greeting,
        'As we haven’t heard back, I’ll take it that the timing isn’t right and won’t contact you again.',
        `If you ever need a New Zealand manufacturer for a new product or a supply problem, please get in touch any time.${s.phone ? ` Direct: ${s.phone}` : ''}`,
        tpl.adLabel ? optOut : '',
        signature
      ].filter(Boolean).join('\n\n') }
    };

    const linkedin = person
      ? `${person.name}, hello. This is ${me}at Demo Labs, a health supplement manufacturer in Auckland. Recently ${f.company || 'your company'} I emailed, and I’m asking to connect as I think we could help in future.`
      : '';

    const askFor = person ? honor : 'the manufacturing / supply contact';
    const call = [
      `To: ${f.contact || '[contact]'}${f.phone ? ' — ' + f.phone + (f.generalLine ? ' (main line)' : '') : ' — [no confirmed phone number, see contacts]'}`,
      f.generalLine ? `Reception (10 s)\n"Hello, this is ${me}from Demo Labs. We make health supplements in Auckland — ${askFor}${josa(askFor, 'and', 'and')} could I speak with them?"\nIf asked what it’s about: "It’s about the email I sent last week. Email is fine too — who should I send it to?"` : '',
      `Opening (15 s)\n"Hello${person ? ' ' + honor : ''}, this is ${me}from Demo Labs. I emailed last week and wanted to introduce us as a manufacturer based in New Zealand. Do you have two minutes?"`,
      'Questions (only 2–3, mostly listening)\n- Do you manufacture with one company or several?\n- For your best sellers, how long does it usually take from order to delivery?\n- Any new products or relaunches planned in the next 6–12 months?\n- If you trialled a new manufacturer, what would you want to check first?',
      `Key points\n${points}`,
      'Likely objections → answers\n"We’re happy with our current manufacturer." → "That’s fine. Not a switch — keeping one product with a second manufacturer helps when timing gets tight."\n"Do you have TGA?" → "No TGA. So Australian listed medicines (AUST L) aren’t a fit; our strengths are NZ supplements, products for export to Korea and Asia, and food-type products such as powders."\n"What’s your MOQ?" → "Tell us the product and the quantity you have in mind and we’ll work it out to suit you."',
      'Close\n"Can we book a 15-minute meeting, or shall I send material first and call again in two weeks?"',
      `Voicemail (20 s)\n"Hello${person ? ' ' + honor : ''}, this is ${me}. Last week I ${f.company || 'your company'} sent an email. I’ll follow up by email, and ${s.phone || '[phone number]'}is also fine to call. Thank you."`
    ].filter(Boolean).join('\n\n');

    const warnings = [];
    if (f.mfgSetup === 'own') warnings.push(['warn', 'Flagged as having its own factory / in-house GMP — conversion odds are low. Treat it as an overflow-capacity conversation or deprioritise it.']);
    if (!f.email) warnings.push(['warn', tpl.adLabel
      ? 'No send-to email yet — open the importer\'s contact page (Companies › Korean importers, or the Tracker) and copy the address in by hand. Addresses are never stored here (Korea’s Network Act §50-2).'
      : 'No send-to email yet — add one in "Send-to email". Email is the first channel: use a published address only, never a guessed one.']);
    if (tpl.adLabel) warnings.push(['warn', 'Recipient in Korea: Korea’s Network Act §50 asks for the recipient’s prior consent to advertising email, B2B included. The CEO decided on 27 Oct to contact the Go importers — calling first and asking "may I email you our profile?" gives both the address and the consent. The (ad) subject, opt-out lines and our address are already in.']);
    if (f.generalInbox) warnings.push(['info', person
      ? `Goes to a shared inbox, so the subject starts "[${honor} ]" and the email asks them to pass it on.`
      : 'Goes to a shared inbox with no named contact, so the email asks them to pass it to the right person.']);
    if (ticked.length) warnings.push(['info', 'Korean email: attach the Korean company profile (260408_Demo Labs_Company profile_Final_KR.pdf in Outreach Toolkit / Related information) instead of the English one where you can.']);
    return { to: f.email, subject, body, steps, linkedin, call, warnings, lang: 'ko' };
  }

  // Which attachments are ticked, with the reason shown for each.
  function attachmentState(size, productStatus) {
    return D.attachments.map(a => {
      let checked, tag, reason = a.reason;
      if (a.rule === 'always') { checked = true; tag = ['ok', 'Recommended']; }
      else if (a.rule === 'never') { checked = false; tag = ['bad', 'Do not send']; }
      else if (a.rule === 'optional') { checked = false; tag = ['warn', 'Optional']; }
      else {
        checked = productStatus === 'new';
        tag = checked ? ['ok', 'Relevant later'] : ['warn', a.id === 'pdr' ? 'Not needed' : 'Not yet'];
        if (!checked) reason = size === 'large' ? a.reasonNo.large : a.reasonNo.other;
      }
      if (a.rule !== 'never' && Object.prototype.hasOwnProperty.call(state.attachTicks, a.id)) checked = state.attachTicks[a.id];
      return { ...a, checked, tag, reason };
    });
  }

  // Research formats a target is pitched on should also appear on its screening row; every
  // target needs an email route that matches its preset and exactly one Top picks row.
  function checkData() {
    const issues = [];
    D.targets.forEach(t => {
      const r = t.emailRoute;
      if (!r || !r.to) issues.push(`${t.name}: no emailRoute`);
      else if (r.to !== t.draft.email) issues.push(`${t.name}: emailRoute.to (${r.to}) differs from draft.email (${t.draft.email})`);
      const m = D.market.find(row => row.key === t.key);
      if (!m) { issues.push(`${t.name}: no market screening row`); return; }
      const missing = t.formats.filter(f => !(m.formatTags || []).includes(f));
      if (missing.length) issues.push(`${t.name}: research formats ${missing.join(', ')} not on market row "${m.name}" (${(m.formatTags || []).join(', ')})`);
    });
    const S = D.strategy;
    if (S) {
      const seen = {};
      S.picks.forEach(p => p.keys.forEach(k => {
        if (!target(k)) issues.push(`strategy.picks: unknown target "${k}"`);
        seen[k] = (seen[k] || 0) + 1;
      }));
      D.targets.forEach(t => { if (seen[t.key] !== 1) issues.push(`strategy.picks: ${t.name} listed ${seen[t.key] || 0} times`); });
      S.picks.forEach(p => S.criteria.forEach(c => {
        const v = p.s[c.id] == null && c.bonus ? 0 : p.s[c.id];
        const max = c.max == null ? 3 : c.max;
        if (!(v >= 0 && v <= max)) issues.push(`strategy.picks ${p.keys.join('+')}: ${c.id} score ${v} is not 0-${max}`);
        if (c.bonus && v > 0 && !p.asiaBasis) issues.push(`strategy.picks ${p.keys.join('+')}: ${c.id} bonus without asiaBasis`);
      }));
    }
    D.targets.forEach(t => {
      if (t.draft.template && !(D.templates || {})[t.draft.template]) issues.push(`${t.name}: unknown template "${t.draft.template}"`);
    });
    return issues;
  }

  // Top picks with their totals, ordered by wave then score (ties: email reach first).
  const score = (p, c) => p.s[c.id] || 0;
  function scoredPicks() {
    const S = D.strategy;
    return S.picks.map(p => ({ ...p, total: S.criteria.reduce((n, c) => n + score(p, c), 0) }))
      .sort((a, b) => a.wave - b.wave || b.total - a.total || b.s.email - a.s.email);
  }

  // ---------- shell ----------
  function mount(el) {
    D = window.OUTREACH_DATA;
    root = el;
    if (!D) { el.innerHTML = '<div class="empty">Outreach data did not load — refresh and try again.</div>'; return; }
    state.mx = mxDefaultFilters();
    el.classList.add('or');
    el.innerHTML = `
      <div class="or-head">
        <div>
          <div class="or-eyebrow">Project WhaleHunting</div>
          <h2 class="or-title">Outreach toolkit</h2>
          <div class="or-sub">Track every prospect and its next step, research by list (NZ brands, Korean importers, needs a contact), draft the email-first sequence, and the playbook we agreed — with the market screening behind it.</div>
        </div>
        <div class="seg" id="or-views">
          <button type="button" data-or-view="tracker"><span class="icon icon--inline">checklist</span>Tracker</button>
          <button type="button" data-or-view="research"><span class="icon icon--inline">domain</span>Companies</button>
          <button type="button" data-or-view="generator"><span class="icon icon--inline">edit_note</span>Draft generator</button>
          <button type="button" data-or-view="strategy"><span class="icon icon--inline">menu_book</span>Playbook</button>
        </div>
      </div>
      <section class="or-view" data-or-pane="tracker"></section>
      <section class="or-view" data-or-pane="strategy"></section>
      <section class="or-view" data-or-pane="research"></section>
      <section class="or-view" data-or-pane="generator"></section>
      <section class="or-view" data-or-pane="market"></section>`;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    renderTracker();
    loadTracker();
    renderStrategy();
    renderResearch();
    renderGenerator();
    renderMarket();
    showView(state.view);
    checkData().forEach(i => console.warn('[outreach data]', i));
    api.mounted = true;
  }

  function showView(view) {
    state.view = view;
    $$('[data-or-view]').forEach(b => b.classList.toggle('active', b.dataset.orView === view));
    $$('[data-or-pane]').forEach(p => p.classList.toggle('active', p.dataset.orPane === view));
  }

  // Research age per company: targets[].checkedAt (re-checked on the web) or the original
  // research date D.researchAsOf. Older than STALE_DAYS -> a note in Companies and a warning
  // when that company is loaded in the Draft generator.
  const ageDays = d => Math.floor((Date.now() - new Date(d + 'T00:00:00').getTime()) / 864e5);
  const researchDate = t => t.checkedAt || D.researchAsOf;
  function staleNote() {
    const old = D.targets.filter(t => ageDays(researchDate(t)) > STALE_DAYS);
    if (!old.length) return '';
    const fresh = D.targets.filter(t => t.checkedAt && ageDays(t.checkedAt) <= STALE_DAYS);
    return `<div class="or-note or-note--warn"><span class="icon icon--inline">schedule</span>${old.length} of ${D.targets.length} companies still rely on research from ${esc(D.researchAsOf)} (over ${STALE_DAYS} days old) — re-check names, titles and leadership on their site before contacting them.${fresh.length ? ` Re-checked in the last ${STALE_DAYS} days: ${fresh.map(t => `${esc(t.name)} (${esc(t.checkedAt.slice(5))})`).join(', ')}.` : ''}</div>`;
  }

  function groupSeg(kind, current, list) {
    const n = g => g === 'all' ? list.length : list.filter(t => formatGroup(t) === g).length;
    const label = { all: 'All', capsule: 'Capsule / tablet', powder: 'Powder / sachet' };
    return `<div class="seg seg--sm">${['all', 'capsule', 'powder'].map(g =>
      `<button type="button" class="${g === current ? 'active' : ''}" data-or-${kind}="${g}">${label[g]} (${n(g)})</button>`).join('')}</div>`;
  }
  const toneTag = t => `<span class="or-tone or-tone--${esc(t.tone)}">${t.label}</span>`;
  const badge = (tone, text) => `<span class="or-tone or-tone--${tone}">${text}</span>`;

  // ---------- Strategy ----------
  // Text in D.strategy is trusted HTML from the repo (like the research text).
  const STRAT_TOC = [['position', 'Where we play'], ['strengths', 'Why us'], ['gaps', 'Gaps'], ['icp', 'Who we contact'],
    ['sequence', 'Email-first sequence'], ['templates', 'Email templates'], ['call', 'Cold-call method'], ['decisions', 'Decisions']];
  const DECISION_TAG = { agreed: ['ok', 'Agreed'], partial: ['info', 'Partly agreed'], open: ['warn', 'Open'] };
  const decisionStatus = d => d.status || (d.decision ? 'agreed' : 'open');
  const STRENGTH_TAG = { ok: ['ok', 'Ready to use'], num: ['warn', 'Needs a number'], check: ['info', 'Check before use'] };
  let stratCopy = [];
  const copyBtn = text => { stratCopy.push(text); return `<button type="button" class="btn btn--sm btn--ghost" data-or-scopy="${stratCopy.length - 1}">Copy</button>`; };
  const stratCard = (id, title, sub, inner) => `<section class="or-card or-strat" id="or-s-${id}">
      <h3 class="or-card__title">${title}${sub ? ` <span class="or-muted">— ${sub}</span>` : ''}</h3>${inner}</section>`;

  function renderStrategy() {
    const S = D.strategy;
    const pane = $('[data-or-pane="strategy"]');
    if (!S) { pane.innerHTML = '<div class="empty">No strategy in outreach_data.js yet.</div>'; return; }
    stratCopy = [];
    const open = S.decisions.filter(d => decisionStatus(d) === 'open').length;
    const partial = S.decisions.filter(d => decisionStatus(d) === 'partial').length;
    const picks = scoredPicks();
    const emails = S.sequence.filter(st => /^Email/.test(st.channel)).length;
    pane.innerHTML = `
      <div class="or-card or-hero">
        <div class="or-hero__top">
          ${open + partial ? badge('warn', `${open} open · ${partial} partly agreed`) : badge('ok', 'Agreed')}
          <span class="or-small">Updated ${esc(S.asOf)} · for the CEO and the sales team</span>
        </div>
        <h3 class="or-hero__title">${S.title}</h3>
        <p class="or-prose">${S.thesisHtml}</p>
        <div class="or-kpis">
          <div class="or-kpi"><span>First channel</span><b>Email</b></div>
          <div class="or-kpi"><span>Wave 1</span><b>${picks.filter(p => p.wave === 1).length} companies</b></div>
          <div class="or-kpi"><span>Emails per company</span><b>max ${emails}</b></div>
          <div class="or-kpi"><span>Open decisions</span><b>${open}${partial ? ` <span class="or-small">+ ${partial} partly</span>` : ''}</b></div>
        </div>
        <div class="or-note">${S.statusHtml}</div>
        <nav class="or-toc">${STRAT_TOC.map(([id, label]) => `<button type="button" data-or-jump="${id}">${label}</button>`).join('')}
          <button type="button" data-or-view="market"><span class="icon icon--inline">filter_alt</span>Market screening ›</button></nav>
      </div>
      ${positionCard(S)}${strengthsCard(S)}${gapsCard(S)}${icpCard(S)}${sequenceCard(S)}${templatesCard()}${callCard(S)}${decisionsCard(S)}`;
  }

  function positionCard(S) {
    const P = S.position;
    return stratCard('position', 'Where we play', 'Positioning', `
      <div class="table-wrap"><table class="or-table or-pos">
        <thead><tr><th></th>${P.cols.map((c, i) => `<th class="${i === 1 ? 'or-mid' : ''}">${c}</th>`).join('')}</tr></thead>
        <tbody>${P.rows.map(r => `<tr><th scope="row">${r[0]}</th>${r.slice(1).map((c, i) => `<td class="${i === 1 ? 'or-mid' : 'or-muted'}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div class="or-small or-strat__foot">${P.note}</div>`);
  }

  function strengthsCard(S) {
    return stratCard('strengths', 'Why us — proof points', 'Strengths and evidence. The English lines can be used as they are in emails and calls', `
      <div class="table-wrap"><table class="or-table">
        <thead><tr><th>Strength</th><th>What we say (English)</th><th>Proof</th><th>Status</th></tr></thead>
        <tbody>${S.strengths.map(x => {
          const tag = STRENGTH_TAG[x.status] || STRENGTH_TAG.check;
          return `<tr>
            <td><b>${x.title}</b></td>
            <td class="or-say">“${esc(x.say)}”</td>
            <td>${x.proof}</td>
            <td>${badge(tag[0], tag[1])}${x.todo ? `<div class="or-small">${x.todo}</div>` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`);
  }

  function gapsCard(S) {
    return stratCard('gaps', 'Gaps &amp; how we answer', 'Say the weaknesses first instead of hiding them', `
      <div class="or-gaps">${S.gaps.map(g => `<div class="or-gapitem">
        <div class="or-gapitem__title">${g.title}</div>
        <div class="or-small"><b>Impact</b> · ${g.impact}</div>
        <div class="or-gapitem__answer"><b>How we answer</b> · ${g.answer}</div>
        ${g.script ? `<div class="or-quote"><span>“${esc(g.script)}”</span>${copyBtn(g.script)}</div>` : ''}
      </div>`).join('')}</div>`);
  }

  function icpCard(S) {
    const I = S.icp;
    return stratCard('icp', 'Who we contact', 'Customer types (ICP)', `
      <div class="or-icp">
        <div class="or-icp__fit">${I.fit.map(f => `<div class="or-tier">
          <span class="or-tier__badge or-tier__badge--${esc(f.tier[0])}">${f.tier}</span>
          <div><div class="or-tier__title">${f.title}</div>
            <div class="or-small">${f.who}</div>
            <div class="or-tier__why">${f.why}</div>
            <div class="or-small"><b>e.g.</b> ${f.eg}</div></div>
        </div>`).join('')}</div>
        <div class="or-icp__side">
          <h4 class="or-subhead">Avoid</h4>
          <ul class="or-avoid">${I.avoid.map(a => `<li><b>${a[0]}</b><span class="or-small">${a[1]}</span></li>`).join('')}</ul>
          <h4 class="or-subhead">Next research pool</h4>
          <ul class="or-approach">${I.nextPool.map(x => `<li>${x}</li>`).join('')}</ul>
        </div>
      </div>`);
  }

  function picksCard(S, picks) {
    const crit = S.criteria;
    const max = crit.filter(c => !c.bonus).reduce((n, c) => n + (c.max == null ? 3 : c.max), 0);
    let wave = null, n = 0;
    const rows = picks.map(p => {
      const t = target(p.keys[0]);
      const r = t.emailRoute || {};
      const tpl = (D.templates || {})[t.draft.template || 'standard'];
      const head = p.wave !== wave ? `<tr class="or-wave"><td colspan="${crit.length + 5}">${badge(p.wave === 1 ? 'ok' : p.wave === 2 ? 'info' : 'neutral', 'Wave ' + p.wave)} ${S.waves[p.wave] || ''}</td></tr>` : '';
      wave = p.wave;
      n++;
      const cell = c => {
        const v = score(p, c);
        if (c.bonus) return `<td class="or-scorecell">${v ? `<span class="or-tone or-tone--info" title="${esc(p.asiaBasis || '')}">+${v}</span>` : '<span class="or-muted">—</span>'}</td>`;
        return `<td class="or-scorecell"><span class="or-score or-score--${v}">${v}</span></td>`;
      };
      return head + `<tr class="${p.wave === 1 ? 'or-rec' : ''}">
        <td class="or-num">${pad(n)}</td>
        <td class="or-pickco"><button type="button" class="or-link" data-or-goto="${esc(t.key)}">${p.label || t.name}</button>
          ${t.crm ? `<div>${badge('warn', 'Past Demo Labs customer')}</div>` : ''}
          <div class="or-pickmail"><span class="icon icon--inline">mail</span>${esc(r.to || '—')}</div>
          ${r.attn ? `<div class="or-small">Attn ${esc(r.attn.split(',')[0])}</div>` : ''}
          ${tpl && t.draft.template && t.draft.template !== 'standard' ? `<div class="or-small">Template: ${esc(tpl.label)}</div>` : ''}</td>
        ${crit.map(cell).join('')}
        <td class="or-scorecell"><b class="or-total">${p.total}</b><span class="or-small">/${max}</span></td>
        <td class="or-small">${p.note}${p.asiaBasis ? `<div class="or-muted">Asia +: ${p.asiaBasis}</div>` : ''}</td>
        <td><button type="button" class="btn btn--sm" data-or-draft="${esc(t.key)}"><span class="icon">edit_note</span>Draft</button></td>
      </tr>`;
    }).join('');
    return stratCard('picks', 'Top picks', `Scores are a proposal to agree on — 0–3 each, +1 bonus for Asian ownership (${picks.length}companies)`, `
      <div class="table-wrap"><table class="or-table or-picks">
        <thead><tr><th>#</th><th>Company · first email</th>${crit.map(c => `<th class="or-scorecell" title="${esc(c.help)}">${c.label}</th>`).join('')}<th class="or-scorecell">Total</th><th>Why</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="or-legend">${crit.map(c => `<span><b>${c.label}</b> ${c.help}</span>`).join('')}</div>`);
  }

  // Companies > Needs a contact: found in the pool search but not emailable yet.
  function backlogCard(S) {
    if (!S.backlog || !S.backlog.length) return '';
    return stratCard('backlog', 'Needs a contact', 'Found when widening the pool, but no public email or something to check first', `
      <div class="table-wrap"><table class="or-table">
        <thead><tr><th>Company</th><th>Why it fits</th><th>What is missing</th></tr></thead>
        <tbody>${S.backlog.map(b => `<tr>
          <td><b>${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${b.name} ↗</a>` : b.name}</b></td>
          <td>${b.why}</td>
          <td class="or-small">${b.need}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${S.excludedNote ? `<div class="or-small or-strat__foot">${S.excludedNote}</div>` : ''}`);
  }

  // Public company details on a Korean importer row (row.web). Never an email address -- the
  // address is read by a person on the contact page (정보통신망법 제50조의2).
  const krWeb = r => {
    const w = r.web;
    if (!w) return '';
    return `<div class="or-small or-krweb">${[w.site ? `<a href="${esc(w.site)}" target="_blank" rel="noopener">Website ↗</a>` : '',
      w.contact ? `<a href="${esc(w.contact)}" target="_blank" rel="noopener">Contact page ↗</a>` : '', w.phone ? esc(w.phone) : '',
      w.ceo ? 'CEO ' + esc(w.ceo) : '', w.brand ? 'Brands: ' + esc(w.brand) : '',
      w.match && w.match !== 'high' ? `match: ${esc(w.match)}` : ''].filter(Boolean).join(' · ')}${w.note ? `<div>${esc(w.note)}</div>` : ''}</div>`;
  };

  // Korean importer filter: a contact = a phone number or a website found on a public source.
  const hasContact = r => !!(r.web && (r.web.phone || r.web.site));
  const KRF = [['all', 'All', () => true], ['contact', 'Contact found', hasContact], ['none', 'No contact yet', r => !!r.no && !hasContact(r)]];

  // Companies > Korean importers (A4): importer -> NZ manufacturer from MFDS import records.
  function importersCard(S) {
    const K = S.koImporters;
    if (!K) return '';
    const TIER = { A: ['ok', 'Target'], conflict: ['warn', 'Customer conflict'], B: ['neutral', 'Check'], skip: ['muted', 'Skip'] };
    const counts = K.rows.reduce((m, r) => (m[r.tier] = (m[r.tier] || 0) + 1, m), {});
    // CEO review of the numbered target rows (row.ceo = {v: go | check | pass, note, date}).
    const CEO = { go: ['ok', 'Go'], check: ['neutral', 'OK'], pass: ['muted', 'Pass'] };
    const ceoCounts = K.rows.reduce((m, r) => (r.ceo && (m[r.ceo.v] = (m[r.ceo.v] || 0) + 1), m), {});
    return stratCard('importers', 'Korean importers of NZ-made supplements', `A4 · traced back from Korean import records — ${esc(K.range)}, health functional food ${K.total}items`, `
      <div class="or-note or-note--warn">${K.law} <a href="${esc(K.lawSource)}" target="_blank" rel="noopener">KISA guide ↗</a></div>
      <div class="or-callmeta">
        <div><h4 class="or-subhead">How to refresh</h4><ol class="or-method__list">${K.method.map(m => `<li>${esc(m)}</li>`).join('')}</ol>
          <div class="or-small"><a href="${esc(K.source)}" target="_blank" rel="noopener">Korea imported food lookup ↗</a></div></div>
        <div><h4 class="or-subhead">NZ manufacturers in Korean imports</h4>
          <div class="or-badges">${K.competitors.map(c => badge(c.demolabs ? 'ok' : c.customer ? 'info' : 'neutral', `${esc(c.name)} · ${c.n}`)).join('')}</div>
          <div class="or-small">Green = Demo Labs, blue = a manufacturer that is also a Demo Labs customer. Importers already buying from Demo Labs (${K.houseBuyers.length}) left out of the list: ${K.houseBuyers.map(esc).join(', ')}</div></div>
      </div>
      <div class="or-badges">${Object.entries(TIER).map(([k, t]) => counts[k] ? badge(t[0], `${t[1]} ${counts[k]}`) : '').join('')}
        ${Object.entries(CEO).map(([k, t]) => ceoCounts[k] ? badge(t[0], ` ${t[1]} ${ceoCounts[k]}`) : '').join('')}</div>
      <div class="seg seg--sm or-krfilter">${KRF.map(([k, l, f]) =>
        `<button type="button" class="${state.krF === k ? 'active' : ''}" data-or-krf="${k}">${l} (${K.rows.filter(f).length})</button>`).join('')}</div>
      <div class="table-wrap"><table class="or-table">
        <thead><tr><th>#</th><th>Importer (Korea)</th><th>NZ manufacturer(s)</th><th>Products</th><th>Records</th><th>Last</th><th>Note</th><th>CEO review</th><th></th></tr></thead>
        <tbody>${K.rows.filter((KRF.find(x => x[0] === state.krF) || KRF[0])[2]).map(r => `<tr class="${r.tier === 'A' ? 'or-rec' : ''}">
          <td class="or-num">${r.no || ''}</td>
          <td><b>${esc(r.importer)}</b><div>${badge(TIER[r.tier][0], TIER[r.tier][1])}</div>${krWeb(r)}</td>
          <td class="or-small">${r.makers.map(m => `${esc(m.name)} ×${m.n}`).join('<br>')}</td>
          <td class="or-small">${r.products.map(esc).join(', ')}</td>
          <td class="or-num">${r.records}</td>
          <td class="or-small">${esc(r.last)}</td>
          <td class="or-small">${esc(r.note)}</td>
          <td class="or-small">${r.ceo ? `${badge(CEO[r.ceo.v][0], CEO[r.ceo.v][1])}<div>${esc(r.ceo.note)} (${esc(r.ceo.date.slice(5))})</div>` : ''}</td>
          <td>${r.ceo && r.ceo.v === 'go' ? `<button type="button" class="btn btn--sm btn--ghost" data-or-kr="${r.no}">Draft</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="or-small or-strat__foot">No contact details here — a person checks them on a public source (no automated collection). The ones the CEO marked Go (27 Oct: nos. 6–10) open "Draft"with "Korean importer" the template ((ad), opt-out and address included) — put the checked address in Send-to email; the dosage-form ticks are guessed from product names, so check them before sending.</div>`);
  }

  // Strategy > Email templates: when to use each one; "Use" opens the generator with it.
  function templatesCard() {
    const T = D.templates || {};
    return stratCard('templates', 'Email templates', 'First email by company type — the 4-email sequence and call script come out in the same language', `
      <div class="table-wrap"><table class="or-table">
        <thead><tr><th>Template</th><th>Language</th><th>When to use</th><th></th></tr></thead>
        <tbody>${Object.entries(T).map(([k, t]) => `<tr>
          <td><b>${esc(t.label)}</b></td>
          <td>${badge(t.lang === 'ko' ? 'info' : 'neutral', t.lang === 'ko' ? 'Korean' : 'English')}${t.adLabel ? ' ' + badge('warn', '(ad)') : ''}</td>
          <td>${esc(t.when || '')}</td>
          <td><button type="button" class="btn btn--sm btn--ghost" data-or-tpl="${esc(k)}">Use</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="or-small or-strat__foot">"Use"applies that template to the company now filled in the Draft generator. Company presets come with a suggested template.</div>`);
  }

  function sequenceCard(S) {
    const outLabel = { first: 'Open email 1', fu1: 'Open email 2', fu2: 'Open email 3', breakup: 'Open email 4', call: 'Open call script', linkedin: 'Open LinkedIn note' };
    return stratCard('sequence', 'Email-first sequence', 'email → email → email → call → (LinkedIn) → closing email', `
      <ol class="or-timeline">${S.sequence.map(st => `<li class="or-step${st.out ? '' : ' or-step--prep'}">
        <span class="or-step__day">${st.day}</span>
        <div class="or-step__main">
          <div class="or-step__head"><span class="icon icon--inline">${esc(st.icon)}</span><b>${st.channel}</b> · ${st.title}</div>
          <div class="or-small">${st.detail}</div>
        </div>
        ${st.out ? `<button type="button" class="btn btn--sm btn--ghost" data-or-seq="${esc(st.out)}">${outLabel[st.out] || 'Open'}</button>` : ''}
      </li>`).join('')}</ol>
      <h4 class="or-subhead">Rules</h4>
      <ul class="or-approach">${S.rules.map(x => `<li>${x}</li>`).join('')}</ul>
      <div class="or-small or-strat__foot">"Open" buttons open that step in the Draft generator. Pick a company preset first and it fills in for that company.</div>`);
  }

  function callCard(S) {
    const C = S.call;
    return stratCard('call', 'Cold-call method', 'The call after two emails — in order', `
      <div class="or-callmeta">
        <div><h4 class="or-subhead">When</h4><div class="or-prose">${C.when}</div></div>
        <div><h4 class="or-subhead">Before you dial</h4><div class="or-prose">${C.before}</div></div>
      </div>
      <h4 class="or-subhead">Call flow</h4>
      <div class="table-wrap"><table class="or-table">
        <thead><tr><th>#</th><th>Step</th><th>Time</th><th>What to do</th></tr></thead>
        <tbody>${C.steps.map((x, i) => `<tr><td class="or-num">${i + 1}</td><td><b>${x[0]}</b></td><td class="or-small">${x[1]}</td><td>${x[2]}</td></tr>`).join('')}</tbody>
      </table></div>
      <h4 class="or-subhead">Discovery questions</h4>
      <ul class="or-qs">${C.questions.map(q => `<li><span>“${esc(q)}”</span>${copyBtn(q)}</li>`).join('')}</ul>
      <h4 class="or-subhead">Voicemail (20 sec)</h4>
      ${(vm => `<div class="or-quote"><span>“${esc(vm)}”</span>${copyBtn(vm)}</div>`)(C.voicemail.replace(/\{(\w+)\}/g, (m, k) => `[${k[0].toUpperCase() + k.slice(1)}]`))}
      <div class="or-small">The call script in the Draft generator fills these in for the selected company.</div>
      <h4 class="or-subhead">Objections</h4>
      <div class="table-wrap"><table class="or-table">
        <thead><tr><th>They say</th><th>We say</th></tr></thead>
        <tbody>${C.objections.map(o => `<tr><td><b>“${esc(o[0])}”</b></td><td>${esc(o[1])}</td></tr>`).join('')}</tbody>
      </table></div>`);
  }

  function decisionsCard(S) {
    return stratCard('decisions', 'Decisions for the CEO &amp; sales team', 'To decide at the Wednesday meeting — fill in the Decision field once decided', `
      <div class="table-wrap"><table class="or-table or-decisions">
        <thead><tr><th>#</th><th>Topic</th><th>Proposal</th><th>Why</th><th>Decision</th></tr></thead>
        <tbody>${S.decisions.map((d, i) => {
          const st = decisionStatus(d), tag = DECISION_TAG[st] || DECISION_TAG.open;
          return `<tr class="or-dec--${st}">
          <td class="or-num">${i + 1}</td>
          <td><b>${d.topic}</b></td>
          <td>${d.proposal}</td>
          <td class="or-small">${d.why}</td>
          <td>${badge(tag[0], tag[1])}${d.decision ? `<div class="or-decision">${d.decision}</div>` : ''}</td>
        </tr>`;
        }).join('')}</tbody>
      </table></div>`);
  }

  function jumpTo(id) {
    const el = $('#or-s-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('or-flash');
    void el.offsetWidth;
    el.classList.add('or-flash');
  }

  // Strategy > sequence "Open" buttons: the matching step of the Draft generator.
  function openSequenceStep(out) {
    showView('generator');
    if (out === 'call' || out === 'linkedin') showOut(out);
    else { state.emailStep = out; showOut('email'); renderEmailStep(); }
    root.scrollTop = 0;
  }

  // ---------- Research & approach ----------
  // Companies: one list at a time -- NZ brands (Top picks + research), Korean importers, Needs a contact.
  function renderResearch() {
    const S = D.strategy || {}, pane = $('[data-or-pane="research"]');
    const n = { nz: (S.picks || []).length, kr: ((S.koImporters || {}).rows || []).filter(r => r.no).length, nc: (S.backlog || []).length };
    const seg = `<div class="seg" id="or-colists">${Object.entries(LISTS).map(([k, l]) =>
      `<button type="button" class="${state.coList === k ? 'active' : ''}" data-or-colist="${k}">${l} (${n[k]})</button>`).join('')}</div>`;
    if (state.coList === 'kr') { pane.innerHTML = seg + importersCard(S); return; }
    if (state.coList === 'nc') { pane.innerHTML = seg + backlogCard(S); return; }
    const all = ordered();
    const list = state.researchGroup === 'all' ? all : all.filter(t => formatGroup(t) === state.researchGroup);
    pane.innerHTML = seg + staleNote() + picksCard(S, scoredPicks()) + `
      <details class="or-card or-method">
        <summary><span class="icon icon--inline">info</span>How this list was built <span class="or-muted">— target selection · fact checking · purpose of the approach · risks · framing · order of work</span></summary>
        <ol class="or-method__list">${D.methodologyHtml}</ol>
      </details>
      <div class="or-note">${D.researchNoteHtml}</div>
      ${groupSeg('rgroup', state.researchGroup, all)}
      <div class="or-card">
        <h3 class="or-card__title">Executive summary</h3>
        <div class="table-wrap"><table class="or-table">
          <thead><tr><th>#</th><th>Company</th><th>Verified pain point</th><th>Email route (1st) · other channels</th><th>Opportunity &amp; how to raise it</th><th>Risk</th><th>Supplement revenue (est.)</th></tr></thead>
          <tbody>${list.map((t, i) => `<tr>
            <td class="or-num">${nzCode(t.key)}</td>
            <td><button type="button" class="or-link" data-or-goto="${esc(t.key)}">${t.name}</button></td>
            <td>${t.painPoint}</td>
            <td>${t.emailRoute ? `<div class="or-routeline"><a href="mailto:${esc(t.emailRoute.to)}">${esc(t.emailRoute.to)}</a></div>` : ''}${channelBadges(t)}<div class="or-small">${t.contactStatus}</div></td>
            <td>${toneTag(t.opportunity)}<div class="or-small">${t.opportunityTip}</div></td>
            <td>${toneTag(t.riskLevel)}</td>
            <td class="or-small">${t.revenueEstimate}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
      ${list.map(companyCard).join('')}
      <div class="or-card">
        <h3 class="or-card__title">Overall recommendation <span class="or-muted">— overall recommendation</span></h3>
        <div class="or-prose">${D.closingHtml}</div>
      </div>`;
  }

  // What we hold, in the order we use it: email first, then phone, LinkedIn last (optional).
  function channelBadges(t) {
    const r = t.emailRoute || {};
    const rec = t.contacts.find(c => c.recommended) || {};
    const gen = t.contacts.find(isGeneralContact) || {};
    const recGeneral = isGeneralContact(rec);
    const b = [];
    if (r.kind === 'direct') b.push(badge('ok', 'Direct email'));
    else if (r.to) b.push(r.unverified ? badge('warn', 'Shared inbox — not re-checked') : badge('neutral', 'Shared inbox'));
    else b.push(badge('bad', 'No email'));
    if (rec.phone && !recGeneral) b.push(badge('ok', 'Direct phone'));
    else if (gen.phone || rec.phone) b.push(badge('neutral', 'Main line'));
    if (rec.linkedin) b.push(badge('neutral', 'LinkedIn'));
    return `<div class="or-badges">${b.join('')}</div>`;
  }

  // The first channel for a target: the published address, who it's for and why.
  function emailRouteBox(t) {
    const r = t.emailRoute;
    if (!r) return `<div class="or-route or-route--warn"><span class="icon icon--inline">mail</span>No published email address yet — find one before this company enters the sequence.</div>`;
    return `<div class="or-route${r.unverified ? ' or-route--warn' : ''}">
      <div class="or-route__head"><span class="icon icon--inline">mail</span><b>Email route</b> <span class="or-muted">— first channel</span>
        ${r.kind === 'direct' ? badge('ok', 'Direct email') : badge('neutral', 'Shared inbox')}${r.unverified ? badge('warn', 'Not re-checked') : ''}</div>
      <div class="or-route__to"><a href="mailto:${esc(r.to)}">${esc(r.to)}</a>${r.attn ? `<span class="or-muted"> · Attn: ${esc(r.attn)}</span>` : ''}</div>
      <div class="or-small">${r.why}${r.sourceUrl ? ` <a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">Source ↗</a>` : ''}</div>
      ${r.escalate ? `<div class="or-small"><b>Email 3 escalation:</b> <a href="mailto:${esc(r.escalate)}">${esc(r.escalate)}</a></div>` : ''}
      ${(alt => alt.length ? `<div class="or-small"><b>Other addresses:</b> ${alt.map(a => `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a> — ${a.note}`).join(' · ')}</div>` : '')((r.alt || []).filter(a => a.email !== r.escalate))}
    </div>`;
  }

  function sources(list) {
    if (!list || !list.length) return '';
    return `<details class="or-src"><summary>Sources (${list.length})</summary><ul>${list.map(s => s.url
      ? `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${s.label} ↗</a></li>`
      : `<li class="or-muted">${s.label}</li>`).join('')}</ul></details>`;
  }
  function contactLinks(p) {
    const parts = [];
    if (p.email) parts.push(`<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`);
    if (p.phone) parts.push(esc(p.phone));
    if (p.linkedin) parts.push(`<a href="${esc(p.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>`);
    return parts.length ? parts.join('<br>') : '<span class="or-muted">—</span>';
  }
  // Recommended contact first, then anyone with a published email.
  const contactOrder = list => [...list].sort((a, b) => (b.recommended ? 2 : 0) + (b.email ? 1 : 0) - (a.recommended ? 2 : 0) - (a.email ? 1 : 0));
  const sourceText = p => p.sourceUrl ? `<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">${p.source} ↗</a>` : (p.source || '');

  function companyCard(t, i) {
    return `<article class="or-card or-company" id="or-co-${esc(t.key)}">
      <header class="or-company__head">
        <div>
          <h3 class="or-company__name">${t.name}</h3>
          <div class="or-small">${t.sub}</div>
          <div class="or-tags">${t.formats.map(f => `<span class="tag">${esc(FORMAT_EN[f] || f)}</span>`).join('')}</div>
        </div>
        <div class="or-company__side">
          ${(p => p ? `<span class="or-badges">${t.crm ? badge('warn', 'Past Demo Labs customer') : ''}${badge(p.wave === 1 ? 'ok' : p.wave === 2 ? 'info' : 'neutral', `Wave ${p.wave}`)}${badge('neutral', `Score ${p.total}`)}${score(p, { id: 'asia' }) ? badge('info', 'Asia +1') : ''}</span>` : '')(pickOf(t.key))}
          <span class="or-rank">${t.rank.replace(/^\d+/, nzCode(t.key))}</span>
          <button type="button" class="btn btn--sm btn--primary" data-or-draft="${esc(t.key)}"><span class="icon">edit_note</span>Draft outreach</button>
        </div>
      </header>
      ${t.todoNote ? `<div class="or-note or-note--warn">${t.todoNote}</div>` : ''}
      <h4 class="or-subhead">Key findings</h4>
      <ul class="or-findings">${t.findings.map(f => `<li>${f.text} ${sources(f.sources)}</li>`).join('')}</ul>
      <h4 class="or-subhead">Gaps &amp; risks</h4>
      <div class="or-gap">${t.gaps}</div>
      <h4 class="or-subhead">Contacts — email first</h4>
      ${emailRouteBox(t)}
      <div class="table-wrap"><table class="or-table">
        <thead><tr><th>Name</th><th>Title</th><th>Email / phone / LinkedIn</th><th>Source</th></tr></thead>
        <tbody>${contactOrder(t.contacts).map(p => `<tr class="${p.recommended ? 'or-rec' : ''}">
          <td>${p.name}${p.recommended ? ' <span class="tag tag--new">Recommended</span>' : ''}</td>
          <td>${p.title}</td>
          <td class="or-small">${contactLinks(p)}</td>
          <td class="or-small">${sourceText(p)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <h4 class="or-subhead">Why this contact</h4>
      <div class="or-prose or-muted">${t.reasoning}</div>
      <h4 class="or-subhead">Suggested approach</h4>
      <ul class="or-approach">${t.approach.map(a => `<li>${a}</li>`).join('')}</ul>
    </article>`;
  }

  function gotoCompany(key) {
    const t = target(key);
    if (!t) return;
    if (state.coList !== 'nz') { state.coList = 'nz'; renderResearch(); }
    if (state.researchGroup !== 'all' && formatGroup(t) !== state.researchGroup) { state.researchGroup = 'all'; renderResearch(); }
    showView('research');
    const card = $('#or-co-' + key);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.remove('or-flash');
    void card.offsetWidth;
    card.classList.add('or-flash');
  }

  // ---------- Draft generator ----------
  function renderGenerator() {
    const hookOpts = Object.entries(D.hooks).map(([k, h]) => `<option value="${k}">${esc(h.label)}</option>`).join('');
    $('[data-or-pane="generator"]').innerHTML = `
      <div class="or-gen">
        <div class="or-gen__left">
          <div class="or-card">
            <h3 class="or-card__title">Quick presets</h3>
            <div id="or-pgroup"></div>
            <div class="or-presets" id="or-presets"></div>
            <div class="or-small">Loads one of the ${D.targets.length} WhaleHunting targets with the recommended contact from the research. Everything stays editable.</div>
          </div>
          <div class="or-card or-internal" id="or-internal" hidden></div>
          <div class="or-card or-form">
            <h3 class="or-card__title">Company profile</h3>
            <label class="or-field"><span>Email template</span><select id="or-template">${Object.entries(D.templates || {}).map(([k, t]) =>
              `<option value="${k}">${esc(t.label)}</option>`).join('')}</select></label>
            <div class="or-small" id="or-tplnote"></div>
            <label class="or-field"><span>Company name</span><input type="text" id="or-company" placeholder="e.g. harbourleaf"></label>
            <label class="or-field"><span>Contact name &amp; title</span><input type="text" id="or-contact" placeholder="e.g. Jane Smith, Operations Manager"></label>
            <label class="or-field"><span>Send-to email</span><input type="text" id="or-email" placeholder="e.g. jane@company.com"></label>
            <div class="or-small" id="or-emailsrc"></div>
            <label class="or-check"><input type="checkbox" id="or-generalInbox">Shared inbox (info@, office@ …) — the email asks them to pass it on</label>
            <label class="or-field"><span>Call phone number</span><input type="text" id="or-phone" placeholder="e.g. +64 21 330 053"></label>
            <label class="or-check"><input type="checkbox" id="or-generalLine">Main line / reception — the call script starts by asking to be put through</label>
            <label class="or-field"><span>Current manufacturing setup</span><select id="or-mfgSetup">
              <option value="outsourced">Outsources to OEM already (no own factory)</option>
              <option value="own">Has own factory / in-house GMP</option>
              <option value="partial">Partial in-house, partial outsourced</option>
              <option value="unknown">Not sure</option>
            </select></label>
            <label class="or-field"><span>Primary hook / pain point</span><select id="or-hook">${hookOpts}</select></label>
            <div class="or-small or-hooknote" id="or-hooknote" hidden></div>
            <div class="or-small">Taking over an <em>existing</em> SKU (the usual case here) is decided by Procurement / Operations, who are risk-averse — frame it as "second source / pilot", not "replace your vendor". Use the new-product hook only for a genuinely new SKU with no vendor yet; NPD has no say over vendors already assigned.</div>
            <div class="or-field"><span>Target product types</span><div class="or-chips">${Object.entries(PRODUCTS).map(([id, p]) =>
              `<label class="chip"><input type="checkbox" id="or-${id}"${id === 'p_hardcap' ? ' checked' : ''}>${p[0]}</label>`).join('')}</div></div>
            <label class="or-field"><span>Their SKUs / ingredients (optional)</span><input type="text" id="or-skus" placeholder="e.g. NMN, Pine Bark Extract, Liver Support"></label>
            <div class="or-row2">
              <label class="or-field"><span>Company size</span><select id="or-size">
                <option value="large">Large / established (multi-store, listed …)</option>
                <option value="sme">SME / growing</option>
                <option value="unknown" selected>Not sure</option>
              </select></label>
              <label class="or-field"><span>Product status</span><select id="or-productStatus">
                <option value="existing">Has established SKUs / formulas</option>
                <option value="new">Needs formulation help / new concept</option>
                <option value="unknown" selected>Not sure</option>
              </select></label>
            </div>
            <label class="or-field"><span>Context note</span><textarea id="or-note" rows="3" placeholder="e.g. a recent launch or news mention"></textarea></label>
            <div class="or-small">Goes into the email only with the "Other" hook, as its opening line. Otherwise it's background for you.</div>
          </div>
          <details class="or-card or-sender">
            <summary><span class="icon icon--inline">badge</span>Signature: <b id="or-sendername"></b></summary>
            <label class="or-field"><span>Name</span><input type="text" id="or-sname"></label>
            <label class="or-field"><span>Title</span><input type="text" id="or-stitle"></label>
            <label class="or-field"><span>Phone</span><input type="text" id="or-sphone"></label>
            <div class="or-sender__foot"><span class="or-small">Saved in this browser only.</span><button type="button" class="btn btn--sm btn--ghost" data-or-sender-reset>Reset to ${esc(D.defaultSender.name)}</button></div>
          </details>
        </div>
        <div class="or-gen__right">
          <div id="or-warnings" class="or-stack"></div>
          <div class="or-card or-out">
            <div class="seg seg--sm" id="or-outtabs">
              <button type="button" data-or-out="email">Email sequence</button>
              <button type="button" data-or-out="call">Call script</button>
              <button type="button" data-or-out="linkedin">LinkedIn (optional)</button>
              <button type="button" data-or-out="attach">Attachments</button>
            </div>
            <div data-or-outpane="email">
              <div class="or-steps" id="or-steps">${EMAIL_STEPS.map(([id, n, day, label]) =>
                `<button type="button" data-or-step="${id}"><span class="or-steps__n">${n}</span><span><b>${day}</b> ${label}</span></button>`).join('')}</div>
              <div class="or-note or-note--info" id="or-stephint" hidden></div>
              <div class="or-out__row"><span class="or-out__label">To</span><span class="or-out__val" id="or-to"></span><button type="button" class="btn btn--sm btn--ghost" data-or-copy="to">Copy</button></div>
              <div class="or-out__row"><span class="or-out__label">Subject</span><span class="or-out__val" id="or-subject"></span><button type="button" class="btn btn--sm btn--ghost" data-or-copy="subject">Copy</button></div>
              <pre class="or-out__body" id="or-body"></pre>
              <div class="or-out__actions">
                <button type="button" class="btn btn--sm btn--primary" data-or-copy="body">Copy body</button>
                <button type="button" class="btn btn--sm" data-or-gmail title="Opens a Gmail draft with To and Subject and copies the body -- paste it with Ctrl+V to keep the bold"><span class="icon">open_in_new</span>Open in Gmail</button>
                <span class="or-small" id="or-attachhint"></span>
              </div>
            </div>
            <div data-or-outpane="call">
              <pre class="or-out__body" id="or-call"></pre>
              <div class="or-out__actions"><button type="button" class="btn btn--sm btn--primary" data-or-copy="call">Copy script</button></div>
            </div>
            <div data-or-outpane="linkedin">
              <div class="or-small">Only after the emails and the call got no answer, and only when the person's LinkedIn is confirmed. Email stays the first channel.</div>
              <pre class="or-out__body" id="or-linkedin"></pre>
              <div class="or-out__actions"><button type="button" class="btn btn--sm btn--primary" data-or-copy="linkedin">Copy note</button><span class="or-small" id="or-licount"></span></div>
            </div>
            <div data-or-outpane="attach">
              <div class="or-small">Preview / download open Google Drive — you need to be signed in with the company Google account. Source folder: <b>17. Potential Partner</b>. Ticking a file adds it to the email's "I've attached …" line.</div>
              <div id="or-attach"></div>
            </div>
          </div>
        </div>
      </div>`;
    renderPresetGroup();
    renderPresetButtons();
    renderSender();
    showOut(state.outTab);
    regenerate();
  }

  function renderPresetGroup() { $('#or-pgroup').innerHTML = groupSeg('pgroup', state.presetGroup, D.targets); }
  function renderPresetButtons() {
    const list = ordered().filter(t => state.presetGroup === 'all' || formatGroup(t) === state.presetGroup);
    $('#or-presets').innerHTML = list.map(t =>
      `<button type="button" class="or-preset${t.key === state.presetKey ? ' active' : ''}" data-or-preset="${esc(t.key)}">${esc(t.presetLabel)}</button>`).join('')
      + `<button type="button" class="or-preset or-preset--blank" data-or-blank>Blank / new company</button>`;
  }

  const setVal = (id, v) => { const el = $('#or-' + id); if (el) el.value = v == null ? '' : v; };
  const setChk = (id, v) => { const el = $('#or-' + id); if (el) el.checked = !!v; };

  function loadPreset(key) {
    const t = target(key);
    if (!t) return;
    const p = t.draft;
    state.presetKey = key;
    state.attachTicks = {};
    setVal('company', p.companyName); setVal('contact', p.contact); setVal('email', p.email); setVal('phone', p.phone);
    const route = t.emailRoute && t.emailRoute.to === p.email ? t.emailRoute : null;
    const emailContact = t.contacts.find(c => c.email && c.email === p.email);
    setChk('generalInbox', route ? route.kind === 'shared' : emailContact ? isGeneralContact(emailContact) : isSharedInbox(p.email));
    const gen = t.contacts.find(isGeneralContact);
    setChk('generalLine', !!(p.phone && ((gen && gen.phone && gen.phone.includes(p.phone)) || isMainLine(p.phone))));
    setVal('mfgSetup', p.mfgSetup); setVal('hook', p.hook); setVal('template', p.template || 'standard');
    Object.keys(PRODUCTS).forEach(id => setChk(id, p.products.includes(id)));
    setVal('skus', p.skus); setVal('size', p.size); setVal('productStatus', p.productStatus); setVal('note', p.note);
    $('#or-emailsrc').innerHTML = route
      ? `${route.kind === 'direct' ? 'Direct email' : 'Shared inbox'} · published${route.sourceUrl ? ` — <a href="${esc(route.sourceUrl)}" target="_blank" rel="noopener">source ↗</a>` : ''}${route.unverified ? ' · <b>not re-checked, confirm on their site first</b>' : ''}`
      : emailContact && emailContact.source ? 'Source: ' + sourceText(emailContact) : '';
    renderInternal(t);
    renderPresetButtons();
    showView('generator');
    regenerate();
    root.scrollTop = 0;
  }

  function clearForm() {
    state.presetKey = null;
    state.attachTicks = {};
    ['company', 'contact', 'email', 'phone', 'skus', 'note'].forEach(id => setVal(id, ''));
    setChk('generalInbox', false); setChk('generalLine', false);
    setVal('mfgSetup', 'outsourced'); setVal('hook', 'leadtime'); setVal('template', 'standard'); setVal('size', 'unknown'); setVal('productStatus', 'unknown');
    Object.keys(PRODUCTS).forEach(id => setChk(id, id === 'p_hardcap'));
    $('#or-emailsrc').innerHTML = '';
    renderInternal(null);
    renderPresetButtons();
    showView('generator');
    regenerate();
  }

  // Companies > Korean importers "Draft": the Korean importer template for that row. There is no
  // preset and no address -- the address is typed in after a person checks it (never collected).
  function loadImporter(no) {
    const r = ((D.strategy.koImporters || {}).rows || []).find(x => x.no === no);
    if (!r) return;
    clearForm();
    setVal('company', r.importer); setVal('template', 'ko_importer'); setChk('generalInbox', true);
    if (r.forms) Object.keys(PRODUCTS).forEach(id => setChk(id, r.forms.includes(id)));
    setVal('skus', r.products.join(', '));
    if (r.web && r.web.phone) setVal('phone', r.web.phone.split(/[·,/]/)[0].trim());
    regenerate();
    root.scrollTop = 0;
  }

  // Internal-only notes for the loaded target -- shown beside the form, never in the copy.
  function renderInternal(t) {
    const box = $('#or-internal');
    if (!t) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `
      <h3 class="or-card__title"><span class="icon icon--inline">lock</span>Internal notes — never paste into outreach</h3>
      ${t.todoNote ? `<div class="or-note or-note--warn">${t.todoNote}</div>` : ''}
      <div class="or-prose or-internal__text">${esc(t.draft.contactAlt)}</div>
      <h4 class="or-subhead">Email route</h4>
      ${emailRouteBox(t)}
      <h4 class="or-subhead">All contact channels (recommended first, email first)</h4>
      ${contactOrder(t.contacts).map(c => {
        const links = [c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="or-muted">No email</span>',
          c.phone ? esc(c.phone) : '', c.linkedin ? `<a href="${esc(c.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ''].filter(Boolean);
        return `<div class="or-channel">
        <div class="or-channel__name">${c.name}${c.recommended ? ' <span class="tag tag--new">Recommended</span>' : ''}</div>
        ${c.title ? `<div class="or-small">${c.title}</div>` : ''}
        <div class="or-channel__links">${links.join(' · ')}</div>
        ${c.source ? `<div class="or-small or-channel__src">Source: ${sourceText(c)}</div>` : ''}
      </div>`;
      }).join('')}`;
  }

  function readSender() {
    const v = id => ($('#or-' + id) || {}).value || '';
    return { name: v('sname').trim() || D.defaultSender.name, title: v('stitle').trim(), phone: v('sphone').trim() };
  }
  function renderSender() {
    const s = loadSender();
    setVal('sname', s.name); setVal('stitle', s.title); setVal('sphone', s.phone);
    $('#or-sendername').textContent = s.name;
  }

  function readForm() {
    const v = id => ($('#or-' + id) || {}).value || '';
    const c = id => !!($('#or-' + id) || {}).checked;
    const size = v('size'), productStatus = v('productStatus');
    // The preset's approved emails 1 and 2 apply only with the preset's own template.
    const t = state.presetKey && target(state.presetKey);
    const sameTpl = t && (v('template') || 'standard') === (t.draft.template || 'standard');
    return {
      email1: sameTpl && t.draft.email1 || null, email2: sameTpl && t.draft.email2 || null,
      refLine: t ? t.draft.refLine : undefined, vegeCaps: !!(t && t.draft.vegeCaps),
      company: v('company').trim(), contact: v('contact').trim(), email: v('email').trim(), phone: v('phone').trim(),
      generalInbox: c('generalInbox'), generalLine: c('generalLine'), mfgSetup: v('mfgSetup'), hook: v('hook'), template: v('template') || 'standard',
      products: Object.keys(PRODUCTS).filter(c), skus: v('skus').trim(), size, productStatus, note: v('note').trim(),
      attachments: attachmentState(size, productStatus).filter(a => a.checked).map(a => a.id),
      sender: readSender()
    };
  }

  let last = null, lastForm = null;
  function regenerate() {
    const f = readForm();
    const out = compose(f);
    last = out;
    lastForm = f;
    renderEmailStep();
    $('#or-call').textContent = out.call;
    $('#or-linkedin').textContent = out.linkedin || 'No named contact for this company, so there is no one to connect with on LinkedIn — stay on email and phone.';
    $('#or-licount').textContent = out.linkedin ? `${out.linkedin.length} / 300 characters` : '';
    $('#or-sendername').textContent = f.sender.name;
    const t = state.presetKey && target(state.presetKey);
    const warns = (t && t.needsApproval ? [['bad', 'Do not send without internal approval — this draft is for review only.']] : [])
      .concat(t && ageDays(researchDate(t)) > STALE_DAYS ? [['warn', `Research on ${t.name} is from ${researchDate(t)} (${ageDays(researchDate(t))} days ago) — re-check the contact's name and title on their site before sending.`]] : [])
      .concat(t && t.crm ? [['warn', `${t.name} is a past Demo Labs customer in the CRM (${t.crm.name}: ${t.crm.orders} order${t.crm.orders > 1 ? 's' : ''}, last ${t.crm.last}, rep ${t.crm.rep}). Use the "Past customer — reconnect" template rather than a cold intro, and check the account history with the team before sending.`]] : [])
      .concat(out.warnings);
    renderTemplateNote(f);
    $('#or-warnings').innerHTML = warns.map(([tone, msg]) => `<div class="or-note or-note--${tone}">${esc(msg)}</div>`).join('');
    renderAttachments(f);
  }

  // Under the template picker: when to use it; the hook only drives the "standard" opening.
  function renderTemplateNote(f) {
    const tpl = (D.templates || {})[f.template] || {};
    $('#or-tplnote').innerHTML = tpl.when ? esc(tpl.when) : '';
    const hookUsed = !(typeof tpl.opening === 'function' || tpl.lang === 'ko');
    const note = $('#or-hooknote');
    note.hidden = hookUsed;
    note.textContent = hookUsed ? '' : `Not used in the email: the "${tpl.label}" template has its own opening. The hook still feeds the English call script.`;
  }

  // The selected email of the sequence: {to, subject, body}.
  function currentEmail() {
    if (!last) return null;
    const st = state.emailStep !== 'first' && last.steps[state.emailStep];
    return st ? { to: last.to, subject: st.subject, body: st.body } : { to: last.to, subject: last.subject, body: last.body };
  }
  function renderEmailStep() {
    const cur = currentEmail();
    if (!cur) return;
    const first = state.emailStep === 'first';
    $$('[data-or-step]').forEach(b => b.classList.toggle('active', b.dataset.orStep === state.emailStep));
    $('#or-to').textContent = cur.to || '— no email yet';
    $('#or-to').classList.toggle('or-muted', !cur.to);
    $('#or-subject').textContent = cur.subject;
    $('#or-body').innerHTML = boldHtml(cur.body);
    const n = first && lastForm ? lastForm.attachments.length : 0;
    $('#or-attachhint').textContent = 'Open in Gmail fills To and Subject and copies the body — paste it with Ctrl+V to keep the bold.'
      + (n ? ` Attach the ${n} ticked file${n > 1 ? 's' : ''} yourself.` : '');
    const t = state.presetKey && target(state.presetKey);
    const esc8 = t && t.emailRoute && t.emailRoute.escalate;
    const hint = first ? ''
      : `Send this as a <b>reply in the thread of your first email</b> (Gmail: open the sent email → Reply) and paste the body — no attachments. "Open in Gmail" starts a new thread instead.`
        + (state.emailStep === 'fu2' && esc8 ? `<br>No answer from the shared inbox yet? This one can go to <b>${esc(esc8)}</b> instead (see Email route) — put that address in "Send-to email", that person in "Contact" and untick "Shared inbox" so the greeting fits.` : '');
    const box = $('#or-stephint');
    box.hidden = !hint;
    box.innerHTML = hint;
  }

  function renderAttachments(f) {
    $('#or-attach').innerHTML = attachmentState(f.size, f.productStatus).map(a => `
      <label class="or-attach${a.rule === 'never' ? ' is-blocked' : ''}">
        <input type="checkbox" data-or-attach="${a.id}"${a.checked ? ' checked' : ''}${a.rule === 'never' ? ' disabled' : ''}>
        <span class="or-attach__main">
          <span class="or-attach__name">${esc(a.name)} <span class="or-tone or-tone--${a.tag[0]}">${a.tag[1]}</span></span>
          <span class="or-small">${esc(a.reason)}</span>
          <span class="or-attach__links">
            <a href="https://drive.google.com/file/d/${esc(a.driveId)}/view" target="_blank" rel="noopener">Preview ↗</a>
            <a href="https://drive.google.com/uc?export=download&amp;id=${esc(a.driveId)}" target="_blank" rel="noopener">Download</a>
          </span>
        </span>
      </label>`).join('');
  }

  function showOut(tab) {
    state.outTab = tab;
    $$('[data-or-out]').forEach(b => b.classList.toggle('active', b.dataset.orOut === tab));
    $$('[data-or-outpane]').forEach(p => { p.hidden = p.dataset.orOutpane !== tab; });
  }

  function copyText(text, btn) {
    const label = btn.dataset.label || btn.textContent;
    btn.dataset.label = label;
    const done = ok => { btn.textContent = ok ? 'Copied ✓' : 'Select and press Ctrl+C'; setTimeout(() => { btn.textContent = label; }, 1600); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), () => done(fallback()));
    else done(fallback());
  }

  // Body as rich text (bold kept) plus plain text, for pasting into Gmail.
  function writeRich(text) {
    const html = '<div>' + boldHtml(text).replace(/\n/g, '<br>') + '</div>';
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem && window.isSecureContext) {
      return navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plainText(text)], { type: 'text/plain' })
      })]).then(() => true, () => copyHtmlFallback(html));
    }
    return Promise.resolve(copyHtmlFallback(html));
  }
  function copyHtmlFallback(html) {
    const box = document.createElement('div');
    box.innerHTML = html; box.contentEditable = 'true';
    box.style.position = 'fixed'; box.style.left = '-9999px';
    document.body.appendChild(box);
    const range = document.createRange(); range.selectNodeContents(box);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges(); box.remove();
    return ok;
  }
  function flash(btn, msg) {
    const label = btn.dataset.label || btn.innerHTML;
    btn.dataset.label = label;
    btn.textContent = msg;
    setTimeout(() => { btn.innerHTML = label; }, 2400);
  }
  function copyRich(text, btn) { writeRich(text).then(ok => flash(btn, ok ? 'Copied ✓' : 'Select and press Ctrl+C')); }
  function openGmail(btn) {
    const cur = currentEmail();
    if (!cur) return;
    const q = encodeURIComponent;
    // Started first, while the click still counts as a user action (opening the tab uses it up)
    const copied = writeRich(cur.body);
    window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${q(cur.to || '')}&su=${q(cur.subject)}`, '_blank', 'noopener');
    copied.then(ok => flash(btn, ok ? 'Body copied — paste it in Gmail (Ctrl+V)' : 'Copy failed — use Copy body'));
  }

  // ---------- Market screening ----------
  const MX_FORMATS = ['Hard capsules', 'Tablets', 'Softgels', 'Powder/sachets', 'Liquids', 'Gummies', 'Bars', 'Honey', 'Herbal tea'];
  const MX_FORMAT_OFF = ['Gummies', 'Bars', 'Honey', 'Herbal tea']; // Demo Labs doesn't make these
  const YNU = { yes: 'Yes', no: 'No', unknown: 'Unknown' };
  const MX_FILTERS = {
    market: { label: 'Market', values: ['NZ', 'SG', 'NZ + SG'] },
    medsafe: { label: 'Medsafe / therapeutic', values: ['yes', 'no', 'unknown'], display: YNU },
    ownFactory: { label: 'Own factory', values: ['yes', 'no', 'unknown'], display: YNU },
    mlm: { label: 'MLM / direct selling', values: ['yes', 'no'], display: YNU },
    format: { label: "Formats (ones we don't make start unticked)", values: MX_FORMATS, display: FORMAT_EN }
  };
  function mxDefaultFilters() {
    const f = {};
    Object.keys(MX_FILTERS).forEach(k => { f[k] = new Set(k === 'format' ? MX_FORMATS.filter(t => !MX_FORMAT_OFF.includes(t)) : MX_FILTERS[k].values); });
    return f;
  }
  const MX_PRESETS = {
    all: { label: 'All brands', apply: () => {} },
    candidates: { label: '★ OEM candidates — no Medsafe registration, no own factory, no MLM', apply: f => { f.medsafe.delete('yes'); f.ownFactory.delete('yes'); f.mlm.delete('yes'); } },
    nzOnly: { label: 'NZ only', apply: f => { f.market = new Set(['NZ', 'NZ + SG']); } },
    sgOnly: { label: 'SG only', apply: f => { f.market = new Set(['SG', 'NZ + SG']); } },
    mlmOnly: { label: 'MLM only', apply: f => { f.mlm = new Set(['yes']); } }
  };

  function renderMarket() {
    $('[data-or-pane="market"]').innerHTML = `
      <button type="button" class="btn btn--sm btn--ghost" data-or-view="strategy">‹ Playbook</button>
      <div class="or-note">${D.marketNoteHtml}</div>
      <div class="or-card">
        <h3 class="or-card__title">Quick filters</h3>
        <div class="or-presets" id="or-mxpresets"></div>
        <div class="or-count" id="or-mxcount"></div>
      </div>
      <div class="or-card">
        <h3 class="or-card__title">Filters <span class="or-muted">— untick a value to hide brands with it</span></h3>
        <div class="or-mxfilters" id="or-mxfilters"></div>
      </div>
      <div class="table-wrap or-mxtable"><table class="or-table">
        <thead><tr><th>Brand</th><th>Market</th><th>Parent / owner</th><th>Medsafe / therapeutic</th><th>Own factory</th><th>MLM</th><th>Main channel</th><th>Formats</th><th>Scale</th><th>HW overlap (SG)</th></tr></thead>
        <tbody id="or-mxrows"></tbody>
      </table></div>`;
    renderMxControls();
    renderMxRows();
  }

  function renderMxControls() {
    $('#or-mxpresets').innerHTML = Object.entries(MX_PRESETS).map(([k, p]) =>
      `<button type="button" class="or-preset${k === state.mxPreset ? ' active' : ''}" data-or-mxpreset="${k}">${esc(p.label)}</button>`).join('');
    $('#or-mxfilters').innerHTML = Object.entries(MX_FILTERS).map(([key, f]) => `
      <div class="or-mxgroup">
        <div class="or-mxgroup__label">${esc(f.label)}</div>
        <div class="or-chips">${f.values.map(v => `<label class="chip"><input type="checkbox" data-or-mxkey="${key}" data-or-mxval="${esc(v)}"${state.mx[key].has(v) ? ' checked' : ''}>${esc(f.display ? f.display[v] : v)}</label>`).join('')}</div>
      </div>`).join('');
  }

  function mxPasses(b) {
    const f = state.mx;
    return f.market.has(b.market) && f.medsafe.has(b.medsafe) && f.ownFactory.has(b.ownFactory) && f.mlm.has(b.mlm)
      && (b.formatTags || []).some(t => f.format.has(t));
  }
  function ynBadge(value, src) {
    const tone = value === 'yes' ? 'bad' : value === 'no' ? 'ok' : 'warn';
    return `<span class="or-tone or-tone--${tone}">${YNU[value] || esc(value)}${src ? ` <a href="${esc(src)}" target="_blank" rel="noopener" title="Source">↗</a>` : ''}</span>`;
  }
  function hwLabel(v) {
    if (!v) return '<span class="or-muted">—</span>';
    const tone = v.startsWith('high') ? 'bad' : v.startsWith('low') ? 'ok' : 'warn';
    return `<span class="or-hw or-hw--${tone}">${esc(v)}</span>`;
  }
  function renderMxRows() {
    const rows = D.market.filter(mxPasses);
    $('#or-mxcount').textContent = `Showing ${rows.length} of ${D.market.length} brands`;
    $('#or-mxrows').innerHTML = rows.map(b => `<tr class="${b.key ? 'or-rec' : ''}">
      <td><b>${esc(b.name)}</b>${b.key ? ` <button type="button" class="or-target" data-or-goto="${esc(b.key)}">★ Active target</button>` : ''}${b.isReference ? ' <span class="or-tone or-tone--info">Existing customer (reference)</span>' : ''}</td>
      <td>${esc(b.market)}</td>
      <td class="or-small">${esc(b.parent)}</td>
      <td>${ynBadge(b.medsafe, b.medsafeSrc)}</td>
      <td>${ynBadge(b.ownFactory, b.factorySrc)}</td>
      <td>${ynBadge(b.mlm)}</td>
      <td class="or-small">${esc(b.channel)}</td>
      <td class="or-small">${esc(b.formats)}</td>
      <td class="or-small">${esc(b.scale)}</td>
      <td>${hwLabel(b.hwOverlap)}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="empty">No brands match these filters.</td></tr>';
  }

  // ---------- Tracker (v3.14) ----------
  // Shared progress for every prospect list -- one KV key per company (crm:outreach:<id>), all
  // read through /api/outreach. A company with nothing saved shows its seed (D.tracker.seed, or the
  // CEO review on a Korean importer row); once anyone saves, KV is the record.
  const TRK_KEY = id => 'crm:outreach:' + id;
  const LISTS = { nz: 'NZ brands', kr: 'Korean importers', nc: 'Needs a contact' };
  const LOG_TYPES = [['email1', 'Email 1'], ['email2', 'Email 2'], ['email3', 'Email 3'], ['email4', 'Email 4 (close)'], ['email', 'Email (other)'],
    ['reply', 'Reply received'], ['call', 'Call'], ['meeting', 'Meeting'], ['note', 'Note'], ['review', 'Internal review']];
  const logLabel = t => (LOG_TYPES.find(x => x[0] === t) || [t, t])[1];
  // Logging a step moves the stage forward and sets the next step (Email-first sequence: email 2
  // at D+3, email 3 at D+8, call at D+11, email 4 about 10 days after the call). [stage, next, days];
  // next null = leave the next step as it is.
  const AFTER = { email1: ['emailed', 'Email 2 (same thread)', 3], email2: ['followup', 'Email 3 (same thread)', 5], email3: ['followup', 'Call', 3],
    call: ['followup', 'Email 4 (close)', 10], email4: ['closed', '', 0], reply: ['replied', 'Reply within 24h', 1], meeting: ['meeting', null, 0] };
  const RANK = { todo: 0, hold: 0, ready: 1, emailed: 2, followup: 3, replied: 4, meeting: 5, pipeline: 6, closed: 7 };
  const DONE = ['pipeline', 'closed'];
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => ymd(new Date());
  // n days after a YYYY-MM-DD date, moved off a weekend to the Monday.
  function addDays(ds, n) {
    const d = new Date(ds + 'T12:00:00');
    d.setDate(d.getDate() + n);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return ymd(d);
  }
  const stageOf = id => ((D.tracker || {}).stages || []).find(s => s[0] === id) || [id, id, 'neutral'];
  const pcode = p => `${p.list.toUpperCase()}-${String(p.no).padStart(2, '0')}`;

  // Every prospect: NZ brands in Top picks order, the numbered Korean importers, Needs a contact.
  // Numbers follow list order, so add new companies at the end of a list.
  function prospects() {
    const S = D.strategy || {};
    const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (S.picks || []).map((p, i) => ({ id: 'nz-' + p.keys[0], list: 'nz', no: i + 1, wave: p.wave, key: p.keys[0], keys: p.keys,
      name: p.label || (target(p.keys[0]) || {}).name || p.keys[0] }))
      .concat(((S.koImporters || {}).rows || []).filter(r => r.no).map(r => ({ id: 'kr-' + String(r.no).padStart(2, '0'), list: 'kr', no: r.no, name: r.importer, kr: r,
        url: r.web && (r.web.contact || r.web.site), phone: r.web && r.web.phone })))
      .concat((S.backlog || []).map((b, i) => ({ id: 'nc-' + (slug(b.name) || i + 1), list: 'nc', no: i + 1, name: b.name, url: b.url })));
  }
  function seedFor(p) {
    const s = ((D.tracker || {}).seed || {})[p.id];
    if (s) return s;
    const c = p.kr && p.kr.ceo;
    if (!c) return null;
    const v = { go: ['todo', 'Find the address (by hand) → email 1'], check: ['hold', 'Check before contacting (see review)'], pass: ['closed', ''] }[c.v];
    return { stage: v[0], owner: c.v === 'go' ? 'Jamie' : '', next: v[1] ? { action: v[1], date: '' } : null,
      log: [{ d: c.date, type: 'review', note: ` ${{ go: 'Go', check: 'OK', pass: 'Pass' }[c.v]}: ${c.note}` }] };
  }
  // Tracker number of an NZ target (both brands of a two-brand pick share one).
  const nzCode = key => { const p = prospects().find(x => x.list === 'nz' && x.keys.includes(key)); return p ? pcode(p) : ''; };
  const recOf = p => (state.trk && state.trk[p.id]) || seedFor(p) || { stage: 'todo', owner: '', next: null, log: [] };
  const lastLog = r => (r.log || []).slice().sort((a, b) => (a.d || '') < (b.d || '') ? -1 : 1).pop();

  function loadTracker(force) {
    if ((state.trk && !force) || typeof fetch !== 'function') return;
    fetch('/api/outreach').then(r => r.json()).then(list => {
      state.trk = {};
      (Array.isArray(list) ? list : []).forEach(x => { if (x && x.id) state.trk[x.id] = x; });
      state.trkErr = '';
      renderTrkRows();
    }).catch(() => {
      state.trkErr = 'Could not load saved progress — showing the starting state. Refresh to try again before editing.';
      renderTrkRows();
    });
  }
  // Re-reads the key before writing so two people on the same company keep each other's log
  // entries; mutate(r) edits the record in place.
  function saveTrk(p, mutate) {
    return kvGet(TRK_KEY(p.id)).then(fresh => {
      const r = fresh && fresh.id ? fresh : JSON.parse(JSON.stringify(recOf(p)));
      Object.assign(r, { id: p.id, name: p.name, list: p.list });
      r.log = r.log || [];
      mutate(r);
      r.updated = new Date().toISOString();
      r.by = (typeof profile === 'string' && profile) || '';
      (state.trk = state.trk || {})[p.id] = r;
      renderTrkRows();
      return kvPut(TRK_KEY(p.id), r);
    });
  }

  function renderTracker() {
    const pane = $('[data-or-pane="tracker"]');
    if (!pane) return;
    const owners = (D.tracker || {}).owners || [];
    const stages = (D.tracker || {}).stages || [];
    pane.innerHTML = `
      <div class="or-card">
        <div class="or-kpis" id="or-trk-kpis"></div>
        <div class="or-trk__filters">
          <div class="seg seg--sm" id="or-trk-lists"></div>
          <label class="or-field or-field--inline"><span>Stage</span><select data-or-trkfilter="stage">
            <option value="active">Active</option><option value="all">All</option>
            ${stages.map(s => `<option value="${esc(s[0])}">${esc(s[1])}</option>`).join('')}</select></label>
          <label class="or-field or-field--inline"><span>Owner</span><select data-or-trkfilter="owner"><option value="">Anyone</option>
            ${owners.map(o => `<option>${esc(o)}</option>`).join('')}</select></label>
          <label class="or-check"><input type="checkbox" data-or-trkfilter="due"><span>Due or overdue only</span></label>
          <label class="or-field or-field--inline"><span>Search</span><input type="text" data-or-trkfilter="q" placeholder="Company"></label>
        </div>
        <div id="or-trk-err"></div>
        <div class="table-wrap"><table class="or-table or-trk">
          <thead><tr><th>#</th><th>Company</th><th>Stage</th><th>Owner</th><th>Last touch</th><th>Next step</th></tr></thead>
          <tbody id="or-trk-rows"></tbody>
        </table></div>
        <div class="or-small or-strat__foot">Saved for everyone (CRM storage, one record per company). Click a company to log an email, reply, call or meeting — logging an email sets the next step from the email-first sequence, and a reply stops it. Once a company replies or books a meeting, press → Pipeline: it becomes a client (PIC = its owner) and an Outbound deal, so it can be reported in Weekly Sales.</div>
      </div>`;
    renderTrkRows();
  }

  function renderTrkRows() {
    const body = $('#or-trk-rows');
    if (!body) return;
    const F = state.trkF, td = today();
    const all = prospects().map(p => ({ p, r: recOf(p) }));
    const due = x => !!(x.r.next && x.r.next.date && x.r.next.date <= td && !DONE.includes(x.r.stage));
    const inList = x => F.list === 'all' || x.p.list === F.list;
    const rows = all.filter(x => inList(x)
      && (F.stage === 'all' || (F.stage === 'active' ? !['closed', 'hold'].includes(x.r.stage) : x.r.stage === F.stage))
      && (!F.owner || x.r.owner === F.owner) && (!F.due || due(x)) && (!F.q || x.p.name.toLowerCase().includes(F.q.toLowerCase())));
    const n = f => all.filter(x => inList(x) && f(x)).length;
    $('#or-trk-kpis').innerHTML = [
      ['Due or overdue', n(due)],
      ['Emailed / following up', n(x => ['emailed', 'followup'].includes(x.r.stage))],
      ['Replied / meeting', n(x => ['replied', 'meeting'].includes(x.r.stage))],
      ['In Pipeline', n(x => x.r.stage === 'pipeline')],
      ['Not started', n(x => ['todo', 'ready'].includes(x.r.stage))]
    ].map(([l, v]) => `<div class="or-kpi"><span>${l}</span><b>${v}</b></div>`).join('');
    $('#or-trk-lists').innerHTML = [['all', 'All']].concat(Object.entries(LISTS)).map(([k, l]) =>
      `<button type="button" class="${F.list === k ? 'active' : ''}" data-or-trklist="${k}">${l} (${all.filter(x => k === 'all' || x.p.list === k).length})</button>`).join('');
    $('#or-trk-err').innerHTML = state.trkErr ? `<div class="or-note or-note--warn">${esc(state.trkErr)}</div>` : (state.trk ? '' : '<div class="or-small">Loading saved progress…</div>');
    body.innerHTML = rows.map(({ p, r }) => {
      const st = stageOf(r.stage), last = lastLog(r), nx = r.next;
      const tone = nx && nx.date ? (nx.date < td ? 'bad' : nx.date === td ? 'warn' : 'neutral') : 'neutral';
      return `<tr class="${due({ r }) ? 'or-trk--due' : ''}">
        <td class="or-num">${pcode(p)}</td>
        <td><button type="button" class="or-link" data-or-trk="${esc(p.id)}">${esc(p.name)}</button>
          <div class="or-small">${LISTS[p.list]}${p.wave ? ` · ${p.wave === 3 ? 'Hold' : 'Wave ' + p.wave}` : ''}</div></td>
        <td>${badge(st[2], esc(st[1]))}${['replied', 'meeting'].includes(r.stage) && !r.dealId ? '<div class="or-small">→ Pipeline next</div>' : ''}</td>
        <td>${esc(r.owner || '—')}</td>
        <td class="or-small">${last ? `<b>${esc(last.d)}</b> · ${esc(logLabel(last.type))}<div>${esc((last.note || '').slice(0, 90))}</div>` : '—'}</td>
        <td class="or-small">${nx && nx.action ? `${nx.date ? badge(tone, esc(nx.date)) + ' ' : ''}${esc(nx.action)}` : '—'}</td>
      </tr>${state.trkOpen === p.id ? `<tr class="or-trk__open"><td colspan="6">${trkDetail(p, r)}</td></tr>` : ''}`;
    }).join('') || '<tr><td colspan="6" class="empty">No companies match these filters.</td></tr>';
  }

  function trkDetail(p, r) {
    const T = D.tracker || {}, nx = r.next || {};
    const log = (r.log || []).map((e, i) => ({ e, i })).sort((a, b) => (a.e.d || '') < (b.e.d || '') ? 1 : -1);
    const draft = p.list === 'nz' || (p.kr && p.kr.ceo && p.kr.ceo.v === 'go');
    return `<div class="or-trk__detail" data-or-trkrow="${esc(p.id)}">
      <div class="or-trk__grid">
        <label class="or-field"><span>Stage</span><select data-or-trkv="stage">${(T.stages || []).map(s =>
          `<option value="${esc(s[0])}"${s[0] === r.stage ? ' selected' : ''}>${esc(s[1])}</option>`).join('')}</select></label>
        <label class="or-field"><span>Owner</span><select data-or-trkv="owner"><option value="">—</option>${(T.owners || []).map(o =>
          `<option${o === r.owner ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        <label class="or-field"><span>Next step</span><input type="text" data-or-trkv="action" value="${esc(nx.action || '')}" placeholder="e.g. Email 2 (same thread)"></label>
        <label class="or-field"><span>Date</span><input type="date" data-or-trkv="date" value="${esc(nx.date || '')}"></label>
        <button type="button" class="btn btn--sm" data-or-trksave="${esc(p.id)}">Save</button>
      </div>
      <h4 class="or-subhead">Log</h4>
      <div class="or-trk__grid">
        <label class="or-field"><span>Date</span><input type="date" data-or-trkv="logd" value="${today()}"></label>
        <label class="or-field"><span>What</span><select data-or-trkv="logtype">${LOG_TYPES.map(t => `<option value="${t[0]}">${t[1]}</option>`).join('')}</select></label>
        <label class="or-field or-trk__note"><span>Note</span><input type="text" data-or-trkv="lognote" placeholder="e.g. the CEO replied — passed us to the director"></label>
        <button type="button" class="btn btn--sm btn--primary" data-or-trklog="${esc(p.id)}">Add to log</button>
      </div>
      <ul class="or-trk__log">${log.map(({ e, i }) => `<li><b>${esc(e.d)}</b> · ${esc(logLabel(e.type))} — ${esc(e.note)}${e.by ? ` <span class="or-muted">(${esc(e.by)})</span>` : ''}
        <button type="button" class="or-trk__del" title="Remove this entry" data-or-trkdel="${esc(p.id)}" data-or-trki="${i}">×</button></li>`).join('') || '<li class="or-muted">Nothing logged yet.</li>'}</ul>
      <div class="or-trk__links">
        ${draft ? `<button type="button" class="btn btn--sm btn--ghost" data-or-trkdraft="${esc(p.id)}"><span class="icon icon--inline">edit_note</span>Draft email</button>` : ''}
        ${p.list === 'nz' ? `<button type="button" class="btn btn--sm btn--ghost" data-or-goto="${esc(p.key)}"><span class="icon icon--inline">travel_explore</span>Research</button>` : ''}
        ${p.list === 'kr' ? `<button type="button" class="btn btn--sm btn--ghost" data-or-trkkr="1"><span class="icon icon--inline">travel_explore</span>Importer list</button>` : ''}
        ${p.url ? `<a class="btn btn--sm btn--ghost" href="${esc(p.url)}" target="_blank" rel="noopener">${p.list === 'kr' && p.kr.web.contact ? 'Contact page' : 'Website'} ↗</a>` : ''}
        ${p.phone ? `<span class="or-small">☎ ${esc(p.phone)}</span>` : ''}
        ${r.dealId ? `<button type="button" class="btn btn--sm btn--ghost" data-or-trkdeal="${esc(r.dealId)}"><span class="icon icon--inline">view_kanban</span>Open deal</button>`
          : ['replied', 'meeting'].includes(r.stage) ? `<button type="button" class="btn btn--sm" data-or-trkpipe="${esc(p.id)}"><span class="icon icon--inline">view_kanban</span>→ Pipeline</button>` : ''}
        ${r.updated ? `<span class="or-small">Saved ${esc(r.updated.slice(0, 10))}${r.by ? ' by ' + esc(r.by) : ''}</span>` : '<span class="or-small">Starting state — not saved yet</span>'}
      </div>
    </div>`;
  }

  // "→ Pipeline" (replied or meeting): adds the client if it's new, creates an Outbound Lead deal
  // with the contacts in its notes, copies the log into the deal's activity log and marks the
  // prospect In Pipeline. Uses the CRM's globals (CUSTS, DEALS, ACTIVITIES, ACCOUNT_MANAGERS,
  // DEFAULT_PROB, kvPut, addCustomClient).
  const ACT_OF = { email1: 'Email', email2: 'Email', email3: 'Email', email4: 'Email', email: 'Email', reply: 'Email', call: 'Call', meeting: 'Meeting' };
  function toPipeline(p) {
    const r = recOf(p), t = p.key && target(p.key);
    const legal = t && /Legal name:\s*([^·]+)/.exec(t.sub || '');
    const name = (prompt('Client name in the CRM (type an existing client to link to it):', legal ? `${legal[1].trim()} (${p.name})` : p.name) || '').trim();
    if (!name) return;
    // Full name ("Jamie" → "Jamie Park") from the account managers, or the reps list if those haven't loaded
    const ams = Object.values(ACCOUNT_MANAGERS || {}).map(a => a && a.primary).concat(typeof getEffectiveReps === 'function' ? getEffectiveReps() : []).filter(Boolean);
    const owner = ams.find(n => r.owner && n.toLowerCase().startsWith(r.owner.toLowerCase())) || r.owner || '';
    if (!CUSTS.find(c => c.name === name)) addCustomClient({ name, rep: owner, orders: 0, lines: 0, nzd: 0, usd: 0, first: '', last: '', status: 'Lead', notes: 'From Outreach ' + pcode(p), _custom: true });
    // The owner becomes the client's PIC, so it's listed under them in Clients and Weekly Sales.
    if (owner && !(ACCOUNT_MANAGERS[name] && ACCOUNT_MANAGERS[name].primary)) {
      ACCOUNT_MANAGERS[name] = { primary: owner, backup: (ACCOUNT_MANAGERS[name] || {}).backup || '' };
      kvPut('crm:account_managers', ACCOUNT_MANAGERS);
    }
    const now = new Date().toISOString(), uid = () => Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const contacts = ((t && t.contacts) || []).filter(c => c.email && !/^General enquiry/.test(c.name)).map(c => `${c.name} (${c.title}) ${c.email}${c.phone ? ' · ' + c.phone : ''}`);
    const deal = { id: 'deal_' + uid(), title: `${p.name} — outreach (${pcode(p)})`, customer: name, dealType: 'Outbound', stage: 'Lead', owner,
      unitPrice: 0, qty: 0, estValue: 0, probability: DEFAULT_PROB.Lead, startDate: ((r.log || []).filter(e => e.type === 'email1').map(e => e.d).sort()[0]) || today(),
      quoteSentDate: '', closeDate: '', linkedQuot: '', market: '', created: now, updated: now, stageEnteredAt: now,
      notes: contacts.concat(r.next && r.next.action ? [`Next: ${r.next.action}${r.next.date ? ' (' + r.next.date + ')' : ''}`] : []).join('\n') };
    DEALS.push(deal);
    kvPut('crm:deal:' + deal.id, deal);
    (r.log || []).forEach(e => {
      const a = { id: 'act_' + uid(), dealId: deal.id, actType: ACT_OF[e.type] || 'Note', summary: `${logLabel(e.type)}: ${e.note}`, date: e.d, owner: e.by || owner, ts: now };
      ACTIVITIES.push(a);
      kvPut('crm:act:' + a.id, a);
    });
    saveTrk(p, x => {
      x.stage = 'pipeline';
      x.dealId = deal.id;
      x.log.push({ d: today(), type: 'note', note: `Moved to Pipeline — ${name} (Outbound · Lead)`, by: (typeof profile === 'string' && profile) || '' });
    });
    alert(`Added to the Pipeline as "${deal.title}" (Outbound · Lead) with ${(r.log || []).length} activity entries. "${name}" is now in Clients${owner ? ` (PIC ${owner})` : ''} and can be picked in Weekly Sales.`);
  }

  function trkClick(d) {
    const find = id => prospects().find(p => p.id === id);
    const box = id => root.querySelector(`[data-or-trkrow="${id}"]`);
    const val = (id, k) => (box(id).querySelector(`[data-or-trkv="${k}"]`) || {}).value || '';
    if (d.orTrk) { state.trkOpen = state.trkOpen === d.orTrk ? null : d.orTrk; renderTrkRows(); return true; }
    if (d.orTrklist) { state.trkF.list = d.orTrklist; renderTrkRows(); return true; }
    if (d.orTrksave) {
      const id = d.orTrksave;
      const v = { stage: val(id, 'stage'), owner: val(id, 'owner'), action: val(id, 'action').trim(), date: val(id, 'date') };
      saveTrk(find(id), r => {
        if (v.stage !== r.stage) r.log.push({ d: today(), type: 'note', note: `Stage: ${stageOf(r.stage)[1]} → ${stageOf(v.stage)[1]}`, by: (typeof profile === 'string' && profile) || '' });
        r.stage = v.stage; r.owner = v.owner;
        r.next = v.action || v.date ? { action: v.action, date: v.date } : null;
      });
      return true;
    }
    if (d.orTrklog) {
      const id = d.orTrklog, type = val(id, 'logtype'), note = val(id, 'lognote').trim(), day = val(id, 'logd') || today();
      if (!note && !/^email\d$/.test(type)) { alert('Add a short note first.'); return true; }
      saveTrk(find(id), r => {
        r.log.push({ d: day, type, note: note || logLabel(type) + ' sent', by: (typeof profile === 'string' && profile) || '', ts: new Date().toISOString() });
        // A reply or meeting moves the stage on; sequence steps only while there's no reply yet.
        const a = AFTER[type], talking = ['replied', 'meeting', 'pipeline'].includes(r.stage);
        if (a && (['reply', 'meeting'].includes(type) ? RANK[a[0]] > RANK[r.stage] : !talking && RANK[a[0]] >= RANK[r.stage])) {
          r.stage = a[0];
          if (a[1] !== null) r.next = a[1] ? { action: a[1], date: addDays(day, a[2]) } : null;
        }
      });
      return true;
    }
    if (d.orTrkdel) {
      if (!confirm('Remove this log entry?')) return true;
      const i = +d.orTrki;
      saveTrk(find(d.orTrkdel), r => { r.log.splice(i, 1); });
      return true;
    }
    if (d.orTrkdraft) {
      const p = find(d.orTrkdraft);
      if (p.list === 'nz') loadPreset(p.key); else loadImporter(p.no);
      return true;
    }
    if (d.orTrkpipe) { toPipeline(find(d.orTrkpipe)); return true; }
    if (d.orTrkdeal) { activateTab('pipeline'); setTimeout(() => openDealModal(d.orTrkdeal), 300); return true; }
    if (d.orTrkkr) { state.coList = 'kr'; renderResearch(); showView('research'); root.scrollTop = 0; return true; }
    if (d.orColist) { state.coList = d.orColist; renderResearch(); return true; }
    if (d.orKrf) { state.krF = d.orKrf; renderResearch(); return true; }
    return false;
  }

  // ---------- events ----------
  function onClick(e) {
    const el = e.target.closest('button, [data-or-goto]');
    if (!el || !root.contains(el)) return;
    const d = el.dataset;
    if (trkClick(d)) return;
    if (d.orView) showView(d.orView);
    else if (d.orRgroup) { state.researchGroup = d.orRgroup; renderResearch(); }
    else if (d.orPgroup) { state.presetGroup = d.orPgroup; renderPresetGroup(); renderPresetButtons(); }
    else if (d.orPreset) loadPreset(d.orPreset);
    else if (d.orDraft) loadPreset(d.orDraft);
    else if ('orBlank' in d) clearForm();
    else if (d.orGoto) gotoCompany(d.orGoto);
    else if (d.orOut) showOut(d.orOut);
    else if (d.orStep) { state.emailStep = d.orStep; renderEmailStep(); }
    else if (d.orCopy) {
      const cur = currentEmail() || {};
      const text = { to: cur.to, subject: cur.subject, body: cur.body, call: last && last.call, linkedin: last && last.linkedin }[d.orCopy];
      if (text && d.orCopy === 'body') copyRich(text, el);
      else if (text) copyText(plainText(text), el);
    }
    else if (d.orScopy) { if (stratCopy[d.orScopy]) copyText(stratCopy[d.orScopy], el); }
    else if (d.orJump) jumpTo(d.orJump);
    else if (d.orSeq) openSequenceStep(d.orSeq);
    else if (d.orTpl) { showView('generator'); setVal('template', d.orTpl); regenerate(); root.scrollTop = 0; }
    else if (d.orKr) loadImporter(+d.orKr);
    else if ('orGmail' in d) openGmail(el);
    else if ('orSenderReset' in d) { try { localStorage.removeItem(SENDER_KEY); } catch (err) { /* ignore */ } renderSender(); regenerate(); }
    else if (d.orMxpreset) {
      state.mxPreset = d.orMxpreset;
      state.mx = mxDefaultFilters();
      MX_PRESETS[d.orMxpreset].apply(state.mx);
      renderMxControls();
      renderMxRows();
    }
  }

  // Tracker filters (stage, owner, due, search) re-render only the rows, so focus stays put.
  function trkFilter(t) {
    if (!t.dataset || !t.dataset.orTrkfilter) return false;
    state.trkF[t.dataset.orTrkfilter] = t.type === 'checkbox' ? t.checked : t.value;
    renderTrkRows();
    return true;
  }

  function onInput(e) {
    if (trkFilter(e.target)) return;
    const id = e.target.id;
    if (!id || !id.startsWith('or-')) return;
    if (id === 'or-email') setChk('generalInbox', isSharedInbox(e.target.value));
    if (id === 'or-phone') setChk('generalLine', isMainLine(e.target.value));
    if (['or-sname', 'or-stitle', 'or-sphone'].includes(id)) saveSender(readSender());
    if (e.target.closest('[data-or-pane="generator"]')) regenerate();
  }

  function onChange(e) {
    const t = e.target;
    if (trkFilter(t)) return;
    if (t.dataset.orAttach) { state.attachTicks[t.dataset.orAttach] = t.checked; regenerate(); return; }
    if (t.dataset.orMxkey) {
      const set = state.mx[t.dataset.orMxkey];
      if (t.checked) set.add(t.dataset.orMxval); else set.delete(t.dataset.orMxval);
      state.mxPreset = null;
      $$('[data-or-mxpreset]').forEach(b => b.classList.remove('active'));
      renderMxRows();
      return;
    }
    if (t.id === 'or-productStatus') state.attachTicks = {};
    if (t.closest && t.closest('[data-or-pane="generator"]')) regenerate();
  }

  const api = {
    mounted: false,
    mount,
    compose,
    checkData,
    // For deep links and tests: Outreach.show('generator', 'harbourleaf'), Outreach.show('strategy')
    show(view, key) { if (key && view === 'generator') loadPreset(key); else if (key) gotoCompany(key); else showView(view); },
    scoredPicks: () => scoredPicks(),
    _setData(d) { D = d; },
    // For outreach_check.js: every Tracker id, in list order.
    trackerIds() { return prospects().map(p => p.id); }
  };
  window.Outreach = api;
})();
