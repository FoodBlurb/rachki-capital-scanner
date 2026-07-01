import fetch from 'node-fetch';

// Vercel serverless – GET /api/ema120?tf=day|week|month&wl=TICKER,...
// EMA periods: day=120, week=120, month=50 (API only has ~60 months history)

const SC_TICKERS = [
  // Crypto miners
  'MARA','RIOT','CLSK','HUT','BITF','WULF','CORZ',
  // AI / quantum / growth
  'IONQ','RGTI','QUBT','KULR','SOUN','ENVX',
  // Aerospace / EV / clean energy
  'ACHR','JOBY','BLNK','PLUG','FCEL','NKLA',
  // Biotech
  'NVAX','OCGN','ABUS','MNMD',
  // Retail / meme / cannabis
  'GME','AMC','TLRY','SNDL',
  // Tech / misc
  'MVIS','BB','OPEN','SPCE',
];

const TF = {
  day:   { mult: 1, span: 'day',   daysBack: 210,  period: 120 },
  week:  { mult: 1, span: 'week',  daysBack: 1250, period: 120 },
  month: { mult: 1, span: 'month', daysBack: 4500, period: 50  },
};

function calcEMA(prices, period) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < prices.length; i++) { e = prices[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function analyze(bars, period) {
  if (!bars || bars.length < period + 2) return null;
  const closes = bars.map(b => b.c);
  const ema = calcEMA(closes, period);
  const n = closes.length;
  const price = closes[n-1], e = ema[n-1], prevP = closes[n-2], prevE = ema[n-2];
  if (e == null || prevE == null) return null;
  return {
    price: +price.toFixed(2), ema120: +e.toFixed(3), period,
    above: price > e, pct: +((price - e) / e * 100).toFixed(2),
    crossedAbove: prevP <= prevE && price > e,
    crossedBelow: prevP >= prevE && price < e,
  };
}

// Fetch all bars with pagination support (Massive API paginates weekly/monthly)
async function fetchAllBars(base, key, ticker, cfg, fromDate, toDate) {
  const allBars = [];
  let url = `${base}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${cfg.mult}/${cfg.span}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
  let pages = 0;
  while (url && pages < 10) {
    const d = await fetch(url).then(r => r.json());
    if (d.results) allBars.push(...d.results);
    url = d.next_url ? `${d.next_url}&apiKey=${key}` : null;
    pages++;
  }
  return allBars;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const base = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });
  const tf = req.query.tf || 'day';
  const cfg = TF[tf];
  if (!cfg) return res.status(400).json({ error: 'Invalid tf' });
  const wlTickers  = (req.query.wl || '').split(',').filter(Boolean);
  const scSet = new Set(SC_TICKERS), wlSet = new Set(wlTickers);
  const allTickers = [...new Set([...wlTickers, ...SC_TICKERS])];
  const now = new Date(), toDate = now.toISOString().slice(0, 10);
  const fromDt = new Date(now);
  fromDt.setDate(fromDt.getDate() - cfg.daysBack);
  const fromDate = fromDt.toISOString().slice(0, 10);
  const CONCURRENCY = 40, out = [];
  for (let i = 0; i < allTickers.length; i += CONCURRENCY) {
    const batch = allTickers.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(batch.map(async ticker => {
      try {
        const bars = await fetchAllBars(base, key, ticker, cfg, fromDate, toDate);
        const a = analyze(bars, cfg.period);
        if (!a) return null;
        return { t: ticker, isWL: wlSet.has(ticker), isSC: scSet.has(ticker), ...a };
      } catch { return null; }
    }));
    out.push(...rows.filter(Boolean));
  }
  return res.status(200).json({ results: out, tf, period: cfg.period, updatedAt: toDate });
}
