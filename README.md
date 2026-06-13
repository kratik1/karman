<div align="center">

# kármán

**A real-time fluid simulator that runs entirely on your GPU — in a browser tab.**

The Navier–Stokes equations, solved 10× a frame by hand-written WebGL2 shaders. Drag your mouse through the fluid and watch vortices peel off in real time.

<img src="media/hero-vortex-street.jpg" width="640" alt="A von Kármán vortex street shed by a cylinder, rendered as a vorticity field">

*A von Kármán vortex street: alternating clockwise (blue) and counter-clockwise (orange) vortices shed by a cylinder in cross-flow. This image is a live frame, not a pre-render.*

</div>

---

## Run it

It's a static page — no build step, no dependencies, no server-side anything.

```bash
git clone <this-repo> && cd karman
npx http-server          # or: python3 -m http.server
# open the printed localhost URL
```

**Or host it for free:** push to GitHub, then *Settings → Pages → Deploy from branch → main*. The whole thing is `index.html` + a few hundred lines of JS and GLSL, so GitHub Pages serves it as-is.

> Needs a WebGL2 context with float render targets (`EXT_color_buffer_float`) — every current desktop browser, and most mobile ones.

## Controls

| | |
|---|---|
| **Drag** | Stir the fluid — inject momentum and dye |
| **Shift-drag** | Draw a solid obstacle; flow re-forms around it |
| **Right-drag** | Erase obstacles |
| `1` `2` `3` | Switch field: dye · vorticity · speed |
| `Space` | Pause · `R` reset · `H` hide UI |

Presets in the panel: a cylinder (the classic vortex-street generator), a NACA 0012 airfoil at angle of attack, a slalom of pillars, and an empty sandbox. The viscosity slider sweeps the Reynolds number live — turn it down and the wake goes from a tidy laminar street to a chaotic turbulent one.

## How it works

This is the **Lattice-Boltzmann Method (LBM)** — a different beast from the finite-difference schemes most people reach for. Instead of discretising the Navier–Stokes equations directly, LBM simulates a fictitious gas of particle *populations* streaming and colliding on a regular lattice. The remarkable part: in the limit of small Mach number, the macroscopic behaviour of this toy gas provably *is* incompressible Navier–Stokes (via the Chapman–Enskog expansion). You get real fluid dynamics out of arithmetic that's almost embarrassingly local and parallel — which is exactly what a GPU wants.

**The D2Q9 lattice.** Each cell holds nine numbers `fᵢ` — the density of particles moving along nine discrete directions (rest, 4 axial, 4 diagonal):

```
  6   2   5
    ╲ │ ╱
  3 ─ 0 ─ 1
    ╱ │ ╲
  7   4   8
```

Macroscopic density and velocity are just moments of these populations:

```
ρ  = Σ fᵢ
ρu = Σ fᵢ eᵢ
```

**Each timestep is two operations:**

1. **Collide** — relax every population toward its local Maxwell–Boltzmann equilibrium with a single relaxation time τ (the BGK approximation):
   ```
   fᵢ ← fᵢ + (1/τ)(fᵢᵉ𐞥 − fᵢ),   fᵢᵉ𐞥 = wᵢ ρ [1 + 3(eᵢ·u) + 4.5(eᵢ·u)² − 1.5 u·u]
   ```
2. **Stream** — every population hops to the neighbouring cell in its direction.

The kinematic viscosity falls straight out of the relaxation time:

```
ν = cₛ² (τ − ½),   cₛ² = 1/3
```

so the viscosity slider in the UI is literally setting τ, and the Reynolds-number readout is `Re = U·L/ν`.

**Boundaries.** Solid walls and obstacles use **half-way bounce-back**: a population that would stream into a solid cell is reflected back the way it came, which enforces a no-slip condition to second-order accuracy. The inlet is a fixed-velocity (Zou/He-style) condition; the outlet is zero-gradient.

### On the GPU

The entire state lives in floating-point textures. The nine populations are packed across three `RGBA32F` textures, and one collide-and-stream pass per substep ping-pongs between two such triplets using multiple render targets. Streaming is done in *gather* form — each cell pulls from its neighbours — so there's no separate streaming pass and no race conditions. The dye you see is a passive scalar advected semi-Lagrangianly by the velocity field; vorticity is computed on the fly as the curl of velocity in the display shader.

At the default grid this is on the order of **10⁷ lattice-site updates per frame** at 60 fps — the kind of throughput that's only sane because every cell's update is independent. The live HUD reports the achieved MLUPS (mega-lattice-updates per second).

## Why it looks the way it does

The von Kármán vortex street isn't scripted — it's an *instability*. Above a critical Reynolds number (~47 for a cylinder) the steady wake stops being stable, and the smallest asymmetry blows up into the self-sustaining, alternating shedding you see. The simulation is seeded with a whisper of asymmetry at startup so it doesn't have to wait for numerical noise to break the symmetry, but everything after that is the physics finding its own way.

## Project layout

```
index.html              page shell + control panel
src/
  gl.js                 WebGL2 helpers: shaders, float textures, MRT framebuffers
  lbm.js                simulation state + per-frame pass orchestration
  render.js             dye advection + final compositing
  presets.js            obstacle masks (cylinder, NACA airfoil, pillars)
  main.js               app loop, pointer input, UI
  shaders/
    common.glsl.js       D2Q9 lattice constants + equilibrium
    sim.glsl.js          init / BGK collision / streaming + boundaries
    render.glsl.js       dye advection + colormaps (vorticity, speed, dye)
```

## References

- T. Krüger et al., *The Lattice Boltzmann Method: Principles and Practice* (Springer, 2017) — the standard modern reference.
- Q. Zou & X. He, "On pressure and velocity boundary conditions for the lattice Boltzmann BGK model," *Phys. Fluids* **9**, 1591 (1997) — the inlet/outlet boundary conditions.
- P. Bhatnagar, E. Gross, M. Krook, "A model for collision processes in gases," *Phys. Rev.* **94**, 511 (1954) — the BGK collision operator.

## License

MIT — do whatever you like with it.
