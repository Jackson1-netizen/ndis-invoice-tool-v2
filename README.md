# NDIS Invoice Tool v2 (Support work + Physiotherapy)

Copied from [Jackson1-netizen/ndis-invoice-tool](https://github.com/Jackson1-netizen/ndis-invoice-tool) at
`1e96102e092ff2d535ab3519d3144953c48b8c62`. The original repo and its Pages site are left as they are.

## What's different from v1
- **Separate storage.** v2 uses localStorage `ndis-invoice-tool-v2`, IndexedDB `ndis-invoice-disk-v2` and the ledger file
  `invoice-data-v2.json`. It never reads or writes the v1 key, the v1 IndexedDB, `invoice-data.json`, or the
  local 8765 ledger server. To copy v1 data, export a backup from v1 and use 设置 → 导入备份 in v2. That only reads the file.
- **Invoice type selector** on sessions and invoices: Support work / Physiotherapy.
- **Support work** layout and calculations are unchanged. Tests check that its invoice HTML and printed PDF are pixel-identical to v1.
- **Physiotherapy** (NDIS Pricing Schedule 2026-27, National):
  - Bill To is the plan manager (name, optional address, email). The participant name, NDIS number and address are shown beside it.
  - `For: Capacity Building – Improved Daily Living`
  - Direct `15_055_0128_1_3` $183.99/h · NF2F `_NF` · Cancellation `_CA`.
  - Provider travel time goes on its own lines (to the participant / return). It uses the same item `15_055_0128_1_3` with the claim type
    "Provider Travel (_PT)" (PAPL 2025-26 p.23), its own rate capped at $92.00/h, and a maximum of 30 min each way. The amount is
    worked out from the exact minutes (25 min × $92/h = $38.33). Qty is printed with enough decimals (4–6) that qty × unit price, rounded to the cent, equals the amount (25 min → 0.41667 h).
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
