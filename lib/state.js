// Shared rules for the coffee data: what a valid state looks like and how one change is applied.
export const OPEN = { vol: 1, half: 1, laag: 1, geen: 1 };
export const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const blank = () => ({ checks: {}, stock: [], deals: [], buys: [], settings: { maxBags: 8, minBags: 2 } });
export const nameList = t => [...new Set((Array.isArray(t) ? t : String(t || '').split(/[\n,;]+/)).map(s => String(s).trim().slice(0, 30)).filter(Boolean))].slice(0, 40);

export function cleanDeal(d) {
  if (!d || !d.product || !(+d.grams > 0) || !(+d.price > 0)) return null;
  return { id: String(d.id || uid()).slice(0, 40), store: String(d.store || 'Anders').slice(0, 30), product: String(d.product).slice(0, 80), grams: +d.grams, price: +d.price,
    normal: +d.normal > 0 ? +d.normal : 0, deal: String(d.deal || '').slice(0, 30), qty: Math.max(1, Math.round(+d.qty) || 1), until: isDay(d.until) ? d.until : '' };
}
export function clean(o) {
  const b = blank(); if (!o || typeof o !== 'object') return b;
  if (o.checks && typeof o.checks === 'object') for (const k in o.checks) { const c = o.checks[k]; if (isDay(k) && c) b.checks[k] = { date: k, bags: Math.min(99, Math.max(0, Math.round(+c.bags) || 0)), open: OPEN[c.open] ? c.open : 'geen', at: String(c.at || '').slice(0, 40) }; }
  if (Array.isArray(o.stock)) o.stock.slice(0, 200).forEach(i => { if (i && i.name) b.stock.push({ id: String(i.id || uid()).slice(0, 40), name: String(i.name).slice(0, 40), qty: Math.min(9999, Math.max(0, Math.round(+i.qty) || 0)), min: Math.min(9999, Math.max(0, Math.round(+i.min) || 0)) }); });
  if (Array.isArray(o.deals)) o.deals.slice(0, 200).forEach(d => { const c = cleanDeal(d); if (c) b.deals.push(c); });
  if (Array.isArray(o.buys)) o.buys.slice(0, 5000).forEach(x => { if (x && x.who && +x.amount >= 0 && isDay(x.date)) b.buys.push({ id: String(x.id || uid()).slice(0, 40), who: String(x.who).slice(0, 30), amount: Math.round(+x.amount * 100) / 100, date: x.date, note: String(x.note || '').slice(0, 60) }); });
  if (o.settings) { const mx = Math.round(+o.settings.maxBags), mn = Math.round(+o.settings.minBags); if (mx >= 1 && mx <= 30) b.settings.maxBags = mx; if (mn >= 0 && mn <= 30) b.settings.minBags = mn; }
  // keep roughly two years of daily checks
  const keys = Object.keys(b.checks).sort(); if (keys.length > 750) keys.slice(0, keys.length - 750).forEach(k => delete b.checks[k]);
  return b;
}
export function applyOp(s, op) {
  if (!op || typeof op !== 'object') return s;
  switch (op.t) {
    case 'check': if (isDay(op.date) && op.data) s.checks[op.date] = op.data; break;
    case 'stockAdd': if (op.item && !s.stock.some(i => i.id === op.item.id)) s.stock.push(Object.assign({}, op.item)); break;
    case 'stockAdj': { const it = s.stock.find(i => i.id === op.id); if (it) it.qty = Math.max(0, it.qty + (Math.round(+op.delta) || 0)); break; }
    case 'stockDel': s.stock = s.stock.filter(i => i.id !== op.id); break;
    case 'dealAdd': if (op.deal && !s.deals.some(d => d.id === op.deal.id)) s.deals.push(Object.assign({}, op.deal)); break;
    case 'dealDel': s.deals = s.deals.filter(d => d.id !== op.id); break;
    case 'buyAdd': if (op.buy && !s.buys.some(b => b.id === op.buy.id)) s.buys.push(Object.assign({}, op.buy)); break;
    case 'buyDel': s.buys = s.buys.filter(b => b.id !== op.id); break;
    case 'settings': if (op.patch && typeof op.patch === 'object') Object.assign(s.settings, op.patch); break;
    case 'replace': return clean(op.state);
  }
  return s;
}
export function cleanConfig(c) {
  c = c && typeof c === 'object' ? c : {};
  const people = nameList(c.people), guests = nameList(c.guests).filter(n => !people.includes(n));
  const logo = typeof c.logo === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(c.logo) && c.logo.length <= 600000 ? c.logo : '';
  return { people, guests, logo };
}
