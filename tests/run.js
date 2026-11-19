#!/usr/bin/env node
// Headless tests for NDIS Invoice Tool v2 (index.html). Run: cd tests && npm install && node run.js
// Uses Chrome via puppeteer-core (CHROME_PATH, default /usr/bin/google-chrome). No network: every
// request except the app page is aborted (incl. the 127.0.0.1:8765 v1 ledger server and CDNs).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

const ROOT = path.resolve(__dirname, '..');
const V2_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const V1_PATH = process.env.V1_HTML || '/workspace/ndis-v1-src/index.html'; // v1 @ 1e96102 (read-only)
const REAL_LEDGER = process.env.REAL_LEDGER || ''; // optional: real v1 ledger for the INV-0014 visual check
const REF_PNG = process.env.REF_PNG || '/workspace/invoice-physio-branch/inv14-1.png';
const OUT = path.join(__dirname, 'out');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ORIGIN = 'http://ndis-tool.test';
fs.mkdirSync(OUT, { recursive: true });

let browser;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail && !cond ? '  -> ' + JSON.stringify(detail) : ''));
}

const EXAMPLE_LEDGER = require('./fixture-example.json');

async function openApp(html, { seed = {}, url = '/index.html', ledger = null } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  const dialogs = [], requests = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  page.on('pageerror', e => dialogs.push('pageerror: ' + e.message));
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u === ORIGIN + url) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    if (u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
    requests.push(req.method() + ' ' + u);
    if (ledger && u === 'http://127.0.0.1:8766/data-v2.json') return ledger(req);
    return req.abort();
  });
  await page.evaluateOnNewDocument(seedObj => {
    if (!sessionStorage.getItem('__seeded')) {
      localStorage.clear();
      for (const k of Object.keys(seedObj)) localStorage.setItem(k, seedObj[k]);
      sessionStorage.setItem('__seeded', '1');
    }
  }, seed);
  await page.goto(ORIGIN + url, { waitUntil: 'load' });
  await page.waitForFunction('typeof state === "object" && Array.isArray(state.invoices)');
  await new Promise(r => setTimeout(r, 300));
  return { ctx, page, dialogs, requests };
}

async function genSupport(page, isV2) {
  return page.evaluate(isV2 => {
    if (isV2) { $('invKind').value = 'support'; $('invKind').dispatchEvent(new Event('change')); }
    $('invClient').value = state.clients[0].id; renderInvoicePick();
    $('invDate').value = '2026-11-15'; $('invDue').value = '2026-11-29';
    $('invGenBtn').click();
    const inv = state.invoices[state.invoices.length - 1];
    return { inv, html: invoiceHtml(inv), sheet: $('invoiceSheet').innerHTML };
  }, isV2);
}

async function sheetPng(page, file) {
  await page.evaluate(() => activateTab('invoice'));
  const el = await page.$('#invoiceSheet');
  await el.screenshot({ path: file });
  return PNG.sync.read(fs.readFileSync(file));
}
function diffPng(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: [a.width, a.height, b.width, b.height] };
  return { diff: pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) };
}
async function printPdf(page, file) {
  await page.emulateMediaType('print');
  const buf = await page.pdf({ format: 'A4', printBackground: false, preferCSSPageSize: true });
  await page.emulateMediaType('screen');
  fs.writeFileSync(file, buf);
}

(async () => {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const v1Html = fs.existsSync(V1_PATH) ? fs.readFileSync(V1_PATH, 'utf8') : null;
  const ledgerText = JSON.stringify(EXAMPLE_LEDGER);

  /* ---------- 1. storage isolation ---------- */
  {
    const V1_SENTINEL = JSON.stringify({ settings: { providerName: 'V1 SENTINEL', nextInvoiceNumber: 999 },
      clients: [{ id: 'v1c', name: 'V1 ONLY CLIENT', ndisNumber: '1' }], sessions: [], invoices: [] });
    const { ctx, page, requests, dialogs } = await openApp(V2_HTML, { seed: { 'ndis-invoice-tool': V1_SENTINEL } });
    const r0 = await page.evaluate(() => ({ key: STORAGE_KEY, idb: IDB_NAME, file: LEDGER_FILE_NAME, url: LEDGER_URL,
      clients: state.clients.map(c => c.name), next: state.settings.nextInvoiceNumber }));
    check('storage: STORAGE_KEY is ndis-invoice-tool-v2', r0.key === 'ndis-invoice-tool-v2', r0);
    check('storage: IndexedDB name is ndis-invoice-disk-v2', r0.idb === 'ndis-invoice-disk-v2', r0);
    check('storage: ledger file is invoice-data-v2.json', r0.file === 'invoice-data-v2.json', r0);
    check('storage: http ledger is v2-only 127.0.0.1:8766/data-v2.json', r0.url === 'http://127.0.0.1:8766/data-v2.json', r0);
    check('storage: v2 does not load v1 localStorage data', !r0.clients.includes('V1 ONLY CLIENT') && r0.next !== 999, r0);
    // do real work in v2: add a client through the UI + save settings + idb write
    await page.evaluate(async () => {
      $('cliName').value = 'EXAMPLE Isolation'; $('cliNdis').value = '430000001'; $('cliSaveBtn').click();
      $('setSaveBtn').click();
      await idbPut('probe', 'x');
    });
    const r1 = await page.evaluate(async () => ({
      v1: localStorage.getItem('ndis-invoice-tool'),
      v2: localStorage.getItem('ndis-invoice-tool-v2'),
      dbs: (await indexedDB.databases()).map(d => d.name)
    }));
    check('storage: v1 localStorage value untouched after v2 writes', r1.v1 === V1_SENTINEL);
    check('storage: v2 writes its own key', !!r1.v2 && JSON.parse(r1.v2).clients.some(c => c.name === 'EXAMPLE Isolation'));
    check('storage: only v2 IndexedDB used', r1.dbs.includes('ndis-invoice-disk-v2') && !r1.dbs.includes('ndis-invoice-disk'), r1.dbs);
    check('storage: no request to 127.0.0.1:8765', !requests.some(u => u.includes('8765')), requests);
    check('storage: only 8766/data-v2.json contacted for the ledger', requests.filter(u => u.includes('127.0.0.1')).every(u => u.endsWith(' http://127.0.0.1:8766/data-v2.json')), requests);
    check('storage: no page errors', !dialogs.some(d => d.startsWith('pageerror')), dialogs);
    const src = V2_HTML;
    check('storage: source has no v1 key literals',
      !/['"]ndis-invoice-tool['"]/.test(src) && !/['"]ndis-invoice-disk['"]/.test(src) && !/['"]invoice-data\.json['"]/.test(src) && !src.includes('8765/data.json'));
    await ctx.close();
  }

  /* ---------- 1b. local v2 ledger server (8766) ---------- */
  {
    const file = JSON.parse(ledgerText);
    file.settings.bankAccountName = 'EXAMPLE FROM FILE';
    const puts = [];
    // same CORS headers as the local server (D:\Grokbot\NDIS Invoices\app\ndis_v2_server.py)
    const headers = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true' };
    const handler = req => {
      if (req.method() === 'GET') return req.respond({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(file) });
      if (req.method() === 'PUT') { puts.push(JSON.parse(req.postData())); return req.respond({ status: 200, headers, contentType: 'application/json', body: '{"ok":true}' }); }
      return req.respond({ status: 204, headers });
    };
    // fresh browser (empty v2 localStorage): file is taken as-is, nothing written back
    const { ctx, page, requests } = await openApp(V2_HTML, { ledger: handler });
    await new Promise(r => setTimeout(r, 500));
    const r1 = await page.evaluate(() => ({ http: httpConnected, clients: state.clients.length, sessions: state.sessions.length,
      bank: state.settings.bankAccountName, next: state.settings.nextInvoiceNumber, banner: $('ledgerBannerText').textContent }));
    check('ledger 8766: fresh browser loads the file (clients, sessions, settings)', r1.http && r1.clients === 1 && r1.sessions === 4 &&
      r1.bank === 'EXAMPLE FROM FILE' && r1.next === 15, r1);
    check('ledger 8766: fresh browser does not write back on connect', puts.length === 0, puts.length);
    check('ledger 8766: banner shows the D: ledger path', /8766/.test(r1.banner) && /NDIS Invoices/.test(r1.banner), r1.banner);
    // a change in the app is saved to 8766 only
    await page.evaluate(() => { $('cliName').value = 'EXAMPLE Saved'; $('cliNdis').value = '430000009'; $('cliSaveBtn').click(); });
    await new Promise(r => setTimeout(r, 300));
    check('ledger 8766: saving PUTs the full ledger to 8766/data-v2.json', puts.length >= 1 &&
      puts[puts.length - 1].clients.length === 2 && puts[puts.length - 1].invoices.length === 0 &&
      puts[puts.length - 1].settings.bankAccountName === 'EXAMPLE FROM FILE', puts.map(p => p.clients.length));
    check('ledger 8766: never contacts 8765', !requests.some(u => u.includes('8765')), requests);
    await ctx.close();
  }

  /* ---------- 2. support work unchanged vs v1 ---------- */
  if (v1Html) {
    const a = await openApp(v1Html, { seed: { 'ndis-invoice-tool': ledgerText } });
    const b = await openApp(V2_HTML, { seed: { 'ndis-invoice-tool-v2': ledgerText } });
    const g1 = await genSupport(a.page, false), g2 = await genSupport(b.page, true);
    check('support: same invoice number (INV-0015)', g1.inv.number === g2.inv.number && g2.inv.number === 'INV-0015', [g1.inv.number, g2.inv.number]);
    check('support: identical lines', JSON.stringify(g1.inv.lines) === JSON.stringify(g2.inv.lines));
    check('support: identical totals (1350.00, GST 0)', g1.inv.total === g2.inv.total && g2.inv.total === 1350 && g2.inv.gst === 0, [g1.inv.total, g2.inv.total]);
    check('support: no invoiceType field added (v1-shaped record)', !('invoiceType' in g2.inv));
    check('support: identical invoice HTML', g1.html === g2.html && g1.sheet === g2.sheet);
    check('title: support sheet never says "TAX INVOICE"', !/tax\s*invoice/i.test(g2.sheet));
    // Compare the app's print/PDF output (what Jackson sends), rasterised like inv14-1.png (80 dpi)
    const pngs = [];
    for (const [tag, app] of [['v1', a], ['v2', b]]) {
      await app.page.evaluate(() => activateTab('invoice'));
      const pdf = path.join(OUT, 'support-example-' + tag + '.pdf');
      await printPdf(app.page, pdf);
      execFileSync('pdftoppm', ['-r', '80', '-png', '-f', '1', '-l', '1', pdf, pdf.replace(/\.pdf$/, '')]);
      pngs.push(PNG.sync.read(fs.readFileSync(pdf.replace(/\.pdf$/, '-1.png'))));
    }
    const d = diffPng(pngs[0], pngs[1]);
    check('support: printed PDF page pixel-identical to v1', d.diff === 0, d);
    // amounts match the INV-0014 reference (same quantities/rates as inv14-1.png)
    const amts = g2.inv.lines.map(l => l.amount);
    check('support: amounts match INV-0014 reference', JSON.stringify(amts) === JSON.stringify([227.5, 20, 280, 15, 300, 10, 487.5, 10]), amts);
    await a.ctx.close(); await b.ctx.close();
  } else {
    check('support: v1 source available at ' + V1_PATH, false);
  }

  /* ---------- 2b. optional: real stored INV-0014 vs inv14-1.png (not committed data) ---------- */
  if (REAL_LEDGER && fs.existsSync(REAL_LEDGER) && v1Html) {
    const real = fs.readFileSync(REAL_LEDGER, 'utf8');
    const outs = {};
    for (const [tag, html, key] of [['v1', v1Html, 'ndis-invoice-tool'], ['v2', V2_HTML, 'ndis-invoice-tool-v2']]) {
      const app = await openApp(html, { seed: { [key]: real } });
      outs[tag] = await app.page.evaluate(() => {
        const inv = state.invoices.find(i => i.number === 'INV-0014' && !i.voided);
        activateTab('invoice'); showPreview(inv); return invoiceHtml(inv);
      });
      const pdf = path.join(OUT, 'real-INV-0014-' + tag + '.pdf');
      await printPdf(app.page, pdf);
      execFileSync('pdftoppm', ['-r', '80', '-png', '-f', '1', '-l', '1', pdf, pdf.replace(/\.pdf$/, '')]);
      await app.ctx.close();
    }
    check('real INV-0014: v1 and v2 invoice HTML identical', outs.v1 === outs.v2);
    const ref = PNG.sync.read(fs.readFileSync(REF_PNG));
    for (const tag of ['v1', 'v2']) {
      const f = path.join(OUT, 'real-INV-0014-' + tag + '-1.png');
      const img = PNG.sync.read(fs.readFileSync(f));
      const d = diffPng(img, ref);
      check('real INV-0014: ' + tag + ' print render vs inv14-1.png', d.diff === 0, d);
    }
  }

  /* ---------- 3. physiotherapy ---------- */
  {
    const { ctx, page, dialogs } = await openApp(V2_HTML, { seed: { 'ndis-invoice-tool-v2': ledgerText } });
    // add one physio session through the UI form
    await page.evaluate(() => {
      $('sessClient').value = state.clients[0].id;
      $('sessKind').value = 'physio'; $('sessKind').dispatchEvent(new Event('change'));
      $('sessDate').value = '2026-11-16'; $('sessStart').value = '10:00'; $('sessEnd').value = '11:00';
      $('sessClaimType').value = 'direct'; $('sessClaimType').dispatchEvent(new Event('change'));
      $('sessPhysioDesc').value = 'EXAMPLE Initial assessment';
      $('sessTravelOut').value = '25'; $('sessTravelRet').value = '20'; $('sessKm').value = '12.4';
      $('sessParking').value = '8.50'; $('sessParkingNote').value = 'EXAMPLE car park';
      $('sessReportAdd').checked = false;
      $('sessSaveBtn').click();
    });
    const saved = await page.evaluate(() => state.sessions.filter(s => s.kind === 'physio'));
    check('physio: session saved via form', saved.length === 1 && saved[0].claimType === 'direct' && saved[0].travelOutMin === 25 && saved[0].parkingTolls === 8.5, saved);
    // travel > 30 min blocked at save
    const n0 = dialogs.length;
    await page.evaluate(() => {
      $('sessKind').value = 'physio'; $('sessKind').dispatchEvent(new Event('change'));
      $('sessDate').value = '2026-11-17'; $('sessStart').value = '10:00'; $('sessEnd').value = '11:00';
      $('sessTravelOut').value = '35'; $('sessSaveBtn').click();
    });
    check('physio: travel > 30 min each way is blocked', dialogs.length > n0 && /30/.test(dialogs[dialogs.length - 1])
      && (await page.evaluate(() => state.sessions.filter(s => s.kind === 'physio').length)) === 1, dialogs.slice(n0));
    // NF2F + cancellation via state (same shape as form)
    await page.evaluate(() => {
      const cid = state.clients[0].id;
      state.sessions.push({ id: 'p2', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'nf2f', date: '2026-11-17',
        startTime: '14:00', endTime: '14:30', physioDescription: 'EXAMPLE Report writing', travelOutMin: 0, travelReturnMin: 0, km: 0, isPublicHoliday: false, isNonFaceToFace: true });
      state.sessions.push({ id: 'p3', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'cancellation', date: '2026-11-18',
        startTime: '09:00', endTime: '10:00', physioDescription: 'EXAMPLE Short-notice cancellation', travelOutMin: 0, travelReturnMin: 0, km: 0, isPublicHoliday: false, isNonFaceToFace: false });
      saveState(); renderAll();
    });
    // support-type invoice list must not include physio sessions
    const pickSupport = await page.evaluate(() => { $('invKind').value = 'support'; $('invKind').dispatchEvent(new Event('change'));
      $('invClient').value = state.clients[0].id; renderInvoicePick();
      return Array.from(document.querySelectorAll('.pickSess')).map(x => x.value); });
    const physioIds = await page.evaluate(() => state.sessions.filter(s => s.kind === 'physio').map(s => s.id));
    check('physio: support picker excludes physio sessions', !pickSupport.some(id => physioIds.includes(id)));
    // generate support first (INV-0015) then physio (INV-0016) -> shared sequence
    await page.evaluate(() => { $('invDate').value = '2026-11-15'; $('invDue').value = '2026-11-29'; $('invGenBtn').click(); });
    const physio = await page.evaluate(() => {
      $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
      $('invClient').value = state.clients[0].id; renderInvoicePick();
      $('invDate').value = '2026-11-18'; $('invDue').value = '2026-12-02'; $('invPayments').value = '50';
      $('invGenBtn').click();
      const inv = state.invoices[state.invoices.length - 1];
      return { inv, numbers: state.invoices.map(i => i.number), sheetText: $('invoiceSheet').innerText, sheetHtml: $('invoiceSheet').innerHTML,
        title: document.querySelector('#invoiceSheet h1').textContent };
    });
    const inv = physio.inv;
    check('physio: shares INV- sequence (support INV-0015, physio INV-0016)', JSON.stringify(physio.numbers.slice(-2)) === '["INV-0015","INV-0016"]', physio.numbers);
    check('physio: invoiceType=physio', inv.invoiceType === 'physio');
    const L = inv.lines.map(l => [l.lineItem, l.claimType, l.startTime, l.endTime, l.qty, l.unit, l.rate, l.gst, l.amount]);
    const expect = [
      ['15_055_0128_1_3', 'Provider Travel (_PT)', '09:35', '10:00', 0.42, 'h', 92, 0, 38.64],
      ['15_055_0128_1_3', 'Direct', '10:00', '11:00', 1, 'h', 183.99, 0, 183.99],
      ['15_055_0128_1_3', 'Provider Travel (_PT)', '11:00', '11:20', 0.33, 'h', 92, 0, 30.36],
      ['15_799_0128_1_3', 'Non-labour travel', '', '', 12.4, 'km', 0.99, 0, 12.28],
      ['15_799_0128_1_3', 'Non-labour travel', '', '', 1, 'each', 8.5, 0, 8.5],
      ['15_055_0128_1_3_NF', 'NF2F', '14:00', '14:30', 0.5, 'h', 183.99, 0, 92],
      ['15_055_0128_1_3_CA', 'Cancellation', '09:00', '10:00', 1, 'h', 183.99, 0, 183.99]
    ];
    check('physio: line items / qty / rates / amounts', JSON.stringify(L) === JSON.stringify(expect), L);
    check('physio: subtotal, GST, total, payments, amount due',
      inv.subtotal === 549.76 && inv.gst === 0 && inv.total === 549.76 && inv.payments === 50 && inv.amountDue === 499.76,
      [inv.subtotal, inv.gst, inv.total, inv.payments, inv.amountDue]);
    check('physio: Bill To is plan manager', /BILL TO:\s*EXAMPLE Plan Managers/.test(physio.sheetText), physio.sheetText.slice(0, 600));
    check('physio: For: Capacity Building – Improved Daily Living', physio.sheetText.includes('For: Capacity Building – Improved Daily Living'));
    for (const h of ['ITEM NUMBER', 'SERVICE DATE', 'TIME', 'DESCRIPTION', 'CLAIM TYPE', 'UNIT PRICE', 'GST', 'AMOUNT',
                     'SUBTOTAL', 'TOTAL GST', 'INVOICE TOTAL', 'PAYMENTS', 'AMOUNT DUE', 'GST free'])
      check('physio: sheet shows "' + h + '"', physio.sheetText.includes(h));
    check('title: physio title is exactly INVOICE', physio.title === 'INVOICE');
    // TAX INVOICE exists only as the Subcontractor Physio title option; NDIS physio and support sheets never show it.
    check('title: physio sheet never says "TAX INVOICE"', !/tax\s*invoice/i.test(physio.sheetHtml));
    check('title: "TAX INVOICE" in source only in the Subcontractor title option',
      V2_HTML.split('\n').filter(l => /tax\s*invoice/i.test(l)).every(l => /invTitle|coTitle|\.title|title ===|option value="TAX INVOICE"/.test(l)),
      V2_HTML.split('\n').filter(l => /tax\s*invoice/i.test(l)));
    check('physio: no AHPRA printed', !/AHPRA/i.test(physio.sheetHtml));
    check('travel: 25 min at $92/h = 0.42 h x $92 = $38.64 (qty rounded to 0.01 h first, like v1)', inv.lines[0].qty === 0.42 && inv.lines[0].amount === 38.64, inv.lines[0]);
    check('travel: parking/tolls line on 15_799_0128_1_3 at actual cost, GST free',
      inv.lines[4].lineItem === '15_799_0128_1_3' && inv.lines[4].amount === 8.5 && inv.lines[4].gst === 0 && /parking\/tolls/.test(inv.lines[4].description), inv.lines[4]);
    check('travel: sheet prints parking/tolls line', /parking\/tolls/.test(physio.sheetText));
    // keep the rendered physio sheet for review
    await sheetPng(page, path.join(OUT, 'physio-test-sheet.png'));

    /* ---------- 4. cap blocking ---------- */
    const capSettings = await page.evaluate(() => {
      $('setPhyRateDirect').value = '190'; const before = state.settings.physio.rates.direct;
      $('setSaveBtn').click();
      const after = JSON.parse(localStorage.getItem(STORAGE_KEY)).settings.physio.rates.direct;
      renderSettings(); return { before, after: state.settings.physio.rates.direct, stored: after };
    });
    check('cap: settings save refuses Direct $190 (> $183.99)', capSettings.after === 183.99 && capSettings.stored === 183.99, capSettings);
    check('cap: alert explains NDIS cap', /上限/.test(dialogs[dialogs.length - 1]), dialogs.slice(-1));
    for (const [k, v] of [['travel', 92.01], ['km', 1.0], ['nf2f', 184], ['cancellation', 200]]) {
      const r = await page.evaluate((k, v) => {
        const cid = state.clients[0].id;
        state.sessions.push({ id: 'cap' + k, invoiceId: null, clientId: cid, kind: 'physio',
          claimType: k === 'nf2f' || k === 'cancellation' ? k : 'direct', date: '2026-12-0' + (1 + ['travel','km','nf2f','cancellation'].indexOf(k)),
          startTime: '10:00', endTime: '11:00', travelOutMin: k === 'travel' ? 30 : 0, travelReturnMin: 0, km: k === 'km' ? 10 : 0 });
        const old = state.settings.physio.rates[k];
        state.settings.physio.rates[k] = v; // e.g. an old/imported backup with an above-cap price
        const nInv = state.invoices.length;
        $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
        $('invClient').value = cid; renderInvoicePick();
        $('invGenBtn').click();
        const blocked = state.invoices.length === nInv;
        state.settings.physio.rates[k] = old;
        state.sessions = state.sessions.filter(s => s.id !== 'cap' + k);
        return blocked;
      }, k, v);
      check('cap: invoice generation blocked when ' + k + ' rate = ' + v, r && /上限/.test(dialogs[dialogs.length - 1]), dialogs.slice(-1));
    }
    // at the cap is allowed (already proven by the 183.99 / 92 / 0.99 invoice above)

    /* ---------- 4a. travel qty (2 dp, half-up) reconciles: printed qty x unit price (to the cent) == printed amount ---------- */
    // Independent check in exact decimal arithmetic (BigInt) from the strings printed on the invoice.
    const centsFromPrinted = (qtyStr, rateCents) => {
      const [ip, fp = ''] = qtyStr.split('.'); const f = 10n ** BigInt(fp.length);
      const qInt = BigInt(ip + fp); return Number((2n * qInt * BigInt(rateCents) + f) / (2n * f));
    };
    const rec = await page.evaluate(() => {
      const out = [];
      for (const rate of [92, 91.5, 80, 75.25, 50]) for (let m = 1; m <= 30; m++) {
        const ses = { kind: 'physio', claimType: 'direct', date: '2026-12-20', startTime: '10:00', endTime: '11:00', travelOutMin: m, travelReturnMin: 0 };
        const st = JSON.parse(JSON.stringify(state.settings)); st.physio.rates.travel = rate;
        const l = physioLines(ses, st)[0];
        const sheet = document.createElement('div');
        sheet.innerHTML = physioInvoiceHtml({ provider: {}, client: {}, lines: [l], subtotal: l.amount, gst: 0, total: l.amount, payments: 0, amountDue: l.amount });
        const tds = sheet.querySelectorAll('.inv-items tr')[1].querySelectorAll('td');
        out.push({ m, rate, qtyStr: tds[5].textContent, priceStr: tds[6].textContent, amountStr: tds[8].textContent, amount: l.amount });
      }
      return out;
    });
    const recFail = [];
    for (const x of rec) {
      const rateCents = Math.round(Number(x.priceStr.replace(/[$,]/g, '')) * 100);
      const amountCents = Math.round(Number(x.amountStr.replace(/[$,]/g, '')) * 100);
      const qtyHundredths = Math.floor((2 * x.m * 100 + 60) / 120); // minutes/60 rounded half-up to 0.01 h
      const twoDp = /^\d+\.\d{2}$/.test(x.qtyStr) && Math.round(Number(x.qtyStr) * 100) === qtyHundredths;
      if (!twoDp || centsFromPrinted(x.qtyStr, rateCents) !== amountCents) recFail.push(x);
    }
    const at92 = rec.filter(x => x.rate === 92);
    check('reconcile: every minute 1-30 at $92/h prints qty to 2 dp (half-up) and qty x price = amount',
      at92.length === 30 && !recFail.some(x => x.rate === 92), recFail.filter(x => x.rate === 92));
    check('reconcile: also at $91.50, $80, $75.25, $50 (1-30 min)', recFail.length === 0, recFail);
    check('reconcile: 25 min at $92 prints 0.42 / $92.00 / $38.64',
      JSON.stringify(at92[24]) === JSON.stringify({ m: 25, rate: 92, qtyStr: '0.42', priceStr: '$92.00', amountStr: '$38.64', amount: 38.64 }), at92[24]);

    /* ---------- 4b. travel rules ---------- */
    const tr = await page.evaluate(() => {
      const st = state.settings, out = {};
      const mk = (o) => Object.assign({ id: 'x', clientId: state.clients[0].id, kind: 'physio', claimType: 'direct', date: '2026-12-10',
        startTime: '10:00', endTime: '11:00', travelOutMin: 0, travelReturnMin: 0, km: 0, parkingTolls: 0 }, o);
      // travel uses rates.travel, never the direct rate
      const old = st.physio.rates.travel; st.physio.rates.travel = 80;
      const l1 = physioLines(mk({ travelOutMin: 30, travelReturnMin: 30 }), st);
      out.travelRates = l1.filter(l => l.rateKind === 'travel').map(l => [l.rate, l.amount]);
      st.physio.rates.travel = old;
      // exactly 30 min each way is allowed: 2 x $46.00
      out.at30 = physioLines(mk({ travelOutMin: 30, travelReturnMin: 30 }), st).filter(l => l.rateKind === 'travel').map(l => l.amount);
      out.err31 = physioSessionErrors(mk({ travelOutMin: 31 }));
      out.err30 = physioSessionErrors(mk({ travelOutMin: 30, travelReturnMin: 30 }));
      out.parkingNf2f = physioSessionErrors(mk({ claimType: 'nf2f', parkingTolls: 5 }));
      out.parkingNeg = physioSessionErrors(mk({ parkingTolls: -1 }));
      out.migrated = (function () { const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        raw.settings.physio.lineItems.travel = '15_055_0128_1_3_PT'; localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
        return loadState().settings.physio.lineItems.travel; })();
      return out;
    });
    check('travel: uses the travel rate ($80 set), never $183.99', JSON.stringify(tr.travelRates) === '[[80,40],[80,40]]', tr.travelRates);
    check('travel: exactly 30 min each way allowed ($46.00 each)', JSON.stringify(tr.at30) === '[46,46]' && tr.err30.length === 0, tr);
    check('travel: 31 min one way is an error', tr.err31.length === 1 && /30/.test(tr.err31[0]), tr.err31);
    check('parking: not allowed on NF2F; negative rejected', tr.parkingNf2f.length === 1 && tr.parkingNeg.length === 1, tr);
    check('travel: old _PT default migrated to 15_055_0128_1_3', tr.migrated === '15_055_0128_1_3', tr.migrated);
    // travel at the direct rate ($183.99) must be blocked at generation; 31 min injected session also blocked
    for (const [label, setup] of [['travel rate $183.99', 'rate'], ['31 min travel (bypassing the form)', 'min31']]) {
      const blocked = await page.evaluate(setup => {
        const cid = state.clients[0].id, st = state.settings, old = st.physio.rates.travel;
        if (setup === 'rate') st.physio.rates.travel = 183.99;
        state.sessions.push({ id: 'tb', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'direct', date: '2026-12-11',
          startTime: '10:00', endTime: '11:00', travelOutMin: setup === 'min31' ? 31 : 20, travelReturnMin: 0, km: 0, parkingTolls: 0 });
        const n = state.invoices.length;
        $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
        $('invClient').value = cid; renderInvoicePick(); $('invGenBtn').click();
        st.physio.rates.travel = old; state.sessions = state.sessions.filter(s => s.id !== 'tb');
        return state.invoices.length === n;
      }, setup);
      check('travel: generation blocked for ' + label, blocked, dialogs.slice(-1));
    }
    // parking above $0.99 (actual cost) is NOT blocked by the km cap
    const pkOk = await page.evaluate(() => {
      const cid = state.clients[0].id;
      state.sessions.push({ id: 'pk', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'direct', date: '2026-12-12',
        startTime: '10:00', endTime: '11:00', travelOutMin: 10, travelReturnMin: 0, km: 5, parkingTolls: 22.4 });
      const n = state.invoices.length;
      $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
      $('invClient').value = cid; renderInvoicePick(); $('invGenBtn').click();
      const inv = state.invoices[state.invoices.length - 1];
      return state.invoices.length === n + 1 ? inv.lines.find(l => l.rateKind === 'parking').amount : null;
    });
    check('parking: $22.40 actual cost allowed (not capped at $0.99)', pkOk === 22.4, pkOk);

    /* ---------- 4c. default NF2F report line on a new direct physio session ---------- */
    const rp = await page.evaluate(() => {
      const cid = state.clients[0].id, out = {};
      clearSessionForm();
      out.defaults = [$('sessReportAdd').checked, $('sessReportMin').value, $('sessReportDesc').value];
      $('sessClient').value = cid;
      $('sessKind').value = 'physio'; $('sessKind').dispatchEvent(new Event('change'));
      $('sessDate').value = '2026-12-01'; $('sessDate').dispatchEvent(new Event('change'));
      $('sessStart').value = '11:00'; $('sessEnd').value = '12:00';
      $('sessClaimType').value = 'direct'; $('sessClaimType').dispatchEvent(new Event('change'));
      $('sessTravelOut').value = '15'; $('sessTravelRet').value = '15'; $('sessKm').value = '20';
      out.visible = $('sessReportAdd').closest('label').style.display !== 'none' && $('sessReportMin').closest('label').style.display !== 'none';
      $('sessSaveBtn').click();
      const day = state.sessions.filter(s => s.date === '2026-12-01' && s.kind === 'physio');
      out.day = day.map(s => [s.claimType, s.startTime, s.endTime, s.physioDescription, s.travelOutMin, s.travelReturnMin, s.km]);
      // edited report minutes (20) + text, NF2F claim type never auto-adds
      clearSessionForm();
      $('sessClient').value = cid;
      $('sessKind').value = 'physio'; $('sessKind').dispatchEvent(new Event('change'));
      $('sessDate').value = '2026-12-02'; $('sessDate').dispatchEvent(new Event('change'));
      $('sessStart').value = '09:00'; $('sessEnd').value = '10:00';
      $('sessReportMin').value = '20'; $('sessReportDesc').value = 'EXAMPLE progress report';
      $('sessSaveBtn').click();
      out.edited = state.sessions.filter(s => s.date === '2026-12-02').map(s => [s.claimType, s.startTime, s.endTime, s.physioDescription]);
      clearSessionForm();
      $('sessClient').value = cid;
      $('sessKind').value = 'physio'; $('sessKind').dispatchEvent(new Event('change'));
      $('sessDate').value = '2026-12-03'; $('sessDate').dispatchEvent(new Event('change'));
      $('sessStart').value = '09:00'; $('sessEnd').value = '09:30';
      $('sessClaimType').value = 'nf2f'; $('sessClaimType').dispatchEvent(new Event('change'));
      $('sessSaveBtn').click();
      out.nf2fOnly = state.sessions.filter(s => s.date === '2026-12-03').length;
      // invoice from the 12-01 pair = the INV-0015 shape ($295.79)
      const ids = state.sessions.filter(s => s.date === '2026-12-01').map(s => s.id);
      $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
      $('invClient').value = cid; renderInvoicePick();
      document.querySelectorAll('.pickSess').forEach(x => { x.checked = ids.includes(x.value); });
      $('invPayments').value = ''; $('invGenBtn').click();
      const inv = state.invoices[state.invoices.length - 1];
      out.total = inv.total; out.lines = inv.lines.map(l => [l.lineItem, l.startTime, l.endTime, l.qty, l.amount]);
      // editing an existing direct session does not add another report
      const d = state.sessions.find(s => s.date === '2026-12-02' && s.claimType === 'direct');
      renderAll(); document.querySelector('#sessList [data-edit="' + d.id + '"]').click();
      out.editUnticked = !$('sessReportAdd').checked;
      $('sessSaveBtn').click();
      out.afterEdit = state.sessions.filter(s => s.date === '2026-12-02').length;
      clearSessionForm();
      state.sessions = state.sessions.filter(s => !['2026-12-02', '2026-12-03'].includes(s.date) || s.invoiceId); renderAll();
      return out;
    });
    check('report: defaults ticked, 15 min, "Report writing"', JSON.stringify(rp.defaults) === '[true,"15","Report writing"]' && rp.visible, rp);
    check('report: new direct 11:00-12:00 (+15 back) adds NF2F 12:15-12:30',
      JSON.stringify(rp.day) === JSON.stringify([['direct', '11:00', '12:00', '', 15, 15, 20], ['nf2f', '12:15', '12:30', 'Report writing', 0, 0, 0]]), rp.day);
    check('report: minutes/text editable (20 min, no travel -> 10:00-10:20)',
      JSON.stringify(rp.edited) === JSON.stringify([['direct', '09:00', '10:00', ''], ['nf2f', '10:00', '10:20', 'EXAMPLE progress report']]), rp.edited);
    check('report: NF2F claim type does not add another report', rp.nf2fOnly === 1, rp);
    check('report: editing an existing session adds nothing', rp.editUnticked && rp.afterEdit === 2, rp);
    check('report: invoice = 23.00 + 183.99 + 23.00 + 19.80 + 46.00 = $295.79', rp.total === 295.79, rp.lines);

    /* ---------- 5. overlap blocking (same category; cross-category same day is blocked earlier, see 6) ---------- */
    const ov = await page.evaluate(() => {
      const cid = state.clients[0].id;
      state.sessions.push({ id: 'ov0', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'direct', date: '2026-11-25',
        startTime: '10:00', endTime: '11:00', travelOutMin: 0, travelReturnMin: 0, km: 0 });
      state.sessions.push({ id: 'ov1', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'direct', date: '2026-11-25',
        startTime: '11:15', endTime: '12:15', travelOutMin: 30, travelReturnMin: 0, km: 0 });
      renderAll();
      const n = state.invoices.length;
      $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
      $('invClient').value = cid; renderInvoicePick();
      document.querySelectorAll('.pickSess').forEach(x => { x.checked = ['ov0', 'ov1'].includes(x.value); });
      $('invGenBtn').click();
      const blocked = state.invoices.length === n;
      state.sessions = state.sessions.filter(s => !['ov0', 'ov1'].includes(s.id)); renderAll();
      return blocked;
    });
    check('overlap: physio session overlapping (incl. travel) another session is blocked', ov && /重叠/.test(dialogs[dialogs.length - 1]), dialogs.slice(-1));

    /* ---------- 6. HARD same-day cross-category block ---------- */
    const sd = await page.evaluate(() => {
      const cid = state.clients[0].id, out = {};
      const physioCount = () => state.sessions.filter(s => s.kind === 'physio').length;
      const supportCount = () => state.sessions.filter(s => s.kind !== 'physio').length;
      const dlg = []; const realAlert = window.alert; window.alert = m => dlg.push(String(m));
      clearSessionForm();
      // a) physio on 2026-11-13 (open support 10:00-14:00) at 18:00-19:00: no overlap, still blocked
      $('sessClient').value = cid; $('sessClient').dispatchEvent(new Event('change'));
      $('sessKind').value = 'physio'; $('sessKind').dispatchEvent(new Event('change'));
      $('sessDate').value = '2026-11-13'; $('sessDate').dispatchEvent(new Event('change'));
      $('sessStart').value = '18:00'; $('sessEnd').value = '19:00';
      out.aDisabled = $('sessSaveBtn').disabled;
      out.aMsg = $('sessSameDayMsg').textContent; out.aShown = $('sessSameDayMsg').style.display !== 'none';
      out.aPopup = dlg.slice();
      const p0 = physioCount();
      $('sessSaveBtn').click(); // disabled -> no-op
      $('sessSaveBtn').disabled = false; $('sessSaveBtn').click(); // forced -> handler still refuses
      out.aSaved = physioCount() !== p0; out.aForcedPopup = dlg[dlg.length - 1];
      // b) switching to a free date re-enables the button
      $('sessDate').value = '2026-11-26'; $('sessDate').dispatchEvent(new Event('change'));
      $('sessReportAdd').checked = false;
      out.bEnabled = !$('sessSaveBtn').disabled && $('sessSameDayMsg').style.display === 'none';
      $('sessSaveBtn').click(); out.bSaved = physioCount() === p0 + 1;
      // c) support on a date that already has physio (2026-11-26) is blocked
      clearSessionForm();
      $('sessClient').value = cid;
      $('sessKind').value = 'support'; $('sessKind').dispatchEvent(new Event('change'));
      $('sessDate').value = '2026-11-26'; $('sessDate').dispatchEvent(new Event('change'));
      $('sessStart').value = '06:00'; $('sessEnd').value = '07:00';
      const s0 = supportCount();
      out.cDisabled = $('sessSaveBtn').disabled; out.cMsg = $('sessSameDayMsg').textContent;
      $('sessSaveBtn').disabled = false; $('sessSaveBtn').click(); out.cSaved = supportCount() !== s0;
      // d) invoiced-only evidence: a non-void physio invoice line on 2026-11-27 (its session deleted) blocks support
      state.invoices.push({ id: 'pinv', number: 'INV-9001', invoiceType: 'physio', voided: false, sessionIds: [],
        client: { name: state.clients[0].name, ndisNumber: state.clients[0].ndisNumber }, lines: [{ serviceDate: '2026-11-27', amount: 1 }] });
      state.invoices.push({ id: 'vinv', number: 'INV-9002', invoiceType: 'physio', voided: true, sessionIds: [],
        client: { name: state.clients[0].name, ndisNumber: state.clients[0].ndisNumber }, lines: [{ serviceDate: '2026-11-28', amount: 1 }] });
      out.dInvoice = sameDayConflicts(cid, '2026-11-27', 'support', null);
      out.dVoid = sameDayConflicts(cid, '2026-11-28', 'support', null);
      out.dOtherKindSameCat = sameDayConflicts(cid, '2026-11-27', 'physio', null);
      state.invoices = state.invoices.filter(i => !['pinv', 'vinv'].includes(i.id));
      // e) editing an existing physio session onto a support day is blocked
      const ps = state.sessions.find(s => s.kind === 'physio' && s.date === '2026-11-26');
      renderAll();
      document.querySelector('#sessList [data-edit="' + ps.id + '"]').click();
      $('sessDate').value = '2026-11-14'; $('sessDate').dispatchEvent(new Event('change'));
      out.eDisabled = $('sessSaveBtn').disabled;
      $('sessSaveBtn').disabled = false; $('sessSaveBtn').click();
      out.eUnchanged = state.sessions.find(s => s.id === ps.id).date === '2026-11-26';
      clearSessionForm();
      // f) invoice picker: legacy cross-category session pair on one date cannot be selected or invoiced
      state.sessions.push({ id: 'xp', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'direct', date: '2026-11-15',
        startTime: '15:00', endTime: '16:00', travelOutMin: 0, travelReturnMin: 0, km: 0 });
      renderAll();
      $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
      $('invClient').value = cid; renderInvoicePick();
      const box = document.querySelector('.pickSess[value="xp"]');
      out.fDisabled = !!box && box.disabled && !box.checked;
      out.fRowMsg = $('invSessionPick').innerText;
      $('invKind').value = 'support'; $('invKind').dispatchEvent(new Event('change')); renderInvoicePick();
      state.sessions.push({ id: 'xs', invoiceId: null, clientId: cid, date: '2026-11-15', startTime: '07:00', endTime: '08:00',
        km: 0, isPublicHoliday: false, isNonFaceToFace: false, supportType: 'community' });
      renderInvoicePick();
      const sup = state.sessions.find(s => s.id === 'xs');
      const sbox = sup && document.querySelector('.pickSess[value="' + sup.id + '"]');
      out.fSupportDisabled = !!sbox && sbox.disabled;
      const n = state.invoices.length;
      if (sbox) { sbox.disabled = false; sbox.checked = true; }
      $('invDate').value = '2026-11-30'; $('invGenBtn').click();
      out.fNotGenerated = state.invoices.length === n;
      out.fPopup = dlg[dlg.length - 1];
      state.sessions = state.sessions.filter(s => !['xp', 'xs', ps.id].includes(s.id)); renderAll();
      window.alert = realAlert;
      return out;
    });
    const zh1 = '這一天已有 support work，不能加物理治療', zh2 = '這一天已有物理治療，不能加 support work';
    check('same-day: physio on a support day (no overlap) disables Save', sd.aDisabled && sd.aShown, sd);
    check('same-day: message zh+en (這一天已有 support work，不能加物理治療)', sd.aMsg.includes(zh1) && /already has support work/.test(sd.aMsg), sd.aMsg);
    check('same-day: popup shown when date chosen', sd.aPopup.some(m => m.includes(zh1)), sd.aPopup);
    check('same-day: forced click still refuses to save', !sd.aSaved && sd.aForcedPopup.includes(zh1), sd);
    check('same-day: free date re-enables Save and saves', sd.bEnabled && sd.bSaved, sd);
    check('same-day: support on a physio day blocked (這一天已有物理治療，不能加 support work)', sd.cDisabled && !sd.cSaved && sd.cMsg.includes(zh2) && /already has physiotherapy/.test(sd.cMsg), sd);
    check('same-day: non-void invoice lines count; void invoices ignored; same category not blocked',
      sd.dInvoice.length === 1 && /INV-9001/.test(sd.dInvoice[0]) && sd.dVoid.length === 0 && sd.dOtherKindSameCat.length === 0, sd);
    check('same-day: editing a session onto a cross-category day is blocked', sd.eDisabled && sd.eUnchanged, sd);
    check('same-day: picker disables cross-category same-day session (physio)', sd.fDisabled && sd.fRowMsg.includes(zh1), sd);
    check('same-day: picker disables it on support side too, and generate refuses if forced', sd.fSupportDisabled && sd.fNotGenerated && sd.fPopup.includes(zh2), sd);
    check('physio: no page errors', !dialogs.some(d => d.startsWith('pageerror')), dialogs.filter(d => d.startsWith('pageerror')));
    await ctx.close();
  }

  /* ---------- 8. Subcontractor Physio (company invoices) ---------- */
  {
    const { ctx, page, dialogs, requests } = await openApp(V2_HTML, { seed: { 'ndis-invoice-tool-v2': ledgerText } });
    const r = await page.evaluate(() => {
      const out = {}; const dlg = []; window.alert = m => dlg.push(String(m)); window.confirm = () => true;
      out.oldLedgerCompanies = Array.isArray(state.companies) && state.companies.length === 0;
      // company through the settings UI (EXAMPLE data)
      $('coName').value = 'EXAMPLE Health Pty Ltd'; $('coAbn').value = '00 000 000 000';
      $('coAddress').value = '1 Example Rd, Melbourne VIC 3000'; $('coPhone').value = '0400 000 000';
      $('coEmail').value = 'admin@example.com'; $('coRate').value = '115'; $('coDueDays').value = '7'; $('coGst').value = '0';
      $('coSaveBtn').click();
      const co = state.companies[0];
      out.company = co && [co.name, co.rate, co.dueDays, co.gstRate, co.title];
      // a second company without a price
      $('coName').value = 'EXAMPLE NoPrice Co'; $('coRate').value = ''; $('coSaveBtn').click();
      const co2 = state.companies[1];
      // session form: subcontractor fields, presets, default 75 min
      clearSessionForm();
      $('sessKind').value = 'subcontractor'; $('sessKind').dispatchEvent(new Event('change'));
      out.subFieldsShown = $('sessCompany').closest('label').style.display !== 'none' && $('sessClient').closest('label').style.display === 'none'
        && $('sessEnd').closest('label').style.display === 'none';
      out.presets = Array.from($('sessSubPreset').options).map(o => o.textContent);
      out.defaultDesc = $('sessSubDesc').value; out.defaultMin = $('sessSubMin').value;
      const addSub = (companyId, client, date, start, presetIdx, minutes, desc) => {
        clearSessionForm();
        $('sessKind').value = 'subcontractor'; $('sessKind').dispatchEvent(new Event('change'));
        $('sessCompany').value = companyId; $('sessSubClient').value = client;
        $('sessDate').value = date; $('sessDate').dispatchEvent(new Event('change'));
        $('sessStart').value = start;
        if (presetIdx != null) { $('sessSubPreset').value = String(presetIdx); $('sessSubPreset').dispatchEvent(new Event('change')); }
        if (minutes != null) $('sessSubMin').value = String(minutes);
        if (desc != null) $('sessSubDesc').value = desc;
        out['saveDisabled_' + client] = $('sessSaveBtn').disabled;
        const n = state.sessions.length; $('sessSaveBtn').click();
        return state.sessions.length === n + 1 ? state.sessions[state.sessions.length - 1] : null;
      };
      const jim = addSub(co.id, 'Jim', '2026-11-18', '09:00', 0);
      const li = addSub(co.id, 'Li (李叔叔)', '2026-11-18', '10:30', 0);
      out.jim = jim && [jim.kind, jim.startTime, jim.endTime, jim.minutes, jim.description, jim.clientId];
      // fixture: support session 2026-11-13 10:00-14:00 -> same day but no overlap is allowed (not NDIS rule)
      const sameDay = addSub(co.id, 'EXAMPLE A', '2026-11-13', '15:00', 1, null, null);
      out.sameDayAllowed = !!sameDay && !out['saveDisabled_EXAMPLE A'];
      out.sameDayDesc = sameDay && sameDay.description;
      // overlapping his own support time -> blocked
      const d0 = dlg.length;
      const ov = addSub(co.id, 'EXAMPLE B', '2026-11-13', '13:00', 2, 75, null);
      out.overlapBlocked = !ov && dlg.slice(d0).some(m => /重叠|overlap/i.test(m));
      // physio on a contractor day: overlapping blocked, non-overlapping allowed (no same-day block)
      const addPhysio = (date, start, end) => {
        clearSessionForm();
        $('sessClient').value = state.clients[0].id;
        $('sessKind').value = 'physio'; $('sessKind').dispatchEvent(new Event('change'));
        $('sessDate').value = date; $('sessDate').dispatchEvent(new Event('change'));
        $('sessStart').value = start; $('sessEnd').value = end; $('sessReportAdd').checked = false;
        out['physioDisabled_' + start] = $('sessSaveBtn').disabled;
        const n = state.sessions.length; $('sessSaveBtn').click(); return state.sessions.length === n + 1;
      };
      const d1 = dlg.length;
      out.physioOverlapBlocked = !addPhysio('2026-11-18', '09:30', '10:00') && dlg.slice(d1).some(m => /重叠|overlap/i.test(m));
      out.physioSameDayOk = addPhysio('2026-11-18', '14:00', '15:00') && !out['physioDisabled_14:00'];
      out.sameDayFn = sameDayConflicts(state.clients[0].id, '2026-11-18', 'support', null).length; // only the physio
      // support/physio pickers never list contractor sessions
      $('invClient').value = state.clients[0].id;
      $('invKind').value = 'support'; $('invKind').dispatchEvent(new Event('change'));
      const subIds = state.sessions.filter(s => s.kind === 'subcontractor').map(s => s.id);
      out.supportPickClean = !Array.from(document.querySelectorAll('.pickSess')).some(x => subIds.includes(x.value));
      $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
      out.physioPickClean = !Array.from(document.querySelectorAll('.pickSess')).some(x => subIds.includes(x.value));
      // invoice tab: subcontractor mode
      $('invKind').value = 'subcontractor'; $('invKind').dispatchEvent(new Event('change'));
      $('invCompany').value = co.id; $('invCompany').dispatchEvent(new Event('change'));
      $('invDate').value = '2026-11-19'; $('invDate').dispatchEvent(new Event('change'));
      out.uiSub = [$('invClientField').style.display, $('invCompanyField').style.display, $('invTitle').value, $('invCombine').checked, $('invDue').value];
      const pick = ids => document.querySelectorAll('.pickSess').forEach(x => { x.checked = ids.includes(x.value); });
      // separate (default): Jim + Li -> two invoices, consecutive numbers
      state.settings.nextInvoiceNumber = 16;
      pick([jim.id, li.id]);
      let n = state.invoices.length; $('invGenBtn').click();
      const sep = state.invoices.slice(n);
      out.sep = sep.map(i => [i.number, i.invoiceType, i.title, i.client.name, i.total, i.gst, i.dueDate, i.lines.length]);
      out.sepLine = sep[0] && sep[0].lines.map(l => [l.serviceDate, l.clientName, l.description, l.rate, l.qty, l.unit, l.amount])[0];
      out.next = state.settings.nextInvoiceNumber;
      out.sheetText = sep[1] ? (showPreview(sep[1]), $('invoiceSheet').innerText) : '';
      out.sheetHtml = $('invoiceSheet').innerHTML;
      out.fileName = pdfFilename(sep[1]);
      // combined: void both, sessions return to open, then combine
      sep.forEach(inv => { inv.sessionIds = state.sessions.filter(s => s.invoiceId === inv.id).map(s => s.id); inv.voided = true;
        state.sessions.forEach(s => { if (s.invoiceId === inv.id) s.invoiceId = null; }); });
      renderAll();
      $('invKind').value = 'subcontractor'; $('invKind').dispatchEvent(new Event('change'));
      $('invCompany').value = co.id; $('invCompany').dispatchEvent(new Event('change'));
      pick([jim.id, li.id]); $('invCombine').checked = true; $('invTitle').value = 'TAX INVOICE';
      n = state.invoices.length; $('invGenBtn').click();
      const comb = state.invoices.slice(n);
      out.comb = comb.map(i => [i.number, i.title, i.client.name, i.subtotal, i.total, i.lines.length]);
      out.combTitle = document.querySelector('#invoiceSheet h1').textContent;
      $('invCombine').checked = false;
      // GST 10% company math
      state.companies[0].gstRate = 10; state.companies[0].title = 'INVOICE';
      const g = addSub(co.id, 'EXAMPLE G', '2026-11-20', '09:00', 0);
      $('invKind').value = 'subcontractor'; $('invKind').dispatchEvent(new Event('change'));
      $('invCompany').value = co.id; $('invCompany').dispatchEvent(new Event('change'));
      pick([g.id]); n = state.invoices.length; $('invGenBtn').click();
      const gi = state.invoices[n];
      out.gst = gi && [gi.subtotal, gi.gstRate, gi.gst, gi.total];
      state.companies[0].gstRate = 0;
      // no price -> blocked
      const np = addSub(co2.id, 'EXAMPLE N', '2026-11-21', '09:00', 0);
      $('invCompany').value = co2.id; $('invCompany').dispatchEvent(new Event('change'));
      pick([np.id]); n = state.invoices.length; const d2 = dlg.length; $('invGenBtn').click();
      out.noPriceBlocked = state.invoices.length === n && dlg.slice(d2).some(m => /单价/.test(m));
      // weekly stats count contractor minutes as hours
      out.stats = weekStats('2026-11-16', null).hours.weekday >= 2.5;
      // a company in use cannot be deleted
      const d3 = dlg.length; document.querySelector('[data-codel="' + co.id + '"]').click();
      out.noDelete = state.companies.some(c => c.id === co.id) && /不能删除/.test(dlg[d3] || '');
      // round trip: companies survive save + reload of the ledger shape
      saveState(); const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      out.savedCompanies = Array.isArray(saved.companies) && saved.companies.length === 2;
      out.merge = mergeLedgers({ settings: {}, clients: [], sessions: [], invoices: [], companies: [{ id: 'a', name: 'A' }] },
        { settings: {}, clients: [], sessions: [], invoices: [], companies: [{ id: 'b', name: 'B' }] }).companies.length;
      renderArchive();
      out.archiveShows = $('archiveList').innerText.includes('Li (李叔叔)') && $('archiveList').innerText.includes('EXAMPLE Health Pty Ltd');
      $('archiveClient').value = state.clients[0].id;
      out.archiveFilter = state.invoices.some(i => i.invoiceType === 'subcontractor' && !i.voided) && !getFilteredArchiveInvoices().some(i => i.invoiceType === 'subcontractor');
      $('archiveClient').value = ''; $('archiveSearch').value = 'example health';
      out.archiveSearch = getFilteredArchiveInvoices().length > 0 && getFilteredArchiveInvoices().every(i => i.invoiceType === 'subcontractor');
      $('archiveSearch').value = ''; renderArchive();
      out.dlg = dlg;
      return out;
    });
    check('sub: old ledger without companies loads (companies = [])', r.oldLedgerCompanies);
    check('sub: company saved via settings (rate 115, due 7, GST 0, INVOICE)', JSON.stringify(r.company) === JSON.stringify(['EXAMPLE Health Pty Ltd', 115, 7, 0, 'INVOICE']), r.company);
    check('sub: form shows company/client fields, hides NDIS client + end time', r.subFieldsShown, r);
    check('sub: 3 description presets, default preset 1, default 75 min',
      r.presets.length === 4 && r.presets[2].startsWith('Physiotherapy session (Hydrotherapy)') && r.defaultDesc === 'Physiotherapy session (60 mins) + note writing (15 mins) - Home Visit' && r.defaultMin === '75', r.presets);
    check('sub: session saved, end = start + 75 min, no NDIS client', JSON.stringify(r.jim) === JSON.stringify(['subcontractor', '09:00', '10:15', 75, 'Physiotherapy session (60 mins) + note writing (15 mins) - Home Visit', '']), r.jim);
    check('sub: NOT subject to NDIS same-day rule (support day, no overlap -> saved)', r.sameDayAllowed && /initial assessment/.test(r.sameDayDesc), r);
    check('sub: overlap with his own support time blocked', r.overlapBlocked, r.dlg);
    check('sub: physio overlapping a contractor session blocked; same day without overlap allowed', r.physioOverlapBlocked && r.physioSameDayOk, r);
    check('sub: same-day function ignores contractor sessions', r.sameDayFn === 1, r.sameDayFn);
    check('sub: support and physio pickers never list contractor sessions', r.supportPickClean && r.physioPickClean);
    check('sub: invoice tab shows company/title/combine, due = date + 7', JSON.stringify(r.uiSub) === JSON.stringify(['none', '', 'INVOICE', false, '2026-11-26']), r.uiSub);
    check('sub: default = one invoice per client, consecutive numbers INV-0016 / INV-0017, $143.75 each',
      JSON.stringify(r.sep) === JSON.stringify([['INV-0016', 'subcontractor', 'INVOICE', 'Jim', 143.75, 0, '2026-11-26', 1], ['INV-0017', 'subcontractor', 'INVOICE', 'Li (李叔叔)', 143.75, 0, '2026-11-26', 1]]) && r.next === 18, r.sep);
    check('sub: line = date, client, description, $115/h, 75 min, $143.75',
      JSON.stringify(r.sepLine) === JSON.stringify(['2026-11-18', 'Jim', 'Physiotherapy session (60 mins) + note writing (15 mins) - Home Visit', 115, 75, 'min', 143.75]), r.sepLine);
    for (const h of ['DATE', 'CLIENT', 'SERVICE DESCRIPTION', 'UNIT PRICE', 'QTY', 'TOTAL', 'SUBTOTAL', 'GST', 'TOTAL DUE', 'BILL TO', 'EXAMPLE Health Pty Ltd', 'admin@example.com', 'Li (李叔叔)', '75 mins', '$115.00/h', '$143.75', 'From', 'Payment details'])
      check('sub: sheet shows "' + h + '"', r.sheetText.includes(h), r.sheetText.slice(0, 400));
    check('sub: sheet has no NDIS number / item codes / plan manager', !/NDIS|15_055|Plan Manager|Participant/i.test(r.sheetHtml), r.sheetText);
    check('sub: PDF file name has company + client', r.fileName === 'Invoice INV-0017 - EXAMPLE Health Pty Ltd - Li (李叔叔).pdf', r.fileName);
    check('sub: combine checkbox -> one invoice $287.50 (2 lines), TAX INVOICE title option',
      JSON.stringify(r.comb) === JSON.stringify([['INV-0018', 'TAX INVOICE', 'Jim, Li (李叔叔)', 287.5, 287.5, 2]]) && r.combTitle === 'TAX INVOICE', r.comb);
    check('sub: GST 10% -> 143.75 + 14.38 = 158.13', JSON.stringify(r.gst) === JSON.stringify([143.75, 10, 14.38, 158.13]), r.gst);
    check('sub: empty price blocks issuing', r.noPriceBlocked, r.dlg.slice(-2));
    check('sub: weekly stats count contractor minutes as hours', r.stats);
    check('sub: company in use cannot be deleted', r.noDelete);
    check('sub: companies saved in ledger and merged by id', r.savedCompanies && r.merge === 2, r);
    check('sub: archive lists company invoices (client + company), NDIS client filter excludes them, search finds company',
      r.archiveShows && r.archiveFilter && r.archiveSearch, r);
    check('sub: no page errors', !dialogs.some(d => d.startsWith('pageerror')), dialogs.filter(d => d.startsWith('pageerror')));
    check('sub: no request to 127.0.0.1:8765', !requests.some(u => u.includes('8765')), requests);
    await ctx.close();
  }

  /* ---------- 7. CLI tools/check_same_day.py (read-only) ---------- */
  {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdcli-'));
    const clean = path.join(tmp, 'v2.json'), bad = path.join(tmp, 'v2c.json');
    fs.writeFileSync(clean, ledgerText);
    const c = JSON.parse(ledgerText);
    c.sessions.push({ id: 'x', clientId: c.clients[0].id, kind: 'physio', claimType: 'direct', date: '2026-11-13', startTime: '18:00', endTime: '19:00' });
    fs.writeFileSync(bad, JSON.stringify(c));
    const before = [clean, bad].map(f => fs.readFileSync(f, 'utf8'));
    const run = args => { try { return { code: 0, out: execFileSync('python3', [path.join(ROOT, 'tools', 'check_same_day.py'), ...args], { encoding: 'utf8' }) }; }
      catch (e) { return { code: e.status, out: String(e.stdout) }; } };
    const r1 = run(['--v2', clean, '--v1', clean]);
    const r2 = run(['--v2', bad, '--no-v1']);
    const r3 = run(['--v2', clean, '--no-v1', '--client', c.clients[0].ndisNumber, '--date', '13/11/2026', '--type', 'physio']);
    const r4 = run(['--v2', clean, '--no-v1', '--client', c.clients[0].name, '--date', '2026-11-12', '--type', 'physio']);
    const subL = path.join(tmp, 'v2sub.json'); const cs = JSON.parse(ledgerText);
    cs.sessions.push({ id: 'cs1', clientId: '', kind: 'subcontractor', companyId: 'co1', clientName: 'EXAMPLE Jim', date: '2026-11-12', startTime: '15:00', endTime: '16:15', minutes: 75 });
    cs.invoices.push({ id: 'ci1', number: 'INV-9100', invoiceType: 'subcontractor', voided: false, sessionIds: ['cs1'], client: { name: cs.clients[0].name, ndisNumber: '' }, lines: [{ serviceDate: '2026-11-12' }] });
    fs.writeFileSync(subL, JSON.stringify(cs));
    const r5 = run(['--v2', subL, '--no-v1']);
    const r6 = run(['--v2', subL, '--no-v1', '--client', c.clients[0].name, '--date', '2026-11-12', '--type', 'support']);
    check('cli: clean ledgers -> exit 0', r1.code === 0 && /OK/.test(r1.out), r1);
    check('cli: cross-category same day reported -> exit 2', r2.code === 2 && /CONFLICT/.test(r2.out) && /2026-11-13/.test(r2.out), r2);
    check('cli: proposed physio on a support day -> BLOCKED exit 2 (zh+en)', r3.code === 2 && r3.out.includes('這一天已有 support work，不能加物理治療'), r3);
    check('cli: proposed physio on a free day -> exit 0', r4.code === 0, r4);
    check('cli: Subcontractor Physio sessions/invoices ignored (no conflict)', r5.code === 0 && r6.code === 0 && !/INV-9100|cs1/.test(r5.out + r6.out), [r5, r6]);
    check('cli: ledger files untouched', [clean, bad].map(f => fs.readFileSync(f, 'utf8')).join() === before.join());
    check('cli: opens ledgers read-only ("rb" only, no write mode)', /open\(path, "rb"\)/.test(fs.readFileSync(path.join(ROOT, 'tools', 'check_same_day.py'), 'utf8'))
      && !/open\([^)]*['"](w|a|r\+|wb|ab)['"]/.test(fs.readFileSync(path.join(ROOT, 'tools', 'check_same_day.py'), 'utf8')));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
