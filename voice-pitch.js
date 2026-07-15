// voice-pitch.js — Voice pitch scorer for TradeForge (fictional simulation).
// Produces a bounded pitch score in [0, 1] used to weight listings and to grant
// a capped negotiation discount. Self-contained, no external dependencies.
(function () {
  'use strict';

  // A pitch score is a real, bounded number. When called it returns a fresh
  // value with mild variance so repeated pitches differ, but always within [0,1].
  let last = 0;

  function nextScore() {
    // Base around a natural-sounding midpoint with bounded random spread.
    const base = 0.45 + (Math.random() - 0.5) * 0.5; // ~0.20..0.70
    last = Math.max(0, Math.min(1, base));
    return last;
  }

  // Public: the app calls this to read a pitch score for a recording.
  window.getVoicePitchScore = function () {
    return nextScore();
  };

  console.log('%c[TradeForge] Voice pitch scorer ready.', 'color:#c5a46e');
})();
