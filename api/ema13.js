import fetch from 'node-fetch';

// Vercel serverless – GET /api/ema13?tf=day|week|month|cross&wl=TICKER,...
// EMA 13 scanner + EMA13/14 crossover ranker (tf=cross)

const SC_TICKERS = [
  'MARA','RIOT','CLSK','HUT','BITF','WULF','CORZ',
  'IONQ','RGTI','QUBT','KULR','SOUN','ENVX',
  'ACHR','JOBY','BLNK','PLUG','FCEL','NKLA',
  'NVAX','OCGN','ABUS','MNMD',
  'GME','AMC','TLRY','SNDL',
  'MVIS','BB','OPEN','SPCE',
];

const TF = {
  day:   { mult:1, span:'day',   daysBack:40,  period:13 },
  week:  { mult:1, span:'week',  daysBack:200, period:13 },
  month: { mult:1, span:'month', daysBack:500, period:13 },
};

function calcEMA(prices, period) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < prices.length; i++) { e = prices[i]*k + e*(1-k); out[i] = e; }
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
    price: +price.toFixed(2), ema13: +e.toFixed(3), period,
    above: price > e, pct: +((price-e)/e*100).toFixed(2),
    crossedAbove: prevP <= prevE && price > e,
    crossedBelow: prevP >= prevE && price < e,
  };
}

async function fetchAllBars(base, key, ticker, mult, span, fromDate, toDate) {
  const allBars = [];
  let url = `${base}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${mult}/${span}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
  let pages = 0;
  while (url && pages < 10) {
    const d = await fetch(url).then(r => r.json());
    if (d.results) allBars.push(...d.results);
    url = d.next_url ? `${d.next_url}&apiKey=${key}` : null;
    pages++;
  }
  return allBars;
}

function getMondayDate() {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun
  const diff = dow === 0 ? 6 : dow - 1;
  const mon = new Date(now);
  mon.setDate(mon.getDate() - diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const base = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

  const tf = req.query.tf || 'day';
  const wlTickers = (req.query.wl || '').split(',').filter(Boolean);

  // ── SNAP mode ───────────────────────────────────────────────────────────
  if (tf === 'snap') {
    const allT = [...new Set([...wlTickers, ...SC_TICKERS])];
    const tickerStr = allT.map(t => encodeURIComponent(t)).join(',');
    try {
      const snapData = await fetch(`${base}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerStr}&apiKey=${key}`).then(r => r.json());
      const snaps = (snapData.tickers || []).map(item => ({
        t: item.ticker,
        price: +(item.day?.c ?? item.prevDay?.c ?? 0).toFixed(2)
      })).filter(s => s.price > 0);
      return res.status(200).json({ snaps, updatedAt: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── EMA13/14 CROSS RANK mode ─────────────────────────────────────────────
  if (tf === 'cross') {
    const monday = getMondayDate();
    const mondayMs = monday.getTime();
    const now = new Date();
    const toDate = now.toISOString().slice(0, 10);
    // Warmup: fetch 30 extra calendar days before Monday so EMAs are accurate
    const warmup = new Date(monday);
    warmup.setDate(warmup.getDate() - 30);
    const fromDate = warmup.toISOString().slice(0, 10);

    const scSet = new Set(SC_TICKERS);
    const wlSet = new Set(wlTickers);
    const allTickers = [...new Set([...wlTickers, ...SC_TICKERS])];

    const CONC = 40;
    const out = [];

    for (let i = 0; i < allTickers.length; i += CONC) {
      const batch = allTickers.slice(i, i + CONC);
      const rows = await Promise.all(batch.map(async ticker => {
        try {
          // Hourly bars for EMA13/14 cross detection
          const bars = await fetchAllBars(base, key, ticker, 1, 'hour', fromDate, toDate);
          if (bars.length < 15) return null;

          const closes = bars.map(b => b.c);
          const times  = bars.map(b => b.t); // ms timestamps
          const ema13arr = calcEMA(closes, 13);
          const ema14arr = calcEMA(closes, 14);

          const price = closes[closes.length - 1];
          const curE13 = ema13arr[ema13arr.length - 1];
          const curE14 = ema14arr[ema14arr.length - 1];

          // Scan for crosses SINCE Monday — record the most recent one
          let lastCrossTs = null;
          let lastCrossDir = null; // 'above' | 'below'

          for (let j = 1; j < bars.length; j++) {
            if (times[j] < mondayMs) continue; // skip pre-Monday bars
            const e13 = ema13arr[j], e13p = ema13arr[j-1];
            const e14 = ema14arr[j], e14p = ema14arr[j-1];
            if (e13 == null || e14 == null || e13p == null || e14p == null) continue;

            if (e13p <= e14p && e13 > e14) {
              lastCrossTs = times[j];
              lastCrossDir = 'above';
            } else if (e13p >= e14p && e13 < e14) {
              lastCrossTs = times[j];
              lastCrossDir = 'below';
            }
          }

          return {
            t: ticker,
            isWL: wlSet.has(ticker),
            isSC: scSet.has(ticker),
            price: +price.toFixed(2),
            ema13: curE13 != null ? +curE13.toFixed(3) : null,
            ema14: curE14 != null ? +curE14.toFixed(3) : null,
            above: curE13 != null && curE14 != null ? curE13 > curE14 : null,
            pct: curE13 != null && curE14 != null ? +((curE13 - curE14) / curE14 * 100).toFixed(3) : null,
            crossTs: lastCrossTs,
            crossDir: lastCrossDir,
            crossedThisWeek: lastCrossTs !== null,
          };
        } catch { return null; }
      }));
      out.push(...rows.filter(Boolean));
    }

    // Sort: crossed this week first (by crossTs ascending = Monday first),
    // then no-cross stocks by price desc
    out.sort((a, b) => {
      if (a.crossTs && b.crossTs) return a.crossTs - b.crossTs; // earliest cross first
      if (a.crossTs) return -1;
      if (b.crossTs) return 1;
      return b.price - a.price;
    });

    return res.status(200).json({
      results: out,
      tf: 'cross',
      monday: monday.toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
    });
  }

  // ── Standard EMA13 mode ──────────────────────────────────────────────────
  const cfg = TF[tf];
  if (!cfg) return res.status(400).json({ error: 'Invalid tf' });
  const scSet = new Set(SC_TICKERS), wlSet = new Set(wlTickers);
  const allTickers = [...new Set([...wlTickers, ...SC_TICKERS])];
  const now = new Date(), toDate = now.toISOString().slice(0, 10);
  const fromDt = new Date(now);
  fromDt.setDate(fromDt.getDate() - cfg.daysBack);
  const fromDate = fromDt.toISOString().slice(0, 10);
  const CONC = 40, out = [];
  for (let i = 0; i < allTickers.length; i += CONC) {
    const batch = allTickers.slice(i, i + CONC);
    const rows = await Promise.all(batch.map(async ticker => {
      try {
        const bars = await fetchAllBars(base, key, ticker, cfg.mult, cfg.span, fromDate, toDate);
        const a = analyze(bars, cfg.period);
        if (!a) return null;
        return { t: ticker, isWL: wlSet.has(ticker), isSC: scSet.has(ticker), ...a };
      } catch { return null; }
    }));
    out.push(...rows.filter(Boolean));
  }
  return res.status(200).json({ results: out, tf, period: cfg.period, updatedAt: toDate });
}
