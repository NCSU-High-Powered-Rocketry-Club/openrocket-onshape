# AI Agent Guide — OpenRocket → Onshape

This document is written for AI coding agents (and humans) who will work on this repository. It captures the architecture, the data model, the gotchas discovered while building the parser, and the current state of the project.

---

## Project Goal

Create a workflow that converts an **OpenRocket** (`.ork`) design file into a complete 3D model in **Onshape**:

1. **Static web app** (`webapp/`) — parses `.ork` → JSON geometry payload
2. **Onshape FeatureScript exporter** (`osFeature/`) — consumes the JSON and builds the Onshape sketches/solids

The web app and the FeatureScript exporter are maintained in this repository.

---

## Repository Layout

```
openrocket-onshape/
├── AI_README.md                    # This file
├── docs/
│   └── Onshape-Openrocket_PDF.pdf  # Reference PDF
├── local/                         # Working docs (gitignored)
    ├── geometric-data-checklist.md # Data extraction checklist (user-checked)
    ├── independent-audit-2026-09-29.md
    ├── feature-support-audit.md    # Per-component support audit
    ├── fix-plan-2026-09-29.md
    └── forumpost.md                # Forum post draft
├── openrocket-unstable/            # OpenRocket source (reference only, read-only)
├── webapp/                         # The static web app (Vite + vanilla TS)
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
        ├── types.ts                # JSON schema TypeScript types
        └── vite-env.d.ts
├── osFeature/                      # Onshape FeatureScript exporter
│   ├── main.fs                     # Feature entry point, transforms, completion
│   ├── component_sketches.fs       # Component sketches and fin snapping
│   └── utils.fs                    # Shared conversion/transform helpers
├── tools/
│   ├── build-fs.mjs                # FeatureScript debug / release build
│   └── build-fs.test.mjs           # Its tests (node --test)
├── skills/onshape-featurescript/   # FeatureScript research and authoring notes
```

**Comment convention in `osFeature/*.fs`.** Inline comments say *what* the code does, in one or two
lines; every *why* — a rule, a past failure, a rejected alternative — lives in the numbered notes at
the bottom of the file (`main.fs` notes 1–23, `component_sketches.fs` notes 1–36). Inline comments
cross-reference the note number rather than restating it. **No inline comment runs to more than two
lines**, including a function's `/** ... */` header; anything longer belongs in a numbered note. When
behaviour changes, add or extend a
note instead of growing the inline block. `skills/onshape-featurescript/SKILL.md` holds the
repo-independent FeatureScript knowledge (API cookbook, constraint/geometry traps); it deliberately
carries no rocket specifics.

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
   │  osFeature/main.fs + osFeature/component_sketches.fs
   ▼
Onshape FeatureScript model
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

   A current-format file writes the SAME offset **twice** — once legacy, once modern — so the parser
   must take the array and prefer the modern keyword (`toArray` + `find`). Reading it as a single
   object gives `relativeto == ''` and `parseNum` on the array gives `0`, which silently places
   every tab at `middle`, offset 0. `TAB_METHOD_ALIASES` in `parser.ts` also maps `absolute` and
   `after` explicitly; folding those into `middle` misplaces those tabs just as badly.

6. **Fin base rotation** is `<rotation>` (degrees), NOT `<angleoffset>`. The `angleoffset` element is the component's position around the body axis. For fin sets, `rotation` is the true base rotation.

7. **Materials** are elements with attributes + text content:
   ```xml
   <material type="bulk" density="1850.0" group="Composites">Fiberglass</material>
   ```
   `type` ∈ {`bulk`, `surface`, `line`}. Density in kg/m³.

8. **`<thickness>filled</thickness>`** means a solid body (not a shell). The parser sets `filled: true` and `thickness: -1` as a sentinel.

9. **`auto` radius values** appear as `auto` or `auto 0.025` — the parser extracts the numeric part and flags it: `autoOuterRadius` (body tubes) and `baseRadiusAutomatic`/`foreRadiusAutomatic` (nose cones & transitions, for aft/base vs fore radii).

10. **Rail buttons** typically use `<preset>` (dimensions come from a preset database we don't ship). The parser falls back to explicit `<outerdiameter>` etc. if present.

11. **Boosters are `<parallelstage>` assemblies** (legacy tag: `<boosterset>`). Like pod sets, they are body-less ring-instanced assemblies: the webapp parses their children, derives length from direct `AFTER` children, resolves `RELATIVE` radius against the assembly bounding radius, and the FeatureScript patterns the child trees around the booster axis. Stage separation fields are retained as simulation metadata but do not alter CAD geometry.

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
  type: ComponentType;        // includes nosecone/bodytube/trapezoidfinset/
                             // ellipticalfinset/freeformfinset/tubefinset/...
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

- `params.profile` / `params.innerProfile` — the full meridian section of a nose cone or transition, outer and bore, in `[radius, y]` coordinates with **aft at y=0 and fore at y=length** (so a shoulder extends to y < 0 or y > length). Both are built by `symmetricProfile` and already include shoulders, bridging discs, the bore step across those discs, the axis clipping, and capped ends. The FeatureScript draws these two polylines plus two end faces and makes no further decisions.
- `params.innerIsAxis` — the component is solid, so the bore is the axis
- `params.totalLength` — `length` plus both shoulder lengths
- `params.planform` — trapezoidal and elliptical fin points; elliptical uses OpenRocket's 31-point upper half-ellipse
- `params.length` — **derived** for freeform fin sets: the root chord, `points[n-1].x − points[0].x`. This is *not* the bounding x-span `max(x) − min(x)`, which overstates a swept or raked outline whose tip reaches further aft than its root does. It is what `AxialMethod.BOTTOM` subtracts from the parent length, so an overstated value places the fin too far forward and can push its root chord past the parent's fore end.
- `params.offsetRadius` — parent surface radius for fin/tube-fin/launch-lug placement
- `comp.mass` — estimated mass from volume × density

It also **resolves auto radii** (`resolveAutoRadius`), matching OpenRocket semantics:
- A tube fin's `<radius>auto</radius>` is resolved from the parent surface radius and fin count using `tubeFinTouchingRadius`.
- A transition's auto **fore** radius (`<foreradius>auto …</foreradius>`) comes from the **previous** axial component's rear radius. Unlike a nose cone tip, a transition's fore radius is generally **non-zero**.
- A body tube's auto outer radius comes from the previous (else next) axial component.
- A nose cone / transition auto **base** (aft) radius comes from the **next** axial component.

When a radius is marked `auto`, the numeric neighbor value is **always** used (the stored number such as `auto 0.025` is a placeholder). The forward pass runs left→right so chained autos propagate (an auto body tube resolves from the nose cone, then feeds the transition fore radius that follows it).

Key functions:
- `symmetricProfile(params)` — the outer + bore meridian section of a nose cone or transition, including both shoulders (see below). The single source of truth for the section.
- `transitionRadius(shape, x, radius, length, param, clipped)` — ported from OpenRocket's `Transition.Shape`
- `transitionProfile(...)` — discretize a profile to `[radius, length]`, fore at y+
- `trapezoidFinPoints(rootChord, tipChord, sweep, height)` — 4-corner planform with edge interpolation
- `ellipticalFinPoints(rootChord, height)` — 31-point upper half-ellipse using OpenRocket's parametric formula
- `freeformFinLength(points)` — root chord `points[n-1].x − points[0].x`, matching OpenRocket's `FinSet.getLength()` → `getRootChord()`. Only the first and last points matter; the FeatureScript treats those two as the fore and aft **root** points, so the web app must use the same convention.
- `tubeFinTouchingRadius(bodyRadius, finCount)` — `r·sin(π/n)/(1−sin(π/n))`
- `estimateComponentMass(comp)` — analytic volume × density per component type
- `resolveAutoRadius(comps, warnings)` — auto-radius resolution pass (see above)

---

## Shoulders (nose cones and transitions only)

`<foreshoulder*>` / `<aftshoulder*>` exist on exactly two component types, `nosecone` and
`transition`. Nothing else has them. Each is built by **`shoulderProfile(params, 'fore' | 'aft')`**
as its own closed polygon, published as `params.shoulderProfile.{fore,aft}` (`null` when that end
has no shoulder). The FeatureScript revolves each one separately and boolean-unions it onto the
body of the component carrying the attribute — see the status section below.

- **A shoulder exists only when it has both a radius and a length.** Shipped files are full
  of a non-zero `<aftshoulderradius>` with a zero length; that is "no shoulder", and
  `shoulderProfile` returns `null` so it adds no geometry.
- **A shoulder is solid** when `thickness <= 0` or `thickness >= radius`. Both forms occur in
  real designs: a 20.2184 mm shoulder of thickness 20.2184 mm (solid plug) next to a 14 mm
  shoulder of thickness 1 mm (thin tube).
- **A shoulder's thickness is its own**, independent of the component wall. `TestBooster.ork`'s
  transition has a 2 mm body wall and a 3 mm fore shoulder, so the bore is 0.01775 through the
  shoulder and steps to 0.01875 at the join.
- **The connector step belongs to the shoulder.** A shoulder's radius routinely differs from the
  component's end radius (a 20.7645 mm nose cone base against a 20.2184 mm shoulder), so the
  outline runs in (or out) to the body's own end radius at the body's end plane, and the **bore
  steps to the body's own bore radius there**. That flat annulus is the face the two bodies
  share, so the union has something to match on — and it is what keeps the wall thickness
  honest instead of jumping to the shoulder's.
- **A solid shoulder is the one exception**: it has no bore of its own, so the axis is the
  honest answer all the way to the join and its end face is a full *disc* that overlaps the
  body's end annulus rather than matching it. A union is happy with overlapping solids.
- **`capped`** closes the shoulder's bore with a disc of the shoulder's own wall thickness, at
  its **free** end. Uncapped, the end face spans only the wall and the bore stays open. A solid
  shoulder ignores the flag.
- **`length` stays the bare cone/transition length.** The shoulders extend *beyond* it, and the
  occupied extent is published separately as `params.totalLength`.

Two things this changed elsewhere, both deliberate:

- The bore is **clamped to the component's end planes** and its two ends pinned to them — but a
  point that is **on the axis is never moved**. See the bore-pin section below.
- **Filling and caps are one code path.** A solid component arrives with `innerIsAxis` and a
  two-point axis bore; a walled one arrives with a real bore. The FeatureScript no longer
  branches on `thickness`, `filled` or shape, and the old quadrilateral shortcut for plain
  cones is gone.

### Stacking: a shoulder overlaps the next component, and that is correct

`totalLength` is published but **not** used for stacking. `determineComponentLength` advances by
`params.length` alone, so a component with a shoulder overlaps whatever follows it. That looks
like a bug and is not — it is what OpenRocket does, confirmed in its source (branch `unstable`;
paths under the old `net.sf.openrocket` package all 404, which is why this went unanswered
before):

- `Transition` does **not** override `getLength()`, so it returns the bare `length` field,
  shoulders excluded.
- `RocketComponent.getAxialOffset(...)` passes `parent.getLength()` as the `outerLength`, and
  `AxialMethod.AFTER` is `outerLength + offset`.
- `Transition.getComponentBounds()` puts the fore shoulder at `x ∈ [-foreShoulderLength, 0]` and
  the aft at `[getLength(), getLength() + aftShoulderLength]` — the shoulder deliberately extends
  *beyond* the length it is stacked by.

`determineComponentLength` remains the single place to switch to `params.totalLength` if that
ever stops being true.

---

## Status: shoulders are a separate sketch, revolved and boolean-unioned

`schemaVersion` is `1.2` and `EXPECTED_SCHEMA_VERSION` matches. The flow, per component:

```
[ body profile ]     -> sketch -> revolve  -> base body  -.
                                                              opBoolean UNION -> result
[ shoulder profile ] -> sketch -> revolve  -> shoulder    -'
```

- `symmetricProfile` is the **body alone** — no shoulders, no bridging discs, no bore step.
- `shoulderProfile(params, 'fore' | 'aft')` returns ONE shoulder's closed polygon, or `null`.
  `computeDerivedData` publishes it as `params.shoulderProfile.{fore,aft}`.
- `sketchShoulder` draws it into **its own sketch**, `sketchShoulder`'s `newSketchOnPlane` in
  `unionShoulders`, on the same plane and revolve axis as the body.
- `unionShoulders` revolves that sketch into a **separate body** and unions it onto the body of
  the component that carries the shoulder attribute, then returns the **union result** so the
  caller still names, colours and materials the merged body.

**A shoulder is drawn with `skPolyline`, not `skFitSpline`.** Its meridian is a polygon — a
straight cylindrical wall, a flat connector step where its radius differs from the body's end
radius, and a flat disc across the bore when `capped`. A fitted spline would round the
connector step off, and that flat face is exactly what the union matches on; round it and the
shoulder has nothing to butt against. `drawOutline` (the axis-run handling) is for the body's
genuinely curved outline only.

144 tests pass. The two bore-pin regression tests are retained alongside the shoulder tests.

### Kept from the reverted experiment

- **A failed `opRevolve` throws and silently truncates the run.** An uncaught throw aborted the
  rest of `createComponents`, so the log stopped at the first casualty — indistinguishable from
  a truncated paste. Every revolve is now wrapped in `try`/`catch`.
- **`drawOutline`**, which draws any run of axis points on the body's outer or bore outline as
  straight segments, skips a one-point run (`skPolyline` needs > 1), and starts the spline *at*
  the intercept so the run and the curve share it. Without that last part the outline is not
  closed.
- The `[face]`, `[revolve]`, `[shoulder]` and `[done]` diagnostics.

## The bug: the bore pin was deleting solid material

`REVOLVE_FAILED` on `Bell X-1`'s main transition, and the cause was in `symmetricProfile`'s
bore clamp-and-pin — not the shoulders, and not the sketch.

Where a wall is thicker than the local radius, the bore legitimately dies out partway along the
component and the section is **solid** from that axis intercept out to the end. The pin then
dragged the intercept forward onto the end plane:

```ts
bodyInner[0][1] = L;                        // unconditional — this is the bug
```

Bell X-1's transition is 2 mm wall on a 1.143 mm fore radius, 127 mm long, so:

| | y |
|---|---|
| component fore end | 0.127 |
| bore's genuine axis intercept | 0.11994 |
| **solid nose cone destroyed by the pin** | **7.06 mm** |

The intercept is a real point on the axis at `y = 0.11994`, not at the end. Moving it to `0.127`
deleted the whole solid length, so the region met the axis in a **single vertex** — the shape
`opRevolve` refuses. Onshape needs the axis contact to be a line.

Two changes, both in `symmetricProfile`:

1. **Never move a point that is on the axis.** The pin now only squares off an end whose bore
   point is genuinely off the axis.
2. **Add the end plane's own axis point** when the bore dies out short of it, so the section
   meets the axis along a real segment — `[0, 0.127]` ahead of `[0, 0.11994]`, a 7.06 mm line.

Verified against the same component set:

| component | before | after |
|---|---|---|
| main transition (2 mm wall, 1.143 mm fore radius) | 1 axis point, `REVOLVE_FAILED` | 2 axis points, 7.06 mm line |
| rudder transition (thin wall, never reaches axis) | pinned to the end planes | unchanged |
| solid nose cone | 2-point axis bore | unchanged |

Two regression tests cover both halves, so the pin cannot silently return.

### Why it was hard to see

The `[revolve]` diagnostics print the section *before* the call, so `outerMinR=0 innerMinR=0`
looked identical before and after — the shape was degenerate either way. What distinguished the
cases was the *count* of axis points, which nothing was reporting. And the `try`/`catch` was what
made the rest of the rocket visible at all: a failed `opRevolve` throws, and an uncaught throw
aborts the remainder of `createComponents`, so the log always stopped at the first casualty.

## Onshape FeatureScript exporter

The FeatureScript entry point is `osFeature/main.fs`; component sketch builders are in `osFeature/component_sketches.fs`.

- `oroFeature` — reads the JSON payload, creates one sketch per component, completes solids, patterns instances, and assigns materials/appearance.
- `main.fs` — component transforms, axial positioning, elliptical-fin completion, and patterning.
- `component_sketches.fs` — body/revolution profiles, planar fin snapping, elliptical half-ellipse profiles, and tube-fin sections.
- `utils.fs` — point conversion, transform helpers, and Euler rotation construction.

**Debug vs. release build.** `osFeature/*.fs` is written with all its `println`
diagnostics in place, guarded by a `const DEBUG_*` flag. `tools/build-fs.mjs`
strips them for publishing: `npm run fs:release` writes
`dist/featurescript/release/*.fs` to paste into Feature Studio, `npm run fs:debug`
writes a banner-marked copy that behaves identically, and `npm run fs:check`
validates a release build without writing (it runs in CI). A `println` the user
needs to see survives with a `// @keep` comment above it; a debug branch must be
braced and must not test its flag with `!`, or the build refuses rather than
guessing. Full rules, including how debug-only helpers are detected, are in
`local/featurescript-build.md`. **Edit `osFeature/`, never `dist/`.**

FeatureScript-specific rules:

- Keep all component sketches flat and coplanar; apply elliptical-fin cant after extrusion with `opTransform`, before the angular `opPattern`.
- For `opTransform`, retain the original body query as the pattern source; `qCreatedBy(transformId, ...)` is not a reliable pattern source.
- For automatic tube-fin radii, use the derived `params.offsetRadius` and `tubeFinTouchingRadius()` result.
- Planar-fin profile points are converted to `(offsetRadius + radial, -axial)` sketch coordinates.
- Elliptical fins use OpenRocket's 31-point upper half-ellipse, not a mirrored full ellipse.
- Curved transitions and nose cones are drawn from the serialized `profile` / `innerProfile` arrays via `skFitSpline` + closing lines — never as a quadrilateral, which would leave the sketch empty and produce no body.

**Snapping a fin root onto a curved parent.** `drawSnappedFinOutline` is where fins meet parent
outlines, and two rules are easy to get wrong on a *tapering* parent (a body tube, with its
constant radius, hides both):

- **Match a root end past the curve's axial end on its radial term only.** OpenRocket clamps a
  fin root's radius to the parent's aft radius (`profile_y = max(y, aftRadius)`) and closes the
  outline with a segment from the last point to the nearest point of the parent profile. That
  segment is *horizontal* — both ends sit at the same radius — so the axial part of the gap is
  a link to draw, not a snap failure. Measuring the full 3D distance conflates the two, so a fin
  at exactly the right radius still reports millimetres, misses the tolerance, matches nothing,
  and degrades to a bare root chord. `rootMatchDistance` measures only the radial term once the
  root end leaves the curve's span.
- **Measure a curved parent against its own samples, not its chord.** A projected curve is drawn
  as a spline whose interior bow is not a line, so `nearestOnCurve2D` uses the edge's sampled
  points (`evEdgeTangentLines` + `worldToPlane`); only straight sources fall back to the segment.

Both return **lengths**, so they carry no `returns` annotation — a quantity is a different type
from `number` in FeatureScript, and annotating `returns number` fails with
`Return value should be number, was map`. See `skills/onshape-featurescript/SKILL.md` §2 and §4
for the related language and API traps (no spread operator, `skSplineSegment` has no `guess` key,
forward references are allowed).

**Fin tabs.** `sketchFinTab` draws the tab in its own sketch (it cannot share the fin's: the two
regions touch or overlap, and `createComponents` keeps only `qSketchRegion(sketchId)[0]`). The
top edge is the **projection of the parent's surface**, not drawn geometry — see
`component_sketches.fs` notes 22 and 24. Three things there are easy to get wrong:

- **Pin an axial coordinate with a *signed* relation.** A `DISTANCE` of `abs(y)` against a point on
  the axis is satisfied equally by `-y`. The solver takes the mirror whenever the coordinate is
  positive — and a tab longer than its own root chord, centred on the chord, always puts its fore
  end ahead of the fin's leading edge, so this is an ordinary case, not an edge case. Symptom: the
  tab is drawn mirrored about the fin's leading edge, `D` shape-wide, and only a `[tab] asked for:`
  vs. solved-curve comparison shows it. Use `HORIZONTAL`/`VERTICAL` between the point and a **fixed**
  reference, or `FIX` the point outright.
- **A corner that must be *off* a curve needs a riser.** Offsetting the corner for the union overlap
  (note 25) *and* constraining it onto the projection asks one point to be two places; the solver
  resolves it by dragging the projection out to meet the corner, so the tab's top edge stops being
  the parent's surface. Draw a short segment from the fixed corner to the curve and constrain only
  the segment's inner end.
- **Snap the tab to the PARENT's sketch.** `completeComponent` must receive `parentOwnSketch`, not
  the component's own sketch — the loop in `createComponents` rebinds that field, and reading it
  after the rebind hands the tab the fin's own outline. On a straight parent the two coincide and
  the bug is invisible; on a tapered one the tab's top edge becomes the fin's straight chord. See
  `main.fs` note 17.

Tab extent itself follows OpenRocket's `AxialMethod.getAsPosition(offset, tabLength, chord)` for
all five methods (`top`/`absolute`, `after`, `middle`, `bottom`), and is deliberately **not** clamped
to the chord — a tab may legitimately overhang either end, and `finTabExtent` documents why.

---

## Testing

Test framework: **Vitest** (installed). Test files live in `webapp/test/`.

Real `.ork` test files in `webapp/test/ork/`:
- `demon 54.ork` — nosecone, tubecoupler, masscomponent, bodytube, trapezoidfinset, parachute, railbutton, transition, innertube, centeringring
- `Antar - Estes 7310.ork` — nosecone, masscomponent, transition, bodytube, parachute, shockcord, freeformfinset, podset, trapezoidfinset, launchlug, innertube, engineblock, centeringring
- `Bell X-1 - Starfire Design.ork` — similar to Antar
- `Kerbal.ork` — nosecone, bodytube, shockcord, parachute, trapezoidfinset, launchlug, transition, innertube
- `Low-Boom SST.ork` — nosecone, transition, bodytube, podset, freeformfinset, centeringring, parachute, shockcord, innertube
- `TestBooster.ork` — nosecone, bodytube, transition, freeformfinset (bottom-positioned on a **narrowing ellipsoid** transition), parallelstage/booster set. The regression case for both the freeform root-chord length and the curved-parent fin snap.

Run tests: `cd webapp && npm test` (or `npx vitest run`)

The FeatureScript build has its own tests, run with Node's built-in runner and no
dependencies: `npm run fs:test` (`node --test "tools/*.test.mjs"`). They cover the
stripper's awkward cases — else-chains, unbraced branches, negated flags, a
helper only reachable from another file's debug branch — and assert that the
real `osFeature/` sources strip cleanly.

**Test files:**
- `webapp/test/parser.test.ts` — 63 tests: parses the real .ork files, verifies metadata, stages, all component types (including elliptical and tube fins), automatic tube-fin radius resolution, materials, position methods, instance counts, angle/radius offsets, fin-tab position handling, and derived data.
- `webapp/test/geometry.test.ts` — 94 tests: transition shape math, profile discretization, trapezoidal/elliptical/freeform fin planforms, tube-fin touching radius, parent-radius placement, mass estimation, and validation/storage helpers.
- `webapp/test/colors.test.ts` — 4 tests: colour parsing and conversion.

**161 tests total, all passing.**

---

## Current State & Known Limitations

**Working:**
- Parser handles all the checked-in test rockets plus synthetic coverage for automatic tube-fin radii and elliptical fins
- Geometry pass computes profiles, planforms, masses
- UI: drag-drop, summary, JSON preview, download
- FeatureScript exporter: flat component sketches, planar-fin snapping, elliptical half-ellipse geometry, tube-fin geometry, cant, angular patterning, and separate-shoulder boolean unions

**Known limitations / TODOs:**
- Absolute positions (`position: [x,y,z]`) are not yet computed — the geometry pass only adds resolved radii, profiles/planforms/masses
- The `[face]` / `[revolve]` / `[shoulder]` / `[done]` println diagnostics are still in place and
  are marked TEMPORARY. They are verbose; remove them once no further diagnosis is needed. The
  `try`/`catch` around each revolve is **not** temporary — it is load-bearing.
- Shoulder unions have been verified on `TestBooster.ork` only. A component carrying **two**
  shoulders (fore *and* aft) is not present in any checked-in rocket, so that path is
  unexercised.
- Rail button dimensions come from presets which we don't ship — only explicit values are parsed
- Cluster positions (inner tube clusters) are parsed but not expanded into per-tube coordinates
- The `findType` heuristic was replaced by tag-name dispatch — do NOT reintroduce heuristic detection
- **Fin-tab union is not yet confirmed working.** The last regen reported
  `union produced no body -- keeping the fin alone` on both fin sets, so the guard drops the tab and
  no tab appears in the solid. The corner/riser rework (notes 24 and 17) gives the boolean real
  material to interpenetrate with, but that needs one regen to confirm. Check for `[tab] … region
  faces=1` followed by a successful union before treating tabs as done.
- **A tab overhanging BOTH ends of its parent** is unexercised: no checked-in rocket has it, so the
  double-bridge path has never been observed forming a face.

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

The `local/geometric-data-checklist.md` file is the user-checked data extraction checklist — it defines exactly which fields the web app should include.