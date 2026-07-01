import fetch from 'node-fetch';

// Vercel serverless – GET /api/options?wl=TICKER,...
// Returns unusual options activity: vol/OI ratio >= 3x AND notional >= $50K

// Liquid large/mid caps to always scan (high options volume, good signals)
const LIQUID_TICKERS = [
  'SPY','QQQ','IWM',
  'AAPL','TSLA','NVDA','AMZN','META','GOOGL','MSFT','AMD',
  'PLTR','MARA','COIN','HOOD','SOFI','RIVN',
  'GLD','SLV','TLT',
];

const MIN_VOL      = 10;
const MIN_RATIO    = 3.0;    // vol/OI threshold
const MIN_NOTIONAL = 50000;  // $50K notional minimum

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const base = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

  const wlTickers  = (req.query.wl || '').split(',').filter(Boolean);
  const allTickers = [...new Set([...wlTickers, ...LIQUID_TICKERS])];

  const calls = [];
  const puts  = [];

  // Fetch all tickers concurrently in batches of 15
  const CONCURRENCY = 15;
  for (let i = 0; i < allTickers.length; i += CONCURRENCY) {
    const batch   = allTickers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(t => fetchUnusual(base, key, t)));
    results.forEach(contracts => {
      contracts.forEach(c => {
        if (c.type === 'call') calls.push(c);
        else                    puts.push(c);
      });
    });
  }

  // Sort by notional descending, cap at 50 each
  calls.sort((a, b) => b.notional - a.notional);
  puts.sort((a, b)  => b.notional - a.notional);

  return res.status(200).json({
    calls: calls.slice(0, 50),
    puts:  puts.slice(0, 50),
    updatedAt: new Date().toISOString(),
  });
}

async function fetchUnusual(base, key, ticker) {
  try {
    const url  = `${base}/v3/snapshot/options/${encodeURIComponent(ticker)}?limit=250&apiKey=${key}`;
    const data = await fetch(url).then(r => r.json());
    const contracts = data.results || [];

    const unusual = [];
    for (const c of contracts) {
      const vol   = c.day?.volume ?? 0;
      const oi    = c.open_interest ?? 0;
      const price = c.day?.close ?? 0;

      if (vol < MIN_VOL || price <= 0) continue;

      const ratio    = oi > 0 ? vol / oi : 99;
      if (ratio < MIN_RATIO) continue;

      const notional = vol * 100 * price;
      if (notional < MIN_NOTIONAL) continue;

      unusual.push({
        ticker,
        type:           c.details?.contract_type ?? 'call',
        strike:         c.details?.strike_price,
        expiry:         c.details?.expiration_date,
        contractTicker: c.details?.ticker,
        vol,
        oi,
        ratio:    oi > 0 ? +(vol / oi).toFixed(1) : 99,
        price:    +price.toFixed(2),
        notional: Math.round(notional),
        iv:    c.implied_volatility != null ? +(c.implied_volatility * 100).toFixed(1) : null,
        delta: c.greeks?.delta       != null ? +c.greeks.delta.toFixed(3)               : null,
      });
    }
    return unusual;
  } catch {
    return [];
  }
}
