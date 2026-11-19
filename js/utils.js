'use strict';
/* language helpers and formatting utilities */
const LANGS = [
  ['dr', 'دری', 'fa-AF'],
  ['ps', 'پښتو', 'ps-AF'],
  ['uz', 'اوزبیکچه', 'uz-Arab'],
  ['en', 'English', 'en'],
];
const isLtr = () => LANG === 'en'; // English is shown left-to-right, the other languages right-to-left
const SEP = () => (isLtr() ? ', ' : '، ');
let LANG = 'dr';
try {
  const v = localStorage.getItem('bzk:lang');
  if (T[v]) LANG = v;
} catch (e) {}
const t = (k, ...a) => {
  const v = T[LANG][k];
  return typeof v === 'function' ? v(...a) : (v ?? k);
};
const L = (o) => (o == null ? '' : typeof o === 'string' ? o : o[LANG] || o.dr || '');
const M = (dr, ps, uz) => ({ dr, ps: ps || dr, uz: uz || dr });
const num = (n) => Number(n || 0).toLocaleString(isLtr() ? 'en-US' : 'fa-AF');
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const toNum = (s) =>
  Number(
    String(s || '')
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[^\d]/g, ''),
  ) || 0;
const latinDigits = (s) =>
  String(s || '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ۍ|ې/g, 'ی')
    .replace(/[‌\s]+/g, ' ')
    .trim();
const rid = (n = 10) =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(n)),
    (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32],
  ).join('');
const hashH = (s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
function ago(ts) {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 6e4));
  if (m < 2) return t('now');
  if (m < 60) return t('mins', num(m));
  const h = Math.floor(m / 60);
  if (h < 24) return t('hours', num(h));
  return t('days', num(Math.floor(h / 24)));
}
