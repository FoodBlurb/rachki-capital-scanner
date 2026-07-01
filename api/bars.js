// Vercel serverless function — GET /api/bars
// Fetches 10-minute OHLCV bars for a stock ticker from Massive Market Data
// Query params: ticker (required), days (optional, default 5)

import fetch from 'node-fetch';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const API_KEY  = process.env.MASSIVE_API_KEY;
  const API_BASE = (process.env.MASSIVE_API_BASE || 'https://api.massive.com').replace(/\/$/, '');

  if (!API_KEY) {
    return res.status(500).json({ error: 'MASSIVE_API_KEY not configured' });
  }

  const { ticker, days = '5' } = req.query;
  if (!ticker) {
    return res.status(400).json({ error: 'ticker param required' });
  }

  const now  = Date.now();
  const from = new Date(now - parseInt(days) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to   = new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // +1 day buffer

  try {
    const url = `${API_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/10/minute/${from}/${to}?sort=asc&limit=2000&apiKey=${API_KEY}`;
    const upstream = await fetch(url);
    const json = await upstream.json();

    if (json.status === 'ERROR') {
      return res.status(502).json({ error: json.error || 'API error', results: [] });
    }

    return res.status(200).json({ results: json.results || [], count: (json.results || []).length });
  } catch (err) {
    return res.status(500).json({ error: err.message, results: [] });
  }
}
