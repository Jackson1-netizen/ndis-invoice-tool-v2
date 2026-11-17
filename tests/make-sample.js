#!/usr/bin/env node
// Builds sample/EXAMPLE_physio_invoice.pdf (+ .png) from EXAMPLE data only (no real client),
// using the app's own physio calculation and its print/PDF path.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'sample');
const ORIGIN = 'http://ndis-tool.test';
(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-example.json'), 'utf8'));
  ledger.sessions = [
    { id: 'e1', invoiceId: null, clientId: 'exc1', kind: 'physio', claimType: 'direct', date: '2026-11-16',
      startTime: '10:00', endTime: '11:00', physioDescription: 'EXAMPLE Initial assessment',
      travelOutMin: 25, travelReturnMin: 20, km: 12.4, parkingTolls: 8.5, parkingTollsNote: 'EXAMPLE car park', isPublicHoliday: false, isNonFaceToFace: false },
    { id: 'e2', invoiceId: null, clientId: 'exc1', kind: 'physio', claimType: 'nf2f', date: '2026-11-17',
      startTime: '14:00', endTime: '14:30', physioDescription: 'EXAMPLE Report writing',
      travelOutMin: 0, travelReturnMin: 0, km: 0, isPublicHoliday: false, isNonFaceToFace: true },
    { id: 'e3', invoiceId: null, clientId: 'exc1', kind: 'physio', claimType: 'cancellation', date: '2026-11-18',
      startTime: '09:00', endTime: '10:00', physioDescription: 'EXAMPLE Short-notice cancellation',
      travelOutMin: 0, travelReturnMin: 0, km: 0, isPublicHoliday: false, isNonFaceToFace: false }
  ];
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const alerts = [];
  page.on('dialog', async d => { alerts.push(d.message()); await d.accept(); });
  await page.setRequestInterception(true);
  page.on('request', r => r.url() === ORIGIN + '/' ? r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : (r.url().startsWith('data:') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(t => { localStorage.clear(); localStorage.setItem('ndis-invoice-tool-v2', t); }, JSON.stringify(ledger));
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  const inv = await page.evaluate(() => {
    $('invKind').value = 'physio'; $('invKind').dispatchEvent(new Event('change'));
    $('invClient').value = 'exc1'; renderInvoicePick();
    $('invDate').value = '2026-11-18'; $('invDue').value = '2026-12-02'; $('invPayments').value = '0';
    $('invGenBtn').click();
    activateTab('invoice');
    $('toast').style.display = 'none';
    return state.invoices[state.invoices.length - 1];
  });
  if (!inv || alerts.length) throw new Error('generation failed: ' + alerts.join(' | '));
  fs.mkdirSync(OUT, { recursive: true });
  const pdf = path.join(OUT, 'EXAMPLE_physio_invoice.pdf');
  await page.emulateMediaType('print');
  fs.writeFileSync(pdf, await page.pdf({ format: 'A4', printBackground: false, preferCSSPageSize: true }));
  await browser.close();
  execFileSync('pdftoppm', ['-r', '110', '-png', '-singlefile', pdf, path.join(OUT, 'EXAMPLE_physio_invoice')]);
  console.log(JSON.stringify({ number: inv.number, total: inv.total, amountDue: inv.amountDue, lines: inv.lines.length, pdf }));
})().catch(e => { console.error(e); process.exit(1); });
