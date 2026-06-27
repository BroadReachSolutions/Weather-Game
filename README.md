# Weather Game (Oregon Sail)

A mobile-first PWA weather dashboard with a real-time 3D sailing simulation ("Oregon Sail") built into it. Real marine weather/tide data drives an actual sailing physics engine, a Three.js 3D Helm view, and a growing set of boat systems.

## Live site

https://broadreachsolutions.github.io/Weather-Game/

Deployed via GitHub Pages from the `main` branch — pushing to `main` ships to production. See "Working together" below before pushing directly.

## Project structure

```
weather-game/
├── index.html              — Single page app: dashboard widgets + the Oregon Sail game widget
├── style.css                — All styles (dashboard widgets, dev console, game UI)
├── script.js                 — Dashboard: widget drag/resize/settings, weather/tide fetch, compass, forecast
├── game.js                    — Legacy screen router (mostly superseded by the dashboard + game widget)
├── service-worker.js / manifest.json — PWA install + offline caching
│
├── oregon-sail/               — The sailing game itself
│   ├── supabase-config.js     — Supabase client init (global, no IIFE)
│   ├── game-core.js           — OS namespace: boat CRUD + every OS.setXxx() mutation (lights, batteries, loads, sails, engine, etc)
│   ├── physics.js              — Pure physics functions: sailing speed, point of sail, fuel burn, and the Electrical system's generation/load math
│   ├── game-ui.js               — Main game loop: simulation tick (250ms), electrical tick (5s), wheel/engine/sail controls, weather sync, map
│   ├── instruments.js            — Gauge HTML generators (speed, windex, engine, sail trim, wheel, water/food/hull)
│   ├── helm3d.js                  — Three.js 3D Helm view: boat model, water shader, sky/day-night, wind streaks, wake, AI boats
│   ├── tabsystem.js                — The Cockpit/Nav Station/Crew/Systems/Storage tab framework, widget placement/resize
│   ├── devconsole.js                — Dev console (unlocked via captain/vessel name "Sonic" or "Dev"): boat designer, vessel presets, weather override, UI config
│   └── draggable-buttons.js          — Small drag helper used by a couple of floating buttons
│
└── supabase/
    ├── schema.sql              — Base schema
    ├── migration_NNN_*.sql      — Incremental migrations, run in order against the Supabase project
    └── functions/tick-voyages/  — Server-side cron tick (advances boats while the app is closed)
```

## How the game fits in the dashboard

Oregon Sail lives inside one widget (`data-widget="game"`) on the main dashboard. Internally it has its own tab system (`tabsystem.js`) with five main tabs — **Cockpit**, **Nav Station**, **Crew**, **Systems**, **Storage** — each holding user-arrangeable sub-tabs and widgets (gauges, the chart plotter, battery panel, etc). Widget layout is saved to `localStorage` per device, and can be exported/imported or pushed as the new-player default from the dev console's UI Config tab.

## Major systems, at a glance

- **Sailing physics** (`physics.js`, `game-ui.js`): real point-of-sail calculation, sail/engine speed blending, fuel/food/water consumption, heading/rudder/autopilot.
- **3D Helm view** (`helm3d.js`): procedural boat generator (hull/cabin/keel/rig — fully parametric via the dev console's Boat Designer, or swap in an imported `.glb` model), animated water with real swell physics the boat actually rides, day/night cycle, random AI ambiance boats with collision detection.
- **Electrical system** (`physics.js`, `game-core.js`, the Battery Bank widget, dev console's Boat Designer): batteries (start/house-bank/generator/bow-thruster), generation sources (solar/wind/generator/alternator) with real-world output curves, 14+ load types that actually draw down the house battery in real time and shut off if it dies.
- **Dev console**: unlocked by naming your captain and vessel both "Sonic" (also gets a 100x speed multiplier for fast testing) or both "Dev" (normal speed). Lets you design boats, edit any boat's raw state, override weather/swell/time-of-day, and configure new-player defaults.

## Database

Supabase project `ailcwfpjlelofhqmqzdy`. Run new migrations from `supabase/migration_NNN_*.sql` against the SQL Editor in order — if a big migration hangs in the editor, split it into 2-3 smaller chunks rather than running it all at once.

## Working together

This repo doesn't yet have branch protection set up. Until it does:
- **Small group, high trust**: collaborators can push directly to `main`, but please pull before you start a session and test locally before pushing anything that touches `helm3d.js` (3D/physics) or the Electrical system — those have the most interconnected state.
- **Recommended as the team grows**: work on a feature branch (`git checkout -b yourname-feature`) and open a Pull Request into `main` so changes get reviewed before they go live on the deployed site.

When in doubt about whether a change is safe to ship straight to `main`, ask in whatever chat the team uses before pushing — a broken `main` is a broken live site for everyone.
