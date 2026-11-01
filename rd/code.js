var APP_VERSION = "v1.3";
const GEMINI_MODEL_DEFAULT = "gemini-2.5-flash";
const GEMINI_MODEL_ADVANCED = "gemini-2.5-flash";
function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    SPREADSHEET_ID: props.getProperty("SPREADSHEET_ID"),
    RAW_COST_SPREADSHEET_ID: props.getProperty("RAW_COST_SPREADSHEET_ID"),
    PKG_COST_SPREADSHEET_ID: props.getProperty("PKG_COST_SPREADSHEET_ID"),
    GEMINI_API_KEY: props.getProperty("GEMINI_API_KEY"),
    
    SALES_TOOLKIT_URL: props.getProperty("SALES_TOOLKIT_URL")
  };
}
function col(headers, name) {
  return headers.indexOf(name);
}
function formatDate(value) {
  if (!value) return "";
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  if (!isNaN(value)) {
    const date = new Date((value - 25569) * 86400 * 1e3);
    return Utilities.formatDate(date, "Asia/Seoul", "yyyy-MM-dd");
  }
  return value.toString();
}
function doGet(e) {
  var page = e && e.parameter && e.parameter.page ? e.parameter.page : "search";
  var baseUrl = ScriptApp.getService().getUrl();
  var searchUrl = baseUrl + "?page=search";
  var recommendUrl = baseUrl + "?page=recommend";
  var cfg = getConfig();
  var salesToolkitUrl = cfg.SALES_TOOLKIT_URL || "";
  var salesBase = salesToolkitUrl ? salesToolkitUrl.replace(/[?#].*$/, "") : "";
  var hasPricingUrl = !!salesBase;
  var pricingUrl = salesBase ? salesBase + "?page=pricing" : "";
  var gmUrl = salesBase ? salesBase + "?page=gm" : "";
  var guideUrl = salesBase ? salesBase + "?page=guide" : "";
  var userEmail = "";
  try {
    userEmail = Session.getActiveUser().getEmail();
  } catch (ignored) {
  }
  var localPart = userEmail ? userEmail.split("@")[0] : "";
  var nameParts = localPart ? localPart.split(".") : [];
  var initials = "";
  for (var pi = 0; pi < Math.min(nameParts.length, 2); pi++) {
    if (nameParts[pi]) initials += nameParts[pi].charAt(0).toUpperCase();
  }
  var userInitials = initials || "Demo Labs";
  if (page === "recommend") {
    var html = HtmlService.createTemplateFromFile("Recommend");
    html.searchUrl = searchUrl;
    html.pricingUrl = pricingUrl;
    html.gmUrl = gmUrl;
    html.guideUrl = guideUrl;
    html.hasPricingUrl = hasPricingUrl;
    html.userEmail = userEmail;
    html.userInitials = userInitials;
    html.appVersion = APP_VERSION;
    return html.evaluate().setTitle("Demo Labs Sales R&D Tool").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  var html = HtmlService.createTemplateFromFile("Index");
  html.recommendUrl = recommendUrl;
  html.pricingUrl = pricingUrl;
  html.gmUrl = gmUrl;
  html.guideUrl = guideUrl;
  html.hasPricingUrl = hasPricingUrl;
  html.userEmail = userEmail;
  html.userInitials = userInitials;
  html.appVersion = APP_VERSION;
  return html.evaluate().setTitle("Demo Labs Sales R&D Tool").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function getTypeList() {
  try {
    var cfg = getConfig();
    const ss = SpreadsheetApp.openById(cfg.SPREADSHEET_ID);
    const obSheet = ss.getSheetByName("BK");
    if (!obSheet) return { error: "BK sheet not found." };
    const obData = obSheet.getDataRange().getValues();
    const headers = obData[0];
    const idxType = col(headers, "type");
    if (idxType === -1) return { error: "type column not found." };
    const types =  new Set();
    for (let i = 1; i < obData.length; i++) {
      const type = obData[i][idxType];
      if (type) types.add(type.toString().trim());
    }
    return ["All", ...Array.from(types).sort()];
  } catch (e) {
    return { error: "Dosage form list error: " + e.message };
  }
}
function searchProductWeb(type, keyword) {
  try {
    var cfg = getConfig();
    const ss = SpreadsheetApp.openById(cfg.SPREADSHEET_ID);
    const obSheet = ss.getSheetByName("BK");
    const obBomSheet = ss.getSheetByName("BK_BOM");
    if (!obSheet || !obBomSheet) return { error: "sheet not found." };
    const obData = obSheet.getDataRange().getValues();
    const headers = obData[0];
    const idxStatus = col(headers, "status");
    const idxType = col(headers, "type");
    const idxCode = col(headers, "code");
    const idxName = col(headers, "name");
    const idxGrossWeight = col(headers, "gross_weight");
    const idxColor = col(headers, "color");
    const idxRegisterDate = col(headers, "register_date");
    const idxTargetBenefit = col(headers, "target_benefit");
    const searchType = type ? type.toLowerCase().trim() : "";
    const searchKeyword = keyword ? keyword.toLowerCase().trim() : "";
    let results = [];
    for (let i = 1; i < obData.length; i++) {
      const row = obData[i];
      const obStatus = idxStatus !== -1 ? row[idxStatus].toString().trim() : "";
      const obType = idxType !== -1 ? row[idxType].toString().toLowerCase().trim() : "";
      const obCode = idxCode !== -1 ? row[idxCode].toString() : "";
      const obName = idxName !== -1 ? row[idxName].toString() : "";
      const obGrossWeight = idxGrossWeight !== -1 ? row[idxGrossWeight].toString() : "";
      const obColor = idxColor !== -1 ? row[idxColor].toString() : "";
      const obRegisterDate = idxRegisterDate !== -1 ? formatDate(row[idxRegisterDate]) : "";
      const obTargetBenefit = idxTargetBenefit !== -1 ? row[idxTargetBenefit].toString() : "";
      const matchType = searchType === "" || searchType === "All" || obType === searchType;
      const matchKeyword = searchKeyword === "" || obName.toLowerCase().includes(searchKeyword) || obTargetBenefit.toLowerCase().includes(searchKeyword);
      if (matchType && matchKeyword) {
        results.push({
          obCode,
          obName,
          obType,
          obStatus,
          grossWeight: obGrossWeight,
          color: obColor,
          registerDate: obRegisterDate,
          targetBenefit: obTargetBenefit,
          bom: []
        });
      }
    }
    if (results.length === 0) return { error: "No products match." };
    const bomData = obBomSheet.getDataRange().getValues();
    const bomHeaders = bomData[0];
    const idxBomCode = col(bomHeaders, "BOM Code");
    const idxBomIngCode = col(bomHeaders, "Object CodeItem");
    const idxBomIngName = col(bomHeaders, "Object Description");
    const idxBomQty = col(bomHeaders, "Quantity");
    const idxBomUnit = col(bomHeaders, "Unit");
    const bomMap = {};
    for (let i = 1; i < bomData.length; i++) {
      const bomRow = bomData[i];
      const bomCode = idxBomCode !== -1 ? bomRow[idxBomCode].toString() : "";
      if (!bomCode) continue;
      if (!bomMap[bomCode]) bomMap[bomCode] = [];
      bomMap[bomCode].push({
        code: idxBomIngCode !== -1 ? bomRow[idxBomIngCode].toString() : "",
        name: idxBomIngName !== -1 ? bomRow[idxBomIngName].toString() : "",
        quantity: idxBomQty !== -1 ? bomRow[idxBomQty].toString() : "",
        unit: idxBomUnit !== -1 ? bomRow[idxBomUnit].toString() : ""
      });
    }
    results.forEach(function(product) {
      product.bom = bomMap[product.obCode] || [];
    });
    return { results };
  } catch (e) {
    return { error: "Product search error: " + e.message };
  }
}
function loadORData() {
  try {
    var cfg = getConfig();
    const ss = SpreadsheetApp.openById(cfg.RAW_COST_SPREADSHEET_ID);
    const sheet = ss.getSheetByName("raw_cost");
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idx = {
      code: col(headers, "code"),
      name: col(headers, "name"),
      salesPrice: col(headers, "sales_price"),
      currency: col(headers, "currency"),
      supplier: col(headers, "supplier_name"),
      status: col(headers, "status")
    };
    var results = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[idx.status]) !== "approve") continue;
      results.push({
        code: String(row[idx.code] || ""),
        name: String(row[idx.name] || ""),
        salesPrice: String(row[idx.salesPrice] || ""),
        currency: String(row[idx.currency] || ""),
        supplier: String(row[idx.supplier] || "")
      });
    }
    return results;
  } catch (e) {
    return [];
  }
}
function loadOPData() {
  try {
    var cfg = getConfig();
    const ss = SpreadsheetApp.openById(cfg.PKG_COST_SPREADSHEET_ID);
    const sheet = ss.getSheetByName("packaging_cost");
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idx = {
      code: col(headers, "code"),
      name: col(headers, "name"),
      salesPrice: col(headers, "sales_price"),
      currency: col(headers, "currency"),
      supplier: col(headers, "supplier_name"),
      pkgType: col(headers, "packaging_type"),
      status: col(headers, "status")
    };
    var results = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[idx.status]) !== "approve") continue;
      results.push({
        code: String(row[idx.code] || ""),
        name: String(row[idx.name] || ""),
        salesPrice: String(row[idx.salesPrice] || ""),
        currency: String(row[idx.currency] || ""),
        supplier: String(row[idx.supplier] || ""),
        pkgType: String(row[idx.pkgType] || "")
      });
    }
    return results;
  } catch (e) {
    return [];
  }
}
function getAIRecommendation(requirements) {
  try {
    var cfg = getConfig();
    var orData = loadORData();
    var opData = loadOPData();
    var orText = orData.map(function(r) {
      return r.code + " | " + r.name + " | " + r.currency + " " + r.salesPrice + " | " + r.supplier;
    }).join("\n");
    var opText = opData.map(function(r) {
      return r.code + " | " + r.name + " | " + r.pkgType + " | " + r.currency + " " + r.salesPrice + " | " + r.supplier;
    }).join("\n");
    var prompt = "You are an R&D expert in health supplements. Using the ingredient DB and packaging DB below, recommend ingredients and packaging that fit the client brief.\n\n=== Client brief ===\nDosage form: " + requirements.formType + "\nTarget consumer: " + (requirements.targetCustomer || "Not specified") + "\nBudget level: " + (requirements.budget || "Not specified") + "\nTarget benefit: " + requirements.targetBenefit + "\nOrigin preference: " + (requirements.origin || "none") + "\nOther requirements: " + (requirements.extraNotes || "none") + "\n\n=== Ingredient DB (RM) — code | name | price in currency | supplier ===\n" + orText + "\n\n=== Packaging DB (PK) — code | name | type | price in currency | supplier ===\n" + opText + '\n\n=== Response format (reply only in the JSON format below) ===\n{"summary":"Overall recommendation summary in 2–3 sentences","orItems":[{"code":"RM code","name":"Ingredient","salesPrice":"Price","currency":"Currency","supplier":"Supplier","reason":"Reason for recommending"}],"opItems":[{"code":"PK code","name":"Packaging name","pkgType":"Type","salesPrice":"Price","currency":"Currency","supplier":"Supplier","reason":"Reason for recommending"}]}\nRecommend 5–8 ingredients and 3–5 packaging items. No text outside the JSON.';
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL_DEFAULT + ":generateContent?key=" + cfg.GEMINI_API_KEY;
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: "application/json" }
    };
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var responseJson = JSON.parse(response.getContentText());
    if (responseJson.error) return { error: "Gemini API error: " + responseJson.error.message };
    var candidate = responseJson.candidates[0];
    if (candidate.finishReason === "MAX_TOKENS") return { error: "The AI response was too long and got cut off. Please try again shortly." };
    var text = candidate.content.parts[0].text;
    var clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    return { error: "An error occurred: " + e.message };
  }
}
function getUpgradeAnalysis(product) {
  try {
    var cfg = getConfig();
    var orData = loadORData();
    var orText = orData.map(function(r) {
      return r.code + " | " + r.name + " | " + r.currency + " " + r.salesPrice + " | " + r.supplier;
    }).join("\n");
    var bomText = (product.bom || []).map(function(b) {
      return b.code + " | " + b.name + " | " + b.quantity + " " + b.unit;
    }).join("\n");
    var prompt = "You are an R&D expert in health supplements. Analyse the current formula (BOM) of the product below and propose an upgrade based on our ingredient DB.\nFollow these rules:\n1. Never suggest replacing the main active (the ingredient with the highest amount).\n2. Suggest replacements only for excipients and supporting ingredients.\n3. Suggest added ingredients only if they work with the current purpose of the product.\n4. Don’t recommend very expensive ingredients (USD 100 or more) for Economy/Standard products.\n\n=== Product to analyse ===\nProduct code: " + product.obCode + "\nProduct name: " + product.obName + "\nDosage form: " + product.obType + "\nTarget benefit: " + (product.targetBenefit || "Not specified") + "\n\n=== Current formula (BOM) ===\n" + (bomText || "No data") + "\n\n=== Ingredient DB (RM) — code | name | price in currency | supplier ===\n" + orText + '\n\n=== Response format (reply only in the JSON format below) ===\n{"summary":"Current product analysis and upgrade direction in 2–3 sentences","replaceItems":[{"currentCode":"Current ingredient code","currentName":"Current ingredient name","newCode":"Replacement ingredient code","newName":"Replacement ingredient name","salesPrice":"Price","currency":"Currency","supplier":"Supplier","reason":"Reason for replacing"}],"addItems":[{"code":"Added ingredient code","name":"Added ingredient name","salesPrice":"Price","currency":"Currency","supplier":"Supplier","reason":"Reason for adding"}]}\nSuggest 2–4 replacement ingredients and 2–3 added ingredients. Only ingredients in the ingredient DB. No text outside the JSON.';
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL_ADVANCED + ":generateContent?key=" + cfg.GEMINI_API_KEY;
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: "application/json" }
    };
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var responseJson = JSON.parse(response.getContentText());
    if (responseJson.error) return { error: "Gemini API error: " + responseJson.error.message };
    var candidate = responseJson.candidates[0];
    if (candidate.finishReason === "MAX_TOKENS") return { error: "The AI response was too long and got cut off. Please try again shortly." };
    var text = candidate.content.parts[0].text;
    var clean = text.replace(/```json|```/g, "").trim();
    var jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: "AI response format error" };
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { error: "Error: " + e.message };
  }
}
