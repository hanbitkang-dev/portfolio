/* Apps Script backend (Code.js), unchanged apart from removed confidential values. */
// ================================================================
// CONFIGURATION
// ================================================================

// 배포 버전 — major.minor 규칙은 CLAUDE.md "버전 관리" 참고. 배포 시 이 값과 clasp deploy 설명을 함께 갱신.
var APP_VERSION = 'v1.33';


function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    SPREADSHEET_ID:              props.getProperty('SPREADSHEET_ID'),
    RAW_COST_SPREADSHEET_ID:     props.getProperty('RAW_COST_SPREADSHEET_ID'),
    PKG_COST_SPREADSHEET_ID:     props.getProperty('PKG_COST_SPREADSHEET_ID'),
    BOM_SPREADSHEET_ID:          props.getProperty('BOM_SPREADSHEET_ID'),
    SUPPLY_PRICE_SPREADSHEET_ID: props.getProperty('SUPPLY_PRICE_SPREADSHEET_ID'),
    // 상대방 툴 URL — GAS 배포 후 ScriptProperties에 등록
    RD_TOOLKIT_URL:              props.getProperty('RD_TOOLKIT_URL'),
  };
}

// SPREADSHEET_ID가 미설정이면 자동 생성 후 ScriptProperties에 저장
function getOrCreateMainSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty('SPREADSHEET_ID');
  if (!id) {
    var ss = SpreadsheetApp.create('Demo Labs Sales Pricing Data');
    props.setProperty('SPREADSHEET_ID', ss.getId());
    return ss;
  }
  return SpreadsheetApp.openById(id);
}

// raw_cost 소스 시트 — 메인 스프레드시트의 'raw_cost' 탭이 있으면 우선 사용,
// 없으면 기존 별도 스프레드시트(RAW_COST_SPREADSHEET_ID) 폴백
function getRawCostSheet() {
  var main = getOrCreateMainSpreadsheet();
  var s = main.getSheetByName('raw_cost');
  if (s && s.getLastRow() > 1) return s;   // 메인 탭에 데이터 있으면 그것
  var id = PropertiesService.getScriptProperties().getProperty('RAW_COST_SPREADSHEET_ID');
  if (id) {
    try { var ext = SpreadsheetApp.openById(id).getSheetByName('raw_cost'); if (ext) return ext; } catch(e) {}
  }
  return s || null;
}

// 원료 소싱 점검 — 코드별 최신 approve 단가의 register_date 가 months(기본 18)개월 이전이면 stale
function getStaleRawMaterials(months) {
  try {
    months = parseInt(months) || 18;
    var sheet = getRawCostSheet();
    if (!sheet) return { error: 'raw_cost sheet not found.' };
    var data = sheet.getDataRange().getValues();
    var h = data[0];
    var idx = {
      code: col(h,'code'), name: col(h,'name'), currency: col(h,'currency'),
      unitPrice: col(h,'unit_price'), status: col(h,'status'),
      registerDate: col(h,'register_date'), supplierName: col(h,'supplier_name'),
    };
    if (idx.code === -1 || idx.registerDate === -1) return { error: 'raw_cost has no code/register_date column.' };

    var byCode = {};
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (idx.status !== -1 && !statusOk(row[idx.status])) continue;
      var code = String(row[idx.code] || '').trim();
      if (!code) continue;
      var ms = toDateMs(row[idx.registerDate]);
      if (!byCode[code] || ms > byCode[code].ms) {
        byCode[code] = {
          ms: ms, code: code,
          name:         idx.name         !== -1 ? String(row[idx.name] || '') : '',
          currency:     idx.currency     !== -1 ? String(row[idx.currency] || '') : '',
          unitPrice:    idx.unitPrice    !== -1 ? (parseFloat(row[idx.unitPrice]) || 0) : 0,
          registerDate: formatDate(row[idx.registerDate]),
          supplierName: idx.supplierName !== -1 ? String(row[idx.supplierName] || '') : '',
        };
      }
    }

    var now    = new Date();
    var cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate()).getTime();
    var list = [];
    for (var k in byCode) {
      var r = byCode[k];
      var stale = (!r.ms) || (r.ms < cutoff);   // 날짜 없음도 점검 대상
      if (!stale) continue;
      var monthsOld = r.ms ? Math.floor((now.getTime() - r.ms) / (1000*60*60*24*30.44)) : null;
      list.push({
        code: r.code, name: r.name, currency: r.currency, unitPrice: r.unitPrice,
        registerDate: r.ms ? r.registerDate : '(no date)',
        supplierName: r.supplierName, monthsOld: monthsOld,
      });
    }
    // 오래된 순 (registerDate 오름차순, 날짜없음은 맨 위)
    list.sort(function(a, b){
      if (a.registerDate === '(no date)') return -1;
      if (b.registerDate === '(no date)') return 1;
      return a.registerDate < b.registerDate ? -1 : a.registerDate > b.registerDate ? 1 : 0;
    });
    return {
      months: months,
      cutoff: Utilities.formatDate(new Date(cutoff), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      totalCodes: Object.keys(byCode).length,
      staleCount: list.length,
      items: list,
    };
  } catch(e) { return { error: 'Sourcing check error: ' + e.message }; }
}

// 원료 단가 업로드 — 메인 스프레드시트 raw_cost 탭 전량 갱신 (CSV 업로드용)
function importRawCost(rows) {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('raw_cost') || ss.insertSheet('raw_cost');
    sheet.clearContents();
    if (!rows || !rows.length) return { ok: true, count: 0 };
    var headers = Object.keys(rows[0]);
    var data    = [headers].concat(rows.map(function(r){
      return headers.map(function(h){ return r[h] !== undefined ? r[h] : ''; });
    }));
    sheet.getRange(1, 1, data.length, headers.length).setValues(data);
    sheet.setFrozenRows(1);
    PropertiesService.getScriptProperties().setProperty(
      'RAW_COST_UPDATED',
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    );
    return { ok: true, count: rows.length };
  } catch(e) { return { error: 'raw_cost upload error: ' + e.message }; }
}

// ================================================================
// UTILITIES
// ================================================================

function col(headers, name) {
  return headers.indexOf(name);
}

function formatDate(value) {
  if (!value) return "";
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  if (!isNaN(value)) {
    const date = new Date((value - 25569) * 86400 * 1000);
    return Utilities.formatDate(date, "Asia/Seoul", "yyyy-MM-dd");
  }
  return value.toString();
}

// 날짜 값을 YYYY-MM-DD 문자열로 정규화 (Date · 엑셀 serial · 'yyyy-mm-dd...' · JS Date toString 모두 처리)
function toYmd(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return Utilities.formatDate(value, 'Asia/Seoul', 'yyyy-MM-dd');
  var s = String(value).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);      // 이미 yyyy-mm-dd 로 시작
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  if (s !== '' && !isNaN(s)) {                           // 엑셀 serial 숫자
    var d = new Date((Number(s) - 25569) * 86400 * 1000);
    return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
  }
  var d2 = new Date(s);                                  // "Fri Jan 14 2026 ... KST" etc.
  if (!isNaN(d2.getTime())) return Utilities.formatDate(d2, 'Asia/Seoul', 'yyyy-MM-dd');
  return s;
}

// ================================================================
// WEB APP ENTRY POINT
// ================================================================

// ── 접근 제어 (v1.32~) ─────────────────────────────────────────────
// 웹앱은 @example.com Google 계정만 받고(appsscript.json "access": "DOMAIN"),
// 그중 아래 명단에 있는 사람만 페이지를 연다. 비밀번호 게이트를 대신함.
// 명단 변경: ScriptProperties ALLOWED_USERS (쉼표로 구분한 이메일) — 재배포 없이 바로 적용.
// 속성이 없으면 이 기본 명단을 쓴다.
var DEFAULT_ALLOWED_USERS = ['sales.b@example.com', 'demo.user@example.com', 'sales.c@example.com'];

function getAllowedUsers_() {
  var prop = PropertiesService.getScriptProperties().getProperty('ALLOWED_USERS');
  var list = prop ? prop.split(',') : DEFAULT_ALLOWED_USERS;
  return list.map(function(s) { return String(s).trim().toLowerCase(); }).filter(function(s) { return s; });
}

function isAllowedUser_(email) {
  return !!email && getAllowedUsers_().indexOf(String(email).trim().toLowerCase()) !== -1;
}

function doGet(e) {
  // 명단에 없으면 일반 텍스트만 돌려준다 — HtmlService 페이지를 주지 않으므로
  // 거기서 google.script.run 으로 서버 함수를 부를 수도 없다.
  var visitor = '';
  try { visitor = Session.getActiveUser().getEmail(); } catch(ignored) {}
  if (!isAllowedUser_(visitor)) {
    return ContentService.createTextOutput(
      'Demo Labs Pricing Tool — access denied\n\n' +
      (visitor
        ? visitor + ' is not on the Pricing Tool access list.'
        : 'Sign in with your @example.com Google account.') +
      '\n\nAsk Jamie (demo.user@example.com) to be added.');
  }

  var page    = (e && e.parameter && e.parameter.page) || 'pricing';
  // 회사 계정 전용 웹앱이라 페이지 간 링크도 /a/<도메인>/ 주소로 만든다. 일반 /macros/s/… 주소는
  // 브라우저 기본 Google 계정으로 열려서, 그게 개인 계정이면 "no more “cannot open file”" 오류가 난다 (v1.33).
  var baseUrl = String(ScriptApp.getService().getUrl())
    .replace('https://script.google.com/macros/s/', 'https://script.google.com/macros/s/');

  var cfg = getConfig();
  var rdBase       = cfg.RD_TOOLKIT_URL || '#';
  var searchUrl    = rdBase + '?page=search';
  var recommendUrl = rdBase + '?page=recommend';
  var pricingUrl   = baseUrl + '?page=pricing';
  var gmUrl        = baseUrl + '?page=gm';
  var guideUrl     = baseUrl + '?page=guide';
  var libraryUrl   = baseUrl + '?page=library';
  var changelogUrl = baseUrl + '?page=changelog';
  var classifyUrl  = baseUrl + '?page=classify';
  var uploadUrl    = baseUrl + '?page=upload';
  var sourcingUrl  = baseUrl + '?page=sourcing';
  var procurementUrl = baseUrl + '?page=procurement';
  var loadId       = (e && e.parameter && e.parameter.load) ? String(e.parameter.load) : '';

  var userEmail = '';
  try { userEmail = Session.getActiveUser().getEmail(); } catch(ignored) {}
  var localPart  = userEmail ? userEmail.split('@')[0] : '';
  var nameParts  = localPart ? localPart.split('.') : [];
  var initials   = '';
  for (var pi = 0; pi < Math.min(nameParts.length, 2); pi++) {
    if (nameParts[pi]) initials += nameParts[pi].charAt(0).toUpperCase();
  }
  var userInitials = initials || 'Demo Labs';

  var tplVars = {
    searchUrl: searchUrl, recommendUrl: recommendUrl,
    pricingUrl: pricingUrl, gmUrl: gmUrl, guideUrl: guideUrl, libraryUrl: libraryUrl,
    changelogUrl: changelogUrl, classifyUrl: classifyUrl, uploadUrl: uploadUrl, sourcingUrl: sourcingUrl, procurementUrl: procurementUrl, loadId: loadId,
    userEmail: userEmail, userInitials: userInitials,
    appVersion: APP_VERSION,
  };

  var tplName  = (page === 'gm') ? 'GM' : (page === 'guide') ? 'Guide' : (page === 'library') ? 'Library' : (page === 'changelog') ? 'Changelog' : (page === 'classify') ? 'Classify' : (page === 'upload') ? 'Upload' : (page === 'sourcing') ? 'Sourcing' : (page === 'procurement') ? 'Procurement' : 'Pricing';
  var title    = (page === 'gm') ? 'GM Analysis · Demo Labs' : (page === 'guide') ? 'User Guide · Demo Labs' : (page === 'library') ? 'Pricing Library · Demo Labs' : (page === 'changelog') ? 'Changelog · Demo Labs' : (page === 'classify') ? 'Categories · Demo Labs' : (page === 'upload') ? 'Data upload · Demo Labs' : (page === 'sourcing') ? 'Ingredient check · Demo Labs' : (page === 'procurement') ? 'Procurement · Demo Labs' : 'Demo Labs Sales Pricing Tool';
  var html = HtmlService.createTemplateFromFile(tplName);
  for (var k in tplVars) html[k] = tplVars[k];
  return html.evaluate()
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    var data  = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
    if (token && data.token !== token) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var res;
    if (data.type === 'cost_master')        res = importGmCostMaster(data.rows);
    else if (data.type === 'gm_sales')      res = importGmSales(data.rows);
    else if (data.type === 'classification') res = importClassifications(data.rows);
    else if (data.type === 'raw_cost')      res = importRawCost(data.rows);
    else res = { error: 'Unknown type: ' + data.type };
    return ContentService.createTextOutput(JSON.stringify(res))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    return ContentService.createTextOutput(JSON.stringify({ error: e.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ================================================================
// TOOL 3 — PRICING CALCULATOR
// ================================================================

function checkPricingPassword(pw) {
  var stored = PropertiesService.getScriptProperties().getProperty('PRICING_PASSWORD');
  if (!stored) return { ok: true, warn: 'PRICING_PASSWORD is not set.' };
  return { ok: pw === stored };
}

// ── 환율 ────────────────────────────────────────────────────────

function getExchangeRates() {
  try {
    var response = UrlFetchApp.fetch(
      'https://api.exchangerate-api.com/v4/latest/NZD',
      { muteHttpExceptions: true }
    );
    if (response.getResponseCode() !== 200) {
      return { error: 'FX API error: ' + response.getResponseCode() };
    }
    var rates = JSON.parse(response.getContentText()).rates;
    return {
      usd:       rates['USD'] || 0,
      krw:       rates['KRW'] || 0,
      aud:       rates['AUD'] || 0,
      updatedAt: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
    };
  } catch(e) {
    return { error: 'FX lookup error: ' + e.message };
  }
}

// ── PFS 코드 일괄 매칭 ───────────────────────────────────────────────

// PFS에서 추출한 OR/OP 코드 배열을 받아 raw_cost 시트에서 단가 일괄 조회
// 반환: { "OR0001": { name, currency, unitPrice, finalPrice, custom, overseaFreight, shippingMethod, incoterms }, ... }
function bulkMatchRawMaterials(codes) {
  try {
    var sheet = getRawCostSheet();
    if (!sheet) return {};

    var data    = sheet.getDataRange().getValues();
    var headers = data[0];
    var idx = {
      code:           col(headers, 'code'),
      name:           col(headers, 'name'),
      currency:       col(headers, 'currency'),
      unitPrice:      col(headers, 'unit_price'),
      finalPrice:     col(headers, 'final_price'),
      custom:         col(headers, 'custom'),
      overseaFreight: col(headers, 'oversea_freight'),
      shippingMethod: col(headers, 'shipping_method'),
      incoterms:      col(headers, 'incoterms'),
      status:         col(headers, 'status'),
      registerDate:   col(headers, 'register_date'),
    };

    // 코드셋 구성 (대문자 정규화)
    var codeSet = {};
    for (var ci = 0; ci < codes.length; ci++) {
      codeSet[String(codes[ci]).trim().toUpperCase()] = true;
    }

    // 코드별 최신 행 (register_date 기준)
    var byCode = {};
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!statusOk(row[idx.status])) continue;
      var code = String(row[idx.code] || '').trim().toUpperCase();
      if (!codeSet[code]) continue;

      var ms = idx.registerDate !== -1 ? toDateMs(row[idx.registerDate]) : 0;
      if (!byCode[code] || ms > byCode[code].ms) {
        byCode[code] = {
          ms: ms,
          name:           String(row[idx.name]           || ''),
          currency:       String(row[idx.currency]       || ''),
          unitPrice:      parseFloat(row[idx.unitPrice])      || 0,
          finalPrice:     parseFloat(row[idx.finalPrice])     || 0,
          custom:         parseFloat(row[idx.custom])         || 0,
          overseaFreight: parseFloat(row[idx.overseaFreight]) || 0,
          shippingMethod: String(row[idx.shippingMethod] || ''),
          incoterms:      String(row[idx.incoterms]      || ''),
          registerDate:   idx.registerDate !== -1 ? formatDate(row[idx.registerDate]) : '',
        };
      }
    }

    // ms 필드 제거 후 반환
    var result = {};
    for (var k in byCode) {
      var entry = byCode[k];
      result[k] = {
        name:           entry.name,
        currency:       entry.currency,
        unitPrice:      entry.unitPrice,
        finalPrice:     entry.finalPrice,
        custom:         entry.custom,
        overseaFreight: entry.overseaFreight,
        shippingMethod: entry.shippingMethod,
        incoterms:      entry.incoterms,
        registerDate:   entry.registerDate,
      };
    }
    return result;
  } catch(e) {
    return { error: 'PFS code matching error: ' + e.message };
  }
}

// ── 검색 공통 유틸 ───────────────────────────────────────────────

function isDefaultOk(val) {
  if (val === 1 || val === true) return true;
  var s = String(val).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function statusOk(val) {
  return String(val).trim().toLowerCase() === 'approve';
}

function toDateMs(val) {
  if (!val) return 0;
  if (val instanceof Date) return val.getTime();
  var d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ── 부자재 단가 자동 교정 ────────────────────────────────────────
// raw 데이터에 반복적으로 잘못 들어오는 단가를 지정값으로 보정 + 로그.
// (예: OP0299 가 0.3 이상으로 오면 실제값 0.1500 으로 교정)
var PKG_PRICE_FIXES = {
  'OP0299': { over: 0.3, to: 0.1500 },
};
function fixPkgPrice(code, price) {
  var p = parseFloat(price) || 0;
  var f = PKG_PRICE_FIXES[String(code || '').trim().toUpperCase()];
  if (f && p >= f.over) {
    Logger.log('[PKG_PRICE_FIX] ' + code + ': ' + p + ' → ' + f.to +
               ' @' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
    return f.to;
  }
  return p;
}

// ── 원료/부자재 검색 ─────────────────────────────────────────────

function searchRawMaterial(keyword) {
  try {
    var sheet = getRawCostSheet();
    if (!sheet) return { error: 'raw_cost sheet not found.' };

    var data    = sheet.getDataRange().getValues();
    var headers = data[0];
    var idx = {
      code:           col(headers, 'code'),
      name:           col(headers, 'name'),
      currency:       col(headers, 'currency'),
      unitPrice:      col(headers, 'unit_price'),
      finalPrice:     col(headers, 'final_price'),
      custom:         col(headers, 'custom'),
      overseaFreight: col(headers, 'oversea_freight'),
      shippingMethod: col(headers, 'shipping_method'),
      incoterms:      col(headers, 'incoterms'),
      status:         col(headers, 'status'),
      registerDate:   col(headers, 'register_date'),
    };

    var kw     = keyword ? keyword.toLowerCase().trim() : '';
    var byCode = {};

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!statusOk(row[idx.status])) continue;

      var code = String(row[idx.code] || '').trim();
      var name = String(row[idx.name] || '').trim();
      if (!code) continue;
      if (kw && !code.toLowerCase().includes(kw) && !name.toLowerCase().includes(kw)) continue;

      var dateMs = idx.registerDate !== -1 ? toDateMs(row[idx.registerDate]) : 0;

      if (!byCode[code] || dateMs > byCode[code].dateMs) {
        byCode[code] = {
          dateMs: dateMs,
          item: {
            code:           code,
            name:           name,
            currency:       String(row[idx.currency]            || ''),
            unitPrice:      parseFloat(row[idx.unitPrice])      || 0,
            finalPrice:     parseFloat(row[idx.finalPrice])     || 0,
            custom:         parseFloat(row[idx.custom])         || 0,
            overseaFreight: parseFloat(row[idx.overseaFreight]) || 0,
            shippingMethod: String(row[idx.shippingMethod]      || ''),
            incoterms:      String(row[idx.incoterms]           || ''),
            registerDate:   idx.registerDate !== -1 ? formatDate(row[idx.registerDate]) : '',
          },
        };
      }
    }

    return Object.keys(byCode).map(function(k) { return byCode[k].item; });
  } catch(e) {
    return { error: 'Ingredient search error: ' + e.message };
  }
}

function searchPackaging(keyword) {
  try {
    var cfg   = getConfig();
    var ss    = SpreadsheetApp.openById(cfg.PKG_COST_SPREADSHEET_ID);
    var sheet = ss.getSheetByName('packaging_cost');
    if (!sheet) return { error: 'packaging_cost sheet not found.' };

    var data    = sheet.getDataRange().getValues();
    var headers = data[0];
    var idx = {
      code:          col(headers, 'code'),
      name:          col(headers, 'name'),
      packagingType: col(headers, 'packaging_type'),
      currency:      col(headers, 'currency'),
      unitPrice:     col(headers, 'unit_price'),
      status:        col(headers, 'status'),
      registerDate:  col(headers, 'register_date'),
    };

    var kw     = keyword ? keyword.toLowerCase().trim() : '';
    var byCode = {};

    for (var i = 1; i < data.length; i++) {
      var row     = data[i];
      var pkgType = String(row[idx.packagingType] || '').trim();

      if (!statusOk(row[idx.status])) continue;
      if (pkgType === 'Shell (F)')    continue;

      var code = String(row[idx.code] || '').trim();
      var name = String(row[idx.name] || '').trim();
      if (!code) continue;
      if (kw && !code.toLowerCase().includes(kw) && !name.toLowerCase().includes(kw)) continue;

      var dateMs = idx.registerDate !== -1 ? toDateMs(row[idx.registerDate]) : 0;

      if (!byCode[code] || dateMs > byCode[code].dateMs) {
        byCode[code] = {
          dateMs: dateMs,
          item: {
            code:          code,
            name:          name,
            packagingType: pkgType,
            currency:      String(row[idx.currency]   || ''),
            unitPrice:     fixPkgPrice(code, parseFloat(row[idx.unitPrice]) || 0),
            registerDate:  idx.registerDate !== -1 ? formatDate(row[idx.registerDate]) : '',
          },
        };
      }
    }

    return Object.keys(byCode).map(function(k) { return byCode[k].item; });
  } catch(e) {
    return { error: 'Packaging search error: ' + e.message };
  }
}

// ── 검색 진단 함수 (GAS 편집기에서 직접 실행) ────────────────────

function debugRawSearch(keyword) {
  var sheet = getRawCostSheet();
  var data  = sheet.getDataRange().getValues();
  var h     = data[0];
  var idx   = { code: col(h,'code'), name: col(h,'name'), isDefault: col(h,'is_default'), status: col(h,'status') };
  var kw    = keyword ? keyword.toLowerCase() : '';
  var out   = [];
  for (var i = 1; i < data.length && out.length < 15; i++) {
    var r    = data[i];
    var code = String(r[idx.code] || '');
    var name = String(r[idx.name] || '');
    if (kw && !code.toLowerCase().includes(kw) && !name.toLowerCase().includes(kw)) continue;
    out.push({
      code:            code,
      name:            name,
      is_default:      r[idx.isDefault],
      is_default_type: typeof r[idx.isDefault],
      status:          r[idx.status],
      status_type:     typeof r[idx.status],
      passesFilter:    statusOk(r[idx.status]) && isDefaultOk(r[idx.isDefault]),
    });
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function debugPkgSearch(keyword) {
  var cfg   = getConfig();
  var ss    = SpreadsheetApp.openById(cfg.PKG_COST_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('packaging_cost');
  var data  = sheet.getDataRange().getValues();
  var h     = data[0];
  var idx   = { code: col(h,'code'), name: col(h,'name'), isDefault: col(h,'is_default'), status: col(h,'status') };
  var kw    = keyword ? keyword.toLowerCase() : '';
  var out   = [];
  for (var i = 1; i < data.length && out.length < 15; i++) {
    var r    = data[i];
    var code = String(r[idx.code] || '');
    var name = String(r[idx.name] || '');
    if (kw && !code.toLowerCase().includes(kw) && !name.toLowerCase().includes(kw)) continue;
    out.push({
      code:            code,
      name:            name,
      is_default:      r[idx.isDefault],
      is_default_type: typeof r[idx.isDefault],
      status:          r[idx.status],
      status_type:     typeof r[idx.status],
      passesFilter:    statusOk(r[idx.status]) && isDefaultOk(r[idx.isDefault]),
    });
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

// ================================================================
// TOOL 3 — OP코드 기반 패키징 자동완성
// ================================================================

// OP코드를 포함하는 OF BOM에서 패키징 전체를 반환
// 여러 OF가 있으면 코드 숫자 기준 가장 큰(최신) OF 선택
function getPackagingByOp(opCode) {
  try {
    var cfg = getConfig();
    if (!cfg.BOM_SPREADSHEET_ID) {
      return { error: 'BOM_SPREADSHEET_ID is not set in ScriptProperties.' };
    }

    var bomSS    = SpreadsheetApp.openById(cfg.BOM_SPREADSHEET_ID);
    var finishSh = bomSS.getSheetByName('finish_BOM');
    if (!finishSh) return { error: 'finish_BOM sheet not found.' };

    var data    = finishSh.getDataRange().getValues();
    var headers = data[0];
    var ix = {
      bomCode:  col(headers, 'BOM Code'),
      lineType: col(headers, 'Line Type'),
      objCode:  col(headers, 'Object CodeItem'),
      objDesc:  col(headers, 'Object Description'),
      unit:     col(headers, 'Unit'),
    };

    var targetOp = String(opCode).trim().toUpperCase();

    // 1. finish_BOM에서 해당 OP가 포함된 OF 코드 목록 수집
    var ofSet = {};
    for (var i = 1; i < data.length; i++) {
      var r   = data[i];
      var oc  = String(r[ix.objCode]  || '').trim().toUpperCase();
      var lt  = String(r[ix.lineType] || '').trim().toLowerCase();
      var bmc = String(r[ix.bomCode]  || '').trim().toUpperCase();
      if (oc === targetOp && lt === 'packaging' && bmc.indexOf('OF') === 0) {
        ofSet[bmc] = true;
      }
    }

    var ofCodes = Object.keys(ofSet);
    if (!ofCodes.length) {
      return { packages: [], ofCode: null, multipleOf: false };
    }

    // 2. 코드 숫자 기준 가장 큰 OF 선택
    ofCodes.sort(function(a, b) {
      var na = parseInt(a.replace(/\D/g, '')) || 0;
      var nb = parseInt(b.replace(/\D/g, '')) || 0;
      return nb - na;
    });
    var selectedOf  = ofCodes[0];
    var multipleOf  = ofCodes.length > 1;

    // 3. 선택된 OF의 packaging 라인 전체 수집
    var rawPkgs = [];
    for (var j = 1; j < data.length; j++) {
      var row = data[j];
      var bmc2 = String(row[ix.bomCode]  || '').trim().toUpperCase();
      var lt2  = String(row[ix.lineType] || '').trim().toLowerCase();
      var oc2  = String(row[ix.objCode]  || '').trim().toUpperCase();
      var od2  = String(row[ix.objDesc]  || '').trim();
      var un2  = String(row[ix.unit]     || '').trim();
      if (bmc2 === selectedOf && lt2 === 'packaging' && oc2) {
        rawPkgs.push({ code: oc2, name: od2, qty: 1, unit: un2 });
      }
    }

    if (!rawPkgs.length) {
      return { packages: [], ofCode: selectedOf, multipleOf: multipleOf };
    }

    // 4. packaging_cost 시트에서 단가 매핑
    var pkgMap = buildBomPricingMap(
      SpreadsheetApp.openById(cfg.PKG_COST_SPREADSHEET_ID).getSheetByName('packaging_cost'), true);

    var packages = rawPkgs.map(function(pkg) {
      var p = pkgMap[pkg.code];
      if (p) {
        pkg.packagingType = p.packagingType;
        pkg.currency      = p.currency;
        pkg.finalPrice    = p.finalPrice;
        pkg.unitPrice     = p.unitPrice;
        pkg.registerDate  = p.registerDate || '';
        pkg.found         = true;
      } else {
        pkg.packagingType = '';
        pkg.finalPrice    = 0;
        pkg.found         = false;
      }
      return pkg;
    });

    return { packages: packages, ofCode: selectedOf, multipleOf: multipleOf };
  } catch(e) {
    return { error: 'OP packaging lookup error: ' + e.message };
  }
}

// ================================================================
// TOOL 3 — BOM 자동완성
// ================================================================

function getBomData(code) {
  try {
    var cfg = getConfig();
    if (!cfg.BOM_SPREADSHEET_ID) {
      return { error: 'BOM_SPREADSHEET_ID is not set in ScriptProperties.' };
    }
    var bomSS = SpreadsheetApp.openById(cfg.BOM_SPREADSHEET_ID);
    var bom = {
      finish: loadBomSheet(bomSS, 'finish_BOM'),
      bulk:   loadBomSheet(bomSS, 'bulk_BOM'),
      indv:   loadBomSheet(bomSS, 'indv_BOM'),
    };

    var prefix = code.length >= 2 ? code.substring(0, 2).toUpperCase() : '';
    var seen = {}, result;

    if      (prefix === 'OF') result = resolveOF(bom, code.toUpperCase(), seen);
    else if (prefix === 'OB') result = resolveOB(bom, code.toUpperCase());
    else if (prefix === 'OC') result = resolveOC(bom, code.toUpperCase(), seen);
    else return { error: 'Only OF/OB/OC codes are supported.' };

    if (result.error) return result;

    var rawMap = buildBomPricingMap(getRawCostSheet(), false);
    var pkgMap = buildBomPricingMap(
      SpreadsheetApp.openById(cfg.PKG_COST_SPREADSHEET_ID).getSheetByName('packaging_cost'), true);
    enrichBomPricing(result, rawMap, pkgMap);
    return result;
  } catch(e) {
    return { error: 'BOM lookup error: ' + e.message };
  }
}

function loadBomSheet(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var h    = data[0];
  return {
    rows: data.slice(1),
    idx: {
      bomCode:  col(h, 'BOM Code'),
      descr:    col(h, 'Item Description'),
      itemType: col(h, 'Item Type'),
      lineType: col(h, 'Line Type'),
      objCode:  col(h, 'Object CodeItem'),
      objDesc:  col(h, 'Object Description'),
      qty:      col(h, 'Quantity'),
      unit:     col(h, 'Unit'),
    },
  };
}

function getBomRows(sheet, code) {
  if (!sheet) return [];
  var ix = sheet.idx;
  return sheet.rows.filter(function(r) {
    return String(r[ix.bomCode]).trim().toUpperCase() === code;
  });
}

function resolveOF(bom, code, seen) {
  var rows = getBomRows(bom.finish, code);
  if (!rows.length) return { error: 'Not found in finish_BOM: ' + code };
  var ix = bom.finish.idx;
  var productName = String(rows[0][ix.descr] || '');
  var itemType    = String(rows[0][ix.itemType] || '').toLowerCase().trim();
  var raw = [], pkg = [];
  var BULK = ['soft','hard','hard cap','tablet','powder','liquid'];

  rows.forEach(function(r) {
    var lt = String(r[ix.lineType] || '').toLowerCase().trim();
    var oc = String(r[ix.objCode]  || '').trim().toUpperCase();
    var od = String(r[ix.objDesc]  || '').trim();
    var un = String(r[ix.unit]     || '').trim();
    if (!oc) return;

    if (lt === 'packaging') {
      pkg.push({ code: oc, name: od, qty: 1, unit: un });
    } else if (BULK.indexOf(lt) !== -1) {
      if (!seen[oc]) { seen[oc] = true;
        var s = resolveOB(bom, oc);
        if (!s.error) {
          if (!itemType) itemType = s.itemType;
          s.rawMaterials.forEach(function(x) { raw.push(x); });
          s.packages.forEach(function(x)     { pkg.push(x); });
        }
      }
    } else if (lt === 'blister') {
      if (!seen[oc]) { seen[oc] = true;
        var s = resolveOC(bom, oc, seen);
        if (!s.error) {
          if (!itemType) itemType = s.itemType;
          s.rawMaterials.forEach(function(x) { raw.push(x); });
          s.packages.forEach(function(x)     { pkg.push(x); });
        }
      }
    }
  });
  return { productName: productName, itemType: itemType, rawMaterials: raw, packages: pkg };
}

function resolveOB(bom, code) {
  var rows = getBomRows(bom.bulk, code);
  if (!rows.length) return { error: 'Not found in bulk_BOM: ' + code };
  var ix = bom.bulk.idx;
  var productName = String(rows[0][ix.descr] || '');
  var itemType    = String(rows[0][ix.itemType] || '').toLowerCase().trim();
  var raw = [], pkg = [];

  rows.forEach(function(r) {
    var lt = String(r[ix.lineType] || '').toLowerCase().trim();
    var oc = String(r[ix.objCode]  || '').trim().toUpperCase();
    var od = String(r[ix.objDesc]  || '').trim();
    var qy = parseFloat(r[ix.qty]) || 0;
    var un = String(r[ix.unit]     || '').trim();
    if (!oc) return;

    if      (lt === 'ingredient') raw.push({ code: oc, name: od, mgPerEa: qy, unit: un });
    else if (lt === 'shell')      raw.push({ code: oc, name: od, mgPerEa: qy, unit: un, isShell: true });
    else if (lt === 'packaging')  pkg.push({ code: oc, name: od, qty: 1, unit: un });
  });
  return { productName: productName, itemType: itemType, rawMaterials: raw, packages: pkg };
}

function resolveOC(bom, code, seen) {
  var rows = getBomRows(bom.indv, code);
  if (!rows.length) return { error: 'Not found in indv_BOM: ' + code };
  var ix = bom.indv.idx;
  var productName = String(rows[0][ix.descr] || '');
  var itemType    = String(rows[0][ix.itemType] || '').toLowerCase().trim();
  var raw = [], pkg = [];
  var BULK = ['soft','hard','hard cap','tablet','liquid hard','liquid'];

  rows.forEach(function(r) {
    var lt = String(r[ix.lineType] || '').toLowerCase().trim();
    var oc = String(r[ix.objCode]  || '').trim().toUpperCase();
    var od = String(r[ix.objDesc]  || '').trim();
    var un = String(r[ix.unit]     || '').trim();
    if (!oc) return;

    if (BULK.indexOf(lt) !== -1) {
      if (!seen[oc]) { seen[oc] = true;
        var s = resolveOB(bom, oc);
        if (!s.error) {
          if (!itemType) itemType = s.itemType;
          s.rawMaterials.forEach(function(x) { raw.push(x); });
          s.packages.forEach(function(x)     { pkg.push(x); });
        }
      }
    } else if (lt === 'packaging') {
      pkg.push({ code: oc, name: od, qty: 1, unit: un });
    }
  });
  return { productName: productName, itemType: itemType, rawMaterials: raw, packages: pkg };
}

function buildBomPricingMap(sheet, isPkg) {
  if (!sheet) return {};
  var data = sheet.getDataRange().getValues();
  var h    = data[0];
  var ix   = {
    code: col(h,'code'), currency: col(h,'currency'),
    unitPrice: col(h,'unit_price'), finalPrice: col(h,'final_price'),
    custom: col(h,'custom'), overseaFreight: col(h,'oversea_freight'),
    shippingMethod: col(h,'shipping_method'), incoterms: col(h,'incoterms'),
    status: col(h,'status'), registerDate: col(h,'register_date'),
    packagingType: isPkg ? col(h,'packaging_type') : -1,
  };
  var map = {};
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!statusOk(r[ix.status])) continue;
    var code = String(r[ix.code] || '').trim().toUpperCase();
    if (!code) continue;
    var ms = ix.registerDate !== -1 ? toDateMs(r[ix.registerDate]) : 0;
    if (!map[code] || ms > map[code].ms) {
      var upv = parseFloat(r[ix.unitPrice])  || 0;
      var fpv = parseFloat(r[ix.finalPrice]) || 0;
      if (isPkg) { upv = fixPkgPrice(code, upv); fpv = fixPkgPrice(code, fpv); }
      map[code] = {
        ms: ms,
        currency:       String(r[ix.currency]            || ''),
        unitPrice:      upv,
        finalPrice:     fpv,
        custom:         parseFloat(r[ix.custom])         || 0,
        overseaFreight: parseFloat(r[ix.overseaFreight]) || 0,
        shippingMethod: String(r[ix.shippingMethod]      || ''),
        incoterms:      String(r[ix.incoterms]           || ''),
        registerDate:   ix.registerDate !== -1 ? formatDate(r[ix.registerDate]) : '',
        packagingType:  isPkg ? String(r[ix.packagingType] || '') : '',
      };
    }
  }
  return map;
}

function enrichBomPricing(result, rawMap, pkgMap) {
  result.rawMaterials.forEach(function(rm) {
    var p = rawMap[rm.code] || (rm.isShell ? pkgMap[rm.code] : null);
    if (p) {
      rm.currency = p.currency; rm.unitPrice = p.unitPrice; rm.finalPrice = p.finalPrice;
      rm.custom = p.custom; rm.overseaFreight = p.overseaFreight;
      rm.shippingMethod = p.shippingMethod; rm.incoterms = p.incoterms;
      rm.registerDate = p.registerDate || ''; rm.found = true;
    } else {
      rm.currency = ''; rm.unitPrice = 0; rm.finalPrice = 0;
      rm.custom = 0; rm.overseaFreight = 0; rm.found = false;
    }
  });
  result.packages.forEach(function(pkg) {
    var p = pkgMap[pkg.code];
    if (p) {
      pkg.packagingType = p.packagingType;
      pkg.currency = p.currency; pkg.finalPrice = p.finalPrice; pkg.unitPrice = p.unitPrice;
      pkg.registerDate = p.registerDate || ''; pkg.found = true;
    } else {
      pkg.packagingType = ''; pkg.finalPrice = 0; pkg.found = false;
    }
  });
}

// ================================================================
// TOOL 3 — 견적 저장/불러오기/검토
// ================================================================

// 컬럼 레이아웃 (10열):
// A:id  B:productName  C:savedAt  D:savedBy  E:status
// F:unitCost  G:totalUnits  H:memo  I:bomCode  J:data

function migrateLegacyHistorySheet(ss, year) {
  var old = ss.getSheetByName('Pricing_History');
  if (!old) return;

  var sheetName = 'Pricing_History_' + year;
  var newSheet  = ss.getSheetByName(sheetName);
  var isNewSheet = !newSheet;
  if (!newSheet) {
    newSheet = ss.insertSheet(sheetName);
    newSheet.appendRow(['id','productName','savedAt','savedBy','status',
                        'unitCost','totalUnits','memo','bomCode','data']);
    newSheet.setFrozenRows(1);
    newSheet.setColumnWidth(10, 600);
  }

  // 새로 생성된 시트에만 복사 (이미 존재하면 이미 마이그레이션 완료 → 중복 방지)
  if (isNewSheet) {
    var rows = old.getDataRange().getValues();
    if (rows.length > 1) {
      var inserts = [];
      for (var i = 1; i < rows.length; i++) {
        var r = rows[i];
        inserts.push([r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],'',r[8]||'']);
      }
      if (inserts.length) {
        newSheet.getRange(newSheet.getLastRow()+1, 1, inserts.length, 10).setValues(inserts);
      }
    }
  }

  // Pricing_History_legacy가 이미 존재하면 old 시트 삭제, 아니면 이름 변경
  if (ss.getSheetByName('Pricing_History_legacy')) {
    ss.deleteSheet(old);
  } else {
    old.setName('Pricing_History_legacy');
  }
}

function getPricingHistorySheet(year) {
  var ss  = getOrCreateMainSpreadsheet();
  if (!year) year = new Date().getFullYear();

  migrateLegacyHistorySheet(ss, year);

  var sheetName = 'Pricing_History_' + year;
  var sheet     = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['id','productName','savedAt','savedBy','status',
                     'unitCost','totalUnits','memo','bomCode','data','company','brand']);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(10, 600);
  }
  ensureClassificationColumns(sheet);
  return sheet;
}

// company(11)·brand(12) 컬럼 하위호환: 기존 시트에 헤더만 보강 (데이터는 index로 안전)
function ensureClassificationColumns(sheet) {
  try {
    if (sheet.getLastColumn() < 11) sheet.getRange(1, 11).setValue('company');
    if (sheet.getLastColumn() < 12) sheet.getRange(1, 12).setValue('brand');
  } catch(ignored) {}
}

function generateEstimateId(sheet, year) {
  var seq = sheet.getLastRow();
  return year + '-' + String(seq).padStart(3, '0');
}

function getHistorySheetForId(id) {
  var ss    = getOrCreateMainSpreadsheet();
  var match = String(id).match(/^(\d{4})-/);
  var year  = match ? parseInt(match[1]) : new Date().getFullYear();
  return ss.getSheetByName('Pricing_History_' + year);
}

function saveEstimate(payload) {
  try {
    var now     = new Date();
    var year    = now.getFullYear();
    var sheet   = getPricingHistorySheet(year);
    var id      = generateEstimateId(sheet, year);
    var savedAt = Utilities.formatDate(now, 'Pacific/Auckland', 'yyyy-MM-dd HH:mm');
    var savedBy = '';
    try { savedBy = Session.getActiveUser().getEmail(); } catch(ignored) {}

    sheet.appendRow([
      id,
      payload.productName || '',
      now,
      savedBy || '—',
      'Draft',
      payload.unitCost   || 0,
      payload.totalUnits || 0,
      payload.memo       || '',
      payload.bomCode    || '',
      payload.data       || '',
      payload.company    || '',
      payload.brand      || '',
    ]);
    return { id: id, savedAt: savedAt };
  } catch(e) {
    return { error: 'Save error: ' + e.message };
  }
}

// 기존 견적을 제자리 덮어쓰기 (같은 ID 유지). status 는 보존.
function updateEstimate(id, payload) {
  try {
    var sheet = getHistorySheetForId(id);
    if (!sheet) return { error: 'Quote sheet not found: ' + id };
    ensureClassificationColumns(sheet);
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(id).trim()) {
        var rowNum = i + 1;
        var now    = new Date();
        // 컬럼: 1 id · 2 productName · 3 savedAt · 4 savedBy · 5 status · 6 unitCost ·
        //       7 totalUnits · 8 memo · 9 bomCode · 10 data · 11 company · 12 brand
        sheet.getRange(rowNum, 2).setValue(payload.productName || '');
        sheet.getRange(rowNum, 3).setValue(now);                    // 최종 수정 시각으로 갱신
        sheet.getRange(rowNum, 6).setValue(payload.unitCost   || 0);
        sheet.getRange(rowNum, 7).setValue(payload.totalUnits || 0);
        if (payload.memo != null) sheet.getRange(rowNum, 8).setValue(payload.memo);
        sheet.getRange(rowNum, 9).setValue(payload.bomCode  || '');
        sheet.getRange(rowNum, 10).setValue(payload.data    || '');
        sheet.getRange(rowNum, 11).setValue(payload.company || '');
        sheet.getRange(rowNum, 12).setValue(payload.brand   || '');
        var savedAt = Utilities.formatDate(now, 'Pacific/Auckland', 'yyyy-MM-dd HH:mm');
        return { id: id, savedAt: savedAt, status: String(data[i][4] || 'Draft') };
      }
    }
    return { error: 'Quote not found: ' + id };
  } catch(e) {
    return { error: 'Update error: ' + e.message };
  }
}

// Library 인라인 편집: data(JSON) 은 건드리지 않고 분류(회사·브랜드·제품코드)만 갱신
function updateEstimateMeta(id, meta) {
  try {
    var sheet = getHistorySheetForId(id);
    if (!sheet) return { error: 'Quote sheet not found: ' + id };
    ensureClassificationColumns(sheet);
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(id).trim()) {
        var rowNum = i + 1;
        if (meta.company != null) sheet.getRange(rowNum, 11).setValue(meta.company);
        if (meta.brand   != null) sheet.getRange(rowNum, 12).setValue(meta.brand);
        if (meta.bomCode != null) sheet.getRange(rowNum,  9).setValue(meta.bomCode);
        return { ok: true };
      }
    }
    return { error: 'Quote not found: ' + id };
  } catch(e) {
    return { error: 'Category update error: ' + e.message };
  }
}

function getEstimateList() {
  try {
    var year  = new Date().getFullYear();
    var sheet = getPricingHistorySheet(year);
    var data  = sheet.getDataRange().getValues();
    var list  = [];
    for (var i = data.length - 1; i >= 1; i--) {
      var row    = data[i];
      var status = String(row[4] || '').trim();
      if (status === 'deleted') continue;
      list.push({
        id:          String(row[0] || ''),
        productName: String(row[1] || ''),
        savedAt:     row[2] instanceof Date
          ? Utilities.formatDate(row[2], 'Pacific/Auckland', 'yyyy-MM-dd HH:mm')
          : String(row[2] || ''),
        savedBy:     String(row[3] || ''),
        status:      status || 'Draft',
        unitCost:    parseFloat(row[5]) || 0,
        totalUnits:  parseFloat(row[6]) || 0,
        memo:        String(row[7] || ''),
        bomCode:     String(row[8] || ''),
        company:     String(row[10] || ''),
        brand:       String(row[11] || ''),
        displayCurrency: estDisplayInfo(row[9]).displayCurrency,
        fxUsd:           estDisplayInfo(row[9]).fxUsd,
      });
    }
    return list;
  } catch(e) {
    return { error: 'List error: ' + e.message };
  }
}

// 저장 JSON 에서 STEP 6 표시 통화·당시 USD 환율만 추출 (목록용 — 전체 파싱 없이)
function estDisplayInfo(json) {
  var s = String(json || '');
  var cur = (s.match(/"displayCurrency":"(USD|NZD)"/) || [])[1] || 'NZD';
  var fx  = parseFloat((s.match(/"exchangeRates":\{[^}]*?"usd":([\d.]+)/) || [])[1]) || 0;
  return { displayCurrency: cur, fxUsd: fx };
}

// Library: 모든 연도(Pricing_History_YYYY) 시트를 가로질러 견적 조회 (최신순)
function getAllEstimates() {
  try {
    var ss     = getOrCreateMainSpreadsheet();
    var sheets = ss.getSheets();
    var list   = [];
    for (var s = 0; s < sheets.length; s++) {
      var name = sheets[s].getName();
      if (!/^Pricing_History_\d{4}$/.test(name)) continue;   // legacy 제외
      var data = sheets[s].getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        var row    = data[i];
        var status = String(row[4] || '').trim();
        if (!row[0] || status === 'deleted') continue;
        list.push({
          id:          String(row[0] || ''),
          productName: String(row[1] || ''),
          savedAt:     row[2] instanceof Date
            ? Utilities.formatDate(row[2], 'Pacific/Auckland', 'yyyy-MM-dd HH:mm')
            : String(row[2] || ''),
          savedBy:     String(row[3] || ''),
          status:      status || 'Draft',
          unitCost:    parseFloat(row[5]) || 0,
          totalUnits:  parseFloat(row[6]) || 0,
          memo:        String(row[7] || ''),
          bomCode:     String(row[8] || ''),
          company:     String(row[10] || ''),
          brand:       String(row[11] || ''),
          displayCurrency: estDisplayInfo(row[9]).displayCurrency,
          fxUsd:           estDisplayInfo(row[9]).fxUsd,
          year:        name.replace('Pricing_History_', ''),
        });
      }
    }
    list.sort(function(a, b){ return a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0; });
    return list;
  } catch(e) {
    return { error: 'Library error: ' + e.message };
  }
}

// Library — 파싱데이터(원가DB): GM_CostMaster 에서 제품별 unit_cost 만 추출
// (탭 이름 달라도 of_code/ob_code + unit_cost 헤더로 자동 탐색)
function getCostRecords() {
  try {
    var ss = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('GM_CostMaster');
    if (!sheet || sheet.getLastRow() < 2) {
      var sheets = ss.getSheets();
      for (var i = 0; i < sheets.length; i++) {
        var sh = sheets[i];
        if (sh.getLastRow() < 2 || sh.getLastColumn() < 1) continue;
        var hh = sh.getRange(1, 1, 1, Math.min(sh.getLastColumn(), 20)).getValues()[0]
          .map(function(x){ return String(x).trim().toLowerCase(); });
        if (hh.indexOf('unit_cost') !== -1 && (hh.indexOf('of_code') !== -1 || hh.indexOf('ob_code') !== -1)) { sheet = sh; break; }
      }
    }
    if (!sheet || sheet.getLastRow() < 2) return [];
    var data = sheet.getDataRange().getValues();
    var h = data[0].map(function(x){ return String(x).trim().toLowerCase(); });
    var iOf = h.indexOf('of_code'), iOb = h.indexOf('ob_code'),
        iName = h.indexOf('product_name'), iCost = h.indexOf('unit_cost'), iClient = h.indexOf('client_name');
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var of  = iOf !== -1 ? String(row[iOf] || '').trim() : '';
      var ob  = iOb !== -1 ? String(row[iOb] || '').trim() : '';
      var code = of || ob;
      if (!code) continue;
      out.push({
        id:          'COST-' + code,
        productName: iName   !== -1 ? String(row[iName]   || '').trim() : '',
        bomCode:     code,
        ofCode:      of,
        obCode:      ob,
        unitCost:    iCost   !== -1 ? (parseFloat(row[iCost]) || 0) : 0,
        company:     iClient !== -1 ? String(row[iClient] || '').trim() : '',
        brand:       '',
        savedAt:     '',
        status:      '',
        source:      'cost',
      });
    }
    return out;
  } catch(e) {
    return { error: 'Cost DB error: ' + e.message };
  }
}

// 회사명 자동완성 목록 — 견적 이력 + GM 매출 client_name 병합 (중복 제거, 정렬)
function getCompanyList() {
  try {
    var set = {};
    var ests = getAllEstimates();
    if (ests && ests.length) {
      ests.forEach(function(e){ var c = (e.company || '').trim(); if (c) set[c] = 1; });
    }
    // GM_Sales 의 client_name 도 후보로 포함
    try {
      var ss    = getOrCreateMainSpreadsheet();
      var gm    = ss.getSheetByName('GM_Sales');
      if (gm) {
        var d  = gm.getDataRange().getValues();
        var ci = d.length ? d[0].map(function(h){return String(h).trim();}).indexOf('client_name') : -1;
        if (ci !== -1) for (var i = 1; i < d.length; i++) { var v = String(d[i][ci] || '').trim(); if (v) set[v] = 1; }
      }
    } catch(ignored) {}
    return Object.keys(set).sort(function(a,b){ return a.localeCompare(b); });
  } catch(e) {
    return [];
  }
}

// ── 분류 마스터 (OF코드 기반) ─────────────────────────────────────
// 시트 Pricing_Classification: of_code · company · brand · market · in_house
// 최초 로드는 CSV(File>Import)로 채움. 신규는 upsertClassification 으로 성장.
function getClassificationSheet() {
  var ss = getOrCreateMainSpreadsheet();
  // 1) 정확한 이름에 데이터가 있으면 사용
  var exact = ss.getSheetByName('Pricing_Classification');
  if (exact && exact.getLastRow() > 1) return exact;
  // 2) 탭 이름이 달라도(예: 소문자 import) of_code 헤더를 가진 데이터 시트 자동 탐색
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.getLastRow() < 2 || sh.getLastColumn() < 1) continue;
    var hdr = sh.getRange(1, 1, 1, Math.min(sh.getLastColumn(), 10)).getValues()[0]
      .map(function(x){ return String(x).trim().toLowerCase(); });
    if (hdr.indexOf('of_code') !== -1 && hdr.indexOf('in_house') !== -1) return sh;
  }
  // 3) 없으면 정확한 이름으로 생성 (헤더만)
  if (exact) return exact;
  var sheet = ss.insertSheet('Pricing_Classification');
  sheet.appendRow(['of_code','company','brand','market','in_house']);
  sheet.setFrozenRows(1);
  return sheet;
}

// 헤더 인덱스 매핑 (컬럼 순서 바뀌어도 안전)
function classHeaderIndex(headers) {
  var h = headers.map(function(x){ return String(x).trim().toLowerCase(); });
  return {
    ofCode:  h.indexOf('of_code'),
    company: h.indexOf('company'),
    brand:   h.indexOf('brand'),
    market:  h.indexOf('market'),
    inHouse: h.indexOf('in_house'),
  };
}

function getClassifications() {
  try {
    var sheet = getClassificationSheet();
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    var ix   = classHeaderIndex(data[0]);
    if (ix.ofCode === -1) return [];
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var r  = data[i];
      var of = String(r[ix.ofCode] || '').trim().toUpperCase();
      if (!of) continue;
      rows.push({
        ofCode:  of,
        company: ix.company !== -1 ? String(r[ix.company] || '').trim() : '',
        brand:   ix.brand   !== -1 ? String(r[ix.brand]   || '').trim() : '',
        market:  ix.market  !== -1 ? String(r[ix.market]  || '').trim() : '',
        inHouse: ix.inHouse !== -1 && String(r[ix.inHouse] || '').trim().toUpperCase() === 'Y',
      });
    }
    return rows;
  } catch(e) {
    return { error: 'Category master error: ' + e.message };
  }
}

// 자사 판정 — 자사 브랜드 OR 자사 회사(채널)
var INHOUSE_COMPANIES = ['Demo Labs','Demo Labs korea  co., ltd','Demo Labs korea co., ltd','Demo Outlet','crmdemo'];
function isInHouse(company, brand) {
  var c = String(company || '').trim().toLowerCase();
  if (INHOUSE_COMPANIES.indexOf(c) !== -1) return true;
  var b = String(brand || '').toLowerCase().replace(/\s+/g,'').replace(/&/g,'and');
  if (!b) return false;
  if (b.indexOf('demolabs') !== -1) return true;
  if (b.indexOf('harbourline') === 0)        return true;
  if (b.indexOf('fernwood') !== -1)   return true;
  var EXACT = ['demolabs','demooutlet','fernwood'];
  return EXACT.indexOf(b) !== -1;
}

// 신규/변경 OF 분류를 마스터에 반영 (DB 성장).
// meta.inHouse 가 명시되면(true/false/'Y'/'') 그대로, 없으면 규칙(isInHouse)으로 자동 산정.
function upsertClassification(ofCode, meta) {
  try {
    var of = String(ofCode || '').trim().toUpperCase();
    if (!of) return { error: 'OF code required.' };
    var sheet = getClassificationSheet();
    var data  = sheet.getDataRange().getValues();
    var ix    = classHeaderIndex(data[0]);
    var inh;
    if (meta.inHouse === undefined || meta.inHouse === null) {
      inh = isInHouse(meta.company, meta.brand) ? 'Y' : '';
    } else {
      inh = (meta.inHouse === true || String(meta.inHouse).toUpperCase() === 'Y') ? 'Y' : '';
    }
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ix.ofCode] || '').trim().toUpperCase() === of) {
        var rowNum = i + 1;
        if (ix.company !== -1) sheet.getRange(rowNum, ix.company + 1).setValue(meta.company || '');
        if (ix.brand   !== -1) sheet.getRange(rowNum, ix.brand   + 1).setValue(meta.brand   || '');
        if (ix.market  !== -1 && meta.market != null) sheet.getRange(rowNum, ix.market + 1).setValue(meta.market || '');
        if (ix.inHouse !== -1) sheet.getRange(rowNum, ix.inHouse + 1).setValue(inh);
        return { ok: true, updated: true, inHouse: inh === 'Y' };
      }
    }
    sheet.appendRow([of, meta.company || '', meta.brand || '', meta.market || '', inh]);
    return { ok: true, added: true, inHouse: inh === 'Y' };
  } catch(e) {
    return { error: 'Category save error: ' + e.message };
  }
}

// 분류 마스터 행 삭제 (OF코드 기준)
function deleteClassification(ofCode) {
  try {
    var of = String(ofCode || '').trim().toUpperCase();
    if (!of) return { error: 'OF code required.' };
    var sheet = getClassificationSheet();
    var data  = sheet.getDataRange().getValues();
    var ix    = classHeaderIndex(data[0]);
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][ix.ofCode] || '').trim().toUpperCase() === of) {
        sheet.deleteRow(i + 1);
        return { ok: true };
      }
    }
    return { error: 'OF code not found: ' + of };
  } catch(e) {
    return { error: 'Category delete error: ' + e.message };
  }
}

// bulk 등록/주기 업데이트 — 전량 덮어쓰기. rows: [{of_code, company, brand, market, in_house}]
function importClassifications(rows) {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('Pricing_Classification') || ss.insertSheet('Pricing_Classification');
    sheet.clearContents();
    sheet.appendRow(['of_code','company','brand','market','in_house']);
    sheet.setFrozenRows(1);
    if (rows && rows.length) {
      var out = rows.map(function(r){
        return [
          String(r.of_code || r.ofCode || '').toUpperCase(),
          r.company || '', r.brand || '', r.market || '',
          r.in_house || r.inHouse || '',
        ];
      });
      sheet.getRange(2, 1, out.length, 5).setValues(out);
    }
    return { ok: true, count: (rows || []).length };
  } catch(e) {
    return { error: 'Category master save error: ' + e.message };
  }
}

function getEstimateById(id) {
  try {
    var sheet = getHistorySheetForId(id);
    if (!sheet) return { error: 'Quote sheet not found: ' + id };
    var data  = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(id).trim()) {
        return {
          id:     String(data[i][0]),
          status: String(data[i][4] || 'Draft'),
          memo:   String(data[i][7] || ''),
          data:   String(data[i][9] || ''),
        };
      }
    }
    return { error: 'Quote not found: ' + id };
  } catch(e) {
    return { error: 'Lookup error: ' + e.message };
  }
}

function updateEstimateStatus(id, status, memo) {
  try {
    var sheet = getHistorySheetForId(id);
    if (!sheet) return { error: 'Quote sheet not found: ' + id };
    var data  = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(id).trim()) {
        if (status != null) sheet.getRange(i + 1, 5).setValue(status);
        if (memo   != null) sheet.getRange(i + 1, 8).setValue(memo);
        return { success: true };
      }
    }
    return { error: 'Quote not found: ' + id };
  } catch(e) {
    return { error: 'Update error: ' + e.message };
  }
}

// ================================================================
// TOOL 3 — 계산 설정 (Pricing_Settings)
// ================================================================

var PRICING_SETTINGS_DEFAULTS = {
  custom_general_usd:         2.2448,
  custom_fishoil_gelatin_usd: 0.4,
  freight_air_usd:            6.9,
  freight_sea_usd:            0.4,
  loss_rate_default:          8,
  admin_cost_nzd:             290,
};

var PRICING_SETTINGS_DESC = {
  custom_general_usd:         'Customs, general imported ingredients (USD)',
  custom_fishoil_gelatin_usd: 'Customs, fish oil/gelatin (USD)',
  freight_air_usd:            'Air freight (USD)',
  freight_sea_usd:            'Sea freight (USD)',
  loss_rate_default:          'Default loss rate (%)',
  admin_cost_nzd:             'Admin & Management fixed cost (NZD)',
};

function getPricingSettings() {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('Pricing_Settings');
    if (!sheet) return PRICING_SETTINGS_DEFAULTS;

    var data     = sheet.getDataRange().getValues();
    var settings = {};
    for (var k in PRICING_SETTINGS_DEFAULTS) settings[k] = PRICING_SETTINGS_DEFAULTS[k];

    for (var i = 1; i < data.length; i++) {
      var key = String(data[i][0] || '').trim();
      var val = data[i][1];
      if (key && val !== '' && val !== null) settings[key] = parseFloat(val) || val;
    }
    return settings;
  } catch(e) {
    return { error: 'Settings lookup error: ' + e.message };
  }
}

function savePricingSettings(settings) {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('Pricing_Settings');
    if (!sheet) {
      sheet = ss.insertSheet('Pricing_Settings');
      sheet.appendRow(['key', 'value', 'description']);
      sheet.setFrozenRows(1);
    }

    var lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 3).clearContent();

    var rows = [];
    for (var k in settings) {
      rows.push([k, settings[k], PRICING_SETTINGS_DESC[k] || '']);
    }
    if (rows.length > 0) sheet.getRange(2, 1, rows.length, 3).setValues(rows);

    return { success: true };
  } catch(e) {
    return { error: 'Settings save error: ' + e.message };
  }
}

// ================================================================
// TOOL 3 — 이전 공급가 조회
// ================================================================

function checkSupplyPriceSheet() {
  var cfg = getConfig();
  Logger.log('=== Supply Price diagnostics ===');
  Logger.log('SUPPLY_PRICE_SPREADSHEET_ID: ' + cfg.SUPPLY_PRICE_SPREADSHEET_ID);
  if (!cfg.SUPPLY_PRICE_SPREADSHEET_ID) { Logger.log('❌ ScriptProperty not set'); return; }

  var ss;
  try {
    ss = SpreadsheetApp.openById(cfg.SUPPLY_PRICE_SPREADSHEET_ID);
    Logger.log('Spreadsheet name: ' + ss.getName());
  } catch(e) { Logger.log('❌ Failed to open: ' + e.message); return; }

  var sheetNames = ss.getSheets().map(function(s) { return s.getName(); });
  Logger.log('Sheets: ' + sheetNames.join(', '));

  var sheet = ss.getSheetByName('Sheet1');
  if (!sheet) { Logger.log('❌ No Sheet1'); return; }

  var data = sheet.getDataRange().getValues();
  Logger.log('Total rows (incl. header): ' + data.length);
  Logger.log('Header: ' + data[0].join(' | '));

  var statusIdx = data[0].map(function(h){return String(h).trim();}).indexOf('status');
  var codeIdx   = data[0].map(function(h){return String(h).trim();}).indexOf('product_code');
  Logger.log('product_code column index: ' + codeIdx + '  status column index: ' + statusIdx);

  for (var i = 1; i <= Math.min(5, data.length - 1); i++) {
    Logger.log('row' + i + ': ' + data[i].join(' | '));
  }

  var statusCount = {};
  for (var j = 1; j < data.length; j++) {
    var s = statusIdx !== -1 ? String(data[j][statusIdx] || '').trim().toLowerCase() : '(unknown)';
    statusCount[s] = (statusCount[s] || 0) + 1;
  }
  Logger.log('Count by status: ' + JSON.stringify(statusCount));

  Logger.log('--- OF code sample (with status) ---');
  var ofCount = 0;
  for (var k = 1; k < data.length && ofCount < 3; k++) {
    var pc = codeIdx !== -1 ? String(data[k][codeIdx] || '').trim().toUpperCase() : '';
    if (pc.indexOf('OF') === 0) {
      Logger.log('row' + k + ': ' + data[k].join(' | '));
      Logger.log('  code charCodes: ' + String(data[k][codeIdx]).split('').map(function(c){return c.charCodeAt(0);}).join(','));
      Logger.log('  status raw: [' + data[k][statusIdx] + '] → toLowerCase: [' + String(data[k][statusIdx]||'').toLowerCase() + ']');
      ofCount++;
    }
  }
  if (ofCount === 0) Logger.log('No product_code starting with OF');
}

function normalizeCode(val) {
  return String(val || '').replace(/[\s ​﻿\r\n]/g, '').toUpperCase();
}

// 이전 공급가 데이터 시트 획득 — 메인 시트 Supply_Price 탭(업로드 적재) 우선, 없으면 외부 레거시 시트
function getSupplyPriceSheet() {
  try {
    var ss = getOrCreateMainSpreadsheet();
    var sh = ss.getSheetByName('Supply_Price');
    if (sh && sh.getLastRow() > 1) return sh;
  } catch(e) {}
  var cfg = getConfig();
  if (cfg.SUPPLY_PRICE_SPREADSHEET_ID) {
    try {
      var ext = SpreadsheetApp.openById(cfg.SUPPLY_PRICE_SPREADSHEET_ID);
      var s1  = ext.getSheetByName('Sheet1');
      if (s1) return s1;
    } catch(e) {}
  }
  return null;
}

function getPreviousPrice(productCode, capPerBottle) {
  try {
    var sheet = getSupplyPriceSheet();
    if (!sheet) {
      return { error: 'No previous supply price data. Upload the Sales History CSV on the Data upload page.' };
    }

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];

    var headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
    var idx = {
      code:         headers.indexOf('product_code'),
      registerDate: headers.indexOf('register_date'),
      unitPrice:    headers.indexOf('unit_price'),
      productName:  headers.indexOf('product_name'),
      status:       headers.indexOf('status'),
    };

    var missing = [];
    if (idx.code         === -1) missing.push('product_code');
    if (idx.registerDate === -1) missing.push('register_date');
    if (idx.unitPrice    === -1) missing.push('unit_price');
    if (idx.status       === -1) missing.push('status');
    if (missing.length) {
      return { error: 'Column not found: ' + missing.join(', ') + ' | actual header: ' + data[0].join(', ') };
    }

    var target = normalizeCode(productCode);
    var prefix = target.substring(0, 2);
    var cpb    = parseFloat(capPerBottle) || 60;

    var results = [];

    for (var i = 1; i < data.length; i++) {
      var row    = data[i];
      var code   = normalizeCode(row[idx.code]);
      if (code !== target) continue;

      var rawPrice    = parseFloat(row[idx.unitPrice]) || 0;
      var unitPricePk = (prefix === 'OB') ? rawPrice * cpb : rawPrice;
      var statusRaw   = String(row[idx.status] || '').trim();
      var statusLc    = statusRaw.toLowerCase();
      var isConfirmed = (statusLc === 'confirm' || statusLc === 'finished');

      results.push({
        registerDate: toYmd(row[idx.registerDate]),
        unitPrice:    unitPricePk,
        unitPriceRaw: rawPrice,
        productName:  String(row[idx.productName] || ''),
        status:       statusRaw,
        prefix:       prefix,
        warn:         !isConfirmed,
      });
    }

    results.sort(function(a, b) { return b.registerDate.localeCompare(a.registerDate); });
    return results.slice(0, 3);
  } catch(e) {
    return { error: 'Previous supply price error: ' + e.message };
  }
}

// 이전 공급가 중복 판정 키 — 코드|날짜|단가 (기존 5컬럼 데이터와도 호환)
function supplyPriceKey(code, date, price) {
  return normalizeCode(code) + '|' + String(date || '').trim() + '|' + (parseFloat(price) || 0);
}

// Sales History CSV → 메인 시트 Supply_Price 탭 누적 적재 (이전 공급가 소스)
// 필요한 5개 컬럼만 추출, unit_price>0 행만, 이미 있는 행은 건너뛰고 없는 행만 추가
function importSupplyPrice(rows) {
  try {
    if (!rows || !rows.length) return { ok: false, error: 'No data' };

    var ss = getOrCreateMainSpreadsheet();
    var sh = ss.getSheetByName('Supply_Price');

    // 1) 기존 데이터 로드 + 중복 키 집합
    var merged = [];   // 최종 행 [code, date, price, name, status]
    var seen   = {};
    if (sh && sh.getLastRow() > 1) {
      var cur = sh.getDataRange().getValues();
      var h   = cur[0].map(function(x){ return String(x || '').trim().toLowerCase(); });
      var ci  = {
        code:  h.indexOf('product_code'),
        date:  h.indexOf('register_date'),
        price: h.indexOf('unit_price'),
        name:  h.indexOf('product_name'),
        st:    h.indexOf('status')
      };
      for (var i = 1; i < cur.length; i++) {
        var row  = cur[i];
        var code = ci.code >= 0 ? String(row[ci.code] || '').trim() : '';
        if (!code) continue;
        var date = ci.date  >= 0 ? toYmd(row[ci.date]) : '';
        var pr   = ci.price >= 0 ? (parseFloat(row[ci.price]) || 0)  : 0;
        var key  = supplyPriceKey(code, date, pr);
        if (seen[key]) continue;
        seen[key] = true;
        merged.push([
          code, date, pr,
          ci.name >= 0 ? String(row[ci.name] || '').trim() : '',
          ci.st   >= 0 ? String(row[ci.st]   || '').trim() : ''
        ]);
      }
    }
    var before = merged.length;

    // 2) 신규 행 추가 (없는 것만)
    for (var j = 0; j < rows.length; j++) {
      var r  = rows[j], lc = {};
      for (var k in r) lc[String(k).trim().toLowerCase()] = r[k];

      var ncode  = String(lc['product_code'] || '').trim();
      var nprice = parseFloat(lc['unit_price']);
      if (!ncode) continue;
      if (!(nprice > 0)) continue;             // 가격 없는(0/공란) 행 제외

      var ndate = toYmd(lc['register_date']);
      var nkey  = supplyPriceKey(ncode, ndate, nprice);
      if (seen[nkey]) continue;
      seen[nkey] = true;
      merged.push([
        ncode, ndate, nprice,
        String(lc['product_name'] || '').trim(),
        (String(lc['status'] || '').trim() || 'confirm')
      ]);
    }

    if (!merged.length) return { ok: false, error: 'No rows with a price (unit_price>0)' };

    if (!sh) sh = ss.insertSheet('Supply_Price');
    sh.clear();
    sh.getRange(1, 1, 1, 5).setValues([['product_code', 'register_date', 'unit_price', 'product_name', 'status']]);
    sh.getRange(2, 1, merged.length, 5).setValues(merged);
    sh.setFrozenRows(1);

    return { ok: true, count: merged.length, added: merged.length - before };
  } catch(e) {
    return { ok: false, error: 'Previous supply price load error: ' + e.message };
  }
}

// ================================================================
// TOOL 3 — Processing 단가 설정
// ================================================================

var PROC_TIER_KEYS = [
  'sgc_3oval','sgc_5oval','sgc_12oval','sgc_20oblong','sgc_24oblong',
  'hardCap','tablet_500mg','tablet_2000mg',
  'bottling','powderFill','liquid','casePkgBottle','coding',
];

function getProcessingSettings() {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('Processing_Settings');
    if (!sheet) return {};

    var data = sheet.getDataRange().getValues();
    var result = {};
    for (var i = 1; i < data.length; i++) {
      var key = String(data[i][0] || '').trim();
      var val = String(data[i][1] || '').trim();
      if (!key || !val) continue;
      try { result[key] = JSON.parse(val); } catch(ignored) {}
    }
    return result;
  } catch(e) {
    return { error: 'Processing settings lookup error: ' + e.message };
  }
}

function saveProcessingSettings(tiers) {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('Processing_Settings');
    if (!sheet) {
      sheet = ss.insertSheet('Processing_Settings');
      sheet.appendRow(['tier_key', 'value']);
      sheet.setFrozenRows(1);
    }

    var lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 2).clearContent();

    var rows = [];
    for (var k in tiers) {
      if (tiers[k]) rows.push([k, JSON.stringify(tiers[k])]);
    }
    if (rows.length > 0) sheet.getRange(2, 1, rows.length, 2).setValues(rows);

    return { success: true };
  } catch(e) {
    return { error: 'Processing settings save error: ' + e.message };
  }
}

// ── Encapsulation 임가공비 역산 모델 ────────────────────────────
// batchCost(하루 임가공비) ÷ (ref||daily 생산정수) × 1000 = per-1000캡 기본단가
// 주문량(총캡슐수)/생산정수 비율에 curve 배율을 곱해 구간별 단가 자동 산출
var DEFAULT_ENCAP_LABOR = {
  batchCost: 4200,
  presets: [3500, 3300, 4900],
  sizes: {
    sgc_3oval:     { daily: 510000, ref: null },
    sgc_5oval:     { daily: 480000, ref: 290000 },
    sgc_12oval:    { daily: 450000, ref: null },
    sgc_20oblong:  { daily: 190000, ref: null },
    sgc_24oblong:  { daily: 180000, ref: null },
    hardCap:       { daily: 170000, ref: null },
    tablet_500mg:  { daily: 280000, ref: null },
    tablet_2000mg: { daily: 180000, ref: null }
  },
  // [주문량/생산정수 비율 상한, per-1000 배율] — 소량일수록 비싸고 대량일수록 할인
  curve: [[0.32, 1.52], [0.50, 1.30], [1.00, 1.00], [1.85, 0.83], [4.31, 0.84], [null, 0.95]]
};

function getEncapLaborModel() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('ENCAP_LABOR_MODEL');
    if (!raw) return DEFAULT_ENCAP_LABOR;
    var m = JSON.parse(raw);
    // 기본값과 병합 (누락 사이즈 보강)
    var out = {
      batchCost: (typeof m.batchCost === 'number' && m.batchCost > 0) ? m.batchCost : DEFAULT_ENCAP_LABOR.batchCost,
      presets: Array.isArray(m.presets) && m.presets.length ? m.presets : DEFAULT_ENCAP_LABOR.presets,
      sizes: {},
      curve: Array.isArray(m.curve) && m.curve.length ? m.curve : DEFAULT_ENCAP_LABOR.curve
    };
    for (var k in DEFAULT_ENCAP_LABOR.sizes) {
      var src = (m.sizes && m.sizes[k]) ? m.sizes[k] : DEFAULT_ENCAP_LABOR.sizes[k];
      out.sizes[k] = { daily: Number(src.daily) || DEFAULT_ENCAP_LABOR.sizes[k].daily,
                       ref: (src.ref != null && Number(src.ref) > 0) ? Number(src.ref) : null };
    }
    return out;
  } catch(e) {
    return DEFAULT_ENCAP_LABOR;
  }
}

function saveEncapLaborModel(model) {
  try {
    if (!model || typeof model !== 'object') return { error: 'Invalid data' };
    // 최소 검증 후 그대로 저장 (getEncapLaborModel 에서 병합/보정)
    PropertiesService.getScriptProperties().setProperty('ENCAP_LABOR_MODEL', JSON.stringify(model));
    return { success: true };
  } catch(e) {
    return { error: 'Encapsulation back-calculation model save error: ' + e.message };
  }
}

// ── 회사/브랜드별 Test 비용 기본값 규칙 ──────────────────────────
// 회사명 또는 브랜드명에 keyword 가 포함되면 해당 cost 를 Test 비용 기본값으로 자동 입력
var DEFAULT_TEST_COST_RULES = [
  { keyword: 'Kauri Wellness',    cost: 350 },
  { keyword: 'Tui Naturals', cost: 410 },
  { keyword: 'Southern Light',     cost: 740 }
];

function getTestCostRules() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('TEST_COST_RULES');
    if (!raw) return DEFAULT_TEST_COST_RULES;
    var arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_TEST_COST_RULES;
    return arr.filter(function(r){ return r && String(r.keyword || '').trim(); })
              .map(function(r){ return { keyword: String(r.keyword).trim(), cost: Number(r.cost) || 0 }; });
  } catch(e) {
    return DEFAULT_TEST_COST_RULES;
  }
}

function saveTestCostRules(rules) {
  try {
    if (!Array.isArray(rules)) return { error: 'Invalid data' };
    var clean = rules.filter(function(r){ return r && String(r.keyword || '').trim(); })
                     .map(function(r){ return { keyword: String(r.keyword).trim(), cost: Number(r.cost) || 0 }; });
    PropertiesService.getScriptProperties().setProperty('TEST_COST_RULES', JSON.stringify(clean));
    return { ok: true, count: clean.length };
  } catch(e) {
    return { error: 'Test cost rules save error: ' + e.message };
  }
}

// ================================================================
// TOOL 3 — PROCUREMENT (구매팀 Sourcing & Updates · 단가 근거)
// ================================================================
// 시트 직접 연결 전까지는 다운로드한 엑셀을 업로드한 스냅샷 사용
// (메인 시트 Procurement_List / Procurement_PriceUpdate 탭, 메타는 ScriptProperties PROCUREMENT_META)

// [내부 키, 헤더 앞부분] — 헤더는 줄바꿈·공백 정규화 후 가장 긴 일치 항목으로 매핑
var PROC_LIST_COLS = [
  ['progress', 'progress'], ['requestType', 'type of request'], ['date', 'date'], ['requestedBy', 'requested by'],
  ['code', 'or code'], ['name', 'name'], ['materialType', 'material type'], ['askFor', 'things to ask for'],
  ['qtyRequired', 'qty, expected time'], ['category', 'category'], ['brand', 'brand'], ['obCode', 'ob code'],
  ['targetMarket', 'target market'], ['requesterRemark', "requester's remark"], ['updatedBy', 'updated by'],
  ['result', 'result updated'], ['procRemark', "procurement's remark"],
];
var PROC_PU_COLS = [
  ['date', 'date'], ['category', 'category'], ['code', 'or/op code'], ['description', 'description'], ['supplier', 'supplier'],
  ['currentPrice', 'current price'], ['currentCurr', 'current curr'], ['currentTerm', 'current price term'],
  ['previousPrice', 'previous price'], ['previousCurr', 'previous currency'], ['previousTerm', 'previous price term'],
  ['validPeriod', 'valid period'], ['currentNzdKg', 'current price (nzd/kg)'], ['previousNzdKg', 'previous price (nzd/kg)'],
  ['variance', 'variance'], ['reason', 'reason'], ['remark', 'remark'], ['updatedBy', 'updated by'],
];
var PROC_DATE_KEYS = { date: true, validPeriod: true };

// 2D 배열(엑셀 탭) → 헤더 행 탐지 후 [{key: value}] 로 정규화
function normalizeProcTable(values, spec) {
  if (!values || !values.length) return { rows: [] };
  var norm = function(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); };
  var mapHeader = function(row) {
    var map = {}, n = 0;
    row.forEach(function(h, ci) {
      var t = norm(h), best = null;
      if (!t) return;
      spec.forEach(function(s) {
        if (t.indexOf(s[1]) === 0 && (!best || s[1].length > best[1].length)) best = s;
      });
      if (best && map[best[0]] == null) { map[best[0]] = ci; n++; }
    });
    return { map: map, n: n };
  };
  var hi = -1, hm = null;
  for (var r = 0; r < Math.min(values.length, 12); r++) {
    var m = mapHeader(values[r] || []);
    if (m.n >= 4 && (m.map.name != null || m.map.code != null || m.map.description != null)) { hi = r; hm = m.map; break; }
  }
  if (hi === -1) return { error: 'Header row not found (Progress / Name / OR CODE, etc.).' };
  var rows = [];
  for (var i = hi + 1; i < values.length; i++) {
    var src = values[i] || [], o = {}, filled = false;
    spec.forEach(function(s) {
      var ci = hm[s[0]];
      var v = ci != null ? src[ci] : '';
      v = PROC_DATE_KEYS[s[0]] ? toYmd(v) : String(v == null ? '' : v).trim();
      o[s[0]] = v;
    });
    if (o.name || o.code || o.description) filled = true;
    if (filled) rows.push(o);
  }
  return { rows: rows };
}

function writeProcSheet(ss, name, spec, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  var keys = spec.map(function(s) { return s[0]; });
  var data = [keys].concat(rows.map(function(o) { return keys.map(function(k) { return o[k] || ''; }); }));
  var range = sheet.getRange(1, 1, data.length, keys.length);
  range.setNumberFormat('@');   // 날짜·숫자 자동 변환 방지 (원문 보존)
  range.setValues(data);
  sheet.setFrozenRows(1);
}

// Master 탭 FX Standard (구매팀 기준 환율, 참고용) → [{currency, rate, date}]
function parseFxStandard(values) {
  var out = [];
  (values || []).forEach(function(r) {
    var cur = String(r[0] || '').trim().toUpperCase();
    var rate = parseFloat(r[1]);
    if (/^[A-Z]{3}$/.test(cur) && rate > 0) out.push({ currency: cur, rate: rate, date: toYmd(r[2]) });
  });
  return out;
}

// 엑셀 업로드 → 스냅샷 저장. payload = { fileName, list, priceUpdate, master } (각 탭 2D 배열)
function importProcurement(payload) {
  try {
    var list = normalizeProcTable(payload && payload.list, PROC_LIST_COLS);
    if (list.error) return { error: 'List tab: ' + list.error };
    if (!list.rows.length) return { error: 'No request rows found in the List tab.' };
    var pu = normalizeProcTable(payload.priceUpdate, PROC_PU_COLS);
    var ss = getOrCreateMainSpreadsheet();
    writeProcSheet(ss, 'Procurement_List', PROC_LIST_COLS, list.rows);
    writeProcSheet(ss, 'Procurement_PriceUpdate', PROC_PU_COLS, pu.rows || []);
    var meta = {
      updatedAt:  Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
      fileName:   String(payload.fileName || ''),
      listCount:  list.rows.length,
      puCount:    (pu.rows || []).length,
      fxStandard: parseFxStandard(payload.master),
    };
    PropertiesService.getScriptProperties().setProperty('PROCUREMENT_META', JSON.stringify(meta));
    return { ok: true, count: meta.listCount, puCount: meta.puCount, meta: meta };
  } catch(e) { return { error: 'Procurement upload error: ' + e.message }; }
}

function getProcurementMeta() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('PROCUREMENT_META') || 'null'); }
  catch(e) { return null; }
}

function readProcSheet(name) {
  var sheet = getOrCreateMainSpreadsheet().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues(), keys = data[0];
  return data.slice(1).map(function(r) {
    var o = {};
    keys.forEach(function(k, i) { o[k] = PROC_DATE_KEYS[k] ? toYmd(r[i]) : String(r[i] == null ? '' : r[i]); });
    return o;
  });
}

// ── 공급사 → 통화·운송·조건 최빈값 (raw_cost + packaging_cost). '$'만 적힌 회신의 통화 추정용 ──
function getPkgCostSheet() {
  var id = getConfig().PKG_COST_SPREADSHEET_ID;
  if (!id) return null;
  try { return SpreadsheetApp.openById(id).getSheetByName('packaging_cost'); } catch(e) { return null; }
}

function getSupplierPriors() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('supplierPriors_v1');
  if (hit) return JSON.parse(hit);
  var acc = {};
  [getRawCostSheet(), getPkgCostSheet()].forEach(function(sheet) {
    if (!sheet) return;
    var data = sheet.getDataRange().getValues(), h = data[0];
    var iS = col(h, 'supplier_name'), iC = col(h, 'currency'), iM = col(h, 'shipping_method'), iI = col(h, 'incoterms');
    if (iS === -1 || iC === -1) return;
    for (var i = 1; i < data.length; i++) {
      var s = String(data[i][iS] || '').trim();
      if (!s) continue;
      var a = acc[s] || (acc[s] = { cur: {}, ship: {}, inc: {}, n: 0 });
      a.n++;
      var c = String(data[i][iC] || '').trim().toUpperCase(); if (c) a.cur[c] = (a.cur[c] || 0) + 1;
      var m = iM !== -1 ? shippingFromMethod(data[i][iM]) : ''; if (m) a.ship[m] = (a.ship[m] || 0) + 1;
      var t = iI !== -1 ? String(data[i][iI] || '').trim().toUpperCase() : ''; if (t) a.inc[t] = (a.inc[t] || 0) + 1;
    }
  });
  var top = function(o) { var b = '', n = 0; for (var k in o) if (o[k] > n) { b = k; n = o[k]; } return b; };
  var out = {};
  for (var s in acc) out[s] = { currency: top(acc[s].cur), shipping: top(acc[s].ship), incoterms: top(acc[s].inc), n: acc[s].n };
  try { cache.put('supplierPriors_v1', JSON.stringify(out), 21600); } catch(e) {}
  return out;
}

// DB shipping_method → 계산기 운송 값 (Air / Sea / '')
function shippingFromMethod(sm) {
  var s = String(sm || '').toLowerCase();
  if (s.indexOf('air') !== -1 || s.indexOf('courier') !== -1) return 'Air';
  if (s.indexOf('sea') !== -1) return 'Sea';
  return '';
}

// 회신에 적힌 약칭(Milo, Guben, Pharmapac…) → DB 공급사 (단어 앞부분 일치, 건수 많은 쪽 우선)
function matchSupplier(alias, priors) {
  var a = String(alias || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  if (a.length < 3) return null;
  var best = null;
  for (var s in priors) {
    var words = s.toLowerCase().split(/[^a-z0-9]+/);
    var hit = words.some(function(w) { return w.length >= 3 && (w.indexOf(a) === 0 || a === w); }) ||
              (a.length >= 5 && s.toLowerCase().indexOf(a) !== -1);
    if (hit && (!best || priors[s].n > best.n)) best = { name: s, currency: priors[s].currency, shipping: priors[s].shipping, incoterms: priors[s].incoterms, n: priors[s].n };
  }
  return best;
}

// ── 구매팀 회신 원문(Result updated) → 가격 후보 ──
// 예: "Milo: usd21.5/kg fob / Guben ， USD45.9/kg fob， moq25kg" → [{supplier:'Milo', currency:'USD', price:21.5, unit:'kg', incoterms:'FOB'}, …]
var PROC_NOT_SUPPLIER = /price|moq|update|note|freight|wait|check|master|valid|lead|spec|sample|result|approx|stock|current|next|pack|for a\b/i;
var PROC_LEAD_STOP = { 'medium':1, 'super':1, 'with':1, 'from':1, 'only':1, 'please':1, 'still':1, 'quote':1, 'delivered':1, 'origin':1 };
var PROC_CUR_MAP = { 'usd':'USD', 'us$':'USD', 'us':'USD', 'nzd':'NZD', 'nz$':'NZD', 'aud':'AUD', 'au$':'AUD', 'rmb':'CNY', 'cny':'CNY', 'eur':'EUR', '€':'EUR', 'krw':'KRW', '$':'$' };
// [통화] [조건] 숫자 [통화] [/단위] — 통화가 앞이나 뒤 중 한 곳엔 있어야 가격으로 인정 (없으면 '/kg'·'per kg' 형태일 때만)
var PROC_PRICE_RE = /((?:usd|nzd|aud|eur)\s*\$|usd|us\$|us(?=\d)|nzd|nz\s?\$|aud|au\$|rmb|cny|eur|€|krw|\$)?\s*(?:(?:fob|cif|exw|ddp|dap)\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(usd|nzd|nz\$|aud|rmb|cny|eur)?\s*(?:(\/|per)\s*(kg|ea|g|unit|units|pc|pcs|piece|box|ctn|carton|drum|bag)\b|(kg|ea)\b)?/ig;
function parseProcPrices(text, defaultUnit, priors) {
  var src = String(text || '').replace(/，/g, ', ').replace(/：/g, ': ').replace(/（/g, '(').replace(/）/g, ')');
  if (!src.trim()) return [];
  priors = priors || {};
  var segs = src.split(/\n|\s\/\s|\s\/$|^\/\s/);
  var allTerms = src.match(/\b(fob|cif|cfr|exw|ex[\s-]?works|ddp|dap|fca|cip)\b/ig) || [];
  var uniqTerm = allTerms.length && allTerms.every(function(t) { return normTerm(t) === normTerm(allTerms[0]); }) ? normTerm(allTerms[0]) : '';
  var out = [], seen = {}, supplier = '';
  segs.forEach(function(seg) {
    // 공급사: "이름:" 접두, 없으면 첫 단어가 DB 공급사와 일치할 때 (예: "Guben , USD45.9/kg", "Milo EXW US$101.50")
    var sm = seg.match(/^\s*[-•]?\s*([A-Za-z][A-Za-z0-9&.'\- ]{1,40}?)\s*(?:\([^)]*\))?\s*:/);
    if (sm && !PROC_NOT_SUPPLIER.test(sm[1])) supplier = sm[1].trim();
    else {
      var lw = seg.match(/^\s*[-•]?\s*([A-Za-z][A-Za-z&'\-]{3,30})\b/);
      if (lw && !PROC_NOT_SUPPLIER.test(lw[1]) && !PROC_LEAD_STOP[lw[1].toLowerCase()] && matchSupplier(lw[1], priors)) supplier = lw[1];
    }
    var segTerm = (seg.match(/\b(fob|cif|cfr|exw|ex[\s-]?works|ddp|dap|fca|cip)\b/i) || [])[0];
    var segShip = (seg.match(/\b(air|sea|courier)\b/i) || [])[0];
    var moqM = seg.match(/moq\s*:?\s*(\d[\d,]*)\s*(kg|units?|pcs|ea)?/i);
    var sup = supplier ? matchSupplier(supplier, priors) : null;
    var m;
    PROC_PRICE_RE.lastIndex = 0;
    while ((m = PROC_PRICE_RE.exec(seg))) {
      if (!m[0].trim()) { PROC_PRICE_RE.lastIndex++; continue; }
      var pre = m[1], num = m[2], post = m[3], slash = m[4], unit = String(m[5] || m[6] || '').toLowerCase();
      if (!pre && !post && !(slash && unit)) continue;                         // 통화도 '/단위'도 없으면 숫자일 뿐
      var before = seg.slice(Math.max(0, m.index - 14), m.index), after = seg.slice(m.index + m[0].length, m.index + m[0].length + 24);
      if (/(freight|shipping|fx|rate|exchange|usd\/)[^\d]{0,12}$/i.test(before)) continue;   // 운임·환율 숫자 제외
      if (/^\s*(\+\s*gst\s*)?(\/|per)\s*(ctn|carton|box|drum|bag|pallet|roll)/i.test(after)) continue;
      if (/box|ctn|carton|drum|bag/.test(unit)) continue;                     // 운임·포장 단위 가격은 제외
      var price = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(num) ? parseFloat(num.replace(/,/g, '')) : parseFloat(num.replace(',', '.'));
      if (!(price > 0)) continue;
      if (unit === 'g') { price = price * 1000; unit = 'kg'; }
      if (/^(unit|units|pc|pcs|piece)$/.test(unit)) unit = 'ea';
      var perK = after.match(/^\s*per\s*1,?000\s*(pieces|pcs|capsules|caps|ea)\b/i);   // "$11.50 per 1,000 pieces"
      if (perK) { price = price / 1000; unit = 'ea'; }
      if (!unit && /(?:\d|\b)(?:ea|pcs|pieces|units?)\b/i.test(seg)) unit = 'ea';
      var curKey = String(post || pre || '').toLowerCase().replace(/\s/g, '').replace(/^(usd|nzd|aud|eur)\$$/, '$1');
      var cur = PROC_CUR_MAP[curKey] || '';
      var guessed = false;
      if (!cur || cur === '$') { cur = (sup && sup.currency) || 'NZD'; guessed = true; }
      var key = supplier + '|' + cur + '|' + price;
      if (seen[key]) continue;
      seen[key] = true;
      var ship = segShip ? (/sea/i.test(segShip) ? 'Sea' : 'Air') : ((sup && sup.shipping) || '');
      out.push({
        supplier: supplier, supplierDb: sup ? sup.name : '',
        currency: cur, currencyGuessed: guessed,
        price: price, unit: unit || defaultUnit,
        incoterms: segTerm ? normTerm(segTerm) : ((sup && sup.incoterms) || uniqTerm || ''),
        shipping: ship,
        moq: moqM ? (moqM[1] + (moqM[2] ? ' ' + moqM[2] : '')) : '',
        snippet: seg.trim().slice(0, 160),
      });
    }
  });
  return out;
}
function normTerm(t) { var s = String(t || '').toUpperCase().replace(/[\s-]/g, ''); return s === 'EXWORKS' ? 'EXW' : s; }

// ── 원료명 유사도 (꼬리표·철자 변형 정규화 후 토큰 비교) ──
var NAME_STOP = { powder:1, extract:1, the:1, and:1, with:1, from:1, equiv:1, equivalent:1, aka:1, per:1, cap:1, caps:1, capsule:1, for:1,
  of:1, to:1, in:1, or:1, on:1, by:1, as:1, at:1, an:1, no:1, iu:1, mg:1, mcg:1, kg:1, nz:1, au:1, kr:1, us:1, cn:1 };
// 고객·용도 꼬리표 제거: (TF) · (For Market X, MKX) · (Eligible for KR …) · Equiv. to …
function stripNameTags(name) {
  return String(name || '').toLowerCase()
    .replace(/\((?:for |eligible|tf\b|mkx)[^)]*\)/g, ' ')
    .replace(/,?\s*for market x\b|\bmkx\b|eligible for kr[^)]*/g, ' ')
    .replace(/equiv\.?\s*to.*$/, ' ');
}
// 토큰: 영문 포함 2자 이상 (D3·K2·400ml·38mm 같은 규격 포함, 순수 숫자 제외)
function nameTokens(name) {
  var s = stripNameTags(name)
    .replace(/[®™]/g, ' ')
    .replace(/(\d)\s+(ml|mm|g|mg|kg)\b/g, '$1$2')
    .replace(/ised\b/g, 'ized').replace(/ysed\b/g, 'yzed').replace(/colour/g, 'color').replace(/flavour/g, 'flavor');
  var set = {};
  (s.match(/[a-z0-9][a-z0-9-]*/g) || []).forEach(function(t) {
    if (t.length >= 2 && /[a-z]/.test(t) && !NAME_STOP[t]) set[t] = true;
  });
  return Object.keys(set);
}
function nameSimilarity(ta, tb) {
  if (!ta.length || !tb.length) return 0;
  var inter = 0, setB = {};
  tb.forEach(function(t) { setB[t] = true; });
  ta.forEach(function(t) { if (setB[t]) inter++; });
  var j = inter / (ta.length + tb.length - inter);
  var c = inter / Math.min(ta.length, tb.length);
  return 0.6 * j + 0.4 * c;
}
function normCode(c) { var s = String(c || '').trim().toUpperCase(); return /^O[RPBFC]\d{4}$/.test(s) ? s : ''; }

// Procurement 페이지용 전체 데이터 (회신 가격 파싱 포함)
function getProcurementData() {
  try {
    var meta = getProcurementMeta();
    if (!meta) return { meta: null, list: [], priceUpdate: [] };
    var priors = getSupplierPriors();
    var list = readProcSheet('Procurement_List').map(function(o) {
      o.prices = parseProcPrices(o.result, procDefaultUnit(o), priors);
      return o;
    });
    return { meta: meta, list: list, priceUpdate: readProcSheet('Procurement_PriceUpdate') };
  } catch(e) { return { error: 'Procurement lookup error: ' + e.message }; }
}

function procDefaultUnit(o) {
  var t = String((o.materialType || '') + ' ' + (o.code || '')).toLowerCase();
  return /packag|shell|bottle|lid|label|\bop\d/.test(t) ? 'ea' : 'kg';
}

// 'Price finder' — 코드 일치 우선, 없으면 원료명 유사도로 구매 요청·회신·가격변경 기록 + 회사 DB 유사 품목
// q = { code, name, kind: 'raw'|'pkg', packagingType }
function findPriceEvidence(q) {
  try {
    var db = null, aiPrev = null;
    try { db = getDbAnalogs(q || {}); } catch(e) { db = { error: e.message }; }
    try { aiPrev = getStoredEstimate(q || {}); } catch(e) { aiPrev = null; }
    var meta = getProcurementMeta();
    if (!meta) return { meta: null, matches: [], priceUpdates: [], db: db, aiPrev: aiPrev };
    var code = normCode(q && q.code), toks = nameTokens(q && q.name);
    var priors = getSupplierPriors();
    var score = function(c, n) {
      if (code && normCode(c) === code) return 1;
      return nameSimilarity(toks, nameTokens(n));
    };
    var matches = readProcSheet('Procurement_List').map(function(o) {
      o.score = score(o.code, o.name);
      return o;
    }).filter(function(o) { return o.score >= 0.45; });
    matches.sort(function(a, b) { return (b.score - a.score) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); });
    matches = matches.slice(0, 8).map(function(o) {
      o.prices = parseProcPrices(o.result, procDefaultUnit(o), priors);
      return o;
    });
    var pus = readProcSheet('Procurement_PriceUpdate').filter(function(o) {
      return score(o.code, o.description) >= 0.6;
    });
    return { meta: meta, matches: matches, priceUpdates: pus, db: db, aiPrev: aiPrev };
  } catch(e) { return { error: 'Purchase history error: ' + e.message }; }
}

// ── 단가 추정 근거: 회사 DB 유사 원료·부자재 (방법론 4장) ──────────────────

// 원료 분류 — 이름 키워드 규칙 (위에서부터 먼저 맞는 것). 고객 꼬리표는 nameForClass 에서 제거
var ING_CLASS_RULES = [
  ['branded',        /[®™]/],
  ['probiotic',      /cfu|lactobac|bifido|probiotic|bacillus|streptococcus|saccharomyces|billion/],
  ['excipient',      /^(?!.*extract).*(microcrystalline|\bmcc\b|stearate|silicon dioxide|silica|maltodextrin|starch|dicalcium|croscarmellose|stearic|glycer|sorbitol|xylitol|stevia|sucralose|flavou?r|colou?r|\blake\b|coating|talc|sugar|dextrose|citric acid|lecithin)/],
  ['vitamin',        /vitamin|biotin|folic|folate|cobalamin|niacin|thiamin|riboflavin|pyridox|ascorb|tocopher|retin|cholecalciferol|menaquinone|pantothen/],
  ['mineral',        /^(?!.*extract).*(\bzinc|magnesium|calcium|\biron\b|ferrous|ferric|selen|chromium|potassium|copper|manganese|iodine|iodide|boron|molybd)/],
  ['oil',            /\boil\b|omega|krill|\bdha\b|\bepa\b|softgel/],
  ['protein/animal', /collagen|peptide|protein|keratin|elastin|whey|hydroly[sz]|membrane|placenta|colostrum|lactoferrin|velvet|cartilage|\bbone\b|mussel|royal jelly|propolis|bee pollen|\bhoney\b/],
  ['compound',       /(^|\s)l-|acetyl|carnitine|glutathione|\bnac\b|taurine|glycine|arginine|creatine|betaine|coq10|ubiquin|pqq|\bnmn\b|nicotinamide|resveratrol|quercetin|rutin|lutein|zeaxanthin|astaxanthin|hyaluron|glucosamine|chondroitin|\bmsm\b|inositol|choline|melatonin|lipoic|spermidine|ergothioneine|pterostilbene|berberine|curcumin|policosanol|lycopene|sulforaphane|theanine|\bgaba\b|5-htp|tyrosine/],
  ['extract-ratio',  /\d+\s*:\s*1/],
  ['extract-std',    /extract.*%|%.*extract/],
  ['extract-other',  /extract/],
  ['botanical-powder', /powder|juice|fruit|berry|leaf|root|seed|herb|grass|mushroom/],
];
function nameForClass(name) { return stripNameTags(name); }
// 브랜드·임상근거형 원료 이름 단서 (® · ™ 또는 알려진 브랜드명)
var BRAND_HINT_RE = /®|™|shoden|lipisperse|uthever|immunolin|ksm-?66|gut ?gard|enxtra|teavigo|astareal|curcumin c3|meriva|bioperine|wellmune|sensoril|cognizin|setria|kaneka|quatrefolic|albion|ferrochel|pycnogenol|cynatine|elastin/i;
function ingredientClass(name) {
  var raw = String(name || ''), s = nameForClass(raw);
  for (var i = 0; i < ING_CLASS_RULES.length; i++) {
    var re = ING_CLASS_RULES[i][1];
    if (re.test(i === 0 ? raw : s)) return ING_CLASS_RULES[i][0];
  }
  return 'other';
}

// 부자재 종류 추정 (packaging_type 미입력 시 이름으로)
function inferPkgType(name) {
  var s = String(name || '').toLowerCase();
  if (/shell|hpmc|gelatin capsule|vege capsule|capsule #|#\d/.test(s)) return 'Shell (F)';
  if (/bottle|jar|pot\b/.test(s)) return 'Bottle (F)';
  if (/\blid\b|\bcap\b|closure/.test(s)) return 'Lid (F)';
  if (/label|sticker/.test(s)) return 'Label';
  if (/shipper|outer carton/.test(s)) return 'Shipper Box';
  if (/box|carton|case/.test(s)) return 'Outer Case';
  if (/foil|blister/.test(s)) return 'Foil (F)';
  if (/silica|desiccant/.test(s)) return 'Silica Gel (F)';
  return '';
}
function parseSize(name) {
  var s = String(name || '').toLowerCase();
  var ml = s.match(/(\d+(?:\.\d+)?)\s*ml\b/), mm = s.match(/(\d+)\s*mm\b/);
  return { ml: ml ? parseFloat(ml[1]) : null, mm: mm ? parseInt(mm[1]) : null };
}

// 시트 → 코드별 approve 최신 행 (단가 > 0)
function latestApprovedRows(sheet, isPkg) {
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues(), h = data[0];
  var ix = {
    code: col(h, 'code'), name: col(h, 'name'), currency: col(h, 'currency'), unitPrice: col(h, 'unit_price'),
    incoterms: col(h, 'incoterms'), shipping: col(h, 'shipping_method'), custom: col(h, 'custom'),
    overseaFreight: col(h, 'oversea_freight'), status: col(h, 'status'), registerDate: col(h, 'register_date'),
    supplier: col(h, 'supplier_name'), packagingType: col(h, 'packaging_type'),
  };
  var by = {};
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!statusOk(r[ix.status])) continue;
    var code = String(r[ix.code] || '').trim();
    var up = parseFloat(r[ix.unitPrice]) || 0;
    if (!code || up <= 0) continue;
    var ms = ix.registerDate !== -1 ? toDateMs(r[ix.registerDate]) : 0;
    if (by[code] && by[code].ms >= ms) continue;
    by[code] = {
      ms: ms, code: code, name: String(r[ix.name] || ''), currency: String(r[ix.currency] || 'NZD').toUpperCase(),
      unitPrice: isPkg ? fixPkgPrice(code, up) : up,
      incoterms: ix.incoterms !== -1 ? String(r[ix.incoterms] || '') : '',
      shipping: ix.shipping !== -1 ? shippingFromMethod(r[ix.shipping]) : '',
      custom: ix.custom !== -1 ? (parseFloat(r[ix.custom]) || 0) : 0,
      overseaFreight: ix.overseaFreight !== -1 ? (parseFloat(r[ix.overseaFreight]) || 0) : 0,
      registerDate: ix.registerDate !== -1 ? toYmd(r[ix.registerDate]) : '',
      supplier: ix.supplier !== -1 ? String(r[ix.supplier] || '') : '',
      packagingType: ix.packagingType !== -1 ? String(r[ix.packagingType] || '') : '',
    };
  }
  return Object.keys(by).map(function(k) { delete by[k].ms; return by[k]; });
}

// q = { kind: 'raw'|'pkg', code, name, packagingType }
// → { kind, cls, analogs: 이름 유사 상위 8 (같은 분류 우선), sample: 같은 분류/종류 표본 (분포 계산용, 최대 120) }
function getDbAnalogs(q) {
  var kind = q && q.kind === 'pkg' ? 'pkg' : 'raw';
  var selfCode = normCode(q.code), toks = nameTokens(q.name);
  var rows, cls, sample;
  if (kind === 'raw') {
    rows = latestApprovedRows(getRawCostSheet(), false).filter(function(r) { return /^OR/i.test(r.code) && r.code.toUpperCase() !== selfCode; });
    cls = ingredientClass(q.name);
    sample = rows.filter(function(r) { return ingredientClass(r.name) === cls; });
  } else {
    rows = latestApprovedRows(getPkgCostSheet(), true).filter(function(r) { return r.code.toUpperCase() !== selfCode; });
    cls = q.packagingType || inferPkgType(q.name);
    var size = parseSize(q.name);
    sample = rows.filter(function(r) { return cls && r.packagingType === cls; });
    if (size.ml || size.mm) {
      var sized = sample.filter(function(r) {
        var s = parseSize(r.name);
        if (size.ml && s.ml) return s.ml / size.ml >= 0.5 && s.ml / size.ml <= 2;
        if (size.mm && s.mm) return s.mm / size.mm >= 0.75 && s.mm / size.mm <= 1.33;
        return false;
      });
      if (sized.length >= 3) sample = sized;
    }
  }
  var pool = (kind === 'pkg' && sample.length) ? sample : rows;
  var scored = pool.map(function(r) {
    var s = nameSimilarity(toks, nameTokens(r.name));
    if (kind === 'raw' && ingredientClass(r.name) === cls) s += 0.15;
    return { r: r, s: s };
  }).filter(function(x) { return x.s > 0.15; });
  scored.sort(function(a, b) { return b.s - a.s; });
  var analogs = scored.slice(0, 8).map(function(x) { x.r.score = Math.round(x.s * 100) / 100; return x.r; });
  // 표본은 최근 소싱 순 (분포 계산 · AI 프롬프트의 같은 분류 목록 — 이름이 안 겹쳐도 AI가 성질이 가까운 것을 고름)
  sample.sort(function(a, b) { return a.registerDate < b.registerDate ? 1 : a.registerDate > b.registerDate ? -1 : 0; });
  // 브랜드(임상근거형) 원료 실구매가 — 브랜드 원료로 판별될 때의 벤치마크 (방법론 Case A)
  var branded = kind === 'raw' ? rows.filter(function(r) { return BRAND_HINT_RE.test(r.name); }) : [];
  return { kind: kind, cls: cls, analogs: analogs, sample: sample.slice(0, 120), branded: branded.slice(0, 40) };
}

// ── AI 추정 (Gemini) — ① 웹 리서치(Google 검색) → ② 추론(사내 DB + 리서치 + 원가 구조) ─────────
// 모델은 스크립트 속성으로 바꿀 수 있음: GEMINI_MODEL(리서치) · GEMINI_REASONING_MODEL(추론, 실패 시 리서치 모델로 재시도)
var GEMINI_MODEL = 'gemini-2.5-flash';
var GEMINI_REASONING_MODEL = 'gemini-2.5-pro';

// q = { kind, name, code, mgPerEa, multiplier, capPerBottle, totalCaps, totalUnits, productName, productType, packagingType,
//       analogs:[{code,name,currency,unitPrice,incoterms,supplier,registerDate,landed}], dist:{cls,n,p25,median,p75},
//       classItems:[{name,landed}] (같은 분류 표본), brandBench:[{name,currency,unitPrice,incoterms,registerDate,landed}],
//       procurement:[{progress,date,requestedBy,result}], fxUsd, lossRate, factorPerUnit (단가 1당 NZD/pk), baseUnitCost (이 품목 제외 NZD/pk) }
function estimatePriceAI(q) {
  try {
    q = q || {};
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('GEMINI_API_KEY');
    if (!key) return { error: 'GEMINI_API_KEY is not set — add it in Apps Script project settings > under script properties (the same key as the R&D Toolkit works).' };
    var researchModel = props.getProperty('GEMINI_MODEL') || GEMINI_MODEL;
    var reasonModel   = props.getProperty('GEMINI_REASONING_MODEL') || GEMINI_REASONING_MODEL;

    // ① 리서치 — 브랜드 여부·소매 제품·B2B 리스팅 등 사실만 수집
    var r1 = geminiCall(key, researchModel, buildResearchPrompt(q), { search: true, maxTokens: 8192 });
    if (r1.error) return { error: 'AI research error: ' + r1.error };
    var facts = extractJson(r1.text) || { notes: String(r1.text || '').slice(0, 4000) };
    var sources = groundingSources(r1.grounding);

    // ② 추론 — 사내 근거 우선, 케이스·범위·추천·확인 질문
    var p2 = buildReasoningPrompt(q, facts);
    var r2 = geminiCall(key, reasonModel, p2, { maxTokens: 16384, thinkingBudget: 4096 });
    var usedModel = reasonModel;
    if (r2.error && reasonModel !== researchModel) { r2 = geminiCall(key, researchModel, p2, { maxTokens: 16384 }); usedModel = researchModel; }
    if (r2.error) return { error: 'AI reasoning error: ' + r2.error };
    var raw = extractJson(r2.text);
    if (!raw) return { error: 'Could not read the AI reasoning response.', raw: String(r2.text || '').slice(0, 400) };
    var result = normalizeEstimate(raw, q);
    if (result.error) return result;
    var out = { ok: true, result: result, facts: facts, sources: sources, queries: (r1.grounding && r1.grounding.webSearchQueries) || [],
                model: 'research ' + researchModel + ' · reasoning ' + usedModel + (usedModel !== reasonModel ? ' (' + reasonModel + ' failed, fallback used)' : '') };
    logPriceEstimate(q, out);
    saveStoredEstimate(q, out);
    return out;
  } catch(e) { return { error: 'AI estimate error: ' + e.message }; }
}

function geminiCall(key, model, prompt, opts) {
  try {
    var gc = { temperature: opts.temperature != null ? opts.temperature : 0.2, maxOutputTokens: opts.maxTokens || 8192 };
    if (opts.thinkingBudget) gc.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
    var body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gc };
    if (opts.search) body.tools = [{ google_search: {} }];
    var json;
    // 동시 추정(일괄) 시 분당 한도(429)·과부하(503)는 잠시 후 1회 재시도
    for (var attempt = 0; attempt < 2; attempt++) {
      var resp = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
      });
      json = JSON.parse(resp.getContentText());
      var busy = json.error && (json.error.code === 429 || json.error.code === 503 || /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(String(json.error.status) + ' ' + json.error.message));
      if (!busy || attempt === 1) break;
      Utilities.sleep(8000);
    }
    if (json.error) return { error: model + ': ' + json.error.message };
    var cand = json.candidates && json.candidates[0];
    if (!cand || !cand.content) return { error: model + ': empty response' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') };
    var text = (cand.content.parts || []).map(function(p) { return p.thought ? '' : (p.text || ''); }).join('');
    return { text: text, grounding: cand.groundingMetadata || {}, finishReason: cand.finishReason };
  } catch(e) { return { error: model + ': ' + e.message }; }
}

function extractJson(text) {
  var t = String(text || ''), s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch(err) { return null; }
}

function groundingSources(gm) {
  var seen = {}, out = [];
  ((gm && gm.groundingChunks) || []).forEach(function(ch) {
    var w = ch.web; if (!w || !w.uri) return;
    var t = w.title || w.uri; if (seen[t]) return; seen[t] = true;
    if (out.length < 10) out.push({ title: t, url: w.uri });
  });
  return out;
}

function buildResearchPrompt(q) {
  var isPkg = q.kind === 'pkg';
  return [
    'You are researching market price signals for ' + (isPkg ? 'a dietary-supplement packaging component' : 'a dietary-supplement ingredient') + '. Use Google Search. Report facts only, with the numbers exactly as found.',
    '',
    'ITEM: "' + (q.name || '') + '"' + (isPkg ? ' (packaging, priced per each' + (q.packagingType ? ', type ' + q.packagingType : '') + ')' : ' (raw material, priced per kg)'),
    'Context: ' + (q.productName || '-') + (isPkg ? '' : ' · ' + (q.mgPerEa || '?') + ' mg per capsule'),
    '',
    'FIND',
    isPkg
      ? '1. Supplier / wholesale listings for this component (size, material, colour): price per piece, currency, MOQ, incoterms.\n2. Typical price differences for custom colour/print or small MOQ.'
      : '1. Identity: is "' + q.name + '" a branded/trademarked ingredient, or the label name used for one on retail products (e.g. "Brand® (' + q.name + ')")? Name the brand(s), owner/manufacturer and distributors, and the generic equivalent.\n' +
        '2. Clinical or typical daily dose (mg/day) used in studies or retail products.\n' +
        '3. Retail products containing it: product, mg of this ingredient per serving, servings per bottle, retail price and currency.\n' +
        '4. B2B / wholesale listings (Alibaba, Made-in-China, IndiaMART, distributors): price range per kg, currency, incoterms, MOQ, grade (food / cosmetic / unknown).\n' +
        '5. Any distributor or press price signal for the branded version.',
    '',
    'Return JSON only (use null when unknown; never invent numbers):',
    '{"identity":{"branded":"yes|no|ambiguous","brands":[{"name":"","owner":"","distributors":[""],"label_name":""}],"generic_equivalents":[""],"notes":""},' +
    '"dose_mg_per_day":{"value":null,"basis":""},' +
    '"retail_products":[{"product":"","ingredient_mg_per_serving":null,"servings":null,"price":null,"currency":"USD","source":""}],' +
    '"b2b_listings":[{"source":"","grade":"food|cosmetic|unknown","price_low":null,"price_high":null,"currency":"USD","unit":"' + (isPkg ? 'ea' : 'kg') + '","incoterms":"","moq":"","note":""}],' +
    '"price_signals":[{"source":"","detail":""}],"other_facts":[""]}',
  ].join('\n');
}

function buildReasoningPrompt(q, facts) {
  var isPkg = q.kind === 'pkg', unit = isPkg ? 'ea' : 'kg';
  var kg = (!isPkg && q.mgPerEa > 0 && q.totalCaps > 0) ? (q.mgPerEa * (q.multiplier || 1) * q.totalCaps / 1e6) : 0;
  var fmtL = function(v) { return v != null ? Number(v).toFixed(isPkg ? 4 : 1) : '?'; };
  var line = function(a) {
    return '  - ' + [a.code, a.name, a.currency + ' ' + a.unitPrice + '/' + unit, a.incoterms || '-', a.supplier || '', a.registerDate || '', 'landed NZD ' + fmtL(a.landed)].filter(Boolean).join(' | ');
  };
  var d = q.dist || {};
  var proc = (q.procurement || []).slice(0, 4).map(function(p) {
    return '  - ' + [p.progress || '?', p.date || '', p.requestedBy || ''].join(' · ') + (p.result ? ' — reply: ' + String(p.result).replace(/\s+/g, ' ').slice(0, 240) : ' — no reply yet');
  }).join('\n') || '  (no request found)';
  var factor = q.factorPerUnit > 0 ? q.factorPerUnit : 0;
  return [
    'You are a senior procurement analyst for a New Zealand dietary-supplement contract manufacturer.',
    'Produce the BEST-ESTIMATE purchase price per ' + unit + ' for an item we have no supplier quote for yet; it will be used in a customer quotation.',
    'Reason step by step internally. Our own purchase data outranks web data. Be concrete and quantitative.',
    '',
    'ITEM',
    '- Name: ' + (q.name || '') + (q.code ? ' (internal code ' + q.code + ')' : ''),
    isPkg ? '- Packaging component priced per each' + (q.packagingType ? ' (type ' + q.packagingType + ')' : '')
          : '- Raw material priced per kg · ' + (q.mgPerEa || '?') + ' mg per capsule · ' + (q.capPerBottle || '?') + ' capsules per bottle',
    '- Product: ' + (q.productName || '-') + ' · dosage form ' + (q.productType || '-') + ' · ' + (q.totalUnits || '?') + ' units' + (kg ? ' · about ' + kg.toFixed(2) + ' kg of this ingredient needed' : ''),
    '',
    'COST MODEL (our pricing tool)',
    '- FX: 1 NZD = ' + (q.fxUsd || '?') + ' USD · raw-material loss rate ' + Math.round((q.lossRate || 0) * 100) + '%',
    factor ? '- Every USD 1/' + unit + ' of this item adds about NZD ' + factor.toFixed(5) + ' per unit (pack), before customs/freight.' : '- (per-unit factor unavailable)',
    q.baseUnitCost > 0 ? '- Current unit cost excluding this item: NZD ' + Number(q.baseUnitCost).toFixed(2) + ' per pack.' : '',
    '',
    'INTERNAL EVIDENCE',
    '- Our procurement team requests for this item:', proc,
    '- Name-matched items in our purchase DB:', ((q.analogs || []).slice(0, 8).map(line).join('\n') || '  (none)'),
    d.n ? '- Same-category distribution (' + d.cls + ', n=' + d.n + '): landed NZD/' + unit + ' p25 ' + d.p25 + ' · median ' + d.median + ' · p75 ' + d.p75 : '',
    (q.classItems && q.classItems.length) ? '- Same-category items (name | landed NZD/' + unit + '); choose the ones closest in nature:\n' + q.classItems.slice(0, 30).map(function(c) { return '  - ' + c.name + ' | ' + fmtL(c.landed); }).join('\n') : '',
    (!isPkg && q.brandBench && q.brandBench.length) ? '- Branded / clinically-backed ingredients we buy (benchmark if the item is branded):\n' + q.brandBench.slice(0, 30).map(line).join('\n') : '',
    '',
    'WEB RESEARCH (from search; may be incomplete or wrong — cross-check):',
    JSON.stringify(facts).slice(0, 6000),
    '',
    'METHOD',
    isPkg
      ? '1. Estimate from our same-type/same-size purchases first, then adjust with web listings (colour, print, MOQ).'
      : '1. Decide whether the name refers to a branded ingredient (e.g. the label name of a trademark) or generic material. If ambiguous, give two cases: A (branded) and B (generic); otherwise one case.\n' +
        '2. Branded case: start from our branded-benchmark price distribution, then cap it with a retail reverse-calculation: grams per bottle = mg per serving x servings / 1000; a plausible maximum USD/kg = retail price x 0.20 / (grams per bottle / 1000). Show the arithmetic in the basis.\n' +
        '3. Generic case: intersect B2B listing ranges (food grade preferred) with our actual purchases of similar materials from similar suppliers/countries; adjust for low-volume materials (price higher) and grade.',
    '4. Give low / mid / high, incoterms, likely MOQ, and confidence (low/medium/high) with what could move it.',
    '5. Recommend which case to use in the quotation, weighing under- vs over-quoting with the per-unit factor (e.g. "if we quote B and it turns out A, we lose about NZD x per pack").',
    '6. Questions to ask the customer that decide the case (e.g. brand-name or clinical claims; daily dose vs clinical dose — compute the ratio from mg per capsule).',
    '7. What to request from our procurement team for each case (name suppliers/distributors when known).',
    'Write every text field in Korean, concise, with concrete numbers. Never invent sources or numbers — write "Needs checking" when unknown.',
    '',
    'OUTPUT: JSON only, exactly this shape:',
    '{"summary":"One-line summary","branded":"yes|no|ambiguous","brand_candidates":[""],' +
    '"cases":[{"key":"A","label":"","type":"branded|generic","currency":"USD|NZD","unit":"' + unit + '","low":0,"mid":0,"high":0,"incoterms":"FOB|EXW|CIF|DAP|DDP","moq":"","confidence":"low|medium|high","confidence_note":"","basis":[""],"grade_note":""}],' +
    '"recommended":"A","recommendation":"","db_evidence":"","client_questions":[{"q":"","why":""}],"procurement_requests":[""]}',
  ].filter(function(x) { return x !== ''; }).join('\n');
}

function normalizeEstimate(r, q) {
  var unit = q && q.kind === 'pkg' ? 'ea' : 'kg';
  var arr = function(v) { return Array.isArray(v) ? v.map(String).filter(Boolean) : (v ? [String(v)] : []); };
  var cases = (r.cases || []).map(function(c, i) {
    var low = parseFloat(c.low), mid = parseFloat(c.mid), high = parseFloat(c.high);
    if (!(mid > 0)) return null;
    if (!(low > 0)) low = mid; if (!(high > 0)) high = mid;
    var cur = String(c.currency || 'USD').toUpperCase();
    return {
      key: String(c.key || String.fromCharCode(65 + i)), label: String(c.label || ''), type: String(c.type || ''),
      currency: cur === 'NZD' ? 'NZD' : 'USD', unit: unit,
      low: Math.min(low, mid), mid: mid, high: Math.max(high, mid),
      incoterms: String(c.incoterms || '').toUpperCase().replace(/[^A-Z]/g, ''),
      moq: String(c.moq || ''), confidence: String(c.confidence || 'low').toLowerCase(),
      confidence_note: String(c.confidence_note || ''), basis: arr(c.basis), grade_note: String(c.grade_note || ''),
    };
  }).filter(Boolean).slice(0, 3);
  if (!cases.length) return { error: 'The AI did not return a valid price range.' };
  var rec = String(r.recommended || '');
  if (!cases.some(function(c) { return c.key === rec; })) rec = cases[0].key;
  return {
    summary: String(r.summary || ''), branded: String(r.branded || ''), brand_candidates: arr(r.brand_candidates),
    cases: cases, recommended: rec, recommendation: String(r.recommendation || ''), db_evidence: String(r.db_evidence || ''),
    client_questions: (r.client_questions || []).map(function(x) { return typeof x === 'string' ? { q: x, why: '' } : { q: String(x.q || ''), why: String(x.why || '') }; }).filter(function(x) { return x.q; }),
    procurement_requests: arr(r.procurement_requests),
  };
}

// ── AI 추정 결과 저장 — 한 번 추정하면 팝업을 닫거나 나가도 다시 볼 수 있게 (재추정은 사용자 확인 후) ──
// 키: 종류 + 유효 코드(OR/OP####), 코드가 없으면(ORXXXX·TBD) 원료명 토큰
function estimateKey(kind, code, name) {
  var c = normCode(code);
  return (kind === 'pkg' ? 'pkg' : 'raw') + '|' + (c || nameTokens(name).sort().join(' '));
}

function saveStoredEstimate(q, out) {
  try {
    var ss = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('Price_Estimate_Store');
    if (!sheet) {
      sheet = ss.insertSheet('Price_Estimate_Store');
      sheet.appendRow(['key', 'saved_at', 'user', 'kind', 'code', 'name', 'product', 'json']);
      sheet.setFrozenRows(1);
    }
    var user = ''; try { user = Session.getActiveUser().getEmail(); } catch(e) {}
    out.savedAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    out.savedBy = user;
    out.product = q.productName || '';
    var json = JSON.stringify(out);
    if (json.length > 48000) { var slim = JSON.parse(json); slim.facts = { notes: '(research source text left out, too large)' }; json = JSON.stringify(slim); }
    sheet.appendRow([estimateKey(q.kind, q.code, q.name), out.savedAt, user, q.kind || 'raw', q.code || '', q.name || '', out.product, json]);
  } catch(e) { Logger.log('[EST_STORE] ' + e.message); }
}

// 같은 품목의 가장 최근 AI 추정 (저장본 → 없으면 v1.26~27 요약 로그에서 케이스만 복원)
function getStoredEstimate(q) {
  var key = estimateKey(q.kind, q.code, q.name), ss = getOrCreateMainSpreadsheet();
  var store = ss.getSheetByName('Price_Estimate_Store');
  if (store && store.getLastRow() > 1) {
    var data = store.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) !== key) continue;
      try { var out = JSON.parse(data[i][7]); out.stored = true; return out; } catch(e) {}
    }
  }
  return restoreEstimateFromLog(ss, q, key);
}

// 여러 품목의 저장된 추정 일괄 조회 (STEP 3 행 칩 표시용, 리서치 원자료 제외). items = [{ key, kind, code, name }]
function getStoredEstimates(items) {
  try {
    var ss = getOrCreateMainSpreadsheet(), out = {}, latest = {}, data = [];
    var store = ss.getSheetByName('Price_Estimate_Store');
    if (store && store.getLastRow() > 1) {
      data = store.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) latest[String(data[i][0])] = i;   // 같은 키는 마지막(최신) 행
    }
    (items || []).forEach(function(it) {
      var key = estimateKey(it.kind, it.code, it.name), est = null;
      if (latest[key] != null) { try { est = JSON.parse(data[latest[key]][7]); est.stored = true; } catch(e) {} }
      if (!est) est = restoreEstimateFromLog(ss, it, key);
      if (est) { delete est.facts; out[it.key] = est; }
    });
    return { results: out };
  } catch(e) { return { error: 'Saved estimate error: ' + e.message }; }
}

function restoreEstimateFromLog(ss, q, key) {
  var log = ss.getSheetByName('Price_Estimate_Log');
  if (!log || log.getLastRow() < 2) return null;
  var data = log.getDataRange().getValues(), h = data[0].map(String);
  var ix = function(n) { return h.indexOf(n); };
  var iK = ix('kind'), iC = ix('code'), iN = ix('name'), iCases = ix('cases'), iT = ix('timestamp'), iU = ix('user'), iP = ix('product'), iR = ix('recommended'), iM = ix('model');
  if (iCases === -1) return null;
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (estimateKey(row[iK] || 'raw', row[iC], row[iN]) !== key) continue;
    // "A. 라벨: USD 200/250/350 DAP (low) | B. …" (v1.26 은 키 없이 "라벨: …")
    var cases = String(row[iCases] || '').split(' | ').map(function(seg) {
      var m = seg.match(/^(?:([A-Z])\. )?(.*): (USD|NZD) ([\d.]+)\/([\d.]+)\/([\d.]+) ?([A-Z]*) \(([^)]*)\)$/);
      return m ? { key: m[1] || '', label: m[2], currency: m[3], low: m[4], mid: m[5], high: m[6], incoterms: m[7], confidence: m[8] } : null;
    }).filter(Boolean);
    if (!cases.length) continue;
    var result = normalizeEstimate({ cases: cases, recommended: iR !== -1 ? row[iR] : '' }, q);
    if (result.error) continue;
    result.summary = 'Restored from the summary log — basis, sources and questions are not kept.';
    return { ok: true, stored: true, restoredFromLog: true, result: result, facts: {}, sources: [],
             model: iM !== -1 ? String(row[iM] || '') : '', savedAt: toYmdHm(row[iT]), savedBy: iU !== -1 ? String(row[iU] || '') : '', product: iP !== -1 ? String(row[iP] || '') : '' };
  }
  return null;
}
function toYmdHm(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  return String(v || '');
}

// 추정 로그 — 실측(구매 회신)과 비교해 추정 로직 보정용 (방법론 8장)
function logPriceEstimate(q, out) {
  try {
    var ss = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('Price_Estimate_Log');
    if (!sheet) {
      sheet = ss.insertSheet('Price_Estimate_Log');
      sheet.appendRow(['timestamp', 'user', 'kind', 'code', 'name', 'product', 'cases', 'recommended', 'db_median', 'sources', 'model']);
      sheet.setFrozenRows(1);
    }
    var user = ''; try { user = Session.getActiveUser().getEmail(); } catch(e) {}
    sheet.appendRow([
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'), user, q.kind || 'raw', q.code || '', q.name || '', q.productName || '',
      out.result.cases.map(function(c) { return c.key + '. ' + c.label + ': ' + c.currency + ' ' + c.low + '/' + c.mid + '/' + c.high + ' ' + c.incoterms + ' (' + c.confidence + ')'; }).join(' | '),
      out.result.recommended, (q.dist && q.dist.median) || '', out.sources.length, out.model,
    ]);
  } catch(e) { Logger.log('[EST_LOG] ' + e.message); }
}

// STEP 3 단가 미확정 원료의 구매 요청 상태 (일괄). items = [{ key, code, name }]
// → { meta, status: { key: { progress, date, requestedBy, hasPrice } } } (매칭 없는 key는 생략)
function getProcurementStatus(items) {
  try {
    var meta = getProcurementMeta();
    if (!meta) return { meta: null, status: {} };
    var rows = readProcSheet('Procurement_List');
    rows.forEach(function(o) { o._t = nameTokens(o.name); o._c = normCode(o.code); });
    var out = {};
    (items || []).forEach(function(it) {
      var code = normCode(it.code), toks = nameTokens(it.name), best = null, hasPrice = false;
      rows.forEach(function(o) {
        var s = (code && o._c === code) ? 1 : nameSimilarity(toks, o._t);
        if (s < 0.45) return;
        if (!best || s > best.s || (s === best.s && o.date > best.o.date)) best = { s: s, o: o };
        if (s >= 0.6 && !hasPrice && o.result && parseProcPrices(o.result, 'kg', {}).length) hasPrice = true;
      });
      if (best) out[it.key] = { progress: best.o.progress, date: best.o.date, requestedBy: best.o.requestedBy, hasPrice: hasPrice };
    });
    return { meta: { updatedAt: meta.updatedAt }, status: out };
  } catch(e) { return { error: 'Procurement request status error: ' + e.message }; }
}

// ================================================================
// GM ANALYSIS
// ================================================================

// year: '2025' | '2026' | null(= 2025+2026 합산)
function getGmData(year) {
  try {
    var ss         = getOrCreateMainSpreadsheet();
    var costSheet  = ss.getSheetByName('GM_CostMaster');
    var salesSheet = ss.getSheetByName('GM_Sales');
    var props      = PropertiesService.getScriptProperties();
    var lastUpdated = {
      cost:  props.getProperty('GM_COST_UPDATED')  || null,
      sales: props.getProperty('GM_SALES_UPDATED') || null
    };

    if (!costSheet)  return { error: 'No GM_CostMaster sheet. Upload the data first.' };
    if (!salesSheet) return { error: 'No GM_Sales sheet. Upload the data first.' };

    // ── Cost Master 파싱
    // costByOf: OF코드 → 레코드 (완제품 원가)
    // costByObOnly: OB코드 → 레코드 (OB 단독 탭 — of_code가 없는 것만)
    var costRows    = costSheet.getDataRange().getValues();
    var costHeaders = costRows[0].map(function(h){ return String(h).trim(); });
    var costByOf = {}, costByObOnly = {};
    for (var i = 1; i < costRows.length; i++) {
      var r = costRows[i];
      var rec = {};
      for (var j = 0; j < costHeaders.length; j++) rec[costHeaders[j]] = r[j];
      var ofCode = String(rec.of_code || '').trim();
      var obCode = String(rec.ob_code || '').trim();
      if (ofCode) {
        costByOf[ofCode] = rec;
      } else if (obCode) {
        // OB 전용 레코드 (완제품 정보 없음 → 벌크 납품용)
        costByObOnly[obCode] = rec;
      }
    }

    // ── 연도 필터 설정 (기본: 2025 + 2026)
    var allowedYears = year ? [String(year)] : ['2025', '2026'];

    // ── Sales 파싱 + 조인
    var salesRows    = salesSheet.getDataRange().getValues();
    var salesHeaders = salesRows[0].map(function(h){ return String(h).trim(); });
    var productMap      = {};
    var latestDateByCode = {};  // 제품별 최신 SO 날짜 추적

    for (var i = 1; i < salesRows.length; i++) {
      var r = salesRows[i];
      var s = {};
      for (var j = 0; j < salesHeaders.length; j++) s[salesHeaders[j]] = r[j];

      // 연도 필터 (Date 객체 / 문자열 모두 처리)
      var regRaw  = s.register_date;
      var regDate = regRaw instanceof Date
        ? Utilities.formatDate(regRaw, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(regRaw || '').substring(0, 10);
      var regYear = regDate.substring(0, 4);
      if (allowedYears.indexOf(regYear) === -1) continue;

      if (String(s.status || '').trim() === 'cancel') continue;
      var unitPrice = parseFloat(s.unit_price) || 0;
      if (unitPrice === 0) continue;

      var prodCode = String(s.product_code || '').trim();
      var bulkCode = String(s.bulk_code    || '').trim();

      // 매칭: product_code(OF) 우선, 없으면 bulk_code(OB 전용)로만 조회
      var costRec = costByOf[prodCode] || costByObOnly[bulkCode] || null;
      if (!costRec) continue;

      var unitCost = parseFloat(costRec.unit_cost) || 0;
      var qty      = parseFloat(s.quantity)        || 0;
      var revenue  = parseFloat(s.item_value)      || (unitPrice * qty);

      // 집계 키: product_code(OF) 있으면 그것, OB 전용이면 bulkCode
      var groupKey = prodCode || bulkCode;

      if (!productMap[groupKey]) {
        productMap[groupKey] = {
          of_code:       prodCode || bulkCode,  // OB 전용은 OB코드 표시
          ob_code:       bulkCode,
          product_name:  String(s.product_name || costRec.product_name || ''),
          client_name:   String(costRec.client_name || '').trim(),  // 공장원가 파일 기준
          unit_cost:     unitCost,
          unit_price:    unitPrice,
          latest_date:   regDate,
          total_revenue: 0, total_cost: 0, total_qty: 0, order_count: 0,
        };
      }
      var p = productMap[groupKey];
      p.total_revenue += revenue;
      p.total_cost    += unitCost * qty;
      p.total_qty     += qty;
      p.order_count   += 1;

      // 최신 SO 기준 unit_price 업데이트
      if (regDate >= p.latest_date) {
        p.unit_price  = unitPrice;
        p.latest_date = regDate;
      }
    }

    // ── 제품별 GM 계산 + 클라이언트 집계
    var products  = [];
    var clientMap = {};

    for (var code in productMap) {
      var p        = productMap[code];
      p.gm_nzd     = p.total_revenue - p.total_cost;
      p.gm_percent = p.total_revenue > 0 ? p.gm_nzd / p.total_revenue : 0;
      products.push(p);

      var cn = p.client_name || '(uncategorised)';
      if (!clientMap[cn]) clientMap[cn] = { client_name: cn, product_count: 0, total_revenue: 0, total_cost: 0 };
      clientMap[cn].product_count++;
      clientMap[cn].total_revenue += p.total_revenue;
      clientMap[cn].total_cost    += p.total_cost;
    }

    var clients = [];
    for (var cn in clientMap) {
      var c = clientMap[cn];
      c.gm_nzd             = c.total_revenue - c.total_cost;
      c.blended_gm_percent = c.total_revenue > 0 ? c.gm_nzd / c.total_revenue : 0;
      clients.push(c);
    }
    clients.sort(function(a, b){ return b.total_revenue - a.total_revenue; });

    var totalRev = 0, totalCost = 0;
    clients.forEach(function(c){ totalRev += c.total_revenue; totalCost += c.total_cost; });

    return {
      products: products,
      clients:  clients,
      year:     year || '2025-2026',
      lastUpdated: lastUpdated,
      summary: {
        total_revenue:      totalRev,
        total_cost:         totalCost,
        overall_gm_nzd:     totalRev - totalCost,
        overall_gm_percent: totalRev > 0 ? (totalRev - totalCost) / totalRev : 0,
        product_count:      products.length,
        client_count:       clients.length,
      },
    };
  } catch(e) {
    return { error: 'GM data error: ' + e.message };
  }
}

function importGmCostMaster(rows) {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('GM_CostMaster') || ss.insertSheet('GM_CostMaster');
    sheet.clearContents();
    if (!rows || !rows.length) return { ok: true, count: 0 };
    var headers = Object.keys(rows[0]);
    var data    = [headers].concat(rows.map(function(r){
      return headers.map(function(h){ return r[h] !== undefined ? r[h] : ''; });
    }));
    sheet.getRange(1, 1, data.length, headers.length).setValues(data);
    sheet.setFrozenRows(1);
    PropertiesService.getScriptProperties().setProperty(
      'GM_COST_UPDATED',
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")
    );
    return { ok: true, count: rows.length };
  } catch(e) { return { error: 'Upload error: ' + e.message }; }
}

function importGmSales(rows) {
  try {
    var ss    = getOrCreateMainSpreadsheet();
    var sheet = ss.getSheetByName('GM_Sales') || ss.insertSheet('GM_Sales');
    sheet.clearContents();
    if (!rows || !rows.length) return { ok: true, count: 0 };
    var headers = Object.keys(rows[0]);
    var data    = [headers].concat(rows.map(function(r){
      return headers.map(function(h){ return r[h] !== undefined ? r[h] : ''; });
    }));
    sheet.getRange(1, 1, data.length, headers.length).setValues(data);
    sheet.setFrozenRows(1);
    PropertiesService.getScriptProperties().setProperty(
      'GM_SALES_UPDATED',
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")
    );
    return { ok: true, count: rows.length };
  } catch(e) { return { error: 'Upload error: ' + e.message }; }
}
