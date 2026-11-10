// Tests for subs.js. Run: node extension/dev/test_parsers.mjs [--live]
// --live also fetches a real German YouTube video's caption list and checks track selection
// (the caption body itself needs YouTube's "pot" token, which only the in-page player has).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = new URL('.', import.meta.url);
const S = createRequire(import.meta.url)('../subs.js');
const fixture = (name) => readFileSync(new URL('fixtures/' + name, here), 'utf8');

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('ok   ', name);
  } catch (err) {
    failed++;
    console.log('FAIL ', name, '\n     ', err.message);
  }
}

await test('json3 manual track', () => {
  const lines = S.parseSubtitles(fixture('youtube_manual.json3'));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], { text: 'Guten Abend, meine Damen und Herren.', start: 0, end: 2.5 });
  assert.equal(lines[1].text, 'Die Regierung hat heute ein neues Gesetz beschlossen.');
  assert.equal(lines[1].end, 5.6);
  assert.equal(lines[2].text, 'Das Wetter: morgen "sonnig" – über 20 Grad.');
});

await test('real YouTube json3 (Tagesschau, fetched via the player URL with pot)', () => {
  const lines = S.parseSubtitles(fixture('youtube_real_tagesschau.json3'));
  assert.equal(lines.length, 14);
  assert.deepEqual(lines[0], { text: 'Guten Tag, hier ist die Tagesschau in 100 Sekunden.', start: 0, end: 3.86 });
  assert.equal(S.lineIndexAt(lines, 4.0), -1); // gap 3.86-4.16
  assert.equal(lines[S.lineIndexAt(lines, 30)].text.startsWith('Als Rwanda'), true);
  assert.ok(S.uniqueWords(lines).includes('Straße'));
});

await test('json3 auto-generated track: words joined, appends skipped, overlaps cut', () => {
  const lines = S.parseJson3(fixture('youtube_asr.json3'));
  assert.deepEqual(lines.map((l) => l.text), ['heute geht es um', 'die Wahl in Bayern', '[Musik]']);
  assert.equal(lines[0].start, 0.16);
  assert.equal(lines[0].end, 3); // cut at next line's start, not 4.16
  assert.equal(lines[1].end, 7.2);
});

await test('Netflix DFXP with ticks, <br/>, spans, entities, dur', () => {
  const lines = S.parseSubtitles(fixture('netflix.dfxp'));
  assert.deepEqual(lines, [
    { text: 'Wo warst du gestern Abend?', start: 1.001, end: 3.503 },
    { text: 'Ich war bei meiner Oma.', start: 3.6, end: 5.2 },
    { text: 'Tom & Jerry sind <nie> müde.', start: 6, end: 7.5 },
  ]);
});

await test('TTML clock times and frames', () => {
  const lines = S.parseTtml(fixture('netflix_clock.ttml'));
  assert.deepEqual(lines.map((l) => [l.start, l.end]), [[1.5, 3], [4, 5.48], [6, 7.5]]);
});

await test('Netflix WebVTT with CRLF, cue settings, tags, mm:ss times', () => {
  const lines = S.parseSubtitles(fixture('netflix.vtt'));
  assert.deepEqual(lines, [
    { text: 'Wo warst du gestern Abend?', start: 1.001, end: 3.503 },
    { text: 'Ich war bei meiner Oma.', start: 3.6, end: 5.2 },
    { text: 'Kurze Zeit&Raum', start: 62, end: 64.5 },
  ]);
});

await test('line timing: lineIndexAt', () => {
  const lines = S.parseJson3(fixture('youtube_manual.json3')); // 0-2.5, 2.5-5.6, 6-8, 9-10.5
  const at = (t) => S.lineIndexAt(lines, t);
  assert.equal(at(-1), -1);
  assert.equal(at(0), 0);
  assert.equal(at(2.49), 0);
  assert.equal(at(2.5), 1);
  assert.equal(at(5.8), -1); // gap
  assert.equal(at(7), 2);
  assert.equal(at(11), -1);
});

await test('A / S / D targets', () => {
  const lines = S.parseJson3(fixture('youtube_manual.json3'));
  const go = (t, k) => S.jumpTarget(lines, t, k);
  assert.equal(go(3, 'prev'), 0); // inside line 1 -> line 0
  assert.equal(go(3, 'replay'), 1);
  assert.equal(go(3, 'next'), 2);
  assert.equal(go(5.8, 'prev'), 1); // in gap after line 1 -> line 1
  assert.equal(go(5.8, 'replay'), 1);
  assert.equal(go(5.8, 'next'), 2);
  assert.equal(go(0.5, 'prev'), 0); // clamped at first line
  assert.equal(go(-1, 'next'), 0); // before first line
  assert.equal(go(10, 'next'), 3); // clamped at last line
  assert.equal(S.jumpTarget([], 3, 'next'), -1);
});

await test('tokenize keeps every character and finds German words', () => {
  const text = 'Wie geht’s? Das Café ist „super“ – 20 E-Mails, Straße!';
  const parts = S.tokenize(text);
  assert.equal(parts.map((p) => p.text).join(''), text);
  assert.deepEqual(parts.filter((p) => p.word).map((p) => p.text),
    ['Wie', 'geht’s', 'Das', 'Café', 'ist', 'super', 'E-Mails', 'Straße']);
});

await test('uniqueWords batches each word once per video', () => {
  const words = S.uniqueWords([{ text: 'Der Hund und der Hund' }, { text: 'Hund!' }]);
  assert.deepEqual(words, ['Der', 'Hund', 'und', 'der']);
});

await test('pickYouTubeTrack prefers manual German, accepts de-DE, falls back to asr', () => {
  const asr = { languageCode: 'de', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=de&kind=asr' };
  const manual = { languageCode: 'de-DE', baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=de-DE' };
  const en = { languageCode: 'en', baseUrl: 'u' };
  assert.equal(S.pickYouTubeTrack([en, asr, manual]), manual);
  assert.equal(S.pickYouTubeTrack([en, asr]), asr);
  assert.equal(S.pickYouTubeTrack([en]), null);
  assert.equal(S.pickYouTubeTrack(undefined), null);
  assert.equal(S.pickYouTubeTrack([{ languageCode: 'den' }]), null);
});

await test('youtubeJson3Url rewrites a captured player URL for the chosen track', () => {
  const captured = 'https://www.youtube.com/api/timedtext?v=abc&pot=TOKEN&lang=en&fmt=srv3&tlang=fr&kind=asr&sparams=ip,expire';
  const u = new URL(S.youtubeJson3Url(captured, { languageCode: 'de-DE' }));
  assert.equal(u.searchParams.get('fmt'), 'json3');
  assert.equal(u.searchParams.get('lang'), 'de-DE');
  assert.equal(u.searchParams.get('pot'), 'TOKEN');
  assert.equal(u.searchParams.get('tlang'), null);
  assert.equal(u.searchParams.get('kind'), null);
  const a = new URL(S.youtubeJson3Url('/api/timedtext?v=abc', { languageCode: 'de', kind: 'asr' }));
  assert.equal(a.searchParams.get('kind'), 'asr');
});

await test('pickNetflixTrack: German, not forced, subtitles over CC, WebVTT first, both URL shapes', () => {
  const m = JSON.parse(fixture('netflix_manifest.json')).result;
  assert.deepEqual(S.pickNetflixTrack(m.timedtexttracks), {
    format: 'webvtt-lssdh-ios8', url: 'https://ipv4-c002.1.nflxvideo.net/de.vtt',
  });
  const ccOnly = m.timedtexttracks.filter((t) => t.rawTrackType !== 'subtitles' || t.language !== 'de');
  assert.equal(S.pickNetflixTrack(ccOnly).url, 'https://ipv4-c001.1.nflxvideo.net/de-cc.vtt');
  assert.equal(S.pickNetflixTrack(m.timedtexttracks.filter((t) => t.language === 'en')), null);
});

await test('unknown format throws', () => {
  assert.throws(() => S.parseSubtitles('hello'));
});

if (process.argv.includes('--live')) {
  // Same selection path as the extension, but the caption list comes from the watch page HTML.
  await test('live: German YouTube video lists a German track that pickYouTubeTrack selects', async () => {
    const id = '-EWY7UjNTCg'; // tagesschau in 100 Sekunden, 1 Nov 2026
    const html = await (await fetch(`https://www.youtube.com/watch?v=${id}&hl=de`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' },
    })).text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|<\/script)/s);
    assert.ok(m, 'player response not found in page');
    const tracks = JSON.parse(m[1]).captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = S.pickYouTubeTrack(tracks);
    assert.ok(track, 'no German track: ' + tracks.map((t) => t.languageCode).join(','));
    console.log('      picked', track.languageCode, track.kind || 'manual');
    const r = await fetch(S.youtubeJson3Url(track.baseUrl, track));
    const body = await r.text();
    console.log(`      baseUrl without pot -> HTTP ${r.status}, ${body.length} bytes`
      + (body.length ? '' : ' (expected: the extension then uses the player\'s own URL)'));
    if (body.length) assert.ok(S.parseSubtitles(body).length > 0);
  });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
