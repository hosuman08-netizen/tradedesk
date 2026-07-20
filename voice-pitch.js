// voice-pitch.js — Voice pitch scorer for TradeForge (fictional simulation).
// Produces a bounded pitch score in [0, 1] used to weight listings and to grant
// a capped negotiation discount. Self-contained, no external dependencies.
//
// The score is REAL: it is computed from the actual recorded audio. A pitch that
// is louder, more sustained, and more expressive (more pitch/energy variation)
// scores higher. If no audio is available, a small neutral fallback is returned.
// Code and UI match 100% — "a stronger pitch earns a bigger discount" is genuine.
(function () {
  'use strict';

  let last = 0;

  // Analyze a decoded audio buffer and return a bounded score in [0,1].
  // Three honest signals, blended:
  //   loudness   — RMS energy (did you actually speak up?)
  //   sustain    — fraction of the clip above a speech threshold (did you keep going?)
  //   expression — variation of short-frame energy (was it flat or dynamic?)
  function scoreFromSamples(data, sampleRate) {
    const n = data.length;
    if (!n) return 0;

    // Overall RMS loudness.
    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += data[i] * data[i];
    const rms = Math.sqrt(sumSq / n);

    // Frame-by-frame energy for sustain + expression (≈20ms frames).
    const frame = Math.max(1, Math.floor(sampleRate * 0.02));
    const energies = [];
    for (let i = 0; i < n; i += frame) {
      let e = 0;
      const end = Math.min(n, i + frame);
      for (let j = i; j < end; j++) e += data[j] * data[j];
      energies.push(Math.sqrt(e / (end - i)));
    }

    const SPEECH = 0.012; // below this a frame is treated as silence/noise floor
    const voiced = energies.filter(e => e > SPEECH).length;
    const sustain = energies.length ? voiced / energies.length : 0;

    // Expression = coefficient of variation of the voiced frames (dynamic > flat).
    const voicedE = energies.filter(e => e > SPEECH);
    let expression = 0;
    if (voicedE.length > 1) {
      const mean = voicedE.reduce((a, b) => a + b, 0) / voicedE.length;
      const varc = voicedE.reduce((a, b) => a + (b - mean) * (b - mean), 0) / voicedE.length;
      expression = mean > 0 ? Math.sqrt(varc) / mean : 0;
    }

    // Normalize each signal to ~[0,1] against realistic speech ranges, then blend.
    const nLoud = Math.min(1, rms / 0.15);        // ~0.15 RMS ≈ a confident voice
    const nSust = Math.min(1, sustain / 0.6);     // speaking 60%+ of the clip = full
    const nExpr = Math.min(1, expression / 0.9);  // lively delivery = full

    const score = 0.45 * nLoud + 0.30 * nSust + 0.25 * nExpr;
    return Math.max(0, Math.min(1, score));
  }

  // Public: analyze a recorded Blob and resolve to a real score in [0,1].
  // Falls back to a small neutral value if the audio can't be decoded.
  window.analyzeVoiceBlob = function (blob) {
    return new Promise(resolve => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!blob || !Ctx || !blob.arrayBuffer) { resolve(0.3); return; }
      blob.arrayBuffer().then(buf => {
        const ctx = new Ctx();
        ctx.decodeAudioData(
          buf,
          audioBuf => {
            const s = scoreFromSamples(audioBuf.getChannelData(0), audioBuf.sampleRate);
            last = s;
            ctx.close && ctx.close();
            resolve(s);
          },
          () => { ctx.close && ctx.close(); resolve(0.3); }
        );
      }).catch(() => resolve(0.3));
    });
  };

  // Legacy sync hook (used only when no audio blob is available). Returns the
  // last real measurement if there is one, else a small neutral fallback.
  window.getVoicePitchScore = function () {
    return last > 0 ? last : 0.3;
  };

  console.log('%c[TradeForge] Voice pitch scorer ready.', 'color:#c5a46e');
})();
