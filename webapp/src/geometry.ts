/**
 * Derived geometry calculations for OpenRocket components.
 *
 * These values are NOT stored in the .ork file — they are computed from
 * the parsed parameters. Included:
 *  - Transition / nose cone profile reconstruction (all 6 shape types)
 *  - Trapezoid fin planform points
 *  - Elliptical fin planform points (OpenRocket's 31-point discretization)
 *  - Tube fin touching radius
 *  - Auto-radius resolution pass
 *  - Component mass / CG estimation
 */

import type {
  RocketJson,
  RocketComponent,
  SymmetricShape,
  SymmetricParams,
  Shoulder,
  ComponentType,
  Position,
  FinCrossSection,
} from './types';

/**
 * Fin cross-section as a fraction of the planform area x thickness.
 *
 * These are OpenRocket's own numbers, from `FinSet.CrossSection.getRelativeVolume()`
 * (FinSet.java:51-55), and they are the ONLY place OpenRocket uses the
 * cross-section: `calculateCM()` multiplies the planform volume by them, while
 * the 3D exporters draw every fin as a flat plate of constant thickness and
 * ignore the setting entirely.
 *
 * They are area ratios, so a rounded section costs 1% of the planform's volume
 * and an airfoil 15% -- a symmetric section is not the same shape as the
 * rectangle it replaces, and that difference is real mass.
 */
const FIN_CROSS_SECTION_VOLUME: Readonly<Record<FinCrossSection, number>> = {
  square: 1.0,
  rounded: 0.99,
  airfoil: 0.85,
};

/** The volume fraction for a fin's cross-section, defaulting to square. */
function finCrossSectionVolume(crossSection: unknown): number {
  if (typeof crossSection !== 'string') return FIN_CROSS_SECTION_VOLUME.square;
  return FIN_CROSS_SECTION_VOLUME[crossSection as FinCrossSection] ?? FIN_CROSS_SECTION_VOLUME.square;
}

// ---------- Transition / Nose Cone shapes ----------

/**
 * Compute the radius of a transition/nose cone profile at a given x position.
 * Ported from OpenRocket's Transition.Shape implementations.
 *
 * @param shape The shape type
 * @param x     Distance along the transition (0..length)
 * @param radius The aft radius
 * @param length The transition length
 * @param param  The shape parameter
 * @returns The radius at position x
 *
 * This is the *base* shape: radius 0 at x=0 growing to `radius` at x=length.
 * A non-zero fore radius, a narrowing direction and clipping are all applied by
 * the caller -- see {@link transitionRadiusAt}.
 */
export function transitionRadius(
  shape: SymmetricShape,
  x: number,
  radius: number,
  length: number,
  param: number
): number {
  if (x <= 0) return 0;
  if (x >= length) return radius;
  if (length <= 0) return radius;

  const r = Math.max(radius, 0);
  const L = Math.max(length, 1e-9);
  const p = param;

  let z = 0;
  switch (shape) {
    case 'conical':
      z = x * (r / L);
      break;

    case 'ogive': {
      // Ogive: profile is a segment of a circle. The shape parameter is the
      // fraction of an extended tangent ogive to use — param == 1 produces a
      // tangent ogive (smooth transition to the body tube at the aft end),
      // lower values produce secant ogives, and param == 0 degenerates to a
      // cone (linear). Ported from OpenRocket's
      // Transition.Shape.Ogive.getRadius. This computes the underlying 0→aft
      // base shape; a non-zero fore radius is applied by the caller the way
      // OpenRocket's Transition.getRadius does (including the mirror for a
      // narrowing transition), see transitionProfile.
      if (p < 1e-3) {
        // param ≈ 0 → conical (linear)
        z = x * (r / L);
        break;
      }
      // An ogive cannot be built when it is shorter than it is wide; OpenRocket
      // scales the axial coordinate instead (Transition.Shape.Ogive).
      let Lx = L;
      let xx = x;
      if (Lx < r) {
        xx = (xx * r) / Lx;
        Lx = r;
      }
      // Radius of the circle.  Algebraically identical to OpenRocket's
      //   sqrt(A) / (2·p·r),  A = (L² + r²)·((2−p)²L² + p²r²)
      // with the division hoisted inside the root so the radicand is visibly
      // non-negative.
      const R = Math.sqrt(
        (Lx * Lx + r * r) * ((2 - p) * (2 - p) * Lx * Lx + p * p * r * r) / (4 * p * p * r * r)
      );
      const Lc = Lx / p; // x-offset of the circle center
      const y0 = Math.sqrt(Math.max(R * R - Lc * Lc, 0));
      z = Math.sqrt(Math.max(R * R - (Lc - xx) * (Lc - xx), 0)) - y0;
      break;
    }

    case 'ellipsoid': {
      // Ellipsoid nose: the outer surface is a sphere of radius R scaled so the
      // fore tip is a point and the base is full radius. OpenRocket scales the
      // axial coordinate by radius/length (x' = x·r/L) and intersects the circle
      // of radius r:  z = sqrt(2·r·x' − x'²)  →  with t = x/L this is r·√(2t − t²).
      // This is a quarter-ellipse whose tip (x=0) is radius 0 and whose base
      // (x=L) is the full radius with a horizontal tangent — the correct
      // "forward" orientation. (The previous r·√(1 − t²) mirrored the shape and
      // put the wide end at the tip, so the first/last values looked swapped.)
      const t = x / L;
      z = r * Math.sqrt(2 * t - t * t);
      break;
    }

    case 'power': {
      // Power series: y = r * (x/L)^p
      const t = x / L;
      z = r * Math.pow(t, p);
      break;
    }

    case 'parabolic': {
      // Parabolic series: y = r * (2(x/L) - (x/L)²) * p + r * (x/L)²
      const t = x / L;
      z = r * (2 * t - t * t) * p + r * t * t * (1 - p);
      break;
    }

    case 'haack': {
      // Von Kármán / LV-Haack series
      const t = x / L;
      const theta = Math.acos(1 - 2 * t);
      z = (r / Math.sqrt(Math.PI)) * Math.sqrt(theta - Math.sin(2 * theta) / 2);
      break;
    }
  }

  // Clamp to valid range
  return Math.max(0, Math.min(z, r));
}

/**
 * Radius of a transition / nose cone at axial station `x`, measured from its
 * fore end.  This is the single implementation of OpenRocket's
 * `Transition.getRadius`, shared by {@link transitionProfile} and
 * {@link mountParentRadiusAt} so the two can never disagree.
 *
 * Two behaviours matter and are easy to get wrong:
 *
 *   - A *narrowing* transition (fore radius > aft radius) is evaluated by
 *     mirroring -- the station is flipped and the radii swapped -- so one
 *     widening formula serves both directions.  Interpolating linearly between
 *     the end radii instead gives the wrong curvature on narrowing transitions,
 *     which visibly inverts an ogive.
 *   - A *clipped* transition is not the small shape offset by the fore radius: it
 *     is the tail of a full shape, cut where that shape reaches the fore radius,
 *     so the curvature comes from a different (larger) profile entirely.
 */
function transitionRadiusAt(
  shape: SymmetricShape,
  x: number,
  foreRadius: number,
  aftRadius: number,
  length: number,
  param: number,
  shapeClipped: boolean
): number {
  if (x < 0) return Math.max(foreRadius, 0);
  if (x >= length) return Math.max(aftRadius, 0);

  let r1 = Math.max(foreRadius, 0);
  let r2 = Math.max(aftRadius, 0);
  if (r1 === r2) return r1;
  if (r1 > r2) {
    x = length - x;
    const swap = r1;
    r1 = r2;
    r2 = swap;
  }

  if (shapeClipped && r2 > 0 && length > 0) {
    const clipLength = solveClipLength(shape, r1, r2, length, param);
    return transitionRadius(shape, clipLength + x, r2, clipLength + length, param);
  }

  return r1 + transitionRadius(shape, x, r2 - r1, length, param);
}

/**
 * Discretize a transition/nose cone profile into a list of [x, y] points.
 *
 * Coordinate convention: **x = radius, y = distance along the rocket length**,
 * with the fore (front) end at **y+**. Specifically, the aft end sits at y = 0
 * and the fore end at y = length, so the rocket points "up" (fore-side is +y).
 * No rotation is expected downstream — the profile is already in this
 * left-handed axis system.
 *
 * @param shape The shape type
 * @param length The transition length
 * @param radius The aft radius
 * @param param The shape parameter
 * @param shapeClipped Whether the shape is clipped at the fore end
 * @param steps Number of sample points (default 50)
 * @param foreRadius The fore radius (default 0 — e.g. a nose cone tip)
 */
export function transitionProfile(
  shape: SymmetricShape,
  length: number,
  radius: number,
  param: number,
  shapeClipped = false,
  steps = 50,
  foreRadius = 0
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 = fore, 1 = aft
    const r = transitionRadiusAt(shape, t * length, foreRadius, radius, length, param, shapeClipped);
    points.push([r, length * (1 - t)]); // aft at y=0, fore at y=length
  }
  return points;
}

/**
 * Solve for the clip offset of a clipped transition: the x at which the base
 * shape, grown to `highR` over `clipLength + length`, first reaches `lowR`.
 *
 * Ported from OpenRocket's Transition.calculateClip, including its exponential
 * bracket search (the base shape is short relative to its radius, so the
 * solution can sit beyond `length`) and its 0.1 mm convergence tolerance.
 */
function solveClipLength(
  shape: SymmetricShape,
  lowR: number,
  highR: number,
  length: number,
  param: number
): number {
  const CLIP_PRECISION = 0.0001;

  if (lowR <= 0 || length <= 0) {
    return 0;
  }

  // Bracket the root, doubling the upper bound if the shape is still short of
  // lowR there (up to OpenRocket's 10 doublings).
  let min = 0;
  let max = length;
  let n = 0;
  while (transitionRadius(shape, max, highR, max + length, param) - lowR < 0) {
    min = max;
    max *= 2;
    n += 1;
    if (n > 10) {
      break;
    }
  }

  for (let i = 0; i < 100; i += 1) {
    const mid = (min + max) / 2;
    if (max - min < CLIP_PRECISION) {
      return mid;
    }
    if (transitionRadius(shape, mid, highR, mid + length, param) - lowR > 0) {
      max = mid;
    } else {
      min = mid;
    }
  }
  return (min + max) / 2;
}

/**
 * Generate the inner (wall) profile of a curved nose cone / transition by
 * offsetting each outer profile point toward the axial center (r = 0) by the
 * shell wall `thickness`, measured along the curve's normal at that point.
 *
 * The outer profile (as produced by {@link transitionProfile}) is a list of
 * [radius, y] points. For every sample the curve tangent is estimated from its
 * neighbors, the unit normal is chosen to point toward the axis (decreasing
 * radius), and the point is moved by `thickness` along that normal.
 *
 * Where the offset would push the inner radius below zero the profile is CLIPPED
 * at the radius-0 crossing instead of snapping: the negative-radius points are
 * dropped and the exact intercept point (radius exactly 0) is inserted, so the
 * spline stops cleanly on the axis. The closed section from the intercept out to
 * the outer surface is a straight (wall) line, not a spline, so the caller is
 * told (via the fore/aft flags and intercept coordinates) whether and where the
 * inner profile no longer reaches the component ends.
 *
 * @param outerProfile Outer profile points ([radius, y], fore at y+).
 * @param thickness    Shell wall thickness in meters.
 * @returns An object with:
 *   - `profile`: the non-negative inner points (including the radius-0 intercept
 *     at any clipped end), in the same fore→aft order as the outer profile.
 *   - `foreNegative` / `aftNegative`: whether the raw offset went negative at the
 *     fore (front, y+) or aft (y=0) end respectively.
 *   - `foreIntercept` / `aftIntercept`: the radius-0 intercept point where the
 *     profile re-enters a clipped end, or null if that end is not clipped.
 */
export function innerNoseTransitionProfile(
  outerProfile: Array<[number, number]>,
  thickness: number
): InnerNoseTransitionResult {
  const n = outerProfile.length;
  const t = Math.max(0, thickness);

  // Raw offset points; radii may run negative near a narrow tip where the wall
  // exceeds the local radius.
  const raw: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const r = outerProfile[i][0];
    const y = outerProfile[i][1];

    // Estimate the tangent as a central finite difference over the neighbors.
    const iPrev = Math.max(0, i - 1);
    const iNext = Math.min(n - 1, i + 1);
    const dr = outerProfile[iNext][0] - outerProfile[iPrev][0];
    const dy = outerProfile[iNext][1] - outerProfile[iPrev][1];
    const mag = Math.hypot(dr, dy);

    let nx = 0;
    let ny = 0;
    if (mag > 1e-12) {
      // Perpendicular to (dr, dy) there are two unit normals: (dy, −dr) and
      // (−dy, dr). Pick the one with a NEGATIVE radius component so the offset
      // moves from the outer surface toward the axis (r = 0) — i.e. inward.
      nx = dy / mag;
      ny = -dr / mag;
      if (nx >= 0) {
        nx = -nx;
        ny = -ny;
      }
    }

    raw.push([r + t * nx, y + t * ny]);
  }

  // Clip at radius 0: keep only the non-negative portion and insert an intercept
  // at every sign crossing so the profile stops on the axis rather than dipping
  // negative.
  const profile: Array<[number, number]> = [];
  let foreNegative = false;
  let aftNegative = false;
  let foreIntercept: [number, number] | null = null;
  let aftIntercept: [number, number] | null = null;

  for (let i = 0; i < n; i++) {
    const p = raw[i];
    const neg = p[0] < 0;

    if (i === 0 && neg) foreNegative = true;
    if (i === n - 1 && neg) aftNegative = true;

    if (i > 0) {
      const prev = raw[i - 1];
      const prevNeg = prev[0] < 0;
      if (prevNeg !== neg) {
        // Sign change between prev and p → radius crosses 0 in between.
        const frac = prev[0] / (prev[0] - p[0]);
        const intercept: [number, number] = [0, prev[1] + frac * (p[1] - prev[1])];
        profile.push(intercept);
        if (prevNeg && !neg) foreIntercept = foreIntercept ?? intercept;
        if (!prevNeg && neg) aftIntercept = aftIntercept ?? intercept;
      }
    }

    if (!neg) profile.push(p);
  }

  return { profile, foreNegative, aftNegative, foreIntercept, aftIntercept };
}

/** Shape of the value returned by {@link innerNoseTransitionProfile}. */
export interface InnerNoseTransitionResult {
  profile: Array<[number, number]>;
  foreNegative: boolean;
  aftNegative: boolean;
  foreIntercept: [number, number] | null;
  aftIntercept: [number, number] | null;
}

// ---------- Shoulders ----------

/**
 * A shoulder is a cylindrical section attached BEYOND one end of a nose cone or
 * transition.  Only nose cones and transitions have them; the `.ork` tags
 * `<foreshoulder*>` / `<aftshoulder*>` appear on those two elements only.
 *
 * A shoulder exists only when it has BOTH a radius and a length.  Shipped files
 * rely on this: most components carry a non-zero `<aftshoulderradius>` with a
 * zero length, which is simply "no shoulder" and must add no geometry.
 */
function hasShoulder(s: Shoulder | undefined): s is Shoulder {
  return !!s && s.radius > 0 && s.length > 0;
}

/**
 * A shoulder is solid when it has no wall: a zero/negative thickness means "fill
 * it in", and a thickness at least as large as the radius leaves no bore.  Real
 * files contain both forms side by side — a shoulder of radius 20.2184 mm with
 * thickness 20.2184 mm (solid plug) next to one of radius 14 mm with thickness
 * 1 mm (thin tube).
 */
function shoulderIsSolid(s: Shoulder): boolean {
  return s.thickness <= 0 || s.thickness >= s.radius;
}

/** Inner (bore) radius of a shoulder; 0 when it is solid. */
function shoulderBoreRadius(s: Shoulder): number {
  return shoulderIsSolid(s) ? 0 : Math.max(0, s.radius - s.thickness);
}

/** Radii closer than this are the same point, so no bridging step is emitted. */
const PROFILE_EPS = 1e-9;

/** Append `p` unless it duplicates the previous point. */
function pushPoint(points: Array<[number, number]>, p: [number, number]): void {
  const last = points[points.length - 1];
  if (last && Math.abs(last[0] - p[0]) < PROFILE_EPS && Math.abs(last[1] - p[1]) < PROFILE_EPS) {
    return;
  }
  points.push(p);
}

/** Result of {@link symmetricProfile}. */
export interface SymmetricProfileResult {
  /** Outer surface, fore to aft. */
  profile: Array<[number, number]>;
  /** Bore surface, fore to aft. Coincident with the axis when `innerIsAxis`. */
  innerProfile: Array<[number, number]>;
  /** The component is solid: the bore is the axis, so two points suffice. */
  innerIsAxis: boolean;
}

/** Result of {@link shoulderProfile}. */
export interface ShoulderProfileResult {
  /** Outer surface of the shoulder alone, fore to aft. */
  profile: Array<[number, number]>;
  /** Bore of the shoulder alone, fore to aft. On the axis when `innerIsAxis`. */
  innerProfile: Array<[number, number]>;
  /** The shoulder is solid: the bore is the axis, so two points suffice. */
  innerIsAxis: boolean;
}

/**
 * The component's own bore, fore to aft, with the ends squared off onto the
 * component's end planes.
 *
 * The bore is offset along the surface NORMAL, which on a sloping profile also
 * shifts it axially -- often past the end planes.  Clamp every point back into
 * [0, L]: a wall is cut square at the end, an end face that leans (or pokes out
 * past the end) is wrong, and a bore beyond the end plane also breaks the
 * fore->aft ordering that skFitSpline relies on.  Clamping is monotonic, so the
 * ordering survives.  The radii stay as offset -- a perpendicular wall is
 * thinner radially on a slope, which is correct.
 *
 * ...and pin the two ends onto the planes themselves, so the bore spans exactly
 * the component.  Both moves keep the fore->aft ordering: the first point can
 * only rise to L and the last can only fall to 0.
 */
function bodyBoreProfile(
  p: any,
  bodyOuter: Array<[number, number]>,
  L: number
): Array<[number, number]> {
  const bodyInner: Array<[number, number]> =
    p.filled === true
      ? [
          [0, L],
          [0, 0],
        ]
      : innerNoseTransitionProfile(bodyOuter, Math.max(p.thickness ?? 0, 0)).profile;
  if (bodyInner.length === 0) bodyInner.push([0, L], [0, 0]);

  for (const pt of bodyInner) {
    pt[1] = Math.min(Math.max(pt[1], 0), L);
  }

  // Square off the ends onto the planes themselves -- but NEVER move a point
  // that is on the axis.  Where the wall is thicker than the local radius the
  // bore dies out partway along and the section is genuinely solid from that
  // intercept to the end; dragging the intercept out to the end plane (as an
  // unconditional `bodyInner[0][1] = L` did) deletes that solid length and
  // leaves the region meeting the axis in a single degenerate vertex, which is
  // the shape `opRevolve` refuses.  See AI_README, "the bore pin".
  if (Math.abs(bodyInner[0][0]) >= PROFILE_EPS) {
    bodyInner[0][1] = L;
  }
  if (Math.abs(bodyInner[bodyInner.length - 1][0]) >= PROFILE_EPS) {
    bodyInner[bodyInner.length - 1][1] = 0;
  }

  // A bore that dies out partway along the component is SOLID from its axis
  // intercept out to the end, so the section's inner boundary is the axis itself
  // over that length.  Add the end plane's own axis point so that segment is
  // actually part of the outline -- otherwise it touches the axis at a single
  // vertex, which is the degenerate shape `opRevolve` refuses.
  if (
    Math.abs(bodyInner[0][0]) < PROFILE_EPS &&
    Math.abs(bodyInner[0][1] - L) >= PROFILE_EPS
  ) {
    bodyInner.unshift([0, L]);
  }
  if (
    Math.abs(bodyInner[bodyInner.length - 1][0]) < PROFILE_EPS &&
    Math.abs(bodyInner[bodyInner.length - 1][1]) >= PROFILE_EPS
  ) {
    bodyInner.push([0, 0]);
  }

  return bodyInner;
}

/**
 * Meridian outline of a nose cone or transition's OWN body, with no shoulders.
 *
 * Coordinates are `[radius, y]` with the component's aft end at `y = 0` and its
 * fore end at `y = length`.  The FeatureScript subtracts `length` from every
 * `y`, which lands the sketch on the component's own plane.
 *
 * Shoulders are deliberately NOT folded in here.  A section whose region runs
 * along the revolve axis -- i.e. every solid component -- is the one shape
 * Onshape's revolve refuses, and folding a shoulder in only made that section
 * longer and more likely to trip it.  A shoulder is now revolved as its own
 * body and unioned on; see {@link shoulderProfile}.
 */
export function symmetricProfile(params: SymmetricParams): SymmetricProfileResult {
  const p = params as any;
  const L = Math.max(p.length ?? 0, 0);
  const foreR = Math.max(p.foreRadius ?? 0, 0);
  const aftR = Math.max(p.aftRadius ?? 0, 0);

  // The component's own outer surface, fore to aft. transitionProfile covers
  // every shape, including a nose cone (foreRadius 0) and a plain cone.
  const bodyOuter = transitionProfile(
    p.shape,
    L,
    aftR,
    p.shapeParameter,
    p.shapeClipped,
    50,
    foreR
  );

  const profile: Array<[number, number]> = [];
  for (const pt of bodyOuter) pushPoint(profile, pt);

  const innerProfile: Array<[number, number]> = [];
  for (const pt of bodyBoreProfile(p, bodyOuter, L)) pushPoint(innerProfile, pt);

  // A component whose bore is the axis everywhere is solid: two points on the
  // axis are enough, and the modeller draws a straight line rather than a spline.
  const innerIsAxis = innerProfile.every((pt) => Math.abs(pt[0]) < PROFILE_EPS);
  if (innerIsAxis) {
    return {
      profile,
      innerProfile: [
        [0, profile[0][1]],
        [0, profile[profile.length - 1][1]],
      ],
      innerIsAxis: true,
    };
  }

  return { profile, innerProfile, innerIsAxis: false };
}

/**
 * Meridian outline of ONE shoulder, as a small closed polygon that the
 * FeatureScript revolves on its own and unions onto the component.
 *
 * Coordinates are `[radius, y]` in the same convention as
 * {@link symmetricProfile} -- the component's aft end at `y = 0`, its fore end
 * at `y = length` -- so the FeatureScript's `y -= length` still works with no
 * change on its side.  The fore shoulder occupies `y ∈ [length, length + len]`,
 * the aft shoulder `y ∈ [-len, 0]`.
 *
 * The **connector step is part of the polygon**: a shoulder's radius routinely
 * differs from the component's end radius (a 20.7645 mm nose cone base against
 * a 20.2184 mm shoulder), so the outline runs in (or out) to the component's own
 * end radius at the component's end plane, and the bore steps to the body's own
 * bore radius there to match.  That flat annulus is the face the union shares,
 * and carrying it here is what keeps the shoulder's wall thickness its own
 * instead of jumping to the body's.
 *
 * `capped` closes the shoulder's bore with a disc of the shoulder's own wall
 * thickness at its FREE end; uncapped, the end stays open and the closing face
 * is only the wall annulus.  A solid shoulder ignores the flag -- it has no bore
 * to close.
 *
 * @returns `null` when that end has no shoulder.
 */
export function shoulderProfile(
  params: SymmetricParams,
  which: 'fore' | 'aft'
): ShoulderProfileResult | null {
  const p = params as any;
  const L = Math.max(p.length ?? 0, 0);
  const isFore = which === 'fore';
  const s = (isFore ? p.shoulderFore : p.shoulderAft) as Shoulder | undefined;
  if (!hasShoulder(s)) return null;

  const foreR = Math.max(p.foreRadius ?? 0, 0);
  const aftR = Math.max(p.aftRadius ?? 0, 0);
  const endR = isFore ? foreR : aftR;

  // The body's own bore at the shared end plane, so the connector step lands
  // exactly on a face the body already has.
  const bodyOuter = transitionProfile(
    p.shape,
    L,
    aftR,
    p.shapeParameter,
    p.shapeClipped,
    50,
    foreR
  );
  const bodyInner = bodyBoreProfile(p, bodyOuter, L);
  const bodyBore = isFore ? bodyInner[0][0] : bodyInner[bodyInner.length - 1][0];

  const R = s.radius;
  const sl = s.length;
  const bore = shoulderBoreRadius(s);
  const solid = shoulderIsSolid(s);

  // The shoulder's free end, and the component's end plane it grows from.
  const yFree = isFore ? L + sl : -sl;
  const yJoin = isFore ? L : 0;

  // The bore at the join is the BODY's own bore radius there, so the shoulder's
  // end face and the body's end face are the same annulus and the union has a
  // face to match on.  The step is kept even when it moves the radius the
  // "wrong" way: a shoulder whose wall is thicker than the body's has a smaller
  // bore, and the step then opens the bore back out to the body's, which is
  // exactly the wall-thickness behaviour the shoulder is supposed to have.
  //
  // A solid shoulder is the one exception: it has no bore of its own, and the
  // axis is the honest answer all the way to the join, exactly as for a solid
  // body.  Its end face is then a full disc that OVERLAPS the body's end
  // annulus rather than matching it, which a union is happy with -- overlapping
  // solids merge more reliably than merely abutting ones.
  const joinBore = solid ? 0 : bodyBore;

  const profile: Array<[number, number]> = [];
  const innerProfile: Array<[number, number]> = [];

  if (isFore) {
    // fore -> aft: the shoulder's outer wall, then the step in to the body.
    pushPoint(profile, [R, yFree]);
    pushPoint(profile, [R, yJoin]);
    pushPoint(profile, [endR, yJoin]);
    // A capped shoulder closes its bore with a disc of the wall thickness at the
    // FORE end: the boundary runs in on the axis, steps out to the bore, and
    // the bore carries on aft to the body.  Every profile is ordered
    // fore -> aft, so y must decrease throughout.
    if (s.capped && !solid) {
      // The cap is a disc of the shoulder's OWN wall thickness, sitting at its
      // free end: y ∈ [yFree - thickness, yFree].  Measured from the free end,
      // not from the join.
      const capStart = yFree - Math.min(Math.max(s.thickness, 0), sl);
      pushPoint(innerProfile, [0, yFree]);
      pushPoint(innerProfile, [0, capStart]);
      pushPoint(innerProfile, [bore, capStart]);
    } else {
      pushPoint(innerProfile, [bore, yFree]);
    }
    pushPoint(innerProfile, [bore, yJoin]);
    pushPoint(innerProfile, [joinBore, yJoin]);
  } else {
    // fore -> aft: the step out from the body, then the shoulder's outer wall.
    pushPoint(profile, [endR, yJoin]);
    pushPoint(profile, [R, yJoin]);
    pushPoint(profile, [R, yFree]);
    pushPoint(innerProfile, [joinBore, yJoin]);
    pushPoint(innerProfile, [bore, yJoin]);
    if (s.capped && !solid) {
      // The cap is a disc of the shoulder's OWN wall thickness, sitting at its
      // free end: y ∈ [yFree, yFree + thickness].  Measured from the free end,
      // not from the join.
      const capStart = yFree + Math.min(Math.max(s.thickness, 0), sl);
      pushPoint(innerProfile, [bore, capStart]);
      pushPoint(innerProfile, [0, capStart]);
      pushPoint(innerProfile, [0, yFree]);
    } else {
      pushPoint(innerProfile, [bore, yFree]);
    }
  }

  return {
    profile,
    innerProfile,
    innerIsAxis: innerProfile.every((pt) => Math.abs(pt[0]) < PROFILE_EPS),
  };
}

// ---------- Fin planform generation ----------

/**
 * Generate trapezoid fin planform points (root-to-tip).
 * Ported from OpenRocket's TrapezoidFinSet.shapes().
 */
export function trapezoidFinPoints(
  rootChord: number,
  tipChord: number,
  sweepLength: number,
  height: number
): Array<[number, number]> {
  const y0 = 0;
  const x0 = 0;
  const x1 = sweepLength;
  const y1 = height;
  const x2 = sweepLength + tipChord;
  const y2 = height;
  const x3 = rootChord;
  const y3 = 0;

  // Interpolate points along the edges for smooth lofting
  const points: Array<[number, number]> = [ [x0, y0] ];
  const edgeSteps = 5;
  for (let i = 1; i <= edgeSteps; i++) {
    const t = i / edgeSteps;
    points.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
  }
  for (let i = 1; i <= edgeSteps; i++) {
    const t = i / edgeSteps;
    points.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
  }
  for (let i = 1; i <= edgeSteps; i++) {
    const t = i / edgeSteps;
    points.push([x2 + (x3 - x2) * t, y2 + (y3 - y2) * t]);
  }
  points.push([x3, y3]);
  return points;
}

/**
 * Generate elliptical fin planform points.
 * Ported from OpenRocket's EllipticalFinSet: 31 points forming the upper
 * half of an ellipse from the fore root point to the aft root point.
 */
export function ellipticalFinPoints(
  rootChord: number,
  height: number
): Array<[number, number]> {
  const pointCount = 31;
  const points: Array<[number, number]> = [];
  for (let i = 0; i < pointCount; i++) {
    const angle = (Math.PI * (pointCount - 1 - i)) / (pointCount - 1);
    const x = (Math.cos(angle) + 1) / 2;
    const y = Math.sin(angle);
    points.push([x * rootChord, y * height]);
  }
  // Make the endpoints exact despite floating-point trig roundoff.
  points[0] = [0, 0];
  points[pointCount - 1] = [rootChord, 0];
  return points;
}

/**
 * Compute the touching radius for tube fins around a body of given radius.
 * r_tube = r_body * sin(π/n) / (1 - sin(π/n))
 */
export function tubeFinTouchingRadius(bodyRadius: number, finCount: number): number {
  if (finCount <= 1) return bodyRadius;
  const sinAngle = Math.sin(Math.PI / finCount);
  return (bodyRadius * sinAngle) / (1 - sinAngle);
}

// ---------- Fin mount radius ----------

/**
 * Length of a freeform fin along its mounting body axis (the x direction).
 *
 * This is the ROOT CHORD, `points[n-1].x − points[0].x`, matching
 * OpenRocket's `FinSet.getLength()` -> `getRootChord()`, which for a freeform
 * fin set is defined by the first and last planform points.
 *
 * It is deliberately NOT the x-span `max(x) − min(x)`. The two differ whenever
 * the fin's tip reaches further aft than its root does — a swept or raked
 * freeform outline, where the trailing tip point can sit beyond the last root
 * point. The bounding span then overstates the chord, and since the fin's
 * length is what `AxialMethod.BOTTOM` subtracts from the parent's length
 * (`foreAxialPosition`), the fin is placed too far forward and can overhang
 * the parent's fore end.
 *
 * The FeatureScript relies on the same convention: `drawSnappedFinOutline`
 * treats `profilePoints[0]` and `profilePoints[n-1]` as the fore and aft ROOT
 * points.
 *
 * @param points The freeform fin planform points (`[x, y]`, meters), ordered
 *               from the fore root point to the aft root point.
 * @returns The root chord in meters, or 0 for an empty/invalid list.
 */
export function freeformFinLength(points: Array<[number, number]>): number {
  if (!points || points.length === 0) return 0;

  // Only the two root points matter; ignore any non-finite coordinate.
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 0;
  if (!Number.isFinite(first[0]) || !Number.isFinite(last[0])) return 0;

  return Math.max(0, last[0] - first[0]);
}

/** The axial (mounting-body) length of a fin set, in meters. */
function finAxialLength(fin: RocketComponent): number {
  const p = fin.params as any;
  if (typeof p?.rootChord === 'number') return Math.max(0, p.rootChord);
  if (typeof p?.length === 'number') return Math.max(0, p.length);
  if (Array.isArray(p?.points)) return freeformFinLength(p.points);
  // Rail buttons have no explicit length: their axial extent along the parent
  // is the outer (flange) diameter, matching OpenRocket's RailButton.getLength.
  if (typeof p?.outerDiameter === 'number') return Math.max(0, p.outerDiameter);
  return 0;
}

/** Component types the fin set mounts onto (matching OpenRocket's SymmetricComponent). */
const FIN_MOUNT_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'bodytube',
  'nosecone',
  'transition',
]);

function isFinMountParent(comp: RocketComponent): boolean {
  return FIN_MOUNT_TYPES.has(comp.type);
}

/**
 * Component types that place themselves on the parent's surface through
 * `params.offsetRadius` rather than through `position.radiusOffset`.
 *
 * These are the parts a designer physically mounts on the outside of a body --
 * fin sets, tube fins, launch lugs, rail buttons -- and the FeatureScript builds
 * each of them with `offsetRadius` already folded into the sketch or revolve
 * origin. Adding `position.parentRadius` on top would displace them by the
 * parent's radius a second time, so the derived-radius path deliberately skips
 * them and `offsetRadius` stays the single source of truth.
 *
 * A rail button is in this set because it always sits on the parent's surface;
 * OpenRocket's own `RailButton` has no radial placement of its own.
 */
const SURFACE_MOUNTED_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'trapezoidfinset',
  'ellipticalfinset',
  'freeformfinset',
  'tubefinset',
  'launchlug',
  'railbutton',
]);

function isSurfaceMounted(type: ComponentType): boolean {
  return SURFACE_MOUNTED_TYPES.has(type);
}

/**
 * Compute the radius of a fin's parent symmetric component at a given axial
 * position along its length. Mirrors OpenRocket's
 * `SymmetricComponent.getRadius(x)`:
 *  - body tube: constant outer radius
 *  - nose cone / transition: interpolated between fore and aft radii following
 *    the profile interpolation used by {@link transitionProfile}.
 */
function mountParentRadiusAt(comp: RocketComponent, x: number): number {
  const p = comp.params as any;
  if (comp.type === 'bodytube') {
    return Math.max(0, p.outerRadius ?? 0);
  }
  // nose cone / transition -- the same OpenRocket evaluation the profile uses, so
  // a fin's mount radius cannot drift from the surface it is measured against.
  return transitionRadiusAt(
    p.shape,
    x,
    p.foreRadius ?? 0,
    p.aftRadius ?? 0,
    Math.max(p.length ?? 0, 1e-9),
    p.shapeParameter,
    p.shapeClipped === true
  );
}

/**
 * Inner radius of a `RadialParent` component at axial position `x` — i.e. the
 * inside wall of the tube a ring sits in. Mirrors OpenRocket's
 * `RadialParent.getInnerRadius(x)`:
 *  - body tube: outer minus wall thickness (or the outer radius if filled /
 *    has no wall)
 *  - tube coupler / inner tube / engine block: the explicit inner radius when
 *    one is present, else outer minus wall thickness
 *  - nose cone / transition: the outer surface radius at `x` minus the wall
 *    thickness
 */
function parentInnerRadiusAt(parent: RocketComponent, x: number): number {
  const p = parent.params as any;
  const outer = Math.max(p.outerRadius ?? 0, 0);
  const thickness = p.thickness ?? 0;

  switch (parent.type) {
    case 'bodytube':
      if (p.filled || thickness <= 0) return outer;
      return Math.max(0, outer - thickness);
    case 'tubecoupler':
    case 'innertube':
    case 'engineblock': {
      const inner = p.innerRadius ?? 0;
      if (inner > 0) return inner;
      if (thickness > 0) return Math.max(0, outer - thickness);
      return outer;
    }
    case 'nosecone':
    case 'transition': {
      const surface = mountParentRadiusAt(parent, x);
      if (p.filled || thickness <= 0) return surface;
      return Math.max(0, surface - thickness);
    }
    default:
      return 0;
  }
}

/**
 * Fore (front-end) axial position of a component within its parent, in meters,
 * measured from the parent's fore (top) end. Mirrors OpenRocket's
 * `AxialMethod.getAsPosition(offset, innerLength, outerLength)`:
 *  - `top` / `absolute`: the offset measured from the parent's fore end
 *  - `middle`: offset + (parent length − component length) / 2
 *  - `bottom`: offset + (parent length − component length)
 *  - `after`: parent length + offset
 */
function foreAxialPosition(
  pos: Position | undefined,
  componentLength: number,
  parentLength: number
): number {
  const offset = pos?.axialOffset ?? 0;
  let x = offset; // TOP / ABSOLUTE
  switch (pos?.axialMethod) {
    case 'middle':
      x = offset + (parentLength - componentLength) / 2;
      break;
    case 'bottom':
      x = offset + (parentLength - componentLength);
      break;
    case 'after':
      x = parentLength + offset;
      break;
    case 'absolute':
    case 'top':
    default:
      x = offset;
      break;
  }
  return x;
}

/**
 * Compute the mount offset radius for a component that sits on a symmetric
 * parent's surface (fin sets, tube fins, launch lugs): the radial distance
 * from the central axis to the body surface at the component's axial
 * position. This lets it be positioned radially ("offset correctly")
 * regardless of whether its parent is a body tube (constant radius) or a
 * nose cone / transition (radius varies along the length).
 *
 * The component's axial position relative to its parent is derived from its
 * `position.axialMethod` / `position.axialOffset` (following OpenRocket's
 * `AxialMethod.getAsPosition`), and the parent radius at that point is
 * returned.
 *
 * Returns 0 if there is no suitable symmetric parent.
 */
export function finMountRadius(fin: RocketComponent, parent: RocketComponent): number {
  if (!isFinMountParent(parent)) return 0;

  const parentLength = Math.max((parent.params as any).length ?? 0, 0);
  const finLength = finAxialLength(fin);
  const pos: Position = fin.position || ({} as Position);
  const x = foreAxialPosition(pos, finLength, parentLength);

  return mountParentRadiusAt(parent, x);
}

/**
 * OpenRocket ComponentAssembly.getBoundingRadius(): maximum outer radius of
 * its direct body-tube or transition children. Used with RadiusMethod.RELATIVE
 * when the assembly is itself positioned relative to another component.
 */
function assemblyBoundingRadius(comp: RocketComponent): number {
  if (!isAssembly(comp)) return 0;
  let radius = 0;
  for (const child of comp.children) {
    const p = child.params as any;
    if (child.type === 'bodytube') {
      radius = Math.max(radius, p.outerRadius ?? 0);
    } else if (child.type === 'transition') {
      radius = Math.max(radius, p.foreRadius ?? 0, p.aftRadius ?? 0);
    }
  }
  return radius;
}

// ---------- Inner-tube clusters ----------

/** `Math.SQRT3`, which JavaScript does not provide (Java has `SQRT3`). */
const SQRT3 = 1.7320508075688772;

/** An n-tube ring: radius 1/(2 sin(pi/n)), the tightest ring of touching tubes. */
function clusterRing(count: number): Array<readonly [number, number]> {
  const radius = 1 / (2 * Math.sin(Math.PI / count));
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count;
    return [radius * Math.sin(angle), radius * Math.cos(angle)] as const;
  });
}

/** The n outer tubes of an n-star layout, on the unit circle. */
function clusterStarRing(count: number): Array<readonly [number, number]> {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * (i + 1)) / count;
    return [Math.sin(angle), Math.cos(angle)] as const;
  });
}

/**
 * The cluster layouts OpenRocket offers, ported from
 * `info.openrocket.core.rocketcomponent.ClusterConfiguration`.
 *
 * Each entry is a list of (x, y) offsets in units of the *tube diameter*: the
 * layouts are normalised so the closest pair of tubes sits exactly one diameter
 * apart, which is why `3-row` runs -1 .. +1 and `4-ring` sits on the corners of
 * a unit square. The real distance is `separation` (see {@link clusterOffsets}),
 * the tube diameter times `clusterScale`.
 *
 * OpenRocket's own axes are x = axial with y/z radial, and the table is
 * expressed in that radial (y, z) pair. The rotation `getPoints(rotation)`
 * applies is reproduced in {@link clusterOffsets}, sign and all.
 */
const CLUSTER_LAYOUTS: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>> = {
  single: [[0, 0]],
  double: [[-0.5, 0], [0.5, 0]],
  '3-row': [[-1, 0], [0, 0], [1, 0]],
  '4-row': [[-1.5, 0], [-0.5, 0], [0.5, 0], [1.5, 0]],
  '3-ring': [[-0.5, -1 / (2 * SQRT3)], [0.5, -1 / (2 * SQRT3)], [0, 1 / SQRT3]],
  '4-ring': [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]],
  '5-ring': clusterRing(5),
  '6-ring': [
    [0, 1],
    [SQRT3 / 2, 0.5],
    [SQRT3 / 2, -0.5],
    [0, -1],
    [-SQRT3 / 2, -0.5],
    [-SQRT3 / 2, 0.5],
  ],
  '3-star': [[0, 0], [0, 1], [SQRT3 / 2, -0.5], [-SQRT3 / 2, -0.5]],
  '4-star': [
    [0, 0],
    [-1 / Math.SQRT2, 1 / Math.SQRT2],
    [1 / Math.SQRT2, 1 / Math.SQRT2],
    [1 / Math.SQRT2, -1 / Math.SQRT2],
    [-1 / Math.SQRT2, -1 / Math.SQRT2],
  ],
  '5-star': [[0, 0], [0, 1], ...clusterStarRing(5)],
  '6-star': [
    [0, 0],
    [0, 1],
    [SQRT3 / 2, 0.5],
    [SQRT3 / 2, -0.5],
    [0, -1],
    [-SQRT3 / 2, -0.5],
    [-SQRT3 / 2, 0.5],
  ],
  '9-grid': [
    [-1.4, 1.4],
    [0, 1.4],
    [1.4, 1.4],
    [-1.4, 0],
    [0, 0],
    [1.4, 0],
    [-1.4, -1.4],
    [0, -1.4],
    [1.4, -1.4],
  ],
  '9-star': [
    [0, 0],
    [1.4, 0],
    [1.4 / Math.SQRT2, 1.4 / Math.SQRT2],
    [0, 1.4],
    [-1.4 / Math.SQRT2, 1.4 / Math.SQRT2],
    [-1.4, 0],
    [-1.4 / Math.SQRT2, -1.4 / Math.SQRT2],
    [0, -1.4],
    [1.4 / Math.SQRT2, -1.4 / Math.SQRT2],
  ],
};

/**
 * Where each tube of a cluster sits, in metres, in the mounting component's own
 * frame. A direct port of `InnerTube.getClusterPoints()`:
 *
 *  - the layout is rotated by `clusterRotation - radialDirection` (radians),
 *  - scaled by `separation`, the tube diameter times `clusterScale` (1.0 =
 *    touching, larger spreads the tubes, smaller nests them), and
 *  - offset by the component's own `radialPosition`.
 *
 * `clusterRotation` arrives in degrees from the XML -- the saver writes
 * `getClusterRotation() * 180 / PI` -- and is converted here.
 */
export function clusterOffsets(
  params: any,
  radialPosition = 0,
  radialDirection = 0
): Array<{ x: number; y: number }> {
  const layout = CLUSTER_LAYOUTS[params.clusterConfiguration] ?? CLUSTER_LAYOUTS.single;
  const outerRadius = Math.max(params.outerRadius ?? 0, 0);
  const scale = typeof params.clusterScale === 'number' ? Math.max(params.clusterScale, 0) : 1;
  const separation = 2 * outerRadius * scale;
  const rotation = ((params.clusterRotation ?? 0) * Math.PI) / 180 - radialDirection;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // The component's own radial offset, in the same (y, z) frame.
  const yOffset = radialPosition * Math.cos(radialDirection);
  const zOffset = radialPosition * Math.sin(radialDirection);

  return layout.map(([x, y]) => {
    // getPoints(rotation), verbatim: x' = x cos + y sin, y' = -x sin + y cos.
    const px = x * cos + y * sin;
    const py = -x * sin + y * cos;
    return { x: px * separation + yOffset, y: py * separation + zOffset };
  });
}

/** A deep copy of a component and its subtree, with distinct ids throughout. */
function cloneComponent(comp: RocketComponent, tag: string): RocketComponent {
  return {
    ...comp,
    id: `${comp.id || comp.type}-${tag}`,
    position: { ...comp.position },
    params: { ...(comp.params as any) },
    material: comp.material ? { ...comp.material } : undefined,
    children: comp.children.map((child, i) => cloneComponent(child, `${tag}.${i}`)),
  };
}

/**
 * Replace a clustered inner tube with one component per tube.
 *
 * `Clusterable` components are not written with an `instancecount` by
 * OpenRocket's saver, so there is nothing for the FeatureScript's angular
 * patterning to pick up and a `4-ring` cluster used to build as a single tube
 * of the same outer diameter. Expanding here, in the .ork interpretation layer
 * beside the rest of the format's semantics, means the FeatureScript only ever
 * sees ordinary inner tubes -- one per motor -- and needs no notion of what a
 * "4-ring" is.
 *
 * Each copy is placed with the `radialPosition` / `radialDirection` pair the
 * FeatureScript already applies, so no new payload field is introduced. The
 * tube's children (thrust rings, engine blocks) are cloned onto every copy,
 * because each clustered tube is a complete motor mount of its own.
 */
function expandCluster(comp: RocketComponent, warnings: string[]): RocketComponent[] {
  const params = comp.params as any;
  if (comp.type !== 'innertube' || !params) return [comp];

  const layout = params.clusterConfiguration ?? 'single';
  if (layout === 'single') return [comp];
  if (!CLUSTER_LAYOUTS[layout]) {
    warnings.push(
      `[MEDIUM] ${comp.name}: unknown cluster configuration "${layout}" — built as a single tube.`
    );
    return [comp];
  }

  const offsets = clusterOffsets(params, comp.position.radialPosition, comp.position.radialDirection);
  const total = offsets.length;

  return offsets.map((offset, index) => {
    const copy = cloneComponent(comp, `cluster${index + 1}`);
    const copyParams = copy.params as any;
    // Consumed here: each copy carries its own placement, so leaving the
    // cluster description on would re-expand it on a second derived-data pass.
    copyParams.clusterConfiguration = 'single';
    copy.name = `${comp.name} (${index + 1}/${total})`;
    // The FeatureScript applies the radial direction as a rotation about the
    // body axis and the radial position as an offset along that rotated axis,
    // so this polar (magnitude, angle) pair is exactly the placement
    // OpenRocket computes. Overwriting the tube's own values folds them in.
    copy.position.radialPosition = Math.hypot(offset.x, offset.y);
    copy.position.radialDirection = Math.atan2(offset.y, offset.x);
    return copy;
  });
}

/** Walk the tree, expanding every clustered inner tube in place. */
function expandInnerTubeClusters(components: RocketComponent[], warnings: string[]): RocketComponent[] {
  const expanded: RocketComponent[] = [];
  for (const comp of components) {
    comp.children = expandInnerTubeClusters(comp.children, warnings);
    expanded.push(...expandCluster(comp, warnings));
  }
  return expanded;
}

// ---------- Mass estimation ----------

/**
 * The axial length of a single component, used for derived assembly lengths.
 * - component assemblies (pod set, stage, parallel stage): the total length of
 *   their direct AFTER-positioned children, matching OpenRocket
 * - tube-like components (body tubes, nose cones, transitions, rings,
 *   launch lugs, recovery devices): their `length` param
 * - fin sets: root chord (`rootChord`), falling back to `length` for tube fins
 *   or the planform extent for freeform fins
 * - anything without an explicit length: 0
 */
function isAssembly(comp: RocketComponent): boolean {
  return comp.type === 'podset' || comp.type === 'stage' || comp.type === 'parallelstage';
}

function componentLength(comp: RocketComponent): number {
  const p = comp.params as any;
  // ComponentAssembly.updateBounds() sums only direct children positioned AFTER;
  // off-axis parallel stages and pod sets therefore do not lengthen the core
  // stage, and explicitly positioned children do not create phantom extent.
  if (isAssembly(comp)) {
    return comp.children.reduce(
      (sum, child) => child.position?.axialMethod === 'after' ? sum + componentLength(child) : sum,
      0
    );
  }
  if (typeof p?.rootChord === 'number') return Math.max(0, p.rootChord);
  if (typeof p?.length === 'number') return Math.max(0, p.length);
  if (Array.isArray(p?.points)) return freeformFinLength(p.points);
  return 0;
}

/**
 * Estimate the mass of a component (external components only).
 * Uses volume × material density via the analytic formulas from OpenRocket.
 */
export function estimateComponentMass(comp: RocketComponent): number | null {
  if (!comp.material || comp.material.density <= 0) return null;

  const d = comp.material.density;
  const p = comp.params as any;

  switch (comp.type) {
    case 'bodytube': {
      const { length, outerRadius, thickness, filled } = p;
      if (filled) {
        return d * Math.PI * outerRadius * outerRadius * length;
      }
      const innerR = Math.max(0, outerRadius - thickness);
      return d * Math.PI * (outerRadius * outerRadius - innerR * innerR) * length;
    }

    case 'nosecone': {
      // A nose cone's material is sized from its BASE, which is the flip-
      // independent "wide" end. A tail cone (<isflipped>) carries that base at
      // the FORE end and tapers to a point aft, so keying the estimate off
      // `aftRadius` alone would report a tail cone as essentially massless.
      // (OpenRocket's own `NoseCone.getBaseRadius()` picks the same end.)
      const { length, foreRadius, aftRadius, thickness, filled } = p;
      const baseR = Math.max(foreRadius ?? 0, aftRadius ?? 0);
      if (filled) {
        // Approximate as a cone: V = πr²L/3
        return d * (Math.PI * baseR * baseR * length) / 3;
      }
      // Approximate shell volume using mean radius and surface area
      const meanR = Math.max(0, baseR - thickness / 2);
      const surf = Math.PI * meanR * Math.sqrt(meanR * meanR + length * length);
      return d * surf * thickness;
    }

    case 'transition': {
      // Unchanged: a transition is not flippable, so its base is always the aft
      // end and keying off `aftRadius` stays correct even when narrowing.
      const { length, aftRadius, thickness, filled } = p;
      if (filled) {
        // Approximate as a cone: V = πr²L/3
        return d * (Math.PI * aftRadius * aftRadius * length) / 3;
      }
      // Approximate shell volume using mean radius and surface area
      const meanR = Math.max(0, aftRadius - thickness / 2);
      const surf = Math.PI * meanR * Math.sqrt(meanR * meanR + length * length);
      return d * surf * thickness;
    }

    case 'trapezoidfinset': {
      const { rootChord, tipChord, height, thickness } = p;
      const area = ((rootChord + tipChord) / 2) * height;
      return d * area * thickness * finCrossSectionVolume(p.crossSection) * p.finCount;
    }

    case 'ellipticalfinset': {
      const { rootChord, height, thickness } = p;
      const area = (Math.PI / 4) * rootChord * height;
      return d * area * thickness * finCrossSectionVolume(p.crossSection) * p.finCount;
    }

    case 'freeformfinset': {
      if (!p.points || p.points.length < 3) return null;
      // Shoelace formula for planform area
      let area = 0;
      for (let i = 0; i < p.points.length; i++) {
        const [x1, y1] = p.points[i];
        const [x2, y2] = p.points[(i + 1) % p.points.length];
        area += x1 * y2 - x2 * y1;
      }
      area = Math.abs(area) / 2;
      return d * area * p.thickness * finCrossSectionVolume(p.crossSection) * p.finCount;
    }

    case 'tubefinset': {
      const { length, outerRadius, thickness, finCount } = p;
      const innerRadius = Math.max(0, outerRadius - thickness);
      return d * Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius) * length * finCount;
    }

    case 'launchlug': {
      const { outerRadius, innerRadius, length } = p;
      return d * Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius) * length;
    }

    case 'innertube':
    case 'tubecoupler':
    case 'engineblock': {
      const { outerRadius, innerRadius, thickness, length } = p;
      const id = innerRadius > 0 ? innerRadius : Math.max(0, outerRadius - thickness);
      return d * Math.PI * (outerRadius * outerRadius - id * id) * length;
    }

    case 'centeringring':
    case 'bulkhead': {
      const { outerRadius, innerRadius, length } = p;
      return d * Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius) * length;
    }

    default:
      return null;
  }
}

// ---------- Auto-radius resolution ----------

/** Axial (body-chain) component types whose radii form a continuous stack. */
const AXIAL_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'nosecone',
  'transition',
  'bodytube',
]);

function isAxial(comp: RocketComponent): boolean {
  return AXIAL_TYPES.has(comp.type);
}

/**
 * Ring components whose `auto` OUTER radius means "fit snugly inside the tube I
 * sit in". All five are OpenRocket `ThicknessRingComponent`s, and each one's
 * `getOuterRadius()` resolves the same way: the parent's inner radius, sampled
 * at both ends of the ring's axial span, taking the smaller. The parser sets
 * `autoOuterRadius` for all of them (they share `parseRingComponentParams`).
 */
const AUTO_OUTER_RADIUS_RING_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'innertube',
  'tubecoupler',
  'centeringring',
  'bulkhead',
  'engineblock',
]);

/** Outer radius at the fore (front) of an axial component, in meters. */
function foreRadiusOf(comp: RocketComponent): number {
  const p = comp.params as any;
  if (comp.type === 'bodytube') return p.outerRadius ?? 0;
  return p.foreRadius ?? 0;
}

/** Outer radius at the aft (rear) of an axial component, in meters. */
function aftRadiusOf(comp: RocketComponent): number {
  const p = comp.params as any;
  if (comp.type === 'bodytube') return p.outerRadius ?? 0;
  return p.aftRadius ?? 0;
}

/** Nearest preceding axial sibling in the same `<subcomponents>` (document order). */
function prevAxialSibling(comps: RocketComponent[], index: number): RocketComponent | null {
  for (let j = index - 1; j >= 0; j--) {
    if (isAxial(comps[j])) return comps[j];
  }
  return null;
}

/** Nearest following axial sibling in the same `<subcomponents>` (document order). */
function nextAxialSibling(comps: RocketComponent[], index: number): RocketComponent | null {
  for (let j = index + 1; j < comps.length; j++) {
    if (isAxial(comps[j])) return comps[j];
  }
  return null;
}

/**
 * Resolve auto-radius markers from the adjacent axial (body-chain) components,
 * matching OpenRocket's semantics:
 *  - A transition's auto **fore** radius comes from the PREVIOUS component's rear radius.
 *    (Unlike a nose cone tip, a transition's fore radius is generally non-zero.)
 *  - A body tube's auto outer radius comes from the previous (else next) component.
 *  - A nose cone / transition auto **base** (aft) radius comes from the NEXT component.
 *  - A FLIPPED nose cone (tail cone) stores its base in `<aftradius>`, which the
 *    parser moves to `foreRadius`, so its auto base resolves from the PREVIOUS
 *    component instead -- the mirror image of the rule above.
 *
 * When a radius is marked "auto" the stored numeric value is only a junk/placeholder
 * (e.g. `auto 0.025`), so it is ALWAYS overwritten by the resolved neighbor value.
 * Neighbors are walked in its own `<subcomponents>` sibling document order, and the
 * forward pass runs left→right so chained autos propagate (a body tube that resolves
 * from the nose cone feeds the transition fore radius that follows it). Mutates
 * `params` in place.
 */
function resolveAutoRadius(
  comps: RocketComponent[],
  warnings: string[],
  parent?: RocketComponent
): void {
  // Recurse into each component's children first (each has its own sibling chain).
  for (const child of comps) resolveAutoRadius(child.children, warnings, child);

  // Fore / outer radii depend on the PREVIOUS sibling, so resolve left → right.
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    if (!isAxial(c)) continue;
    const p = c.params as any;

    // A flipped nose cone carries its BASE radius in `<aftradius>`, which the
    // parser has already moved to `foreRadius` (with the auto marker following
    // it), so a tail cone's base resolves from the PREVIOUS sibling exactly like
    // a transition's fore radius does. A non-flipped nose cone never reaches
    // this branch: its fore radius is always the 0-radius tip.
    if ((c.type === 'transition' || p.flipped === true) && p.foreRadiusAutomatic) {
      const prev = prevAxialSibling(comps, i);
      const resolved = prev ? aftRadiusOf(prev) : NaN;
      if (prev && resolved > 0) {
        p.foreRadius = resolved;
      } else {
        warnings.push(
          `${c.name}: auto fore radius — no previous component to resolve from (foreRadius=${p.foreRadius ?? 0})`
        );
      }
    }

    if (c.type === 'bodytube' && p.autoOuterRadius) {
      const prev = prevAxialSibling(comps, i);
      const next = nextAxialSibling(comps, i);
      const fromPrev = prev ? aftRadiusOf(prev) : NaN;
      const fromNext = next ? foreRadiusOf(next) : NaN;
      if (prev && fromPrev > 0) {
        p.outerRadius = fromPrev;
      } else if (next && fromNext > 0) {
        p.outerRadius = fromNext;
      } else {
        warnings.push(
          `${c.name}: auto outer radius — no adjacent component to resolve from`
        );
      }
    }
  }

  // Radius-ring components: resolve an `auto` OUTER radius against the enclosing
  // assembly.  All five ring types share the same rule, because all five are
  // OpenRocket `ThicknessRingComponent`s whose getOuterRadius() is identical
  // (see ThicknessRingComponent.java):
  //
  //  - An `auto` OUTER radius is the INNER radius of the tube the ring sits in
  //    (its `RadialParent`), sampled over the ring's axial span — the ring
  //    always fits snugly inside its enclosing body tube / coupler. A bulkhead
  //    defaults to an automatic outer radius (Bulkhead() calls
  //    setOuterRadiusAutomatic(true)), as do a tube coupler and an engine
  //    block, and an inner tube's <outerradius> is frequently `auto` too.
  //    Resolving only centering rings and bulkheads left `innertube`,
  //    `tubecoupler` and `engineblock` at outerRadius 0 — a zero-thickness
  //    section, reported by validation but never fixed.
  //
  //  - A centering ring's `auto` INNER radius is the largest sibling
  //    inner/motor tube's OUTER radius that actually OVERLAPS the ring's axial
  //    span, capped by this ring's (resolved) outer radius. A non-overlapping
  //    inner tube (e.g. one sitting in a different part of the tube) does NOT
  //    define the hole. Bulkheads are skipped here — OpenRocket's
  //    Bulkhead.getInnerRadius() always returns 0 (solid disc) and its saver
  //    never writes an <innerradius> element, so a bulkhead has no auto inner
  //    radius to resolve.
  //
  // The outer radius is resolved first so the inner pass can cap against it.
  const parentLength = Math.max((parent?.params as any)?.length ?? 0, 0);
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    if (!AUTO_OUTER_RADIUS_RING_TYPES.has(c.type)) continue;
    const p = c.params as any;
    const ringLength = Math.max(p.length ?? 0, 0);
    const pos: Position = c.position || ({} as Position);
    const ringFore = foreAxialPosition(pos, ringLength, parentLength);
    const ringAft = ringFore + ringLength;

    if (p.autoOuterRadius) {
      let resolved = 0;
      if (parent) {
        const outerFore = parentInnerRadiusAt(parent, Math.min(Math.max(ringFore, 0), parentLength));
        const outerAft = parentInnerRadiusAt(parent, Math.min(Math.max(ringAft, 0), parentLength));
        resolved = Math.min(outerFore, outerAft);
      }
      if (resolved > 0) {
        p.outerRadius = resolved;
      } else {
        warnings.push(
          `${c.name}: auto outer radius — no enclosing tube to fit within (outerRadius=0)`
        );
      }
    }

    if (c.type === 'centeringring' && p.autoInnerRadius) {
      let inner = 0;
      for (const sibling of comps) {
        if (sibling.type !== 'innertube') continue;
        const sLen = Math.max((sibling.params as any).length ?? 0, 0);
        const sFore = foreAxialPosition(sibling.position, sLen, parentLength);
        // Only sibling inner tubes whose axial span intersects the ring's count.
        const overlaps = ringAft >= sFore && ringFore <= sFore + sLen;
        if (!overlaps) continue;
        const outerRadius = (sibling.params as any).outerRadius ?? 0;
        if (outerRadius > 0 && outerRadius > inner) inner = outerRadius;
      }
      const outer = p.outerRadius ?? 0;
      if (outer > 0) inner = Math.min(inner, outer);

      if (inner > 0) {
        p.innerRadius = inner;
      } else {
        warnings.push(
          `${c.name}: auto inner radius — no overlapping inner-tube sibling to derive a diameter from (innerRadius=0)`
        );
      }
    }
  }

  // Base (aft) radii depend on the NEXT sibling, so resolve right → left.
  for (let i = comps.length - 1; i >= 0; i--) {
    const c = comps[i];
    if (!isAxial(c)) continue;
    const p = c.params as any;
    if ((c.type === 'nosecone' || c.type === 'transition') && p.baseRadiusAutomatic) {
      const next = nextAxialSibling(comps, i);
      const resolved = next ? foreRadiusOf(next) : NaN;
      if (next && resolved > 0) {
        p.aftRadius = resolved;
      } else {
        warnings.push(
          `${c.name}: auto aft radius — no next component to resolve from`
        );
      }
    }
  }
}

/**
 * Recursively decorate all components with computed derived data
 * (profiles, planforms, masses). Mutates the RocketJson in place.
 */
export function computeDerivedData(rocketJson: RocketJson): void {
  const warnings: string[] = [];

  // Expand before anything is derived, so each tube of a cluster gets its own
  // profile, mass and placement exactly as a hand-authored tube would.
  rocketJson.rocket.components = expandInnerTubeClusters(
    rocketJson.rocket.components,
    warnings
  );

  // Resolve auto radii against adjacent axial components first, so the
  // derived profiles are computed with concrete resolved radii.
  resolveAutoRadius(rocketJson.rocket.components, warnings);

  const visit = (comp: RocketComponent) => {
    // Derive assembly extent before children need it for placement. The result
    // is data-only: FeatureScript never creates a solid for an assembly.
    if (isAssembly(comp)) {
      (comp.params as any).length = comp.children.reduce(
        (sum, child) => child.position?.axialMethod === 'after' ? sum + componentLength(child) : sum,
        0
      );
    }

    switch (comp.type) {
      case 'nosecone':
      case 'transition': {
        const p = comp.params as any;

        // One builder for every shape, wall and cap. It emits the outer
        // surface, the bore (already clipped onto the axis where a wall is
        // thicker than the local radius), and a flag for the fully-solid case.
        // The FeatureScript draws these two polylines and the two end faces; it
        // no longer has to decide anything about walls or caps.
        const shape = symmetricProfile(p);
        (p as any).profile = shape.profile;
        (p as any).innerProfile = shape.innerProfile;
        (p as any).innerIsAxis = shape.innerIsAxis;

        // Shoulders are NOT folded into the section above: each is its own small
        // polygon, revolved separately and boolean-unioned on by the
        // FeatureScript.  `null` means "no shoulder on that end", which the
        // FeatureScript reads as an absent key.
        const fore = shoulderProfile(p, 'fore');
        const aft = shoulderProfile(p, 'aft');
        (p as any).shoulderProfile = { fore, aft };

        // Axial extent actually occupied, shoulders included. `length` stays the
        // bare cone/transition length so `<length>` keeps its stored meaning,
        // and that is also what OpenRocket stacks by (see AI_README).
        (p as any).totalLength =
          Math.max(p.length ?? 0, 0) +
          (fore ? p.shoulderFore.length : 0) +
          (aft ? p.shoulderAft.length : 0);
        break;
      }
      case 'trapezoidfinset': {
        const p = comp.params as any;
        (p as any).planform = trapezoidFinPoints(
          p.rootChord,
          p.tipChord,
          p.sweepLength,
          p.height
        );
        break;
      }
      case 'ellipticalfinset': {
        const p = comp.params as any;
        (p as any).planform = ellipticalFinPoints(p.rootChord, p.height);
        break;
      }
      case 'freeformfinset': {
        const p = comp.params as any;
        // Attach the fin's axial length (max x distance between any two
        // points) so downstream consumers have it without re-deriving it.
        (p as any).length = freeformFinLength(p.points);
        break;
      }
    }

    // Components that mount onto this component inherit the parent's surface
    // radius as their radial offset, so they are placed correctly whether the
    // parent is a body tube (constant radius) or a nose cone / transition
    // (radius varies along the length).
    //
    // Both 'relative' and 'surface' measure the offset from the parent's
    // surface, so both need the same base radius. It has to be recorded for
    // 'surface' too, not just 'relative': `surface` is what the saver writes by
    // default and is the most common value in real files, and without this the
    // FeatureScript has no radius to offset from and drops the component onto
    // the rocket axis.
    for (const child of comp.children) {
      const method = child.position?.radiusMethod;
      if ((method === 'relative' || method === 'surface') && !isSurfaceMounted(child.type)) {
        const parentRadius = isAssembly(comp)
          ? assemblyBoundingRadius(comp)
          : finMountRadius(child, comp);
        // RadiusMethod.RELATIVE also adds the positioned component's own
        // bounding radius when it is a ring assembly (pod set / parallel stage).
        (child.position as any).parentRadius = parentRadius +
          (isAssembly(child) ? assemblyBoundingRadius(child) : 0);
      }
      if (isSurfaceMounted(child.type)) {
        const childParams = child.params as any;
        childParams.offsetRadius = finMountRadius(child, comp);
        if (child.type === 'tubefinset' && childParams.autoOuterRadius) {
          childParams.outerRadius = tubeFinTouchingRadius(
            childParams.offsetRadius,
            childParams.finCount
          );
        }
      }
    }

    // Add mass estimate.
    //
    // NOTE: the FeatureScript never reads `comp.mass` -- Onshape derives mass
    // from the geometry it builds and the material assigned to it. This figure
    // exists for the web app's own summary, so it is a *design estimate*, not a
    // prediction of what Onshape will report. Do not "fix" a mismatch by
    // writing mass into the payload; there is nowhere for it to go.
    const mass = estimateComponentMass(comp);
    if (mass !== null) {
      comp.mass = mass;
    } else if (
      (comp.type === 'parachute' ||
        comp.type === 'streamer' ||
        comp.type === 'shockcord' ||
        comp.type === 'masscomponent') &&
      typeof (comp.params as any).mass === 'number'
    ) {
      comp.mass = (comp.params as any).mass;
    }

    // Guard an exactly-zero `length`, which makes degenerate geometry downstream
    // (zero-thickness fillets, vanishing lofts).
    //
    // `packedLength` is deliberately NOT clamped.  A MassObject with a zero
    // packed length is a mass marker with no axial extent -- `Bell X-1`'s
    // "screw  eye (SE-1)" is exactly that -- and OpenRocket's
    // `MassObject.getLength()` returns the zero unchanged.  Clamping it to 1e-9
    // fabricated a 1 nm tall, 12.5 mm wide section, whose revolve failed.  Left
    // at 0, the FeatureScript skips the solid, which is what OpenRocket renders.
    const length = (comp.params as any)?.length;
    if (typeof length === 'number' && length === 0) {
      (comp.params as any).length = 1e-9;
    }

    for (const child of comp.children) visit(child);
  };

  for (const comp of rocketJson.rocket.components) visit(comp);
  rocketJson.warnings.push(...warnings);
}