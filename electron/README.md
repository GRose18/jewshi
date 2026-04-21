## Electron Shell

This folder contains the Mac desktop wrapper for Jewshi.

Current behavior:
- loads the hosted Jewshi frontend or a locally running instance
- keeps the existing Node/Render/Turso backend architecture
- does not replace the web app, it wraps it

Run modes:
- `npm run desktop:local`
  - opens Electron against `http://localhost:3000`
  - use this while running the local Jewshi server
- `npm run desktop:web`
  - opens Electron against `https://jewshi.onrender.com`
- `npm run desktop`
  - uses `JEWSHI_DESKTOP_START_URL` if set
  - otherwise falls back to `CLIENT_URL`
  - otherwise uses `http://localhost:3000`

Before running:
- install dependencies locally with `npm install`

Build commands:
- `npm run desktop:dir`
  - creates a packaged Mac app folder under `dist/desktop`
- `npm run desktop:dist`
  - creates a Mac `.dmg` build under `dist/desktop`

URL behavior:
- in development, Electron defaults to `http://localhost:3000`
- in packaged builds, Electron defaults to `https://jewshi.onrender.com`
- you can override either one with:
  - `JEWSHI_DESKTOP_START_URL`
  - or for packaged builds specifically, `JEWSHI_DESKTOP_PROD_URL`

Later steps for a real Mac release:
- add app icon assets
- sign and notarize the app
- generate a `.dmg`
