(function() {
  var KEYWORDS = {
    "immun": ["vitamin c", "zinc", "elderberry", "echinacea", "propolis", "colostrum", "vitamin d3", "beta-glucan", "lactoferrin"],
    "sleep": ["magnesium", "theanine", "5-htp", "ashwagandha", "melatonin"],
    "joint": ["glucosamine", "chondroitin", "msm", "mussel", "turmeric", "hyaluronic", "collagen"],
    "skin": ["collagen", "hyaluronic", "vitamin c", "astaxanthin", "grape seed", "biotin"],
    "gut": ["lactobacillus", "bifidobacterium", "inulin", "kiwifruit"],
    "eye": ["lutein", "bilberry", "astaxanthin", "beta-carotene"],
    "fatigue": ["ginseng", "rhodiola", "b12", "coenzyme", "iron", "carnitine"],
    "heart": ["fish oil", "krill", "coenzyme", "vitamin k2", "grape seed"],
    "liver": ["milk thistle", "cysteine", "lipoic"]
  };
  function lines(prompt, header) {
    var i = prompt.indexOf(header);
    if (i < 0) return [];
    var body = prompt.slice(prompt.indexOf("\n", i) + 1);
    var end = body.indexOf("\n\n");
    if (end >= 0) body = body.slice(0, end);
    return body.split("\n").map(function(l) {
      return l.split(" | ");
    }).filter(function(p) {
      return p.length >= 3;
    });
  }
  function pick(rows, words, n) {
    var seen = {}, uniq = rows.filter(function(r) {
      if (seen[r[0]]) return false;
      seen[r[0]] = 1;
      return true;
    });
    var out = [];
    words.forEach(function(w) {
      var r = uniq.find(function(x) {
        return out.indexOf(x) === -1 && x[1].toLowerCase().indexOf(w) !== -1;
      });
      if (r) out.push(r);
    });
    uniq.forEach(function(r) {
      if (out.indexOf(r) === -1 && words.some(function(w) {
        return r[1].toLowerCase().indexOf(w) !== -1;
      })) out.push(r);
    });
    return out.slice(0, n);
  }
  function price(s) {
    var m = /^(\w+)\s+(.+)$/.exec((s || "").trim());
    return m ? { currency: m[1], salesPrice: m[2] } : { currency: "", salesPrice: s };
  }
  function wordsFor(text) {
    var w = [];
    var low = text.toLowerCase();
    Object.keys(KEYWORDS).forEach(function(k) {
      if (low.indexOf(k) !== -1) w = w.concat(KEYWORDS[k]);
    });
    return w.length ? w : KEYWORDS.immun;
  }
  function recommend(prompt) {
    var benefit = (/Target benefit: (.*)/.exec(prompt) || [])[1] || "";
    var form = (/Dosage form: (.*)/.exec(prompt) || [])[1] || "";
    var or = pick(lines(prompt, "=== Ingredient DB"), wordsFor(benefit), 6);
    var op = lines(prompt, "=== Packaging DB").filter(function(r) {
      return /bottle|cap|label|desiccant|seal|pouch|sachet|capsule|shell/i.test(r[1]);
    });
    if (/soft/i.test(form)) op = op.filter(function(r) {
      return !/HPMC/i.test(r[1]);
    });
    op = op.slice(0, 4);
    return {
      summary: '[Demo answer] For "' + benefit + '", picked ' + or.length + " related ingredients from the ingredient DB and " + op.length + " packaging items for " + (form || "the chosen dosage form") + ". The real version has Gemini read the same DB and explain each pick.",
      orItems: or.map(function(r) {
        var p = price(r[2]);
        return { code: r[0], name: r[1], salesPrice: p.salesPrice, currency: p.currency, supplier: r[3] || "", reason: "Related to the target benefit (" + benefit + ") (demo match)" };
      }),
      opItems: op.map(function(r) {
        var p = price(r[3]);
        return { code: r[0], name: r[1], pkgType: r[2], salesPrice: p.salesPrice, currency: p.currency, supplier: r[4] || "", reason: "Standard packaging for this dosage form and pack (demo)" };
      })
    };
  }
  function upgrade(prompt) {
    var benefit = (/Target benefit: (.*)/.exec(prompt) || [])[1] || "";
    var bom = lines(prompt, "=== Current formula");
    var db = lines(prompt, "=== Ingredient DB");
    var inBom = bom.map(function(b) {
      return b[0];
    });
    var minor = bom.slice(1).filter(function(b) {
      return /cellulose|stearate|flour|dioxide|dicalcium|maltodextrin/i.test(b[1]);
    }).slice(0, 2);
    var alt = db.filter(function(r) {
      return /rice flour|silicon|sunflower lecithin|inulin/i.test(r[1]) && inBom.indexOf(r[0]) === -1;
    });
    var add = pick(db.filter(function(r) {
      return inBom.indexOf(r[0]) === -1;
    }), wordsFor(benefit), 3);
    return {
      summary: "[Demo answer] Keep the main actives, swap some excipients for clean-label ones, and add ingredients that support the benefit (" + benefit + ").",
      replaceItems: minor.map(function(b, i) {
        var r = alt[i] || alt[0];
        if (!r) return null;
        var p = price(r[2]);
        return { currentCode: b[0], currentName: b[1], newCode: r[0], newName: r[1], salesPrice: p.salesPrice, currency: p.currency, supplier: r[3] || "", reason: "Clean-label excipient swap (demo)" };
      }).filter(Boolean),
      addItems: add.map(function(r) {
        var p = price(r[2]);
        return { code: r[0], name: r[1], salesPrice: p.salesPrice, currency: p.currency, supplier: r[3] || "", reason: "Supports the benefit (demo match)" };
      })
    };
  }
  window.GAS_FETCH_MOCKS = [{
    match: /generativelanguage\.googleapis\.com/,
    respond: function(url, opts) {
      var body = JSON.parse(opts.payload || "{}");
      var prompt = (((body.contents || [])[0] || {}).parts || [{}])[0].text || "";
      var out = /propose an upgrade/.test(prompt) ? upgrade(prompt) : recommend(prompt);
      return { body: { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }] } };
    }
  }];
})();
