# AI Agent Guide — OpenRocket → Onshape

This document is written for AI coding agents (and humans) who will work on this repository. It captures the architecture, the data model, the gotchas discovered while building the parser, and the current state of the project.

---

## Project Goal

Create a workflow that converts an **OpenRocket** (`.ork`) design file into a complete 3D model in **Onshape**:

1. **Static web app** (this repo, `webapp/`) — parses `.ork` → JSON geometry payload
2. **Onshape custom feature** (NOT in this repo — written separately) — consumes the JSON and builds the 3D geometry

The web app is the deliverable for this repo. The custom feature is out of scope for the coding agent.

---

## Repository Layout

```
openrocket-onshape/
├── AI_README.md                    # This file
├── docs/
│   └── geometric-data-checklist.md # Data extraction checklist (user-checked)
├── openrocket-unstable/            # OpenRocket source (reference only, read-only)
└── webapp/                         # The static web app (Vite + vanilla TS)
    ├── index.html                  # UI
    ├── package.json
    ├── tsconfig.json
    ├── README.md                   # Human-facing usage docs
    ├── test/
    │   └── ork/                    # Real .ork test files (5 rockets)
    └── src/
        ├── main.ts                 # UI entry point
        ├── parser.ts               # .ork ZIP + XML → RocketJson
        ├── geometry.ts             # Derived geometry (profiles, planforms, mass)
        ├── onshape.ts              # Onshape REST API client
        ├── types.ts                # JSON schema TypeScript types
        └── vite-env.d.ts
```

---

## Architecture / Data Flow

```
.ork file (ZIP)
   │  JSZip unzip
   ▼
rocket.ork (XML)
   │  fast-xml-parser
   ▼
Raw component tree (keyed by XML tag)
   │  parser.ts (dispatch by tag name)
   ▼
RocketJson (types.ts)
   │  geometry.ts (profiles, planforms, masses)
   ▼
Enriched RocketJson
   │  onshape.ts (REST API)
   ▼
Onshape custom feature (separate repo)
```

---

## The .ork File Format (CRITICAL — read before editing parser)

The `.ork` file is a **ZIP archive** containing `rocket.ork` (the XML design) plus optional `thrustcurves/` and `images/` directories.

### XML structure (verified against real files, format 1.8–1.10)

```xml
<openrocket version="1.10">
  <rocket>
    <name>Rocket</name>
    <id>uuid</id>
    <designer>...</designer>
    <designtype>original</designtype>
    <referencetype>maximum</referencetype>
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <id>uuid</id>
        <subcomponents>
          <nosecone>...</nosecone>
          <bodytube>
            <subcomponents>
              <trapezoidfinset>...</trapezoidfinset>
            </subcomponents>
          </bodytube>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket>
</openrocket>
```

### ⚠️ Gotchas discovered (do NOT "fix" these back to the naive form)

1. **NO `<rocketcomponent>` wrappers.** Components appear **directly** inside `<subcomponents>`, keyed by their tag name (`<nosecone>`, `<bodytube>`, `<stage>`, etc.). The parser dispatches on the **object key** in the parsed `subcomponents` object, NOT on a wrapper.

2. **Stages appear directly** in the rocket's `<subcomponents>` (no wrapper). The parser treats any key in `subcomponents` as a component tag.

3. **Position method is an ATTRIBUTE, not text content:**
   ```xml
   <axialoffset method="bottom">0.1219</axialoffset>
   <position type="bottom">0.1219</position>   <!-- redundant duplicate -->
   <radiusoffset method="surface">0.0</radiusoffset>
   <angleoffset method="relative">0.0</angleoffset>
   <rotation>0.0</rotation>   <!-- fins: base rotation in degrees -->
   ```
   The parser reads `method`/`type` attributes via `valWithMethod()`.

4. **Body tubes use `<radius>`** for outer radius (not `<outerradius>`). Inner tubes / rings use `<outerradius>`.

5. **Fin tab position** uses `relativeto` attribute:
   ```xml
   <tabposition relativeto="center">0.01016</tabposition>
   ```
   Values: `front`/`top`, `center`/`middle`, `end`/`bottom`. The `relativeto="front|center|end"` form is the **legacy** (pre-2021) attribute; newer files emit both.

6. **Fin base rotation** is `<rotation>` (degrees), NOT `<angleoffset>`. The `angleoffset` element is the component's position around the body axis. For fin sets, `rotation` is the true base rotation.

7. **Materials** are elements with attributes + text content:
   ```xml
   <material type="bulk" density="1850.0" group="Composites">Fiberglass</material>
   ```
   `type` ∈ {`bulk`, `surface`, `line`}. Density in kg/m³.

8. **`<thickness>filled</thickness>`** means a solid body (not a shell). The parser sets `filled: true` and `thickness: -1` as a sentinel.

9. **`auto` radius values** appear as `auto` or `auto 0.025` — the parser extracts the numeric part and flags `autoOuterRadius`/`baseRadiusAutomatic`.

10. **Rail buttons** typically use `<preset>` (dimensions come from a preset database we don't ship). The parser falls back to explicit `<outerdiameter>` etc. if present.

11. **`<boosterset>`** is the legacy tag for `<parallelstage>` (pre-1.8). The parser maps both to `parallelstage`.

12. **fast-xml-parser config** is critical: `ignoreAttributes: false`, `attributeNamePrefix: '@_'`, `textNodeName: '#text'`, `parseTagValue: false`, `parseAttributeValue: false`. This keeps all values as strings so we control conversion.

13. **Sibling ORDER is lost by the default parse — recover it with a second `preserveOrder` parse.** The default ("prettified") output groups repeated sibling tags into arrays keyed by tag name, so when two tag types alternate (e.g. `nosecone, bodytube, transition, bodytube, transition`) the true interleaved order collides: both the second bodytube **and** the first transition share a group, and both transitions end up at the very end. Because position methods like `bottom` are **relative to the previous sibling**, this reorders the whole rocket. Fix: run a second `XMLParser` with `preserveOrder: true`, walk it with `rocketOrderLevel()`/`buildOrderLevel()` to get each `<subcomponents>` container's exact tag sequence, then have `parseChildren()` consume the prettified grouped fields **in that document order**. Field values still come from the prettified parse; the ordered parse only supplies ordering. See `src/parser.ts` (`OrderLevel`, `buildOrderLevel`, `rocketOrderLevel`).

---

## The JSON Schema (types.ts)

The output `RocketJson` has this shape (see `webapp/src/types.ts` for full types):

```ts
interface RocketJson {
  schemaVersion: string;      // "1.0"
  rocket: Rocket;
  warnings: string[];
}

interface Rocket {
  name: string;
  designer: string;
  revision: string;
  designType: string;
  kitName: string;
  referenceType: string;
  referenceLength: number;
  unitSystem: 'SI';
  components: RocketComponent[];
}

interface RocketComponent {
  type: ComponentType;        // 'nosecone' | 'bodytube' | 'trapezoidfinset' | ...
  name: string;
  id: string;                 // UUID from file format 1.9+
  material?: Material;
  position: Position;         // axial/angle/radius methods + offsets
  params: <union of per-type param interfaces>;
  children: RocketComponent[];
}
```

All dimensions are **SI** (meters, radians). Densities in kg/m³.

---

## Parser Design (parser.ts)

- `parseOrkFile(buffer)` — entry point: unzips, parses XML, returns `RocketJson`
- `parseChildren(el, warnings)` — iterates `subcomponents` object keys; each key is a component tag; dispatches via `COMPONENT_TAGS`
- `parseComponent(el, warnings, type)` — dispatches to per-type param parsers
- Per-type parsers: `parseSymmetricParams`, `parseBodyTubeParams`, `parseFinCommon` (+ trapezoid/elliptical/freeform), `parseTubeFinParams`, `parseLaunchLugParams`, `parseRailButtonParams`, `parseRingComponentParams`, `parseRecoveryParams`
- `parsePosition(el)` — reads `axialoffset`/`radiusoffset`/`angleoffset`/`rotation` with their `method` attributes

**Important:** The parser does NOT resolve `auto` radii or compute absolute positions — that's the geometry pass.

---

## Geometry Pass (geometry.ts)

`computeDerivedData(rocketJson)` mutates the JSON in place, adding:

- `params.profile` — discretized transition/nose-cone profile (50 points) for all 6 shape types
- `params.planform` — fin planform points (trapezoid/elliptical)
- `comp.mass` — estimated mass from volume × density

Key functions:
- `transitionRadius(shape, x, radius, length, param, clipped)` — ported from OpenRocket's `Transition.Shape`
- `transitionProfile(...)` — discretize a profile
- `trapezoidFinPoints(rootChord, tipChord, sweep, height)` — 4-corner planform with edge interpolation
- `ellipticalFinPoints(rootChord, height)` — 31-point half-ellipse (OpenRocket's POINT_X/POINT_Y tables)
- `tubeFinTouchingRadius(bodyRadius, finCount)` — `r·sin(π/n)/(1−sin(π/n))`
- `estimateComponentMass(comp)` — analytic volume × density per component type

---

## Onshape Client (onshape.ts)

- `createDocument(token, name)` — POST `/api/documents`
- `createPartStudio(token, did, wid, name)` — find or create a part studio
- `uploadToCustomFeature(token, target, rocketJson)` — finds the custom feature (type starts with `openRocket`), updates its `rocketJson` string parameter
- `uploadRocketToOnshape(token, rocketJson)` — convenience wrapper

**Note:** The uploader expects the custom feature to already exist in the part studio. The custom feature is written separately (out of scope).

---

## Testing

Test framework: **Vitest** (installed). Test files live in `webapp/test/`.

Real `.ork` test files in `webapp/test/ork/`:
- `demon 54.ork` — nosecone, tubecoupler, masscomponent, bodytube, trapezoidfinset, parachute, railbutton, transition, innertube, centeringring
- `Antar - Estes 7310.ork` — nosecone, masscomponent, transition, bodytube, parachute, shockcord, freeformfinset, podset, trapezoidfinset, launchlug, innertube, engineblock, centeringring
- `Bell X-1 - Starfire Design.ork` — similar to Antar
- `Kerbal.ork` — nosecone, bodytube, shockcord, parachute, trapezoidfinset, launchlug, transition, innertube
- `Low-Boom SST.ork` — nosecone, transition, bodytube, podset, freeformfinset, centeringring, parachute, shockcord, innertube

Run tests: `cd webapp && npm test` (or `npx vitest run`)

**Test files:**
- `webapp/test/parser.test.ts` — 26 tests: parses all 5 real .ork files, verifies metadata, stages, all component types (nosecone, bodytube, trapezoid/elliptical/freeform fins, parachute, railbutton, innertube, centeringring, transition, podset, launchlug, shockcord, engineblock, masscomponent), materials, position methods, instance counts, angle/radius offsets, and derived data (profiles, planforms, masses)
- `webapp/test/geometry.test.ts` — 22 tests: transition shape math (all 6 shapes), profile discretization, trapezoid/elliptical fin planforms, tube fin touching radius, and mass estimation formulas

**48 tests total, all passing.**

---

## Current State & Known Limitations

**Working:**
- Parser handles all 5 real test files (all component types present in them)
- Geometry pass computes profiles, planforms, masses
- UI: drag-drop, summary, JSON preview, download
- Onshape upload scaffolding (needs real token + custom feature to test end-to-end)

**Known limitations / TODOs:**
- `auto` radii are flagged but NOT resolved to actual values (the Onshape custom feature must resolve them against neighboring parts)
- Absolute positions (`position: [x,y,z]`) are not yet computed — the geometry pass only adds profiles/planforms/masses
- Rail button dimensions come from presets which we don't ship — only explicit values are parsed
- Cluster positions (inner tube clusters) are parsed but not expanded into per-tube coordinates
- The `findType` heuristic was replaced by tag-name dispatch — do NOT reintroduce heuristic detection

---

## How to Add a New Component Type

1. Add the XML tag to `COMPONENT_TAGS` in `parser.ts`
2. Add a `parseXxxParams` function
3. Add the param interface to `types.ts`
4. Add a case in `parseComponent`'s switch
5. Add mass estimation in `geometry.ts` (if external)
6. Add a test using one of the real `.ork` files (or a synthetic XML snippet)

---

## Reference: OpenRocket Source

The OpenRocket source is vendored at `openrocket-unstable/` (read-only reference). Key files for understanding the data model:

- `core/src/main/java/info/openrocket/core/rocketcomponent/*.java` — component classes
- `core/src/main/java/info/openrocket/core/file/openrocket/savers/*.java` — XML serialization (defines the .ork format)
- `core/src/main/java/info/openrocket/core/file/openrocket/importt/DocumentConfig.java` — setters for each XML element
- `fileformat.txt` — file format version history
- `ReleaseNotes.md` — feature timeline

The `docs/geometric-data-checklist.md` file (in repo root) is the user-checked data extraction checklist — it defines exactly which fields the web app should include.