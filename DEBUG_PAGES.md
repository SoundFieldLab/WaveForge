# Independent Debug Pages

This file is the registry for standalone developer-only pages in the WaveForge repository. AI agents and developers must check this file before building a new visual debugging surface.

## Weather Lab

| Field | Value |
|---|---|
| Page | `weather-debug.html` |
| Local URL | `http://127.0.0.1:3000/weather-debug.html` |
| Start command | `npm run dev` |
| Source entry | `src/weather-debug/main.tsx` |
| Scenario factory | `src/weather-debug/scenarios.ts` |
| Styles | `src/weather-debug/debug.css` |
| Test | `test/weatherDebugScenarios.test.ts` |
| Production status | Development-only. Do not add this HTML file to Vite `rollupOptions.input`. |

### Purpose

Use Weather Lab to compare Apple-derived weather visuals before changing production weather code. It provides these local, API-free previews:

- Nine WMO weather categories: clear, partly cloudy, cloudy, fog, drizzle, rain, heavy rain, thunder, and snow.
- Day and night variants for every category.
- One full-screen Apple weather scene preview.
- Desktop `full` and `simple` weather card previews using the compact Apple renderer.
- A button that opens the real `WeatherDetailsModal` using only local mock data.
- A reduced-motion/static-frame toggle.

### Feedback Format

Use the visible scenario identifier when reporting a visual issue:

```text
scene=thunder-night: reduce rain density and darken the cloud base
scene=clear-day: move the sun farther right
card=full: improve temperature contrast
card=simple: increase hourly forecast readability
```

### Safety Rules

- Do not import `DesktopWidgetZone` or `WeatherWidget` into this page. They perform real weather and hazard refreshes.
- Keep all data in `scenarios.ts`; do not call Open-Meteo, Nominatim, location services, or hazard APIs from the page.
- Do not use port `3002`; it is reserved for the Python beat-analysis service. Use the existing Vite `3000` server and open `/weather-debug.html`.
- Keep this page outside production build inputs. It is a visual validation tool, not a customer-facing route.
- When adding another independent debug page, add a separate section in this registry with its URL, command, scope, source files, production status, and API/network constraints.

## DG-LAB Minimal Debug Platform

| Field | Value |
|---|---|
| Page | `debug-minimal/index.html` |
| Local URL | `http://127.0.0.1:3100` |
| Start command | `npm run dglab:debug:all`, or `launchers/start-dglab-debug.bat`, or `dglab:debug` / `dglab:debug:ui` separately |
| Source entry | `debug-minimal/src/main.tsx` |
| Docs | `debug-minimal/README.md` |
| Backend | `debug-minimal/server/index.cjs` (real relay on 31082 / API 3101) + `server/frame-tap.cjs` |
| Type check | `npm run dglab:debug:typecheck` |
| Production status | Development-only. Not in electron-builder `files` nor Vite inputs; committed to the repo for shared debugging. |

### Purpose

Debug the DG-LAB (coyote) plugin with a **real device** and without restarting the packaged app. It reuses the production plugin code directly, so results transfer:

- `@` resolves to the repo `src/`, so the console/widget UI being edited here is the same file the app ships.
- `server/dglab-relay.cjs` is `require`d in-process, so the mapping engine under test is the shipping engine.
- The phone connects by scanning the console QR code; `frame-tap.cjs` passively records every frame the relay sends to that real device (no virtual device, no relay changes), so the observed waveform is exactly what the phone received.

### Feedback Format

Report waveform issues against the observed frames:

```text
style=stereo: A/B should diverge more on this track (currently 47 vs 41)
style=heartbeat: pulse envelope decays too fast after the first frame
pulse: freq stays near 100 — check rtFreqMap influence
```

### Safety Rules

- Do not copy plugin logic into this folder. Reuse `src/` and `server/dglab-relay.cjs` via alias/`require`; a second copy will drift and invalidate the debug results.
- Do not reintroduce a simulated device. Real-device observation is the point; a fake device hides exactly the hardware-specific problems (real caps, handshake timing, dropped frames) this platform exists to find.
- Keep the frame tap passive: only wrap `send` for recording, never alter or delay what the relay sends to the device.
- Stay on ports 3100 / 3101 / 31082. Do not reuse 3000 / 3001 / 30082 — the platform must run alongside the real app.
- Do not add this folder to electron-builder `files` or Vite `rollupOptions.input`.
- Keeping test music out of the repo is preferred; point `DGLAB_DEBUG_MUSIC_DIR` at a local folder instead of committing audio.
- `installDevBridgeRafFallback` and `window.__dglabDebug` are debug-only affordances; keep them out of production plugin code.

## Adding A New Debug Page

1. Create a root `*-debug.html` entry and a dedicated `src/<feature>-debug/` folder.
2. Reuse the existing Vite dev server unless a feature truly requires a separate backend process.
3. Keep all data local or explicitly document allowed test APIs.
4. Add a focused test for the scenario/data factory.
5. Register the page in this document and link it from `AGENTS.md`.
6. Do not add it to production Vite inputs unless the product specification explicitly promotes it to a shipped feature.
