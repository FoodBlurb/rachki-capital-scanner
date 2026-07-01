import fetch from 'node-fetch';

const BASE = process.env.MASSIVE_API_BASE;
const KEY  = process.env.MASSIVE_API_KEY;

function calcEMA13(closes) {
  if (closes.length < 13) return null;
  const k = 2 / 14;
  let ema = closes.slice(0, 13).reduce((a, b) => a + b, 0) / 13;
  for (let i = 13; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

async function fetchBars(ticker, mult, span, fromDate, toDate) {
  const url = BASE+'/v2/aggs/ticker/'+ticker+'/range/'+mult+'/'+span+'/'+fromDate+'/'+toDate+'?adjusted=true&sort=asc&limit=200&apiKey='+KEY;
  const r = await fetch(url);
  const d = await r.json();
  return d.results || [];
}

function getDateRange(tf) {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  let from;
  if (tf === 'daily') {
    const d = new Date(now); d.setDate(d.getDate() - 60);
    from = d.toISOString().slice(0, 10);
  } else if (tf === 'weekly') {
    const d = new Date(now); d.setDate(d.getDate() - 365);
    from = d.toISOString().slice(0, 10);
  } else {
    const d = new Date(now); d.setFullYear(d.getFullYear() - 5);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const tf = req.query.tf || 'daily';
  const wl = req.query.wl || '';
  const sc = req.query.sc || '';

  if (!['daily','weekly','monthly'].includes(tf)) {
    return res.status(400).json({ error: 'Invalid tf. Use daily, weekly, or monthly.' });
  }

  const tickers = [...new Set([
    ...wl.split(',').map(t => t.trim()).filter(Boolean),
    ...sc.split(',').map(t => t.trim()).filter(Boolean),
  ])];

  if (!tickers.length) return res.status(400).json({ error: 'No tickers' });

  const mult = 1;
  const span = tf === 'daily' ? 'day' : tf === 'weekly' ? 'week' : 'month';
  const { from, to } = getDateRange(tf);

  const wlSet = new Set(wl.split(',').map(t => t.trim()).filter(Boolean));
  const scSet = new Set(sc.split(',').map(t => t.trim()).filter(Boolean));

  const results = await Promise.all(tickers.map(async (t) => {
    try {
      const bars = await fetchBars(t, mult, span, from, to);
      if (bars.length < 14) return null;
      const closes = bars.map(b => b.c);
      const ema13 = calcEMA13(closes);
      if (ema13 == null) return null;
      const price = closes[closes.length - 1];
      const pct = ((price - ema13) / ema13) * 100;
      return {
        t,
        price: +price.toFixed(2),
        ema13: +ema13.toFixed(2),
        pct: +pct.toFixed(3),
        above: price > ema13,
        isWL: wlSet.has(t),
        isSC: scSet.has(t),
      };
    } catch(e) { return null; }
  }));

  const valid = results.filter(Boolean);
  const above = valid.filter(r => r.above).sort((a, b) => b.pct - a.pct);
  const below = valid.filter(r => !r.above).sort((a, b) => a.pct - b.pct);

  return res.status(200).json({
    tf, above, below,
    total: valid.length,
    updatedAt: new Date().toISOString().slice(0, 10),
  });
}
