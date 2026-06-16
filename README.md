# Weather Game

A mobile-only PWA game built on top of St Augustine Sailing real-time marine data.

## Project structure

```
weather-game/
├── index.html        — Single page, 5 screens (loading, home, how-to, high scores, game, game-over)
├── style.css         — Mobile-only styles + desktop guard message
├── game.js           — Screen router, live weather fetch, score system, game loop placeholder
├── service-worker.js — PWA offline caching
├── manifest.json     — PWA install config (name, icons, orientation: portrait)
├── _headers          — Netlify security/cache headers
├── icon-192.png      — App icon (add your own)
└── icon-512.png      — App icon (add your own)
```

## Separate from AppV1

This is a **completely separate project** from the Marine Dashboard (AppV1).
- Different git repo
- Different deployment URL
- Shares the same API endpoints (NOAA proxy, open-meteo) but none of the dashboard code

## Deploying

### Netlify (recommended)
1. Create a **new site** on Netlify (separate from Marine Dashboard)
2. Connect this repo
3. Build command: (none — static site)
4. Publish directory: .

### GitHub Pages
1. Push to a new GitHub repo
2. Settings → Pages → deploy from main / root

## Adding your game mechanics

The game loop is in game.js around startGame().
- addScore(points) — call whenever the player earns points
- liveWeather object has windMph, tempF, tideStatus, tideFt
- gameTimer counts down from 60; endGame() fires at 0

## PWA install

- iPhone: Safari → Share → Add to Home Screen
- Android: Chrome → menu → Install App

## Icons

Drop in icon-192.png and icon-512.png.
