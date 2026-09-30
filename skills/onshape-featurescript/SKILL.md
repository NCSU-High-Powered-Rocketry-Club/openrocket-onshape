---
name: onshape-featurescript
description: Research workflow, verified API cookbook, and gotchas for writing Onshape FeatureScript (sketches, constraints, queries, evaluations) custom features. Use when creating or debugging .fs Feature Studio code, sketch constraint systems, or geometry evaluation code.
---

# Onshape FeatureScript — research & authoring skill

FeatureScript cannot be compiled or linted outside Onshape. Therefore: **verify every
API against std source before using it**, prefer APIs that appear in std's own usage
examples, and always ask the user to paste code into a Feature Studio and report
regen errors.

## 1. Research workflow (do this before writing code)

1. **Clone the std source mirror** (fastest ground truth — full doc comments, MIT):
   ```
   git clone --depth 1 https://github.com/javawizard/onshape-std-library-mirror /tmp/os-std
   ```
   Flat `*.fs` files (`sketch.fs`, `evaluate.fs`, `query.fs`, `surfaceGeometry.fs`,
   `curveGeometry.fs`, `geomOperations.fs`, `common.fs`, ...). Then `grep`/`sed` locally
   for the exact signature, accepted map fields, and a real usage example. **Never
   trust a function's existence/shape without seeing it here or in the official docs.**

2. **Official docs** (https://cad.onshape.com/FsDoc/):
   - `index.html` — guide hub. Pages are flat, e.g. `modeling.html`, `values.html`,
     `imports.html`, `annotations.html`, `feature-types.html`, `tutorials/…`.
   - `library.html` — the ENTIRE standard-library reference as one ~1.8 MB page.
     Web fetch tools truncate it; **download and grep locally instead**:
     ```
     curl -s https://cad.onshape.com/FsDoc/library.html -o /tmp/library.html && grep ...
     ```
3. **Wire-level (BTM) schema** — how Onshape's UI stores sketches/constraints; the
   FeatureScript `skConstraint` map mirrors these parameter ids:
   - `PrincetonLIPS/SketchGraphs` → `sketchgraphs/data/_constraint.py`
     (constraint types, `localFirst/localSecond`, `externalFirst/externalSecond`,
     `direction`, `length`, `alignment`, `halfSpace0/1`).
   - `ReshefElisha/jarvis-onshape-mcp` → `builders/sketch_constraints.py`,
     `knowledge_base/api/sketch_creation_guide.md`,
     `scripts/probe_sketch_constraint_fixtures.py` (live-probed constraint shapes;
     e.g. `POINT_ON` == COINCIDENT with a point sub-ref; `HORIZONTAL_DISTANCE` /
     `VERTICAL_DISTANCE` == DISTANCE + `direction`).
4. Web search engines / grep.app are often blocked or flaky; the GitHub REST API
   (repo search works unauthenticated) + `curl` + local `grep` is the reliable path.

## 2. Language essentials

- Header: `FeatureScript 3044;` then imports. `import(path : "onshape/std/common.fs",
  version : "3044.0");` re-exports most modules (query, evaluate, context, sketch,
  surfaceGeometry, curveGeometry, mathUtils→vector, units, containers…). Other
  documents import by document id + microversion: `import(path : "a0cb…", version : "…")`.
- Functions may mix typed and untyped params: `function f(a is Context, b, c is array)`.
  `returns T`, optional `precondition { … }` blocks. Untyped params accept `undefined`.
- Values: maps `{"key" : v}`; arrays via `makeArray(n)`, `append(arr, v)`, `size`,
  `arr[i]` read/write on `var`; membership `x in arr`; ternary `c ? a : b`;
  string concat `~` (numbers stringify: `".line" ~ i` → `".line3"`).
- Units: `5e-3 * meter`, `vector(x, y) * units`. `ValueWithUnits` compares/arithmetic
  work across compatible units. `dot(unitlessDir, lengthVec)` is fine (std pattern);
  `unitlessVec * lengthScalar` returns a length vector.
- `println(value)` writes to the FeatureScript notices pane and appends a newline;
  `println()` writes only a newline. `println` does not change model state. Use
  string labels with `~` and `toString()` when combining diagnostics:
  ```featurescript
  const length = 42 * centimeter;
  println("length: " ~ toString(length));
  println("length in inches: " ~ toString(length / inch));
  println("point: " ~ toString(point));
  println("transform: " ~ toString(tform));
  ```
  A vector printed directly includes its units when it is a `ValueWithUnits`.
- **Vector units are component-wide.** A vector passed to an angle-only API such
  as `rotationMatrix3dEulerXYZ` must have an angular unit on every component.
  Prefer multiplying the whole unitless vector:
  ```featurescript
  rotationMatrix3dEulerXYZ(vector(0, tiltAngle, 0) * radian);
  rotationMatrix3dEulerXYZ(vector(90, 0, 0) * degree);
  ```
  `vector(0, tiltAngle * radian, 0)` is invalid because the first and third
  components are still unitless. For length vectors, use one shared unit for
  every component (`vector(x, y, z) * units`); for directions, keep the vector
  unitless and multiply by a length only when a point/vector with units is
  required. `ValueWithUnits` vectors can be divided by a compatible unit before
  printing when a particular unit system is desired.
- Vector math: `dot`, `cross`, `norm`, `normalize` (vector.fs). Compare geometry with
  `tolerantEquals` (≈1e-8 m / 1e-11 rad), not `==`.
- Typechecks: `value is Line`, `definition is BSplineCurve`, etc. work on tagged maps.
- **A quantity is NOT a `number`.** `norm`, `sqrt`, `min`, `max` and any arithmetic on
  lengths return a *quantity* (`Length`), which is a distinct type from a bare `number`.
  A function annotated `returns number` that returns `norm(v)` is a type error, and the
  compiler names the quantity by its internal representation:
  `Return value should be number, was map`. Omit the return annotation for
  quantity-returning helpers, as std itself does for `norm`/`min`/`sqrt`. Annotate only
  when the value really is a bare number (an index, a count).
- **No spread operator.** `...(cond ? {…} : {})` inside a map literal is a parse error
  (`no viable alternative at input`). Build the map, then conditionally assign keys, or
  branch on whole separate calls.
- **Forward references between functions are allowed** — a function may call one defined
  further down the same file, so definition order is a style choice, not a constraint.
- Transforms compose right-to-left: `t1 * t2` applies t2 first. `toWorld(cs)` gives
  the cs→world Transform.
- **`Sketch` is an OPAQUE builtin** — no `sketch.id`/`sketch.context` access. Carry
  `sketchId` (and anything else needed) alongside the Sketch object when plumbing.

## 3. Verified API cookbook

### Sketch creation & entities (sketch.fs)
- `newSketchOnPlane(context, id, {"sketchPlane" : plane})` → `Sketch`; finalize with
  `skSolve(sketch)`. After solving: curves = WIRE bodies, regions = SURFACE bodies,
  loose points = POINT bodies — find regions with `qSketchRegion(sketchId)`.
- 2D coords passed to sk* functions are length-Vectors in the plane's (x, y) frame.
  Convert 3D→2D with `worldToPlane(plane, worldPt)` and back with
  `planeToWorld(plane, pt2d)` (surfaceGeometry.fs) — `worldToPlane` output feeds
  sketch functions directly.
- `Plane` = `{origin (3D length), normal (unit), x (unit)}`; its y = `cross(normal, x)`.
  Build with `plane(cSys)` = `plane(cSys.origin, cSys.zAxis, cSys.xAxis)`.
- `skLineSegment(sketch, lineId, {"start", "end", "construction"?})` → `{startId, endId}`.
- `skPoint(sketch, pointId, {"position"})`.
- `skPolyline(sketch, polylineId, {"points", "construction"?, "constrained"?})`:
  draws `polylineId.lineN` from point N→N+1 (N = 0…size−2); endpoint refs are
  `polylineId.lineN.start` / `.end`. `constrained : true` adds COINCIDENT constraints
  between consecutive segments (endpoints are NOT auto-merged otherwise!), and a
  closing coincidence when `points[0] ≈ points[last]` (pass the first point again to
  close a loop).
- `skFitSpline(sketch, splineId, {"points"})` (interpolating), `skArc`, `skCircle`,
  `skEllipse`, `skRectangle` (sub-ids `.left/.right/.top/.bottom`, corner refs like
  `rectId.left.start`), `skText`, `skImage`, `skConicSegment`.

### Constraints (skConstraint)
`skConstraint(sketch, constraintId, map)` — map fields:
- `constraintType : ConstraintType` (COINCIDENT, PARALLEL, VERTICAL, HORIZONTAL,
  PERPENDICULAR, TANGENT, MIDPOINT, EQUAL, DISTANCE, LENGTH, ANGLE, RADIUS,
  FIX, PROJECTED, …).
- `localFirst` / `localSecond` : entity id **strings**, optionally with a sub-point
  suffix — `".start"`, `".end"`, `".center"` (also `".<N>"` offset-chain in UI terms).
- `direction : DimensionDirection.{MINIMUM, HORIZONTAL, VERTICAL}` for DISTANCE.
- `length` (ValueWithUnits; the wrapper drops it if not a length) and `angle`.
- `alignment : DimensionAlignment.{UNSPECIFIED, ALIGNED, ANTI_ALIGNED}` — use
  **ANTI_ALIGNED when localFirst is further along the positive axis than
  localSecond** (e.g. vertically higher / to the right); otherwise ALIGNED.

Proven shapes (std sheetMetalHem.fs is the best real example):
```
// point-on-curve (UI "point on entity"): point sub-ref + curve id
skConstraint(sketch, "c1", { "constraintType" : ConstraintType.COINCIDENT,
        "localFirst" : "line1.end", "localSecond" : "arc2" });

// pin an entity
skConstraint(sketch, "c2", { "constraintType" : ConstraintType.FIX,
        "localFirst" : "point1" });

// dimension: axis-aligned distance between two refs
skConstraint(sketch, "c3", { "constraintType" : ConstraintType.DISTANCE,
        "localFirst" : "line1.start", "localSecond" : "helper.end",
        "direction" : DimensionDirection.VERTICAL,
        "length" : 12 * millimeter, "alignment" : DimensionAlignment.ALIGNED });
```
Notes: `POINT_ON` is not a type — use COINCIDENT with a point sub-ref.
`HORIZONTAL_DISTANCE`/`VERTICAL_DISTANCE` are DISTANCE + `direction`.
The BTM schema also has `externalFirst`/`externalSecond` (query-list references to
foreign geometry, e.g. planes or the sketch origin `IB`) — not documented in FS's
`skConstraint`, but the std wrapper forwards its map verbatim to `@skConstraint`,
and with `ConstraintType.PROJECTED` this performs the UI's "Use/Project" exactly
(proven working shape). Create the projected
copy's entity FIRST as an entity of the matching type — `skLineSegment` for
straight sources, `skSplineSegment` for curved ones — then drive it with three
PROJECTED constraints. Notes: a type-mismatched entity (e.g. a spline entity for
a line source) silently fails to take the projection; a *bare* `skLineSegment`
(no start/end) keeps placeholder geometry at the sketch origin and the
constraints do NOT fix it (profiles end up inset to the axis). For line sources,
draw `skLineSegment` between the projected end points (exact — no sampling) and
leave it unconstrained: the PROJECTED constraints mis-drive line entities (drag
them onto the wrong axis). For curved sources a bare `skSplineSegment` driven by
the three constraints is fine:

```fs
// entity matching the source curve type: for straight curves use
// skLineSegment(sketch, "curve1", { "start" : projectedStart, "end" : projectedEnd,
//                                   "construction" : false, "index" : "1" });
skSplineSegment(sketch, "curve1", { "construction" : false, "index" : "1" });
// start point ("use end")
skConstraint(sketch, "curve1.start.project", {
        "constraintType" : ConstraintType.PROJECTED,
        "index" : "1",
        "name" : "",
        "projectionType" : SketchProjectionType.USE_END,
        "localFirst" : "curve1.start",
        "externalVertex" : qUnion([startVertexEntity]),
        "externalVertexEdge" : qUnion([edgeQuery]),
        "sketchToolType" : SketchToolType.USE });
// end point ("use end")
skConstraint(sketch, "curve1.end.project", {
        "constraintType" : ConstraintType.PROJECTED,
        "index" : "2",
        "name" : "",
        "projectionType" : SketchProjectionType.USE_END,
        "localFirst" : "curve1.end",
        "externalVertex" : qUnion([endVertexEntity]),
        "externalVertexEdge" : qUnion([edgeQuery]),
        "sketchToolType" : SketchToolType.USE });
// curve shape ("use")
skConstraint(sketch, "curve1.project", {
        "constraintType" : ConstraintType.PROJECTED,
        "index" : "2",
        "name" : "",
        "projectionType" : SketchProjectionType.USE,
        "localFirst" : "curve1",
        "externalSecond" : qUnion([edgeQuery]),
        "sketchToolType" : SketchToolType.USE });
```

`externalVertex` holds the source vertex (an `evaluateQuery` result is fine inside
`qUnion`), `externalVertexEdge` its owning edge query. Constraint ids follow
Onshape's `"<entity>[.start|.end].project"` naming. `SketchProjectionType`
(`USE`, `USE_END`, `SILHOUETTE_START`, `SILHOUETTE_END`) and `SketchToolType` are
exported by sketch.fs. For other constraint types prefer local entities; draw/keep
local copies of foreign curves when constraints must reference them.

### Queries & evaluations
- `qCreatedBy(id, EntityType.EDGE|VERTEX|BODY|FACE)` — sketch curves are EDGES of
  the WIRE bodies created by the sketch id.
- `qAdjacent(seed, AdjacencyType.VERTEX, EntityType.VERTEX)`, `qEdgeVertex(q, atStart)`,
  `qNthElement(q, n)`, `qSketchRegion(id)`, `qSketchFilter(q, SketchObject.YES)`,
  `sketchEntityQuery(opId, entityType, sketchEntityId)`, `evaluateQuery(context, q)`.
- `evDistance(context, {"side0", "side1"})` → `DistanceResult`:
  `distance` (length) and `sides` = 2 maps `{point (world 3D), index, parameter}`.
  **A side may be a raw 3D point (`vector(...) * meter`)**, a Query, a `Line`, a
  `Plane`, or arrays of points/Lines/Planes. `sides[1].point` is the closest world
  point on side 1; `sides[1].index` indexes the query results (resolve with
  `qNthElement`). Edges carry `parameter` 0..1 (arc-length by default).
- `evCurveDefinition(context, {"edge" : q})` → `Line{origin, direction}` |
  `Circle{coordSystem, radius}` | `Ellipse{coordSystem, majorRadius, minorRadius}` |
  `BSplineCurve{degree, dimension, isRational, isPeriodic, controlPoints, weights,
  knots}` (else an unspecified map).
- `evEdgeTangentLines(context, {"edge" : q, "parameters" : [t …]})` → array of `Line`
  whose **origins are points along the edge** (t ∈ [0,1]) — the easy way to sample
  any curve. Also `evEdgeTangentLine` (singular, `parameter`), `evEdgeCurvature`,
  `evVertexPoint({"vertex" : q})`, `evOwnerSketchPlane({"entity" : q})`.

## 4. Gotchas

1. **Nothing validates outside Onshape.** After writing, tell the user which studio
   to paste into and which model to regenerate; expect to iterate on solver errors.
2. **"Use/Project" of external geometry:** std exposes no high-level function
   (docs: "Advanced sketch functionality … is not available in FeatureScript";
   `SketchProjectionType` is exported but consumed by no std function), but the
   `ConstraintType.PROJECTED` recipe in §3 (bare `skSplineSegment` entity driven
   by three constraints) performs the projection exactly — prefer it over
   emulation. Fallback emulation (for features that rebuild fully each
   regeneration, so no associativity is needed):
   draw sampled copies (`evEdgeTangentLines` + `skFitSpline`/`skLineSegment`,
   mapped via `worldToPlane`). Caveat: the constraint projects **orthographically
   along the sketch normal** (as `worldToPlane` does) — when the source curve lies
   in another plane (e.g. a parent outline in a different meridian plane about a
   shared axis) its image is foreshortened; the sampled-copy fallback allows a
   custom mapping (e.g. a revolved image) instead. Constrain points to the
   **projected copies**, not external curves, or faces close with micro-gaps.
3. **Constraint well-posedness:** `COINCIDENT(point, curve)` leaves exactly 1 DOF
   (slide along curve). Add exactly one dimension pinning the coordinate the curve
   does NOT determine (e.g. pin y for a near-vertical curve). Pinning the other
   coordinate is over-constrained → "conflicting constraints" regen error; zero extra
   constraints leaves the point sliding.
3a. **A dimension is UNSIGNED — never pin a coordinate with `|value|` from the
   origin.** `DISTANCE … length : abs(y)` against a fixed point on the axis is
   satisfied equally well by `+y` and `-y`, and the constraint cannot tell them
   apart. The solver picks whichever satisfies the rest of the system, and the
   result is a *mirrored* point that looks correct until you measure it. This is
   benign while the coordinate is negative and silently corrupting once it goes
   positive — and a positive coordinate is ordinary, not exotic (anything centred
   on a span and longer than that span puts an end outboard of it). To pin a
   coordinate with a sign:
   - prefer `HORIZONTAL`/`VERTICAL` **between two points**, where the relation is
     signed because one endpoint is already FIXED; or
   - `FIX` the point outright when it does not need to slide; or
   - insert a short construction segment (a "riser") from the point to the curve
     and constrain only the segment's *inner* end to the curve — see §4b.
   Pinning the orthogonal coordinate is **not** a workaround: on a surface of
   revolution every station shares one radius, so the mirror is just as valid
   there and the point slides freely. "Over-constrained" is often this sign bug
   wearing a different hat.
3b. **Drawing a point and a curve through the same coordinates does not join
   them.** Both are free until constrained, and the solver will move them
   independently. Whenever a face must close on a projected/derived curve, tie
   the vertex to it explicitly (COINCIDENT to the curve) *and* pin its remaining
   coordinate. Prefer a dedicated `skPoint` + point-to-point COINCIDENT over
   referencing a polyline sub-vertex directly: the corner then has one owner and
   the polyline vertex is a slave of it, which adds no equation of its own.
4. **Sketch endpoints are not merged automatically.** Adjacent `skLineSegment`s share
   positions only numerically; once constraints move a vertex, the copies diverge →
   open contours, no region. Use `skPolyline(constrained : true)` or add explicit
   COINCIDENT constraints at corners before moving vertices.
5. **One face per loop.** If a chord and a projected curve both connect the same two
   points, they enclose a spurious second region and `qSketchRegion(...)[0]` may pick
   the wrong face. Draw chord XOR projected surface chain as a boundary.
6. Ties at corners (a point exactly at the junction of two curves): prefer the curve
   that also matches the opposite boundary point, else the wrong (e.g. cap) edge wins
   and the pin becomes degenerate/under-determined along it.
7. Degenerate inputs: guard `size == 0`; `skPolyline` requires > 1 point and rejects
   a 2-point "closed" polyline (precondition). Zero-length dimensions (`0 * meter`)
   are legal and useful for pinning a coordinate that must stay 0.
8. Import versions matter (`version : "3044.0"`); the std mirror prints `✨`
   placeholders — copy the real version from the studio's own imports.
9. **Audit loop variables that shadow a parameter.** A `var parentInfo = …` inside a
   loop shadows the function parameter of the same name for the rest of the block,
   and if the loop *reassigns a field* of that map (`parentInfo.parentSketch = …`)
   then every later read in the same block — including calls made before the loop's
   own work — silently sees the new value. Nothing errors; the code is just
   answering a different question than it reads as asking. When a loop must
   rebind a field that later code depends on, capture the original in a distinctly
   named `const` first, and prefer not shadowing at all.
10. **A boolean guard on a computed flag is not the same as checking the
    precondition.** `if (!bridged && over <= 0)` reads as "no bridge and no
    overlap", but `over` may be zero because a guard *suppressed* it rather than
    because it is zero. Name the reason, and comment the branch with which
    arrangement it is and what guarantees it.
11. **Log the before/after pair, not the intent.** A single "asked for" line cannot
    distinguish a clipped projection from a solver that moved things, because the
    two agree until the solve. Print the request *and* read the solved entities
    back (`qCreatedBy(sketchId, EDGE)`), then compare the two numbers directly.

## 4b. Language & API quirks that cost real time

Each of these produced a wrong model or a compile error that looked like a logic bug.</new_string>

- **Index vectors, never use field names.** `v.x` / `v.y` are not available;
  use `v[0]`, `v[1]`, `v[2]`. A `Plane` is a value type, not a map, so bind
  `const o = plane.origin;` then index it. Writing `plane.origin.x` fails.
- **`type` is a reserved keyword.** Map access must be quoted — `comp['type']`,
  never `comp.type`.
- **String concatenation is `~`, never `+`.** `a ~ ")"` builds a string;
  `a + ")"` is a compile error ("cannot add string and string").
- **A variable is only in scope in the block that declares it.** A `const`
  declared in an earlier loop is not visible later — an easy source of
  "<name> not defined".
- **Opaque imports expose only `export`ed symbols.** A `const` in an imported
  file that is not `export`ed is invisible to the importer. Also check the file
  you are editing actually matches the import hash in the header.
- **`qCreatedBy` needs an `Id`, not a string.** Sketch entity ids are strings
  elsewhere (the constraint APIs want strings), so convert at the call site with
  the std `makeId(str)`. Do **not** write your own `makeId` — it is already in
  `onshape/std/common.fs`. `EntityType.CONSTRAINT` is not a valid enum member.
- **`evaluateQueryCount` takes a `Query`, not an array.** `evaluateQuery` returns
  an array; use `size(arr)` on it. Typechecking is strict, so this is a compile
  error even inside a `canBeQuery` guard.
- **Constrain to the projected copy, never the external curve**, or the face
  closes with micro-gaps.
- **`opPattern` only *adds* the extra instances**; the source bodies stay put.
  So pass `instanceCount - 1` transforms and the total visible is `instanceCount`.
  For an assembly with no body of its own, pattern the **children** and return
  only the patterned copies.
- **Never call `opPattern` with an empty entity set** — guard with `canBeQuery`
  or a count. It silently produces nothing.
- **Rotate instances about the ASSEMBLY axis, not the part's own axis.** A body of
  revolution rotated about its own longitudinal axis maps onto itself, so every
  instance lands on top of the first. Match the upstream `getInstanceOffsets`,
  which rotates the radius vector about the PARENT's axis. Symptom: correct
  count, all instances co-located.
- **`skSplineSegment` has NO `guess` key** — only the closed `skSpline` does
  (`value.guess is array` appears in `skSpline`'s precondition, not
  `skSplineSegment`'s). A projected curve drawn as a segment is driven purely by its
  PROJECTED constraints; adding `"guess" : …` to the map is a type error. If a guess
  really is needed, `skSetInitialGuess(sketch, initialGuess)` wants a map from entity id
  to a flat `array of number` and **replaces** the whole guess map, so call it once
  after every projected curve exists, not per curve. In practice it is not needed: the
  three PROJECTED constraints are enough.
- **A vertex past its curve's axial end is not a snap failure.** When matching a
  child's end point to a parent curve, the full 3D distance conflates a *radial* miss
  with an *axial overrun*, and an overrun on a tapering parent is normal (the design
  clamps the child's radius to the parent's aft radius, then closes with a segment at
  constant radius). Measure only the radial term once the point is outside the curve's
  span, or the child silently matches nothing and degrades to a bare outline. This
  only bites on **tapering** parents — a cylinder's constant radius makes the full
  distance equal the radial distance anyway.
- **A `continue` inside a first-pass loop can silently drop a component** if the
  loop also records per-component state after the `continue`. A sketch that
  yields no region then deletes the component instead of just skipping its face.
- **A failed `opRevolve` / `opBoolean` THROWS, and an uncaught throw aborts the
  rest of the enclosing loop.** This is the most misleading failure mode in this
  exporter: the notice names only the line, and every component after the first
  casualty is simply never built, so the log looks *truncated* — easy to misread
  as a bad paste or a capped notices pane. Wrap each in `try { … } catch(e) { … }`
  so one bad component cannot hide the whole run. (FeatureScript cannot
  `continue` out of a `catch`; carry a `var` flag instead.)
- **`getFeatureError` does not see a raw `@opRevolve` failure from the caller.**
  The status API is meant to be read from *inside* a feature that wraps the
  failing call, the way std's `boolean.fs` uses `processSubfeatureStatus` on a
  subfeature. A `if (getFeatureError(context, id) != undefined) println(…)`
  guard placed right after a bare `opRevolve` never fires — and a guard that
  silently never fires is worse than none, because it reads as "already ruled
  out". Print before the call, or in the `catch`.
- **A region must meet the revolve axis along a SEGMENT, not at a single
  vertex.** `opRevolve` fails (`REVOLVE_FAILED`) on a section whose boundary
  touches the axis at one point with a near-zero included angle. Two ways in,
  both of which look fine in the sketch: a solid component's tip, and a bore
  *clipped* onto the axis because the wall is thicker than the local radius.
  Fitting a spline *through* an axis point makes it worse — the fitted tangent
  there is nearly parallel to the axis. Draw the axis run as straight segments
  and **start the spline at the intercept** so the run and the curve share a
  point; starting at the first off-axis sample instead leaves an unclosed outline
  that presents as "the curve stops early and runs straight to the top".
- **`skPolyline` has a `size(value.points) > 1` precondition.** A run of exactly
  one point is a degenerate curve and fails at runtime; skip it instead.
- **Raw payload values are not quantities.** Values read straight out of a
  `params` map (`packedLength`, `profile[i][0]`) are bare `number`s; only values
  that have been through `convertProfilePoints(…, units)` are lengths. Comparing
  one against the other — e.g. `packedLength <= MIN_SEGMENT_LENGTH`, which is
  `1e-9 * meter` — is a compile error, and so is `var smallest = 1 * meter`
  followed by `min(smallest, rawNumber)`. Seed with a bare literal instead.
- **A flat-faced polygon must be drawn with `skPolyline`, never `skFitSpline`.**
  A spline rounds the corner off, and a corner that a boolean needs to match on
  (a connector step between two bodies) is exactly the one you lose.

## 4c. Debugging discipline (the part that actually matters)

FeatureScript cannot be run locally, so a hypothesis about what the code does is
a guess. Most of the wasted effort on this feature came from theorising instead
of observing.

- **Instrument before theorising.** A `println` of the few quantities that
  discriminate between hypotheses — query vs array, entity counts, match indices,
  the chain returned — resolves in one regeneration what several rounds of
  reading cannot. Gate it behind `const DEBUG_x = true` so removal is trivial
  (see §7 for the strip that removes it), and keep the flag's `// TEMPORARY:` note
  directly above the declaration.
- **Tell the user exactly which lines to paste back.** Say "paste just the `[asm]`
  lines", and state what each possible reading means, so one run is decisive.
- **Separate "the count is wrong" from "the positions are wrong".** Different bugs,
  different fixes. Confirm which before editing.
- **Verify the instrument itself before trusting it.** A probe that reports 0 for
  something known to work (e.g. an entity-count query returning 0 for a
  projection that visibly exists) tells you nothing about the entity — fix or drop
  the probe rather than drawing a conclusion from it.
- **Fix the smallest demonstrable cause.** A change that removes the symptom but
  touches a shared path can break something else. An early attempt to widen a
  per-component return value fixed a missing body but then overwrote every
  child's name and colour, since the same caller names them.
- **When a fix produces a NEW symptom, re-read the surrounding code** rather than
  layering another change on the same lines.
- **If one edit causes two unrelated symptoms, split it.** The missing body and
  the renaming were separable; bundling them is why reverting lost both.
- **Check how a return value is consumed before widening it.** If the result feeds
  `setProperty(NAME/APPEARANCE/MATERIAL)`, including children in it silently
  renames them.
- **Read the upstream source of the format/spec, not the UI description.** Several
  bugs came from assumed semantics — defaults that differ from the docs, helpers
  that take a value from a level above the obvious one, and profiles that mirror
  on one branch and not another. Clone the source and `grep` the class or method;
  the UI tooltip is not the contract.
- **Check the code path against the log in the log's own frame.** The source
  format's frame is not necessarily this model's: one commonly has X axial where
  the other has Z, so a cross-check written in the wrong frame yields convincing
  nonsense. Confirm the axis convention from the part's own transform before
  comparing any quantity.
- **Simulate the formula numerically instead of reasoning about it.** Porting a
  profile expression to a scratch script and comparing against expected values (or
  the upstream unit tests) is how the denominators and the mirror cases were
  pinned to exact numbers.
- **If several rounds pass without progress, stop guessing and instrument.** Each
  wrong guess costs the user a regeneration.
- **An uncaught throw looks exactly like a truncated log.** Before concluding
  that a pasted log is cut off, check whether every component is *accounted
  for*. A builder that runs two passes — one line per component in pass one, one
  per component in pass two — tells you where it stopped: if a component has a
  first-pass line but no matching second-pass line, the run **aborted between
  them**, and it is not truncation. This was misread twice as a bad paste. Print
  an end-of-level marker so the distinction is self-evident in the log itself.
- **Report a state, not just a verdict.** "ok=true bodies=1" and
  "CAUGHT: REVOLVE_FAILED" remove the ambiguity between "this failed" and "this
  succeeded and the next one is missing for some other reason".

## 5. Worked pattern (reusable template): snap sketch points onto parent sketches

Goal: a child sketch's vertices that lie near curves of the parent's / parent's
siblings' sketches get pulled exactly onto them, and the projected curves close a
face along the true surface. Reusable shape:

1. Plumb references down: carry `{sketch, sketchId, plane}` maps for the parent and
   its siblings (ids are what queries need; planes enable non-coplanar handling via
   a "revolved image" mapping about the relevant axis — identity when coplanar).
2. `collectSnapEdges`: `evaluateQuery(qCreatedBy(sketchId, EntityType.EDGE))` per
   target → `[{plane, edge}, …]`.
3. Keep each candidate curve's **2D geometry in the child's own plane** (start/end
   points, plus `samples2D` for curved edges via `evEdgeTangentLines` + `worldToPlane`),
   and match against *that*. A curved parent is drawn as a spline whose interior bow is
   not a line, so measuring it against its chord reports a gap that does not exist.
4. Per point: nearest edge within a tolerance (take it from the format's own
   snap threshold rather than inventing one), matched on the **radial** term once
   the point lies outside the curve's axial span (see the overrun gotcha in §4);
   optionally restrict the boundary endpoints to a curve both of them touch.
5. Project each matched edge into the sketch with the type-matched line/spline
   segment (lines seeded with projected end points) + three PROJECTED constraints
   (§3) — the entity is what gets referenced below. `skSplineSegment` takes no `guess`.
6. Draw the outline `skPolyline(constrained : true)` (open when projected curves
   close the boundary; else append the first point for a chord-closed loop).
7. Per matched vertex, hold the vertex where it belongs and pin it **with a sign**:
   - `COINCIDENT(vertexRef, projectedCurveId)` — point-on-curve, 1 DOF left; then
   - `HORIZONTAL` / `VERTICAL` between the vertex and a **fixed** `skPoint`
     reference on the axis the dimension is measured from. Point-to-point is signed
     because one end cannot move.
   - **Do not** use `DISTANCE` + `length : abs(coord)`. It is unsigned and admits the
     mirror solution (see §4 gotcha 3a); use `FIX` on the vertex directly when it does
     not need to slide along the curve.
   - Prefer owning the corner with a dedicated `skPoint` + point-to-point COINCIDENT
     and letting the polyline vertex be a slave of it, so the corner has one owner.
8. `skSolve` at the end of sketch construction (the host feature does this).

### 5a. Riser idiom: a corner that must be OFF a curve

When a vertex has to sit *near* a projected curve but not on it — an overlap that
gives a boolean material to work with, or a clearance so two solids interpenetrate
instead of merely touching — do **not** offset the corner and also constrain it onto
the curve. That asks one point to be two places; the solver resolves the
contradiction by dragging the *curve* out to meet the corner, silently invalidating
every measurement taken against it. Split the jobs:

- `FIX` the corner at its real (offset) position — the station is then signed and exact.
- Draw a short segment (the riser) from the corner to where the curve passes that
  station.
- Constrain only the riser's **inner** end: `COINCIDENT(innerEnd, projectedCurveId)`
  plus `HORIZONTAL`/`VERTICAL` to the fixed corner.

The curve now stays exactly where the real surface is, the offset is a separate
radial jog, and the region closes on the projected curve between two risers. One
equation each on a two-DOF point, so nothing is over-constrained. A corner past the
end of the curve has no riser — bridge from the curve's end vertex to the corner at
a constant radius instead.

## 6. Pre-flight checklist

- [ ] Every function/field verified in `/tmp/os-std` or FsDoc (name, map keys, units).
- [ ] No spread operator in map literals; no `"guess"` key on `skSplineSegment`.
- [ ] Return annotation matches the actual type — a `returns number` function must not
      return a length/quantity (`norm`, `sqrt`, `min`, arithmetic on lengths). Omit the
      annotation instead of guessing a type name; std has no `returns Length`.
- [ ] Vectors indexed (`v[0]`), reserved keys quoted (`['type']`), strings joined with `~`.
- [ ] Raw payload values are compared against bare numbers, scaled ones against
      quantities — never mixed in one comparison or one `min`.
- [ ] Every revolved region meets the axis along a segment, not a vertex: axis
      runs drawn as straight segments, one-point runs skipped, and the spline
      starting at the intercept so run and curve share a point.
- [ ] Every `opRevolve` / `opBoolean` that can fail is inside a `try`/`catch`, so
      one casualty cannot silently truncate the rest of the run.
- [ ] A polygon carrying a flat face another body must mate with is drawn with
      `skPolyline`, not `skFitSpline`.
- [ ] `tools` on `opBoolean` is a Query (`qUnion([...])`), the parent body is
      first so the union keeps its identity, and the **union result** is what
      the caller returns (that is what gets named/coloured/materialised).
- [ ] Every identifier used exists in the current scope, and every cross-file symbol
      is `export`ed from the file the import hash points at.
- [ ] Entity refs used in constraints match the ids passed at creation (incl. sub-refs).
- [ ] `qCreatedBy` receives `makeId(...)`, not a string; `EntityType` member is real.
- [ ] `evaluateQueryCount` only ever sees a Query, never an `evaluateQuery` array.
- [ ] Constraint set per point is exactly well-posed (count DOFs), and the held
      coordinate is pinned by a **signed** relation — `HORIZONTAL`/`VERTICAL`
      between two points, or `FIX` — never `DISTANCE` + `abs(coord)` (unsigned,
      admits the mirror; §4 gotcha 3a).
- [ ] A point drawn through the same coordinates as a curve is also explicitly
      constrained to it; a vertex that must sit *off* a curve uses the riser
      idiom (§5a) rather than offsetting the vertex and constraining it onto the
      curve at once.
- [ ] Loop variables do not shadow a parameter whose fields are rebound before
      later reads; anything captured before a rebinding has a distinct name.
- [ ] Corner coincidences exist wherever a vertex is shared and movable.
- [ ] Exactly one closing boundary per intended face (chord XOR projected chain).
- [ ] Snapping a point that lies *past* a curve's axial end measures the radial term
      only; the axial overrun is bridged by a link, not treated as a miss.
- [ ] Degenerate sizes (0/1/2 points, empty queries) guarded; `opPattern` never
      called with an empty entity set.
- [ ] First-pass loops do not `continue` past per-component bookkeeping.
- [ ] Flat sketches remain flat; cant is applied after extrusion and before patterning.
- [ ] `opTransform` pattern sources retain the original body query.
- [ ] Instances rotate about the **parent's** axis, with `instanceCount - 1`
      transforms (the source body is the first instance).
- [ ] Assembly/group return values exclude children from the naming/appearance
      path, so the caller does not overwrite each child with the group's name.
- [ ] Dimensions and derived offsets match the source payload exactly; profile
      expressions verified against the upstream implementation's own unit tests,
      including the mirrored/narrowing and clamped cases.
- [ ] Attribution/header comments per repo convention; long explanations live in
      the file footer, not inline.
- [ ] Any `DEBUG_*` flag left on is a deliberate, temporary choice, called out to
      the user.
- [ ] User instructions: paste into which studio, which input to regenerate, what
      to look for (regions, solver errors), and what error text to send back.

## 7. Shipping without the debug logging

There is no preprocessor in FeatureScript, so "release mode" is a separate step
that rewrites the file. Writing the logs so that step can remove them is a habit
worth forming from the first `println`:

- Guard a block with `const DEBUG_x = true;` and always use **braces**:
  `if (DEBUG_x) { ... }`. A one-line `if (DEBUG_x) log();` cannot be removed
  safely, so a good stripper refuses it — and refusing is the right behaviour.
- **Test the flag, never its inverse.** `if (!DEBUG_x) { realWork(); }` puts the
  real work in the else branch of a debug test, which no tool can resolve. Write
  `if (DEBUG_x) { log(); } else { realWork(); }` instead.
- A `println` the *user* has to act on is not debug output. Mark it so the
  release build keeps it (this repo uses a `// @keep` comment above the line);
  everything else can go.
- Helpers that exist only to format a log should live in functions the strip can
  see become uncalled, rather than being inlined into the message — then the
  release build drops them too.
- Validate the stripped output mechanically (balanced brackets, no surviving
  flag, no call to something removed). It is the only check available before the
  file goes near Feature Studio, where a syntax error costs the user a
  round-trip.

`tools/build-fs.mjs` in this repository implements exactly that for
`osFeature/*.fs`; `local/featurescript-build.md` is the full rule set and
`pnpm run fs:check` is the gate.


