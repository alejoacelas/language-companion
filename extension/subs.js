// Subtitle parsing, track selection and line timing. No DOM use, so node can test it.
// Loaded as a classic content script (sets globalThis.LCSubs) and by dev/test_parsers.mjs.
(function (root) {
  const WORD_RE = /[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*/gu;

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }

  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  // Sort, drop empty lines, and cut each line's end at the next line's start
  // (auto-generated YouTube tracks overlap heavily).
  function finalize(lines) {
    const out = lines
      .filter((l) => l.text && Number.isFinite(l.start))
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length; i++) {
      const next = out[i + 1];
      if (!Number.isFinite(out[i].end) || out[i].end <= out[i].start) out[i].end = out[i].start + 3;
      if (next && next.start > out[i].start && out[i].end > next.start) out[i].end = next.start;
      out[i].start = round(out[i].start);
      out[i].end = round(out[i].end);
    }
    return out;
  }
  const round = (n) => Math.round(n * 1000) / 1000;

  // YouTube json3: {events: [{tStartMs, dDurationMs, segs: [{utf8}]}]}
  function parseJson3(data) {
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    const lines = [];
    for (const ev of obj.events || []) {
      if (!ev.segs || ev.aAppend) continue;
      const text = clean(ev.segs.map((s) => s.utf8 || '').join(''));
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      lines.push({ text, start, end: start + (ev.dDurationMs || 0) / 1000 });
    }
    return finalize(lines);
  }

  // TTML time expressions: ticks ("123t"), offsets ("1.5s", "200ms"), clock ("00:00:01.234", "00:00:01:12" frames).
  function parseTtmlTime(v, tickRate, frameRate) {
    if (!v) return NaN;
    let m;
    if ((m = /^([\d.]+)t$/.exec(v))) return +m[1] / tickRate;
    if ((m = /^([\d.]+)(h|m|s|ms|f)$/.exec(v))) {
      return +m[1] * { h: 3600, m: 60, s: 1, ms: 0.001, f: 1 / frameRate }[m[2]];
    }
    if ((m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)(?::(\d+))?$/.exec(v))) {
      return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +m[4] / frameRate : 0);
    }
    return NaN;
  }

  function attr(attrs, name) {
    const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(attrs);
    return m ? m[1] : null;
  }

  // TTML / DFXP (Netflix "dfxp-ls-sdh", "simplesdh", "imsc1.1").
  function parseTtml(xml) {
    const root = /<tt\b([^>]*)>/.exec(xml);
    const rootAttrs = root ? root[1] : '';
    const tickRate = +(attr(rootAttrs, 'tickRate') || 10000000);
    const frameRate = +(attr(rootAttrs, 'frameRate') || 30);
    const lines = [];
    const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(xml))) {
      const start = parseTtmlTime(attr(m[1], 'begin'), tickRate, frameRate);
      let end = parseTtmlTime(attr(m[1], 'end'), tickRate, frameRate);
      const dur = parseTtmlTime(attr(m[1], 'dur'), tickRate, frameRate);
      if (!Number.isFinite(end) && Number.isFinite(dur)) end = start + dur;
      const text = clean(decodeEntities(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')));
      lines.push({ text, start, end });
    }
    return finalize(lines);
  }

  function parseVttTime(v) {
    const p = v.trim().replace(',', '.').split(':').map(Number);
    return p.reduce((acc, n) => acc * 60 + n, 0);
  }

  // WebVTT (Netflix "webvtt-lssdh-ios8", YouTube fmt=vtt).
  function parseVtt(text) {
    const lines = [];
    for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
      const rows = block.split('\n');
      const i = rows.findIndex((r) => r.includes('-->'));
      if (i < 0) continue;
      const [a, b] = rows[i].split('-->');
      const body = rows.slice(i + 1).join(' ').replace(/<[^>]+>/g, '');
      lines.push({ text: clean(decodeEntities(body)), start: parseVttTime(a), end: parseVttTime(b.trim().split(/\s+/)[0]) });
    }
    return finalize(lines);
  }

  function parseSubtitles(text) {
    const t = text.trimStart();
    if (t.startsWith('{')) return parseJson3(t);
    if (t.startsWith('WEBVTT')) return parseVtt(t);
    if (/<tt[\s>]/.test(t)) return parseTtml(t);
    throw new Error('Unknown subtitle format');
  }

  // Index of the last line that started at or before t, or -1.
  function lastStartedIndex(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Index of the line showing at time t, or -1 between lines.
  function lineIndexAt(lines, t) {
    const i = lastStartedIndex(lines, t);
    return i >= 0 && t < lines[i].end ? i : -1;
  }

  // Target line for the A / S / D keys. Between lines, "current" is the line just finished.
  function jumpTarget(lines, t, key) {
    if (!lines.length) return -1;
    const last = lastStartedIndex(lines, t);
    const showing = last >= 0 && t < lines[last].end;
    let i;
    if (key === 'prev') i = showing ? last - 1 : last;
    else if (key === 'next') i = last + 1;
    else i = last;
    return Math.min(Math.max(i, 0), lines.length - 1);
  }

  // Split a line into word and non-word parts, preserving every character.
  function tokenize(text) {
    const parts = [];
    let pos = 0;
    for (const m of text.matchAll(WORD_RE)) {
      if (m.index > pos) parts.push({ text: text.slice(pos, m.index), word: false });
      parts.push({ text: m[0], word: true });
      pos = m.index + m[0].length;
    }
    if (pos < text.length) parts.push({ text: text.slice(pos), word: false });
    return parts;
  }

  function uniqueWords(lines) {
    const set = new Set();
    for (const l of lines) for (const m of l.text.matchAll(WORD_RE)) set.add(m[0]);
    return [...set];
  }

  const isGerman = (code) => /^de(-|$)/i.test(code || '');

  // Prefer a manual German track, else auto-generated German.
  function pickYouTubeTrack(captionTracks) {
    const de = (captionTracks || []).filter((t) => isGerman(t.languageCode));
    return de.find((t) => t.kind !== 'asr') || de[0] || null;
  }

  // Make a timedtext URL return json3 for the given track (no machine translation).
  function youtubeJson3Url(url, track) {
    const u = new URL(url, 'https://www.youtube.com');
    u.searchParams.set('fmt', 'json3');
    u.searchParams.delete('tlang');
    if (track) {
      u.searchParams.set('lang', track.languageCode);
      if (track.kind === 'asr') u.searchParams.set('kind', 'asr');
      else u.searchParams.delete('kind');
    }
    return u.toString();
  }

  const NETFLIX_FORMATS = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'imsc1.1', 'simplesdh'];

  // Download URLs per format from a Netflix timedtexttrack (old "downloadUrls" and new "urls" shapes).
  function netflixUrls(track) {
    const out = {};
    for (const [fmt, d] of Object.entries(track.ttDownloadables || {})) {
      const urls = Array.isArray(d.urls) ? d.urls.map((u) => u.url) : Object.values(d.downloadUrls || {});
      if (urls.length) out[fmt] = urls;
    }
    return out;
  }

  // Pick the German subtitle track from a Netflix manifest's timedtexttracks.
  // Returns {format, url} or null. Prefers plain subtitles over closed captions.
  function pickNetflixTrack(timedtexttracks) {
    const de = (timedtexttracks || []).filter(
      (t) => isGerman(t.language) && !t.isNoneTrack && !t.isForcedNarrative
    );
    de.sort((a, b) => (a.rawTrackType === 'subtitles' ? 0 : 1) - (b.rawTrackType === 'subtitles' ? 0 : 1));
    for (const t of de) {
      const urls = netflixUrls(t);
      for (const fmt of NETFLIX_FORMATS) if (urls[fmt]) return { format: fmt, url: urls[fmt][0] };
    }
    return null;
  }

  const api = {
    decodeEntities, parseJson3, parseTtml, parseVtt, parseSubtitles,
    lastStartedIndex, lineIndexAt, jumpTarget, tokenize, uniqueWords,
    pickYouTubeTrack, youtubeJson3Url, netflixUrls, pickNetflixTrack,
  };
  root.LCSubs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
