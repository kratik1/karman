// Aeolian sonification — "hear the vortex street".
//
// The physical shedding period is ~1000-2000 lattice steps, i.e. sub-Hz in
// wall-clock time — inaudible. So we don't play the lift signal directly; we
// estimate its frequency + amplitude and use them to drive a synth tone that
// sits in the audible band. Pitch tracks shedding rate, gain tracks amplitude.

export class Aeolian {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.getSignal = null;      // () => { freqHz, amp, norm, silent }
    this._timer = null;
  }

  // getSignal returns the current estimate each update tick.
  attach(getSignal) { this.getSignal = getSignal; }

  toggle() { this.setEnabled(!this.enabled); return this.enabled; }

  setEnabled(on) {
    if (on) this._start(); else this._stop();
  }

  _start() {
    if (this.enabled) return;
    // AudioContext must be created/resumed from a user gesture (autoplay policy).
    if (!this.ctx) this._buildGraph();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.enabled = true;
    // Update pitch/gain ~4x/sec with setTargetAtTime — no zipper noise.
    this._timer = setInterval(() => this._update(), 250);
    this._update();
  }

  _stop() {
    this.enabled = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(0.0, t, 0.1); // ramp out, keep graph alive
    }
  }

  _buildGraph() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.sub = ctx.createOscillator();     // one octave down for body
    this.sub.type = 'sine';

    this.oscGain = ctx.createGain();
    this.subGain = ctx.createGain();
    this.oscGain.gain.value = 0.0;
    this.subGain.gain.value = 0.0;

    this.lp = ctx.createBiquadFilter();    // gentle lowpass ~2x tone
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 600;
    this.lp.Q.value = 0.7;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;

    this.osc.connect(this.oscGain).connect(this.lp);
    this.sub.connect(this.subGain).connect(this.lp);
    this.lp.connect(this.master).connect(ctx.destination);

    this.osc.start();
    this.sub.start();
  }

  _update() {
    if (!this.enabled || !this.ctx || !this.getSignal) return;
    const sig = this.getSignal();
    const t = this.ctx.currentTime;
    const tc = 0.1; // smoothing time constant

    if (!sig || sig.silent) {
      this.master.gain.setTargetAtTime(0.0, t, tc);
      return;
    }

    // Pitch-scale so the default cylinder sings ~130-500 Hz.
    const tone = Math.min(2000, Math.max(40, sig.freqHz * 600));
    this.osc.frequency.setTargetAtTime(tone, t, tc);
    this.sub.frequency.setTargetAtTime(tone * 0.5, t, tc);
    this.lp.frequency.setTargetAtTime(Math.min(8000, tone * 2), t, tc);

    // Amplitude -> gain, normalized against 0.5*rho*U^2*D so it can't blow out.
    const g = Math.min(1.0, sig.amp / Math.max(sig.norm, 1e-6));
    this.oscGain.gain.setTargetAtTime(0.5, t, tc);
    this.subGain.gain.setTargetAtTime(0.28, t, tc);
    this.master.gain.setTargetAtTime(0.22 * g, t, tc);
  }
}
