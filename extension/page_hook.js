// Runs in the page's main world at document_start. Talks to content.js via window.postMessage.
// YouTube: reads the player response, captures the player's own timedtext URLs (they carry the
// "pot" token YouTube now requires), turns captions on when asked, seeks.
// Netflix: asks the manifest for WebVTT/DFXP subtitles, captures timedtexttracks, controls the player.
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
  const manifests = {}; // movieId -> timedtexttracks

  const stringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      const params = value && value.params;
      if (params && Array.isArray(params.profiles)) {
        for (const p of ['webvtt-lssdh-ios8', 'dfxp-ls-sdh']) if (!params.profiles.includes(p)) params.profiles.push(p);
        params.showAllSubDubTracks = true;
      }
    } catch {}
    return stringify.apply(this, arguments);
  };

  const parse = JSON.parse;
  JSON.parse = function () {
    const value = parse.apply(this, arguments);
    try {
      const m = value && (value.result && value.result.timedtexttracks ? value.result : value.timedtexttracks ? value : null);
      if (m && m.movieId) {
        const movieId = String(m.movieId);
        manifests[movieId] = m.timedtexttracks;
        post({ type: 'nf-tracks', movieId, tracks: m.timedtexttracks });
      }
    } catch {}
    return value;
  };

  function nfPlayer() {
    const vp = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const ids = vp?.getAllPlayerSessionIds?.() || [];
    return ids.length ? vp.getVideoPlayerBySessionId(ids[ids.length - 1]) : null;
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'lc-content') return;
    if (d.type === 'nf-get-tracks' && manifests[d.movieId]) {
      post({ type: 'nf-tracks', movieId: d.movieId, tracks: manifests[d.movieId] });
    } else if (d.type === 'nf-seek') {
      nfPlayer()?.seek(Math.round(d.seconds * 1000));
    } else if (d.type === 'nf-pause') {
      nfPlayer()?.pause();
    } else if (d.type === 'nf-play') {
      nfPlayer()?.play();
    }
  });
})();
