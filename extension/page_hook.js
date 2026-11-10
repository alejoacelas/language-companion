// Runs in the page's main world at document_start. Talks to content.js via window.postMessage.
// YouTube: reads the player response, captures the player's own timedtext URLs (they carry the
// "pot" token YouTube now requires), turns captions on when asked, seeks.
// Netflix: keeps the subtitle files the player downloads, selects German, controls the player.
(() => {
  const post = (msg) => window.postMessage({ source: 'lc-hook', ...msg }, '*');
  const isNetflix = location.hostname.includes('netflix');

  if (!isNetflix) {
    const timedtext = {}; // videoId -> last captured timedtext URL
    const note = (url) => {
      try {
        if (!url || !String(url).includes('/api/timedtext')) return;
        const u = new URL(String(url), location.href);
        if (!u.searchParams.get('pot')) return;
        const videoId = u.searchParams.get('v');
        timedtext[videoId] = u.toString();
        post({ type: 'yt-timedtext-url', videoId, url: u.toString() });
      } catch {}
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      note(url);
      return open.apply(this, arguments);
    };
    const fetch0 = window.fetch;
    window.fetch = function (input) {
      note(typeof input === 'string' ? input : input && input.url);
      return fetch0.apply(this, arguments);
    };

    const player = () => document.getElementById('movie_player');

    window.addEventListener('message', async (e) => {
      const d = e.data;
      if (e.source !== window || !d || d.source !== 'lc-content') return;
      if (d.type === 'yt-get-player') {
        // The player response can lag behind SPA navigation; wait until it matches the video.
        for (let i = 0; i < 40; i++) {
          const pr = player()?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
          if (pr?.videoDetails?.videoId === d.videoId) {
            post({
              type: 'yt-player', reqId: d.reqId, videoId: d.videoId,
              title: pr.videoDetails.title || document.title,
              captionTracks: pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [],
              timedtextUrl: timedtext[d.videoId] || null,
            });
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        post({ type: 'yt-player', reqId: d.reqId, videoId: d.videoId, error: 'no player response' });
      } else if (d.type === 'yt-enable-captions') {
        // Makes the player fetch the track itself, which reveals a timedtext URL with "pot".
        const p = player();
        try {
          p.loadModule?.('captions');
          p.setOption?.('captions', 'track', { languageCode: d.languageCode, kind: d.kind });
        } catch {}
      }
    });
    return;
  }

  // ---- Netflix ----
  // Netflix downloads a whole subtitle file (TTML or WebVTT) the first time a text track is
  // selected. We keep every file it fetches and select the German track ourselves.
  const files = []; // {movieId, lang, text}

  function nfPlayer() {
    const vp = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const ids = vp?.getAllPlayerSessionIds?.() || [];
    return ids.length ? vp.getVideoPlayerBySessionId(ids[ids.length - 1]) : null;
  }

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        let text = null;
        if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
        else if (this.responseType === 'arraybuffer' && this.response.byteLength < 5e6) {
          text = new TextDecoder().decode(new Uint8Array(this.response));
        }
        const head = text ? text.slice(0, 3000) : '';
        if (!/<tt[\s>]|^WEBVTT/.test(head)) return;
        const p = nfPlayer();
        const lang = (head.match(/xml:lang="([^"]+)"/) || [])[1] || p?.getTimedTextTrack?.()?.bcp47 || '';
        files.push({ movieId: String(p?.getMovieId?.() || ''), lang, text });
      } catch {}
    });
    return send.apply(this, arguments);
  };

  // The full German file for this movie. Forced-narrative files are German too but tiny; take the largest.
  function germanFile(movieId) {
    const de = files.filter((f) => f.movieId === movieId && f.lang.toLowerCase().startsWith('de'));
    return de.sort((a, b) => b.text.length - a.text.length)[0] || null;
  }

  // "Dark S1E1: Secrets" for an episode, the plain title for a film.
  function nfTitle(movieId) {
    try {
      const v = window.netflix.appContext.state.playerApp.getState().videoPlayer.videoMetadata[movieId]._metadataObject.video;
      for (const season of v.seasons || []) {
        for (const ep of season.episodes || []) {
          if (String(ep.id || ep.episodeId) === movieId) return `${v.title} S${season.seq}E${ep.seq}: ${ep.title}`;
        }
      }
      return v.title || null;
    } catch {
      return null;
    }
  }

  async function getSubs(reqId) {
    let asked = false;
    for (let i = 0; i < 50; i++) {
      const p = nfPlayer();
      const movieId = String(p?.getMovieId?.() || '');
      const tracks = p?.getTimedTextTrackList?.() || [];
      if (movieId && tracks.length) {
        const de = tracks.filter((t) => t.bcp47?.toLowerCase().startsWith('de') && !t.isForcedNarrative && !t.isNoneTrack);
        if (!de.length) return post({ type: 'nf-subs', reqId, movieId, title: nfTitle(movieId), text: null });
        const got = germanFile(movieId);
        if (got && got.text.length > 5000) return post({ type: 'nf-subs', reqId, movieId, title: nfTitle(movieId), text: got.text });
        if (!asked) {
          // Regular German subtitles if offered, else German closed captions (e.g. German originals).
          const pick = de.find((t) => t.trackType === 'PRIMARY') || de[0];
          if (p.getTimedTextTrack?.()?.trackId !== pick.trackId) p.setTimedTextTrack(pick);
          asked = true;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    post({ type: 'nf-subs', reqId, error: 'Netflix did not load its German subtitle file' });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'lc-content') return;
    if (d.type === 'nf-get-subs') getSubs(d.reqId);
    else if (d.type === 'nf-seek') nfPlayer()?.seek(Math.round(d.seconds * 1000));
    else if (d.type === 'nf-pause') nfPlayer()?.pause();
    else if (d.type === 'nf-play') nfPlayer()?.play();
  });
})();
