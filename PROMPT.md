# Nested Cells: Browser Prototype Brief

Build a browser-based prototype of a microorganism game. This brief describes what the finished product must look and feel like. It also fixes the technical decisions the result depends on, and gives tuned starting values. Where it leaves a detail open, choose whatever technique best meets the stated behaviour.

Units: distances are given in cell radii, where one radius is a typical cell's half-width (its semi-minor axis). Speeds are in radii per second. "Screen" means the shorter side of the browser window.

## Concept
The world is made of living cells nested inside one another. Every cell is a small world of its own: inside it, a colony of smaller cells drifts around. Zooming out reveals that the world you were looking at is the inside of a larger cell, which itself drifts among dozens of other large cells. Zooming between levels is continuous and smooth, with no cuts, fades to black or loading pauses.

## Technology
- Plain vanilla JavaScript loaded with ordinary script tags. No frameworks, libraries, package manager, modules or build step. It must run from any static file server.
- WebGL2 with float render targets (the colour-buffer-float extension). If either is missing, show a short centred message saying the demo needs WebGL2 with float render targets, instead of the help bar.
- Shaders are written in GLSL ES 3.00 and kept as strings in the JavaScript.
- If the WebGL context is lost, reload the page when it is restored.
- Split the code into a handful of files by responsibility:
  - tunable constants and palettes;
  - small WebGL helpers;
  - shader sources;
  - camera and 2-D similarity transforms;
  - a world, meaning one level and its population;
  - input;
  - user interface;
  - the main application.

## What the player sees on load
- A full-screen view of the inner world: pink/magenta cells drifting around on a deep plum background.
  - The view starts zoomed in so the shorter side of the screen spans about 14 radii, which is a handful of cells across.
  - The colony around the view continues beyond the screen edges.
- Small glowing particles float slowly through the scene.
- A small, unobtrusive help bar sits at the bottom centre of the screen. It is a rounded pill, semi-transparent with a light background blur, and it becomes more opaque on hover. In one line it shows:
  - the pan control;
  - the zoom control;
  - "Right-click & hold: split";
  - "M: menu";
  - a two-option Mouse / Trackpad segmented toggle.
  The pan and zoom labels follow the input mode: "Drag: pan" and "Wheel: zoom" for Mouse; "Drag / two-finger scroll: pan" and "Pinch: zoom" for Trackpad.
- Nothing else is on screen: no score and no HUD. The tuning panel stays hidden until the player presses M.

## Controls (this is the complete list)
- **Click and drag:** pan the camera.
  - Releasing during a quick drag leaves a little inertia, which decays within a fraction of a second.
  - A drag that had stopped before release leaves none.
- **Mouse wheel or trackpad pinch:** zoom smoothly, centred on the cursor.
  - Zoom is logarithmic: each wheel pixel adds a fixed step to the logarithm of the scale.
  - It is eased: the pending zoom is applied exponentially over about 0.09 s for a wheel and 0.035 s for a pinch.
  - A pinch arrives as a ctrl+wheel event, or as Safari gesture events. Handle both.
  - Normalise line-based and page-based wheel deltas to pixels.
- **Right-click and hold on a cell:** split it into two cells (see Splitting). The browser context menu never appears on the canvas.
- **Mouse / Trackpad toggle:**
  - In Mouse mode, the wheel zooms.
  - In Trackpad mode, two-finger scrolling pans, and pinching zooms.
  - The choice is remembered across visits in local storage, wrapped so that missing storage is harmless.
- **M key:** shows or hides the tuning panel.
- When the window loses focus, any drag or hold is cancelled.
- The player cannot steer, select or otherwise control cells. All cell movement is autonomous.

## Zooming and nesting

### Which cells can be entered
- Exactly one cell per colony holds the next world down; call it the container cell. Only that cell can be zoomed into.
- Zooming into any other cell stops at a hard limit, where that cell's radius is about three screens. Nothing is inside it.
- The starting world is the innermost level, so none of its cells can be entered.

### Colours and shapes of container cells
- A container cell wears the palette of the colony inside it, not the palette of its own colony.
  - Starting from the magenta inner world and zooming out, the cell that holds it is magenta, while all its siblings in the outer world are periwinkle blue.
  - One level further out, the cell holding the periwinkle world is periwinkle among siblings of the next palette, and so on.
- The inside of a container cell, its "background from within", uses the inside colours of that same palette. This is why the inner world's background is plum and the outer world's is deep navy.
- A container cell has exactly the shape of the membrane of the world inside it. That membrane is the container's undeformed outline scaled up about 500×.
- The inner world's origin is the container's centre, and its x-axis is the container's long axis. The transform between the two levels is just that scale, rotation and offset.

### How far out the levels go
- Nesting continues outwards indefinitely. The two levels above the camera's current world must always exist; create them on demand.
- Palettes are assigned by level: level 0 magenta, level 1 periwinkle, then aqua, amber, green and rose. Those last four repeat for further levels; magenta and periwinkle never recur.
- Each new outer level has about 42 cells, counting its container cell, which starts in the centre of its colony.

### Fading between levels
- The world inside a container cell shows through only while that cell is large on screen.
  - Let t be the container's on-screen radius in screens. The inner world's opacity rises with an ease-in (the square of a ramp) from 0 at t = 0.1 to fully visible at t = 0.5.
  - Zoomed out to see the container among its neighbours, its colony has faded away completely and it looks like any other cell.
- While its inner world is visible, a container cell goes rigid and stops rippling: its membrane is that world's boundary.
  - Fade its deformation and ripple out over the first few percent of the inner world's opacity.
  - It deforms like any other cell only while its inner world is fully hidden.
- Seen from the inside, the container's outline is a thick, bright band. Outline thickness is a fixed fraction of a cell's radius, so at inner-world scale it is many inner radii wide. Its interior colour blends into the inner world's background, so the transition has no seam.

### What the camera does
- **Following the container.** While the view is inside a container that fills the screen, the camera rides along with it. The container drifts and turns, but the inner world stays still on screen, and panning and zooming feel exactly as they would anywhere else.
  - As the player zooms out, the camera hands over smoothly to the outer world's frame. It is fully attached while the container's radius is at least about 0.55 screens and fully detached at about 0.18 screens.
  - The hand-over also happens as the view centre moves out past the container's outline. That band must be a fixed fraction of a screen wide, not a fraction of the cell's size. Otherwise the camera drifts at the rim when zoomed in deep.
- **Switching frames.** The camera always lives in exactly one world's coordinate frame.
  - It moves to the parent frame when the current world's membrane radius drops below about 0.42 screens, or when the view centre is well outside it.
  - It moves into the child frame when the container's radius exceeds about 0.75 screens and the view centre is inside it.
  - Because the follow blend depends only on zoom and position, these switches are invisible.

## Splitting
- **Starting a split.** Right-click and hold on a cell at the current zoom level.
  - A quick right-click without holding does nothing: nothing starts until the button has been held for about 0.15 s.
  - Holding splits the cell **exactly once**. Holding longer after the split does nothing more, and a new split needs a new press.
- **While the button is held.**
  - The cell elongates along its long axis and pinches into two halves.
  - The separation between the halves grows at about 4.2 radii per second toward its full value of (2 × aspect + 0.8) × size.
  - The separation follows its target through a slightly springy membrane rather than rigidly.
  - The membrane goes taut while dividing: wobble and ripple fade out over about 0.2 s, and fade back in afterwards.
- **Releasing early.**
  - Released before about 55% of full separation, the halves relax back into one cell, and the second cell is removed again without a trace.
  - Released after that point, the split completes on its own.
- **Finishing the split.**
  - At full separation the halves let go of each other with a small push apart.
  - The remaining bridge between them fades out over about 0.3 s.
  - Each half then has its own halo, like any separate cell.
- **The new cells.**
  - Each is the same size, shape and colour as the mother cell. Cells do not shrink when they split.
  - The daughter starts exactly on top of her mother with the same interior texture and ripple, so the split begins seamlessly.
  - The two then live independently: they drift apart and wander like any other cell.
- **The look of a split.**
  - It must look natural and organic: one smooth, pinching shape with no popping, shape jumps, texture jumps or flicker.
  - Draw the two halves as one shape by blending their distance fields.
  - The waist forms early, between about 10% and 55% of the separation.
- **Which cells can split.**
  - A container cell, which holds a colony, can never be split.
  - Only one player division runs at a time, and splits are limited only by capacity.
  - Splitting is the only way the population grows during normal play.

## What every cell looks like
These rules apply at every level; only the palette changes.

- **Shape:** an oval 1.3 to 1.5 times as long as it is wide.
  - Many cells are slightly egg-shaped, with one end fuller than the other. Model the outline as two half-ellipses that share the minor axis, with the front and back semi-major axes differing by up to ±11%.
  - Sizes vary by about ±9%, and cells sit at all angles.
  - They must never look like perfect geometric ellipses.
- **Body:**
  - The centre is a calm, slightly darker tone that becomes the body colour toward the rim, following the square of the normalised radius.
  - A narrow, bright rim band sits just inside the outline, about 0.17 radii deep with an exponential falloff, so the cell looks lit from within.
- **Halo:** a soft glow spills about 0.42 radii beyond the outline. It is drawn additively before the bodies, is strongest at the membrane, and reaches zero with zero slope, so no ring shows where it ends.
- **Outline:**
  - A thin, crisp, bright line about 3.2% of the radius thick that follows every deformation exactly.
  - It is anti-aliased from the signed distance and drawn at least one pixel wide. Below one pixel it fades in opacity instead.
  - It looks smooth and clean at every zoom level, never jagged or flickering.
- **Interior:** a marbled, cloudy, organic texture that blends softly into the body colours.
  - It is magnified and bulged like a lens, as if seen through the curved surface of a droplet.
  - It shows no seams or repeats.
  - Give each cell its own random texture offset and rotation plus a very slow drift, so no two cells look identical inside.
  - The marbling fades out toward the rim, and fades out when the texture would be magnified so much that it turns blurry.
- **The interior texture:**
  - Generate it once at startup on the GPU as a seamlessly tiling, mipmapped noise texture.
  - It combines domain-warped fractal noise (the clouds), two warp channels, and ridged noise sharpened into thin veins.
  - Each palette sets how veiny or wispy its marbling is.
- **Far away:** when a cell's radius drops below about one device pixel, draw it as a soft, area-preserving dot, so dense distant colonies blend into a smooth tint without shimmering.

## How cells move and behave
- **Wandering:** every cell actively cruises on its own along meandering paths, independently of the others.
  - Top cruising speed is about 2.2 radii per second. Cells speed up and slow down as they go, so the stretch visibly comes and goes.
  - Heading and speed come from a per-cell sum of slow sine waves at unrelated frequencies. Cells steer toward that velocity, so bumps deflect them and they recover.
  - The long axis turns toward the direction of travel through a torque, so turning stays smooth even when a bump reverses the velocity, plus a little independent turning of its own.
  - Cells must never look nearly stationary.
- **Colony:**
  - The cells of each world form a loose colony in the centre of a membrane that is far larger than they need: it is sized to hold 100,000 cells at about 36% area coverage.
  - A gentle pull back toward the middle grows linearly with distance. It starts at 0.25 × colony size × the colony's natural radius, and at colony size × that radius it equals the wandering speed (colony size ≈ 3).
  - The colony's natural radius is the membrane formula from the defaults table, evaluated at the world's current population.
  - Wanderers turn back, so the starting view never empties. The pull must never collect cells into a ring at the edge.
  - The pull fades away as the population grows to fill the membrane.
- **Crowding:**
  - Cells never pass through or overlap one another.
  - When they meet, they bump, press and squash against each other, then drift apart, so clusters form and dissolve naturally.
  - Bumps turn cells only gently: about a third of rigid-body spin.
- **The outline is the collision shape.** The white outline marks exactly where cells touch, including every stretch, squash and ripple. Touching cells show neither gaps nor overlaps.
- **Soft, wobbly bodies:**
  - Each cell's membrane is a springy jelly, with an area-preserving stretch that can point in any direction.
  - Its target is a stretch along the direction of travel that grows with speed and saturates: about 28% at most, half-way at 1.2 radii per second.
  - The deformation follows the target through a lightly damped spring, about 5.5 rad/s with a damping ratio of about 0.16. Whenever a cell's motion changes, it overshoots and wobbles naturally before settling.
  - Cells must not look rigid.
- **Squash on contact:**
  - Pressure from neighbours squashes a cell rather than only pushing it.
  - A bump squashes it in proportion to how fast the two cells met, and it then springs back and wobbles.
  - Cap the total deformation, and never let a cell become more than about twice as long as it is wide. No sausages.
- **At rest:** the outline ripples subtly and irregularly.
  - Use waves with 2, 3 and 4 lobes, with relative weights 1, 0.62 and 0.38 and a total amplitude of about 4% of the radius.
  - Each wave travels around the outline at its own speed and direction, and its amplitude slowly breathes.
  - The motion is slow and smooth with no obvious rhythm and no regular star or flower pattern. It reads as a living membrane, not a vibrating shape.
  - The ripple is attached to the cell's undeformed frame, so it stretches with the cell.
- **Contents:** the interior texture is attached to the cell's undeformed (material) frame, so it stretches and squashes together with the body and clearly sits inside the membrane.
  - The contents also lag behind the body's movement and rotation through their own soft spring, about 5 rad/s with damping 0.45, capped at a fraction of the radius.
  - The lag shifts the middle of the texture while the rim stays put, which gives a subtle viscous, oozing slosh.
- **Continuity rule:** anything that moves the outline or the interior must be continuous simulated state, driven by springs. It must never be derived from the instantaneous velocity. The interior texture and the outline must never jerk, even when cells collide hard.

## Palettes
Each palette has nine colours and four marbling parameters:
- **Body colours:** body, centre, rim, outline and glow.
- **Marbling:** marble colour; the low and high thresholds of the marbling; the vein mix (how veiny versus cloudy the marble is); and marble strength.
- **Seen from inside:** the background at the centre and at the edge, as the cell looks when its inner world is visible.
- **Particles:** the particle colour.

| Palette | body | centre | rim | outline | glow | marble | inside bg | inside bg edge | particle | marble lo / hi / veins / strength |
|---|---|---|---|---|---|---|---|---|---|---|
| Inner (magenta) | #d23a9a | #a32a80 | #ff8ad8 | #ffeaf8 | #ff4cc0 | #4a0f42 | #1c0620 | #6e1a5c | #ffb8ea | 0.40 / 0.80 / 0.50 / 0.85 |
| Outer (periwinkle) | #8a93ea | #737cd8 | #c6ccff | #f4f6ff | #8494ff | #e6e9ff | #151946 | #3b4396 | #cbd3ff | 0.50 / 0.90 / 0.22 / 0.62 |
| Level 2 (aqua) | #2fa3ad | #24828f | #86f2ec | #eafffd | #3cd9d3 | #0c3d48 | #080c2c | #1d2870 | #b6f0ff | 0.42 / 0.84 / 0.45 / 0.80 |
| Level 3 (amber) | #d0923a | #aa7429 | #ffd88f | #fff5e0 | #ffb347 | #4d2c0a | #071a1e | #1a4b4e | #ffe0ae | 0.42 / 0.84 / 0.45 / 0.80 |
| Level 4 (green) | #5fae4e | #478f3b | #bdf7a0 | #f2ffe9 | #7ee06c | #183f13 | #1e1106 | #5a3a14 | #d6ffc6 | 0.42 / 0.84 / 0.45 / 0.80 |
| Level 5 (rose) | #b8425a | #933347 | #ffa0b2 | #fff0f3 | #ff5e78 | #3c0b16 | #0b1a10 | #21502c | #ffd0da | 0.42 / 0.84 / 0.45 / 0.80 |

- The magenta cells have a darker plum, irregular, veiny and cloudy interior. The periwinkle cells have a lighter, wispy, cloud-like interior.
- **Background of a world:**
  - It is the inside gradient of its container's palette: the centre colour, growing lighter toward the membrane.
  - The gradient is concentrated in the outer part of the world, and the whole background carries a very soft, large-scale cloud modulation of about ±12%.
  - Inside the magenta home cell this gives deep plum turning magenta near the membrane. Outside it, in the outer world, deep indigo/navy.

## Particles
- Every world has its own sparse field of particles that drift slowly at different apparent depths, so the scene feels three-dimensional. There are two kinds:
  - tiny sharp specks with a faint glow;
  - a few larger, blurred, softly glowing orbs.
- **Placement:** generate them procedurally from a hash per tile of world space, so density is independent of world size and no buffers are needed.
  - Specks: about 3 per tile of 3 × 3 radii, with a radius of about 0.016 to 0.04.
  - Orbs: about 0.6 per tile of 8 × 8 radii, with a radius of about 0.2 to 0.5.
- **Motion and depth:** create the parallax by scaling each particle's screen position about the view centre by up to ±30%. Particles drift slowly and twinkle gently.
- **Fading:**
  - Particles fade out near the membrane.
  - Each kind fades out smoothly as the world shrinks on screen, before it would turn into sub-pixel noise.
  - Particles are drawn with the opacity of their world.

## Hidden tuning panel (M key)
- **Layout:** a compact, scrollable panel at the top right, about 300 px wide. It is dark and translucent, with small monospace text and a header reading "Tuning", with "M to close".
- **Stats line:** fps, render resolution in percent, the current level, cells in this world, total cells and the number of worlds.
- **Buttons:**
  - **Divide all here:** doubles the current world's population.
  - **Grow here to 100k:** a stress test.
  - **Copy settings:** copies all tunables and palettes as JSON to the clipboard, or logs them to the console if the clipboard is unavailable.
- **Sliders, live, grouped:**
  - Cells:
    - outline width and the membrane outline weight;
    - halo size and strength;
    - rim width and strength;
    - ripple strength and speed;
    - stretch strength;
    - wobble frequency and damping;
    - squash softness and impact squish;
    - interior strength, scale and bulge;
    - contents lag strength, frequency and damping.
  - Motion:
    - wander speed and turn rate;
    - colony size;
    - steering and linear damping;
    - alignment strength and contact spin;
    - solver iterations and relaxation.
  - Division: pull-apart speed, spring stiffness, damping, gap and push-apart kick.
  - Scene: particle density, and the start and end of the inner-world fade.
- **Palettes:** colour pickers for every colour of every palette, applied live.
- Wheel events over the panel scroll it instead of zooming.

**Stress test:**
- Cells keep dividing automatically until the target is reached. Each automatic division separates on its own over about 1.2 s.
- Each frame, spend a budget of about 2% of the population, with a minimum of 40 and a maximum of 4,000 divisions.
- Skip container cells and cells that split recently.
- While it runs, the colony expands outward smoothly with its growing population, so new cells find room everywhere. The camera rides along with that expansion, and the membrane only grows if the colony outgrows it.

## Scale and performance
- The starting world has about 70 cells. The outer world has about 46, counting the home cell.
- Each starting colony has no overlaps at frame zero:
  - place cells by random non-overlapping sampling inside the colony radius;
  - then relax any remaining overlaps before the first frame, with the container cell pinned at the centre.
- Splitting, or the stress test, must be able to grow a world to 100,000 cells, and up to about 250,000 per world, while holding a steady 60 fps on typical desktop hardware.
- Zooming and panning must stay perfectly smooth at any population.
- Cap the device pixel ratio at 2.
- **Adaptive resolution:**
  - While frames are being dropped (average frame time above 1/50 s), lower the render resolution in steps of about 15%, down to 50%.
  - After about 8 s of smooth frames, probe back up.
- Clamp the frame time to 0.1 s, and the simulation step to 1/30 s.
- Simulate only the worlds that are on screen, plus the camera's own world.

## Implementation requirements
These decisions are load-bearing. Without them, the behaviour above is not achievable.

1. **All cell state and physics live on the GPU.**
   - Store per-cell state in RGBA32F textures that are 512 texels wide, with cell i at texel (i mod 512, i div 512), and ping-pong them every solver iteration using multiple render targets.
     - **Dynamic state:** position and velocity; angle and angular velocity; the deformation and its velocity; the contents' lag offset and rotation with their velocities.
     - **Static attributes, written by the CPU only when cells are born:** size, aspect, egg factor and a wander seed; palette, flags, parent and side of a pending division, birth time and a ripple seed; texture offset, rotation and drift direction.
   - Grow the textures by doubling their rows, copying the old state on the GPU.
   - **No GPU-to-CPU readbacks in the steady state.** The only readback is a right-click pick: render cell IDs into a 1 × 1 target at the cursor and read it back asynchronously with a fence.
     - The pick takes the deepest visible level whose cells have a radius of at least about 6 CSS pixels on screen.
     - A container whose inner world is mostly visible is skipped, so the pick goes through to the cells inside it.
2. **Neighbour search:**
   - Each frame, build a uniform spatial grid on the GPU, with cells slightly larger than the largest possible cell's diameter.
   - Use depth peeling into about 10 single-channel float layers: layer k holds, per grid cell, the k-th smallest cell index.
   - The solver checks the 3 × 3 neighbouring grid cells and stops at the first empty layer.
   - The solver must stay within 16 texture units, the WebGL2 minimum: the state and attribute textures plus the grid layers.
   - Packing must stay overlap-free even in tightly squeezed clusters.
3. **Solver:**
   - Use position-based (Jacobi) contacts with about 3 iterations per frame and a relaxation of about 0.7 divided by the square root of the contact count.
   - Each iteration does the following, in order:
     - steering;
     - the colony pull;
     - the alignment torque;
     - the deformation spring;
     - predicting the new position, angle and deformation;
     - contacts;
     - containment in the membrane, with cells kept about 6% inside it;
     - the held-division constraint;
     - deriving velocities from the position change, capped at about 4 radii/s and 1.8 rad/s.
   - **Predict neighbours forward within the step:** their position, angle and deformation by their velocities. Otherwise fast rebounds overlap.
4. **Exact contact between the deformed shapes:**
   - **Deformation:** an area-preserving stretch, given by the exponential of a traceless symmetric 2 × 2 matrix in the body frame.
     - The stretched ellipse is refitted along its principal axes.
     - The egg asymmetry stays on the long axis and fades out as the shape becomes round.
   - **Separation:** an egg is exactly the union of the circles inscribed along its long axis. The separation between two eggs is the minimum, over those circles of one egg, of the distance from the circle's centre to the other egg minus the circle's radius.
     - It is convex along the axis, so a short golden-section search plus an endpoint check finds it.
     - Compute distances to the half-ellipses exactly, with a few Newton steps.
   - **Ripple:** subtract each outline's ripple at the contact point.
   - **Sharing the correction:** split each contact correction between moving, turning and squashing both cells, weighted by mass, rotational inertia (scaled by contact spin) and membrane softness.
   - **Impact squish:** add a deformation-velocity kick proportional to the closing speed.
   - **Same shape everywhere:** the renderer draws exactly this shape, deformation and ripple included.
5. **Container cells are driven by the CPU.**
   - Their position and angle are simulated on the CPU with the same wandering, colony and membrane rules and uploaded each frame, so their exact frame is always known for camera tracking and for drawing the world inside them.
   - The GPU cells treat a container as immovable and make way for it.
   - Its deformation is still simulated on the GPU, scaled down to rigid by its flex value.
6. **Precision at any depth:**
   - Compose the transforms between levels (similarity transforms: scale, rotation, offset) in double precision on the CPU.
   - Render relative to an origin near the view, so 32-bit floats on the GPU never lose precision.
   - Draw a large container cell on its own, in its exact double-precision frame, with its rotation computed on the CPU. GPU sine and cosine of a large angle put a 500× enlarged outline visibly off.
   - Its outline must stay exactly on its inner world's boundary at every zoom.
7. **Rendering per frame:**
   - Walk outward from the camera's world until the screen lies entirely inside one container cell.
   - Draw that cell, already enlarged, as the backdrop: its interior has fully become the inner world's background.
   - Then draw the world inside it in this order:
     - particles;
     - the halo pass for all cells;
     - the body pass, which also draws the outlines.
   - Recurse into any container whose inner world is visible, at that world's opacity.
   - Use premultiplied alpha.
   - Draw each cell as an instanced, oriented quad sized to its shape.
   - The mother of a dividing pair draws both halves.
8. **Division on the GPU:**
   - The daughter is born in the solver on top of her mother, offset by a hair along the long axis, copying all of her mother's dynamic state.
   - While the player holds, a constraint keeps the pair at the current separation along the mother's long axis.
   - The daughter is always the newest cell, so cancelling a division just removes the last cell.

## Suggested defaults
These values reproduce the intended feel. Expose all of them as named constants, with the ones listed in the panel section as live sliders.

| Parameter | Value |
|---|---|
| Starting / outer / further-out populations | 70 / 46 / 42 |
| Membrane capacity, area coverage | 100,000 cells, 0.36 (membrane semi-minor radius ≈ √(n × 1.3 / (0.36 × aspect)); about 500 radii) |
| Size variation, aspect range, egg factor | ±0.09, 1.3–1.5, ±0.11 |
| Wander top speed, turn rate, steering, linear damping | 2.2 r/s, 1.6, 2.2 /s, 0.15 /s |
| Alignment, wander torque, angular damping, contact spin | 2.0, 0.6, 2.5 /s, 0.35 |
| Colony size | 3.0 |
| Solver iterations, relaxation | 3, 0.7 |
| Stretch strength, half-way speed | 0.28, 1.2 r/s |
| Largest stretch factor, longest aspect | 1.38, 2.0 |
| Wobble frequency, damping ratio | 5.5 rad/s, 0.16 |
| Squash softness, impact squish | 0.6, 0.55 |
| Contents spring frequency, damping, lag strength | 5.0 rad/s, 0.45, 1.0 |
| Ripple strength, speed | 0.04 of the radius, 1.0 |
| Outline width, halo size, halo strength | 0.032, 0.42, 0.5 (fractions of the radius where relevant) |
| Rim width, rim strength | 0.17, 0.8 |
| Interior strength, scale, bulge | 0.9, 0.2, 0.32 |
| Particle density | 1.0 |
| Inner-world fade start / end (container radius in screens) | 0.1 / 0.5, ease-in |
| Hold delay, pull-apart speed, commit fraction | 0.15 s, 4.2 r/s, 0.55 |
| Split spring stiffness, damping, gap, kick | 250, 14, 0.8 r, 0.9 r/s |
| Membrane tension time, bridge crossfade, automatic split time | 0.2 s, 0.3 s, 1.2 s |
| Wheel / pinch zoom step per pixel (log scale) | 0.0022 / 0.011 |
| Wheel / pinch zoom easing | 0.09 s / 0.035 s |
| Starting view, maximum zoom | screen = 14 radii; cell radius = 3 screens |

## Quality bar: avoid
- Flat, rigid or clip-art-looking cells, or perfectly regular ellipses.
- Cells that barely move, or that drift apart until the start view is empty.
- Cells that keep their shape while moving or colliding. They must stretch, wobble and squash visibly.
- Overlapping cells, gaps between touching outlines, or an outline that does not mark the collision.
- Outlines that jerk, twitch or jump for no visible reason.
- Interior textures that jerk on collisions, slide independently of the shape, or show tiling.
- Splitting on a plain click, splitting repeatedly while the button is held, or a split that looks glitchy or pops.
- Being able to enter cells other than the one container cell per colony, or a container cell drawn in the wrong colour.
- A container outline that swims, jitters or misaligns with its inner world's boundary at high zoom.
- The camera drifting or sliding when hovering at a container's rim.
- Aliased edges, flicker, or popping while zooming or panning.
- Ripples or wandering that look mechanical, or identical across cells.
- Any visible seam, cut or swap when moving between levels.
- Laggy panning, or frame drops as the population grows.

## Deliverable
A single runnable browser demo that behaves exactly as described:
- the magenta inner world on load;
- the controls above and nothing more;
- the hidden tuning panel on M;
- hold-to-split, exactly once per hold;
- one enterable, correctly coloured container cell per colony;
- seamless, endless zooming between levels.
