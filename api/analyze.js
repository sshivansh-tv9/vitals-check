const T = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800], tbt: [200, 600] };
const rate = (k, v) => (v == null ? null : v <= T[k][0] ? 'good' : v <= T[k][1] ? 'ni' : 'poor');
const FIELD = { lcp: 'LARGEST_CONTENTFUL_PAINT_MS', inp: 'INTERACTION_TO_NEXT_PAINT', cls: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', fcp: 'FIRST_CONTENTFUL_PAINT_MS', ttfb: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE' };
const LAB = { lcp: 'largest-contentful-paint', cls: 'cumulative-layout-shift', fcp: 'first-contentful-paint', tbt: 'total-blocking-time', ttfb: 'server-response-time' };
const NAMES = { lcp: 'Largest Contentful Paint (LCP)', inp: 'Interaction to Next Paint (INP)', cls: 'Cumulative Layout Shift (CLS)', fcp: 'First Contentful Paint', ttfb: 'Time to First Byte', tbt: 'Total Blocking Time (lab stand-in for INP)' };

// Lighthouse audit id -> [metric it affects, what to do about it]
const FIX = {
  'server-response-time': ['lcp', 'The server is slow to answer. Add page caching or a CDN, speed up backend queries, or upgrade hosting.'],
  redirects: ['lcp', 'Redirect chains delay the first byte. Link straight to the final URL.'],
  'render-blocking-resources': ['lcp', 'These files block the first paint. Inline critical CSS and add defer/async to scripts.'],
  'lcp-lazy-loaded': ['lcp', 'The LCP image is lazy-loaded. Remove loading="lazy" from it.'],
  'prioritize-lcp-image': ['lcp', 'Preload the LCP image and add fetchpriority="high" to it.'],
  'uses-optimized-images': ['lcp', 'Compress these images.'],
  'modern-image-formats': ['lcp', 'Serve these images as WebP or AVIF.'],
  'uses-responsive-images': ['lcp', 'These images are bigger than displayed. Use srcset and sizes.'],
  'offscreen-images': ['lcp', 'Lazy-load these below-the-fold images so they stop competing with the LCP image.'],
  'uses-text-compression': ['lcp', 'Enable Brotli or gzip for these text files.'],
  'unused-css-rules': ['lcp', 'Remove or split out CSS the page does not use.'],
  'total-byte-weight': ['lcp', 'The page is heavy. Shrink or defer the largest files.'],
  'unsized-images': ['cls', 'Add width and height (or CSS aspect-ratio) so the browser reserves space.'],
  'layout-shifts': ['cls', 'These elements moved during load. Reserve space with explicit sizes or min-height, and never insert content above what is already visible.'],
  'font-display': ['cls', 'Use font-display: swap or optional, and preload key fonts.'],
  'non-composited-animations': ['cls', 'Animate transform and opacity only, not layout properties.'],
  'long-tasks': ['inp', 'Break these long tasks up and yield to the main thread so taps respond quickly.'],
  'bootup-time': ['inp', 'These scripts use the most CPU. Defer, code-split or remove them.'],
  'unused-javascript': ['inp', 'Remove or lazy-load JavaScript that is not used on this page.'],
  'third-party-summary': ['inp', 'Third-party code is busy on the main thread. Delay or drop the heaviest.'],
  'dom-size': ['inp', 'A large DOM slows every interaction. Simplify the markup or virtualise long lists.'],
};

const flat = (a) => (a.details?.items || []).flatMap((i) => i.items || [i]);
const label = (i) => {
  if (i.node) return { el: i.node.selector || i.node.nodeLabel || '', html: i.node.snippet || '' };
  const u = i.url || i.entity || i.source?.url || i.label;
  return { el: u ? String(u) : '' };
};
const note = (i) =>
  [
    i.wastedMs && `save ~${Math.round(i.wastedMs)} ms`,
    i.wastedBytes && `save ~${Math.round(i.wastedBytes / 1024)} KiB`,
    i.totalBytes && `${Math.round(i.totalBytes / 1024)} KiB`,
    i.duration && `${Math.round(i.duration)} ms long`,
    i.total && `${Math.round(i.total)} ms CPU`,
    i.mainThreadTime && `${Math.round(i.mainThreadTime)} ms main thread`,
    i.node && typeof i.score === 'number' && `shift score ${i.score.toFixed(3)}`,
  ].filter(Boolean).join(', ');

module.exports = async (req, res) => {
  let u;
  try {
    u = new URL(req.query.url);
    if (!/^https?:$/.test(u.protocol)) throw 0;
  } catch {
    return res.status(400).json({ error: 'Enter a full URL starting with http:// or https://' });
  }
  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';
  const q = new URLSearchParams({ url: u.href, strategy, category: 'performance' });
  if (process.env.PSI_API_KEY) q.set('key', process.env.PSI_API_KEY);

  try {
    const r = await fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + q);
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: d.error?.message || 'PageSpeed API error' });

    const lh = d.lighthouseResult, A = lh.audits;
    const has = (e) => e && e.metrics && Object.keys(e.metrics).length;
    const scope = has(d.loadingExperience) ? 'page' : has(d.originLoadingExperience) ? 'origin' : 'none';
    const fm = (scope === 'page' ? d.loadingExperience : scope === 'origin' ? d.originLoadingExperience : {}).metrics || {};

    const metrics = Object.keys(NAMES).map((k) => {
      const f = fm[FIELD[k]];
      const fv = f ? (k === 'cls' ? f.percentile / 100 : f.percentile) : null;
      const lv = A[LAB[k]]?.numericValue;
      return {
        key: k, name: NAMES[k],
        field: f ? { value: fv, rating: rate(k, fv) } : null,
        lab: lv != null ? { value: lv, rating: rate(k, lv) } : null,
      };
    });

    const findings = Object.entries(FIX).map(([id, [metric, fix]]) => {
      const a = A[id];
      if (!a) return null;
      const items = flat(a).map((x) => ({ ...label(x), note: note(x) })).filter((x) => x.el).slice(0, 5);
      const bad = id === 'layout-shifts' ? items.length > 0 : a.score != null && a.score < 0.9;
      if (!bad) return null;
      return { id, metric, title: a.title, value: a.displayValue || '', fix, savingsMs: a.details?.overallSavingsMs || 0, items };
    }).filter(Boolean).sort((a, b) => b.savingsMs - a.savingsMs);

    const le = flat(A['largest-contentful-paint-element'] || {}).find((i) => i.node);

    res.setHeader('Cache-Control', 's-maxage=300');
    res.json({
      url: u.href, finalUrl: lh.finalDisplayedUrl, strategy, fetchedAt: lh.fetchTime, scope,
      score: Math.round((lh.categories.performance.score || 0) * 100),
      metrics, findings, lcp: le ? label(le) : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the PageSpeed API. Try again in a moment.' });
  }
};
