require('dotenv').config();
const express      = require('express');
const axios        = require('axios');
const cors         = require('cors');
const path         = require('path');
const googleTrends = require('google-trends-api');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const DATAFORSEO_CREDS  = process.env.DATAFORSEO_CREDS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── PageSpeed Insights ────────────────────────────────────────────────────────
app.get('/api/pagespeed', async (req, res) => {
  const { url, strategy = 'mobile' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const cleanUrl = `https://${url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')}`;
    const psiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    psiUrl.searchParams.set('url', cleanUrl);
    psiUrl.searchParams.set('strategy', strategy);
    psiUrl.searchParams.set('key', GOOGLE_API_KEY);
    ['performance', 'accessibility', 'best-practices', 'seo'].forEach(c => psiUrl.searchParams.append('category', c));

    const response = await axios.get(psiUrl.toString());
    const lhr    = response.data.lighthouseResult;
    const cats   = lhr.categories;
    const audits = lhr.audits;

    const scores = {
      performance:   Math.round((cats.performance?.score       || 0) * 100),
      accessibility: Math.round((cats.accessibility?.score     || 0) * 100),
      seo:           Math.round((cats.seo?.score               || 0) * 100),
      bestPractices: Math.round((cats['best-practices']?.score || 0) * 100)
    };

    const cwv = {
      lcp: { label: 'Largest Contentful Paint', desc: 'How long until the biggest visible element fully loads',       value: audits['largest-contentful-paint']?.displayValue, score: audits['largest-contentful-paint']?.score },
      inp: { label: 'Interaction to Next Paint', desc: 'How quickly the page reacts after a user tap or click',        value: audits['interaction-to-next-paint']?.displayValue || audits['max-potential-fid']?.displayValue, score: audits['interaction-to-next-paint']?.score ?? audits['max-potential-fid']?.score },
      cls: { label: 'Cumulative Layout Shift',   desc: 'How much page elements unexpectedly move during load',         value: audits['cumulative-layout-shift']?.displayValue,  score: audits['cumulative-layout-shift']?.score },
      fcp: { label: 'First Contentful Paint',    desc: 'When the first text or image appears on screen',               value: audits['first-contentful-paint']?.displayValue,   score: audits['first-contentful-paint']?.score },
      tti: { label: 'Time to Interactive',       desc: 'When the page is fully interactive and responds to all input', value: audits['interactive']?.displayValue,              score: audits['interactive']?.score },
      si:  { label: 'Speed Index',               desc: 'How quickly content is visually populated on screen',          value: audits['speed-index']?.displayValue,              score: audits['speed-index']?.score }
    };

    const cwvPass    = (cwv.lcp.score >= 0.9) && (cwv.inp.score >= 0.9) && (cwv.cls.score >= 0.9);
    const screenshot = audits['final-screenshot']?.details?.data || null;

    res.json({ url, strategy, scores, cwv, cwvPass, screenshot });

  } catch (err) {
    console.error('PageSpeed error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ── AI Key Findings — on demand only ─────────────────────────────────────────
app.post('/api/findings', async (req, res) => {
  const { clientDomain, clientData, competitorResults } = req.body;

  const prompt = `You are an SEO and web performance expert writing a client audit report. Based on the PageSpeed data below, write exactly 3 key findings. Each should have a punchy title (max 10 words) and a 1–2 sentence plain-English explanation. Focus on the most impactful issues and any notable competitive gaps.

Client: ${clientDomain}
Client scores: ${JSON.stringify(clientData?.scores)}
Client CWV: ${JSON.stringify(Object.entries(clientData?.cwv || {}).map(([k,v]) => ({ metric: v.label, value: v.value, score: v.score })))}
Competitors: ${JSON.stringify(competitorResults?.map(c => ({ domain: c.url, scores: c.scores })))}

Return ONLY a valid JSON array — no markdown, no preamble:
[{"title":"...","body":"...","type":"issue"},{"title":"...","body":"...","type":"gap"},{"title":"...","body":"...","type":"issue"}]
type must be either "issue" or "gap".`;

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const text  = response.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));

  } catch (err) {
    console.error('Anthropic error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Google Trends autocomplete ────────────────────────────────────────────────
// Returns topic suggestions for a keyword — same as the dropdown in Google Trends UI
app.get('/api/trends/autocomplete', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  try {
    const raw  = await googleTrends.autoComplete({ keyword });
    const data = JSON.parse(raw);

    // Extract suggestions — each has a title, type (e.g. "Liqueur"), and mid (topic ID)
    const suggestions = (data.default?.topics || []).map(t => ({
      title:   t.title,
      type:    t.type,    // "Search term", "Liqueur", "Topic" etc.
      mid:     t.mid      // Google's internal topic ID e.g. /m/02rjjll
    }));

    res.json(suggestions);

  } catch (err) {
    console.error('Autocomplete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Google Trends data ────────────────────────────────────────────────────────
app.post('/api/trends', async (req, res) => {
  const { keywords, startTime, endTime, geo } = req.body;
  // keywords is array of { keyword, mid } — mid is optional topic ID
  if (!keywords || !keywords.length) return res.status(400).json({ error: 'keywords required' });

  try {
    const start = new Date(startTime || Date.now() - 365 * 24 * 60 * 60 * 1000);
    const end   = new Date(endTime   || Date.now());

    // Build keyword array — use mid (topic ID) if available, otherwise plain keyword
    const kwArray = keywords.map(k => k.mid ? k.mid : k.keyword);

    // Interest over time
    const interestRaw  = await googleTrends.interestOverTime({
      keyword:   kwArray,
      startTime: start,
      endTime:   end,
      geo:       geo || 'ZA'
    });
    const interestData = JSON.parse(interestRaw).default?.timelineData || [];

    // Related queries per keyword
    const relatedData = await Promise.all(keywords.map(async (k, i) => {
      try {
        const raw    = await googleTrends.relatedQueries({
          keyword:   kwArray[i],
          startTime: start,
          endTime:   end,
          geo:       geo || 'ZA'
        });
        const ranked = JSON.parse(raw).default?.rankedList || [];
        return {
          keyword: k.keyword,
          top:     (ranked[0]?.rankedKeyword || []).slice(0, 10).map(q => ({ query: q.query, value: q.value })),
          rising:  (ranked[1]?.rankedKeyword || []).slice(0, 10).map(q => ({ query: q.query, value: q.value }))
        };
      } catch {
        return { keyword: k.keyword, top: [], rising: [] };
      }
    }));

    res.json({ interestData, relatedData, keywords: keywords.map(k => k.keyword) });

  } catch (err) {
    console.error('Trends error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve pages ───────────────────────────────────────────────────────────────
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'audit.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ODD-it running → http://localhost:${PORT}`));