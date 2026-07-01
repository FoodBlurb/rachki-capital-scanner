// Vercel serverless function — GET /api/smallcap
// Small Cap NASDAQ Scanner: Price $1–$11 · Volume > 21-day average

const SC_TICKERS = [
  // Crypto miners
  'MARA','RIOT','CLSK','HUT','BITF','WULF','CIFR','BTBT','CORZ',
  // EV / clean energy
  'PLUG','NKLA','GOEV','WKHS','MULN','BLNK','FCEL','HYLN',
  // Biotech
  'OCGN','NVAX','AGEN','CTXR','ABUS','SAVA',
  // Tech / finance
  'BB','NOK','BKKT','OPEN','PSFE','MVIS','INPX','GFAI',
  // Cannabis
  'TLRY','SNDL','CRON','ACB',
  // Retail / meme
  'AMC','GME',
  // Misc
  'CLOV','SPCE','GENI','IDEX','KULR','ENVX',
  'SOS','EBON','NCTY','LIZI','CNET','CXAI',
  'INDO','IMPP','ATER','CTRM','FFIE','XELA','PSTV','CIDM',
  'VERB','GREE','MNMD','ONDS','JMIA',
  'WINT','STTK','VLNX','SENS','NVOS','HYMC','ORBC',
];

// Module-level cache: recomputed once per calendar day
let _avgVol   = {};
let _cacheDay = '';

function pastBizDates(n) {
  const dates = [];
  const d = new Date();
  while (dates.length < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6)
      dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const base = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  const today = new Date().toISOString().slice(0, 10);

  if (!key) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

  try {
    // Refresh 21-day avg volume cache once per calendar day
    if (_cacheDay !== today) {
      const dates = pastBizDates(21);
      const days = await Promise.all(
        dates.map(dt =>
          fetch(`${base}/v2/aggs/grouped/locale/us/market/stocks/${dt}?adjusted=true&apiKey=${key}`)
            .then(r => r.json()).catch(() => ({ results: [] }))
        )
      );
      const sums = {}, counts = {};
      const tickerSet = new Set(SC_TICKERS);
      for (const day of days) {
        for (const bar of (day.results || [])) {
          if (!tickerSet.has(bar.T)) continue;
          sums[bar.T]   = (sums[bar.T]   || 0) + (bar.v || 0);
          counts[bar.T] = (counts[bar.T] || 0) + 1;
        }
      }
      _avgVol = {};
      for (const t of SC_TICKERS)
        _avgVol[t] = counts[t] > 0 ? sums[t] / counts[t] : 0;
      _cacheDay = today;
    }

    // Fetch current snapshots in chunks of 50
    const chunks = [];
    for (let i = 0; i < SC_TICKERS.length; i += 50)
      chunks.push(SC_TICKERS.slice(i, i + 50));
    const snaps = await Promise.all(
      chunks.map(c =>
        fetch(`${base}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${c.join(',')}&apiKey=${key}`)
          .then(r => r.json()).catch(() => ({ tickers: [] }))
      )
    );

    const all = snaps.flatMap(s => s.tickers || []);

    const quotes = all
      .map(s => {
        const price  = +(s.lastTrade?.p || s.min?.c || s.day?.c  || 0).toFixed(2);
        const vol    = Math.round(s.min?.av || s.day?.v || 0);
        const avg    = Math.round(_avgVol[s.ticker] || 0);
        const relVol = avg > 0 ? +(vol / avg).toFixed(2) : 0;
        return {
          t: s.ticker, n: s.ticker,
          price,
          chg:    +(s.todaysChange     || 0).toFixed(2),
          pct:    +(s.todaysChangePerc || 0).toFixed(2),
          vol, avgVol: avg, relVol,
        };
      })
      .filter(q => q.price >= 1 && q.price <= 11 && q.vol > 0 && (q.vol > q.avgVol || (q.vol > 1000 && Math.abs(q.pct) >= 0.5)))
      .sort((a, b) => b.relVol - a.relVol);

    return res.status(200).json({ quotes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('smallcap error:', err);
    return res.status(500).json({ error: err.message });
  }
}
