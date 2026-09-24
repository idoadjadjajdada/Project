# Orbital

A true-scale gravity sandbox for desktop browsers and iPad, built with TypeScript and PixiJS.
The design and scope live in the PRD ("Space Sandbox PRD" doc).

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # physics tests
npm run build      # typecheck + production build in dist/
```

## How it's put together

| Folder | What's in it |
| --- | --- |
| `src/sim/` | Physics, runs in a Web Worker. N-body gravity in SI units with per-body block timesteps, collisions (merge, hit-and-run, partial disruption, shatter), surface maps, habitability, real-data presets. No DOM. |
| `src/render/` | PixiJS renderer. Camera math runs in float64 on the CPU so true-scale positions keep their precision. |
| `src/ui/`, `index.html`, `src/styles/` | HTML/CSS HUD over the canvas: picker, toolbar, time bar, stats, info panel, menus. |
| `src/input/` | Mouse, touch and Pencil input: tools, pinch/pan, two-finger-tap undo, long-press info, Pencil mode. |
| `src/state/` | Settings and local save slots (localStorage). |

The worker runs one frame ahead of the screen, so every tool position is sent as an
offset from a body (`Pt` in `src/sim/protocol.ts`) rather than as absolute coordinates.
