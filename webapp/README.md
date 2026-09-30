# OpenRocket → Onshape Web App

Static web app that converts OpenRocket `.ork` files to a JSON geometry payload for an Onshape custom feature.

## Features

- **Client-side parsing** — the `.ork` file is unzipped and parsed entirely in the browser; no design data is uploaded
- **Full component support** — nose cones, transitions, body tubes, all fin types (trapezoid/elliptical/freeform/tube), launch lugs, rail buttons, internal rings, recovery devices, mass components, parallel stages, and pod sets
- **Assemblies and boosters** — preserves stage, pod-set, and parallel-stage/booster hierarchy, ring instances, axial/radial placement, and child geometry
- **Derived geometry** — computes transition/nose-cone meridian sections (all 6 shape types), fin planforms, assembly lengths, and mass estimates. Shoulders are emitted as their **own** closed polygons (`shoulderProfile.fore` / `.aft`) so the FeatureScript can revolve and boolean-union each one onto its parent, rather than folding them into the body's section.
- **Validation warnings** — reports missing mass, zero opacity, missing material names, and unsupported component tags
- **Motor configuration picker** — a rocket can declare one motor per flight configuration. The dropdown lists them (named or numbered, with the file's default flagged) and shows the motors each one loads across all mounts. Picking a non-default configuration re-reads the file so **every** motor mount resolves against it, not just the first
- **Center of pressure picker** — when the `.ork` carries saved flight data, pick which simulation the CP marker comes from; each option shows the median, sample count, and how many post-apogee samples were dropped
- **JSON preview + download** — inspect and save the generated payload locally

## Development

```bash
pnpm install
pnpm run dev      # start dev server
pnpm run build    # type-check + production build
pnpm run preview  # preview production build
pnpm test         # vitest
```

This project uses **pnpm** — `pnpm-lock.yaml` is the only lockfile, and CI installs
with `pnpm install --frozen-lockfile`. Use `pnpm`, not `npm`: a stale `package-lock.json`
was tracked here until 2026-09-29, and `npm ci` could not resolve against it (it still
pinned vite 5 while `package.json` required vite 6). `packageManager` in `package.json`
pins the version.

The built app is a fully static site in `dist/` — deploy it to any static host (GitHub Pages, Netlify, S3, etc.).

## Using the app

1. Open the app in a browser
2. Drag & drop an `.ork` file (or click to browse)
3. Review the parsed design summary, validation warnings, and generated JSON
4. If the rocket declares more than one flight configuration, pick which one's motors to build; if it carries saved simulations, pick the CP source
5. Click "Download JSON" to save the payload locally

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
   │  validation.ts (structured warnings)
   ▼
JSON preview + local download
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
    ├── validation.ts   # structured validation warnings
    ├── types.ts        # JSON schema TypeScript types
    └── vite-env.d.ts
```

## Credits

Data model derived from the [OpenRocket](https://github.com/openrocket/openrocket) source (unstable branch, v24.12, file format 1.8–1.10). See `local/geometric-data-checklist.md` for the full data extraction checklist.