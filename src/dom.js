// Shared DOM helpers used by every panel renderer. Kept thin and free of
// dashboard-specific knowledge so panels don't have to reach back into the
// inline block to render cells / set text / tag columns.

(function () {
  'use strict';

  function safeText(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number' && !isFinite(v)) return v === Infinity ? '∞' : '—';
    return v;
  }

  // Build a <td> with text-only content. Used everywhere row data
  // includes API-derived strings — textContent prevents an indexer
  // string ever reaching innerHTML.
  function appendCell(tr, text, classes = []) {
    const td = document.createElement('td');
    classes.filter(Boolean).forEach(c => td.classList.add(c));
    td.textContent = (text === null || text === undefined) ? '—' : String(text);
    tr.appendChild(td);
    return td;
  }

  // Tag each <td> with data-label matching its column header so the
  // <600px stacked-card table CSS can surface the label via ::before
  // pseudo-element. Skips cells with colspan (footer notes).
  function tagCells(tbodyId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const table = tbody.closest('table');
    if (!table || !table.tHead || !table.tHead.rows.length) return;
    const headers = [...table.tHead.rows[0].cells].map(th => th.textContent.trim());
    tbody.querySelectorAll('tr').forEach(tr => {
      [...tr.children].forEach((td, i) => {
        if (headers[i] && !td.hasAttribute('colspan')) {
          td.setAttribute('data-label', headers[i]);
        }
      });
    });
  }

  function updateElement(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = safeText(value);
  }

  // Set text + apply profit/loss class for currency-coded cells.
  function updateMetric(id, value, isPositive = true) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = safeText(value);
      el.className = isPositive ? 'metric-value mono profit' : 'metric-value mono loss';
    }
  }

  window.AppDom = { safeText, appendCell, tagCells, updateElement, updateMetric };
})();
