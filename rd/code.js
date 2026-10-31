/* Apps Script backend (Code.js), unchanged apart from removed confidential values. */
// ================================================================
// CONFIGURATION
// ================================================================

var APP_VERSION = 'v1.3';

const GEMINI_MODEL_DEFAULT  = "gemini-2.5-flash";
const GEMINI_MODEL_ADVANCED = "gemini-2.5-flash";

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    SPREADSHEET_ID:          props.getProperty('SPREADSHEET_ID'),
    RAW_COST_SPREADSHEET_ID: props.getProperty('RAW_COST_SPREADSHEET_ID'),
    PKG_COST_SPREADSHEET_ID: props.getProperty('PKG_COST_SPREADSHEET_ID'),
    GEMINI_API_KEY:          props.getProperty('GEMINI_API_KEY'),
    // 상대방 툴 URL — GAS 배포 후 ScriptProperties에 등록
    SALES_TOOLKIT_URL:       props.getProperty('SALES_TOOLKIT_URL'),
  };
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

// ================================================================
// WEB APP ENTRY POINT
// ================================================================

function doGet(e) {
  var page       = e && e.parameter && e.parameter.page ? e.parameter.page : 'search';
  var baseUrl    = ScriptApp.getService().getUrl();
  var searchUrl    = baseUrl + '?page=search';
  var recommendUrl = baseUrl + '?page=recommend';

  var cfg = getConfig();
  // SALES_TOOLKIT_URL: ScriptProperties에 등록 필요 (없으면 링크 숨김)
  var salesToolkitUrl = cfg.SALES_TOOLKIT_URL || '';
  // ScriptProperty에 ?page=xxx 또는 #fragment 가 붙어 있을 수 있으므로 항상 베이스 URL만 추출
  var salesBase     = salesToolkitUrl ? salesToolkitUrl.replace(/[?#].*$/, '') : '';
  var hasPricingUrl = !!salesBase;
  var pricingUrl    = salesBase ? salesBase + '?page=pricing' : '';
  var gmUrl         = salesBase ? salesBase + '?page=gm'      : '';
  var guideUrl      = salesBase ? salesBase + '?page=guide'   : '';

  var userEmail = '';
  try { userEmail = Session.getActiveUser().getEmail(); } catch(ignored) {}
  var localPart  = userEmail ? userEmail.split('@')[0] : '';
  var nameParts  = localPart ? localPart.split('.') : [];
  var initials   = '';
  for (var pi = 0; pi < Math.min(nameParts.length, 2); pi++) {
    if (nameParts[pi]) initials += nameParts[pi].charAt(0).toUpperCase();
  }
  var userInitials = initials || 'Demo Labs';

  if (page === 'recommend') {
    var html = HtmlService.createTemplateFromFile('Recommend');
    html.searchUrl      = searchUrl;
    html.pricingUrl     = pricingUrl;
    html.gmUrl          = gmUrl;
    html.guideUrl       = guideUrl;
    html.hasPricingUrl  = hasPricingUrl;
    html.userEmail      = userEmail;
    html.userInitials   = userInitials;
    html.appVersion     = APP_VERSION;
    return html.evaluate()
      .setTitle('Demo Labs Sales R&D Tool')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // 기본: search 페이지
  var html = HtmlService.createTemplateFromFile('Index');
  html.recommendUrl   = recommendUrl;
  html.pricingUrl     = pricingUrl;
  html.gmUrl          = gmUrl;
  html.guideUrl       = guideUrl;
  html.hasPricingUrl  = hasPricingUrl;
  html.userEmail      = userEmail;
  html.userInitials   = userInitials;
  html.appVersion     = APP_VERSION;
  return html.evaluate()
    .setTitle('Demo Labs Sales R&D Tool')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ================================================================
// TOOL 1 — R&D SEARCH
// ================================================================

function getTypeList() {
  try {
    var cfg = getConfig();
    const ss = SpreadsheetApp.openById(cfg.SPREADSHEET_ID);
    const obSheet = ss.getSheetByName("OB");
    if (!obSheet) return { error: "OB 시트를 찾을 수 없습니다." };

    const obData = obSheet.getDataRange().getValues();
    const headers = obData[0];
    const idxType = col(headers, "type");
    if (idxType === -1) return { error: "type 컬럼을 찾을 수 없습니다." };

    const types = new Set();
    for (let i = 1; i < obData.length; i++) {
      const type = obData[i][idxType];
      if (type) types.add(type.toString().trim());
    }
    return ["전체", ...Array.from(types).sort()];
  } catch(e) {
    return { error: "제형 목록 조회 오류: " + e.message };
  }
}

function searchProductWeb(type, keyword) {
  try {
    var cfg = getConfig();
    const ss = SpreadsheetApp.openById(cfg.SPREADSHEET_ID);
    const obSheet    = ss.getSheetByName("OB");
    const obBomSheet = ss.getSheetByName("OB_BOM");
    if (!obSheet || !obBomSheet) return { error: "시트를 찾을 수 없습니다." };

    const obData  = obSheet.getDataRange().getValues();
    const headers = obData[0];

    const idxStatus        = col(headers, "status");
    const idxType          = col(headers, "type");
    const idxCode          = col(headers, "code");
    const idxName          = col(headers, "name");
    const idxGrossWeight   = col(headers, "gross_weight");
    const idxColor         = col(headers, "color");
    const idxRegisterDate  = col(headers, "register_date");
    const idxTargetBenefit = col(headers, "target_benefit");

    const searchType    = type    ? type.toLowerCase().trim()    : "";
    const searchKeyword = keyword ? keyword.toLowerCase().trim() : "";

    let results = [];

    for (let i = 1; i < obData.length; i++) {
      const row = obData[i];
      const obStatus        = idxStatus        !== -1 ? row[idxStatus].toString().trim()             : "";
      const obType          = idxType          !== -1 ? row[idxType].toString().toLowerCase().trim() : "";
      const obCode          = idxCode          !== -1 ? row[idxCode].toString()                      : "";
      const obName          = idxName          !== -1 ? row[idxName].toString()                      : "";
      const obGrossWeight   = idxGrossWeight   !== -1 ? row[idxGrossWeight].toString()               : "";
      const obColor         = idxColor         !== -1 ? row[idxColor].toString()                     : "";
      const obRegisterDate  = idxRegisterDate  !== -1 ? formatDate(row[idxRegisterDate])             : "";
      const obTargetBenefit = idxTargetBenefit !== -1 ? row[idxTargetBenefit].toString()             : "";

      const matchType    = searchType === "" || searchType === "전체" || obType === searchType;
      const matchKeyword = searchKeyword === "" ||
        obName.toLowerCase().includes(searchKeyword) ||
        obTargetBenefit.toLowerCase().includes(searchKeyword);

      if (matchType && matchKeyword) {
        results.push({
          obCode, obName, obType, obStatus,
          grossWeight:   obGrossWeight,
          color:         obColor,
          registerDate:  obRegisterDate,
          targetBenefit: obTargetBenefit,
          bom: []
        });
      }
    }

    if (results.length === 0) return { error: "조건에 맞는 제품을 찾을 수 없습니다." };

    const bomData    = obBomSheet.getDataRange().getValues();
    const bomHeaders = bomData[0];
    const idxBomCode    = col(bomHeaders, "BOM Code");
    const idxBomIngCode = col(bomHeaders, "Object CodeItem");
    const idxBomIngName = col(bomHeaders, "Object Description");
    const idxBomQty     = col(bomHeaders, "Quantity");
    const idxBomUnit    = col(bomHeaders, "Unit");

    const bomMap = {};
    for (let i = 1; i < bomData.length; i++) {
      const bomRow  = bomData[i];
      const bomCode = idxBomCode !== -1 ? bomRow[idxBomCode].toString() : "";
      if (!bomCode) continue;
      if (!bomMap[bomCode]) bomMap[bomCode] = [];
      bomMap[bomCode].push({
        code:     idxBomIngCode !== -1 ? bomRow[idxBomIngCode].toString() : "",
        name:     idxBomIngName !== -1 ? bomRow[idxBomIngName].toString() : "",
        quantity: idxBomQty     !== -1 ? bomRow[idxBomQty].toString()     : "",
        unit:     idxBomUnit    !== -1 ? bomRow[idxBomUnit].toString()     : ""
      });
    }

    results.forEach(function(product) {
      product.bom = bomMap[product.obCode] || [];
    });

    return { results };
  } catch(e) {
    return { error: "제품 검색 오류: " + e.message };
  }
}

// ================================================================
// TOOL 2 — AI RECOMMENDATION (GEMINI)
// ================================================================

function loadORData() {
  try {
    var cfg = getConfig();
    const ss    = SpreadsheetApp.openById(cfg.RAW_COST_SPREADSHEET_ID);
    const sheet = ss.getSheetByName("raw_cost");
    if (!sheet) return [];

    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const idx = {
      code:       col(headers, "code"),
      name:       col(headers, "name"),
      salesPrice: col(headers, "sales_price"),
      currency:   col(headers, "currency"),
      supplier:   col(headers, "supplier_name"),
      status:     col(headers, "status"),
    };

    var results = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[idx.status]) !== 'approve') continue;
      results.push({
        code:       String(row[idx.code]       || ''),
        name:       String(row[idx.name]       || ''),
        salesPrice: String(row[idx.salesPrice] || ''),
        currency:   String(row[idx.currency]   || ''),
        supplier:   String(row[idx.supplier]   || '')
      });
    }
    return results;
  } catch(e) {
    return [];
  }
}

function loadOPData() {
  try {
    var cfg = getConfig();
    const ss    = SpreadsheetApp.openById(cfg.PKG_COST_SPREADSHEET_ID);
    const sheet = ss.getSheetByName("packaging_cost");
    if (!sheet) return [];

    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const idx = {
      code:       col(headers, "code"),
      name:       col(headers, "name"),
      salesPrice: col(headers, "sales_price"),
      currency:   col(headers, "currency"),
      supplier:   col(headers, "supplier_name"),
      pkgType:    col(headers, "packaging_type"),
      status:     col(headers, "status"),
    };

    var results = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[idx.status]) !== 'approve') continue;
      results.push({
        code:       String(row[idx.code]       || ''),
        name:       String(row[idx.name]       || ''),
        salesPrice: String(row[idx.salesPrice] || ''),
        currency:   String(row[idx.currency]   || ''),
        supplier:   String(row[idx.supplier]   || ''),
        pkgType:    String(row[idx.pkgType]    || '')
      });
    }
    return results;
  } catch(e) {
    return [];
  }
}

function getAIRecommendation(requirements) {
  try {
    var cfg    = getConfig();
    var orData = loadORData();
    var opData = loadOPData();

    var orText = orData.map(function(r) {
      return r.code + ' | ' + r.name + ' | ' + r.currency + ' ' + r.salesPrice + ' | ' + r.supplier;
    }).join('\n');

    var opText = opData.map(function(r) {
      return r.code + ' | ' + r.name + ' | ' + r.pkgType + ' | ' + r.currency + ' ' + r.salesPrice + ' | ' + r.supplier;
    }).join('\n');

    var prompt =
      "당신은 건강기능식품 R&D 전문가입니다. " +
      "아래 원료 DB와 부자재 DB를 기반으로 클라이언트 요구사항에 맞는 원료와 부자재를 추천해주세요.\n\n" +
      "=== 클라이언트 요구사항 ===\n" +
      "제형: "          + requirements.formType                          + "\n" +
      "타겟 고객: "     + (requirements.targetCustomer || '미지정')      + "\n" +
      "예산 수준: "     + (requirements.budget         || '미지정')      + "\n" +
      "타겟 효능: "     + requirements.targetBenefit                     + "\n" +
      "원산지 선호: "   + (requirements.origin         || '없음')        + "\n" +
      "추가 요구사항: " + (requirements.extraNotes     || '없음')        + "\n\n" +
      "=== 원료 DB (OR) — 코드 | 원료명 | 통화 단가 | 공급사 ===\n" + orText + "\n\n" +
      "=== 부자재 DB (OP) — 코드 | 부자재명 | 타입 | 통화 단가 | 공급사 ===\n" + opText + "\n\n" +
      "=== 응답 형식 (반드시 아래 JSON 형식으로만 응답) ===\n" +
      '{"summary":"전체 추천 요약 2-3문장",' +
      '"orItems":[{"code":"OR코드","name":"원료명","salesPrice":"단가","currency":"통화","supplier":"공급사","reason":"추천이유"}],' +
      '"opItems":[{"code":"OP코드","name":"부자재명","pkgType":"타입","salesPrice":"단가","currency":"통화","supplier":"공급사","reason":"추천이유"}]}' +
      "\n원료 5~8개, 부자재 3~5개 추천. JSON 외 텍스트 절대 포함 금지.";

    var url     = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL_DEFAULT + ":generateContent?key=" + cfg.GEMINI_API_KEY;
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    };

    var response     = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var responseJson = JSON.parse(response.getContentText());

    if (responseJson.error) return { error: 'Gemini API 오류: ' + responseJson.error.message };

    var candidate = responseJson.candidates[0];
    if (candidate.finishReason === 'MAX_TOKENS') return { error: 'AI 응답이 너무 길어 잘렸습니다. 잠시 후 다시 시도해주세요.' };

    var text  = candidate.content.parts[0].text;
    var clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);

  } catch(e) {
    return { error: '오류가 발생했습니다: ' + e.message };
  }
}

// ================================================================
// TOOL 2B — AI UPGRADE ANALYSIS (기존 제품 업그레이드 제안)
// ================================================================

function getUpgradeAnalysis(product) {
  try {
    var cfg    = getConfig();
    var orData = loadORData();

    var orText = orData.map(function(r) {
      return r.code + ' | ' + r.name + ' | ' + r.currency + ' ' + r.salesPrice + ' | ' + r.supplier;
    }).join('\n');

    var bomText = (product.bom || []).map(function(b) {
      return b.code + ' | ' + b.name + ' | ' + b.quantity + ' ' + b.unit;
    }).join('\n');

    var prompt =
      "당신은 건강기능식품 R&D 전문가입니다. " +
      "아래 제품의 현재 원료 구성(BOM)을 분석하고, 우리 원료 DB를 기반으로 업그레이드 방안을 제안해주세요.\n" +
      "단, 다음 규칙을 반드시 지키세요:\n" +
      "1. 핵심 주원료(가장 함량이 높은 원료)는 절대 대체 제안하지 마세요.\n" +
      "2. 대체 제안은 부형제, 보조 원료 위주로만 하세요.\n" +
      "3. 추가 원료는 현재 효능 목적과 시너지가 있는 것만 제안하세요.\n" +
      "4. 단가가 지나치게 비싼 원료(USD 100 이상)는 Economy/Standard 제품에 추천하지 마세요.\n\n" +

      "=== 분석 대상 제품 ===\n" +
      "제품코드: " + product.obCode + "\n" +
      "제품명: " + product.obName + "\n" +
      "제형: " + product.obType + "\n" +
      "타겟 효능: " + (product.targetBenefit || '미지정') + "\n\n" +

      "=== 현재 원료 구성 (BOM) ===\n" +
      (bomText || '데이터 없음') + "\n\n" +

      "=== 원료 DB (OR) — 코드 | 원료명 | 통화 단가 | 공급사 ===\n" +
      orText + "\n\n" +

      "=== 응답 형식 (반드시 아래 JSON 형식으로만 응답) ===\n" +
      '{"summary":"현재 제품 분석 및 업그레이드 방향 요약 2-3문장",' +
      '"replaceItems":[{"currentCode":"현재 원료코드","currentName":"현재 원료명","newCode":"대체 원료코드","newName":"대체 원료명","salesPrice":"단가","currency":"통화","supplier":"공급사","reason":"대체 이유"}],' +
      '"addItems":[{"code":"추가 원료코드","name":"추가 원료명","salesPrice":"단가","currency":"통화","supplier":"공급사","reason":"추가 이유"}]}' +
      "\n대체 원료 2~4개, 추가 원료 2~3개 제안. 반드시 원료 DB에 있는 것만 추천. JSON 외 텍스트 절대 포함 금지.";

    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL_ADVANCED + ":generateContent?key=" + cfg.GEMINI_API_KEY;
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    };

    var response     = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var responseJson = JSON.parse(response.getContentText());

    if (responseJson.error) return { error: 'Gemini API 오류: ' + responseJson.error.message };

    var candidate = responseJson.candidates[0];
    if (candidate.finishReason === 'MAX_TOKENS') return { error: 'AI 응답이 너무 길어 잘렸습니다. 잠시 후 다시 시도해주세요.' };

    var text  = candidate.content.parts[0].text;
    var clean = text.replace(/```json|```/g, '').trim();
    var jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: 'AI 응답 형식 오류' };
    return JSON.parse(jsonMatch[0]);

  } catch(e) {
    return { error: '오류: ' + e.message };
  }
}
