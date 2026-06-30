// Vercel serverless function — GET /api/quotes
const TICKERS = [
  'CAR','WEN','ASTS','NFLX','MSFT','V','LLY','COIN','OKLO','IREN',
  'AAPL','META','MSTR','BA','PLTR','CRWV','SNOW','MDB','IWM','AMZN',
  'AVGO','TSLA','SPY','QCOM','APP','NBIS','QQQ','HPE','GOOGL','NVDA',
  'SMCI','MRAM','INTC','CRDO','ORCL','AMD','CBRS','DELL','SNDK',
  'AAOI','LITE','MRVL','MU'
].join(',');

const NAMES = {
  CAR:'Avis Budget Group', WEN:"Wendy's Co", ASTS:'AST SpaceMobile',
  NFLX:'Netflix Inc', MSFT:'Microsoft Corp', V:'Visa Inc',
  LLY:'Eli Lilly & Co', COIN:'Coinbase Global', OKLO:'Oklo Inc',
  IREN:'Iris Energy Ltd', AAPL:'Apple Inc', META:'Meta Platforms',
  MSTR:'MicroStrategy Inc', BA:'Boeing Co', PLTR:'Palantir Technologies',
  CRWV:'CoreWeave Inc', SNOW:'Snowflake Inc', MDB:'MongoDB Inc',
  IWM:'iShares Russell 2000 ETF', AMZN:'Amazon.com Inc',
  AVGO:'Broadcom Inc', TSLA:'Tesla Inc', SPY:'S&P 500 ETF',
  QCOM:'Qualcomm Inc', APP:'Applovin Corp', NBIS:'Nebius Group NV',
  QQQ:'Nasdaq 100 ETF', HPE:'HP Enterprise', GOOGL:'Alphabet Inc',
  NVDA:'NVIDIA Corp', SMCI:'Super Micro Computer', MRAM:'Everspin Technologies',
  INTC:'Intel Corp', CRDO:'Credo Technology Group', ORCL:'Oracle Corp',
  AMD:'Advanced Micro Devices', CBRS:'Citizen Broadband Radio',
  DELL:'Dell Technologies', SNDK:'SanDisk Corp',
  AAOI:'Applied Optoelectronics', LITE:'Lumentum Holdings',
  MRVL:'Marvell Technology', MU:'Micron Technology',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=25, stale-while-revalidate=5');

  const API_KEY  = process.env.MASSIVE_API_KEY;
  const API_BASE = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');

  if (!API_KEY) {
    return res.status(500).json({ error: 'MASSIVE_API_KEY not configured in Vercel env vars' });
  }

  try {
    const url = `${API_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${TICKERS}&apiKey=${API_KEY}`;
    const upstream = await fetch(url);
    const json = await upstream.json();

    if (!json.tickers) {
      return res.status(502).json({ error: 'Unexpected API response', detail: JSON.stringify(json).slice(0, 300) });
    }

    const quotes = json.tickers.map(tk => ({
      t:     tk.ticker,
      n:     NAMES[tk.ticker] || tk.ticker,
      price: +(tk.day?.c            ?? 0).toFixed(2),
      chg:   +(tk.todaysChange      ?? 0).toFixed(2),
      pct:   +(tk.todaysChangePerc  ?? 0).toFixed(2),
      vol:   Math.round(tk.day?.v   ?? 0),
      vwap:  +(tk.day?.vw           ?? 0).toFixed(2),
      high:  +(tk.day?.h            ?? 0).toFixed(2),
      low:   +(tk.day?.l            ?? 0).toFixed(2),
      open:  +(tk.day?.o            ?? 0).toFixed(2),
    }));

    return res.status(200).json({ quotes, updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
