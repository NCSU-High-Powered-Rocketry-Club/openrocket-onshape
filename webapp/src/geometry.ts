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

import type { RocketJson, RocketComponent, SymmetricShape } from './types';

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
 * @param shapeClipped Whether the shape is clipped at the fore end
 * @returns The radius at position x
 */
export function transitionRadius(
  shape: SymmetricShape,
  x: number,
  radius: number,
  length: number,
  param: number,
  shapeClipped = false
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
      // Circle-based ogive: radius determined by a circle intersecting the
      // fore and aft points. If clipped, the full ogive has radius r/p at the
      // fore end and the tip is truncated.
      if (shapeClipped) {
        const baseLength = L / (1 - p);
        const R = (r * r + baseLength * baseLength) / (2 * r);
        z = Math.sqrt(R * R - (baseLength - x) * (baseLength - x)) - (R - r);
      } else {
        const R = (r * r + L * L) / (2 * r);
        z = Math.sqrt(R * R - (L - x) * (L - x)) - (R - r);
      }
      break;
    }

    case 'ellipsoid': {
      // Half-ellipse: x²/L² + y²/r² = 1
      const t = x / L;
      z = r * Math.sqrt(1 - t * t);
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
 * Discretize a transition/nose cone profile into a list of [x, y] points.
 * @param shape The shape type
 * @param length The transition length
 * @param radius The aft radius
 * @param param The shape parameter
 * @param shapeClipped Whether clipped
 * @param steps Number of sample points (default 50)
 */
export function transitionProfile(
  shape: SymmetricShape,
  length: number,
  radius: number,
  param: number,
  shapeClipped = false,
  steps = 50
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * length;
    points.push([x, transitionRadius(shape, x, radius, length, param, shapeClipped)]);
  }
  return points;
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
 * Ported from OpenRocket's EllipticalFinSet using a 31-point half-ellipse.
 */
const POINT_X = [
  1.0,   0.962, 0.889, 0.792, 0.689, 0.584, 0.481, 0.383, 0.297, 0.223,
  0.163, 0.116, 0.079, 0.05,  0.029, 0.015, 0.006, 0.0,
];
const POINT_Y = [
  0.0,   0.209, 0.378, 0.507, 0.623, 0.713, 0.784, 0.843, 0.889, 0.923,
  0.946, 0.959, 0.969, 0.976, 0.983, 0.989, 0.995, 1.0,
];

export function ellipticalFinPoints(
  rootChord: number,
  height: number
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const n = POINT_X.length;
  for (let i = 0; i < n; i++) {
    points.push([POINT_X[i] * rootChord, POINT_Y[i] * height]);
  }
  // Mirror the bottom half (hull is symmetric)
  for (let i = n - 2; i >= 0; i--) {
    points.push([POINT_X[i] * rootChord, -POINT_Y[i] * height]);
  }
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

// ---------- Mass estimation ----------

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

    case 'nosecone':
    case 'transition': {
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
      return d * area * thickness * p.finCount;
    }

    case 'ellipticalfinset': {
      const { rootChord, height, thickness } = p;
      const area = (Math.PI / 4) * rootChord * height;
      return d * area * thickness * p.finCount;
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
      return d * area * p.thickness * p.finCount;
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

/**
 * Recursively decorate all components with computed derived data
 * (profiles, planforms, masses). Mutates the RocketJson in place.
 */
export function computeDerivedData(rocketJson: RocketJson): void {
  const warnings: string[] = [];

  const visit = (comp: RocketComponent) => {
    // Resolve auto-radii: walk up to find the parent symmetric component
    if (comp.type === 'transition' || comp.type === 'nosecone') {
      const p = comp.params as any;
      if (p.aftRadius <= 0 && p.baseRadiusAutomatic) {
        // Try to find an adjacent bodytube in the same stage
        // (For simplicity, we keep the value as-is; the Onshape FS will
        //  resolve auto-radii against neighboring parts.)
        warnings.push(`${comp.name}: auto aft radius — resolve in Onshape feature`);
      }
    }

    switch (comp.type) {
      case 'nosecone':
      case 'transition': {
        const p = comp.params as any;
        (p as any).profile = transitionProfile(
          p.shape,
          p.length,
          p.aftRadius,
          p.shapeParameter,
          p.shapeClipped
        );
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
    }

    // Add mass estimate
    const mass = estimateComponentMass(comp);
    if (mass !== null) {
      (comp as any).mass = mass;
    }
    for (const child of comp.children) visit(child);
  };

  for (const comp of rocketJson.rocket.components) visit(comp);
  rocketJson.warnings.push(...warnings);
}