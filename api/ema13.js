import fetch from 'node-fetch';

const SC_TICKERS = [
  'MARA','RIOT','CLSK','HUT','BITF','WULF','CORZ',
  'IONQ','RGTI','QUBT','KULR','SOUN','ENVX',
  'ACHR','JOBY','BLNK','PLUG','FCEL','NKLA',
  'NVAX','OCGN','ABUS','MNMD',
  'GME','AMC','TLRY','SNDL',
  'MVIS','BB','OPEN','SPCE',
];

const TF = {
  daily:   { mult:1, span:'day',   daysBack:40  },
  weekly:  { mult:1, span:'week',  daysBack:200 },
  monthly: { mult:1, span:'month', daysBack:500 },
};

function calcEMA(prices, period) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  let e = prices.slice(0, period).reduce((a,b) => a+b, 0) / period;
  out[period-1] = e;
  for (let i = period; i < prices.length; i++) { e = prices[i]*k + e*(1-k); out[i] = e; }
  return out;
}

function analyze(bars, period) {
  if (!bars || bars.length < period+2) return null;
  const closes = bars.map(b => b.c);
  const ema = calcEMA(closes, period);
  const n = closes.length;
  const price = closes[n-1], e = ema[n-1];
  if (e == null) return null;
  return { price: +price.toFixed(2), ema13: +e.toFixed(3), above: price > e, pct: +((price-e)/e*100).toFixed(2) };
}

async function fetchBars(base, key, ticker, cfg) {
  const now = new Date(), to = now.toISOString().slice(0,10);
  const from = new Date(now); from.setDate(from.getDate() - cfg.daysBack);
  const fr = from.toISOString().slice(0,10);
  const url = base+'/v2/aggs/ticker/'+encodeURIComponent(ticker)+'/range/'+cfg.mult+'/'+cfg.span+'/'+fr+'/'+to+'?adjusted=true&sort=asc&limit=50000';
  const r = await fetch(url, {headers:{'Authorization':'Bearer '+key}});
  const d = await r.json();
  return d.results || [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const base = (process.env.MASSIVE_API_BASE || '').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: 'API key not set' });

  const tf = req.query.tf || 'daily';
  const wlTickers = (req.query.wl || '').split(',').filter(Boolean);
  const allTickers = [...new Set([...wlTickers, ...SC_TICKERS])];

  // ── SNAP MODE: fast price refresh via snapshot ──
  if (tf === 'snap') {
    try {
      const tickerStr = allTickers.map(t => encodeURIComponent(t)).join(',');
      const snapUrl = base+'/v2/snapshot/locale/us/markets/stocks/tickers?tickers='+tickerStr;
      const sd = await fetch(snapUrl, {headers:{'Authorization':'Bearer '+key}}).then(r=>r.json());
      const snaps = (sd.tickers || []).map(item => ({
        t: item.ticker,
        price: +(item.day?.c ?? item.prevDay?.c ?? 0).toFixed(2)
      })).filter(s => s.price > 0);
      return res.status(200).json({ snaps, updatedAt: new Date().toISOString() });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const cfg = TF[tf];
  if (!cfg) return res.status(400).json({ error: 'Invalid tf. Use daily, weekly, or monthly.' });

  const CONCURRENCY = 40, above = [], below = [];
  const wlSet = new Set(wlTickers);
  for (let i = 0; i < allTickers.length; i += CONCURRENCY) {
    const batch = allTickers.slice(i, i+CONCURRENCY);
    const rows = await Promise.all(batch.map(async ticker => {
      try {
        const bars = await fetchBars(base, key, ticker, cfg);
        const a = analyze(bars, 13);
        if (!a) return null;
        return { t: ticker, isWL: wlSet.has(ticker), ...a };
      } catch { return null; }
    }));
    rows.filter(Boolean).forEach(r => (r.above ? above : below).push(r));
  }
  above.sort((a,b) => b.pct-a.pct);
  below.sort((a,b) => a.pct-b.pct);
  return res.status(200).json({ above, below, tf, updatedAt: new Date().toISOString() });
}
