> [!IMPORTANT]
> **This project is a test of LLM capabilities. I take no credit for the work.** — Rakantor

> Built by Claude (Opus 5.5) in Claude Code from [PROMPT.md](PROMPT.md) in a single run of about 50 minutes: about 13 minutes of planning, 14 of writing the code and 22 of testing it in a browser. A later session fixed cells overlapping during the 100k stress test.

<br>

# Nested Cells

A browser prototype of a microorganism world made of living cells nested inside one another. Every cell holds a colony of smaller cells; zooming out reveals that the world you were looking at is the inside of a larger cell drifting among its neighbours. Zooming between levels is continuous, with no cuts or loading pauses.

The full design brief is in [PROMPT.md](PROMPT.md).

## Running

Plain JavaScript with no build step or dependencies. Serve the folder with any static file server and open `index.html`:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>. It needs WebGL2 with float render targets (`EXT_color_buffer_float`).

## Controls

| Input | Action |
|---|---|
| Drag | Pan |
| Mouse wheel / trackpad pinch | Zoom around the cursor |
| Two-finger scroll (Trackpad mode) | Pan |
| Right-click and hold on a cell | Split it into two |
| M | Show or hide the tuning panel |

The Mouse / Trackpad toggle in the help bar switches what the scroll wheel does and is remembered between visits. Only one cell per colony, the container, can be zoomed into; it holds the next world down.

The tuning panel has live sliders, colour pickers for every palette, and three buttons: **Divide all here**, **Grow here to 100k** (stress test) and **Copy settings** (tunables and palettes as JSON).

## Code layout

| File | Responsibility |
|---|---|
| `js/config.js` | Tunable constants, palettes and the slider list |
| `js/gl.js` | Small WebGL2 helpers |
| `js/shaders.js` | GLSL ES 3.00 sources: solver, neighbour grid, cells, containers, particles, noise |
| `js/camera.js` | Camera and double-precision 2-D similarity transforms |
| `js/world.js` | One level: population, GPU state, divisions, CPU-driven container, colony expansion |
| `js/input.js` | Pointer, wheel, pinch, keyboard |
| `js/ui.js` | Help bar and tuning panel |
| `js/main.js` | Frame loop, camera following and frame switching, nested rendering, picking, stress test |

All cell state and physics live on the GPU in RGBA32F textures. The only readback is the right-click pick.

## Development

Append `?noadapt` to the URL to turn off adaptive resolution. This is useful when testing under a software renderer, which would otherwise drop the resolution to 50%.
