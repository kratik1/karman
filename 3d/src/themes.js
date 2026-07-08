// Full color themes. Each theme drives the volume renderer (background,
// colormap, emission/absorption balance), the dye jets, the tracer streaks,
// and the UI accent per render mode.

export const THEMES = {
  nightlab: {
    label: 'Nightlab',
    accents: ['#5ac8ff', '#ff9046', '#ffce56', '#8affc1'],
    bg0: [0.016, 0.020, 0.032], bg1: [0.043, 0.055, 0.083],
    cold: [0.15, 0.50, 1.00], hot: [1.00, 0.42, 0.10],
    slow: [0.10, 0.38, 1.00], fast: [1.00, 0.86, 0.45],
    jetA: [0.25, 0.85, 1.00], jetB: [0.85, 0.40, 1.00],
    wire: [0.16, 0.19, 0.26],
    emission: 1.0, absorb: 1.0,
  },
  ember: {
    label: 'Ember',
    accents: ['#ffb35c', '#ff7a3d', '#ffd97a', '#ff9b6b'],
    bg0: [0.022, 0.014, 0.010], bg1: [0.055, 0.035, 0.028],
    cold: [0.38, 0.05, 0.02], hot: [1.00, 0.76, 0.34],
    slow: [0.45, 0.10, 0.03], fast: [1.00, 0.80, 0.40],
    jetA: [1.00, 0.45, 0.12], jetB: [0.95, 0.15, 0.10],
    wire: [0.22, 0.16, 0.13],
    emission: 1.0, absorb: 1.0,
  },
  hologram: {
    label: 'Hologram',
    accents: ['#41f0d9', '#2cc7ff', '#9ef7e8', '#5ce1ff'],
    bg0: [0.000, 0.018, 0.024], bg1: [0.000, 0.048, 0.062],
    cold: [0.00, 0.30, 0.34], hot: [0.42, 1.00, 0.94],
    slow: [0.02, 0.30, 0.32], fast: [0.55, 1.00, 0.95],
    jetA: [0.10, 0.85, 0.80], jetB: [0.55, 1.00, 0.95],
    wire: [0.08, 0.26, 0.28],
    emission: 1.0, absorb: 1.0,
  },
  ivory: {
    label: 'Ivory',
    light: true,                   // streaks blend subtractively (ink, not light)
    accents: ['#3b5bdb', '#e8590c', '#c2255c', '#0b7285'],
    bg0: [0.905, 0.895, 0.870], bg1: [0.985, 0.980, 0.965],
    cold: [0.16, 0.22, 0.52], hot: [0.86, 0.24, 0.10],
    slow: [0.60, 0.55, 0.33],      // pigment: paper minus indigo
    fast: [0.09, 0.55, 0.62],      // pigment: paper minus vermilion
    jetA: [0.20, 0.30, 0.62], jetB: [0.80, 0.22, 0.30],
    wire: [0.72, 0.70, 0.66],
    emission: 0.55, absorb: 2.4,   // ink on paper: absorb more, glow less
  },
  synthwave: {
    label: 'Synthwave',
    accents: ['#ff4fd8', '#00e5ff', '#b388ff', '#ff8a00'],
    bg0: [0.045, 0.012, 0.085], bg1: [0.105, 0.030, 0.155],
    cold: [0.15, 0.35, 1.00], hot: [1.00, 0.16, 0.62],
    slow: [0.20, 0.40, 1.00], fast: [1.00, 0.30, 0.80],
    jetA: [0.05, 0.90, 1.00], jetB: [1.00, 0.30, 0.85],
    wire: [0.26, 0.14, 0.34],
    emission: 1.0, absorb: 1.0,
  },
};

export const DEFAULT_THEME = 'ivory';
