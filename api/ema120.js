import fetch from 'node-fetch';

// Vercel serverless — GET /api/ema120?tf=day|week|month&wl=TICKER,...
// Returns 120 EMA analysis for watchlist + small cap tickers

const SC_TICKERS = [
  'MARA','RIOT','CLSK','HUT','BITF','WULF','CIFR','BTBT','CORZ',
  'PLUG','NKLA','GOEV','WKHS','MULN','BLNK','FCEL','HYLN',
  'OCGN','NVAX','AGEN','CTXR','ABUS','SAVA',
  'BB','NOK','BKKT','OPEN','PSFE','MVIS','INPX','GFAI',
  'TLRY','SNDL','CRON','ACB',
  'AMC','GME',
  'CLOV','SPCE','GENI','IDEX','KULR','ENVX',
  'SOS','EBON','NCTY','LIZI','CNET','CXAI',
  'INDO','IMPP','ATER','CTRM','FFIE','XELA','PSTV','CIDM',
  'VERB','GREE','MNMD','ONDS','JMIA',
  'WINT','STTK','VLNX','SENS','NVOS','HYMC','ORBC',
];

const TF = {
  day:   { mult: 1, span: 'day',   daysBack: 210  },
  week:  { mult: 1, span: 'week',  daysBack: 1250 },
  month: { mult: 1, span: 'month', daysBack: 4500 },
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

function analyze(bars) {
  if (!bars || bars.length < 122) return null;
  const closes = bars.map(b => b.c);
  const ema = calcEMA(closes, 120);
  const n = closes.length;
  const price = closes[n - 1], e = ema[n - 1], prevP = closes[n - 2], prevE = ema[n - 2];
  if (e == null || prevE == null) return null;
  return {
    price:        +price.toFixed(2),
    ema120:       +e.toFixed(3),
    above:        price > e,
    pct:          +((price - e) / e * 100).toFixed(2),
    crossedAbove: prevP <= prevE && price > e,
    crossedBelow: prevP >= prevE && price < e,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const base = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

  const tf  = req.query.tf || 'day';
  const cfg = TF[tf];
  if (!cfg) return res.status(400).json({ error: 'Invalid tf' });

  const wlTickers  = (req.query.wl || '').split(',').filter(Boolean);
  const scSet      = new Set(SC_TICKERS);
  const wlSet      = new Set(wlTickers);
  const allTickers = [...new Set([...wlTickers, ...SC_TICKERS])];

  const now      = new Date();
  const toDate   = now.toISOString().slice(0, 10);
  const fromDt   = new Date(now);
  fromDt.setDate(fromDt.getDate() - cfg.daysBack);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const CONCURRENCY = 40;
  const out = [];
  for (let i = 0; i < allTickers.length; i += CONCURRENCY) {
    const batch = allTickers.slice(i, i + CONCURRENCY);
    const rows  = await Promise.all(batch.map(async ticker => {
      try {
        const url = `${base}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${cfg.mult}/${cfg.span}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=300&apiKey=${key}`;
        const d   = await fetch(url).then(r => r.json());
        const a   = analyze(d.results || []);
        if (!a) return null;
        return { t: ticker, isWL: wlSet.has(ticker), isSC: scSet.has(ticker), ...a };
      } catch { return null; }
    }));
    out.push(...rows.filter(Boolean));
  }

  return res.status(200).json({ results: out, tf, updatedAt: toDate });
}
