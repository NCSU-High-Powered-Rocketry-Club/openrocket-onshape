import { describe, it, expect } from 'vitest';
import {
  transitionRadius,
  transitionProfile,
  trapezoidFinPoints,
  ellipticalFinPoints,
  tubeFinTouchingRadius,
  estimateComponentMass,
} from '../src/geometry';
import type { RocketComponent } from '../src/types';

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

  it('ellipsoid follows the half-ellipse equation', () => {
    // x²/L² + y²/r² = 1 → at x=L/2, y = r·√(1 - 1/4) = r·√3/2
    expect(transitionRadius('ellipsoid', L / 2, r, L, 1)).toBeCloseTo(r * Math.sqrt(3) / 2, 6);
  });

  it('power with p=1 is linear', () => {
    expect(transitionRadius('power', L / 2, r, L, 1)).toBeCloseTo(r / 2, 6);
  });

  it('power with p=2 is quadratic', () => {
    expect(transitionRadius('power', L / 2, r, L, 2)).toBeCloseTo(r / 4, 6);
  });

  it('clamps to [0, radius]', () => {
    expect(transitionRadius('conical', -1, r, L, 1)).toBe(0);
    expect(transitionRadius('conical', L + 1, r, L, 1)).toBe(r);
  });

  it('handles zero length', () => {
    expect(transitionRadius('conical', 0.1, r, 0, 1)).toBe(r);
  });
});

describe('transitionProfile', () => {
  it('produces 51 points for 50 steps', () => {
    const pts = transitionProfile('conical', 0.2, 0.05, 1);
    expect(pts.length).toBe(51);
  });

  it('starts at 0 and ends at radius', () => {
    const pts = transitionProfile('ogive', 0.2, 0.05, 1);
    expect(pts[0][1]).toBeCloseTo(0, 6);
    expect(pts[50][1]).toBeCloseTo(0.05, 6);
  });

  it('x values are monotonic from 0 to length', () => {
    const pts = transitionProfile('haack', 0.2, 0.05, 1);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0]).toBeGreaterThan(pts[i - 1][0]);
    }
    expect(pts[0][0]).toBe(0);
    expect(pts[50][0]).toBeCloseTo(0.2, 6);
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
  it('produces a symmetric planform', () => {
    const pts = ellipticalFinPoints(0.1, 0.08);
    expect(pts.length).toBeGreaterThan(10);
    // Symmetric about y=0
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(first[1]).toBeCloseTo(-last[1], 6);
    // Max height is the fin height
    const maxY = Math.max(...pts.map((p) => Math.abs(p[1])));
    expect(maxY).toBeCloseTo(0.08, 6);
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