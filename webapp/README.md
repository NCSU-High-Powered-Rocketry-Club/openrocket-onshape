# OpenRocket → Onshape Web App

Static web app that converts OpenRocket `.ork` files to a JSON geometry payload for an Onshape custom feature.

## Features

- **Client-side parsing** — the `.ork` file is unzipped and parsed entirely in the browser; nothing is uploaded until you push to Onshape
- **Full component support** — nose cones, transitions, body tubes, all fin types (trapezoid/elliptical/freeform/tube), launch lugs, rail buttons, internal rings, recovery devices, mass components, parallel stages, and pod sets
- **Derived geometry** — computes transition/nose-cone profiles (all 6 shape types), fin planforms, and mass estimates
- **JSON preview + download** — inspect the payload before uploading
- **Onshape upload** — creates a document + part studio and pushes the JSON to the custom feature via the Onshape REST API

## Development

```bash
npm install
npm run dev      # start dev server
npm run build    # type-check + production build
npm run preview  # preview production build
```

The built app is a fully static site in `dist/` — deploy it to any static host (GitHub Pages, Netlify, S3, etc.).

## Using the app

1. Open the app in a browser
2. Drag & drop an `.ork` file (or click to browse)
3. Review the parsed design summary and generated JSON
4. Click "Download JSON" to save the payload, OR
5. Paste an Onshape OAuth2 bearer token and click "Upload to Onshape"

> **Note:** The Onshape upload requires the OpenRocket custom feature to be installed in the target part studio (the uploader looks for a feature whose type starts with `openRocket`).

## Data pipeline

```
.ork file (ZIP)
   │  JSZip unzip
   ▼
rocket.ork (XML)
   │  fast-xml-parser
   ▼
Raw component tree
   │  parser.ts (component dispatch)
   ▼
RocketJson (types.ts)
   │  geometry.ts (profiles, planforms, masses)
   ▼
Enriched RocketJson
   │  onshape.ts (REST API)
   ▼
Onshape custom feature
```

## Project structure

```
webapp/
├── index.html          # UI markup + styles
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts         # UI logic / entry point
    ├── parser.ts       # .ork ZIP + XML parsing
    ├── geometry.ts     # derived geometry calculations
    ├── onshape.ts      # Onshape REST API client
    ├── types.ts        # JSON schema TypeScript types
    └── vite-env.d.ts
```

## Credits

Data model derived from the [OpenRocket](https://github.com/openrocket/openrocket) source (unstable branch, v24.12, file format 1.8–1.10). See `docs/geometric-data-checklist.md` in the repo root for the full data extraction checklist.