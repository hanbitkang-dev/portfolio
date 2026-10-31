// Fetch all KV keys with a given prefix, handling cursor pagination
async function kvListAll(kv, prefix) {
  const keys = [];
  let cursor;
  while (true) {
    const res = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...res.keys);
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  return keys;
}

// Roles (v3.29: enforced here, not only in the page). Everyone in the Cloudflare Access
// policy can sign in; anyone not listed is 'full'. The limited roles get ops.html (built
// without sales money, see build.py), only the assets in LIMITED_ASSETS, only the crm:prod_*
// KV keys (plus FX rates to read) and no other API -- no deals, orders, AI or deletes.
//   production  Production tab (without its Sales view)
//   ops         Production + Delays (Planning)
const ROLES = {
  'planner@example.com': 'ops',
};
const LIMITED_ASSETS = /^\/(production\.(js|css)|production_seed\.js|delays\.(js|css))$/;
const LIMITED_KV_READ = /^crm:(prod_|fx_rates$)/;
const LIMITED_KV_WRITE = /^crm:prod_/;
const canDelays = role => role === 'full' || role === 'ops';

// Who is signed in: the Cloudflare Access JWT (Cf-Access-Jwt-Assertion header, else the
// CF_Authorization cookie), with its signature checked against the team's public keys.
// Headers alone are never trusted. ACCESS_AUD (a Worker variable) pins the application;
// without it any app of this Access team is accepted.
const ACCESS_TEAM = 'https://demo-team.cloudflareaccess.com';
let accessKeys = null, accessKeysAt = 0;
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const b64uJson = s => JSON.parse(new TextDecoder().decode(b64u(s)));
async function accessKey(kid) {
  if (!accessKeys || !accessKeys[kid] || Date.now() - accessKeysAt > 3600e3) {
    const r = await fetch(ACCESS_TEAM + '/cdn-cgi/access/certs');
    if (!r.ok) throw new Error('Access certs HTTP ' + r.status);
    const keys = {};
    for (const k of (await r.json()).keys || []) {
      keys[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    }
    accessKeys = keys; accessKeysAt = Date.now();
  }
  return accessKeys[kid];
}
async function accessIdentity(request, env) {
  const cookie = (request.headers.get('cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const jwt = request.headers.get('cf-access-jwt-assertion') || (cookie && cookie[1]);
  if (!jwt) return null;
  try {
    const [h, p, s] = jwt.split('.');
    const head = b64uJson(h);
    if (head.alg !== 'RS256') return null;
    const key = await accessKey(head.kid);
    if (!key || !(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p)))) return null;
    const pl = b64uJson(p), now = Date.now() / 1000;
    if (pl.iss !== ACCESS_TEAM || !(pl.exp > now) || (pl.nbf && pl.nbf > now + 60)) return null;
    if (env.ACCESS_AUD && ![].concat(pl.aud).includes(env.ACCESS_AUD)) return null;
    return { email: String(pl.email || '').trim().toLowerCase(), aud: pl.aud, service: pl.common_name || '' };
  } catch (e) {
    console.warn('access token check failed:', e.message);
    return null;
  }
}

const json = (body, status, extra) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extra || {}) } });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(backupKv(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const id = await accessIdentity(request, env);
    // Kanban (Apps Script) posts with an Access service token, so it has no email; the
    // body must carry its signature.
    if (url.pathname === '/api/hooks/kanban') {
      if (!id) return json({ error: 'not signed in' }, 401);
      return request.method === 'POST' ? kanbanHook(request, env) : json({ error: 'method not allowed' }, 405);
    }
    if (!id || !id.email) {
      return url.pathname.startsWith('/api/') ? json({ error: 'sign-in could not be verified' }, 401)
        : new Response('Your sign-in could not be verified. Reload the page; if this keeps happening, tell Alex.', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const role = ROLES[id.email] || 'full';

    // API: /api/me -- who is signed in and which role the page should apply
    if (url.pathname === '/api/me' && request.method === 'GET') {
      return json({ email: id.email, role, aud: role === 'full' ? id.aud : undefined });
    }

    if (url.pathname.startsWith('/api/delays')) {
      if (!canDelays(role)) return json({ error: 'not allowed' }, 403);
      if (!env.DB) return json({ error: 'Delays database is not connected' }, 503);
      return delaysApi(request, env, url, id.email);
    }

    if (role !== 'full') {
      if (url.pathname === '/api/kv') {
        const key = url.searchParams.get('key') || '';
        const ok = request.method === 'GET' ? LIMITED_KV_READ.test(key) : request.method === 'PUT' && LIMITED_KV_WRITE.test(key);
        if (!ok) return json({ error: 'not allowed' }, 403);
      } else if (url.pathname.startsWith('/api/')) {
        return json({ error: 'not allowed' }, 403);
      } else if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/index') {
        return env.ASSETS.fetch(new Request(new URL('/ops', url), request));
      } else if (!LIMITED_ASSETS.test(url.pathname)) {
        return new Response('Not available for your role.', { status: 403 });
      }
    }

    // API: /api/kv?key=xxx
    if (url.pathname === '/api/kv') {
      const key = url.searchParams.get('key');
      if (!key) return new Response('missing key', { status: 400 });

      if (request.method === 'GET') {
        const val = await env.CRM_KV.get(key);
        return new Response(val ?? 'null', { headers: cors });
      }

      if (request.method === 'PUT') {
        const body = await request.text();
        await env.CRM_KV.put(key, body);
        return new Response('ok', { headers: cors });
      }

      if (request.method === 'DELETE') {
        await env.CRM_KV.delete(key);
        return new Response('ok', { headers: cors });
      }

      return new Response('method not allowed', { status: 405 });
    }

    // API: /api/deals — list all individual deal keys
    if (url.pathname === '/api/deals' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:deal:');
      const deals = await Promise.all(
        keys.map(async k => {
          const val = await env.CRM_KV.get(k.name);
          try { return JSON.parse(val); } catch { return null; }
        })
      );
      return new Response(JSON.stringify(deals.filter(Boolean)), { headers: cors });
    }

    // API: /api/orders — accumulated order-line records.
    // Stored as ONE blob (crm:orders_bulk) instead of one KV key per row --
    // free-tier Workers KV caps out at 1000 PUTs/day, and there are thousands
    // of order lines, so per-row keys blow the budget on every reconcile.
    // Per-record manual edits (type override, dismissed flag) are rare user
    // actions, so those alone get individual keys (crm:order_override:*).
    if (url.pathname === '/api/orders' && request.method === 'GET') {
      const bulkRaw = await env.CRM_KV.get('crm:orders_bulk');
      let bulk = [];
      try { bulk = JSON.parse(bulkRaw) || []; } catch {}

      const overrideKeys = await kvListAll(env.CRM_KV, 'crm:order_override:');
      const overrides = {};
      await Promise.all(overrideKeys.map(async k => {
        const val = await env.CRM_KV.get(k.name);
        try { overrides[k.name.slice('crm:order_override:'.length)] = JSON.parse(val); } catch {}
      }));

      const merged = bulk.map(o => {
        // so+code alone isn't unique -- a few orders split the same product across
        // two require-date batches, so require_date disambiguates them (must match
        // orderLineKey() in template.html).
        const key = o.so + '_' + o.code + '_' + (o.require_date || '');
        const ov = overrides[key];
        return ov ? Object.assign({}, o, ov) : o;
      });
      return new Response(JSON.stringify(merged), { headers: cors });
    }

    // API: /api/product_feedback — list all individual product feedback (QC/label/
    // quality issue) keys. Rare-write collection (a handful of entries a month at
    // most), so individual crm:product_feedback:<id> keys are fine -- same pattern
    // as /api/deals and /api/activities, not the single-blob pattern used for
    // thousands-of-rows order data.
    if (url.pathname === '/api/product_feedback' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:product_feedback:');
      const items = await Promise.all(
        keys.map(async k => {
          const val = await env.CRM_KV.get(k.name);
          try { return JSON.parse(val); } catch { return null; }
        })
      );
      const sorted = items.filter(Boolean).sort((a,b) => (b.date||'') < (a.date||'') ? -1 : 1);
      return new Response(JSON.stringify(sorted), { headers: cors });
    }

    // API: /api/meetings — list all individual client meeting log keys. Rare-write
    // collection (a handful of entries a month at most), same individual-key pattern
    // as /api/product_feedback -- each record is just a date/topic/link, so storage
    // per entry is tiny.
    if (url.pathname === '/api/meetings' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:meeting:');
      const items = await Promise.all(
        keys.map(async k => {
          const val = await env.CRM_KV.get(k.name);
          try { return JSON.parse(val); } catch { return null; }
        })
      );
      const sorted = items.filter(Boolean).sort((a,b) => (b.date||'') < (a.date||'') ? -1 : 1);
      return new Response(JSON.stringify(sorted), { headers: cors });
    }

    // API: /api/account_notes — list all individual account-handover note keys.
    // Threaded per customer (multiple entries over time, each its own key) rather
    // than one growing blob per customer, same rare-write pattern as
    // /api/product_feedback and /api/meetings.
    if (url.pathname === '/api/account_notes' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:account_note:');
      const items = await Promise.all(
        keys.map(async k => {
          const val = await env.CRM_KV.get(k.name);
          try { return JSON.parse(val); } catch { return null; }
        })
      );
      const sorted = items.filter(Boolean).sort((a,b) => (b.date||'') < (a.date||'') ? -1 : 1);
      return new Response(JSON.stringify(sorted), { headers: cors });
    }

    // API: /api/activities — list all individual activity keys
    if (url.pathname === '/api/activities' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:act:');
      const acts = await Promise.all(
        keys.map(async k => {
          const val = await env.CRM_KV.get(k.name);
          try { return JSON.parse(val); } catch { return null; }
        })
      );
      const sorted = acts.filter(Boolean).sort((a,b) => (a.id||'') < (b.id||'') ? -1 : 1);
      return new Response(JSON.stringify(sorted), { headers: cors });
    }

    // API: /api/outreach — Outreach tracker, one record per prospect (crm:outreach:<id>)
    if (url.pathname === '/api/outreach' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:outreach:');
      const recs = await Promise.all(
        keys.map(async k => {
          const val = await env.CRM_KV.get(k.name);
          try { return JSON.parse(val); } catch { return null; }
        })
      );
      return new Response(JSON.stringify(recs.filter(Boolean)), { headers: cors });
    }

    // API: /api/remarks — customer remarks by individual key
    if (url.pathname === '/api/remarks' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:remark:');
      const result = {};
      await Promise.all(keys.map(async k => {
        const customer = k.name.slice('crm:remark:'.length);
        const val = await env.CRM_KV.get(k.name);
        try { result[customer] = JSON.parse(val); } catch {}
      }));
      return new Response(JSON.stringify(result), { headers: cors });
    }

    // API: /api/product_remarks — product remarks by individual key
    if (url.pathname === '/api/product_remarks' && request.method === 'GET') {
      const keys = await kvListAll(env.CRM_KV, 'crm:product_remark:');
      const result = {};
      await Promise.all(keys.map(async k => {
        const code = k.name.slice('crm:product_remark:'.length);
        const val = await env.CRM_KV.get(k.name);
        try { result[code] = JSON.parse(val); } catch {}
      }));
      return new Response(JSON.stringify(result), { headers: cors });
    }

    // API: /api/production_insight — on-demand Gemini conversation about the
    // Production tab's Year-over-Year-by-type table. Only ever called when the
    // user clicks "Ask AI" or sends a chat message (never on tab load/re-render),
    // to keep Gemini usage low. Takes { table, history, query }: history is the
    // prior turns of THIS conversation so the user can push back on a claim (e.g.
    // "Liquid is tiny % of revenue, not a real concern") and get it factored in,
    // instead of a one-shot verdict that can't be corrected.
    if (url.pathname === '/api/production_insight' && request.method === 'POST') {
      try {
        const { table, history, query, isUserContext } = await request.json();
        const rows = (table || []).map(r =>
          `${r.type} (${r.unit}): ` + Object.keys(r.years).sort().map(y => `${y}=${r.years[y]}`).join(', ')
        ).join('\n');

        // Shared memory across users/sessions: whenever someone adds real context in
        // the chat (isUserContext), it's appended here (single blob, capped) and fed
        // into every future conversation's system prompt -- so a correction one person
        // makes (e.g. "Liquid is a tiny share of revenue, the decline isn't a concern")
        // sticks around and improves insights for everyone after them, not just that
        // one chat session. This is a persisted-notes list, not model fine-tuning.
        const notesRaw = await env.CRM_KV.get('crm:production_insight_notes');
        let notes = [];
        try { notes = JSON.parse(notesRaw) || []; } catch {}
        const notesBlock = notes.length
          ? `\n\nContext learned from previous conversations with other team members (may be outdated -- weigh against the current numbers above, don't just repeat it verbatim):\n${notes.map(n => `- ${n}`).join('\n')}`
          : '';

        const systemPrompt = `You are a production data analyst for a health-supplement OEM manufacturer, in conversation with a member of the sales/production team about their production trend data.

Annual production volume by dosage form/type (unit shown in parentheses):
${rows || 'No data'}${notesBlock}

Discuss notable trends (growing vs. declining types), plausible reasons behind them, and anything worth considering strategically. When the user adds context or pushes back on something you said (e.g. a type is a small share of total volume/revenue so a decline there isn't actually concerning), take that into account and revise your view instead of repeating the same point. Keep replies to a few concise, plain-English sentences or a short paragraph -- no markdown, no bullet-point lists unless asked for one.`;

        const contents = [];
        (history || []).forEach(h => {
          contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
        });
        contents.push({ role: 'user', parts: [{ text: query || 'Please share your initial analysis of this data.' }] });

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents,
              // gemini-flash-latest is a "thinking" model that spends part of the token
              // budget on an internal reasoning part before the real answer, and some
              // models behind this alias reject thinkingBudget:0 outright ("invalid
              // argument") -- so just give it enough room for both instead of disabling it.
              generationConfig: { temperature: 0.4, maxOutputTokens: 3072 }
            })
          }
        );

        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) {
          return new Response(JSON.stringify({ error: geminiData.error?.message || 'Gemini error' }), { status: 500, headers: cors });
        }

        const parts = geminiData.candidates?.[0]?.content?.parts || [];
        const answer = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim() || 'Could not generate an insight.';

        // Persist genuine user-typed context (not the synthetic kickoff prompt) as a
        // new shared note, deduped and capped so this stays a short, curated list
        // rather than an ever-growing transcript.
        if (isUserContext && query && query.trim().length > 12 && !notes.includes(query.trim())) {
          const updated = notes.concat([query.trim()]).slice(-60);
          await env.CRM_KV.put('crm:production_insight_notes', JSON.stringify(updated));
        }

        return new Response(JSON.stringify({ answer }), { headers: cors });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // API: /api/pipeline_insight — on-demand Gemini conversation about the
    // Pipeline tab's Funnel & Table view (same shape/philosophy as
    // /api/production_insight above: only called on explicit user action,
    // shared memory across conversations via a capped notes list).
    if (url.pathname === '/api/pipeline_insight' && request.method === 'POST') {
      try {
        const { data, history, query, isUserContext } = await request.json();
        const d = data || {};
        const funnelLine = (d.funnel || []).map(f => `${f.stage}=${f.everReached}`).join(', ');
        const reasonsLine = (label, arr) => (arr && arr.length)
          ? `${label}: ` + arr.map(r => `"${r.reason}" x${r.count}`).join(', ')
          : `${label}: none recorded`;

        const summary = `Funnel (deals that ever reached each stage): ${funnelLine || 'no data'}
Won: ${d.won ?? 0}, Drop: ${d.drop ?? 0}
${reasonsLine('Drop reasons', d.dropReasons)}
${reasonsLine('Won reasons', d.wonReasons)}
${reasonsLine('Current stall reasons (active deals stuck mid-stage)', d.stallReasons)}`;

        const pipeNotesRaw = await env.CRM_KV.get('crm:pipeline_insight_notes');
        let pipeNotes = [];
        try { pipeNotes = JSON.parse(pipeNotesRaw) || []; } catch {}
        const pipeNotesBlock = pipeNotes.length
          ? `\n\nContext learned from previous conversations with other team members (may be outdated -- weigh against the current numbers above, don't just repeat it verbatim):\n${pipeNotes.map(n => `- ${n}`).join('\n')}`
          : '';

        const pipeSystemPrompt = `You are a sales pipeline analyst for a health-supplement OEM manufacturer, in conversation with a member of the sales team about their deal pipeline data.

${summary}${pipeNotesBlock}

Discuss where deals are winning, losing, or getting stuck, what the recorded reasons suggest is really going on, and what's worth considering strategically (e.g. process changes, which reasons to address first, whether a stage is a bottleneck). When the user adds context or pushes back on something you said, take that into account and revise your view instead of repeating the same point. Keep replies to a few concise, plain-English sentences or a short paragraph -- no markdown, no bullet-point lists unless asked for one.`;

        const pipeContents = [];
        (history || []).forEach(h => {
          pipeContents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
        });
        pipeContents.push({ role: 'user', parts: [{ text: query || 'Please share your initial analysis of this pipeline data.' }] });

        const pipeGeminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: pipeSystemPrompt }] },
              contents: pipeContents,
              generationConfig: { temperature: 0.4, maxOutputTokens: 3072 }
            })
          }
        );

        const pipeGeminiData = await pipeGeminiRes.json();
        if (!pipeGeminiRes.ok) {
          return new Response(JSON.stringify({ error: pipeGeminiData.error?.message || 'Gemini error' }), { status: 500, headers: cors });
        }

        const pipeParts = pipeGeminiData.candidates?.[0]?.content?.parts || [];
        const pipeAnswer = pipeParts.filter(p => !p.thought).map(p => p.text || '').join('').trim() || 'Could not generate an insight.';

        if (isUserContext && query && query.trim().length > 12 && !pipeNotes.includes(query.trim())) {
          const pipeUpdated = pipeNotes.concat([query.trim()]).slice(-60);
          await env.CRM_KV.put('crm:pipeline_insight_notes', JSON.stringify(pipeUpdated));
        }

        return new Response(JSON.stringify({ answer: pipeAnswer }), { headers: cors });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // API: /api/ask  — Gemini-powered CRM assistant
    if (url.pathname === '/api/ask' && request.method === 'POST') {
      try {
        const { query, history, deals, customers, activities } = await request.json();

        const today = new Date().toISOString().slice(0, 10);

        // Build context summary
        const dealSummary = (deals || []).map(d =>
          `[${d.stage}] ${d.title} / ${d.customer} / 담당:${d.owner} / NZD${d.estValue||0} / 확률${d.probability||0}% / 시작:${d.startDate||d.created||'?'} / 종결예정:${d.closeDate||'?'}${d.closeReason?' / 종결사유:'+d.closeReason:''}${d.dwellNote?' / 체류메모:'+d.dwellNote:''}`
        ).join('\n');

        const custSummary = (customers || []).slice(0, 80).map(c =>
          `${c.name} (담당:${c.rep||'?'}, 매출NZD:${c.nzd||0}, 주문${c.orders||0}건)`
        ).join('\n');

        const actSummary = (activities || []).slice(-40).map(a =>
          `[${a.date||a.ts?.slice(0,10)}] ${a.dealId} / ${a.actType} / ${a.summary||a.note} (${a.owner||''})`
        ).join('\n');

        const systemPrompt = `당신은 Demo Labs(Demo Labs) CRM 전용 AI 어시스턴트입니다.
오늘 날짜: ${today}
회사: Demo Labs NZ — 건강기능식품 B2B 영업팀 CRM

아래 데이터를 기반으로 질문에 답하세요. 데이터에 없는 내용은 "데이터에서 확인되지 않습니다"라고 답하세요.
숫자는 NZD 기준이며, 딜 금액은 Est. Value 기준입니다.
답변은 한국어로, 간결하고 실용적으로 해주세요. 마크다운 사용 가능.

=== 딜 현황 (${(deals||[]).length}건) ===
${dealSummary || '없음'}

=== 고객사 현황 (${(customers||[]).length}개사) ===
${custSummary || '없음'}

=== 최근 Activity (${(activities||[]).length}건) ===
${actSummary || '없음'}`;

        // Build Gemini contents with conversation history
        const contents = [];
        (history || []).forEach(msg => {
          contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
        });
        contents.push({ role: 'user', parts: [{ text: query }] });

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents,
              generationConfig: { temperature: 0.3, maxOutputTokens: 3072 }
            })
          }
        );

        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) {
          return new Response(JSON.stringify({ error: geminiData.error?.message || 'Gemini error' }), { status: 500, headers: cors });
        }

        const answer = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '답변을 생성할 수 없었어요.';
        return new Response(JSON.stringify({ answer }), { headers: cors });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // Static assets fallback
    return env.ASSETS.fetch(request);
  },
};

/* ── Delays (v3.29) ── D1 (binding DB), schema in migrations/. One row per change, so two
   people saving at once never overwrite each other, and Delays doesn't use the shared KV
   write budget. Every write also lands in `audit` (who, when, old -> new).
     line_review  the verdict on one completed order line (key = SO|code|required date)
     so_step      stage dates per SO and source (manual | kanban | cin7)
     setting      lead-time standards
     kanban_*     what the Kanban boards sent (/api/hooks/kanban)                         */
const nowIso = () => new Date().toISOString();
const nzDate = iso => { const d = new Date(iso); return isNaN(d) ? null : d.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); };
const RE = {
  so: /^SO\d{3,6}$/, key: /^SO\d{3,6}\|[^|]{1,40}\|(\d{4}-\d{2}-\d{2})?$/, step: /^s\d[abc]?$/, cause: /^[A-Z]{2}-\d{1,2}$/,
  date: /^\d{4}-\d{2}-\d{2}$/, board: /^[a-z0-9-]{1,40}$/,
};
const CTRL = ['internal', 'external', 'customer'];
const SETTINGS = ['lead_std', 'lead_type'];
const txt = (v, n) => v == null || v === '' ? null : String(v).slice(0, n || 2000);
const pick = (v, ok) => v == null || v === '' ? null : ok(v) ? v : undefined;
const audit = (env, who, kind, ref, body) => env.DB.prepare('INSERT INTO audit (at, who, kind, ref, body) VALUES (?1, ?2, ?3, ?4, ?5)').bind(nowIso(), who, kind, ref, JSON.stringify(body));

async function delaysApi(request, env, url, who) {
  const path = url.pathname.slice('/api/delays'.length) || '/';
  try {
    if (request.method === 'GET' && path === '/') return json(await delaysState(env));
    if (request.method === 'GET' && path === '/audit') {
      // one line's verdict history plus its SO's stage edits (refs SO|s1 ... SO|s9)
      const ref = url.searchParams.get('ref') || '', so = url.searchParams.get('so') || '';
      const { results } = await env.DB.prepare("SELECT at, who, kind, body FROM audit WHERE ref = ?1 OR (?2 <> '' AND ref LIKE ?2 || '|s%') ORDER BY id DESC LIMIT 60")
        .bind(ref, RE.so.test(so) ? so : '').all();
      return json(results);
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const b = await request.json();
    if (path === '/review') return json(await saveReview(env, who, b));
    if (path === '/step') return json(await saveStep(env, who, b));
    if (path === '/setting') {
      if (!SETTINGS.includes(b.k) || !b.v || typeof b.v !== 'object') return json({ error: 'bad setting' }, 400);
      const v = {};
      for (const [k, n] of Object.entries(b.v)) if (/^[a-z0-9 _-]{1,30}$/.test(k) && Number.isFinite(+n) && +n >= 0 && +n <= 400) v[k] = Math.round(+n);
      const old = await env.DB.prepare('SELECT v FROM setting WHERE k = ?1').bind(b.k).first();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO setting (k, v, who, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(k) DO UPDATE SET v = excluded.v, who = excluded.who, at = excluded.at').bind(b.k, JSON.stringify(v), who, nowIso()),
        audit(env, who, 'setting', b.k, { old: old ? JSON.parse(old.v) : null, new: v }),
      ]);
      return json({ ok: true });
    }
    if (path === '/cases') return json(await addCases(env, who, b));
    if (path === '/kanban_map') {
      if (!RE.board.test(b.board || '') || !b.card || String(b.card).length > 80 || (b.so && !RE.so.test(b.so))) return json({ error: 'bad card' }, 400);
      const row = await env.DB.prepare('SELECT COALESCE(so_manual, so_auto) AS so FROM kanban_card WHERE board = ?1 AND card = ?2').bind(b.board, b.card).first();
      if (!row) return json({ error: 'no such card' }, 404);
      await env.DB.batch([
        env.DB.prepare('UPDATE kanban_card SET so_manual = ?3 WHERE board = ?1 AND card = ?2').bind(b.board, b.card, b.so || null),
        audit(env, who, 'kanban_map', b.board + '|' + b.card, { old: row.so, new: b.so || null }),
      ]);
      await rederive(env, [row.so, b.so].filter(Boolean));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function delaysState(env) {
  const [rv, st, se, boards, unmatched, recent] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM line_review'),
    env.DB.prepare('SELECT so, step, src, started, done, note, cause, ask, who, at FROM so_step'),
    env.DB.prepare('SELECT k, v, who, at FROM setting'),
    env.DB.prepare('SELECT board, COUNT(*) AS events, COUNT(DISTINCT card) AS cards, MAX(received_at) AS last FROM kanban_event GROUP BY board'),
    env.DB.prepare("SELECT board, card, title, last_at FROM kanban_card WHERE COALESCE(so_manual, so_auto) IS NULL ORDER BY last_at DESC LIMIT 200"),
    env.DB.prepare('SELECT e.board, e.card, e.title, e.type, e.from_col, e.to_col, e.at, COALESCE(c.so_manual, c.so_auto) AS so FROM kanban_event e LEFT JOIN kanban_card c ON c.board = e.board AND c.card = e.card ORDER BY e.at DESC LIMIT 30'),
  ]);
  const settings = {};
  for (const r of se.results) { try { settings[r.k] = { v: JSON.parse(r.v), who: r.who, at: r.at }; } catch (e) { /* skip a bad row */ } }
  return {
    reviews: rv.results, steps: st.results, settings,
    kanban: { boards: boards.results, unmatched: unmatched.results, recent: recent.results, rules: KANBAN_RULES },
    sources: { hook: !!env.KANBAN_HOOK_SECRET, cin7: false },
  };
}

// One line's verdict. 'save' keeps a confirmed verdict confirmed only if the verdict
// itself (stage, cause, control, note, prevention) didn't change.
async function saveReview(env, who, b) {
  if (!RE.key.test(b.key || '') || !RE.so.test(b.so || '') || b.key.split('|')[0] !== b.so) throw new Error('bad line key');
  const p = b.patch || {};
  const v = {
    step: pick(p.step, x => RE.step.test(x)), cause: pick(p.cause, x => RE.cause.test(x)), ctrl: pick(p.ctrl, x => CTRL.includes(x)),
    note: txt(p.note), prevent: txt(p.prevent), why: txt(p.why),
    is_case: p.is_case ? 1 : 0, incl: p.incl === 0 || p.incl === 1 ? p.incl : null,
  };
  if (Object.values(v).includes(undefined)) throw new Error('bad value');
  const old = await env.DB.prepare('SELECT * FROM line_review WHERE key = ?1').bind(b.key).first();
  const verdictSame = old && ['step', 'cause', 'ctrl', 'note', 'prevent'].every(k => (old[k] || null) === v[k]);
  let status = v.cause ? 'proposed' : 'open', cby = null, cat = null;
  if (b.action === 'confirm') {
    if (!v.cause || !v.step) throw new Error('a confirmed verdict needs a stage and a cause');
    status = 'confirmed'; cby = who; cat = nowIso();
  } else if (b.action !== 'unconfirm' && old && old.status === 'confirmed' && verdictSame) {
    status = 'confirmed'; cby = old.confirmed_by; cat = old.confirmed_at;
  }
  const row = { key: b.key, so: b.so, ...v, status, updated_by: who, updated_at: nowIso(), confirmed_by: cby, confirmed_at: cat };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
      ON CONFLICT(key) DO UPDATE SET step = excluded.step, cause = excluded.cause, ctrl = excluded.ctrl, note = excluded.note, prevent = excluded.prevent,
        why = excluded.why, is_case = excluded.is_case, incl = excluded.incl, status = excluded.status, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`)
      .bind(row.key, row.so, row.step, row.cause, row.ctrl, row.note, row.prevent, row.why, row.is_case, row.incl, row.status, row.updated_by, row.updated_at, row.confirmed_by, row.confirmed_at),
    audit(env, who, 'review:' + (b.action || 'save'), b.key, { old, new: v, status }),
  ]);
  return row;
}

// A stage typed in by hand (src 'manual'). An empty row is deleted.
async function saveStep(env, who, b) {
  if (!RE.so.test(b.so || '') || !RE.step.test(b.step || '')) throw new Error('bad stage');
  const v = {
    started: pick(b.started, x => RE.date.test(x)), done: pick(b.done, x => RE.date.test(x)),
    note: txt(b.note), cause: pick(b.cause, x => RE.cause.test(x)), ask: b.ask ? 1 : 0,
  };
  if (Object.values(v).includes(undefined)) throw new Error('bad value');
  const old = await env.DB.prepare("SELECT started, done, note, cause, ask FROM so_step WHERE so = ?1 AND step = ?2 AND src = 'manual'").bind(b.so, b.step).first();
  const empty = !v.started && !v.done && !v.note && !v.cause && !v.ask;
  await env.DB.batch([
    empty ? env.DB.prepare("DELETE FROM so_step WHERE so = ?1 AND step = ?2 AND src = 'manual'").bind(b.so, b.step)
      : env.DB.prepare(`INSERT INTO so_step (so, step, src, started, done, note, cause, ask, who, at) VALUES (?1, ?2, 'manual', ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(so, step, src) DO UPDATE SET started = excluded.started, done = excluded.done, note = excluded.note, cause = excluded.cause,
          ask = excluded.ask, who = excluded.who, at = excluded.at`).bind(b.so, b.step, v.started, v.done, v.note, v.cause, v.ask, who, nowIso()),
    audit(env, who, 'step', b.so + '|' + b.step, { old, new: v }),
  ]);
  return { ok: true };
}

// Mark lines as review cases (and the stages to ask about) in one go. Never overwrites a
// verdict that is already there.
async function addCases(env, who, b) {
  const lines = (b.lines || []).filter(l => RE.key.test(l.key || '') && RE.so.test(l.so || '')).slice(0, 50)
    .map(l => ({ key: l.key, so: l.so, why: txt(l.why) }));
  const asks = (b.asks || []).filter(a => RE.so.test(a.so || '') && RE.step.test(a.step || '')).slice(0, 200).map(a => ({ so: a.so, step: a.step }));
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO line_review (key, so, why, is_case, status, updated_by, updated_at)
      SELECT json_extract(value, '$.key'), json_extract(value, '$.so'), json_extract(value, '$.why'), 1, 'open', ?2, ?3 FROM json_each(?1) WHERE true
      ON CONFLICT(key) DO UPDATE SET is_case = 1, why = COALESCE(line_review.why, excluded.why)`).bind(JSON.stringify(lines), who, at),
    env.DB.prepare(`INSERT INTO so_step (so, step, src, ask, who, at)
      SELECT json_extract(value, '$.so'), json_extract(value, '$.step'), 'manual', 1, ?2, ?3 FROM json_each(?1) WHERE true
      ON CONFLICT(so, step, src) DO UPDATE SET ask = 1`).bind(JSON.stringify(asks), who, at),
    audit(env, who, 'cases', null, { lines: lines.map(l => l.key), asks: asks.length }),
  ]);
  return { ok: true, lines: lines.length, asks: asks.length };
}

/* ── Kanban -> CRM (one way). Apps Script posts changes here every few minutes:
     POST /api/hooks/kanban   (Cloudflare Access service token headers)
     X-Demo Labs-Signature: sha256=<hex HMAC-SHA256 of the raw body with KANBAN_HOOK_SECRET>
     { board, sent_at, events: [{ id, card, title, type, from, to, labels, by, at }] }
   Events are kept as sent (an id seen before is ignored, so a failed batch can simply be
   sent again); stage dates are then re-derived from every event of the SOs touched.
   A card's SO comes from its title ("[SO-02787] ...") unless someone set it in Delays.
   KANBAN_RULES: which column / label means which stage. Names are from the boards as seen
   on 2026-10-28 -- confirm them with IT (question 12) before relying on them. ── */
const KANBAN_RULES = {
  'artwork': [{ to: 'Preparing', step: 's3b', set: 'started' }, { to: 'Completed', step: 's3b', set: 'done' }],
  'warehouse-load-out': [
    { to: 'Request', step: 's9', set: 'started' }, { to: 'Waiting for COA', step: 's8', set: 'started' },
    { label: 'CoA completed', step: 's8', set: 'done' }, { label: 'Released', step: 's8', set: 'done' },
    { to: 'Complete', step: 's9', set: 'done' },
  ],
  'quality-others': [],
  'manufacturing': [],
};
const soFromTitle = t => { const m = /\bSO[-\s]?0*(\d{3,5})\b/i.exec(t || ''); return m ? 'SO' + m[1].padStart(5, '0') : null; };
const hexBytes = h => /^[0-9a-f]{64}$/i.test(h) ? Uint8Array.from(h.match(/../g), x => parseInt(x, 16)) : null;

async function kanbanHook(request, env) {
  if (!env.KANBAN_HOOK_SECRET) return json({ error: 'hook not configured' }, 503);
  if (!env.DB) return json({ error: 'database not connected' }, 503);
  const raw = await request.text();
  if (raw.length > 1e6) return json({ error: 'too large' }, 413);
  const sig = hexBytes((request.headers.get('x-demolabs-signature') || '').replace(/^sha256=/, ''));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.KANBAN_HOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!sig || !(await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(raw)))) return json({ error: 'bad signature' }, 401);
  let b;
  try { b = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, 400); }
  if (!Object.prototype.hasOwnProperty.call(KANBAN_RULES, b.board)) return json({ error: 'unknown board' }, 400);
  const at = nowIso(), events = [], cards = {};
  for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, 500)) {
    const when = e && e.at && !isNaN(new Date(e.at)) ? new Date(e.at).toISOString() : null;
    if (!e || !e.id || !e.card || !when) continue;
    const ev = {
      id: String(e.id).slice(0, 100), card: String(e.card).slice(0, 80), title: txt(e.title, 300), type: txt(e.type, 30),
      from: txt(e.from, 80), to: txt(e.to, 80), by: txt(e.by, 120), at: when,
      labels: JSON.stringify((Array.isArray(e.labels) ? e.labels : []).slice(0, 20).map(l => String(l).slice(0, 60))),
    };
    events.push(ev);
    const c = cards[ev.card];
    if (!c || c.last_at < when) cards[ev.card] = { card: ev.card, title: ev.title, so: soFromTitle(ev.title) || (c && c.so) || null, last_at: when };
    else if (!c.so) c.so = soFromTitle(ev.title);
  }
  if (!events.length) return json({ ok: true, events: 0 });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO kanban_card (board, card, title, so_auto, last_at)
      SELECT ?1, json_extract(value, '$.card'), json_extract(value, '$.title'), json_extract(value, '$.so'), json_extract(value, '$.last_at') FROM json_each(?2) WHERE true
      ON CONFLICT(board, card) DO UPDATE SET
        title = CASE WHEN excluded.last_at >= COALESCE(kanban_card.last_at, '') THEN COALESCE(excluded.title, kanban_card.title) ELSE kanban_card.title END,
        so_auto = COALESCE(excluded.so_auto, kanban_card.so_auto),
        last_at = MAX(COALESCE(kanban_card.last_at, ''), excluded.last_at)`).bind(b.board, JSON.stringify(Object.values(cards))),
    env.DB.prepare(`INSERT OR IGNORE INTO kanban_event (id, board, card, title, type, from_col, to_col, labels, who, at, received_at)
      SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.card'), json_extract(value, '$.title'), json_extract(value, '$.type'),
        json_extract(value, '$.from'), json_extract(value, '$.to'), json_extract(value, '$.labels'), json_extract(value, '$.by'), json_extract(value, '$.at'), ?3
      FROM json_each(?2)`).bind(b.board, JSON.stringify(events), at),
  ]);
  const { results } = await env.DB.prepare('SELECT DISTINCT COALESCE(so_manual, so_auto) AS so FROM kanban_card WHERE board = ?1 AND card IN (SELECT value FROM json_each(?2))')
    .bind(b.board, JSON.stringify(Object.keys(cards))).all();
  await rederive(env, results.map(r => r.so).filter(Boolean));
  return json({ ok: true, events: events.length });
}

async function rederive(env, sos) {
  sos = [...new Set(sos)];
  if (!sos.length) return;
  const list = JSON.stringify(sos);
  const { results } = await env.DB.prepare(`SELECT e.board, e.to_col, e.labels, e.at, COALESCE(c.so_manual, c.so_auto) AS so
    FROM kanban_event e JOIN kanban_card c ON c.board = e.board AND c.card = e.card
    WHERE COALESCE(c.so_manual, c.so_auto) IN (SELECT value FROM json_each(?1))`).bind(list).all();
  const steps = {};
  for (const e of results) {
    let labels = [];
    try { labels = JSON.parse(e.labels || '[]'); } catch (x) { /* none */ }
    for (const r of KANBAN_RULES[e.board] || []) {
      if (r.to ? e.to_col !== r.to : !labels.includes(r.label)) continue;
      const s = steps[e.so + '|' + r.step] || (steps[e.so + '|' + r.step] = { so: e.so, step: r.step, started: null, done: null });
      const d = nzDate(e.at);
      if (d && (!s[r.set] || d < s[r.set])) s[r.set] = d; // the first time it got there
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM so_step WHERE src = 'kanban' AND so IN (SELECT value FROM json_each(?1))").bind(list),
    env.DB.prepare(`INSERT INTO so_step (so, step, src, started, done, who, at)
      SELECT json_extract(value, '$.so'), json_extract(value, '$.step'), 'kanban', json_extract(value, '$.started'), json_extract(value, '$.done'), 'Kanban', ?2
      FROM json_each(?1)`).bind(JSON.stringify(Object.values(steps)), nowIso()),
  ]);
}

/* ── Daily KV backup (cron in wrangler.jsonc) into D1 kv_backup, kept 14 days. Skips the old
   one-key-per-order-line leftovers (crm:order:*) and the upload snapshots (crm:prod_snap:*,
   written once and never changed). Values over 500K characters are split into parts.
   Restore by hand: SELECT value FROM kv_backup WHERE day = ? AND key = ? ORDER BY part. ── */
async function backupKv(env) {
  if (!env.DB) return;
  const day = nzDate(nowIso());
  const keys = (await kvListAll(env.CRM_KV, 'crm:')).map(k => k.name).filter(k => !k.startsWith('crm:order:') && !k.startsWith('crm:prod_snap:'));
  const rows = [];
  for (let i = 0; i < keys.length; i += 20) {
    const vals = await Promise.all(keys.slice(i, i + 20).map(k => env.CRM_KV.get(k)));
    vals.forEach((v, j) => {
      if (v == null) return;
      for (let p = 0; p * 5e5 < v.length || p === 0; p++) rows.push([keys[i + j], p, v.slice(p * 5e5, (p + 1) * 5e5)]);
    });
  }
  // up to 30 small rows per statement (3 bound values each, the limit is 100); a big part alone
  const stmts = [env.DB.prepare('DELETE FROM kv_backup WHERE day = ?1 OR day < ?2').bind(day, nzDate(new Date(Date.now() - 14 * 864e5).toISOString()))];
  let group = [], size = 0;
  const flush = () => {
    if (!group.length) return;
    stmts.push(env.DB.prepare('INSERT INTO kv_backup (day, key, part, value) VALUES ' + group.map(() => "('" + day + "', ?, ?, ?)").join(', ')).bind(...group.flat()));
    group = []; size = 0;
  };
  for (const r of rows) {
    if (group.length >= 30 || size + r[2].length > 5e5) flush();
    group.push(r); size += r[2].length;
  }
  flush();
  stmts.push(env.DB.prepare("INSERT INTO setting (k, v, who, at) VALUES ('backup_last', ?1, 'cron', ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at")
    .bind(JSON.stringify({ day, keys: keys.length, chars: rows.reduce((n, r) => n + r[2].length, 0) }), nowIso()));
  await env.DB.batch(stmts);
}
