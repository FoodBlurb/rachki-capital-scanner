import fetch from 'node-fetch';

// Third Friday of month (month is 0-indexed)
function thirdFriday(year, month) {
  const d = new Date(year, month, 1);
  const dow = d.getDay();
  const toFri = (5 - dow + 7) % 7;
  return new Date(year, month, 1 + toFri + 14);
}

function nextOpexDates(n = 6) {
  const now = new Date();
  const out = [];
  let year = now.getFullYear();
  let month = now.getMonth();
  while (out.length < n) {
    const opex = thirdFriday(year, month);
    if (opex > now) out.push(opex);
    if (++month > 11) { month = 0; year++; }
  }
  return out;
}

function toDateStr(d) { return d.toISOString().slice(0, 10); }

const US_HOLIDAYS = new Set([
  '2026-07-03','2026-09-07','2026-11-26','2026-11-27',
  '2026-12-25','2027-01-01','2027-01-19','2027-02-15',
]);

function addTradingDays(baseDate, days) {
  let d = new Date(baseDate);
  let rem = Math.ceil(Math.max(0, days));
  while (rem > 0) {
    d = new Date(d.getTime() + 86400000);
    const dow = d.getDay();
    const ds = toDateStr(d);
    if (dow !== 0 && dow !== 6 && !US_HOLIDAYS.has(ds)) rem--;
  }
  return d;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const base = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');
  const key  = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

  const ticker     = (req.query.ticker || 'SPY').toUpperCase();
  const chartPrice = parseFloat(req.query.chartPrice) || 0;
  const atrDaily   = parseFloat(req.query.atrDaily)   || 0;
  const pctDaily   = Math.min(parseFloat(req.query.pctDaily) || 0, 100) / 100;
  const atrMonthly = parseFloat(req.query.atrMonthly) || 0;
  const pctMonthly = Math.min(parseFloat(req.query.pctMonthly) || 0, 100) / 100;

  const LEVEL_KEYS = ['r1','r2','r3','r4','r5','r6'];
  const chartLevels = {};
  LEVEL_KEYS.forEach(k => {
    const v = parseFloat(req.query[k]);
    if (!isNaN(v) && v > 0) chartLevels[k] = v;
  });

  if (!chartPrice || Object.keys(chartLevels).length === 0) {
    return res.status(400).json({ error: 'chartPrice and at least r1 are required' });
  }

  let tickerPrice = chartPrice;
  try {
    const snap = await fetch(
      base+'/v2/snapshot/locale/us/markets/stocks/tickers/'+ticker+'?apiKey='+key
    ).then(r => r.json());
    const p = snap?.ticker?.day?.c ?? snap?.ticker?.prevDay?.c ?? 0;
    if (p > 0) tickerPrice = p;
  } catch {}

  const scale = chartPrice > 0 && tickerPrice > 0 ? tickerPrice / chartPrice : 1;
  const hvAnn = chartPrice > 0 && atrDaily > 0
    ? (atrDaily / chartPrice / 1.3) * Math.sqrt(252) : 0;
  const remainingToday = atrDaily * (1 - pctDaily);

  function daysToLevel(chartTarget) {
    const gap = chartTarget - chartPrice;
    if (gap <= 0) return 0;
    const afterToday = Math.max(0, gap - remainingToday);
    return atrDaily > 0 ? afterToday / atrDaily : 999;
  }

  const scaledValues = Object.values(chartLevels).map(v => Math.round(v * scale));
  const minStrike = Math.min(...scaledValues) - 15;
  const maxStrike = Math.max(...scaledValues) + 15;

  const opexDates = nextOpexDates(6);
  const now = new Date();
  const resistanceLevels = Object.entries(chartLevels);
  const CONC = 3;
  const opexResults = [];

  for (let i = 0; i < opexDates.length; i += CONC) {
    const batch = opexDates.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async opexDate => {
      const expStr = toDateStr(opexDate);
      const daysToExpiry = Math.round((opexDate - now) / 86400000);
      try {
        const url = base+'/v3/snapshot/options/'+encodeURIComponent(ticker)
          +'?expiration_date='+expStr+'&contract_type=call'
          +'&strike_price.gte='+minStrike+'&strike_price.lte='+maxStrike
          +'&limit=250&apiKey='+key;
        const data = await fetch(url).then(r => r.json());
        const contracts = data.results || [];
        const levels = [];
        for (const [levelKey, chartTarget] of resistanceLevels) {
          const scaledTarget = Math.round(chartTarget * scale);
          const days = daysToLevel(chartTarget);
          const reachDate = addTradingDays(now, days);
          const reachStr = reachDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const feasible = days < daysToExpiry - 2;
          const candidates = contracts.filter(c => {
            const s = c.details?.strike_price ?? 0;
            const delta = c.greeks?.delta ?? 0;
            const price = c.day?.close ?? 0;
            return Math.abs(s - scaledTarget) <= 7 && delta > 0.002 && delta < 0.5 && price > 0;
          });
          if (!candidates.length) continue;
          candidates.sort((a, b) => {
            const da = Math.abs((a.details?.strike_price??0) - scaledTarget);
            const db = Math.abs((b.details?.strike_price??0) - scaledTarget);
            return da !== db ? da - db : (b.open_interest||0) - (a.open_interest||0);
          });
          const best = candidates[0];
          const iv = best.implied_volatility || 0;
          const mktPrice = best.day?.close || 0;
          const ivPct  = +(iv * 100).toFixed(1);
          const hvPct  = +(hvAnn * 100).toFixed(1);
          const undervalPct = iv > 0 && hvAnn > 0 ? Math.round((1 - iv/hvAnn)*100) : 0;
          const verdict = undervalPct > 15 ? 'UNDERVALUED' : undervalPct < -10 ? 'OVERPRICED' : 'FAIR';
          levels.push({
            level: levelKey.toUpperCase(),
            chartTarget: +chartTarget.toFixed(2),
            strike: best.details?.strike_price,
            premium: +mktPrice.toFixed(2),
            premiumPerContract: Math.round(mktPrice * 100),
            delta: +(best.greeks?.delta||0).toFixed(3),
            iv: ivPct, hvPct,
            hvFair: iv > 0 ? +(mktPrice*(hvAnn/iv)).toFixed(2) : null,
            undervalPct, verdict,
            oi: best.open_interest||0,
            vol: best.day?.volume||0,
            theta: +(best.greeks?.theta||0).toFixed(4),
            daysToReach: +days.toFixed(1),
            estimatedReach: reachStr,
            feasible,
            contractTicker: best.details?.ticker||'',
          });
        }
        return { expiry: expStr, daysToExpiry, levels };
      } catch(err) {
        return { expiry: expStr, daysToExpiry, levels: [], error: err.message };
      }
    }));
    opexResults.push(...results);
  }

  return res.status(200).json({
    ticker, tickerPrice: +tickerPrice.toFixed(2), chartPrice,
    scale: +scale.toFixed(4), hvAnn: +(hvAnn*100).toFixed(1),
    opexResults, updatedAt: new Date().toISOString(),
  });
}
