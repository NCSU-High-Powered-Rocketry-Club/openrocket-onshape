FeatureScript 3044;
import(path : "onshape/std/common.fs", version : "3044.0");
import(path : "cd77025bdba011dd69d477e3", version : "6b4ef6a3ed29f1cfb9cb3c87");

/**
 * Copyright 2026 William Degele
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the “Software”), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom
 * the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.

 * THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
 * OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 * OTHER DEALINGS IN THE SOFTWARE.
 */

/**
 * OpenRocket-to-Onshape component sketches.  Every *why* -- including how the
 * fin-snapping machinery evolved -- is in the notes at the foot of this file.
 */

// Fin root ends closer than this to a parent outline snap onto it (OpenRocket's
// FreeformFinSet.SNAP_SMALLER_THAN).
const SNAP_TOLERANCE = 5e-3 * meter;

// Two parent-outline curves are treated as sharing an end point within this.
const VERTEX_MATCH_TOLERANCE = 1e-5 * meter;

// Sample count for measuring a distance against a CURVED parent outline, fine
// enough that the nearest sample is within ROOT_LINK_TOLERANCE of the curve.
const CURVE_SAMPLE_COUNT = 25;

// Root-end offset from a projected curve before a link line bridges the gap.
const ROOT_LINK_TOLERANCE = 1e-4 * meter;


// TEMPORARY: prints which parent curve the FIN ROOT picked, and which code path
// it took; set false to silence.  See the `[finroot]` notes in the outline.
const DEBUG_FIN_SNAP = true;

// A segment shorter than this is absent: a solid nose cone's tip has coincident
// end points, and drawing that zero-length segment makes the revolve fail.
const MIN_SEGMENT_LENGTH = 1e-9 * meter;

/**
 * Index of the first profile point genuinely OFF the axis.  The points are
 * already scaled to `units`, so this compares lengths (notes 19, 21).
 */
function firstOffAxisIndex(points is array) returns number
{
    for (var i = 0; i < size(points); i += 1)
    {
        if (points[i][0] > MIN_SEGMENT_LENGTH)
        {
            return i;
        }
    }
    return size(points);
}

/** The LAST point genuinely off the axis; mirrors `firstOffAxisIndex`. */
function lastOffAxisIndex(points is array) returns number
{
    for (var i = size(points) - 1; i >= 0; i -= 1)
    {
        if (points[i][0] > MIN_SEGMENT_LENGTH)
        {
            return i;
        }
    }
    return -1;
}

/**
 * Draw a run of consecutive axis points, `from` to `to` inclusive.  A run of one
 * point is a no-op: `skPolyline` requires more than one.  (note 19)
 */
function drawAxisRun(sketch is Sketch, runId is string, points is array, from is number, to is number)
{
    if (to <= from)
    {
        return;
    }

    skPolyline(sketch, runId, { "points" : slicePoints(points, from, to) });
}

/** A sub-array of `points` from `from` to `to` INCLUSIVE; arrays cannot be
 * sliced inline, so the run is copied out and the points themselves are shared. */
function slicePoints(points is array, from is number, to is number) returns array
{
    const count = to - from + 1;
    if (count < 1)
        return [];

    var out = makeArray(count);
    for (var i = 0; i < count; i += 1)
    {
        out[i] = points[i + from];
    }
    return out;
}

/** Draw a meridian outline, closing any run of axis points with straight
 * segments; `drawAsLine` means the outline IS the axis (note 19). */
function drawOutline(sketch is Sketch, curveId is string, foreId is string, aftId is string, points is array, drawAsLine is boolean)
{
    const count = size(points);

    if (count < 2)
        return;

    if (drawAsLine)
    {
        skLineSegment(sketch, curveId, {
                    "start" : points[0],
                    "end" : points[count - 1]
                });
        return;
    }

    const first = firstOffAxisIndex(points);
    const last = lastOffAxisIndex(points);

    if (first > last)
    {
        // Every point is on the axis: a straight segment is the honest answer.
        skLineSegment(sketch, curveId, {
                    "start" : points[0],
                    "end" : points[count - 1]
                });
        return;
    }

    if (first > 0)
    {
        // The whole run, not just its ends: the intercept is in the middle of it.
        drawAxisRun(sketch, foreId, points, 0, first - 1);
    }

    if (last < count - 1)
    {
        drawAxisRun(sketch, aftId, points, last + 1, count - 1);
    }

    // The spline starts and ends ON the axis run, sharing the intercept with it.
    const splineFrom = first > 0 ? first - 1 : 0;
    const splineTo = last < count - 1 ? last + 1 : count - 1;

    skFitSpline(sketch, curveId, {
                "points" : slicePoints(points, splineFrom, splineTo)
            });
}

/** Wall section of a tube, coupler or engine block; `filled` ones are solid, so
 *  the wall runs out to the axis.  A zero wall is REPORTED, not skipped (notes 20, 21, 26). */
function tubeWallSketch(params is map, sketch is Sketch, units is ValueWithUnits)
{
    const radius = params.outerRadius;
    const thickness = params.filled == true ? radius : params.thickness;
    const wall = radius - thickness;

    if (radius <= 0)
    {
        // An `auto` outer radius with no RadialParent to resolve it against,
        // which the web app warns about separately.
        println("  [wall] outerRadius is " ~ toString(radius) ~ " -- no section drawn (unresolved auto radius?)");
        return;
    }
    if (wall <= 0)
    {
        // A tube as thick as its radius has NO bore, and OpenRocket renders that
        // as a solid, so it is drawn rather than dropped (note 26).
        println("  [wall] wall is " ~ toString(wall) ~ " (outerRadius " ~ toString(radius)
                ~ " minus thickness " ~ toString(thickness) ~ ") -- solid section drawn");

        // `annulusSketch` would draw these for innerRadius 0, but it is defined
        // further down.  The inner edge lies ON the axis, making this a solid.
        const solidTopAxis = vector(0, 0) * units;
        const solidTopOuter = vector(radius, 0) * units;
        const solidBottomAxis = vector(0, -params.length) * units;
        const solidBottomOuter = vector(radius, -params.length) * units;

        skLineSegment(sketch, "outer_edge", {
                    "start" : solidTopOuter,
                    "end" : solidBottomOuter
                });

        skLineSegment(sketch, "inner_edge", {
                    "start" : solidTopAxis,
                    "end" : solidBottomAxis
                });

        skLineSegment(sketch, "top_edge", {
                    "start" : solidTopAxis,
                    "end" : solidTopOuter
                });

        skLineSegment(sketch, "bottom_edge", {
                    "start" : solidBottomAxis,
                    "end" : solidBottomOuter
                });
        return;
    }

    const topRight = vector(radius, 0) * units;
    const bottomRight = vector(radius, -params.length) * units;

    sketchQuadrilateral(sketch, topRight - vector(thickness, 0) * units, topRight,
                        bottomRight - vector(thickness, 0) * units, bottomRight);
}

/** Section between an inner and an outer radius: a ring, or a solid disc at 0. */
function annulusSketch(sketch is Sketch, innerRadius is number, outerRadius is number, length is number, units is ValueWithUnits)
{
    sketchQuadrilateral(sketch,
                vector(innerRadius, 0) * units,
                vector(outerRadius, 0) * units,
                vector(innerRadius, -length) * units,
                vector(outerRadius, -length) * units);
}

export function bodyComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    tubeWallSketch(comp.params, sketch, units);
}

export function innertubeComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    tubeWallSketch(comp.params, sketch, units);
}

export function tubecouplerComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    tubeWallSketch(comp.params, sketch, units);
}

export function engineblockComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    tubeWallSketch(comp.params, sketch, units);
}

export function bulkheadComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    annulusSketch(sketch, 0, comp.params.outerRadius, comp.params.length, units);
}

export function noseComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    sketchProfile(comp, sketch, units);
}

export function transitionComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    // Everything goes through the profile path, plain cones included: the quad
    // shortcut cannot represent a shoulder, a wall or a cap (note 14).
    sketchProfile(comp, sketch, units);
}

/** Every curve of the parent sketch and its siblings, as snap targets carrying
 * the source "plane" and a per-curve "edgeQuery" (note 3). */
function collectSnapEdges(context is Context, parentSketch, parentSiblingSketches) returns array
{
    var targets = [];
    if (parentSketch != undefined && parentSketch.sketchId != undefined)
    {
        targets = append(targets, parentSketch);
    }
    if (parentSiblingSketches != undefined)
    {
        for (var sibling in parentSiblingSketches)
        {
            if (sibling != undefined && sibling.sketchId != undefined)
            {
                targets = append(targets, sibling);
            }
        }
    }

    var snapEdges = [];
    for (var target in targets)
    {
        const edgeQuery = qCreatedBy(target.sketchId, EntityType.EDGE);
        const edgeCount = evaluateQueryCount(context, edgeQuery);
        for (var i = 0; i < edgeCount; i += 1)
        {
            snapEdges = append(snapEdges, { "plane" : target.plane, "edgeQuery" : qNthElement(edgeQuery, i) });
        }
    }

    return snapEdges;
}

/** Whether a snap-edge index is in an index list (see notes 4). */
function edgeIndexAllowed(index is number, indexList is array) returns boolean
{
    for (var j = 0; j < size(indexList); j += 1)
    {
        if (indexList[j] == index)
        {
            return true;
        }
    }
    return false;
}

/** The point of segment a--b closest to `target`, clamped to its ends. */
function nearestOnSegment2D(target is Vector, a is Vector, b is Vector) returns Vector
{
    const d = b - a;
    const lengthSq = dot(d, d);
    if (lengthSq <= 0 * meter * meter)
    {
        return a;
    }
    var t = dot(target - a, d) / lengthSq;
    if (t < 0)
    {
        t = 0;
    }
    if (t > 1)
    {
        t = 1;
    }
    return a + d * t;
}

/** Closest point to `target` on a chain curve, in the sketch's 2D frame.  See notes 9. */
function nearestOnCurve2D(target is Vector, geom is map) returns Vector
{
    if (geom["isLine"])
    {
        return nearestOnSegment2D(target, geom.start2D, geom.end2D);
    }

    const samples = geom["samples2D"];
    if (samples == undefined || size(samples) == 0)
    {
        return nearestOnSegment2D(target, geom.start2D, geom.end2D);
    }

    var best = samples[0];
    var bestDistance = norm(samples[0] - target);
    for (var i = 1; i < size(samples); i += 1)
    {
        const distance = norm(samples[i] - target);
        if (distance < bestDistance)
        {
            best = samples[i];
            bestDistance = distance;
        }
    }
    return best;
}

/** Distance from a fin root end to one parent curve; returns a LENGTH (note 13). */
function rootMatchDistance(point2D is Vector, geom is map)
{
    const axialIndex = 1;
    const radialIndex = 0;
    const lo = min(geom.start2D[axialIndex], geom.end2D[axialIndex]);
    const hi = max(geom.start2D[axialIndex], geom.end2D[axialIndex]);

    if (point2D[axialIndex] >= lo && point2D[axialIndex] <= hi)
    {
        return norm(nearestOnCurve2D(point2D, geom) - point2D);
    }

    // Beyond the curve's end: only the radial miss decides the match.
    return min(abs(geom.start2D[radialIndex] - point2D[radialIndex]),
               abs(geom.end2D[radialIndex] - point2D[radialIndex]));
}

/** Nearest parent curve for a fin root end, within SNAP_TOLERANCE, or -1.
 * `restrictTo` limits the search; matching is in the fin's own 2D frame (note 9). */
function findRootEdgeIndex(point2D is Vector, snapGeoms is array, restrictTo) returns number
{
    var bestIndex = -1;
    var bestDistance = SNAP_TOLERANCE;
    for (var i = 0; i < size(snapGeoms); i += 1)
    {
        if (restrictTo != undefined && size(restrictTo) > 0 && !edgeIndexAllowed(i, restrictTo))
        {
            continue;
        }
        const distance = rootMatchDistance(point2D, snapGeoms[i]);
        if (distance <= SNAP_TOLERANCE && (bestIndex == -1 || distance < bestDistance))
        {
            bestDistance = distance;
            bestIndex = i;
        }
    }
    return bestIndex;
}

/** Sample a source edge into this sketch's 2D frame.  See notes 9. */
function sampleEdgePointsInPlane(context is Context, edgeQuery, finPlane is Plane, samples is number) returns array
{
    var parameters = makeArray(samples);
    for (var i = 0; i < samples; i += 1)
    {
        parameters[i] = i / (samples - 1);
    }

    var points = [];
    for (var line in evEdgeTangentLines(context, { "edge" : edgeQuery, "parameters" : parameters }))
    {
        points = append(points, worldToPlane(finPlane, meridianImage(line.origin, finPlane)));
    }

    return points;
}

/**
 * One snap curve's world and fin-plane 2D end points.  The 2D form is the same
 * mapping the projection draws with, so chain walking compares true positions.
 */
function edgeGeometry(context is Context, snapEdge is map, finPlane is Plane) returns map
{
    const startVertices = evaluateQuery(context, qEdgeVertex(snapEdge.edgeQuery, true));
    const endVertices = evaluateQuery(context, qEdgeVertex(snapEdge.edgeQuery, false));
    const startWorld = evVertexPoint(context, { "vertex" : startVertices[0] });
    const endWorld = evVertexPoint(context, { "vertex" : endVertices[0] });
    const isLine = evCurveDefinition(context, { "edge" : snapEdge.edgeQuery }) is Line;

    // Curved edges are sampled; straight ones need no samples (notes 9).
    return {
        "startWorld" : startWorld,
        "endWorld" : endWorld,
        "start2D" : worldToPlane(finPlane, meridianImage(startWorld, finPlane)),
        "end2D" : worldToPlane(finPlane, meridianImage(endWorld, finPlane)),
        "isLine" : isLine,
        "samples2D" : isLine ? [] : sampleEdgePointsInPlane(context, snapEdge.edgeQuery, finPlane, CURVE_SAMPLE_COUNT)
    };
}

/** The run of parent-outline curves from the fore root curve to the aft one, so
 * the face can close along the surface between them (note 5). */
function surfaceChainIndexes(context is Context, finPlane is Plane, snapEdges is array, foreIndex is number, aftIndex is number, aftRootY is ValueWithUnits) returns array
{
    var chain = [foreIndex];
    if (foreIndex == aftIndex)
    {
        return chain;
    }

    var current = foreIndex;
    var currentGeom = edgeGeometry(context, snapEdges[current], finPlane);
    const aftY = aftRootY;

    const axialIndex = 1;
    var steps = 0;
    while (current != aftIndex && steps < size(snapEdges))
    {
        steps += 1;

        // Continue from whichever end of the current curve lies towards the aft
        // root point.
        const forwardIsEnd = abs(currentGeom.end2D[axialIndex] - aftY) < abs(currentGeom.start2D[axialIndex] - aftY);
        const forwardY = forwardIsEnd ? currentGeom.end2D[axialIndex] : currentGeom.start2D[axialIndex];
        const sharedWorld = forwardIsEnd ? currentGeom.endWorld : currentGeom.startWorld;
        const goingAft = aftY > forwardY;

        var bestNext = -1;
        var bestProgress = 0 * meter;
        for (var i = 0; i < size(snapEdges); i += 1)
        {
            if (i == current || edgeIndexAllowed(i, chain))
            {
                continue;
            }
            const geom = edgeGeometry(context, snapEdges[i], finPlane);
            for (var end = 0; end < 2; end += 1)
            {
                const candidateWorld = end == 0 ? geom.startWorld : geom.endWorld;
                if (norm(candidateWorld - sharedWorld) > VERTEX_MATCH_TOLERANCE)
                {
                    continue;
                }
                const otherY = end == 0 ? geom.end2D[axialIndex] : geom.start2D[axialIndex];
                if (goingAft ? otherY <= forwardY : otherY >= forwardY)
                {
                    continue;
                }
                const progress = abs(otherY - aftY);
                if (bestNext == -1 || progress < bestProgress)
                {
                    bestNext = i;
                    bestProgress = progress;
                }
            }
        }

        if (bestNext == -1)
        {
            break;
        }
        chain = append(chain, bestNext);
        current = bestNext;
        currentGeom = edgeGeometry(context, snapEdges[current], finPlane);
    }

    return chain;
}

/** Project ("use") a parent curve in: a straight source becomes a line segment
 *  between its projected ends, a curved one a spline from PROJECTED constraints (note 6). */
function projectEdgeIntoSketch(context is Context, sketch is Sketch, curveId is string, snapEdge is map, finPlane is Plane, construction is boolean) returns string
{
    const edgeQuery = snapEdge.edgeQuery;
    const startVertices = evaluateQuery(context, qEdgeVertex(edgeQuery, true));
    const endVertices = evaluateQuery(context, qEdgeVertex(edgeQuery, false));

    const startPoint = worldToPlane(finPlane, meridianImage(evVertexPoint(context, { "vertex" : startVertices[0] }), finPlane));
    const endPoint = worldToPlane(finPlane, meridianImage(evVertexPoint(context, { "vertex" : endVertices[0] }), finPlane));

    const definition = evCurveDefinition(context, { "edge" : edgeQuery });
    if (definition is Line)
    {
        skLineSegment(sketch, curveId, {
                    "start" : startPoint,
                    "end" : endPoint,
                    "construction" : construction,
                    "index" : "1"
                });
        return curveId;
    }

    // A bare skSplineSegment driven by the three PROJECTED constraints below,
    // each needing its own `index` (note 6).
    skSplineSegment(sketch, curveId, {
                "construction" : construction,
                "index" : "1"
            });

    // Two USE_ENDs fix the extent, the whole-curve USE drives the shape (note 6).
    if (size(startVertices) > 0)
    {
        skConstraint(sketch, curveId ~ ".start.project", {
                    "constraintType" : ConstraintType.PROJECTED,
                    "index" : "1",
                    "name" : "",
                    "projectionType" : SketchProjectionType.USE_END,
                    "localFirst" : curveId ~ ".start",
                    "externalVertex" : qUnion([startVertices[0]]),
                    "externalVertexEdge" : qUnion([edgeQuery]),
                    "sketchToolType" : SketchToolType.USE
                });
    }

    if (size(endVertices) > 0)
    {
        skConstraint(sketch, curveId ~ ".end.project", {
                    "constraintType" : ConstraintType.PROJECTED,
                    "index" : "2",
                    "name" : "",
                    "projectionType" : SketchProjectionType.USE_END,
                    "localFirst" : curveId ~ ".end",
                    "externalVertex" : qUnion([endVertices[0]]),
                    "externalVertexEdge" : qUnion([edgeQuery]),
                    "sketchToolType" : SketchToolType.USE
                });
    }

    skConstraint(sketch, curveId ~ ".project", {
                "constraintType" : ConstraintType.PROJECTED,
                "index" : "3",
                "name" : "",
                "projectionType" : SketchProjectionType.USE,
                "localFirst" : curveId,
                "externalSecond" : qUnion([edgeQuery]),
                "sketchToolType" : SketchToolType.USE
            });

    return curveId;
}

/** Local id of vertex `index` of a polyline drawn with skPolyline, which draws
 * "polylineId.lineN" from point N to point N + 1. */
function polylineVertexRef(polylineId is string, index is number, lastIndex is number) returns string
{
    if (index < lastIndex)
    {
        return polylineId ~ ".line" ~ index ~ ".start";
    }
    return polylineId ~ ".line" ~ (lastIndex - 1) ~ ".end";
}

/**
 * The rotation axis a plane revolves about: the vertical line through the plane
 * origin's own x/y.  A Plane is a value type, read by index (note 1).
 */
function planeAxisPoint(targetPlane is Plane) returns Vector
{
    const origin = targetPlane.origin;
    return vector(origin[0], origin[1], 0 * meter);
}

/** `point`'s offset from the axis, i.e. the part perpendicular to the rocket axis. */
function radialOffsetFromAxis(point is Vector, axisPoint is Vector) returns Vector
{
    const fromAxis = point - axisPoint;
    return fromAxis - Z_DIRECTION * dot(Z_DIRECTION, fromAxis);
}

/**
 * Rotate a point onto `targetPlane`'s meridian, about that plane's own axis.
 * For distance comparisons, where both sides of the axis are equivalent.
 */
function revolvedImage(point is Vector, targetPlane is Plane) returns Vector
{
    const heightAxis = Z_DIRECTION;
    const radialVector = radialOffsetFromAxis(point, planeAxisPoint(targetPlane));
    const radius = norm(radialVector);
    if (radius == 0 * meter)
    {
        return point;
    }

    var radialDirection = targetPlane.x - heightAxis * dot(targetPlane.x, heightAxis);
    if (norm(radialDirection) == 0)
    {
        return point;
    }

    return point - radialVector + normalize(radialDirection) * radius;
}

/** As `revolvedImage`, but keeps the point on the same side of the axis, landing
 * on the -x meridian rather than flipped to +r. */
function meridianImage(point is Vector, targetPlane is Plane) returns Vector
{
    const heightAxis = Z_DIRECTION;
    const axisPoint = planeAxisPoint(targetPlane);
    const radialVector = radialOffsetFromAxis(point, axisPoint);
    const planeRadial = targetPlane.x - heightAxis * dot(targetPlane.x, heightAxis);
    if (norm(radialVector) == 0 * meter || norm(planeRadial) == 0 * meter)
    {
        return point;
    }
    if (dot(normalize(radialVector), normalize(planeRadial)) < 0)
    {
        // Mirror through the rotation axis, not the world origin, so a component
        // off the rocket axis lands on its own parent's -x meridian.
        return revolvedImage(point - 2 * radialVector, targetPlane);
    }
    return revolvedImage(point, targetPlane);
}

/**
 * Whether a root end misses the projected curve it matched, and where to link
 * to instead (note 7).
 */
function rootLinkEnd(geom is map, target2D is Vector) returns map
{
    if (geom["isLine"])
    {
        const nearest = nearestOnSegment2D(target2D, geom.start2D, geom.end2D);
        if (norm(nearest - target2D) <= ROOT_LINK_TOLERANCE)
        {
            return { "needsLink" : false, "linkPoint" : target2D };
        }
        return { "needsLink" : true, "linkPoint" : nearest };
    }

    const axialIndex = 1;
    const y0 = geom.start2D[axialIndex];
    const y1 = geom.end2D[axialIndex];
    const yLo = min(y0, y1) - ROOT_LINK_TOLERANCE;
    const yHi = max(y0, y1) + ROOT_LINK_TOLERANCE;
    const y = target2D[axialIndex];

    if (y >= yLo && y <= yHi)
    {
        return { "needsLink" : false, "linkPoint" : target2D };
    }
    if (y < yLo)
    {
        return { "needsLink" : true, "linkPoint" : y0 <= y1 ? geom.start2D : geom.end2D };
    }
    return { "needsLink" : true, "linkPoint" : y0 >= y1 ? geom.start2D : geom.end2D };
}

/**
 * Draw a fin planform snapped onto its parent surface.  `profilePoints` runs from
 * the fore root point to the aft root point (notes 2, 8).
 */
function drawSnappedFinOutline(context is Context, sketch is Sketch, profilePoints is array, units is ValueWithUnits, sketchPlane is Plane, parentSketch, parentSiblingSketches)
{
    const pointsNumber = size(profilePoints);
    if (pointsNumber == 0)
    {
        return;
    }

    const allEdges = collectSnapEdges(context, parentSketch, parentSiblingSketches);

    // Keep only curves that run under the root chord (notes 2).
    const axialIndex = 1;
    const radialIndex = 0;
    const foreV = profilePoints[0][axialIndex];
    const aftV = profilePoints[pointsNumber - 1][axialIndex];
    const vLo = min(foreV, aftV);
    const vHi = max(foreV, aftV);

    var snapEdges = [];
    var snapGeoms = [];
    for (var i = 0; i < size(allEdges); i += 1)
    {
        const geom = edgeGeometry(context, allEdges[i], sketchPlane);
        const overlap = min(max(geom.start2D[axialIndex], geom.end2D[axialIndex]), vHi)
                - max(min(geom.start2D[axialIndex], geom.end2D[axialIndex]), vLo);

        if (overlap > VERTEX_MATCH_TOLERANCE)
        {
            snapEdges = append(snapEdges, allEdges[i]);
            snapGeoms = append(snapGeoms, geom);
        }
    }

    // A curve near both root ends is preferred for them, so a body cap edge
    // cannot win a tie at a corner.
    var closureEdges = [];
    if (pointsNumber >= 2)
    {
        for (var i = 0; i < size(snapEdges); i += 1)
        {
            if (rootMatchDistance(profilePoints[0], snapGeoms[i]) <= SNAP_TOLERANCE
                    && rootMatchDistance(profilePoints[pointsNumber - 1], snapGeoms[i]) <= SNAP_TOLERANCE)
            {
                closureEdges = append(closureEdges, i);
            }
        }
    }

    // Only the root ends are fitted; interior points are tip corners (notes 8).
    const foreMatch = pointsNumber >= 2
            ? findRootEdgeIndex(profilePoints[0], snapGeoms, closureEdges)
            : -1;
    const aftMatch = pointsNumber >= 2
            ? findRootEdgeIndex(profilePoints[pointsNumber - 1], snapGeoms, closureEdges)
            : -1;

    // Which parent curve the ROOT chose, and how it was found, so the `[tab]`
    // lines have a reference to be read against (note 27).
    if (DEBUG_FIN_SNAP)
    {
        println("  [finroot] candidates=" ~ toString(size(snapEdges))
                ~ " closure=" ~ toString(size(closureEdges))
                ~ " foreMatch=" ~ toString(foreMatch)
                ~ " aftMatch=" ~ toString(aftMatch));
        for (var i = 0; i < size(snapGeoms); i += 1)
        {
            println("  [finroot]   edge" ~ toString(i)
                    ~ (snapGeoms[i]["isLine"] ? " line " : " curve")
                    ~ " y=" ~ toString(snapGeoms[i]["start2D"][1] / units)
                    ~ "..y=" ~ toString(snapGeoms[i]["end2D"][1] / units)
                    ~ " r=" ~ toString(snapGeoms[i]["start2D"][0] / units)
                    ~ "..r=" ~ toString(snapGeoms[i]["end2D"][0] / units)
                    ~ " foreD=" ~ toString(rootMatchDistance(profilePoints[0], snapGeoms[i]) / units)
                    ~ " aftD=" ~ toString(rootMatchDistance(profilePoints[pointsNumber - 1], snapGeoms[i]) / units));
        }
    }

    // Both ends matched: close along the projected surface.  Otherwise close
    // with the straight root chord -- never both, that would make two faces.
    if (pointsNumber >= 3 && foreMatch != -1 && aftMatch != -1)
    {
        const wanted = surfaceChainIndexes(context, sketchPlane, snapEdges, foreMatch, aftMatch, aftV);
        const lastWanted = size(wanted) - 1;

        // The single chain curve, when the whole root chord sits on one edge.
        const slideGeom = size(wanted) == 1
                ? edgeGeometry(context, snapEdges[wanted[0]], sketchPlane)
                : undefined;

        // Slide a uniformly offset root chord onto the surface (notes 9).
        if (slideGeom != undefined)
        {
            const foreSlide = nearestOnCurve2D(profilePoints[0], slideGeom);
            const aftSlide = nearestOnCurve2D(profilePoints[pointsNumber - 1], slideGeom);
            const foreGap = foreSlide[radialIndex] - profilePoints[0][radialIndex];
            const aftGap = aftSlide[radialIndex] - profilePoints[pointsNumber - 1][radialIndex];

            if (abs(foreGap) > ROOT_LINK_TOLERANCE && abs(foreGap - aftGap) <= ROOT_LINK_TOLERANCE)
            {
                for (var p = 0; p < pointsNumber; p += 1)
                {
                    profilePoints[p] = vector(profilePoints[p][radialIndex] + foreGap, profilePoints[p][axialIndex]);
                }
            }
        }

        // Decided before projecting: the answer can be that none is needed (notes 7).
        const foreLink = rootLinkEnd(edgeGeometry(context, snapEdges[wanted[0]], sketchPlane), profilePoints[0]);
        const aftLink = rootLinkEnd(edgeGeometry(context, snapEdges[wanted[lastWanted]], sketchPlane), profilePoints[pointsNumber - 1]);

        const foreNeedsLink = foreLink["needsLink"];
        const aftNeedsLink = aftLink["needsLink"];

        // Closed outline is the face already; projecting would double the edge (notes 10).
        if (size(wanted) == 1 && slideGeom["isLine"] && !foreNeedsLink && !aftNeedsLink)
        {
            if (DEBUG_FIN_SNAP)
            {
                // This path draws NO projection at all, which is why the flag
                // exists at all (note 27).
                println("  [finroot] path=closed-polyline (NO projection drawn) on edge"
                        ~ toString(wanted[0]) ~ " of the chain");
            }
            skPolyline(sketch, "finOutline", {
                        "points" : append(profilePoints, profilePoints[0]),
                        "constrained" : true
                    });
            return;
        }

        var projectedIds = makeArray(size(snapEdges));
        var projectionCount = 0;
        for (var i = 0; i < size(wanted); i += 1)
        {
            projectionCount += 1;
            const curveId = "snapCurve" ~ projectionCount;
            projectedIds[wanted[i]] = projectEdgeIntoSketch(context, sketch, curveId, snapEdges[wanted[i]], sketchPlane, false);
        }

        if (DEBUG_FIN_SNAP)
        {
            println("  [finroot] path=projected chain of " ~ toString(size(wanted))
                    ~ " curve(s), first=" ~ toString(wanted[0])
                    ~ " foreLink=" ~ toString(foreNeedsLink)
                    ~ " aftLink=" ~ toString(aftNeedsLink));
        }

        if (foreNeedsLink)
        {
            skLineSegment(sketch, "rootLinkFore", {
                        "start" : foreLink["linkPoint"],
                        "end" : profilePoints[0]
                    });
        }
        if (aftNeedsLink)
        {
            skLineSegment(sketch, "rootLinkAft", {
                        "start" : aftLink["linkPoint"],
                        "end" : profilePoints[pointsNumber - 1]
                    });
        }

        // Open outline -- the projected curves close the root edge.
        skPolyline(sketch, "finOutline", {
                    "points" : profilePoints,
                    "constrained" : true
                });

        // Fixed reference on the x-axis for the dimensions below.
        skPoint(sketch, "xAxisRef", {
                    "position" : vector(0, 0) * units
                });
        skConstraint(sketch, "fixXAxisRef", {
                    "constraintType" : ConstraintType.FIX,
                    "localFirst" : "xAxisRef"
                });

        // Pin each fitted root end; a linked end is left where the design put it (notes 8).
        const rootEnds = [[0, foreMatch], [pointsNumber - 1, aftMatch]];
        for (var e = 0; e < size(rootEnds); e += 1)
        {
            const i = rootEnds[e][0];
            const edgeIndex = rootEnds[e][1];

            if ((i == 0 && foreNeedsLink) || (i == pointsNumber - 1 && aftNeedsLink))
            {
                continue;
            }

            const vertexRef = polylineVertexRef("finOutline", i, pointsNumber - 1);

            skConstraint(sketch, "snapCoincident" ~ i, {
                        "constraintType" : ConstraintType.COINCIDENT,
                        "localFirst" : vertexRef,
                        "localSecond" : projectedIds[edgeIndex]
                    });

            // VERTICAL from the x-axis = the axial coordinate (notes 8).
            skConstraint(sketch, "snapXDimension" ~ i, {
                        "constraintType" : ConstraintType.DISTANCE,
                        "localFirst" : vertexRef,
                        "localSecond" : "xAxisRef",
                        "direction" : DimensionDirection.VERTICAL,
                        "length" : abs(profilePoints[i][axialIndex]),
                        "alignment" : DimensionAlignment.ALIGNED
                    });
        }
    }
    else
    {
        // Nothing to snap to: close the outline with the straight root chord.
        skPolyline(sketch, "finOutline", {
                    "points" : append(profilePoints, profilePoints[0]),
                    "constrained" : true
                });
    }
}

/**
 * A fin planform in sketch coordinates: the design's (x, y) becomes
 * (offsetRadius + y, -x), the convention the planar fin types use.
 */
function finProfilePoints(params is map, key is string, units is ValueWithUnits) returns array
{
    var profilePoints = convertProfilePoints(params[key], units);
    const offsetRadius = params.offsetRadius == undefined ? 0 : params.offsetRadius;

    for (var i = 0; i < size(profilePoints); i += 1)
    {
        const point = profilePoints[i];
        profilePoints[i] = vector(offsetRadius * units + point[1], -point[0]);
    }

    return profilePoints;
}

/** A fin tab: a U hanging INWARD off the parent's surface, closed by that surface
 * as it is projected in.  Four load-bearing rules govern it (notes 22, 24, 25, 28). */
export function sketchFinTab(context is Context, comp is map, sketch is Sketch, units is ValueWithUnits, sketchPlane is Plane, parentSketch)
{
    const params = comp.params;
    const tab = params.tab;
    if (tab == undefined)
    {
        return false;
    }

    const tabHeight = tab.height == undefined ? 0 : tab.height;

    // The tab's extent AFTER OpenRocket's own clamps, so a tab longer than the
    // root chord is shortened exactly as the UI shortens it.
    const extent = finTabExtent(params);
    const tabLength = extent["length"];

    if (tabHeight <= 1e-9 || tabLength <= 1e-9)
    {
        if (DEBUG_FIN_SNAP && tab.height != undefined)
        {
            println("  [tab] " ~ comp.name ~ " tab dropped: height=" ~ toString(tabHeight)
                    ~ " clampedLength=" ~ toString(tabLength)
                    ~ " (payload length=" ~ toString(tab.length == undefined ? 0 : tab.length)
                    ~ ", root chord=" ~ toString(finRootChord(params)) ~ ")");
        }
        return false;
    }

    // No chord means no fin, and a fin with no chord has nothing to hang a tab
    // off.  A freeform fin carries the same extent as `length`.
    if (finRootChord(params) <= 1e-9)
    {
        return false;
    }

    const radialIndex = 0;
    const axialIndex = 1;

    const offsetRadius = params.offsetRadius == undefined ? 0 : params.offsetRadius;

    // The design's span, fore to aft.  The planform maps the design's x to -x, and
    // y runs aft-negative, so the tab's FORE end is the LARGER of the two.
    const front = extent["front"];
    const foreGuess = vector(offsetRadius, -front) * units;
    const aftGuess = vector(offsetRadius, -(front + tabLength)) * units;
    const foreV = foreGuess[axialIndex];
    const aftV = aftGuess[axialIndex];

    // The PARENT's profile, and nothing else -- not the siblings.  See the header.
    const allEdges = collectSnapEdges(context, parentSketch, undefined);

    // One surface curve under the tab -- see the header and `surfaceUnderSpan`.
    const surface = surfaceUnderSpan(context, allEdges, sketchPlane, foreGuess, aftGuess);
    if (surface == undefined)
    {
        // No parent surface under the tab: a fin with no sketch behind it.  Draw
        // nothing rather than a tab floating unattached.
        return false;
    }

    // The radius at which the surface passes each of the tab's two ends, measured
    // ON the curve; equal at both ends on a straight parent, not on a taper.
    const geom = surface["geom"];
    const foreR = nearestOnCurve2D(foreGuess, geom)[radialIndex];
    const aftR = nearestOnCurve2D(aftGuess, geom)[radialIndex];

    const tabHeightLength = tabHeight * units;

    // One radius for the whole inner edge, `tabHeight` below the SMALLER of the
    // two -- OpenRocket's own rule, and the invariant to check on a taper.
    const innerRadius = min(foreR, aftR) - tabHeightLength;

    // How far the two top corners are pushed back OUT into the fin, so the two
    // solids interpenetrate instead of sharing a single face (note 25).
    var overlap = tabHeightLength / 4;
    const finThickness = params.thickness == undefined ? 0 : params.thickness * units;
    if (finThickness > 0 * meter && finThickness < overlap)
    {
        overlap = finThickness;
    }

    // Does the tab's span stay inside the surface's own span?  An overhang is
    // not a reason to refuse the tab; it is bridged as the fin root's is.
    const foreLink = rootLinkEnd(geom, foreGuess);
    const aftLink = rootLinkEnd(geom, aftGuess);
    const foreNeedsLink = foreLink["needsLink"];
    const aftNeedsLink = aftLink["needsLink"];

    if (DEBUG_FIN_SNAP)
    {
        // Both ends, every time: a line printing only when something needs a
        // bridge cannot answer "aft is there, fore is missing".  + = inside.
        println("  [tab] link check: surface y=" ~ toString(geom["start2D"][1]) ~ "..y=" ~ toString(geom["end2D"][1])
                ~ "  tab y=" ~ toString(foreV) ~ "..y=" ~ toString(aftV));
        println("  [tab]   fore needsLink=" ~ toString(foreNeedsLink)
                ~ " (tab fore is " ~ toString((geom["start2D"][1] - foreV) * 1000) ~ "mm inside the surface)");
        println("  [tab]   aft  needsLink=" ~ toString(aftNeedsLink)
                ~ " (tab aft is " ~ toString((geom["start2D"][1] - aftV) * 1000) ~ "mm inside the surface)");
    }

    // THE BRIDGE RADIUS: the inner radius plus one tab height, which makes a
    // bridge HORIZONTAL by construction (note 29).
    const bridgeRadius = innerRadius + tabHeightLength;
    const foreCornerR = foreNeedsLink ? bridgeRadius : foreR;
    const aftCornerR = aftNeedsLink ? bridgeRadius : aftR;

    // The overlap applies only where there IS a fin to overlap with, and a
    // BRIDGED corner never gets one however far inside the chord it is (note 30).
    const chordLength = finRootChord(params) * units;
    const foreOver = (!foreNeedsLink && foreV <= 0 * meter && foreV >= -chordLength) ? overlap : 0 * meter;
    const aftOver = (!aftNeedsLink && aftV <= 0 * meter && aftV >= -chordLength) ? overlap : 0 * meter;

    const topFore = vector(foreCornerR + foreOver, foreV);
    const topAft = vector(aftCornerR + aftOver, aftV);
    const foreInner = vector(innerRadius, foreV);
    const aftInner = vector(innerRadius, aftV);

    // The top edge IS the projected surface, real geometry, plus a bridge at each
    // overhang; the overlap rides on two risers (notes 22, 24, 31).
    const snapEdge = surface["edge"];
    const robustEdge = { "plane" : snapEdge["plane"],
                         "edgeQuery" : makeRobustQuery(context, snapEdge["edgeQuery"]) };
    projectEdgeIntoSketch(context, sketch, "tabSurface", robustEdge, sketchPlane, false);

    // The U: down the fore side, along the inner edge, back up the aft side.
    // skPolyline, not a spline: a tab is a flat plate with square corners.
    skPolyline(sketch, "finTab", {
                "points" : [topFore, foreInner, aftInner, topAft],
                "constrained" : true
            });

    // The top corners: of [topFore, foreInner, aftInner, topAft], line0.start is
    // the fore corner, line2.end the aft; each FIXED, with a RISER (notes 24, 25).
    const tabSides = [["Fore", topFore, foreNeedsLink, foreLink, foreOver, "finTab.line0.start"],
                      ["Aft", topAft, aftNeedsLink, aftLink, aftOver, "finTab.line2.end"]];
    for (var s = 0; s < size(tabSides); s += 1)
    {
        const which = tabSides[s][0];
        const corner = tabSides[s][1];
        const cornerBridged = tabSides[s][2];
        const link = tabSides[s][3];
        const cornerOver = tabSides[s][4];
        const vertexRef = tabSides[s][5];

        // FIXED unless it belongs ON the projection, in which case the fin root's
        // own arrangement applies; never an unsigned distance (note 24).
        const cornerOnSurface = !cornerBridged && cornerOver <= 0 * meter;

        if (cornerOnSurface)
        {
            // The station reference.  Only "same y" is ever asked of it, so its
            // radius is irrelevant and is set for legibility only.
            skPoint(sketch, "tabStation" ~ which, {
                        "position" : vector(corner[radialIndex], corner[axialIndex])
                    });
            skConstraint(sketch, "tabFixStation" ~ which, {
                        "constraintType" : ConstraintType.FIX,
                        "localFirst" : "tabStation" ~ which
                    });
        }

        skPoint(sketch, "tabCorner" ~ which, {
                    "position" : corner
                });
        if (cornerOnSurface)
        {
            skConstraint(sketch, "tabCornerOnSurface" ~ which, {
                        "constraintType" : ConstraintType.COINCIDENT,
                        "localFirst" : "tabCorner" ~ which,
                        "localSecond" : "tabSurface"
                    });
            skConstraint(sketch, "tabCornerStation" ~ which, {
                        "constraintType" : ConstraintType.HORIZONTAL,
                        "localFirst" : "tabCorner" ~ which,
                        "localSecond" : "tabStation" ~ which
                    });
        }
        else
        {
            skConstraint(sketch, "tabFixCorner" ~ which, {
                        "constraintType" : ConstraintType.FIX,
                        "localFirst" : "tabCorner" ~ which
                    });
        }

        // The U's own vertex IS the corner.  Point-to-point, so the vertex is a
        // slave of the corner and adds no equation of its own.
        skConstraint(sketch, "tabCornerJoins" ~ which, {
                    "constraintType" : ConstraintType.COINCIDENT,
                    "localFirst" : vertexRef,
                    "localSecond" : "tabCorner" ~ which
                });

        if (cornerBridged)
        {
            // Past the end of the parent, so there is no curve to lie on and the
            // bridge IS the top edge; horizontal on a straight parent.
            skLineSegment(sketch, "tabBridge" ~ which, {
                        "start" : link["linkPoint"],
                        "end" : corner
                    });

            // Shared coordinates are not a shared point, so both ends are
            // constrained: the corner, and the measured END VERTEX (note 7).
            const fromStart = norm(link["linkPoint"] - geom.start2D) <= norm(link["linkPoint"] - geom.end2D);
            skConstraint(sketch, "tabBridgeEnd" ~ which, {
                        "constraintType" : ConstraintType.COINCIDENT,
                        "localFirst" : "tabBridge" ~ which ~ ".end",
                        "localSecond" : "tabCorner" ~ which
                    });
            skConstraint(sketch, "tabBridgeStart" ~ which, {
                        "constraintType" : ConstraintType.COINCIDENT,
                        "localFirst" : "tabBridge" ~ which ~ ".start",
                        "localSecond" : fromStart ? "tabSurface.start" : "tabSurface.end"
                    });
            continue;
        }

        // THE RISER: its inner end, not the corner, lies on the projection, so
        // the surface is followed exactly and the overlap is a radial jog.
        if (cornerOver > 0 * meter)
        {
            skLineSegment(sketch, "tabRiser" ~ which, {
                        "start" : vector(corner[radialIndex] - cornerOver, corner[axialIndex]),
                        "end" : corner
                    });
            skConstraint(sketch, "tabRiserOnSurface" ~ which, {
                        "constraintType" : ConstraintType.COINCIDENT,
                        "localFirst" : "tabRiser" ~ which ~ ".start",
                        "localSecond" : "tabSurface"
                    });
            skConstraint(sketch, "tabRiserStation" ~ which, {
                        "constraintType" : ConstraintType.HORIZONTAL,
                        "localFirst" : "tabRiser" ~ which ~ ".start",
                        "localSecond" : "tabCorner" ~ which
                    });
        }
    }

    if (DEBUG_FIN_SNAP)
    {
        // What the sketch is ASKED to contain, before the solver has run; the
        // AFTER-solve measurement is `reportTabSketchCurves` (note 23 of main.fs).
        println("  [tab] asked for: tabSurface from edge" ~ toString(surface["index"])
                ~ (geom["isLine"] ? " via skLineSegment" : " via skSplineSegment+PROJECTED")
                ~ "  U topFore=(r=" ~ toString((foreR + overlap) / units) ~ ",y=" ~ toString(foreV / units)
                ~ ") topAft=(r=" ~ toString((aftR + overlap) / units) ~ ",y=" ~ toString(aftV / units)
                ~ ") inner=(r=" ~ toString(innerRadius / units) ~ ")");
    }

    // Design units throughout, so the numbers can be compared with the .ork.
    println("  [tab] " ~ comp.name ~ " (" ~ comp['type'] ~ ") surface edge matched, top edge is the projection");
    println("  [tab] " ~ comp.name ~ " tabSurface runs y=" ~ toString(geom["start2D"][axialIndex] / units)
            ~ " to " ~ toString(geom["end2D"][axialIndex] / units) ~ "  (tab y=" ~ toString(aftV / units)
            ~ " to " ~ toString(foreV / units) ~ ")");
    println("  [tab] " ~ comp.name ~ " fore/aft root radii=" ~ toString(foreR / units) ~ "/"
            ~ toString(aftR / units) ~ "  inner=" ~ toString(innerRadius / units) ~ "  overlap="
            ~ toString(overlap / units) ~ "  shorter end=" ~ toString((min(foreR, aftR) - innerRadius) / units)
            ~ "  tabHeight=" ~ toString(tabHeight));

    return true;
}

/** Read back and print what the SOLVED tab sketch holds -- the probe that tells
 * the three candidate bugs apart (note 35). */
export function reportTabSketchCurves(context is Context, sketchId, tabPlane is Plane, units is ValueWithUnits, label is string)
{
    const edgeQuery = qCreatedBy(sketchId, EntityType.EDGE);
    const count = evaluateQueryCount(context, edgeQuery);
    println("  [tab] " ~ label ~ " solved sketch holds " ~ toString(count) ~ " curve(s)");

    for (var i = 0; i < count; i += 1)
    {
        const edge = qNthElement(edgeQuery, i);

        // Both ends off the edge: the extent really in the sketch rather than
        // asked for.  A `tabSurface` spanning only the tab is the "short stub".
        const startVertices = evaluateQuery(context, qEdgeVertex(edge, true));
        const endVertices = evaluateQuery(context, qEdgeVertex(edge, false));
        if (size(startVertices) == 0 || size(endVertices) == 0)
        {
            println("  [tab]   curve" ~ toString(i) ~ " has no vertices (degenerate)");
            continue;
        }

        const startW = evVertexPoint(context, { "vertex" : startVertices[0] });
        const endW = evVertexPoint(context, { "vertex" : endVertices[0] });
        const start2D = worldToPlane(tabPlane, meridianImage(startW, tabPlane));
        const end2D = worldToPlane(tabPlane, meridianImage(endW, tabPlane));

        println("  [tab]   curve" ~ toString(i)
                ~ " y=" ~ toString(start2D[1] / units) ~ "..y=" ~ toString(end2D[1] / units)
                ~ " r=" ~ toString(start2D[0] / units) ~ "..r=" ~ toString(end2D[0] / units)
                ~ " length=" ~ toString(norm(end2D - start2D) / units));
    }
}

/** The single parent curve a tab's top edge follows, as the snap edge plus its 2D
 *  geometry, or undefined if none both spans the tab and sits at the root radius (note 32). */
function surfaceUnderSpan(context is Context, allEdges is array, finPlane is Plane, foreGuess is Vector, aftGuess is Vector)
{
    const axialIndex = 1;
    const vLo = min(foreGuess[axialIndex], aftGuess[axialIndex]);
    const vHi = max(foreGuess[axialIndex], aftGuess[axialIndex]);

    var bestEdge = undefined;
    var bestGeom = undefined;
    var bestRadius = 0 * meter;
    var bestExtent = 0 * meter;
    var bestIndex = -1;

    // Every candidate and why it was kept or dropped: the selection was revised on
    // hypotheses and never checked against a list, so it prints (note 32).
    if (DEBUG_FIN_SNAP)
    {
        println("  [tab] parent edges offered=" ~ toString(size(allEdges))
                ~ "  tab span y=" ~ toString(vLo) ~ "..y=" ~ toString(vHi));
    }

    for (var i = 0; i < size(allEdges); i += 1)
    {
        const geom = edgeGeometry(context, allEdges[i], finPlane);

        // Must COVER the MIDDLE of the tab, not merely touch it: mere overlap is
        // too weak, demanding a full SPAN too strong.  The middle half (note 32).
        const lo = min(geom.start2D[axialIndex], geom.end2D[axialIndex]);
        const hi = max(geom.start2D[axialIndex], geom.end2D[axialIndex]);
        const overlap = min(hi, vHi) - max(lo, vLo);
        if (overlap < (vHi - vLo) / 2)
        {
            if (DEBUG_FIN_SNAP)
            {
                println("  [tab]   edge" ~ toString(i) ~ " REJECT covers-too-little"
                        ~ " y=" ~ toString(lo) ~ "..y=" ~ toString(hi)
                        ~ " overlap=" ~ toString(overlap) ~ " of " ~ toString(vHi - vLo)
                        ~ (geom["isLine"] ? " line " : " curve")
                        ~ " r=" ~ toString(geom.start2D[0]) ~ "..r=" ~ toString(geom.end2D[0]));
            }
            continue;
        }

        // Among curves spanning the tab, the OUTERMOST wins: a bore, shoulder or
        // second skin is inboard.  Measure at the FORE end, correct on a taper.
        const radiusAtFore = nearestOnCurve2D(foreGuess, geom)[0];
        const extent = hi - lo;

        // Extent only breaks an exact radius tie: a longer run at the same radius
        // is the same surface; a shorter is never better.
        if (bestGeom == undefined || radiusAtFore > bestRadius
                || (radiusAtFore == bestRadius && extent > bestExtent))
        {
            bestEdge = allEdges[i];
            bestGeom = geom;
            bestRadius = radiusAtFore;
            bestExtent = extent;
            bestIndex = i;
        }
    }

    if (bestGeom == undefined)
    {
        if (DEBUG_FIN_SNAP)
        {
            println("  [tab] no parent edge spanned the tab -- the tab is NOT drawn");
        }
        return undefined;
    }

    if (DEBUG_FIN_SNAP)
    {
        // The index is against `allEdges`, so it reads straight off the
        // "offered=" list and off the `[finroot] edgeN` lines (note 32).
        println("  [tab] CHOSE edge" ~ toString(bestIndex)
                ~ "  extent=" ~ toString(bestExtent)
                ~ " (tab length=" ~ toString(vHi - vLo) ~ ")"
                ~ " radiusAtFore=" ~ toString(bestRadius)
                ~ (bestGeom["isLine"] ? " (line source: skLineSegment, no constraints)" : " (curve source: skSplineSegment + 3 PROJECTED)"));
    }

    return { "edge" : bestEdge, "geom" : bestGeom, "index" : bestIndex };
}


// Stations per surface for the airfoil section.  Cosine spacing, so the
// samples bunch at the leading edge where the sqrt term turns sharply.
const AIRFOIL_SAMPLES = 25;

// Steps per half circle for the rounded section.  A 22.5 degree step puts the
// chordal error near 0.03 mm, and a polyline is safer than an arc that must close.
const ARC_STEPS = 8;

/** The fin cross-section, a closed profile in a plane whose NORMAL is the fin's
 *  span, so extruding it radially sweeps the section along the whole fin (notes 20, 21, 23). */
export function finCrossSectionProfile(comp is map, sketch is Sketch, units is ValueWithUnits, chord, thickness)
{
    const crossSection = comp.params.crossSection == undefined ? "square" : comp.params.crossSection;

    if (crossSection == "rounded")
    {
        return roundedSectionProfile(sketch, units, chord, thickness);
    }
    if (crossSection == "airfoil")
    {
        return airfoilSectionProfile(sketch, units, chord, thickness);
    }
    return squareSectionProfile(sketch, units, chord, thickness);
}

/** A plain rectangle: the section every fin has always been drawn with here. */
function squareSectionProfile(sketch is Sketch, units is ValueWithUnits, chord, thickness)
{
    const half = thickness / 2;
    skPolyline(sketch, "finSection", {
                "points" : [vector(-half, 0) * units, vector(half, 0) * units,
                            vector(half, chord) * units, vector(-half, chord) * units,
                            vector(-half, 0) * units],
                "constrained" : true
            });
    return true;
}

/** A rectangle with both ends radiused to half the thickness: a chord shorter than
 *  the two radii has no straight run, so it falls back to the plain rectangle (note 23). */
function roundedSectionProfile(sketch is Sketch, units is ValueWithUnits, chord, thickness)
{
    const half = thickness / 2;
    const radius = half;
    const straightAft = chord - radius;

    if (chord <= 0 || half <= 0 || straightAft <= radius)
    {
        return squareSectionProfile(sketch, units, chord, thickness);
    }

    var pts = [];

    // Top straight run, fore to aft.
    pts = append(pts, vector(half, radius) * units);
    pts = append(pts, vector(half, straightAft) * units);

    // Aft half circle: (half, straightAft) round to (-half, straightAft).
    pts = appendHalfCircle(pts, units, 0, straightAft, radius, 0, PI);

    // Bottom straight run, aft to fore.
    pts = append(pts, vector(-half, radius) * units);

    // Fore half circle: (-half, radius) round to (half, radius).
    pts = appendHalfCircle(pts, units, 0, radius, radius, PI, 2 * PI);

    skPolyline(sketch, "finSection", { "points" : pts, "constrained" : true });
    return true;
}

/** A symmetric airfoil section from the NACA four-digit thickness series, scaled to
 *  the fin's own maximum thickness.  A deliberate choice: OpenRocket defines no airfoil (note 23). */
function airfoilSectionProfile(sketch is Sketch, units is ValueWithUnits, chord, thickness)
{
    const half = thickness / 2;
    const stations = AIRFOIL_SAMPLES;

    if (chord <= 0 || half <= 0 || stations < 3)
    {
        return false;
    }

    // Upper surface leading to trailing, then the lower surface back again, so
    // the two meet at the shared trailing point and the loop closes.
    var upper = [];
    var lower = [];
    for (var i = 0; i < stations; i += 1)
    {
        // `cos` takes a QUANTITY in std, so the angle needs `* radian` (note 33).
        const s = (1 - cos(PI * i / (stations - 1) * radian)) / 2;
        const y = airfoilHalfThickness(s) * half;
        upper = append(upper, vector(y, s * chord) * units);
        lower = append(lower, vector(-y, s * chord) * units);
    }

    var pts = upper;
    for (var j = size(lower) - 1; j >= 0; j -= 1)
    {
        pts = append(pts, lower[j]);
    }
    pts = append(pts, upper[0]);

    // skFitSpline, not a polyline: the section IS smooth.  The leading and
    // trailing points are shared, so the loop still closes.
    skFitSpline(sketch, "finSection", { "points" : pts });
    return true;
}

/** The NACA four-digit half-thickness at chord fraction `s`, normalised so the maximum
 *  is 1; `s` is clamped to [0, 1] so a rounded sample cannot ask for a negative root. */
function airfoilHalfThickness(s)
{
    const c = min(1, max(0, s));
    return 5 * (0.2969 * sqrt(c) - 0.1260 * c - 0.3516 * c * c
                + 0.2843 * c * c * c - 0.1036 * c * c * c * c);
}

/** Points along a circle of `radius` about (`centreX`, `centreY`), `from` to `to`
 * inclusive.  The caller supplies the start point, so only the steps are added. */
function appendHalfCircle(points is array, units is ValueWithUnits, centreX, centreY, radius, from, to) returns array
{
    // `from`/`to` are bare numbers in radians, given their unit only where the
    // trig functions need one (note 33).
    for (var i = 1; i <= ARC_STEPS; i += 1)
    {
        const angle = from + (to - from) * i / ARC_STEPS;
        points = append(points, vector(centreX + radius * cos(angle * radian), centreY + radius * sin(angle * radian)) * units);
    }
    return points;
}

/** Meridian section of a motor: a solid rectangle of `radius` from `foreY` to `aftY`,
 *  which `annulusSketch` cannot draw, so both y values are taken (notes 19, 20, 21). */
export function motorSectionSketch(sketch is Sketch, radius, foreY, aftY, units is ValueWithUnits)
{
    // `radius` is scaled here and `foreY`/`aftY` are already lengths; `vector()`
    // needs both the same kind, or it is a type error (note 21).
    const topFore = vector(radius * units, foreY);
    const topAft = vector(radius * units, aftY);
    const bottomFore = vector(0 * units, foreY);
    const bottomAft = vector(0 * units, aftY);

    skPolyline(sketch, "motorSection", {
                "points" : [topFore, topAft, bottomAft, bottomFore, topFore],
                "constrained" : true
            });
}

/** The fin's root chord, in design units.  A freeform fin has no `rootChord`, but
 * the geometry pass attaches the same extent as `length`. */
export function finRootChord(params is map) returns number
{
    if (params.rootChord != undefined && params.rootChord > 0)
    {
        return params.rootChord;
    }
    if (params.length != undefined && params.length > 0)
    {
        return params.length;
    }
    return 0;
}

/** The tab's axial extent inside the root chord, as `{ "front", "length" }` in design
 *  units from the LEADING EDGE, by AxialMethod's conversion and WITHOUT clamping (notes 20, 21, 34). */
function finTabExtent(params is map) returns map
{
    const tab = params.tab;
    const chord = finRootChord(params);

    const offset = tab.position == undefined ? 0 : tab.position;
    const method = tab.positionMethod == undefined ? "middle" : tab.positionMethod;

    // The payload's own length, used unmodified by AxialMethod's conversion --
    // the tab is not clamped to the chord here (see the note above).
    var length = tab.length == undefined ? 0 : tab.length;

    // `position` is a LENGTH in metres, not a fraction of the chord, and may be
    // NEGATIVE.  All FIVE AxialMethod cases are explicit (note 34).
    var front = offset;
    if (method == "after" || method == "aftersibling" || method == "aftersiblings")
    {
        front = offset + chord;
    }
    else if (method == "middle" || method == "center" || method == "centre")
    {
        front = offset + (chord - length) / 2;
    }
    else if (method == "bottom" || method == "end")
    {
        front = offset + (chord - length);
    }
    else if (method == "top" || method == "front" || method == "absolute" || method == "tip")
    {
        // "top"/"front" measure from the parent's leading edge and
        // "absolute"/"tip" from the rocket's tip; both reduce to the bare offset.
        front = offset;
    }
    else if (DEBUG_FIN_SNAP)
    {
        // Loud rather than silent: an unknown method is an importer bug, and
        // guessing "top" hides it until the tab is visibly in the wrong place.
        println("  [tab] unknown positionMethod \"" ~ method ~ "\" -- treating as top");
    }

    // A negative length is meaningless; anything else is passed through as the
    // payload asks, INCLUDING a tab longer than the chord.  See the note above.
    return { "front" : front, "length" : max(0, length) };
}

/** Whether a payload describes a fin tab worth drawing at all.  See sketchFinTab. */
export function finHasTab(params is map) returns boolean
{
    const tab = params.tab;
    if (tab == undefined)
    {
        return false;
    }
    const tabHeight = tab.height == undefined ? 0 : tab.height;
    const tabLength = tab.length == undefined ? 0 : tab.length;
    return tabHeight > 1e-9 && tabLength > 1e-9;
}

export function freeformfinsetComponentSketch(context is Context, comp is map, sketch is Sketch, units is ValueWithUnits, sketchPlane is Plane, parentSketch, parentSiblingSketches)
{
    drawSnappedFinOutline(context, sketch, finProfilePoints(comp.params, "points", units), units, sketchPlane, parentSketch, parentSiblingSketches);
}

export function trapezoidfinsetComponentSketch(context is Context, comp is map, sketch is Sketch, units is ValueWithUnits, sketchPlane is Plane, parentSketch, parentSiblingSketches)
{
    drawSnappedFinOutline(context, sketch, finProfilePoints(comp.params, "planform", units), units, sketchPlane, parentSketch, parentSiblingSketches);
}

export function ellipticalfinsetComponentSketch(context is Context, comp is map, sketch is Sketch, units is ValueWithUnits, sketchPlane is Plane, parentSketch, parentSiblingSketches)
{
    drawSnappedFinOutline(context, sketch, finProfilePoints(comp.params, "planform", units), units, sketchPlane, parentSketch, parentSiblingSketches);
}

/** Tube-fin section in the meridian sketch plane: an annulus centred at the tube
 * axis, offset from the rocket axis by the parent body radius plus the tube. */
export function tubefinsetComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    const params = comp.params;
    const length = params.length;
    const outerRadius = params.outerRadius;
    const innerRadius = max(0, outerRadius - params.thickness);
    const centerOffset = (params.offsetRadius == undefined ? 0 : params.offsetRadius) + outerRadius;

    // One wall rectangle, clear of the revolve axis (notes 11).
    const innerTop = vector(centerOffset - outerRadius, 0) * units;
    const outerTop = vector(centerOffset - innerRadius, 0) * units;
    const innerBottom = vector(centerOffset - outerRadius, -length) * units;
    const outerBottom = vector(centerOffset - innerRadius, -length) * units;

    skPolyline(sketch, "tube_fin_section", {
        "points" : [innerTop, outerTop, outerBottom, innerBottom, innerTop],
        "constrained" : true
    });
}

/** Packed canister: parachute, shock cord or mass component, solid to its radius.
 * A zero packed length draws nothing, as OpenRocket renders nothing (notes 4, 20). */
function packedCanisterSketch(params is map, sketch is Sketch, units is ValueWithUnits)
{
    // A raw payload number, so the tolerance is a bare `1e-9` and not
    // `MIN_SEGMENT_LENGTH` -- that is a quantity (notes 20, 21).
    const packedLength = params.packedLength == undefined ? 0 : params.packedLength;

    if (packedLength <= 1e-9)
    {
        return;
    }

    annulusSketch(sketch, 0, params.packedRadius, packedLength, units);
}

export function shockcordComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits) {
    packedCanisterSketch(comp.params, sketch, units);
}

export function parachuteComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits) {
    packedCanisterSketch(comp.params, sketch, units);
}

/** A streamer, drawn as its PACKED canister, like a parachute or shock cord.  Its
 * own function only to make explicit that it is modelled stowed (note 15). */
export function streamerComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits) {
    packedCanisterSketch(comp.params, sketch, units);
}

export function launchlugComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits) {
    const params = comp.params;
    const length = params.length;
    
    const outerRadius = params.offsetRadius;
    const thickness = params.thickness;
    
    const topLeft = vector(outerRadius, 0) * units;
    const bottomLeft = vector(outerRadius, -length) * units;
    
    const topRight = topLeft + vector(thickness, 0) * units;
    const bottomRight = bottomLeft + vector(thickness, 0) * units;
    
    sketchQuadrilateral(sketch, topLeft, topRight, bottomLeft, bottomRight);
}

export function masscomponentComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits) {
    packedCanisterSketch(comp.params, sketch, units);
}

export function centeringringComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits) {
    annulusSketch(sketch, comp.params.innerRadius, comp.params.outerRadius, comp.params.length, units);
}

/** Meridian section of a rail button, revolved about the z axis of its own frame
 * (notes 19, 36). */
export function railbuttonComponentSketch(comp is map, sketch is Sketch, units is ValueWithUnits){
    const params = comp.params;
    
    const outerDiameter = params.outerDiameter;
    const innerDiameter  = params.innerDiameter;
    const totalHeight = params.totalHeight;
    const flangeHeight = params.flangeHeight;
    const baseHeight = params.baseHeight;
    const screwHeight = params.screwHeight;
    
    // The parent's surface radius: every run is measured out from it.
    const outerRadius = params.offsetRadius;

    const origin = vector(outerRadius, 0) * units;
    
    const left = vector(0, -outerDiameter/2) * units + origin;
    const leftOuter = vector(baseHeight, -outerDiameter/2) * units + origin;
    const leftInner = vector(baseHeight, -innerDiameter/2) * units + origin;
    const rightInner = vector(baseHeight + flangeHeight, -innerDiameter/2) * units + origin;
    const rightOuter = vector(baseHeight + flangeHeight, -outerDiameter/2) * units + origin;
    const rightMostOuter = vector(totalHeight, -outerDiameter/2) * units + origin;
    
    // Six segments over seven points, so the last segment is `line5`.
    skPolyline(sketch, "polyline", {
            "points" : [
                origin,
                left,
                leftOuter,
                leftInner,
                rightInner,
                rightOuter,
                rightMostOuter
            ]
    });

    // The top corner.  `cornerCenter` is the corner itself: one half-outer-
    // diameter below the axis, at the full height.
    const cornerCenter = origin + vector(totalHeight, 0) * units;
    if (screwHeight != 0) {
        const arcDefinition = {
                "center" : cornerCenter,
                "majorAxis" : normalize(vector(1, 0)),
                // Half the outer diameter: the arc has to reach the polyline's
                // end, which sits half the outer diameter below the axis.
                "minorRadius" : outerDiameter / 2 * units,
                "majorRadius" : screwHeight * units,
                // 0.75 is the -y end of the minor axis, 1.0 the +x end of the
                // major axis; sweeping the other way leaves the profile open.
                "startParameter" : 0.75,
                "endParameter" : 1.0
        };
        skEllipticalArc(sketch, "screwArc", arcDefinition);
    }

    // Where the top corner ends, and so where the centerline starts: the corner
    // itself, or the arc's far end.  `origin` is already in `cornerCenter`.
    var endPosition = cornerCenter;
    if (screwHeight != 0) {
        endPosition = endPosition + vector(screwHeight, 0) * units;
    } else {
        skLineSegment(sketch, "rightline", {
                "start" : rightMostOuter,
                "end" : endPosition
        });
    }
    
    skLineSegment(sketch, "centerline", {
            "start" : endPosition,
            "end" : origin
    });

    // Close the loop with real coincidences rather than the numeric ones the guess
    // satisfies; only the three shared joints are constrained.
    const joints = [
            // polyline end -> the top corner's near end
            ["polyline.line5.end", screwHeight != 0 ? "screwArc.start" : "rightline.start"],
            // the top corner's far end -> the centerline
            [screwHeight != 0 ? "screwArc.end" : "rightline.end", "centerline.start"],
            // the centerline -> the polyline's first point, `origin`
            ["centerline.end", "polyline.line0.start"]
    ];
    for (var i = 0; i < size(joints); i += 1)
    {
        skConstraint(sketch, "railButtonJoint" ~ i, {
                    "constraintType" : ConstraintType.COINCIDENT,
                    "localFirst" : joints[i][0],
                    "localSecond" : joints[i][1]
                });
    }
}

/** Meridian section of a nose cone or transition, from the two profiles the web
 * app computed; shoulders are NOT in it (notes 14, 15, 18). */
function sketchProfile(comp is map, sketch is Sketch, units is ValueWithUnits)
{
    const params = comp.params;
    const length = params.length * units;

    // `var`, not `const`: the y of every point is shifted below, which mutates the
    // array in place.  A const binding rejects that assignment outright.
    var profilePoints = convertProfilePoints(params.profile, units);

    if (size(profilePoints) < 2)
    {
        // @keep: the user has to re-export the JSON for this to go away.
        println("  [profile] " ~ comp.name ~ " (" ~ comp['type'] ~ ") has no profile — regenerate the JSON with the current web app");
        return;
    }

    const pointsNumber = size(profilePoints);
    for (var i = 0; i < pointsNumber; i += 1)
    {
        profilePoints[i][1] -= length;
    }

    // A solid tip sits ON the axis, and a thin-walled BORE can be clipped onto
    // it: either way the outline meets the axis along a segment (note 19).
    drawOutline(sketch, "transition_spline", "tip_line", "aft_tip_line", profilePoints, false);

    // A missing bore means a stale payload; fall back to the axis and say so.
    const hasBore = params.innerProfile != undefined;
    if (!hasBore)
    {
        // @keep: a stale payload, and the user is the one who can fix it.
        println("  [profile] " ~ comp.name ~ " (" ~ comp['type'] ~ ") has no innerProfile — drawn solid; regenerate the JSON with the current web app");
    }

    // Dividing by `units` turns a length back into a bare number before it is
    // rebuilt as a sketch point; scaling twice would square the unit (note 21).
    const foreY = profilePoints[0][1] / units;
    const aftY = profilePoints[pointsNumber - 1][1] / units;

    var innerPoints = hasBore
            ? convertProfilePoints(params.innerProfile, units)
            : [ vector(0, foreY) * units, vector(0, aftY) * units ];

    for (var i = 0; i < size(innerPoints); i += 1)
    {
        innerPoints[i][1] -= length;
    }

    // A solid section's bore IS the axis; a walled one's is clipped onto it when
    // the wall is thicker than the local radius.  (notes 19)
    drawOutline(sketch, "inner_spline", "inner_tip_line", "inner_aft_tip_line",
                innerPoints, params.innerIsAxis == true || !hasBore);

    // End faces: on a solid these span the full radius, on a walled one only the
    // wall.  Where outer and bore MEET, no segment -- it fails the revolve.
    const innerFirst = innerPoints[0];
    if (norm(innerFirst - profilePoints[0]) > MIN_SEGMENT_LENGTH)
    {
        skLineSegment(sketch, "top_line", {
                    "start" : profilePoints[0],
                    "end" : innerFirst
                });
    }

    const outerLast = profilePoints[pointsNumber - 1];
    const innerLast = innerPoints[size(innerPoints) - 1];
    if (norm(innerLast - outerLast) > MIN_SEGMENT_LENGTH)
    {
        skLineSegment(sketch, "bottom_line", {
                    "start" : outerLast,
                    "end" : innerLast
                });
    }
}

/** Meridian polygon of ONE shoulder, in its own sketch so it can be revolved and
 * unioned on separately; `which` is "fore" or "aft" (note 18). */
export function sketchShoulder(comp is map, sketch is Sketch, units is ValueWithUnits, which is string)
{
    const params = comp.params;
    const length = params.length * units;

    const shoulders = params.shoulderProfile;
    if (shoulders == undefined)
    {
        // @keep: as above -- only a fresh payload fixes this.
        println("  [shoulder] " ~ comp.name ~ " (" ~ comp['type'] ~ ") has no shoulderProfile — regenerate the JSON with the current web app");
        return;
    }

    const data = which == "fore" ? shoulders.fore : shoulders.aft;
    if (data == undefined)
    {
        // @keep: says which end is missing, which is the whole diagnosis.
        println("  [shoulder] " ~ comp.name ~ " (" ~ comp['type'] ~ ") has no " ~ which ~ " shoulder in the payload");
        return;
    }

    // `var`, not `const`: the y of every point is shifted below, which mutates
    // the arrays in place.  A const binding rejects that assignment outright.
    var profilePoints = convertProfilePoints(data.profile, units);
    var innerPoints = convertProfilePoints(data.innerProfile, units);

    if (size(profilePoints) < 2 || size(innerPoints) < 2)
    {
        println("  [shoulder] " ~ comp.name ~ " (" ~ comp['type'] ~ ") " ~ which ~ " shoulder has a degenerate polygon — skipping it");
        return;
    }

    for (var i = 0; i < size(profilePoints); i += 1)
    {
        profilePoints[i][1] -= length;
    }
    for (var i = 0; i < size(innerPoints); i += 1)
    {
        innerPoints[i][1] -= length;
    }

    // A shoulder's meridian is a POLYGON -- straight walls, a flat connector
    // step, a flat cap -- so `skPolyline`, never `skFitSpline` (note 18).
    skPolyline(sketch, "shoulder_outer", { "points" : profilePoints });
    skPolyline(sketch, "shoulder_inner", { "points" : innerPoints });

    // The two end faces, skipped where the outer and the bore already meet: a
    // zero-length segment is degenerate (note 16).
    const innerFirst = innerPoints[0];
    if (norm(innerFirst - profilePoints[0]) > MIN_SEGMENT_LENGTH)
    {
        skLineSegment(sketch, "shoulder_top_line", {
                    "start" : profilePoints[0],
                    "end" : innerFirst
                });
    }

    const outerLast = profilePoints[size(profilePoints) - 1];
    const innerLast = innerPoints[size(innerPoints) - 1];
    if (norm(innerLast - outerLast) > MIN_SEGMENT_LENGTH)
    {
        skLineSegment(sketch, "shoulder_bottom_line", {
                    "start" : outerLast,
                    "end" : innerLast
                });
    }
}

function sketchQuadrilateral(sketch, topLeft, topRight, bottomLeft, bottomRight)
{
    skLineSegment(sketch, "outer_edge", {
                "start" : topRight,
                "end" : bottomRight
            });

    skLineSegment(sketch, "inner_edge", {
                "start" : topLeft,
                "end" : bottomLeft
            });

    skLineSegment(sketch, "top_edge", {
                "start" : topLeft,
                "end" : topRight
            });

    skLineSegment(sketch, "bottom_edge", {
                "start" : bottomLeft,
                "end" : bottomRight
            });
}

/*
 * ---------------------------------------------------------------------------
 * Notes referenced from the comments above.
 * ---------------------------------------------------------------------------
 * 1. Why revolve about the plane's own axis, not the global Z axis
 *
 *    Every component is coaxial with the rocket axis (Z), but a component inside
 *    a pod set is coaxial with the *pod*.  Revolving about the global axis
 *    therefore measures a pod child's radius as the pod's offset from the rocket
 *    axis: a fin root a little off a pod tube far off centre reads as the pod's
 *    whole offset, so the snap test compares the fin against the pod's centreline
 *    instead of its wall, and the root-slide pass then shoves the profile out
 *    until the fin lands on the core body's surface.  Taking the axis through the
 *    plane origin's own x/y picks the component's own axis out of that family; for
 *    a coaxial component the origin is on the global axis, so nothing changes.
 *
 *    Note a Plane is a value type, not a map, so `origin` and the basis vectors
 *    are read by index (`origin[0]`) and not by field name.
 *

 * 2. Restricting snap candidates to the fin's own axial span
 *
 *    Two kinds of curve must not contribute, and both are caught by requiring
 *    the curve to *overlap* the root chord's axial span:
 *
 *      - A curve ahead of (or behind) the fin.  A transition running forward of
 *        a fin ends exactly on the fin's fore corner, so it ties with the body it
 *        butts against for the root snap; projecting it runs the face off past
 *        the fin instead of along the body underneath.
 *      - End caps.  Being perpendicular to the axis they have no axial extent,
 *        but they share a vertex with the wall beside them, so at a root corner
 *        they also measure zero -- and snapping to one leaves the chain walk
 *        with no axial continuation.  A fin root runs along the side, never
 *        across an end face.
 *
 *    The test is overlap rather than containment because the body wall a fin sits
 *    on normally extends past both ends of the chord, and that is correct.
 *

 * 3. Why the parent's siblings are snap targets
 *
 *    A fin's root can outrun its direct parent, for instance a fin on a
 *    transition whose root reaches back over the body tube beside it.  The face
 *    then has to close along the real profile across that whole run, so the
 *    neighbouring outlines are offered as well as the parent's.
 *

 * 4. Why edgeIndexAllowed tests membership
 *
 *    The restriction used to be the range test `size(restrictTo) >= i`, which
 *    skipped indices 0..size(restrictTo) rather than checking membership.
 *    Low-indexed edges such as a body's outer wall were never considered, and a
 *    fin point matched the tube's inner wall instead.
 *

 * 5. Why the chain walk is given the aft root's own y
 *
 *    The walk heads towards the aft root, so that is what it must measure
 *    against -- not an arbitrary vertex of the aft edge.  A transition's start
 *    vertex sits exactly where the previous segment ends, so using it as the
 *    target makes the walk's direction ambiguous at that shared point: it steps
 *    no further and the last segment of the body never gets picked up.
 *

 * 6. How the projection is drawn
 *
 *    Straight sources become a line segment between the projected end points and
 *    are left unconstrained: the PROJECTED constraints mis-drive line entities,
 *    dragging the segment onto the rocket axis or along a wrong axis.
 *
 *    Curved sources become a spline segment driven by three PROJECTED ("use")
 *    constraints, matching what Onshape's own Use/Project emits -- a USE_END at
 *    each end plus a whole-curve USE.  Each constraint needs a distinct `index`:
 *    that is the auto-numbering key skConstraint uses when `name` is empty, so
 *    sharing one displaces a constraint rather than adding it.
 *
 *    The spline is created bare and driven entirely by those three constraints.
 *    No initial guess is set: skSplineSegment takes no "guess" key (only the
 *    closed skSpline does), and skSetInitialGuess is not needed here.
 *
 *    Source vertices are revolved onto this fin's meridian before being drawn.
 *    Plain orthogonal projection foreshortens a non-coplanar source to
 *    r*cos(angle), and revolving without regard to the side puts a vertex
 *    opposite the plane's +x direction at +r where the surface is at -r -- a
 *    parallel line at the wrong radius.  This is the same mapping meridianImage
 *    draws with, so the measurement and the drawn geometry agree.
 *

 * 7. Bridging a root end that misses its curve
 *
 *    Two distinct gaps leave the face unclosed: an axial overrun, where the root
 *    chord runs past the parent's end so the projected curve stops short, and a
 *    radial offset, where the root sits at the wrong radius and so runs parallel
 *    to the curve at a distance.  Measuring the distance to the curve itself
 *    rather than to its end points covers both.  For a straight source the drawn
 *    geometry *is* the segment between its two 2D end points, so the closest
 *    point on it is a valid link anchor, and an end already on the segment needs
 *    no link.  A curved source is drawn as a spline whose chord is not in the
 *    sketch, so there the axial extent test is used instead -- a curve's own bow
 *    cannot fake it, being reached through the coincident constraint that slides
 *    the point on.
 *
 *    This is also the shape of OpenRocket's own closure on a tapering parent.
 *    A fin root's radius is clamped to the parent's aft radius --
 *    profile_y = max(y, aftRadius) -- and the outline is then closed by a
 *    segment running from the last point to the nearest point of the parent
 *    profile.  Because the clamp puts both of that segment's ends at the same
 *    radius, the segment is horizontal: the fin's trailing part runs straight
 *    along, at constant radius, past the parent's aft end.  That is exactly the
 *    axial-overrun link above, and it is why matching a root end must ignore
 *    the axial part of the distance (see rootMatchDistance).
 *

 * 8. Why only the root ends are fitted
 *
 *    OpenRocket gives a fin one mount radius (FinSet.getFinFront() ->
 *    getBodyRadius()) and leaves the planform's own points alone.  An interior
 *    point is a tip corner, so letting it snap within SNAP_TOLERANCE of the wall
 *    flattens the fin onto the body -- a leading edge a few mm proud of the tube
 *    gets pulled down onto it.  For the same reason a root end bridged by a link
 *    line is left where the design put it: constraining it back onto the curve
 *    would reopen the gap the link closes.
 *

 * 9. Why an offset root chord is slid onto the surface
 *
 *    The surface curve is the authority on where the parent's surface is: the
 *    design's own offsetRadius can be wrong (a fin on a pod reporting its
 *    thickness/2 instead of the pod tube's outer radius), which would bury the
 *    root inside the parent or leave it floating clear of it.  When the root
 *    chord is parallel to a single chain curve and sits a uniform distance off
 *    it, the whole profile is slid onto that curve.  A purely axial overrun is
 *    left alone -- there is no curve to sit on, and the links bridge it.
 *
 *    The slide applies to CURVED chains as well, which is the whole point for a
 *    fin on an ellipsoid or ogive transition.  Such a fin reports one flat
 *    offsetRadius -- the radius at its fore station -- while the surface runs
 *    from the fore radius to the aft radius underneath it, so the chord is
 *    parallel to nothing and sits at a varying distance.  Restricting the slide
 *    to straight chains meant those fins were never corrected at all.
 *
 *    Measuring that distance needs the curve itself: a projected curve is drawn
 *    as a spline whose interior bow is not a line, so comparing it against its
 *    chord would report a gap that is not there.  `edgeGeometry` therefore
 *    carries `samples2D` for curved edges and `nearestOnCurve2D` measures
 *    against those, falling back to the segment only for straight sources.
 *

 * 10. Why the closed outline is preferred when the chord lies on one curve
 *
 *     The root chord already lies exactly on a single straight chain curve, so
 *     the closed outline is already the face.  Projecting the curve on top of it
 *     lays a second edge along the very same root chord, and the two overlapping
 *     edges leave the region solver free to close the loop the wrong way,
 *     producing a face that spans the curve's whole length instead of the fin.
 *     Only straight sources qualify: a spline root has to follow the curve,
 *     which is what the projected copy is for.
 *

 * 11. Why a tube fin's section must not span the revolve axis
 *
 *     The section is one wall rectangle lying entirely to one side of the tube's
 *     own axis; revolving that single region through 360 degrees already yields
 *     the complete hollow tube.  Letting the rectangle straddle the axis makes it
 *     self-intersecting, and Onshape collapses the resulting solid to a line.
 *

 * 12. Why matching ignores the axial part of a root end's distance
 *
 *     A fin's root can outrun its parent, and OpenRocket's own construction is
 *     what makes it so.  A fin root's radius is clamped to the parent's aft
 *     radius -- profile_y = max(y, aftRadius) -- and the outline is then closed
 *     by a segment from the last point to the nearest point of the parent
 *     profile.  Since the clamp puts both of that segment's ends at the same
 *     radius, the segment is HORIZONTAL: the fin's trailing part runs straight
 *     along, at constant radius, past the parent's aft end.
 *
 *     So for a root end lying beyond a curve's axial end, the axial gap is not a
 *     failure to snap -- it is a link waiting to be drawn (notes 7).  Measuring
 *     the full 3D distance adds that overrun to the radial term, so a fin
 *     sitting at exactly the right radius still reports millimetres, blows past
 *     SNAP_TOLERANCE, and matches nothing.  `rootMatchDistance` therefore
 *     measures only the radial term once the root end is out of the curve's
 *     span, and measures against the curve itself while it is inside it.
 *
 *     This is why a narrowing transition is the hard case and a body tube is
 *     not: a tube's radius is constant, so a flat offsetRadius matches at both
 *     ends and the full distance equals the radial distance anyway.
 *

 * 13. Why rootMatchDistance has no return annotation
 *
 *     It returns a LENGTH, and FeatureScript treats a quantity as a different
 *     type from `number`.  Annotating it `returns number` is a type error, and
 *     the compiler reports a quantity by its internal representation:
 *     "Return value should be number, was map".  `norm`, `min` and `sqrt` all
 *     return quantities and all leave the annotation off in std, so this
 *     function does too.  Only annotate when the value really is a bare number
 *     (an index, a count) -- `findRootEdgeIndex` legitimately does.
 *

 * 14. Why the section is only two polylines and two end faces
 *
 *     Everything about the section is decided in the web app
 *     (`symmetricProfile` in geometry.ts), which emits `profile` (outer) and
 *     `innerProfile` (bore) already carrying:
 *
 *       - the axis clipping where a wall is thicker than the local radius, so
 *         `innerForeNegative` / `innerAftNegative` and the intercept points are
 *         no longer needed on this side;
 *       - the solid case as two points on the axis (`innerIsAxis`).
 *
 *     Shoulders used to be in this list too, as bridging discs/annuli and a
 *     bore step.  They are not any more -- see note 18.
 *
 *     That is why this function no longer branches on `thickness`, `filled` or
 *     the shape: those cases used to be decided here, each with its own way of
 *     closing the section, and they disagreed with each other.  The quad
 *     shortcut for plain cones is gone for the same reason -- it cannot carry a
 *     shoulder, a wall or a cap, and the web app already emits a two-point
 *     profile for a cone.
 *
 *     The two end faces do the closing: on a solid they span the full radius
 *     and are the caps; on a walled component they span only the wall, leaving
 *     the bore open.
 *

 * 15. Why a missing bore is reported instead of fatal
 *
 *     `sketchProfile` is typed, so `convertProfilePoints(params.innerProfile, …)`
 *     is a compile error the moment `innerProfile` is absent — it does not
 *     degrade to undefined at runtime.  A JSON from an older web app trips that,
 *     because that build emitted `profile` for every shape but only emitted
 *     `innerProfile` for non-conical, unfilled, walled components.
 *
 *     So the presence of the bore is checked first.  Missing means the payload is
 *     stale: the section is drawn solid and a line is printed naming the
 *     component, rather than one out-of-date JSON killing the whole
 *     regeneration.  The same guard covers a missing `profile`, which would
 *     leave nothing to draw at all.
 *
 *     This is deliberately a fallback, not a supported input.  Regenerating the
 *     JSON with the current web app removes the message and brings back the
 *     bore, the shoulders and the caps.
 *

 * 16. Why a coincident end face is skipped
 *
 *     The two end faces close the section.  Where the outer surface and the bore
 *     already MEET there is nothing to close -- a solid nose cone's tip is on
 *     the axis, and the component's own end can sit where the bore reaches it.
 *     Drawing a segment between two coincident points makes a zero-length curve,
 *     which is degenerate geometry, and the revolve of the whole section then
 *     fails with REVOLVE_FAILED even though the profile itself is fine.
 *
 *     So each end face is drawn only when its two points actually differ.  This
 *     is the same "skip a degenerate size" rule as elsewhere in the file, and it
 *     is why a solid and a walled section can share one code path.
 *

 * 17. Why a section that reaches the axis used to be reported
 *
 *     A solid nose cone's tip is ON the rocket axis, and a solid section runs
 *     along the axis for a segment before closing.  That is the one section shape
 *     whose failure mode is invisible in the sketch: the profile and the region
 *     both look correct, and only the revolve refuses.  A `[section]` println
 *     reporting the minimum radius used to separate "the revolve rejected a
 *     solid section" from "the profile is actually wrong".
 *
 *     That instrumentation is now removed.  It narrowed the failure down but
 *     could not fix it: the profile was never wrong.  See note 18 for what
 *     actually did, and re-add the equivalent print if a revolve ever fails
 *     again -- it is two lines.
 *

 * 18. Why shoulders are revolved separately and unioned on
 *
 *     Shoulders used to be folded into the component's own meridian section
 *     (`profile` / `innerProfile`), as bridging discs/annuli and a bore step at
 *     the component's end plane.  That section is geometrically correct and the
 *     revolve refused it anyway, with REVOLVE_FAILED, on every component whose
 *     region runs ALONG the axis -- i.e. every solid one.  Three hypotheses for
 *     the cause were formed and disproved in a row; the profile was never the
 *     problem, and neither was the sketch: each one solved to exactly one face.
 *
 *     The fix is structural rather than numerical.  A shoulder is now its own
 *     small closed polygon -- `shoulderProfile(params, 'fore' | 'aft')` in
 *     geometry.ts, drawn by `sketchShoulder` above -- revolved on its own about
 *     the same axis and boolean-unioned onto the body (see `unionShoulders` in
 *     main.fs, note 10).  The body is left with exactly the section it had
 *     before shoulders existed, which is the well-trodden path.
 *
 *     The connector step matters and must stay in the polygon.  A shoulder's
 *     radius routinely differs from the body's end radius, so the outline runs
 *     in or out to the body's own end radius at the body's end plane, and the
 *     bore steps to the body's bore there to match.  That flat annulus is the
 *     face the two bodies share, so the union has something to match on, and it
 *     is what keeps the shoulder's wall thickness its own rather than jumping
 *     to the body's.
 *
 *     BECAUSE that step is a flat face the union depends on, a shoulder's
 *     meridian is drawn with `skPolyline` and never `skFitSpline`.  A shoulder's
 *     meridian is a polygon -- a straight cylindrical wall, a flat step, a flat
 *     cap -- with right angles between them and no curve anywhere, so a fitted
 *     spline is both a lie and a hazard: it rounds the connector step off, and
 *     then the shoulder has nothing to butt against.  `drawOutline` is for the
 *     body's genuinely curved outline only.
 *
 *     A solid shoulder is the one polygon here that still runs along the axis.
 *     It has to: a solid cylinder revolved from a section that reaches the axis
 *     is the normal way to make one, and the same is true of the solid body it
 *     is unioned onto.  What changed is that the two are now SEPARATE revolves,
 *     so neither one's axis edge is a property of a long, kinked section that
 *     also has to carry a shoulder.
 *
 * 19. Why a tip on the axis is closed with a LINE, not a spline
 *
 *     A solid component's section reaches the rocket axis at exactly ONE point
 *     -- a nose cone's tip -- and a region that meets the axis at a single
 *     point, with a near-zero included angle between the spline and the axis
 *     there, is the shape the revolve refuses.  Measured on the Bell X-1 nose
 *     cone: the outer profile is 51 points whose first is exactly `[0, L]`, the
 *     bore is the 2-point axis line `[[0, L], [0, 0]]`, and the two meet at that
 *     one shared vertex.
 *
 *     Fitting a spline THROUGH that point is the problem, not the point itself:
 *     the fitted curve's tangent there is almost parallel to the axis, which is
 *     what makes the included angle degenerate.  So the tip is closed by an
 *     explicit straight segment from the axis out to the first point genuinely
 *     off it, and the spline is fitted from that point aft.  The contact with
 *     the axis is then a segment, not a vertex.
 *
 *     This is deliberately NOT a change to the web app's profile.  The profile
 *     is correct: the tip of a solid nose cone is geometrically a point, and any
 *     faithful profile puts it at r = 0.  The pre-shoulder code got away with it
 *     only because the `filled` branch drew the axis as a separate
 *     `left_line` and the outer surface separately, so no spline was ever fitted
 *     through the shared vertex.  Reverting the profile would not have helped
 *     and would have undone the auto-fore-radius work that the transition -- the
 *     component that revolves perfectly well -- depends on.
 *
 *     `firstOffAxisIndex` returns 0 for every component that does not start on
 *     the axis, so those are still fitted through whole and are unchanged.
 *
 *     It is the SAME defect on either curve, which the `[revolve]` diagnostics
 *     settled once the try/catch let the whole rocket build.  Bell X-1, before
 *     and after the tip fix:
 *
 *       - nose cone   outer on axis, bore = 2-point axis line  -> fixed
 *       - transition  outer clear, bore CLIPPED onto the axis  -> still failed
 *
 *     The failing transition is thin-walled (2 mm) and narrow at its fore end
 *     (1.143 mm), so `innerNoseTransitionProfile` clips its bore onto the axis
 *     there: 49 bore points whose FIRST is exactly `[0, 0.127]`, with no axis
 *     point in the outer profile at all.  So the axis contact is on the BORE,
 *     not the outer, and it needed the same straight-segment closure.
 *
 *     Hence `drawOutline`, which both curves go through: it closes a leading OR a
 *     trailing run of axis points with straight segments and fits the spline
 *     only over what is genuinely off the axis, at either end.  Both ends matter
 *     -- a component narrow enough at both ends clips its bore at both.
 *
 *     The run must be drawn in FULL, point by point, and not as a single segment
 *     from the outermost axis point to the first off-axis point.  A bore that
 *     dies out partway carries two axis points -- the end plane's own, and the
 *     intercept where the curve really leaves the axis -- and joining the
 *     outermost pair cuts the corner: the curve appears to stop early and run
 *     straight to the top, and the intercept is discarded along with the solid
 *     length it bounds.  `drawAxisRun` draws every point of the run, and skips it
 *     entirely when the run is a single point, because `skPolyline` requires
 *     more than one and a one-point polyline is a degenerate curve.
 *
 *     And the spline must START at the intercept, not at the first off-axis
 *     sample.  Those are different points, and starting one sample later leaves
 *     the axis run ending at the intercept with the curve beginning one point
 *     beyond it and nothing drawn between: the outline is not closed.  Sharing the
 *     intercept between the run and the spline is what makes the region closed.
 *

 * 20. Why a zero packed length draws nothing at all
 *
 *     `Bell X-1` contains a mass component named "screw  eye (SE-1)" with
 *     `<packedlength>0.0</packedlength>` and a 12.5 mm radius.  It is a mass
 *     marker with no axial extent, and OpenRocket's `MassObject.getLength()`
 *     returns that zero unchanged -- OpenRocket renders no solid for it.
 *
 *     The web app used to clamp an exactly-zero `packedLength` to 1e-9 "so
 *     feature creation still succeeds".  That fabricated a 1 nm tall, 12.5 mm
 *     wide meridian section, and the revolve of it failed with
 *     REVOLVE_FAILED.  The clamp did not prevent a degenerate feature, it
 *     CREATED one -- and 1e-9 m is exactly `MIN_SEGMENT_LENGTH`, the same
 *     threshold this file uses elsewhere to decide a segment does not exist.
 *
 *     So the zero is left alone on the web-app side and honoured here: no
 *     section, no region, no body.  `createComponents` completes a component
 *     with an undefined face without complaint (notes 4), and the mass still
 *     counts, because it comes from `params.mass` rather than from geometry.
 *
 *     This is a different failure from the shoulder/solid-nose-cone one in
 *     note 18, and the stack trace is what told them apart: the failing call
 *     passed through `createComponents`' recursive child call, so the component
 *     was a CHILD (a mass component inside a body tube), not the top-level nose
 *     cone the original report named.  See main.fs notes 20, 21.
 *
 * 21. Raw payload numbers are not quantities
 *
 *     This is the trap that cost the most time while chasing the revolve above,
 *     because it is invisible to every check available outside Onshape: balanced
 *     braces, unused declarations and a grep all pass, and the web app's own
 *     tests are in a different language entirely.
 *
 *     A component's params arrive as RAW numbers -- `params.packedLength` is
 *     `0.0508`, not a length -- and the `* units` scaling happens here, on the
 *     FeatureScript side.  Anything that scales a point with
 *     `convertProfilePoints(…, units)` produces a real length; anything reading
 *     `params` directly does not.
 *
 *     So a helper that takes scaled points may work in `ValueWithUnits`, while
 *     one that takes raw points must not:
 *
 *       - `minRadiusOf` (main.fs) seeds with a bare `1` and returns `number`.
 *         Seeding it with `1 * meter` mixes a quantity with a number and fails
 *         to compile.
 *       - `packedCanisterSketch` above tests `packedLength <= 1e-9`, not
 *         `packedLength <= MIN_SEGMENT_LENGTH`, for the same reason:
 *         `annulusSketch` declares its length as `is number` and applies
 *         `units` itself.  `MIN_SEGMENT_LENGTH` is a quantity, and is correct
 *         only where both sides of a comparison are quantities -- which is why
 *         the four `norm(...) > MIN_SEGMENT_LENGTH` guards in this file are fine:
 *         `norm` of two scaled points is a length.
 *
 *     The tell in both cases: a `const` in this file is declared `1e-9 * meter`
 *     or not at all, never a mix.  When adding a helper that reads `params`
 *     directly, check what the value actually is before reaching for a
 *     quantity.
 * 22. Why a fin tab's top edge is the PROJECTION, and nothing else
 *
 *     A tab is the only part of a fin lying INBOARD of the parent's surface: it
 *     passes through a slot in the body.  It therefore has to be shaped by that
 *     surface, and the surface is exactly what the fin root was snapped to but
 *     is generally not straight -- a nose cone or transition curves away under
 *     the fin, while the design's root chord is a straight line.
 *
 *     Drawing the tab as a rectangle at the fore root radius, which is the
 *     obvious thing to do, runs OUTSIDE the body for the rest of its length on
 *     such a parent, and the union then hangs a flange of tab off the side of
 *     the rocket.  So the top edge is left out of the drawn shape and supplied
 *     from the parent instead: three straight sides hanging inward, plus
 *     `projectEdgeIntoSketch`.  The "stretched U".
 *
 *     Four things about that top edge are counter-intuitive, and each of them
 *     cost a round of regens.
 *
 *     PROJECTED, not fitted.  For two whole rounds this edge was built by
 *     sampling the parent edge and refitting -- an `skLineSegment` for a
 *     straight parent, an `skFitSpline` through the in-span samples for a curved
 *     one.  Both were wrong, and the visible symptom was a straight line
 *     running along the tab where the surface should have been: the fitted edge
 *     is a DUPLICATE of geometry the projection already provides, and for a
 *     curved parent a refit is a second, worse approximation of a curve Onshape
 *     can hand over exactly.  `projectEdgeIntoSketch` is the same call the fin
 *     root uses, it is already written, and it is exact.
 *
 *     WHOLE, not bounded to the tab.  A "use" constraint draws the ENTIRE
 *     source edge, so a projected body wall runs the length of the tube and
 *     past the tab at both ends.  That reads as the bug and is not: the region
 *     closes where the two radial sides CROSS the curve, and the tails outside
 *     the tab bound nothing.  The fin's own root is projected the same way, on
 *     the same kind of edge, and the log shows it forming one face every time.
 *     An earlier pass mis-diagnosed the overshoot as the cause of a missing
 *     face and "fixed" it by clipping the curve, which is what put the straight
 *     line in the sketch in the first place.  Do not clip.
 *
 *     ONE curve, not a chain.  `drawSnappedFinOutline` walks a chain of curves
 *     because a fin root is allowed to outrun its parent (notes 2, 3, 5).  A tab
 *     is not -- OpenRocket's `validateFinTabPosition` / `validateFinTabLength`
 *     keep it inside the root chord -- so it lies on one run of surface, and
 *     `surfaceUnderSpan` insists on a single curve matching at BOTH ends.
 *     Requiring both ends is also what tells the body's bore from its outer
 *     wall: a bore within SNAP_TOLERANCE of the root is not disqualified on
 *     distance alone, it just loses, because it is further off than the wall at
 *     both ends.  A chain would also admit a second edge and leave two where one
 *     belongs.
 *
 *     NOTHING ELSE ALONG IT.  No straight run parallel to the root, no corner
 *     radius, no bridge out to the tab's ends.  The projection is the whole top
 *     edge, and the corners are square because the design says so.
 *
 *     The inner edge takes the SMALLER of the two radii at which the surface
 *     passes the tab's ends, less tabHeight -- OpenRocket's own rule, from
 *     `getTabPoints()`: `yTabBottom = min(yTabFront, yTabTrail) - tabHeight`.
 *     That is what stops the tab escaping the other way, and on a tapering body
 *     it ends up slightly deeper at the fore end rather than shallower at the
 *     aft, so it is never thinner than the slot it has to fill.  It has a
 *     consequence worth stating because it is the invariant to check: the
 *     SHORTER of the two radial sides is then exactly `tabHeight`, whichever way
 *     the surface runs.  On a body tube the two ends are equal and it is
 *     simply `offsetRadius - tabHeight`.
 *
 *     What replaced the bridges.  A pass read "the curve covers the tab and
 *     keeps going" as needing a continuation to the tab's real ends, and drew
 *     `tabBridge` per side -- which made the U into a C.  The
 *     reading was wrong in both directions: the projected curve is not
 *     truncated, so there is no gap for a bridge to close, and the curve's own
 *     ends are the tube's ends, not the tab's.  If a fin root genuinely outruns
 *     its parent, the parent edge stops and the tab has no surface to follow --
 *     draw no tab rather than inventing a continuation.  No corpus file
 *     exercises that, so it is an open question, not a solved one.
 *
 *     Note 25's overlap still applies and is the reason the two top corners are
 *     pushed OUTWARD, radially into the fin, by `overlap`: a tab drawn exactly
 *     on the surface would share only a coincident face with the fin, and the
 *     UNION would return no body.  How the corner is held while it is held OFF
 *     the surface is note 24.
 *
 *     This is the same reason shoulders are not folded into the body's meridian
 *     section (note 18), one level up: a feature that has to meet the parent
 *     along a curve is easier to get right, and to keep debuggable, as its own
 *     body unioned on afterwards.  A tab cannot even be drawn in the fin's own
 *     sketch, for a further reason: it shares its outer edge with the root
 *     chord, so the two regions would touch or overlap, and `createComponents`
 *     keeps only `qSketchRegion(sketchId)[0]` anyway.
 *
 * 23. Why a fin cross-section is INTERSECTED in, not swept along the outline
 *
 *     A fin's cross-section is the shape of its thickness as seen edge-on: a
 *     rectangle, that rectangle with its leading and trailing edges radiused, or
 *     a symmetric airfoil.  Until this note it was parsed and then ignored --
 *     every fin was a flat plate of constant thickness, whatever
 *     `crosssection` said.
 *
 *     What upstream actually defines is worth being precise about, because it is
 *     less than the name suggests.  `FinSet.CrossSection` is an enum of three
 *     names and three volume ratios -- 1.00, 0.99, 0.85 -- and those ratios are
 *     the ONLY place the value is read: `calculateCM()` multiplies the planform
 *     volume by `getRelativeVolume()`.  There is no airfoil geometry anywhere in
 *     OpenRocket, and its own 3D exporters (FinSetExporter, the wavefront/OBJ
 *     path) hand the polygon straight to `addPolygonMesh` and draw a plate.  So
 *     there was no profile to copy, and the shapes below are a choice.
 *
 *     The web app applies the three ratios, which is exact and matches upstream.
 *     The geometry is our own: a stadium for `rounded`, and for `airfoil` the
 *     standard NACA four-digit thickness series, scaled so its maximum is the
 *     fin's own thickness and closed at the trailing edge by the 0.1036
 *     coefficient.  Both are symmetric about the mid-surface, so the fin sits
 *     where the old +/-thickness/2 extrude put it.
 *
 *     The construction is the part with a real constraint behind it.  A section
 *     is a varying profile, and `opSweep` carries ONE constant profile along its
 *     path -- so sweeping the section round the planform outline, which is the
 *     obvious reading of "sweep a profile", would give a trapezoidal fin a tip
 *     with the root's chord and would skew a freeform one.  Instead the section
 *     is drawn in a plane normal to the span and extruded radially into a prism
 *     longer than the fin, and then INTERSECTED with a slab of the planform.  The
 *     intersect does not care what shape the planform is, so one construction is
 *     exact for all three fin types and reuses the very region the square path
 *     already extrudes.
 *
 *     The square path is deliberately untouched -- same single symmetric extrude
 *     as before.  It is the default, it is what all six test rockets use, and it
 *     is the one path in this file known to work; putting it through a new
 *     boolean would trade a proven result for an unproven one.  The two shaped
 *     sections are new code on a new code path, and every step of it is guarded
 *     with a fallback to that same plate, so the worst case is a fin that keeps
 *     its square section rather than a fin that disappears.
 *
 * 24. Why a tab's top corner is a FIXED POINT, and what holds it to the surface
 *
 *     Note 22 requires the top edge to be the projection, and note 25 requires
 *     the corners to be pushed `overlap` OUTWARD off it.  Those two requirements
 *     pull in opposite directions, and every arrangement tried here asked ONE
 *     point to be two different places.  Two of them failed in ways worth
 *     recording, because both produce correct-looking geometry and are wrong
 *     only under measurement.
 *
 *     THE CORNER ON THE PROJECTION, PINNED BY AN UNSIGNED DISTANCE.  This is the
 *     fin root's arrangement copied across: COINCIDENT(corner, tabSurface) to put
 *     it on the curve, then a `DISTANCE` of `abs(cornerV)` from a fixed point on
 *     the x-axis to pin its axial coordinate.  The distance is the defect.  A
 *     FeatureScript dimension is UNSIGNED, so `abs(y)` is satisfied equally well
 *     by `-y`, and the two solutions are indistinguishable to the constraint.
 *
 *     That is harmless while the corner's station is negative and fatal once it
 *     is positive, and a positive station is ORDINARY rather than exotic: any tab
 *     longer than its own root chord centred on the chord has both ends outboard
 *     of the leading and trailing edges, so the fore corner's `y` goes positive.
 *     The solver then takes the mirror, and the tab is drawn at `-y`.
 *
 *     A regen of a two-stage test rocket showed it on both fin sets.  The log
 *     asks for a freeform tab whose fore end sits 5.25 mm AHEAD of the fin's
 *     leading edge -- the tab is 100 mm long on an 83.5 mm chord -- and reports
 *     the solved inner edge running from `y = -0.00525`, mirrored exactly, with
 *     the aft bridge following it.  Read against the `[tab] asked for:` line the
 *     fore end had moved about 10.5 mm, and the tab's whole 100 mm length with
 *     it: the shape was drawn where the design did not put it, by roughly the
 *     15 mm the model was seen to be out.
 *
 *     Pinning the RADIUS instead is not a way out.  On a body tube every station
 *     shares one radius, so the mirror is exactly as valid there and the corner
 *     slides freely -- which is what "pinning the radius over-constrains and
 *     upsets the region solver" was really about: it did not constrain at all.
 *
 *     THE CORNER OFFSET AND STILL ON THE PROJECTION.  Satisfying note 22 and note
 *     25 in one point is a contradiction the solver has to resolve somehow, and
 *     it resolved it by dragging the PROJECTION.  One regen logged `tabSurface`
 *     coming back at r = 0.02326 on a body whose surface is at r = 0.02076: the
 *     projection had been pulled 2.5 mm out to meet the corner, so the tab's top
 *     edge was no longer the parent's surface at all.  Everything downstream --
 *     the region, the tab's fit in its slot -- was then being computed against a
 *     curve that was never there.
 *
 *     THE RISER, which separates the two jobs.  A tab's corner is now a FIXED
 *     point: the axial station, and with it the tab's position along the rocket,
 *     is pinned outright and no signed or unsigned quantity appears anywhere in
 *     the arrangement.  Where note 25's `overlap` holds the corner off the
 *     surface, a short radial RISER is drawn from the corner down to the
 *     projection, and it is the RISER'S INNER END that lies on the curve -- by
 *     COINCIDENT to `tabSurface`, plus HORIZONTAL to the fixed corner.  The
 *     projection therefore still lies exactly where the parent is, and the
 *     overlap is a separate, purely radial jog.  The region closes on the
 *     projected curve between the two risers, exactly as it did before.
 *
 *     HORIZONTAL is a relation BETWEEN TWO POINTS, so the station is inherited
 *     from a fixed point and cannot flip sign; that is what makes this immune to
 *     the mirror, and it is also why the fin root's own arrangement is sound.
 *     Where a corner carries no overlap -- it sits past the end of the fin, where
 *     there is no material to interpenetrate with -- corner and surface point are
 *     the same place, so the corner is left free on the curve and held only by
 *     the HORIZONTAL.  That is one equation each on a two-DOF point, so nothing
 *     is over-constrained.  A BRIDGED corner gets no riser at all, being past the
 *     end of the curve where there is no surface to hang one off; the bridge is
 *     its top edge instead.
 *
 *     The U's own vertex is tied to the corner by a point-to-point COINCIDENT, so
 *     the vertex is a slave of the corner and adds no equation of its own.  Note
 *     that the corners cannot be left to their own coordinates: they and the
 *     projected curve are drawn through the same measured points, but "drawn
 *     through" is not "joined", and the solver moves both freely.
 *
 * 25. Why a union of two solids that merely TOUCH produces no body at all
 *
 *     This is the lesson from the first real regen of note 22's tab, and it cost
 *     the whole feature.  Every fin in the log came back
 *
 *       [tab] Freeform Fin Set (freeformfinset) union produced no body
 *              -- keeping the fin alone
 *
 *     with a perfectly good tab sitting in the sketch beside it.  A tab drawn
 *     exactly ON the surface shares nothing with the fin but one coincident face,
 *     and `opBoolean` with `operationType : UNION` over two solids that meet
 *     face-to-face and nowhere else returns no body.  The boolean is not failing --
 *     it is declining -- and the guard built around it then quietly kept the fin,
 *     so the tab simply never appeared.
 *
 *     The fix is to make the two solids INTERPENETRATE: the tab's two top
 *     corners are offset outward, radially away from the axis and so into the
 *     fin, by `overlap` -- a quarter of the tab height, capped at the fin's
 *     thickness.  The offset is buried inside the fin, so nothing about the
 *     finished part changes, but the boolean now has a volume to work with.
 *
 *     This is the one thing the overlap must NOT be traded away for, and it is
 *     why the tab's top edge is a PROJECTION rather than a curve the tab owns:
 *     a corner constrained to lie exactly ON the projected surface is, by
 *     construction, a corner that cannot be offset, and the union goes back to
 *     producing no body.  The overlap and the on-curve constraint are mutually
 *     exclusive; sketchFinTab keeps the overlap and lets the region close on
 *     the crossings instead.
 *
 *     The same failure is in the same log, on the same mechanism, for the
 *     shoulders:
 *
 *       [shoulder] Nose Cone (nosecone) aft shoulder union produced no body
 *                  -- keeping the body alone
 *
 *     on every nose cone and transition in the rocket.  A shoulder is revolved from
 *     a polygon in the SAME meridian plane as the body, with its outer wall lying
 *     in the component's end plane, so it meets the body the same face-to-face way.
 *     The audit called that path never exercised; the log shows it is not merely
 *     unexercised but broken, and it needs the same treatment.  It is left alone
 *     here because the tab was what was asked for, and how far a shoulder should be
 *     buried in its component is a separate decision.
 *
 *     The general rule for this file: anything unioned onto another body has to
 *     CROSS a face, not merely touch it.  A boolean that returns no body is almost
 *     always this, rather than a geometry error.
 *
 * 26. Why a zero wall is a SOLID, not an absence
 *
 *     `tubeWallSketch` used to treat `wall <= 0` as "nothing to draw" and return.
 *     For a wall of exactly zero that is wrong, and not by a small margin.
 *
 *     A body tube with `thickness == outerRadius` has an inner radius of zero:
 *     it is a solid rod, not a tube.  OpenRocket renders it as a solid, and so
 *     must this.  A designer writes one deliberately all the time -- a fin
 *     spike, a rod, a standoff -- and the log for one was:
 *
 *         [wall] wall is 0 (outerRadius 0.00119 minus thickness 0.00119)
 *                -- no section drawn
 *         [asm] Fin Spikes (bodytube) produced NO body
 *         [asm] Fin Spike Pod Set (podset) pattern produced no bodies
 *
 *     The last two lines are the point.  A body tube used as a fin spike is
 *     typically the ONLY child of a pod set, and a pod set has no body of its own
 *     (main.fs note 3), so losing the tube leaves the pod set with nothing to
 *     pattern -- and `opPattern` on an empty set throws
 *     `CANNOT_RESOLVE_ENTITIES`, which aborted the rest of the build.  A missing
 *     solid rod three components deep became a truncated rocket.
 *
 *     The fix is to draw the section the shape actually calls for: a rectangle
 *     from the axis out to `outerRadius`, with its inner edge lying ON the revolve
 *     axis.  That is the same four segments `annulusSketch` draws for
 *     `innerRadius == 0`, written out inline because both that function and
 *     `sketchQuadrilateral` are defined further down this file.
 *
 *     The diagnostic is kept and its wording changed to match: it now says the
 *     solid section was DRAWN, because a log line reading "no section drawn" next
 *     to a body that then turns up in the model is exactly the kind of
 *     contradiction that costs an afternoon.
 *
 *
 * 27. Why `DEBUG_FIN_SNAP` exists, and what the closed-polyline branch hides
 *
 *     The `[finroot]` lines exist to answer one question that no amount of
 *     reading the code answers: which parent curve the fin ROOT picked, and by
 *     which code path.  The tab is supposed to follow the same surface by the
 *     same call, so those lines are the reference the `[tab]` lines are read
 *     against.
 *
 *     The `path=` line matters more than it looks, and it is the reason the flag
 *     is worth its output.  On a STRAIGHT parent -- a body tube, which is every
 *     corpus rocket that has a tab -- `drawSnappedFinOutline` takes the
 *     closed-polyline branch and returns before `projectEdgeIntoSketch` is ever
 *     called.  The root is a closed polyline whose end points were merely SLID
 *     onto the surface radius.  So on a tube the fin root does NOT project, and
 *     the tab's projection has no working precedent in this codebase to be
 *     compared against.
 *
 *     The consequence is a trap for anyone reasoning from the code alone:
 *     "the fin does it, so the tab can too" is reasoning from a path that does
 *     not run.  An earlier version of note 22 said the tab's ordering was "the
 *     same one `drawSnappedFinOutline` already uses successfully", which was
 *     wrong for exactly this reason.  Check the `path=` line before trusting any
 *     comparison between the two.
 *
 * 28. Why the tab's top corners are CONSTRAINED, not merely placed
 *
 *     An earlier note claimed `skPolyline` with `"constrained" : true` "fixes all
 *     four of its points -- 8 equations for 8 degrees of freedom", and concluded
 *     from that the corner constraints were redundant and must be left off.
 *     That reading of the flag is wrong.
 *
 *     `sketch.fs` documents it as "true if constraints should be created", and
 *     what it creates is CHAINING: the consecutive segments are tied together so
 *     their shared endpoints cannot drift apart.  The points themselves stay
 *     free.  So the corner constraints were never redundant -- they were simply
 *     missing.
 *
 *     The visible consequence was that the tab's top corners only ever LOOKED
 *     attached to the projection: placed at measured coordinates, free to move,
 *     and not joined to anything.  Where they drifted off the curve the region
 *     could not close.  Both top corners now carry the same COINCIDENT plus
 *     axial pin that the fin root uses (note 24).
 *
 * 29. Why a tab's bridge radius is the inner radius plus one tab height
 *
 *     `innerRadius` is OpenRocket's own rule: the smallest of the two end radii
 *     minus `tabHeight` (`FinSet.getTabPoints`, `yTabBottom = min(yTabFront,
 *     yTabTrail) - tabHeight`).  So `innerRadius + tabHeight` is exactly that
 *     smallest end radius, and a bridge drawn there is HORIZONTAL BY
 *     CONSTRUCTION -- parallel to the root chord -- with no extra rule of its
 *     own.  Get the root offset right and the bridge falls out horizontal.
 *
 *     An earlier version added `overlap` to a bridged corner as well, which was
 *     wrong twice over.  The bridge runs PAST the end of the fin, so there is no
 *     fin there to overlap with; and adding the overlap tilted the bridge off
 *     horizontal while stretching the tab's radial side, breaking the very
 *     invariant the radius rule exists to preserve.  Both showed up in one regen:
 *
 *         bridge  r = 0.015000 -> 0.017750    not horizontal
 *         aft side 0.01375  vs  tabHeight 0.011
 *
 *     The overlap is therefore applied ONLY where the corner is actually over
 *     the fin, which is what gives `opBoolean` UNION material to work with
 *     (note 25).  A bridged corner sits past the fin's end and needs none.
 *
 * 30. Why the overlap is applied per corner, and never to a bridged one
 *
 *     The overlap only means anything where there IS a fin to overlap with.  The
 *     fin's root chord runs from its leading edge at y = 0 aft to y = -chord, so
 *     a tab allowed to be longer than its fin pokes out past one or both ends,
 *     and out there the corner has nothing behind it: the overlap becomes a stub
 *     of drawn curve hanging in space, outside the region and visibly not
 *     attached to anything.  One regen showed exactly that, the fore radial
 *     reaching r = 0.02342 against a surface at 0.02067, with the fin's body not
 *     starting until y = 0.  So the overlap is applied per corner, and only
 *     inside the chord.
 *
 *     A BRIDGED corner never gets the overlap, however far inside the chord it
 *     falls.  The bridge runs from the surface's end to the corner, so overlap
 *     on the corner tilts the bridge off horizontal -- the one thing a bridge
 *     must not be -- and there is no surface under the corner to overlap with
 *     anyway.
 *
 * 31. Why the top edge is real geometry again, and is projected first
 *
 *     An earlier version closed the U with a hand-drawn segment at the overlapped
 *     radius and made the projection CONSTRUCTION geometry.  That fixes the
 *     union but loses the shape: the tab's top no longer follows the parent,
 *     which is the whole point on a curved or tapered parent.  So the projection
 *     is REAL geometry again and bounds the tab exactly where the parent
 *     actually is, and the overhang past the parent's end is closed by a bridge
 *     at constant radius (note 29).
 *
 *     The overlap survives on two short RISERS -- radial segments from the
 *     surface out to the corners -- which cross into the fin.  That is enough to
 *     give `opBoolean` UNION real material (note 25) without displacing the top
 *     edge from the surface.
 *
 *     PROJECTED BEFORE THE POLYLINE IS DRAWN, and off a robust query.
 *     `surface["edge"]["edgeQuery"]` is captured by `collectSnapEdges` before
 *     anything is created here, and `skPolyline` is itself an operation on the
 *     part.  Consuming a query after an operation has intervened can leave it
 *     stale, and a stale edge projects as a stub rather than as the parent's
 *     profile -- which is exactly what the tab was doing.  `makeRobustQuery`
 *     pins the edge, and projecting first means no operation intervenes.
 *
 *     The projection is deliberately NOT truncated to the tab's span: a "use"
 *     constraint draws the ENTIRE source edge, so it runs the length of a body
 *     wall and past the tab at both ends.  Where it runs past the tab's own end
 *     that tail IS the overhang and the bridge picks up from it; where the tab
 *     is wholly inside, the tails are harmless because the region closes on the
 *     two crossings (note 22).  Do not clip it.
 *
 * 32. Why `surfaceUnderSpan` takes ONE curve and selects on COVERAGE
 *
 *     One curve where a fin root takes a chain.  A root is allowed to outrun its
 *     parent, so `drawSnappedFinOutline` walks a chain (notes 2, 3, 5).  A tab is
 *     not: `validateFinTabPosition()` and `validateFinTabLength()` keep it inside
 *     the root chord, so the whole tab lies on one run of surface.  Requiring a
 *     single curve to match at BOTH ends is also what keeps one edge in the tab's
 *     sketch, and what tells the body's bore from its outer wall -- a bore
 *     within SNAP_TOLERANCE of the root loses here because it is further off at
 *     both ends than the wall is.
 *
 *     WHY COVERAGE, NOT A RADIUS MATCH.  An earlier version rejected any curve
 *     whose distance from the tab's two end GUESSES exceeded SNAP_TOLERANCE, and
 *     that is wrong on a tapering parent.  `offsetRadius` is one constant, true
 *     at the fin's root chord, but a 50 mm tab running down a transition that
 *     loses ~5.7 mm of radius showed a ~5.04 mm miss on the correct outer
 *     profile -- rejected by 0.04 mm -- in favour of a 10 mm sliver that happened
 *     to sit near the constant.  The tab then projected that sliver and the
 *     region could not close on it.
 *
 *     So the two end points are not radius-matched at all; they are AXIAL hints.
 *     What is required is that ONE curve spans the whole tab and that it is the
 *     OUTERMOST such curve, since a tab is glued to the outside and the bore is
 *     always inboard.  The radii used for the U are then measured on the chosen
 *     curve, which is exact on a taper.  The `[tab] CHOSE` line prints the
 *     winner's extent so this cannot recur silently.
 *
 * 33. Why `cos` and `sin` need a QUANTITY, not a bare number
 *
 *     std declares them as `cos(value is ValueWithUnits) returns number`
 *     (units.fs), so a bare number is a compile error: "Call cos(number) does not
 *     match cos(ValueWithUnits)".  Multiplying by `radian` converts to exactly the
 *     type the builtin wants, and `* radian` is a no-op on the value.
 *
 *     The angles here are built as plain numbers and given their unit only where
 *     the trig functions need one, so `PI` can stay a bare number.  This bit the
 *     airfoil path only: it never ran on a rocket with no airfoil fin, so the
 *     error was invisible until an airfoil section was actually built.
 *
 * 34. Why `tab.position` is a LENGTH, and all five AxialMethod cases are explicit
 *
 *     `position` is a LENGTH in metres, NOT a fraction of the chord.  The FinTab
 *     type in webapp/src/types.ts used to document it as "fraction along root
 *     chord [0..1]", which was wrong; that comment came from an older assumption
 *     that a tab could never be longer than its fin, and the assumption no
 *     longer holds.  OpenRocket's own `<tabposition>` has always held a length
 *     (`FinSet.getTabOffset()`) and nothing in the importer scales it, so
 *     `offset` is used directly.  It may legitimately be NEGATIVE: centring a tab
 *     longer than its chord pushes the start back past the fin's leading edge,
 *     and the Airstart example rocket ships exactly that (-0.0047625 on a 0.34036
 *     chord).
 *
 *     ALL FIVE of AxialMethod, each a DIFFERENT arithmetic expression, with
 *     innerLength the tab's length and outerLength the root chord:
 *
 *         ABSOLUTE   offset                          tip of the rocket
 *         AFTER      offset + outerLength            after the sibling component
 *         TOP        offset                          top of the parent
 *         MIDDLE     offset + (outer - inner) / 2    middle of the parent
 *         BOTTOM     offset + (outer - inner)        bottom of the parent
 *
 *     The previous version handled only top/middle/bottom and let anything else
 *     fall through to "top", so a tab set to "tip of the rocket" or "after the
 *     sibling component" was silently resolved as if it were "top" -- a wrong
 *     position with no warning anywhere.  Every branch is explicit now, and an
 *     unrecognised method is reported rather than guessed at.  ABSOLUTE and TOP
 *     are the same expression; they differ in what the offset is measured FROM,
 *     which the caller has already resolved, so both give `offset` here.
 *
 *     And the extent is NOT clamped, which reverses an earlier decision.
 *     OpenRocket validates the tab before storing it (FinSet.java):
 *     `validateFinTabPosition()` clamps tabPosition to [0, length], and
 *     `validateFinTabLength()` REDUCES tabLength by any overrun past the chord.
 *     Both are right for the UI and wrong here, in two separate ways:
 *
 *       - The length clamp silently shortened the tab.  The log showed a tab of
 *         exactly 0.0835 -- the fin's own root chord -- whatever the payload
 *         asked for, so the aft bridge stopped 13 mm short of where the tab
 *         really ended.
 *       - The position clamp forced `front >= 0`, pinning the tab's fore end to
 *         the fin's LEADING EDGE and pulling it back inside the surface, so the
 *         tab never overhung forwards and no fore bridge was ever drawn.
 *
 *     A tab IS allowed to be longer than its fin.  The overhang at either end is
 *     bridged at a constant radius by the caller (one `tabBridge` per side),
 *     which is exactly the horizontal line this shape calls for, so there is
 *     nothing to gain by truncating the tab to fit.
 *
 * 35. Why `reportTabSketchCurves` reads the sketch back
 *
 *     This is the probe the earlier rounds were missing.  Everything printed
 *     before it describes what the code ASKED for; it describes what came out,
 *     and the two together are the only way to tell the three candidate bugs
 *     apart:
 *
 *       - `tabSurface` missing or degenerate (length ~ 0) => the projection
 *         itself produced a stub, and the edge selection is irrelevant.
 *       - `tabSurface` present and long, but `finTab` clipped to it, or the
 *         region count is 0 => the projection is fine and the REGION is failing.
 *       - `tabSurface` long and correct, region 1, yet the solid is short => the
 *         fault is downstream in `unionFinTab`'s extrude/union.
 *
 *     It reads the sketch's edges back through `qCreatedBy(sketchId, EDGE)` --
 *     the sketch's own curves, which is what the region solver sees -- rather
 *     than re-deriving anything from the source edge, so it cannot be fooled by
 *     the same wrong assumption twice.  This is the "after-solve" half of the
 *     pair described in note 23 of main.fs.
 *
 * 36. Why the rail button's corner arc is shaped the way it is
 *
 *     The corner arc is what makes the profile close, and two things about it
 *     were wrong.
 *
 *     First, `cornerCenter` already carries `origin`, so advancing along the arc
 *     must NOT add `origin` a second time.  Doing so displaced the screw head by
 *     the whole mount offset.
 *
 *     Second, the arc has to actually LAND on the polyline's last point, which
 *     sits half the outer diameter below the axis.  So its minor radius is half
 *     the outer diameter rather than all of it, and it sweeps from the -y end of
 *     the minor axis (parameter 0.75) round to the +x end of the major axis
 *     (1.0).  Sweeping the other way leaves the arc on the far side of the axis
 *     and the profile open.
 *
 */
