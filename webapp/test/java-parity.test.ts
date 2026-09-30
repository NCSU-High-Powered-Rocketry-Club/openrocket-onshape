import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  transitionRadius,
  tubeFinTouchingRadius,
  computeDerivedData,
} from '../src/geometry';
import { parseOrkFile } from '../src/parser';
import type { RocketComponent, RocketJson } from '../src/types';

/**
 * Numerical differential against OpenRocket's own formulas.
 *
 * Two of the defects this file guards (#1 `parabolic`, #4 `haack`) were
 * wrong-but-plausible curves that survived three separate read-through audits:
 * both produced sane-looking monotone profiles through the correct endpoints, so
 * nothing downstream complained. Code review cannot reliably catch that class of
 * bug, but a numeric port of the Java expression can. Every function below is an
 * independent transcription of the named Java source, written straight from the
 * expression rather than from the TypeScript it checks.
 */
describe('parabolic shape matches Transition.Shape.Parabolic.getRadius', () => {
  // OpenRocket Transition.java:1068
  //   radius * ((2 * x / length - param * pow2(x / length)) / (2 - param))
  const javaParabolic = (x: number, r: number, L: number, p: number): number =>
    r * ((2 * (x / L) - p * Math.pow(x / L, 2)) / (2 - p));

  it('agrees with the Java formula across the parameter range', () => {
    for (const r of [0.0125, 0.025, 0.05]) {
      for (const L of [0.05, 0.15, 0.3, 0.6]) {
        for (const p of [0, 0.25, 0.5, 0.6, 0.75, 1]) {
          for (let i = 0; i <= 200; i++) {
            const x = (L * i) / 200;
            expect(transitionRadius('parabolic', x, r, L, p)).toBeCloseTo(
              javaParabolic(x, r, L, p),
              12
            );
          }
        }
      }
    }
  });

  it('is a cone at param 0, as OpenRocket documents', () => {
    // The documented degenerate case, and the one the old blended formula broke
    // hardest: it returned a blunt paraboloid r*t^2 instead of a cone.
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(transitionRadius('parabolic', 0.2 * t, 0.05, 0.2, 0)).toBeCloseTo(0.05 * t, 12);
    }
  });

  it('reaches full radius at the base for every param', () => {
    for (const p of [0, 0.25, 0.5, 0.6, 0.75, 1]) {
      expect(transitionRadius('parabolic', 0.2, 0.05, 0.2, p)).toBeCloseTo(0.05, 12);
    }
  });

  it('param 1 is the plain 2t - t^2 parabola', () => {
    for (const t of [0.1, 0.5, 0.9]) {
      expect(transitionRadius('parabolic', 0.2 * t, 0.05, 0.2, 1)).toBeCloseTo(
        0.05 * (2 * t - t * t),
        12
      );
    }
  });

  it('stays finite at the unreachable param 2 (zero denominator)', () => {
    // OpenRocket's UI caps param at 1, but a hand-edited file could carry 2.
    // The result must not become Infinity (and so `null` once serialised).
    for (let i = 0; i <= 20; i++) {
      const z = transitionRadius('parabolic', (0.2 * i) / 20, 0.05, 0.2, 2);
      expect(Number.isFinite(z)).toBe(true);
    }
  });
});

describe('haack shape matches Transition.Shape.Haack.getRadius', () => {
  // OpenRocket Transition.java:1106-1109
  //   radius * safeSqrt((theta - sin(2*theta)/2 + param*pow3(sin(theta))) / PI)
  const javaHaack = (x: number, r: number, L: number, p: number): number => {
    const theta = Math.acos(1 - 2 * (x / L));
    const d =
      (theta - Math.sin(2 * theta) / 2 + p * Math.pow(Math.sin(theta), 3)) / Math.PI;
    return r * (d < 0 ? 0 : Math.sqrt(d));
  };

  it('agrees with the Java formula for both the LD and LV branches', () => {
    for (const r of [0.025, 0.05]) {
      for (const L of [0.1, 0.15, 0.3]) {
        // 0 = Von Karman, 1/3 = LV-Haack, which is the UI's max.
        for (const p of [0, 1 / 6, 1 / 3]) {
          for (let i = 0; i <= 200; i++) {
            const x = (L * i) / 200;
            expect(transitionRadius('haack', x, r, L, p)).toBeCloseTo(
              javaHaack(x, r, L, p),
              12
            );
          }
        }
      }
    }
  });

  it('param actually changes the shape (LV-Haack differs from Von Karman)', () => {
    // The bug was that the param*sin^3(theta) term was dropped entirely, so every
    // LV-Haack nose cone built as a plain Von Karman. The term peaks near
    // mid-length, where sin(theta) is largest.
    let maxDiff = 0;
    for (let i = 1; i < 200; i++) {
      const x = (0.15 * i) / 200;
      maxDiff = Math.max(
        maxDiff,
        Math.abs(
          transitionRadius('haack', x, 0.025, 0.15, 1 / 3) -
            transitionRadius('haack', x, 0.025, 0.15, 0)
        )
      );
    }
    // The audit measured ~1.8 mm on r=25 mm; the effect is large, not marginal.
    expect(maxDiff).toBeGreaterThan(1e-3);
  });

  it('param 0 reduces to the Von Karman series exactly', () => {
    for (const t of [0.1, 0.5, 0.9]) {
      const theta = Math.acos(1 - 2 * t);
      expect(transitionRadius('haack', 0.15 * t, 0.025, 0.15, 0)).toBeCloseTo(
        0.025 * Math.sqrt((theta - Math.sin(2 * theta) / 2) / Math.PI),
        12
      );
    }
  });
});

describe('launch lug bore is derived, not read', () => {
  // `LaunchLugSaver` writes only <radius>, <length> and <thickness> -- never
  // <innerradius>. `LaunchLug.getInnerRadius()` is `radius - thickness`, so a
  // file from any OpenRocket version cannot carry the element and the parsed
  // bore used to be 0, which made every lug a solid disc in the mass estimate.
  const ork = async (inner: string): Promise<RocketJson> => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <openrocket version="1.10" creator="t"><rocket><name>S</name>
        <subcomponents><stage><name>St</name><subcomponents>${inner}</subcomponents></stage></subcomponents>
      </rocket></openrocket>`;
    const zip = new JSZip();
    zip.file('rocket.ork', xml);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    return parseOrkFile(buf as ArrayBuffer);
  };

  const lug = (extra = '', thickness = '0.001') =>
    ork(
      '<bodytube><name>BT</name><length>0.2</length><outerradius>0.02</outerradius>' +
        '<thickness>0.001</thickness></bodytube>' +
        '<launchlug><name>Lug</name><radius>0.0031463</radius>' +
        `<length>0.01905</length><thickness>${thickness}</thickness>` +
        '<material type="bulk" density="680.0" group="Paper">Cardboard</material>' +
        `${extra}</launchlug>`
    ).then((j) => {
      computeDerivedData(j);
      return j.rocket.components[0].children[1];
    });

  it('derives innerRadius as radius - thickness when the element is absent', async () => {
    const l = await lug();
    const p = l.params as { innerRadius: number; outerRadius: number; thickness: number };
    expect(p.outerRadius).toBeCloseTo(0.0031463, 9);
    expect(p.innerRadius).toBeCloseTo(0.0031463 - 0.001, 9);
  });

  it('is an annulus, not a solid disc: mass is density x wall area x length', async () => {
    const l = await lug();
    const p = l.params as { innerRadius: number; outerRadius: number; length: number };
    const d = (l.material as { density: number }).density;
    expect(l.mass).toBeCloseTo(
      d * Math.PI * (p.outerRadius ** 2 - p.innerRadius ** 2) * p.length,
      12
    );
    // A solid disc of the same outer radius would be far heavier; the bore is
    // the whole point of a lug, so the two must not coincide.
    const solid = d * Math.PI * p.outerRadius ** 2 * p.length;
    expect(l.mass as number).toBeLessThan(solid);
    expect(solid / (l.mass as number)).toBeGreaterThan(1.5);
  });

  it('clamps to a zero bore when the lug is as thick as its radius', async () => {
    // `setThickness` clamps thickness to radius, so a full-thickness lug has no
    // bore and OpenRocket draws it solid. The derived value must not go negative,
    // which would make the annulus formula yield a NEGATIVE volume.
    const l = await lug('', '0.0031463');
    const p = l.params as { innerRadius: number; outerRadius: number; length: number };
    expect(p.innerRadius).toBe(0);
    // A zero bore means a solid cylinder of the full outer radius, not a
    // massless one -- the guard is against a negative radius, not zero mass.
    expect(l.mass).toBeCloseTo(680 * Math.PI * p.outerRadius ** 2 * p.length, 12);
    expect(l.mass as number).toBeGreaterThan(0);
  });

  it('lets an explicit <innerradius> win, so a hand-edited file is honoured', async () => {
    const l = await lug('<innerradius>0.001</innerradius>');
    expect((l.params as { innerRadius: number }).innerRadius).toBe(0.001);
  });
});

describe('mass overrides are read and honoured', () => {
  const comp = (extra: Partial<RocketComponent> = {}): RocketComponent =>
    ({
      type: 'bodytube',
      name: 'BT',
      id: 'bt',
      material: { name: 'cardboard', type: 'bulk', density: 680, shearModulus: 0, group: '' },
      position: { instanceCount: 1 } as never,
      params: {
        length: 0.2,
        outerRadius: 0.02,
        thickness: 0.001,
        filled: false,
        isMotorMount: false,
      },
      children: [],
      ...extra,
    }) as RocketComponent;

  const json = (components: RocketComponent[]): RocketJson => ({
    schemaVersion: '1.0',
    rocket: {
      name: 'T',
      designer: '',
      revision: '',
      designType: '',
      kitName: '',
      referenceType: '',
      referenceLength: 0,
      unitSystem: 'SI',
      components,
    },
    warnings: [],
  });

  it('a deliberate override wins over the geometric estimate', () => {
    const c = comp({ overrideMass: 0.05 });
    computeDerivedData(json([c]));
    expect(c.mass).toBe(0.05);
  });

  it('an explicit override of 0 is honoured, not treated as absent', () => {
    const c = comp({ overrideMass: 0 });
    computeDerivedData(json([c]));
    expect(c.mass).toBe(0);
  });

  it('falls back to the estimate when the component is not overridden', () => {
    const c = comp();
    computeDerivedData(json([c]));
    expect(c.mass).toBeGreaterThan(0);
  });
});

describe('parser reads <overridemass> and <color>', () => {
  const ork = async (inner: string): Promise<RocketJson> => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <openrocket version="1.10" creator="t"><rocket><name>S</name>
        <subcomponents><stage><name>St</name><subcomponents>${inner}</subcomponents></stage></subcomponents>
      </rocket></openrocket>`;
    const zip = new JSZip();
    zip.file('rocket.ork', xml);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    return parseOrkFile(buf as ArrayBuffer);
  };

  const body = (extra: string) =>
    ork(`<bodytube><name>BT</name><length>0.2</length><outerradius>0.02</outerradius>
      <thickness>0.001</thickness>${extra}</bodytube>`)
      // components[0] is the <stage> wrapper; the body tube is its only child.
      .then((j) => j.rocket.components[0].children[0]);

  it('carries an explicit <overridemass> through to the component mass', async () => {
    const j = await ork(
      '<bodytube><name>BT</name><length>0.2</length><outerradius>0.02</outerradius>' +
        '<thickness>0.001</thickness><overridemass>0.045</overridemass></bodytube>'
    );
    const bt = j.rocket.components[0].children[0];
    expect(bt.overrideMass).toBe(0.045);
    // The geometry pass is driven by the app (main.ts), not by parseOrkFile, so
    // run it here: that is where the override is applied to `mass`.
    computeDerivedData(j);
    expect(bt.mass).toBe(0.045);
  });

  it('leaves overrides undefined when the elements are absent', async () => {
    const bt = await body('');
    expect(bt.overrideMass).toBeUndefined();
    expect(bt.overrideCG).toBeUndefined();
    expect(bt.overrideCD).toBeUndefined();
  });

  it('reads <overridecg> and <overridecd> as simulation metadata', async () => {
    const bt = await body('<overridecg>0.12</overridecg><overridecd>0.35</overridecd>');
    expect(bt.overrideCG).toBe(0.12);
    expect(bt.overrideCD).toBe(0.35);
  });

  it('reads <color> when there is no <appearance><paint>', async () => {
    // A file can carry <color> alone; the appearance is optional. Without this
    // the component fell back to a material guess instead of its real paint.
    const bt = await body('<color red="255" green="0" blue="0" alpha="255"/>');
    expect(bt.color).toEqual({ red: 1, green: 0, blue: 0, alpha: 1 });
  });

  it('prefers <appearance><paint> over <color> when both are present', async () => {
    const bt = await body(
      '<color red="255" green="0" blue="0" alpha="255"/>' +
        '<appearance><paint red="0" green="0" blue="255" alpha="255"/></appearance>'
    );
    expect(bt.color).toEqual({ red: 0, green: 0, blue: 1, alpha: 1 });
  });
});

describe('tube fin auto radius matches TubeFinSet.getOuterRadius', () => {
  // OpenRocket TubeFinSet.java:86 — `if (fins < 3) return getBodyRadius();`
  it('returns the plain body radius for fin counts below 3', () => {
    for (const n of [1, 2]) {
      expect(tubeFinTouchingRadius(0.02, n)).toBe(0.02);
    }
  });

  it('never returns Infinity, which would serialise as null', () => {
    // At n=2, sin(pi/2) == 1 makes the denominator exactly zero. The old
    // `finCount <= 1` guard let that through, and JSON.stringify(Infinity) is
    // `null` — a silently radius-less tube fin rather than a crash.
    for (let n = 1; n <= 12; n++) {
      expect(Number.isFinite(tubeFinTouchingRadius(0.02, n))).toBe(true);
    }
  });

  it('agrees with the touching-radius formula for n >= 3', () => {
    for (const n of [3, 4, 5, 6, 7, 8]) {
      const sin = Math.sin(Math.PI / n);
      expect(tubeFinTouchingRadius(0.02, n)).toBeCloseTo((0.02 * sin) / (1 - sin), 12);
    }
  });
});
