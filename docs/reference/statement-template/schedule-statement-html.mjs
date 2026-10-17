// Print-ready SCHEDULE STATEMENT template (HTML + CSS) for Belgrove.
// Usage: html = renderScheduleStatementHtml(model, assets, fmt) then HTML -> PDF
// with headless Chromium (page.pdf({ format:'A4', printBackground:true, preferCSSPageSize:true })).
// All numbers and dates arrive already computed by schedule-statement.ts /
// schedule-statement-model.ts. This file only lays them out.
//
// This is the CLIENT-FACING schedule document (one row per installment, with
// its status). It is deliberately separate from the ledger Statement of
// Account, which stays for staff/internal ledger viewing.
//
// model:  see schedule-statement-html.d.mts
// assets: { logoSrc, stampSrc?, qrSvg?, fontFamily?, fontFaceCss? }
// fmt:    { money(n) -> "₦6,500,000" ; cell(n) -> "6,500,000" / "-" when undefined }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderScheduleStatementHtml(model, assets, fmt) {
  const m = model;
  const draft = !!m.isDraft;
  const fontFamily = assets.fontFamily || "'Noto Sans'";
  const anchorFooter = !draft && m.rows.length <= 6;

  const rows = m.rows.map((r) => `
      <tr>
        <td class="d">${esc(r.dueDate)}</td>
        <td class="det"><div class="l1">${esc(r.label)}</div></td>
        <td class="n">${fmt.cell(r.scheduled)}</td>
        <td class="n">${fmt.cell(r.received)}</td>
        <td class="st">${esc(r.status)}</td>
      </tr>`).join('');

  const meta = [
    `<div>ACCOUNT: ${esc(m.accountRef)}</div>`,
    !draft && m.number ? `<div>STATEMENT: ${esc(m.number)}</div>` : '',
    `<div>GENERATED: ${esc(m.generatedOn)}</div>`,
  ].join('');

  const nextDue = m.nextDue
    ? `<div class="next"><span class="lbl">NEXT PAYMENT DUE</span><span class="v">${fmt.money(m.nextDue.amount)}</span><span class="when">${esc(m.nextDue.label)} · due ${esc(m.nextDue.dueDate)}</span></div>`
    : `<div class="next settled"><span class="lbl">PLAN STATUS</span><span class="v">No further payments due</span><span class="when">Plan fully paid${m.settledOn ? ` on ${esc(m.settledOn)}` : ''}</span></div>`;

  const footer = draft ? `
    <p class="legal">This draft is for internal review and is not an issued statement.</p>` : `
    <section class="foot">
      <div class="auth">
        <div class="lbl">AUTHORIZED BY BELGROVE</div>
        <div class="stampwrap">
          ${assets.stampSrc ? `<img class="stamp" src="${assets.stampSrc}" alt="">` : ''}
          <div class="issued">Date: ${esc(m.generatedOn)}<br>Issued by Belgrove Homes accounts</div>
        </div>
      </div>
      <div class="qr">${assets.qrSvg || ''}<span>SCAN TO VERIFY</span></div>
    </section>
    <p class="legal">This schedule statement lists the agreed payment plan and the payments confirmed by Belgrove Homes accounts as at the date shown. It is not a demand for payment. Property allocation is subject to completion of the agreed plan. Keep this statement with your receipts.</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Schedule Statement ${esc(m.accountRef)}${draft ? ' (DRAFT)' : ''}</title>
<meta name="generator" content="${esc(m.layoutVersion)}">
<style>
${assets.fontFaceCss || ''}
@page { size: A4; margin: 56px 56px 60px 56px;
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 9px ${fontFamily}; color:#A39A87; }
  ${draft ? `@bottom-left { content: "${esc(m.layoutVersion)} draft"; font: 8px ${fontFamily}; color:#A39A87; }` : ''} }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:${fontFamily};color:#1C2B20;font-size:11px;line-height:1.4;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{display:flex;flex-direction:column;${anchorFooter ? 'min-height:1003px;' : ''}}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:2px solid #C89B3C}
.brand{display:flex;gap:14px;align-items:center}
.logo{height:44px;width:auto;display:block}
.co{font-weight:700;font-size:15px;letter-spacing:.01em}
.addr{font-size:10.5px;color:#6B6252;margin-top:3px;max-width:380px;line-height:1.4}
.contact{text-align:right;font-size:10.5px;line-height:1.6}
.titlebar{display:flex;justify-content:space-between;align-items:flex-end;margin:24px 0 18px}
.draftlbl{color:#A8402B;font-weight:700;font-size:13px;letter-spacing:.06em}
h1{margin:0;font-size:27px;font-weight:700;line-height:1.15}
.meta{text-align:right;font-size:11px;color:#6B6252;line-height:1.7}
.client{display:flex;gap:20px;margin-bottom:16px}
.client>div:first-child{flex:1.3}.client>div:last-child{flex:1}
.lbl{font-size:9.5px;letter-spacing:.09em;font-weight:600;color:#6B6252;margin-bottom:5px}
.cname{font-size:15px;font-weight:600;margin-bottom:3px}
.pname{font-size:13px;font-weight:600;margin-bottom:3px}
.small{font-size:11px;color:#6B6252;line-height:1.55}
.summary{display:flex;border:1px solid #E4D8C1;border-radius:6px;margin-bottom:20px;overflow:hidden}
.sum{flex:1;padding:12px 14px;border-right:1px solid #E4D8C1;background:#FDFBF7}
.sum:last-child{border-right:none;background:#16281D;color:#fff}
.sum .lbl{margin-bottom:3px}.sum:last-child .lbl{color:#E8C77A}
.sum .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11px}
col.cd{width:78px}col.cn{width:92px}col.cs{width:186px}
thead{display:table-header-group}
thead tr{background:#16281D}
thead th{background:transparent;color:#E8C77A;font-size:10.5px;font-weight:600;text-align:left;padding:9px 10px}
thead th.n{text-align:right}
tr{break-inside:avoid;page-break-inside:avoid}
td{padding:9px 10px;border-bottom:1px solid #E4D8C1;vertical-align:top;font-variant-numeric:tabular-nums}
tbody tr:nth-child(even) td{background:#FBF7EF}
td.n{text-align:right;white-space:nowrap}
td.st{font-size:10.5px;color:#4A4336}
.det .l1{font-size:11px}
tbody tr.tot td{background:#16281D;color:#E8C77A;font-weight:700;border-bottom:none}
.next{display:flex;align-items:baseline;gap:10px;margin:16px 0 6px;padding:12px 14px;border:1px solid #E4D8C1;border-radius:6px;background:#FDFBF7;break-inside:avoid}
.next .lbl{margin:0}.next .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.next .when{font-size:10.5px;color:#6B6252}
.next.settled .v{color:#1F6B3E}
.spacer{flex:1;min-height:24px}
.foot{display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid #E4D8C1;padding-top:16px;break-inside:avoid;margin-top:${anchorFooter ? '0' : '28px'}}
.stampwrap{display:flex;align-items:flex-end;gap:14px;margin-top:6px}
.stamp{width:148px;height:auto;display:block}
.issued{font-size:10px;color:#6B6252;line-height:1.6;white-space:nowrap}
.qr{text-align:center}.qr svg{width:104px;height:104px;display:block}
.qr span{display:block;font-size:9px;letter-spacing:.04em;color:#6B6252;margin-top:5px}
.legal{font-size:9px;color:#6B6252;line-height:1.5;margin:14px 0 0}
</style></head><body>
<div class="wrap">
  <header class="hdr">
    <div class="brand">
      <img class="logo" src="${assets.logoSrc}" alt="">
      <div><div class="co">${esc(m.company.name)}</div><div class="addr">${esc(m.company.addressLine)}</div></div>
    </div>
    <div class="contact">${esc(m.company.website)}<br>${esc(m.company.email)}<br>${esc(m.company.phone)}</div>
  </header>
  <div class="titlebar">
    <div>${draft ? '<div class="draftlbl">DRAFT, NOT ISSUED</div>' : ''}<h1>SCHEDULE STATEMENT</h1></div>
    <div class="meta">${meta}</div>
  </div>
  <div class="client">
    <div><div class="lbl">CLIENT</div><div class="cname">${esc(m.client.name)}</div>
      <div class="small">${[m.client.phone, m.client.email].filter(Boolean).map(esc).join('<br>')}</div></div>
    <div><div class="lbl">PROPERTY</div><div class="pname">${esc(m.property.estate)}</div>
      <div class="small">${esc(m.property.unitType)}<br>${esc(m.property.sku)} · ${m.property.plots} plot${m.property.plots === 1 ? '' : 's'}</div></div>
  </div>
  <div class="summary">
    <div class="sum"><div class="lbl">TOTAL SCHEDULED</div><div class="v">${fmt.money(m.totals.scheduled)}</div></div>
    <div class="sum"><div class="lbl">TOTAL RECEIVED</div><div class="v">${fmt.money(m.totals.received)}</div></div>
    <div class="sum"><div class="lbl">${m.totals.outstanding < 0 ? 'CREDIT BALANCE' : `OUTSTANDING AS AT ${esc(m.asOf)}`}</div><div class="v">${fmt.money(Math.abs(m.totals.outstanding))}</div></div>
  </div>
  <table>
    <colgroup><col class="cd"><col><col class="cn"><col class="cn"><col class="cs"></colgroup>
    <thead><tr><th>Due date</th><th>Installment</th><th class="n">Scheduled (₦)</th><th class="n">Received (₦)</th><th>Status</th></tr></thead>
    <tbody>${rows}
      <tr class="tot"><td colspan="2">Totals</td><td class="n">${fmt.cell(m.totals.scheduled || undefined)}</td><td class="n">${fmt.cell(m.totals.received || undefined)}</td><td></td></tr>
    </tbody>
  </table>
  ${nextDue}
  <div class="spacer"></div>
  ${footer}
</div>
</body></html>`;
}
