import fetch from 'node-fetch';

// Updated base universe — current momentum/active small caps
const BASE_TICKERS = [
  // Crypto miners
  'MARA','RIOT','CLSK','HUT','BITF','WULF','CORZ',
  // AI / quantum
  'IONQ','RGTI','QUBT','KULR','SOUN','ENVX',
  // Aerospace / EV
  'ACHR','JOBY','BLNK','PLUG','FCEL','NKLA',
  // Biotech
  'NVAX','OCGN','ABUS','MNMD',
  // Retail / meme
  'GME','AMC','TLRY','SNDL',
  // Tech / misc
  'MVIS','BB','OPEN','SPCE',
];

function normalize(s) {
  const price  = +(s.lastTrade?.p || s.min?.c || s.day?.c || 0).toFixed(2);
  const vol    = Math.round(s.min?.av || s.day?.v || 0);
  const prevV  = Math.round(s.prevDay?.v || 0);
  const relVol = prevV > 0 ? +(vol / prevV).toFixed(2) : 0;
  return {
    t: s.ticker, n: s.ticker,
    price,
    chg:    +(s.todaysChange     || 0).toFixed(2),
    pct:    +(s.todaysChangePerc || 0).toFixed(2),
    vol, avgVol: prevV, relVol,
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const base = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

  try {
    // Fetch gainers, losers, and base tickers all in parallel
    const baseChunked = chunk(BASE_TICKERS, 50);
    const [gainersRes, losersRes, ...baseResults] = await Promise.all([
      fetch(`${base}/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=false&apiKey=${key}`).then(r => r.json()),
      fetch(`${base}/v2/snapshot/locale/us/markets/stocks/losers?include_otc=false&apiKey=${key}`).then(r => r.json()),
      ...baseChunked.map(c =>
        fetch(`${base}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${c.join(',')}&apiKey=${key}`)
          .then(r => r.json()).catch(() => ({ tickers: [] }))
      ),
    ]);

    // Combine, deduplicate
    const seen = new Set();
    const quotes = [
      ...(gainersRes.tickers || []),
      ...(losersRes.tickers  || []),
      ...baseResults.flatMap(r => r.tickers || []),
    ]
    .filter(s => { if (seen.has(s.ticker)) return false; seen.add(s.ticker); return true; })
    .map(normalize)
    .filter(q =>
      q.price >= 1 && q.price <= 30 &&
      q.vol > 0 &&
      Math.abs(q.pct) >= 0.5
    )
    .sort((a, b) => b.relVol - a.relVol);

    return res.status(200).json({ quotes, updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
