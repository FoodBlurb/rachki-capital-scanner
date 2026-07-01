export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel' });

  const { image, mediaType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'No image data provided' });

  const prompt = `Analyze this TradingView chart screenshot and extract numeric values for:

1. Chart Price - the current/last price shown on the chart axis or price label
2. Resistance levels R1, R2, R3, R4, R5, R6 (horizontal resistance lines labeled R1-R6)
3. Support levels S1, S2, S3 (if visible)
4. Pivot point (labeled P or Pivot)
5. Daily ATR - the ATR(daily) value shown (e.g. "ATR: 94.23")
6. Daily ATR used % - how much of today's daily range has been consumed (e.g. "76.6%")
7. Monthly ATR - the monthly ATR value
8. Monthly ATR used % - monthly range consumed

Return ONLY valid JSON, no explanation:
{
  "chartPrice": <number or null>,
  "r1": <number or null>,
  "r2": <number or null>,
  "r3": <number or null>,
  "r4": <number or null>,
  "r5": <number or null>,
  "r6": <number or null>,
  "s1": <number or null>,
  "s2": <number or null>,
  "s3": <number or null>,
  "pivot": <number or null>,
  "atrDaily": <number or null>,
  "pctDaily": <number or null>,
  "atrMonthly": <number or null>,
  "pctMonthly": <number or null>
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/png', data: image },
            },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    const d = await r.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));

    const text = d.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Vision model returned no JSON: ' + text.substring(0, 200));

    const parsed = JSON.parse(match[0]);
    return res.status(200).json({ ok: true, ...parsed });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
