// Print-ready Company Sales Ledger template (HTML + CSS) for Belgrove.
// Usage: html = renderCompanyLedgerHtml(model, assets, fmt)  then HTML -> PDF with
// headless Chromium (page.pdf({ printBackground:true, preferCSSPageSize:true })).
// Landscape A4: the table has eight columns. Every number and date arrives already
// computed by the ledger model — this file only lays them out, and never recomputes a total.
//
// model:  CompanyLedgerModel (see src/lib/company-ledger.ts)
// assets: { logoSrc, fontFamily?, fontFaceCss? }
//   fontFamily default "'Noto Sans'". fontFaceCss must @font-face the embedded Noto
//   Sans files. Do NOT add fallback families in production.
// fmt:    { money(n) -> "₦6,500,000" or "-₦3,000,000", cell(n) -> "6,500,000" / "-" when undefined }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderCompanyLedgerHtml(model, assets, fmt) {
  const m = model;
  const fontFamily = assets.fontFamily || "'Noto Sans'";

  const bodyRows = m.rows.map((r) => {
    const cls = [r.correction ? 'corr' : '', r.pending ? 'pend' : '', r.isOpening ? 'open' : ''].filter(Boolean).join(' ');
    return `
      <tr${cls ? ` class="${cls}"` : ''}>
        <td class="d">${esc(r.date)}</td>
        <td class="acct">${r.accountRef ? `<div class="l1">${esc(r.accountRef)}</div>` : ''}${r.clientName ? `<div class="l2">${esc(r.clientName)}</div>` : ''}</td>
        <td class="det">${esc(r.entry)}</td>
        <td class="ref">${esc(r.reference)}</td>
        <td class="n">${fmt.cell(r.debit)}</td>
        <td class="n">${fmt.cell(r.credit)}</td>
        <td class="n">${r.accountBalance === null ? '-' : fmt.money(r.accountBalance)}</td>
        <td class="n strong">${fmt.money(r.totalOwed)}</td>
      </tr>`;
  }).join('');

  const outstanding = m.outstandingByAccount.map((a) => `
      <tr>
        <td class="l1">${esc(a.accountRef)}</td>
        <td>${esc(a.clientName)}</td>
        <td class="n">${fmt.money(a.contractPrice)}</td>
        <td class="n">${fmt.money(a.paid)}</td>
        <td class="n strong">${fmt.money(a.outstanding)}</td>
      </tr>`).join('');

  const meta = [
    `<div>PERIOD: ${esc(m.period.from || 'All time')}${m.period.to ? ` – ${esc(m.period.to)}` : ''}</div>`,
    `<div>GENERATED: ${esc(m.generatedOn)}</div>`,
    `<div>${m.accounts} account${m.accounts === 1 ? '' : 's'} · ${m.rowCount} row${m.rowCount === 1 ? '' : 's'}</div>`,
    m.confirmedOnly ? `<div>CONFIRMED PAYMENTS ONLY</div>` : '',
  ].join('');

  const warnings = (m.warnings && m.warnings.length)
    ? `<div class="notes"><b>NOTES</b><ul>${m.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Company Sales Ledger</title>
<meta name="generator" content="${esc(m.layoutVersion)}">
<style>
${assets.fontFaceCss || ''}
@page { size: A4 landscape; margin: 12mm 12mm 14mm 12mm;
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 9px ${fontFamily}; color:#A39A87; } }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:${fontFamily};color:#1C2B20;font-size:10.5px;line-height:1.4;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:2px solid #C89B3C}
.brand{display:flex;gap:14px;align-items:center}
.logo{height:40px;width:auto;display:block}
.co{font-weight:700;font-size:15px;letter-spacing:.01em}
.addr{font-size:10.5px;color:#6B6252;margin-top:3px;max-width:420px;line-height:1.4}
.contact{text-align:right;font-size:10.5px;line-height:1.6}
.titlebar{display:flex;justify-content:space-between;align-items:flex-end;margin:16px 0 10px}
h1{margin:0;font-size:22px;font-weight:700;line-height:1.15}
.legend{font-size:10px;color:#6B6252;margin-top:4px}
.meta{text-align:right;font-size:10.5px;color:#6B6252;line-height:1.7}
.summary{display:flex;border:1px solid #E4D8C1;border-radius:6px;margin:12px 0 14px;overflow:hidden}
.sum{flex:1;padding:10px 14px;border-right:1px solid #E4D8C1;background:#FDFBF7}
.sum:last-child{border-right:none;background:#16281D;color:#fff}
.lbl{font-size:9.5px;letter-spacing:.09em;font-weight:600;color:#6B6252;margin-bottom:4px}
.sum:last-child .lbl{color:#E8C77A}
.sum .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10.5px}
col.cd{width:20mm}col.ca{width:42mm}col.ce{width:36mm}col.cr{width:auto}col.cn{width:26mm}col.cb{width:30mm}col.ct{width:34mm}
thead{display:table-header-group}
thead tr{background:#16281D}
thead th{color:#E8C77A;font-size:10px;font-weight:600;text-align:left;padding:8px 7px}
thead th.n{text-align:right}
tr{break-inside:avoid;page-break-inside:avoid}
td{padding:7px;border-bottom:1px solid #E4D8C1;vertical-align:top;font-variant-numeric:tabular-nums}
tbody tr:nth-child(even) td{background:#FBF7EF}
td.n{text-align:right;white-space:nowrap}
td.strong{font-weight:700}
td .l1{font-size:10.5px}
td .l2{font-size:9.5px;color:#6B6252;margin-top:2px;overflow-wrap:anywhere}
td.ref{color:#6B6252;overflow-wrap:anywhere}
tr.corr td{color:#8C8375;background:#F4F1EA !important;font-style:italic}
tr.pend td{color:#8C8375;background:#F7F3E8 !important}
tr.open td{background:#F7F1E2 !important;font-weight:600}
tbody tr.tot td{background:#16281D;color:#E8C77A;font-weight:700;border-bottom:none}
.notes{border:1px solid #E4D8C1;background:#FDFBF7;border-radius:6px;padding:8px 12px;margin-top:14px;font-size:10px;color:#6B6252;break-inside:avoid}
.notes ul{margin:4px 0 0 16px;padding:0}
h2{font-size:13px;font-weight:700;margin:22px 0 8px;break-after:avoid}
.ohead{background:#16281D}
.ohead th{color:#E8C77A}
</style></head><body>
  <header class="hdr">
    <div class="brand">
      <img class="logo" src="${assets.logoSrc}" alt="">
      <div><div class="co">${esc(m.company.name)}</div><div class="addr">${esc(m.company.addressLine)}</div></div>
    </div>
    <div class="contact">${esc(m.company.website)}<br>${esc(m.company.email)}<br>${esc(m.company.phone)}</div>
  </header>
  <div class="titlebar">
    <div>
      <h1>COMPANY SALES LEDGER</h1>
      <div class="legend">Debit: a sale recorded (client owes). Credit: a payment received. Amounts in Naira (₦).</div>
    </div>
    <div class="meta">${meta}</div>
  </div>
  <div class="summary">
    <div class="sum"><div class="lbl">TOTAL SALES</div><div class="v">${fmt.money(m.summary.totalSales)}</div></div>
    <div class="sum"><div class="lbl">TOTAL RECEIVED</div><div class="v">${fmt.money(m.summary.totalReceived)}</div></div>
    <div class="sum"><div class="lbl">TOTAL OWED TO US AS AT ${esc(m.asOf)}</div><div class="v">${fmt.money(m.summary.totalOwed)}</div></div>
  </div>
  <table>
    <colgroup><col class="cd"><col class="ca"><col class="ce"><col class="cr"><col class="cn"><col class="cn"><col class="cb"><col class="ct"></colgroup>
    <thead><tr>
      <th>Date</th><th>Account</th><th>Entry</th><th>Reference</th>
      <th class="n">Debit</th><th class="n">Credit</th><th class="n">Account balance</th><th class="n">Total owed to us</th>
    </tr></thead>
    <tbody>${bodyRows}
      <tr class="tot"><td colspan="4">Totals</td><td class="n">${fmt.cell(m.totals.debit || undefined)}</td><td class="n">${fmt.cell(m.totals.credit || undefined)}</td><td></td><td class="n">${fmt.money(m.totals.owed)}</td></tr>
    </tbody>
  </table>
  ${warnings}
  <h2>Outstanding by account</h2>
  <table>
    <colgroup><col style="width:36mm"><col><col class="cn"><col class="cn"><col class="ct"></colgroup>
    <thead class="ohead"><tr><th>Account</th><th>Client</th><th class="n">Contract price</th><th class="n">Paid</th><th class="n">Outstanding</th></tr></thead>
    <tbody>${outstanding}
      <tr class="tot"><td colspan="2">Totals</td><td class="n">${fmt.money(m.outstandingTotals.contractPrice)}</td><td class="n">${fmt.money(m.outstandingTotals.paid)}</td><td class="n">${fmt.money(m.outstandingTotals.outstanding)}</td></tr>
    </tbody>
  </table>
</body></html>`;
}
