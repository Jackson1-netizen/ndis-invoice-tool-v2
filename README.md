# NDIS Invoice Tool v2 (Support work + Physiotherapy)

Copied from [Jackson1-netizen/ndis-invoice-tool](https://github.com/Jackson1-netizen/ndis-invoice-tool) at
`1e96102e092ff2d535ab3519d3144953c48b8c62`. The original repo and its Pages site are left as they are.

## What's different from v1
- **Separate storage.** v2 uses localStorage `ndis-invoice-tool-v2`, IndexedDB `ndis-invoice-disk-v2` and the ledger file
  `invoice-data-v2.json`. It never reads or writes the v1 key, the v1 IndexedDB, `invoice-data.json`, or the
  v1 local ledger server (port 8765). To copy v1 data, export a backup from v1 and use 设置 → 导入备份 in v2. That only reads the file.
- **Local ledger (optional):** on Jackson's PC, `NDIS Invoice v2 (local).bat` starts a small v2-only server on
  `127.0.0.1:8766` (`GET/PUT /data-v2.json`, file `D:\Grokbot\NDIS Invoices\ledger\invoice-data-v2.json`). The app connects
  to it automatically. In a browser with no v2 data yet, the file is loaded as it is and nothing is merged into it. Port 8765 (v1) is never used.
  The server script and the data stay on the PC; neither is in this repo.
- **Invoice type selector** on sessions and invoices: Support work / Physiotherapy.
- **Support work** layout and calculations are unchanged. Tests check that its invoice HTML and printed PDF are pixel-identical to v1.
- **Physiotherapy** (NDIS Pricing Schedule 2026-27, National):
  - Bill To is the plan manager (name, optional address, email). The participant name, NDIS number and address are shown beside it.
  - `For: Capacity Building – Improved Daily Living`
  - Direct `15_055_0128_1_3` $183.99/h · NF2F `_NF` · Cancellation `_CA`.
  - Provider travel time goes on its own lines (to the participant / return). It uses the same item `15_055_0128_1_3` with the claim type
    "Provider Travel (_PT)" (PAPL 2025-26 p.23), its own rate capped at $92.00/h, and a maximum of 30 min each way. The amount is
    worked out like v1: qty = minutes/60 rounded half-up to 0.01 h, amount = qty × rate rounded to the cent (25 min = 0.42 h × $92 = $38.64).
  - Non-labour travel uses `15_799_0128_1_3` (Provider travel - non-labour costs): km at $0.99/km, plus a parking/tolls line
    at actual cost (1 each, GST free) (PAPL 2025-26 p.23-24). Travel time, km and parking/tolls can only be claimed on Direct service.
  - Each line shows the item number, service date, start–end time, description, claim type, qty, unit price, GST free and amount.
  - Totals are Subtotal, Total GST, Invoice total, Payments and Amount Due, followed by "No GST charged: supplier not registered for GST."
  - The invoice uses the same `INV-` number sequence as support work. The title is always `INVOICE`. No AHPRA number is printed.
  - Settings won't save, and an invoice won't be generated, if any price is above the NDIS cap, if travel time is over 30 min each way, or if session times overlap (travel windows included).

## Tests
```
cd tests && npm install && node run.js          # needs Chrome at /usr/bin/google-chrome (or CHROME_PATH)
node make-sample.js                              # rebuilds sample/EXAMPLE_physio_invoice.pdf/.png (EXAMPLE data)
```
`run.js` compares v1 against `V1_HTML` (a checkout of v1 @ 1e96102). If `REAL_LEDGER` points to a local v1 ledger, it also
compares the stored INV-0014 with `REF_PNG`. That ledger has real client data, so it is never committed.

## Same-day rule (HARD block)

One participant cannot have **support work and physiotherapy on the same date**, even with no time overlap.
The app checks sessions (open or invoiced) and non-void invoices in the v2 ledger:

- Session form: picking a client/date/type that clashes shows a popup and a red note
  (`這一天已有 support work，不能加物理治療` / `這一天已有物理治療，不能加 support work`, plus English) and disables **保存 Session**.
- Invoice tab: a clashing session cannot be ticked, and **生成 Invoice** refuses it.

Command-line check (Python 3, standard library only; opens both ledgers read-only):

```
python tools\check_same_day.py
python tools\check_same_day.py --client "<name or NDIS number>" --date 2026-11-17 --type physio
```

Defaults: v2 ledger `D:\Grokbot\NDIS Invoices\ledger\invoice-data-v2.json`, v1 ledger `%USERPROFILE%\.openjarvis\invoice-data.json`.
Exit code 0 = OK, 2 = conflict, 1 = error.

## Default NF2F report line (physio)

When a new **Direct** physiotherapy session is saved, the app also adds a separate NF2F session
(item `15_055_0128_1_3_NF`, default 15 min = 0.25 h × $183.99, "Report writing") starting right after the
return travel. Minutes and text are editable on the form; untick 「同时加报告 NF2F」 to skip it. The report is a
normal session, so it can be edited or deleted before invoicing. Editing an existing session never adds one.

## Subcontractor Physio (invoice to a company)

A third invoice type for physio work done as a contractor for another provider. The invoice is billed to the
company, not to an NDIS participant: no NDIS number, item codes or plan manager on the sheet.

- **Settings → 公司**: add each company once (name, ABN, address, phone, email, $/hour, payment days (default 7),
  GST % (default 0), default title INVOICE or TAX INVOICE). A company with sessions or invoices cannot be deleted.
- **加新的 Session → Invoice 类型 = Subcontractor Physio**: pick the company, type the client's name (as printed),
  pick one of three description presets (editable), minutes default 75, date and start time.
- **出 Invoice → Subcontractor Physio**: pick the company, tick sessions. Default = one invoice per client, numbered
  consecutively from the shared INV sequence. Tick 「合并成一张」 to put all ticked sessions on one invoice.
  Line amount = $/hour × minutes / 60. An empty price blocks issuing.
- These sessions are **not** part of the NDIS same-day rule (app and `tools/check_same_day.py` both ignore them),
  but a time overlap with any other session is still blocked in both directions.
