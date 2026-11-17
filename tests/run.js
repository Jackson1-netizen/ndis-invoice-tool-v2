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

async function openApp(html, { seed = {}, url = '/index.html' } = {}) {
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
    requests.push(u);
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
    check('storage: v1 8765 ledger server disabled', r0.url === null, r0);
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
    check('storage: no page errors', !dialogs.some(d => d.startsWith('pageerror')), dialogs);
    const src = V2_HTML;
    check('storage: source has no v1 key literals',
      !/['"]ndis-invoice-tool['"]/.test(src) && !/['"]ndis-invoice-disk['"]/.test(src) && !/['"]invoice-data\.json['"]/.test(src) && !src.includes('8765/data.json'));
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
    check('title: no "TAX INVOICE" anywhere in app source', !/tax\s*invoice/i.test(V2_HTML));
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

    /* ---------- 5. overlap blocking ---------- */
    const ov = await page.evaluate(() => {
      const cid = state.clients[0].id;
      // support session 09:00-12:15 on 2026-11-11 already invoiced; physio 12:00-13:00 with travel overlaps it
      state.sessions.push({ id: 'ov1', invoiceId: null, clientId: cid, kind: 'physio', claimType: 'direct', date: '2026-11-11',
        startTime: '12:30', endTime: '13:30', travelOutMin: 20, travelReturnMin: 0, km: 0 });
      const n = state.invoices.length;
      $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
      $('invClient').value = cid; renderInvoicePick(); $('invGenBtn').click();
      const blocked = state.invoices.length === n;
      state.sessions = state.sessions.filter(s => s.id !== 'ov1');
      return blocked;
    });
    check('overlap: physio session overlapping (incl. travel) another session is blocked', ov && /重叠/.test(dialogs[dialogs.length - 1]), dialogs.slice(-1));
    check('physio: no page errors', !dialogs.some(d => d.startsWith('pageerror')), dialogs.filter(d => d.startsWith('pageerror')));
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
