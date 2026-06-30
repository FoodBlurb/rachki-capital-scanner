import fetch from 'node-fetch';

const API_BASE = 'https://api.massive.com';
const API_KEY = process.env.MASSIVE_API_KEY;

const BASE_TICKERS = ['CAR','WEN','ASTS','NFLX','MSFT','V','LLY','COIN','OKLO','IREN',
  'AAPL','META','MSTR','BA','PLTR','CRWV','SNOW','MDB','IWM','AMZN',
  'AVGO','TSLA','SPY','QCOM','APP','NBIS','QQQ','HPE','GOOGL','NVDA',
  'SMCI','MRAM','INTC','CRDO','ORCL','AMD','CBRS','DELL','SNDK',
  'AAOI','LITE','MRVL','MU'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const extra = (req.query?.extra || '').split(',').map(s=>s.trim().toUpperCase()).filter(s=>/^[A-Z]{1,5}$/.test(s));
  const allTickers = [...new Set([...BASE_TICKERS, ...extra])];

  try {
    // v3/snapshot returns live extended-hours data (pre-market + after-hours)
    const url = API_BASE+'/v3/snapshot?ticker.any_of='+allTickers.join(',')+'&apiKey='+API_KEY;
    const r = await fetch(url);
    const data = await r.json();
    const results = data.results || [];

    const tickers = results.map(item => {
      const s = item.session || {};
      const ms = item.market_status || '';
      // Pick the right change for the current session
      let chg, pct;
      if (ms === 'late_trading') {
        chg = s.late_trading_change ?? s.change ?? 0;
        pct = s.late_trading_change_percent ?? s.change_percent ?? 0;
      } else if (ms === 'early_trading') {
        chg = s.early_trading_change ?? s.change ?? 0;
        pct = s.early_trading_change_percent ?? s.change_percent ?? 0;
      } else {
        chg = s.change ?? 0;
        pct = s.change_percent ?? 0;
      }
      return {
        t: item.ticker,
        n: item.name || item.ticker,
        price: s.price ?? s.close ?? 0,
        chg: Number(chg.toFixed(4)),
        pct: Number(pct.toFixed(4)),
        vol: s.volume ?? 0,
        high: s.high,
        low: s.low,
        prevClose: s.previous_close,
        ms,
      };
    }).filter(s => s.price > 0);

    res.json({ tickers, updatedAt: Date.now() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
