const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  pg.on('dialog', d => d.accept());
  const plan = [['OF3101',3000,'Approved'],['OF3103',5000,'Approved'],['OF3104',2000,'Reviewed'],['OF3107',3000,'Draft'],
                ['OF3111',1500,'Reviewed'],['OF3113',4000,'Draft'],['OF3115',2500,'Approved'],['OF3119',3000,'Draft'],['OF3122',6000,'Reviewed']];
  for (const [code, units, st] of plan) {
    await pg.goto('http://localhost:8765/pricing/index.html', { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1200);
    await pg.fill('#bomCode', code);
    await pg.evaluate(() => loadBom());
    await pg.waitForTimeout(1300);
    await pg.fill('#totalUnits', String(units)); await pg.dispatchEvent('#totalUnits', 'input'); await pg.dispatchEvent('#totalUnits', 'change');
    await pg.waitForTimeout(600);
    await pg.evaluate(() => { if (!STATE.packagingForm) selectPackaging('Bottle'); });
    await pg.waitForTimeout(400);
    await pg.evaluate(() => doSaveEstimate(false));
    await pg.waitForTimeout(1000);
    const id = await pg.evaluate(() => EST_LOADED_ID);
    if (st !== 'Draft') { await pg.evaluate(([i, s]) => google.script.run.updateEstimateStatus(i, s, null), [id, st]); await pg.waitForTimeout(800); }
    console.log(code, units, st, id, (await pg.evaluate(() => currentUnitCost())).toFixed(2));
  }
  // AI estimate on a new raw row
  await pg.goto('http://localhost:8765/pricing/index.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1000);
  const ai = await pg.evaluate(() => new Promise(res => google.script.run.withSuccessHandler(res).withFailureHandler(e => res({ err: e.message }))
    .estimatePriceAI({ kind: 'raw', code: '', name: 'Tart Cherry Extract 10:1', mgPerEa: 300, productName: 'Sleep formula', totalCaps: 180000, fxUsd: 0.598, lossRate: 0.08 })));
  console.log('AI:', JSON.stringify(ai).slice(0, 400));
  const st = await pg.evaluate(() => GasDemo.exportJson());
  fs.writeFileSync('/tmp/state.json', st);
  console.log(errs.join('\n') || 'no errors');
  await b.close();
})();
