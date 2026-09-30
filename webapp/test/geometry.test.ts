import { describe, it, expect } from 'vitest';
import {
  transitionRadius,
  transitionProfile,
  innerNoseTransitionProfile,
  symmetricProfile,
  shoulderProfile,
  trapezoidFinPoints,
  ellipticalFinPoints,
  tubeFinTouchingRadius,
  finMountRadius,
  freeformFinLength,
  estimateComponentMass,
  computeDerivedData,
} from '../src/geometry';
import { validateRocketJson } from '../src/validation';
import { shouldAutoDownload } from '../src/storage';
import type { RocketComponent, RocketJson } from '../src/types';

/**
 * `estimateComponentMass` returns null for a component it cannot size.  Tests
 * that assert on a specific mass want the number, and a silent null would make
 * every comparison below vacuously true, so it is asserted away once here rather
 * than at each call site.
 */
function massOf(component: RocketComponent): number {
  const mass = estimateComponentMass(component);
  expect(mass).not.toBeNull();
  return mass as number;
}

describe('validateRocketJson', () => {
  it('blocks automatic download for medium or higher warnings', () => {
    expect(shouldAutoDownload([{ severity: 'low' }, { severity: 'info' }])).toBe(true);
    expect(shouldAutoDownload([{ severity: 'medium' }])).toBe(false);
    expect(shouldAutoDownload([{ severity: 'high' }])).toBe(false);
    expect(shouldAutoDownload([{ severity: 'error' }])).toBe(false);
  });

  it('ranks warnings by severity and keeps high and medium distinct', () => {
    const component: RocketComponent = {
      type: 'bodytube', name: 'Body tube', id: 'body', children: [], params: {
        length: 0.2, outerRadius: 0, thickness: 0, filled: false, isMotorMount: false,
      } as any, position: { instanceCount: 1 } as any,
    };
    component.color = { red: 1, green: 1, blue: 1, alpha: 0 };
    const json: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: 'test', designer: '', revision: '', designType: 'original',
        kitName: '', referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [component],
      },
      warnings: [],
    };

    validateRocketJson(json);
    const severities = json.warningDetails?.map((warning) => warning.severity);
    expect(severities).toEqual(expect.arrayContaining(['high', 'medium', 'low']));
    expect(severities?.indexOf('high')).toBeLessThan(severities?.indexOf('medium') ?? -1);
    expect(severities?.indexOf('medium')).toBeLessThan(severities?.indexOf('low') ?? -1);
  });
  it('does not warn about a resolved automatic inner radius', () => {
    const ring: RocketComponent = {
      type: 'centeringring', name: 'Ring', id: 'ring', children: [], params: {
        length: 0.01, outerRadius: 0.02, innerRadius: 0.01, autoInnerRadius: true, thickness: 0,
        clusterConfiguration: 'single', clusterScale: 1, clusterRotation: 0, isMotorMount: false,
      } as any, position: { instanceCount: 1 } as any,
    };
    const json: RocketJson = {
      schemaVersion: '1.0',
      rocket: { name: 'test', designer: '', revision: '', designType: 'original', kitName: '', referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI', components: [ring] },
      warnings: [],
    };
    validateRocketJson(json);
    expect(json.warningDetails?.some((warning) => warning.message.includes('Automatic inner radius could not be resolved'))).toBe(false);
  });

  it('does not require a separate mass when material density can derive it', () => {
    const component: RocketComponent = {
      type: 'bodytube', name: 'Body tube', id: 'body', children: [], params: {
        length: 0.2, outerRadius: 0.03, thickness: 0.001, filled: false, isMotorMount: false,
      } as any, position: {} as any,
      material: { name: 'Cardboard', type: 'bulk', density: 680, shearModulus: 0, group: '' },
    };
    component.color = { red: 1, green: 1, blue: 1, alpha: 0 };
    const json: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: 'test', designer: '', revision: '', designType: 'original',
        kitName: '', referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [component],
      },
      warnings: [],
    };

    validateRocketJson(json);
    expect(json.warningDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'low', message: expect.stringContaining('Opacity is 0') }),
    ]));
    expect(json.warningDetails?.some((warning) => warning.message.includes('Mass is not defined'))).toBe(false);
  });
});

describe('transitionRadius', () => {
  const r = 0.05;
  const L = 0.2;

  it('returns 0 at x=0 and radius at x=length for all shapes', () => {
    const shapes = ['conical', 'ogive', 'ellipsoid', 'power', 'parabolic', 'haack'] as const;
    for (const shape of shapes) {
      expect(transitionRadius(shape, 0, r, L, 1)).toBeCloseTo(0, 6);
      expect(transitionRadius(shape, L, r, L, 1)).toBeCloseTo(r, 6);
    }
  });

  it('conical is linear', () => {
    expect(transitionRadius('conical', L / 2, r, L, 1)).toBeCloseTo(r / 2, 6);
  });

  it('ellipsoid grows from the tip and is tangent at the base (correct orientation)', () => {
    // OpenRocket scales x by radius/length then intersects a circle radius r:
    //   x' = x·r/L  →  z = sqrt(2·r·x' − x'²)  ⇒  z = r·√(2t − t²), t = x/L
    expect(transitionRadius('ellipsoid', L / 2, r, L, 1)).toBeCloseTo(r * Math.sqrt(3) / 2, 6);
    // A quarter-ellipse dome: near the fore tip TIN, wide at the base — the exact
    // opposite of the old (mirrored) r·√(1 − t²), which bulged at the tip.
    expect(transitionRadius('ellipsoid', L * 0.25, r, L, 1)).toBeCloseTo(
      r * Math.sqrt(2 * 0.25 - 0.25 * 0.25),
      6
    );
    expect(transitionRadius('ellipsoid', L * 0.1, r, L, 1)).toBeCloseTo(
      r * Math.sqrt(2 * 0.1 - 0.01),
      6
    );
    expect(transitionRadius('ellipsoid', L * 0.1, r, L, 1)).toBeLessThan(r * 0.5);
    // Base is full radius with a horizontal (dome) tangent.
    expect(transitionRadius('ellipsoid', L, r, L, 1)).toBeCloseTo(r, 6);
  });

  it('power with p=1 is linear', () => {
    expect(transitionRadius('power', L / 2, r, L, 1)).toBeCloseTo(r / 2, 6);
  });

  it('power with p=2 is quadratic', () => {
    expect(transitionRadius('power', L / 2, r, L, 2)).toBeCloseTo(r / 4, 6);
  });

  it('ogive with shape parameter 0 is a cone (linear), like OpenRocket', () => {
    // OpenRocket degenerates ogive to conical when param < 0.001.
    expect(transitionRadius('ogive', L / 2, r, L, 0)).toBeCloseTo(r / 2, 6);
    // secant-ogive eccentricity: p ≈ 0 → straight sides at any point
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(transitionRadius('ogive', L * x, r, L, 1e-4)).toBeCloseTo(r * x, 6);
    }
    // ...and p=0 behaves identically to the conical shape.
    expect(transitionRadius('ogive', L / 3, r, L, 0)).toBeCloseTo(
      transitionRadius('conical', L / 3, r, L, 0),
      6
    );
  });

  it('ogive with shape parameter 1 is a tangent ogive (matches the osculating circle)', () => {
    // param == 1 → R = (r² + L²) / (2r), i.e. the circle that is tangent at
    // the aft end. Verify the midpoint against that exact tangent-ogive value
    // (OpenRocket's getRadius at x=L/2 for r=0.05, L=0.2).
    const R = (r * r + L * L) / (2 * r);
    const y0 = Math.sqrt(R * R - L * L);
    const expected = Math.sqrt(R * R - (L - L / 2) * (L - L / 2)) - y0;
    expect(transitionRadius('ogive', L / 2, r, L, 1)).toBeCloseTo(expected, 6);

    // The tangent ogive is essentially flat at the aft end (smooth transition
    // to the body tube): the radius barely changes over the last 1% of length.
    expect(transitionRadius('ogive', L * 0.99, r, L, 1)).toBeCloseTo(r, 4);
  });

  it('ogive shape parameter changes the shape (secant vs tangent ogive)', () => {
    // p < 1 is a secant ogive, p = 1 is tangent — they must trace different
    // profiles through the same endpoints.
    const p5 = transitionRadius('ogive', L / 2, r, L, 0.5);
    const p1 = transitionRadius('ogive', L / 2, r, L, 1);
    expect(p5).not.toBeCloseTo(p1, 4);
    // A secant ogive curves inward relative to the tangent ogive near the tip.
    expect(transitionRadius('ogive', L * 0.25, r, L, 0.5)).toBeLessThan(
      transitionRadius('ogive', L * 0.25, r, L, 1)
    );
  });

  it('ogive endpoints hold for every shape parameter', () => {
    for (const p of [0, 0.2, 0.5, 0.9, 1]) {
      expect(transitionRadius('ogive', 0, r, L, p)).toBeCloseTo(0, 6);
      expect(transitionRadius('ogive', L, r, L, p)).toBeCloseTo(r, 6);
    }
  });

  it('clamps to [0, radius]', () => {
    expect(transitionRadius('conical', -1, r, L, 1)).toBe(0);
    expect(transitionRadius('conical', L + 1, r, L, 1)).toBe(r);
  });

  it('handles zero length', () => {
    expect(transitionRadius('conical', 0.1, r, 0, 1)).toBe(r);
  });
});

describe('transitionProfile narrowing transitions', () => {
  // The aft transition of the design under test: fore 0.0168275 > aft 0.0123952.
  const LEN = 0.01905;
  const AFT = 0.0123952;
  const FORE = 0.0168275;

  // Verbatim port of OpenRocket's Transition.Shape.Ogive.getRadius composed with
  // Transition.getRadius, including the narrowing mirror.
  const sq = (v: number) => v * v;
  function openRocketOgive(x: number, fore: number, aft: number, length: number, p: number) {
    if (x < 0) return fore;
    if (x >= length) return aft;
    let r1 = fore;
    let r2 = aft;
    if (r1 === r2) return r1;
    if (r1 > r2) {
      x = length - x;
      const t = r1;
      r1 = r2;
      r2 = t;
    }
    const radius = r2 - r1;
    let len = length;
    let xx = x;
    if (len < radius) {
      xx = (xx * radius) / len;
      len = radius;
    }
    if (p < 1e-3) return r1 + (xx * radius) / len;
    const R = Math.sqrt(
      (sq(len) + sq(radius)) * (sq((2 - p) * len) + sq(p * radius)) / (4 * sq(p * radius))
    );
    const Lc = len / p;
    const y0 = Math.sqrt(Math.max(R * R - Lc * Lc, 0));
    return r1 + (Math.sqrt(Math.max(R * R - (Lc - xx) * (Lc - xx), 0)) - y0);
  }

  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    it(`matches OpenRocket exactly for a narrowing ogive, shape parameter ${p}`, () => {
      const prof = transitionProfile('ogive', LEN, AFT, p, false, 50, FORE);
      prof.forEach(([radius], i) => {
        const t = i / (prof.length - 1);
        expect(radius).toBeCloseTo(openRocketOgive(t * LEN, FORE, AFT, LEN, p), 9);
      });
    });
  }

  it('hits both end radii and decreases monotonically fore to aft', () => {
    const prof = transitionProfile('ogive', LEN, AFT, 1, false, 50, FORE);
    expect(prof[0][0]).toBeCloseTo(FORE, 9);
    expect(prof[prof.length - 1][0]).toBeCloseTo(AFT, 9);
    for (let i = 1; i < prof.length; i++) {
      expect(prof[i][0]).toBeLessThanOrEqual(prof[i - 1][0] + 1e-12);
    }
  });

  it('a narrowing ogive is the mirror of the equivalent widening one', () => {
    const delta = FORE - AFT;
    const narrowing = transitionProfile('ogive', LEN, AFT, 1, false, 50, FORE);
    const widening = transitionProfile('ogive', LEN, delta, 1, false, 50, 0);
    // Both profiles run fore -> aft, and the mirror maps the narrowing fore end
    // onto the widening aft end, so compare against the reversed series.
    narrowing.forEach(([radius], i) => {
      expect(radius - AFT).toBeCloseTo(widening[widening.length - 1 - i][0], 9);
    });
  });
});

describe('clipped transitions', () => {
  it('hit both end radii, widening and narrowing', () => {
    const cases: Array<[string, number, number, number]> = [
      ['widening ogive', 1.0, 1.0, 0.5],
      ['narrowing ogive', 1.0, 0.5, 1.0],
    ];
    for (const [, LEN, AFT, FORE] of cases) {
      const prof = transitionProfile('ogive', LEN, AFT, 1, true, 50, FORE);
      // The clip is solved to 0.1 mm (OpenRocket's CLIP_PRECISION), so the end
      // points land just inside the nominal radii rather than exactly on them.
      expect(prof[0][0]).toBeCloseTo(FORE, 3);
      expect(prof[prof.length - 1][0]).toBeCloseTo(AFT, 3);
    }
  });

  it('is a slice of a larger shape, not the unclipped profile', () => {
    const LEN = 0.8;
    const AFT = 1.0;
    const FORE = 0.3;
    const clipped = transitionProfile('ogive', LEN, AFT, 1, true, 50, FORE);
    const unclipped = transitionProfile('ogive', LEN, AFT, 1, false, 50, FORE);
    // Both share their end radii but bow differently in between: a clipped
    // transition is the tail of a full ogive, not the small shape offset upward.
    const diff = clipped.map(([r], i) => Math.abs(r - unclipped[i][0]));
    expect(Math.max(...diff)).toBeGreaterThan(0.01);
    expect(clipped[0][0]).toBeCloseTo(unclipped[0][0], 3);
    expect(clipped[clipped.length - 1][0]).toBeCloseTo(unclipped[clipped.length - 1][0], 6);
  });

  it('a zero fore radius degenerates to no clip', () => {
    const clipped = transitionProfile('ogive', 0.5, 0.05, 1, true, 20, 0);
    const plain = transitionProfile('ogive', 0.5, 0.05, 1, false, 20, 0);
    clipped.forEach(([r], i) => expect(r).toBeCloseTo(plain[i][0], 9));
  });

  it('still reaches both end radii when clipped, for every shape parameter', () => {
    for (const p of [0, 0.2, 0.5, 0.9, 1]) {
      const prof = transitionProfile('ogive', 0.8, 1.0, p, true, 50, 0.3);
      expect(prof[0][0]).toBeCloseTo(0.3, 3);
      expect(prof[prof.length - 1][0]).toBeCloseTo(1.0, 6);
    }
  });
});

describe('transitionProfile', () => {
  it('produces 51 points for 50 steps', () => {
    const pts = transitionProfile('conical', 0.2, 0.05, 1);
    expect(pts.length).toBe(51);
  });

  it('is [radius, length] with the aft end at y=0 and the fore end at y=length', () => {
    const pts = transitionProfile('ogive', 0.2, 0.05, 1);
    // aft (last point): x = aft radius 0.05, y = 0
    expect(pts[50][0]).toBeCloseTo(0.05, 6);
    expect(pts[50][1]).toBeCloseTo(0, 6);
    // fore (first point): x = fore radius (0 for a nose cone), y = length
    expect(pts[0][0]).toBeCloseTo(0, 6);
    expect(pts[0][1]).toBeCloseTo(0.2, 6);
  });

  it('y values decrease along the profile (fore at y+, aft at y=0)', () => {
    const pts = transitionProfile('haack', 0.2, 0.05, 1);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][1]).toBeLessThan(pts[i - 1][1]);
    }
  });

  it('honors a non-zero fore radius', () => {
    const pts = transitionProfile('conical', 0.2, 0.05, 1, false, 50, 0.03);
    expect(pts[0][0]).toBeCloseTo(0.03, 6);
    expect(pts[50][0]).toBeCloseTo(0.05, 6);
  });

  it('x values (radii) are monotonic from fore to aft', () => {
    const pts = transitionProfile('conical', 0.2, 0.05, 1, false, 50, 0.02);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0]).toBeGreaterThanOrEqual(pts[i - 1][0]);
    }
  });
});

describe('innerNoseTransitionProfile', () => {
  it('returns the intercept + fore flag when the fore tip goes negative', () => {
    // A full conical nose (tip radius 0) with a real wall: the inner offset goes
    // negative at the tip, so the profile is clipped at the radius-0 intercept.
    const outer = transitionProfile('conical', 0.2, 0.05, 1);
    const res = innerNoseTransitionProfile(outer, 0.004);
    expect(res.foreNegative).toBe(true);
    expect(res.aftNegative).toBe(false);
    expect(res.foreIntercept).not.toBeNull();
    // Intercept sits on the axis and is the first point of the kept profile.
    expect(res.foreIntercept![0]).toBeCloseTo(0, 6);
    expect(res.profile[0][0]).toBeCloseTo(0, 6);
    // The kept profile stops short of the outer fore tip (y = length).
    expect(res.profile[0][1]).toBeLessThan(outer[0][1]);
    // No point is ever negative, and every radius stays at or below the aft radius.
    for (const pt of res.profile) {
      expect(pt[0]).toBeGreaterThanOrEqual(0);
      expect(pt[0]).toBeLessThanOrEqual(outer[outer.length - 1][0] + 1e-9);
    }
  });

  it('flags aft clipping when the aft end goes negative', () => {
    // A profile that tapers toward the aft end (smallest radius at aft) with a
    // wall thicker than that radius — forces a negative at the aft end.
    const outer: Array<[number, number]> = [
      [0.05, 0.2],
      [0.02, 0.1],
      [0.0, 0.0],
    ];
    const res = innerNoseTransitionProfile(outer, 0.04);
    expect(res.foreNegative).toBe(false);
    expect(res.aftNegative).toBe(true);
    expect(res.aftIntercept).not.toBeNull();
    expect(res.aftIntercept![0]).toBeCloseTo(0, 6);
    // The kept profile ends at the aft intercept on the axis.
    expect(res.profile[res.profile.length - 1][0]).toBeCloseTo(0, 6);
  });

  it('insets a vertical wall by exactly the thickness (no clipping)', () => {
    // Constant-radius (vertical) wall: the inward normal is purely radial, so
    // the inner radius is outer − thickness at every point and nothing is clipped.
    const r = 0.05;
    const thickness = 0.01;
    const outer: Array<[number, number]> = [
      [r, 0.2],
      [r, 0.1],
      [r, 0.0],
    ];
    const res = innerNoseTransitionProfile(outer, thickness);
    expect(res.foreNegative).toBe(false);
    expect(res.aftNegative).toBe(false);
    expect(res.foreIntercept).toBeNull();
    expect(res.aftIntercept).toBeNull();
    expect(res.profile.length).toBe(outer.length);
    for (let i = 0; i < res.profile.length; i++) {
      expect(res.profile[i][0]).toBeCloseTo(r - thickness, 6);
    }
  });

  it('handles a negative or zero thickness as a no-op', () => {
    const outer = transitionProfile('ellipsoid', 0.2, 0.05, 1);
    const res = innerNoseTransitionProfile(outer, -0.9);
    expect(res.foreNegative).toBe(false);
    expect(res.aftNegative).toBe(false);
    expect(res.foreIntercept).toBeNull();
    expect(res.aftIntercept).toBeNull();
    expect(res.profile.length).toBe(outer.length);
    for (let i = 0; i < res.profile.length; i++) {
      expect(res.profile[i][0]).toBeCloseTo(outer[i][0], 6);
      expect(res.profile[i][1]).toBeCloseTo(outer[i][1], 6);
    }
  });
});

describe('symmetricProfile (body only, walls and caps)', () => {
  const base = {
    shape: 'conical' as const,
    shapeParameter: 1,
    shapeClipped: false,
    length: 0.1,
    foreRadius: 0.02,
    aftRadius: 0.015,
    thickness: 0.002,
    filled: false,
    shoulderFore: { radius: 0, length: 0, thickness: 0, capped: false },
    shoulderAft: { radius: 0, length: 0, thickness: 0, capped: false },
  };
  const last = (pts: Array<[number, number]>) => pts[pts.length - 1];

  it('ignores the shoulders entirely: the section spans the body alone', () => {
    // Shoulders are their own polygons now (see shoulderProfile below). The
    // body's section must not move by a single micron because a shoulder is
    // present -- that coupling is exactly what the revolve choked on.
    const plain = symmetricProfile({ ...base } as any);
    const withShoulders = symmetricProfile({
      ...base,
      shoulderFore: { radius: 0.021, length: 0.012, thickness: 0.003, capped: false },
      shoulderAft: { radius: 0.014, length: 0.02, thickness: 0.001, capped: true },
    } as any);
    expect(withShoulders.profile).toEqual(plain.profile);
    expect(withShoulders.innerProfile).toEqual(plain.innerProfile);
    // Aft at y = 0, fore at y = length. Nothing outside.
    expect(Math.min(...plain.profile.map((p) => p[1]))).toBeCloseTo(0, 9);
    expect(Math.max(...plain.profile.map((p) => p[1]))).toBeCloseTo(base.length, 9);
  });

  it('reports a filled component as solid with a two-point axis bore', () => {
    const r = symmetricProfile({ ...base, filled: true, thickness: -1 } as any);
    expect(r.innerIsAxis).toBe(true);
    expect(r.innerProfile).toHaveLength(2);
    expect(r.innerProfile.every((p) => p[0] === 0)).toBe(true);
    expect(r.innerProfile[0][1]).toBeCloseTo(r.profile[0][1], 9);
    expect(last(r.innerProfile)[1]).toBeCloseTo(last(r.profile)[1], 9);
  });

  it('keeps a walled component off the axis so its ends can be capped', () => {
    const r = symmetricProfile({ ...base } as any);
    expect(r.innerIsAxis).toBe(false);
    // The wall is offset along the surface normal, so on this slope the bore is
    // slightly WIDER than radius − thickness: a perpendicular 2 mm wall only
    // spans 2·cos(tilt) radially.  It must still be close, and clearly positive.
    const bore = last(r.innerProfile)[0];
    expect(bore).toBeGreaterThan(0);
    expect(bore).toBeGreaterThanOrEqual(0.015 - 0.002);
    // ...and the bore is cut square on the end plane, not left leaning.
    expect(last(r.innerProfile)[1]).toBe(0);
  });

  it('keeps the solid nose cone a bore dies out into, as a LINE on the axis', () => {
    // A wall thicker than the local radius makes the bore die out partway along
    // the component, and the section is SOLID from there to the end. That solid
    // length is the inner boundary, so the outline must meet the axis along a
    // segment, not at a single vertex -- a lone vertex is the shape `opRevolve`
    // refuses, with REVOLVE_FAILED.
    //
    // This is Bell X-1's main transition: a 2 mm wall on a 1.143 mm fore radius,
    // 127 mm long. The bore reaches the axis ~7 mm short of the fore end.
    const r = symmetricProfile({
      ...base,
      length: 0.127,
      foreRadius: 0.001143,
      aftRadius: 0.0168275,
      thickness: 0.002,
    } as any);

    const onAxis = r.innerProfile.filter((p) => Math.abs(p[0]) < 1e-12);
    expect(onAxis.length).toBeGreaterThanOrEqual(2);
    // The end plane's own axis point, and the intercept short of it, so the two
    // bound a real segment of solid nose cone.
    expect(onAxis[0][1]).toBeCloseTo(0.127, 6);
    expect(onAxis[onAxis.length - 1][1]).toBeLessThan(0.127);
    expect(0.127 - onAxis[onAxis.length - 1][1]).toBeGreaterThan(1e-3);
    // The component is not solid overall, so it is still drawn as a real bore.
    expect(r.innerIsAxis).toBe(false);
  });

  it('leaves a bore that never reaches the axis pinned to the end planes', () => {
    // The complementary case: a thin-walled component keeps its bore off the
    // axis at both ends, so those ends ARE squared off on the planes.  The fix
    // above must not have stopped doing that.
    const r = symmetricProfile({
      ...base,
      length: 0.01905,
      foreRadius: 0.0123952,
      aftRadius: 0.0162941,
      thickness: 0.000254,
    } as any);
    expect(r.innerProfile.every((p) => Math.abs(p[0]) > 1e-12)).toBe(true);
    expect(r.innerProfile[0][1]).toBeCloseTo(0.01905, 6);
    expect(last(r.innerProfile)[1]).toBe(0);
  });

  it('clips the bore onto the axis where the wall is thicker than the local radius', () => {
    // A thin nose cone with a 2 mm wall: the bore runs out before the tip, so
    // the section must reach the axis rather than invert.
    const r = symmetricProfile({
      ...base,
      shape: 'ogive',
      foreRadius: 0,
      aftRadius: 0.02,
      length: 0.1,
      thickness: 0.002,
    } as any);
    expect(r.innerProfile[0][0]).toBe(0);
    expect(r.innerProfile.every((p) => p[0] >= 0)).toBe(true);
  });
});

// Every shoulder/wall/cap combination, shared by the body and shoulder tests
// below. The invariant is the one that caught two real bugs: a reversed y makes
// skFitSpline fold back on itself, and a bore outside the outer surface
// self-intersects the revolve.
const SHOULDER_VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['no shoulders', {}],
  ['aft, tube', { shoulderAft: { radius: 0.014, length: 0.02, thickness: 0.001, capped: false } }],
  ['aft, solid', { shoulderAft: { radius: 0.014, length: 0.02, thickness: 0, capped: false } }],
  ['aft, capped', { shoulderAft: { radius: 0.014, length: 0.02, thickness: 0.001, capped: true } }],
  ['fore, capped', { shoulderFore: { radius: 0.021, length: 0.012, thickness: 0.001, capped: true } }],
  ['fore, solid', { shoulderFore: { radius: 0.021, length: 0.012, thickness: 0, capped: false } }],
  // Wider than the body end it butts against: the step goes OUT, not in.
  ['aft, wider than body', { shoulderAft: { radius: 0.03, length: 0.02, thickness: 0.001, capped: false } }],
  [
    'both, mixed',
    {
      shoulderFore: { radius: 0.021, length: 0.012, thickness: 0.003, capped: false },
      shoulderAft: { radius: 0.014, length: 0.02, thickness: 0.001, capped: true },
    },
  ],
  ['filled', { filled: true, thickness: -1 }],
];

const PROFILE_BASE = {
  shape: 'conical' as const,
  shapeParameter: 1,
  shapeClipped: false,
  length: 0.1,
  foreRadius: 0.02,
  aftRadius: 0.015,
  thickness: 0.002,
  filled: false,
  shoulderFore: { radius: 0, length: 0, thickness: 0, capped: false },
  shoulderAft: { radius: 0, length: 0, thickness: 0, capped: false },
};

/** Assert one section satisfies the shared profile invariants. */
function expectWellFormed(
  label: string,
  profile: Array<[number, number]>,
  inner: Array<[number, number]>
) {
  const maxOuter = Math.max(...profile.map((p) => p[0]));
  for (const pts of [profile, inner]) {
    expect(pts.length, label).toBeGreaterThan(1);
    for (const [radius] of pts) {
      expect(Number.isFinite(radius), label).toBe(true);
      expect(radius, label).toBeGreaterThanOrEqual(0);
      expect(radius, label).toBeLessThanOrEqual(maxOuter + 1e-9);
    }
    // y must decrease monotonically: fore -> aft.
    for (let i = 1; i < pts.length; i += 1) {
      expect(pts[i][1], `${label} index ${i}`).toBeLessThanOrEqual(pts[i - 1][1] + 1e-12);
    }
  }
}

describe('profile invariants, body and shoulder alike', () => {
  it('holds for the body section of every variant', () => {
    for (const [label, extra] of SHOULDER_VARIANTS) {
      const r = symmetricProfile({ ...PROFILE_BASE, ...extra } as any);
      expectWellFormed(label, r.profile, r.innerProfile);
    }
  });

  it('holds for every shoulder polygon of every variant', () => {
    for (const [label, extra] of SHOULDER_VARIANTS) {
      for (const which of ['fore', 'aft'] as const) {
        const key = which === 'fore' ? 'shoulderFore' : 'shoulderAft';
        const s = shoulderProfile({ ...PROFILE_BASE, ...extra } as any, which);
        if (s == null) {
          // No shoulder on that end here, so the stored length must be zero.
          expect((extra[key] as any)?.length ?? 0, label).toBe(0);
          continue;
        }
        expectWellFormed(`${label} / ${which}`, s.profile, s.innerProfile);
      }
    }
  });
});

describe('shoulderProfile (one small polygon per shoulder)', () => {
  const last = (pts: Array<[number, number]>) => pts[pts.length - 1];

  it('returns null when the shoulder length is zero', () => {
    // Real files carry a non-zero <aftshoulderradius> with a zero length all over
    // the place; that is "no shoulder" and must add no geometry at all.
    expect(
      shoulderProfile(
        {
          ...PROFILE_BASE,
          shoulderAft: { radius: 0.02, length: 0, thickness: 0.02, capped: false },
        } as any,
        'aft'
      )
    ).toBeNull();
    expect(shoulderProfile({ ...PROFILE_BASE } as any, 'fore')).toBeNull();
  });

  it('places the fore shoulder past the fore end and the aft one before the aft end', () => {
    // Same convention as the body: aft at y=0, fore at y=length, so the
    // FeatureScript's `y -= length` needs no special case for a shoulder.
    const fore = shoulderProfile(
      {
        ...PROFILE_BASE,
        shoulderFore: { radius: 0.021, length: 0.012, thickness: 0.003, capped: false },
      } as any,
      'fore'
    )!;
    expect(fore.profile[0]).toEqual([0.021, 0.112]); // length + shoulder length
    // ...and it comes back to the component's own fore end plane.
    expect(last(fore.profile)[1]).toBeCloseTo(PROFILE_BASE.length, 9);

    const aft = shoulderProfile(
      {
        ...PROFILE_BASE,
        shoulderAft: { radius: 0.014, length: 0.02, thickness: 0.001, capped: false },
      } as any,
      'aft'
    )!;
    expect(last(aft.profile)).toEqual([0.014, -0.02]);
    expect(aft.profile[0][1]).toBeCloseTo(0, 9);
  });

  it('carries the connector step at the body end plane, so the union shares a face', () => {
    // A shoulder radius differing from the component's end radius (20.7645 mm
    // nose cone base vs a 20.2184 mm shoulder, in TestBooster.ork) needs a flat
    // step. It is the shoulder's own job now, and the union depends on it.
    const params = {
      ...PROFILE_BASE,
      aftRadius: 0.0207645,
      shoulderAft: { radius: 0.0202184, length: 0.01905, thickness: 0.002, capped: false },
    };
    const s = shoulderProfile(params as any, 'aft')!;
    // fore -> aft: the body's own aft radius, out to the shoulder, then down it.
    expect(s.profile[0]).toEqual([0.0207645, 0]);
    expect(s.profile[1][0]).toBeCloseTo(0.0202184, 9);
    // The bore is stepped the same way, so the two bodies meet on ONE flat face.
    // It is an AFT shoulder, so it butts against the body's AFT end.
    const bodyInner = symmetricProfile(params as any).innerProfile;
    expect(s.innerProfile[0]).toEqual(last(bodyInner));
  });

  it('lets a SOLID shoulder reach the axis, so its end disc overlaps the body face', () => {
    // A solid shoulder has no bore of its own. Its end face at the join is
    // therefore a full disc, which OVERLAPS the walled body's end annulus
    // rather than matching it -- and a solid body already relies on exactly
    // that overlap to union, so the two cases are consistent.
    const params = {
      ...PROFILE_BASE,
      aftRadius: 0.0207645,
      shoulderAft: { radius: 0.0202184, length: 0.01905, thickness: 0.0202184, capped: false },
    };
    const s = shoulderProfile(params as any, 'aft')!;
    expect(s.innerIsAxis).toBe(true);
    expect(s.innerProfile[0][0]).toBe(0);
    // The body's own bore is non-zero here, so the two really are different
    // faces -- this is the case the step deliberately does NOT match.
    const bodyBore = last(symmetricProfile(params as any).innerProfile)[0];
    expect(bodyBore).toBeGreaterThan(0);
  });

  it('gives the shoulder its own thickness, independent of the body wall', () => {
    // TestBooster.ork's transition: body thickness 0.002, fore shoulder 0.003.
    const s = shoulderProfile(
      {
        ...PROFILE_BASE,
        shape: 'ellipsoid',
        foreRadius: 0.02075,
        aftRadius: 0.015,
        shoulderFore: { radius: 0.02075, length: 0.012, thickness: 0.003, capped: false },
      } as any,
      'fore'
    )!;
    // Bore at the shoulder is 0.02075 − 0.003, NOT the body's 0.02075 − 0.002.
    expect(s.innerProfile[0][0]).toBeCloseTo(0.01775, 9);
    // ...and it steps to the body's own wall where they meet.
    const bodyBore = 0.02075 - 0.002;
    expect(s.innerProfile.some((p) => Math.abs(p[0] - bodyBore) < 1e-9)).toBe(true);
  });

  it('treats a zero-thickness or full-radius shoulder as solid', () => {
    const solid = shoulderProfile(
      {
        ...PROFILE_BASE,
        shoulderAft: { radius: 0.014, length: 0.02, thickness: 0, capped: false },
      } as any,
      'aft'
    )!;
    expect(solid.innerIsAxis).toBe(true);
    // Bore runs on the axis through the shoulder.
    expect(last(solid.innerProfile)[0]).toBeCloseTo(0, 9);

    // A tube, by contrast, keeps a bore of radius − thickness.
    const tube = shoulderProfile(
      {
        ...PROFILE_BASE,
        shoulderAft: { radius: 0.014, length: 0.02, thickness: 0.001, capped: false },
      } as any,
      'aft'
    )!;
    expect(tube.innerIsAxis).toBe(false);
    expect(last(tube.innerProfile)[0]).toBeCloseTo(0.013, 9);
  });

  it('closes a capped shoulder bore with a disc of the shoulder wall thickness', () => {
    const open = shoulderProfile(
      {
        ...PROFILE_BASE,
        shoulderAft: { radius: 0.0162941, length: 0.0381, thickness: 0.0032512, capped: false },
      } as any,
      'aft'
    )!;
    // Uncapped: the end face spans only the wall, so the bore reaches the end.
    expect(last(open.innerProfile)).toEqual([0.0162941 - 0.0032512, -0.0381]);

    const capped = shoulderProfile(
      {
        ...PROFILE_BASE,
        shoulderAft: { radius: 0.0162941, length: 0.0381, thickness: 0.0032512, capped: true },
      } as any,
      'aft'
    )!;
    // Capped: the bore stops short of the end and drops onto the axis there.
    const capStart = -(0.0381 - 0.0032512);
    expect(capped.innerProfile.some((p) => p[0] === 0 && Math.abs(p[1] - capStart) < 1e-9)).toBe(
      true
    );
    expect(last(capped.innerProfile)).toEqual([0, -0.0381]);
  });

  it('caps at the FREE end, whichever end that is', () => {
    // The fore shoulder's cap sits at y = length + sl, not at the join, and the
    // bore then runs aft to the join -- so the LAST bore point is the body's
    // bore at the join, not the axis.
    const params = {
      ...PROFILE_BASE,
      shoulderFore: { radius: 0.02, length: 0.012, thickness: 0.003, capped: true },
    };
    const s = shoulderProfile(params as any, 'fore')!;
    expect(s.innerProfile[0]).toEqual([0, PROFILE_BASE.length + 0.012]);
    // The cap is a disc of the shoulder's own 3 mm wall, so the bore resumes
    // 3 mm in from the free end.
    expect(s.innerProfile[1]).toEqual([0, PROFILE_BASE.length + 0.012 - 0.003]);
    expect(s.innerProfile[2][0]).toBeCloseTo(0.02 - 0.003, 9);
    // ...and the bore's aft end is the body's own bore at the FORE end plane,
    // which is what makes the two end faces the same annulus for the union.
    const bodyInner = symmetricProfile(params as any).innerProfile;
    expect(last(s.innerProfile)).toEqual(bodyInner[0]);
  });
});

describe('trapezoidFinPoints', () => {
  it('produces a closed planform with 4 corners', () => {
    const pts = trapezoidFinPoints(0.1, 0.05, 0.02, 0.08);
    expect(pts.length).toBeGreaterThan(4);
    // First and last points are at the root
    expect(pts[0][1]).toBeCloseTo(0, 6);
    expect(pts[pts.length - 1][1]).toBeCloseTo(0, 6);
    // Max y is the height
    const maxY = Math.max(...pts.map((p) => p[1]));
    expect(maxY).toBeCloseTo(0.08, 6);
  });

  it('handles zero tip chord (delta fin)', () => {
    const pts = trapezoidFinPoints(0.1, 0, 0.05, 0.08);
    expect(pts.length).toBeGreaterThan(4);
  });
});

describe('ellipticalFinPoints', () => {
  it('produces OpenRocket\'s 31-point half-ellipse', () => {
    const pts = ellipticalFinPoints(0.1, 0.08);
    expect(pts).toHaveLength(31);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[30][0]).toBeCloseTo(0.1, 8);
    expect(pts[30][1]).toBeCloseTo(0, 8);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(0.08, 6);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0]).toBeGreaterThanOrEqual(pts[i - 1][0]);
    }
  });
});

describe('tubeFinTouchingRadius', () => {
  it('returns body radius for 1 fin', () => {
    expect(tubeFinTouchingRadius(0.05, 1)).toBeCloseTo(0.05, 6);
  });

  it('computes touching radius for 3 fins', () => {
    // r_tube = r * sin(π/3) / (1 - sin(π/3))
    const sin60 = Math.sin(Math.PI / 3);
    const expected = (0.05 * sin60) / (1 - sin60);
    expect(tubeFinTouchingRadius(0.05, 3)).toBeCloseTo(expected, 6);
  });

  it('touching radius decreases as fin count increases', () => {
    const r3 = tubeFinTouchingRadius(0.05, 3);
    const r4 = tubeFinTouchingRadius(0.05, 4);
    expect(r4).toBeLessThan(r3);
  });
});

describe('freeformFinLength', () => {
  it('returns 0 for empty input', () => {
    expect(freeformFinLength([])).toBe(0);
    expect(freeformFinLength(null as any)).toBe(0);
  });

  it('is the max x distance between any two points', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [0.05, 0.02],
      [0.03, 0.04],
      [0.08, 0.03], // largest x
    ];
    expect(freeformFinLength(pts)).toBeCloseTo(0.08, 6);
  });

  it('ignores a swept leading edge for the root chord (non-monotonic x)', () => {
    // The leading edge sweeps FORWARD past the fore root point (x = -0.02).
    // That does not lengthen the fin: the root chord runs from the fore root
    // point (0) to the aft root point (0.06), so the length is 0.06 — not the
    // 0.08 x-span, which would wrongly include the forward-swept tip.
    const pts: Array<[number, number]> = [
      [0, 0],
      [-0.02, 0.02],
      [0.04, 0.04],
      [0.06, 0.0],
    ];
    expect(freeformFinLength(pts)).toBeCloseTo(0.06, 6);
  });
});

describe('finMountRadius', () => {
  function comp(type: string, params: any, position: any = {}): RocketComponent {
    return {
      type: type as RocketComponent['type'],
      name: type,
      id: type + Math.random(),
      material: undefined,
      position: {
        axialMethod: 'top',
        axialOffset: 0,
        position: [0, 0, 0],
        instanceCount: 1,
        instanceSeparation: 0,
        angleOffset: 0,
        angleMethod: 'relative',
        radiusOffset: 0,
        radiusMethod: 'coaxial',
        radialPosition: 0,
        radialDirection: 0,
        ...position,
      },
      params,
      children: [],
    } as RocketComponent;
  }

  it('uses constant radius for a body tube parent', () => {
    const bt = comp('bodytube', { length: 0.2, outerRadius: 0.025 });
    const fin = comp('trapezoidfinset', { rootChord: 0.08 });
    expect(finMountRadius(fin, bt)).toBeCloseTo(0.025, 6);
  });

  it('uses the parent radius at the fin axial position for a transition', () => {
    const trans = comp('transition', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.1,
      foreRadius: 0.01,
      aftRadius: 0.05,
    });
    // Fin mounted at the top (fore) end → radius = fore radius.
    const topFin = comp('trapezoidfinset', { rootChord: 0.02 }, { axialMethod: 'top', axialOffset: 0 });
    expect(finMountRadius(topFin, trans)).toBeCloseTo(0.01, 6);

    // bottom places the fin FRONT one fin-length above the parent's aft end, so
    // x = parentLength − rootChord = 0.08. Conical interpolation over 0.1:
    // 0.01 + (0.08/0.1)·(0.05−0.01) = 0.042.
    const bottomFin = comp('trapezoidfinset', { rootChord: 0.02 }, { axialMethod: 'bottom', axialOffset: 0 });
    expect(finMountRadius(bottomFin, trans)).toBeCloseTo(0.042, 6);
  });

  it('interpolates the transition radius along the fin axial offset', () => {
    const trans = comp('transition', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.1,
      foreRadius: 0.01,
      aftRadius: 0.05,
    });
    // middle centers the fin: x = (parentLength − rootLength)/2 = 0.04.
    // Conical(0.04/0.1): 0.01 + 0.4·(0.05−0.01) = 0.026.
    const midFin = comp('trapezoidfinset', { rootChord: 0.02 }, { axialMethod: 'middle', axialOffset: 0 });
    expect(finMountRadius(midFin, trans)).toBeCloseTo(0.026, 6);
  });

  it('uses the point-derived length to position a freeform fin on a transition', () => {
    const trans = comp('transition', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.1,
      foreRadius: 0.01,
      aftRadius: 0.05,
    });
    // The last point IS the max x here, so the root chord and the x-span agree.
    const fin = comp(
      'freeformfinset',
      {
        points: [
          [0, 0],
          [0.01, 0.02],
          [0.03, 0.02],
        ],
      },
      { axialMethod: 'bottom', axialOffset: 0 }
    );
    // bottom places the fin FRONT one fin-length above the parent's aft end:
    // x = parentLength − finLength = 0.1 − 0.03 = 0.07.
    // Conical(0.07/0.1): 0.01 + 0.7·(0.05−0.01) = 0.038.
    expect(finMountRadius(fin, trans)).toBeCloseTo(0.038, 6);
  });

  it('derives a bottom-positioned freeform fin length as the root chord, not the x-span', () => {
    // Regression (TestBooster.ork): this fin's tip is swept aft past the end of
    // its root, so max(x) − min(x) = 0.098 OVERSTATES the root chord. The
    // correct length is points[n-1].x − points[0].x = 0.0835, which is what
    // `bottom` placement subtracts from the parent length.
    const points: Array<[number, number]> = [
      [0, 0],
      [0.047980779413493546, 0.049425121986694666],
      [0.09798077941349354, 0.049425121986694666],
      [0.03834764987390178, -0.001076132091212649],
      [0.048499999999999995, -0.001669607109398407],
      [0.0738, 0.016048575938417044],
      [0.08345259487976858, -0.00563069149027285],
    ];
    // The x-span that the old (buggy) implementation returned.
    const xSpan = Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x));
    expect(xSpan).toBeCloseTo(0.09798077941349354, 12);

    // The root chord: first point to last point.
    expect(freeformFinLength(points)).toBeCloseTo(0.08345259487976858, 12);
    // Strictly shorter than the span for this swept outline.
    expect(freeformFinLength(points)).toBeLessThan(xSpan);

    const trans = comp('transition', {
      shape: 'ellipsoid',
      shapeParameter: 1,
      shapeClipped: true,
      length: 0.08636,
      foreRadius: 0.02075,
      aftRadius: 0.015,
    });
    const fin = comp('freeformfinset', { points }, {
      axialMethod: 'bottom',
      axialOffset: 0.010471815466275153,
      radiusMethod: 'surface',
    });
    trans.children = [fin];

    const json: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: 'test', designer: '', revision: '', designType: 'original',
        kitName: '', referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [trans],
      },
      warnings: [],
    };
    computeDerivedData(json);

    // The derived length is the root chord, not the bounding span.
    expect((fin.params as any).length).toBeCloseTo(0.08345259487976858, 12);

    // bottom: fore position = offset + (parentLength − finLength)
    //        = 0.010472 + (0.08636 − 0.083453) = 0.013379, which now sits
    // INSIDE the parent instead of 1.15 mm in front of its fore end.
    const forePosition = 0.010471815466275153 + (0.08636 - 0.08345259487976858);
    expect(forePosition).toBeGreaterThan(0);
    expect(forePosition).toBeLessThan(0.08636);
  });

  it('derives a freeform fin root chord from only the first and last points', () => {
    // A tip that reaches further aft than the root must not lengthen the fin.
    expect(freeformFinLength([[0, 0], [0.05, 0.03], [0.09, 0.03], [0.04, 0]])).toBeCloseTo(0.04, 12);
    // Root chord is x-span when the outline is not swept aft.
    expect(freeformFinLength([[0, 0], [0.02, 0.03], [0.06, 0.03], [0.05, 0]])).toBeCloseTo(0.05, 12);
    // A single point has no chord.
    expect(freeformFinLength([[0.01, 0]])).toBe(0);
    // Degenerate / reversed input is clamped, never negative.
    expect(freeformFinLength([[0.05, 0], [0.01, 0.02]])).toBe(0);
    expect(freeformFinLength([])).toBe(0);
  });

  it('sets offsetRadius on tube fin children via computeDerivedData', () => {
    const bt = comp('bodytube', { length: 0.2, outerRadius: 0.03 });
    const fin = comp('tubefinset', { length: 0.08, outerRadius: 0.01, thickness: 0.001, finCount: 3 });
    bt.children = [fin];

    const json: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: 'test', designer: '', revision: '', designType: 'original',
        kitName: '', referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [bt],
      },
      warnings: [],
    };
    computeDerivedData(json);
    expect((fin.params as any).offsetRadius).toBeCloseTo(0.03, 6);
  });

  it('estimates tube fin mass from the hollow cylinder volume', () => {
    const fin = comp('tubefinset', { length: 0.1, outerRadius: 0.01, thickness: 0.002, finCount: 3 });
    fin.material = { name: 'Balsa', type: 'bulk', density: 200, shearModulus: 0, group: '' };
    const expected = 200 * Math.PI * (0.01 ** 2 - 0.008 ** 2) * 0.1 * 3;
    expect(estimateComponentMass(fin)).toBeCloseTo(expected, 12);
  });

  it('scales planar fin mass by the cross-section volume factor', () => {
    // OpenRocket's CrossSection.getRelativeVolume() (FinSet.java:51-55) is the
    // only place the setting is read upstream: 1.00 square, 0.99 rounded,
    // 0.85 airfoil.  A shaped section really is less material than the
    // rectangle it replaces, so this is a mass difference, not a cosmetic one.
    const density = 500;
    const base = { rootChord: 0.12, tipChord: 0.04, height: 0.05, thickness: 0.003, finCount: 3 };
    const planformVolume = density * ((base.rootChord + base.tipChord) / 2) * base.height * base.thickness * base.finCount;

    for (const [crossSection, factor] of [['square', 1.0], ['rounded', 0.99], ['airfoil', 0.85]] as const) {
      const fin = comp('trapezoidfinset', { ...base, crossSection });
      fin.material = { name: 'Balsa', type: 'bulk', density, shearModulus: 0, group: '' };
      expect(massOf(fin)).toBeCloseTo(planformVolume * factor, 12);
    }
  });

  it('treats a missing or unknown cross-section as square', () => {
    // An older payload, or one hand-edited, may carry no crosssection at all.
    // The default must be the full rectangle, never a thinner fin.
    const base = { rootChord: 0.12, tipChord: 0.04, height: 0.05, thickness: 0.003, finCount: 3 };
    const square = comp('trapezoidfinset', { ...base, crossSection: 'square' });
    square.material = { name: 'Balsa', type: 'bulk', density: 500, shearModulus: 0, group: '' };
    const expected = massOf(square);

    for (const params of [{ ...base }, { ...base, crossSection: 'nonsense' }, { ...base, crossSection: undefined }]) {
      const fin = comp('trapezoidfinset', params);
      fin.material = { name: 'Balsa', type: 'bulk', density: 500, shearModulus: 0, group: '' };
      expect(massOf(fin)).toBeCloseTo(expected, 12);
    }
  });

  it('applies the cross-section factor to elliptical and freeform fins too', () => {
    // The same setting applies to all three planar fin types, so all three mass
    // paths have to carry it -- the FeatureScript builds all three the same way.
    const density = 500;
    const material = { name: 'Balsa', type: 'bulk' as const, density, shearModulus: 0, group: '' };

    const elliptical = comp('ellipticalfinset', {
      rootChord: 0.12, height: 0.05, thickness: 0.003, finCount: 3, crossSection: 'airfoil',
    });
    elliptical.material = material;
    const ellipticalSquare = comp('ellipticalfinset', {
      rootChord: 0.12, height: 0.05, thickness: 0.003, finCount: 3, crossSection: 'square',
    });
    ellipticalSquare.material = material;
    expect(massOf(elliptical)).toBeCloseTo(massOf(ellipticalSquare) * 0.85, 12);

    const points: Array<[number, number]> = [[0, 0], [0.02, 0.04], [0.12, 0.04], [0.1, 0]];
    const freeform = comp('freeformfinset', { points, thickness: 0.003, finCount: 3, crossSection: 'rounded' });
    freeform.material = material;
    const freeformSquare = comp('freeformfinset', { points, thickness: 0.003, finCount: 3, crossSection: 'square' });
    freeformSquare.material = material;
    expect(massOf(freeform)).toBeCloseTo(massOf(freeformSquare) * 0.99, 12);
  });

  it('returns 0 for an unsupported (non-symmetric) parent', () => {
    const stage = comp('stage', {});
    const fin = comp('trapezoidfinset', { rootChord: 0.08 });
    expect(finMountRadius(fin, stage)).toBe(0);
  });

  it('sets offsetRadius on fin children via computeDerivedData', () => {
    const bt = comp('bodytube', { length: 0.2, outerRadius: 0.03 });
    const fin = comp('trapezoidfinset', { rootChord: 0.08 });
    bt.children = [fin];

    const json: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: 'test', designer: '', revision: '', designType: 'original',
        kitName: '', referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [bt],
      },
      warnings: [],
    };
    computeDerivedData(json);
    expect((fin.params as any).offsetRadius).toBeCloseTo(0.03, 6);
  });

  it('sets offsetRadius on rail button children via computeDerivedData', () => {
    const bt = comp('bodytube', { length: 0.2, outerRadius: 0.03 });
    const rail = comp('railbutton', { outerDiameter: 0.0095 });
    bt.children = [rail];

    const json: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: 'test', designer: '', revision: '', designType: 'original',
        kitName: '', referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [bt],
      },
      warnings: [],
    };
    computeDerivedData(json);
    expect((rail.params as any).offsetRadius).toBeCloseTo(0.03, 6);
  });

  it('interpolates a rail button radius on a transition parent (middle method)', () => {
    const trans = comp('transition', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.1,
      foreRadius: 0.01,
      aftRadius: 0.05,
    });
    // Rail button axial length = outerDiameter = 0.0095 → middle centers it:
    // x = (0.1 − 0.0095)/2 = 0.04525. Conical: 0.01 + 0.4525·(0.05−0.01) = 0.0281.
    const rail = comp('railbutton', { outerDiameter: 0.0095 }, { axialMethod: 'middle', axialOffset: 0 });
    expect(finMountRadius(rail, trans)).toBeCloseTo(0.0281, 6);
  });
});

describe('estimateComponentMass', () => {
  function makeComp(overrides: any): RocketComponent {
    return {
      type: 'bodytube',
      name: 'test',
      id: 'test',
      material: { name: 'test', type: 'bulk', density: 1000, shearModulus: 0, group: '' },
      position: {
        axialMethod: 'after',
        axialOffset: 0,
        position: [0, 0, 0],
        instanceCount: 1,
        instanceSeparation: 0,
        angleOffset: 0,
        angleMethod: 'relative',
        radiusOffset: 0,
        radiusMethod: 'coaxial',
        radialPosition: 0,
        radialDirection: 0,
      },
      params: {},
      children: [],
      ...overrides,
    } as unknown as RocketComponent;
  }

  it('returns null for components without material', () => {
    const comp = makeComp({ material: undefined });
    expect(estimateComponentMass(comp)).toBeNull();
  });

  it('computes body tube shell mass', () => {
    const comp = makeComp({
      type: 'bodytube',
      params: { length: 0.1, outerRadius: 0.05, thickness: 0.002, filled: false },
    });
    const expected = 1000 * Math.PI * (0.05 * 0.05 - 0.048 * 0.048) * 0.1;
    expect(estimateComponentMass(comp)).toBeCloseTo(expected, 6);
  });

  it('computes filled body tube mass', () => {
    const comp = makeComp({
      type: 'bodytube',
      params: { length: 0.1, outerRadius: 0.05, thickness: -1, filled: true },
    });
    const expected = 1000 * Math.PI * 0.05 * 0.05 * 0.1;
    expect(estimateComponentMass(comp)).toBeCloseTo(expected, 6);
  });

  it('computes trapezoid fin mass', () => {
    const comp = makeComp({
      type: 'trapezoidfinset',
      params: { rootChord: 0.1, tipChord: 0.05, height: 0.08, thickness: 0.003, finCount: 3 },
    });
    const area = ((0.1 + 0.05) / 2) * 0.08;
    const expected = 1000 * area * 0.003 * 3;
    expect(estimateComponentMass(comp)).toBeCloseTo(expected, 6);
  });

  it('computes launch lug mass', () => {
    const comp = makeComp({
      type: 'launchlug',
      params: { outerRadius: 0.01, innerRadius: 0.008, length: 0.05 },
    });
    const expected = 1000 * Math.PI * (0.01 * 0.01 - 0.008 * 0.008) * 0.05;
    expect(estimateComponentMass(comp)).toBeCloseTo(expected, 6);
  });

  it('returns null for unsupported types', () => {
    const comp = makeComp({ type: 'parachute' });
    expect(estimateComponentMass(comp)).toBeNull();
  });
});

describe('auto-radius resolution', () => {
  function comp(type: string, name: string, params: any, children: RocketComponent[] = []): RocketComponent {
    return {
      type: type as RocketComponent['type'],
      name,
      id: name,
      material: undefined,
      position: {} as RocketComponent['position'],
      params,
      children,
    } as RocketComponent;
  }

  function makeJson(comps: RocketComponent[]): RocketJson {
    return {
      schemaVersion: '1.0',
      rocket: {
        name: 'test',
        designer: '',
        revision: '',
        designType: 'original',
        kitName: '',
        referenceType: 'maximum',
        referenceLength: 0,
        unitSystem: 'SI',
        components: comps,
      },
      warnings: [],
    } as RocketJson;
  }

  it('resolves a transition auto fore radius (unset) from the previous body tube', () => {
    const body = comp('bodytube', 'BT', { outerRadius: 0.025 });
    const trans = comp('transition', 'Trans', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.05,
      foreRadius: 0, // bare "auto" → no numeric part parsed
      aftRadius: 0.02,
      foreRadiusAutomatic: true,
      baseRadiusAutomatic: false,
    });
    computeDerivedData(makeJson([body, trans]));
    expect((trans.params as any).foreRadius).toBeCloseTo(0.025, 6);
  });

  it('overwrites a junk auto fore radius (auto 0.025) with the previous component value', () => {
    // The numeric part of `auto 0.025` is a placeholder; the real value comes
    // from the previous sibling, so it must be overwritten.
    const body = comp('bodytube', 'BT', { outerRadius: 0.045 });
    const trans = comp('transition', 'Trans', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.05,
      foreRadius: 0.025, // junk value stored next to "auto"
      aftRadius: 0.02,
      foreRadiusAutomatic: true,
      baseRadiusAutomatic: false,
    });
    computeDerivedData(makeJson([body, trans]));
    expect((trans.params as any).foreRadius).toBeCloseTo(0.045, 6);
  });

  it('propagates chained autos (auto body tube feeds auto transition fore radius)', () => {
    // Matches the Bell X-1 layout: auto body tube after the nose, then an
    // auto-fore transition. The body tube resolves from the nose, which then
    // feeds the transition's fore radius.
    const nose = comp('nosecone', 'NC', {
      shape: 'parabolic',
      shapeParameter: 0.6,
      length: 0.05,
      foreRadius: 0,
      aftRadius: 0.001143,
      foreRadiusAutomatic: false,
      baseRadiusAutomatic: false,
    });
    const body = comp('bodytube', 'BT', { outerRadius: 0.025, autoOuterRadius: true });
    const trans = comp('transition', 'Trans', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.05,
      foreRadius: 0.025,
      aftRadius: 0.02,
      foreRadiusAutomatic: true,
      baseRadiusAutomatic: false,
    });
    computeDerivedData(makeJson([nose, body, trans]));
    expect((body.params as any).outerRadius).toBeCloseTo(0.001143, 6);
    expect((trans.params as any).foreRadius).toBeCloseTo(0.001143, 6);
  });

  it('resolves a nose cone auto base (aft) radius from the next body tube', () => {
    const nose = comp('nosecone', 'NC', {
      shape: 'parabolic',
      shapeParameter: 0.6,
      length: 0.05,
      foreRadius: 0,
      aftRadius: 0,
      foreRadiusAutomatic: false,
      baseRadiusAutomatic: true,
    });
    const body = comp('bodytube', 'BT', { outerRadius: 0.03 });
    computeDerivedData(makeJson([nose, body]));
    expect((nose.params as any).aftRadius).toBeCloseTo(0.03, 6);
  });

  it('skips a nose cone whose base is STILL automatic (auto does not chain from junk)', () => {
    // The audit's #6 reproduction. Java's `Transition.getFrontAutoRadius()`
    // returns -1 while the aft radius is automatic, so `BodyTube.getAutoOuterRadius()`
    // skips the nose cone entirely and takes the FOLLOWING tube's radius.
    //
    // The stored values are deliberately NOT what OpenRocket resolves to, so the
    // coincidence that hid this in the real corpus cannot mask a regression:
    // the nose cone holds 0.0125 and the body tube must end up at 0.03.
    const nose = comp('nosecone', 'NC', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.05,
      foreRadius: 0,
      aftRadius: 0.0125, // stale stored value, <aftradius>auto 0.0125</aftradius>
      foreRadiusAutomatic: false,
      baseRadiusAutomatic: true,
    });
    const bodyAuto = comp('bodytube', 'BT-auto', { outerRadius: 0.0125, autoOuterRadius: true });
    const bodyFixed = comp('bodytube', 'BT-fixed', { outerRadius: 0.03 });

    computeDerivedData(makeJson([nose, bodyAuto, bodyFixed]));

    // NOT 0.0125 — the nose cone is still automatic and cannot be a source.
    expect((bodyAuto.params as any).outerRadius).toBeCloseTo(0.03, 6);
    // The nose cone's own base then resolves from the tube in front of it,
    // which is the auto tube, now resolved.
    expect((nose.params as any).aftRadius).toBeCloseTo(0.03, 6);
  });

  it('still chains a resolved auto body tube into the next auto component', () => {
    // Regression guard for the fix above. `autoOuterRadius` is a parser flag
    // that is never cleared, so treating "flag set" as "still unresolved" would
    // break this legitimate case: BT2 must take BT1's *resolved* radius.
    //
    // The stored values are all DIFFERENT (BT1 anchors to the fixed 0.04, BT2
    // holds junk 0.09), so each expectation discriminates. Under the naive
    // "any autoOuterRadius → -1" rule BT1 would be treated as unresolved, BT2
    // would find no usable previous component, and BT2 would stay at 0.09.
    const fixed = comp('bodytube', 'BT0', { outerRadius: 0.04 });
    const bodyA = comp('bodytube', 'BT1', { outerRadius: 0.04, autoOuterRadius: true });
    const bodyB = comp('bodytube', 'BT2', { outerRadius: 0.09, autoOuterRadius: true });
    computeDerivedData(makeJson([fixed, bodyA, bodyB]));
    expect((bodyA.params as any).outerRadius).toBeCloseTo(0.04, 6);
    expect((bodyB.params as any).outerRadius).toBeCloseTo(0.04, 6);
  });

  it('resolves an auto base from the next tube when the middle tube is auto and resolvable', () => {
    // NC(auto base) → BT(auto) → BT(0.03). The middle tube resolves from the
    // nose cone's junk-free side only if the nose cone is NOT automatic; here
    // it is, so the middle tube takes 0.03, and the nose cone's base — being
    // read from the front — then matches. One resolution, no junk anywhere.
    const nose = comp('nosecone', 'NC', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.05,
      foreRadius: 0,
      aftRadius: 0.001,
      foreRadiusAutomatic: false,
      baseRadiusAutomatic: true,
    });
    const bodyAuto = comp('bodytube', 'BT-auto', { outerRadius: 0.001, autoOuterRadius: true });
    const bodyFixed = comp('bodytube', 'BT-fixed', { outerRadius: 0.03 });
    computeDerivedData(makeJson([nose, bodyAuto, bodyFixed]));
    expect((bodyAuto.params as any).outerRadius).toBeCloseTo(0.03, 6);
  });

  it('recurses forward past a run of auto tubes to the first concrete one', () => {
    // The `Dual parachute deployment.ork` shape: nose(auto base) then a run of
    // auto tubes, with one concrete tube further back. Java's
    // `BodyTube.getRearAutoRadius()` recurses forward, so every tube in the run
    // lands on the concrete value. A naive "skip the auto neighbour and warn"
    // fix instead strands them on their `auto 0.025` placeholders.
    const nose = comp('nosecone', 'NC', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.28321,
      foreRadius: 0,
      aftRadius: 0.028321,
      foreRadiusAutomatic: false,
      baseRadiusAutomatic: true,
    });
    const t1 = comp('bodytube', 'BT1', { outerRadius: 0.025, autoOuterRadius: true });
    const t2 = comp('bodytube', 'BT2', { outerRadius: 0.025, autoOuterRadius: true });
    const fixed = comp('bodytube', 'BT-fixed', { outerRadius: 0.028321 });
    const t3 = comp('bodytube', 'BT3', { outerRadius: 0.025, autoOuterRadius: true });

    const json = makeJson([nose, t1, t2, fixed, t3]);
    computeDerivedData(json);

    // The nose cone cannot serve BT1 (its base is still auto), and BT1's own
    // stored 0.025 is junk, so the search continues down the chain to BT-fixed.
    expect((t1.params as any).outerRadius).toBeCloseTo(0.028321, 9);
    expect((t2.params as any).outerRadius).toBeCloseTo(0.028321, 9);
    expect((t3.params as any).outerRadius).toBeCloseTo(0.028321, 9);
    // No spurious warnings: every auto end found a concrete source.
    expect(json.warnings.filter((w) => w.includes('auto'))).toEqual([]);
  });

  it('does not overwrite a manual (non-auto) transition fore radius', () => {
    const body = comp('bodytube', 'BT', { outerRadius: 0.045 });
    const trans = comp('transition', 'Trans', {
      shape: 'conical',
      shapeParameter: 0,
      length: 0.05,
      foreRadius: 0.0168,
      aftRadius: 0.02,
      foreRadiusAutomatic: false,
      baseRadiusAutomatic: false,
    });
    computeDerivedData(makeJson([body, trans]));
    expect((trans.params as any).foreRadius).toBeCloseTo(0.0168, 6);
  });
it('resolves a centering ring auto outer radius to the enclosing tube inner radius', () => {
    // The ring sits inside a body tube (outer 0.030, wall 0.002), so its auto
    // outer radius must adopt the tube's INNER radius (0.028), fitting snugly.
    const ring = comp('centeringring', 'CR', {
      outerRadius: 0,
      autoOuterRadius: true,
      innerRadius: 0,
      thickness: 0,
      length: 0.005,
    });
    const body = comp('bodytube', 'BT', {
      outerRadius: 0.03,
      thickness: 0.002,
      length: 0.2,
      filled: false,
    });
    body.children = [ring];
    computeDerivedData(makeJson([body]));
    expect((ring.params as any).outerRadius).toBeCloseTo(0.028, 6);
  });

  it('resolves a centering ring auto inner radius only from OVERLAPPING inner-tube siblings', () => {
    // Two sibling inner tubes: one overlaps the ring at the parent's aft end,
    // the other sits forward and does NOT overlap. Only the overlapping tube
    // may define the ring hole (matches OpenRocket's getInnerRadius()).
    const ring = comp('centeringring', 'CR', {
      outerRadius: 0.028,
      autoInnerRadius: true,
      innerRadius: 0,
      thickness: 0,
      length: 0.005,
    });
    ring.position = { axialMethod: 'bottom', axialOffset: 0 } as unknown as RocketComponent['position'];

    const overlapping = comp('innertube', 'Motor tube', {
      outerRadius: 0.009398,
      innerRadius: 0,
      length: 0.06,
    });
    overlapping.position = { axialMethod: 'bottom', axialOffset: 0 } as unknown as RocketComponent['position'];

    const nonOverlapping = comp('innertube', 'Retainer Ring', {
      outerRadius: 0.009779, // larger, but does not overlap → must be ignored
      innerRadius: 0,
      length: 0.02,
    });
    nonOverlapping.position = { axialMethod: 'top', axialOffset: 0.03 } as unknown as RocketComponent['position'];

    const body = comp('bodytube', 'BT', {
      outerRadius: 0.03,
      thickness: 0.002,
      length: 0.1,
      filled: false,
    });
    body.children = [overlapping, nonOverlapping, ring];
    computeDerivedData(makeJson([body]));

    expect((ring.params as any).innerRadius).toBeCloseTo(0.009398, 6);
    expect((ring.params as any).innerRadius).toBeLessThan(0.009779);
  });

  it('resolves a bulkhead auto outer radius to the enclosing tube inner radius (solid disc)', () => {
    // A bulkhead is a RadiusRingComponent that defaults to automatic outer
    // radius (OpenRocket's Bulkhead() sets setOuterRadiusAutomatic(true)). Its
    // auto outer radius adopts the parent tube's INNER radius (0.028), exactly
    // like a centering ring, and its inner radius stays 0 (solid disc).
    const bulk = comp('bulkhead', 'BH', {
      outerRadius: 0,
      autoOuterRadius: true,
      innerRadius: 0,
      thickness: 0,
      length: 0.002,
    });
    const body = comp('bodytube', 'BT', {
      outerRadius: 0.03,
      thickness: 0.002,
      length: 0.2,
      filled: false,
    });
    body.children = [bulk];
    computeDerivedData(makeJson([body]));
    expect((bulk.params as any).outerRadius).toBeCloseTo(0.028, 6);
    expect((bulk.params as any).innerRadius).toBeCloseTo(0, 6);
  });

  it.each(['innertube', 'tubecoupler', 'engineblock'])(
    'resolves a %s auto outer radius to the enclosing tube inner radius',
    (type) => {
      // All five ring types are OpenRocket ThicknessRingComponents and share one
      // getOuterRadius(): fit inside the enclosing tube's inner radius, sampled
      // over the ring's span. Resolving only centering rings and bulkheads left
      // these three at outerRadius 0 -- a zero-thickness section, reported by
      // validation as "could not be resolved" but never actually fixed.
      const ring = comp(type, 'Ring', {
        outerRadius: 0,
        autoOuterRadius: true,
        innerRadius: 0,
        thickness: 0,
        length: 0.06,
      });
      ring.position = { axialMethod: 'top', axialOffset: 0.05 } as unknown as RocketComponent['position'];
      const body = comp('bodytube', 'BT', {
        outerRadius: 0.03,
        thickness: 0.002,
        length: 0.2,
        filled: false,
      });
      body.children = [ring];
      computeDerivedData(makeJson([body]));
      expect((ring.params as any).outerRadius).toBeCloseTo(0.028, 6);
    },
  );

  it('warns when a ring auto outer radius has no tube to fit inside', () => {
    // A tube with no wall: the inner radius equals the outer one, so an auto
    // outer radius on a child of a NON-radial parent still cannot be resolved
    // and must be reported rather than left silently at zero.
    const ring = comp('innertube', 'Orphan tube', {
      outerRadius: 0,
      autoOuterRadius: true,
      innerRadius: 0,
      thickness: 0.001,
      length: 0.06,
    });
    const body = comp('bodytube', 'BT', {
      outerRadius: 0.03,
      thickness: 0.002,
      length: 0.2,
      filled: false,
    });
    const fin = comp('trapezoidfinset', 'Fins', {
      rootChord: 0.05, tipChord: 0.02, sweepLength: 0.02, height: 0.03, thickness: 0.003,
    });
    fin.children = [ring];
    const json = makeJson([body, fin]);
    computeDerivedData(json);
    expect((ring.params as any).outerRadius).toBe(0);
    expect(json.warnings.some((w) => w.includes('Orphan tube') && w.includes('auto outer radius'))).toBe(true);
  });

  it('caps a centering ring auto inner radius by its resolved auto outer radius', () => {
    // Auto outer resolves to the parent's inner radius (0.010); the overlapping
    // inner tube wants a hole of 0.012, so the ring hole is capped at 0.010.
    const ring = comp('centeringring', 'CR', {
      outerRadius: 0,
      autoOuterRadius: true,
      autoInnerRadius: true,
      innerRadius: 0,
      thickness: 0,
      length: 0.005,
    });
    const tube = comp('innertube', 'Motor tube', {
      outerRadius: 0.012,
      innerRadius: 0,
      length: 0.06,
    });
    const body = comp('bodytube', 'BT', {
      outerRadius: 0.012,
      thickness: 0.002,
      length: 0.1,
      filled: false,
    });
    body.children = [tube, ring];
    computeDerivedData(makeJson([body]));

    expect((ring.params as any).outerRadius).toBeCloseTo(0.01, 6);
    expect((ring.params as any).innerRadius).toBeCloseTo(0.01, 6);
  });
});