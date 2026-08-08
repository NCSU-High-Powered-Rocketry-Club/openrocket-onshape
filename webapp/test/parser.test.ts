import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseOrkFile } from '../src/parser';
import { computeDerivedData } from '../src/geometry';
import type { RocketJson, RocketComponent } from '../src/types';

const ORK_DIR = join(__dirname, 'ork');

function loadOrk(name: string): ArrayBuffer {
  const buf = readFileSync(join(ORK_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function flatten(components: RocketComponent[]): RocketComponent[] {
  const out: RocketComponent[] = [];
  const visit = (comps: RocketComponent[]) => {
    for (const c of comps) {
      out.push(c);
      visit(c.children);
    }
  };
  visit(components);
  return out;
}

function findByName(components: RocketComponent[], name: string): RocketComponent | undefined {
  return flatten(components).find((c) => c.name === name);
}

describe('parseOrkFile', () => {
  let demon: RocketJson;
  let antar: RocketJson;
  let kerbal: RocketJson;
  let lowBoom: RocketJson;
  let bellX1: RocketJson;

  beforeAll(async () => {
    demon = await parseOrkFile(loadOrk('demon 54.ork'));
    antar = await parseOrkFile(loadOrk('Antar - Estes 7310.ork'));
    kerbal = await parseOrkFile(loadOrk('Kerbal.ork'));
    lowBoom = await parseOrkFile(loadOrk('Low-Boom SST.ork'));
    bellX1 = await parseOrkFile(loadOrk('Bell X-1 - Starfire Design.ork'));
  });

  it('parses all 5 test files without throwing', () => {
    expect(demon).toBeDefined();
    expect(antar).toBeDefined();
    expect(kerbal).toBeDefined();
    expect(lowBoom).toBeDefined();
    expect(bellX1).toBeDefined();
  });

  it('extracts rocket metadata', () => {
    expect(demon.rocket.name).toBe('Rocket');
    expect(demon.rocket.designer).toBe('Jackson Tesoro');
    expect(demon.rocket.designType).toBe('original');
    expect(demon.rocket.referenceType).toBe('maximum');
    expect(demon.rocket.unitSystem).toBe('SI');
  });

  it('records the file format version in warnings', () => {
    expect(demon.warnings.some((w) => w.includes('1.10'))).toBe(true);
  });

  it('parses stages as top-level components', () => {
    expect(demon.rocket.components.length).toBeGreaterThan(0);
    expect(demon.rocket.components[0].type).toBe('stage');
    expect(demon.rocket.components[0].name).toBe('Sustainer');
  });

  it('parses nose cone geometry (ogive shape)', () => {
    const nose = findByName(demon.rocket.components, 'Nose Cone');
    expect(nose).toBeDefined();
    expect(nose!.type).toBe('nosecone');
    const p = nose!.params as any;
    expect(p.shape).toBe('ogive');
    expect(p.shapeParameter).toBe(1.0);
    expect(p.length).toBeCloseTo(0.2413, 4);
    expect(p.aftRadius).toBeCloseTo(0.02667, 5);
    expect(p.thickness).toBeCloseTo(0.00148082, 6);
    expect(p.flipped).toBe(false);
    expect(p.shoulderAft.radius).toBeCloseTo(0.02667, 5);
    expect(p.shoulderAft.length).toBe(0);
  });

  it('parses body tube geometry', () => {
    const body = findByName(demon.rocket.components, 'Body Tube');
    expect(body).toBeDefined();
    expect(body!.type).toBe('bodytube');
    const p = body!.params as any;
    expect(p.length).toBeGreaterThan(0);
    expect(p.outerRadius).toBeGreaterThan(0);
    expect(p.thickness).toBeGreaterThan(0);
    expect(p.filled).toBe(false);
  });

  it('parses trapezoid fin set with tab and rotation', () => {
    const fins = findByName(demon.rocket.components, 'Trapezoidal Fin Set');
    expect(fins).toBeDefined();
    expect(fins!.type).toBe('trapezoidfinset');
    const p = fins!.params as any;
    expect(p.finCount).toBe(3);
    expect(p.rootChord).toBeGreaterThan(0);
    expect(p.tipChord).toBeGreaterThan(0);
    expect(p.sweepLength).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
    expect(p.thickness).toBeCloseTo(0.003, 4);
    expect(p.crossSection).toBe('square');
    expect(p.tab.height).toBeCloseTo(0.0127, 4);
    expect(p.tab.length).toBeCloseTo(0.13208, 5);
    expect(p.tab.positionMethod).toBe('middle');
    expect(p.baseRotation).toBeCloseTo(0, 5);
  });

  it('parses parachute with packed dimensions', () => {
    const chute = findByName(demon.rocket.components, 'Parachute, 24 in., nylon, 6 lines');
    expect(chute).toBeDefined();
    expect(chute!.type).toBe('parachute');
    const p = chute!.params as any;
    expect(p.diameter).toBeCloseTo(0.6096, 4);
    expect(p.packedLength).toBeCloseTo(0.025, 4);
    expect(p.packedRadius).toBeCloseTo(0.0125, 4);
    expect(p.material).toBeDefined();
    expect(p.material!.type).toBe('surface');
  });

  it('parses rail button (may use preset, falls back to explicit values)', () => {
    const rail = findByName(demon.rocket.components, 'Rail Button');
    expect(rail).toBeDefined();
    expect(rail!.type).toBe('railbutton');
    const p = rail!.params as any;
    expect(p).toBeDefined();
  });

  it('parses inner tube with cluster config and motor mount', () => {
    const inner = findByName(demon.rocket.components, 'Inner Tube');
    expect(inner).toBeDefined();
    expect(inner!.type).toBe('innertube');
    const p = inner!.params as any;
    expect(p.clusterConfiguration).toBe('single');
    expect(p.clusterScale).toBe(1.0);
    expect(p.outerRadius).toBeGreaterThan(0);
    expect(p.thickness).toBeGreaterThan(0);
    expect(p.isMotorMount).toBe(true);
    expect(p.motorMount).toBeDefined();
  });

  it('parses centering ring with inner radius', () => {
    const rings = flatten(demon.rocket.components).filter((c) => c.type === 'centeringring');
    expect(rings.length).toBeGreaterThan(0);
    const p = rings[0].params as any;
    expect(p.outerRadius).toBeGreaterThan(0);
    expect(p.innerRadius).toBeGreaterThan(0);
    expect(p.length).toBeGreaterThan(0);
  });

  it('parses transition (in Antar)', () => {
    const trans = findByName(antar.rocket.components, 'Transition');
    expect(trans).toBeDefined();
    expect(trans!.type).toBe('transition');
    const p = trans!.params as any;
    expect(p.shape).toBeDefined();
    expect(p.length).toBeGreaterThan(0);
  });

  it('parses freeform fin set (in Antar)', () => {
    const fins = flatten(antar.rocket.components).filter((c) => c.type === 'freeformfinset');
    expect(fins.length).toBeGreaterThan(0);
    const p = fins[0].params as any;
    expect(p.points.length).toBeGreaterThan(2);
    expect(Array.isArray(p.points[0])).toBe(true);
    expect(p.points[0].length).toBe(2);
  });

  it('parses pod set with children (in Antar)', () => {
    const pods = flatten(antar.rocket.components).filter((c) => c.type === 'podset');
    expect(pods.length).toBeGreaterThan(0);
    expect(pods[0].children.length).toBeGreaterThan(0);
    expect(pods[0].position.radiusOffset).toBeGreaterThan(0);
  });

  it('parses launch lug (in Kerbal)', () => {
    const lugs = flatten(kerbal.rocket.components).filter((c) => c.type === 'launchlug');
    expect(lugs.length).toBeGreaterThan(0);
    const p = lugs[0].params as any;
    expect(p.outerRadius).toBeGreaterThan(0);
    expect(p.length).toBeGreaterThan(0);
  });

  it('parses shock cord (in Kerbal)', () => {
    const cords = flatten(kerbal.rocket.components).filter((c) => c.type === 'shockcord');
    expect(cords.length).toBeGreaterThan(0);
    const p = cords[0].params as any;
    expect(p.cordLength).toBeGreaterThan(0);
  });

  it('parses engine block (in Antar)', () => {
    const blocks = flatten(antar.rocket.components).filter((c) => c.type === 'engineblock');
    expect(blocks.length).toBeGreaterThan(0);
    const p = blocks[0].params as any;
    expect(p.outerRadius).toBeGreaterThan(0);
    expect(p.length).toBeGreaterThan(0);
  });

  it('parses mass component (in demon)', () => {
    const masses = flatten(demon.rocket.components).filter((c) => c.type === 'masscomponent');
    expect(masses.length).toBeGreaterThan(0);
    const p = masses[0].params as any;
    expect(p.mass).toBeGreaterThan(0);
  });

  it('parses materials with density and type', () => {
    const nose = findByName(demon.rocket.components, 'Nose Cone');
    expect(nose!.material).toBeDefined();
    expect(nose!.material!.name).toContain('Fiberglass');
    expect(nose!.material!.type).toBe('bulk');
    expect(nose!.material!.density).toBeCloseTo(1800, 0);
  });

  it('parses axial position method from attribute', () => {
    // The trapezoid fin set has an explicit <axialoffset method="bottom"> in demon 54.ork
    const fins = findByName(demon.rocket.components, 'Trapezoidal Fin Set');
    expect(fins!.position.axialMethod).toBe('bottom');
    expect(fins!.position.axialOffset).toBeCloseTo(0.12192, 4);
  });

  it('parses instance count and separation', () => {
    const fins = findByName(demon.rocket.components, 'Trapezoidal Fin Set');
    expect(fins!.position.instanceCount).toBe(3);
    const rail = findByName(demon.rocket.components, 'Rail Button');
    expect(rail!.position.instanceCount).toBe(1);
    expect(rail!.position.instanceSeparation).toBeCloseTo(0.0582, 4);
  });

  it('parses angle offset in degrees → radians', () => {
    const fins = findByName(demon.rocket.components, 'Trapezoidal Fin Set');
    expect(fins!.position.angleOffset).toBeCloseTo(0, 5);
    expect(fins!.position.angleMethod).toBe('relative');
  });

  it('parses radius offset method', () => {
    const fins = findByName(demon.rocket.components, 'Trapezoidal Fin Set');
    expect(fins!.position.radiusMethod).toBe('surface');
    expect(fins!.position.radiusOffset).toBe(0);
  });
});

describe('computeDerivedData', () => {
  let demon: RocketJson;

  beforeAll(async () => {
    demon = await parseOrkFile(loadOrk('demon 54.ork'));
    computeDerivedData(demon);
  });

  it('adds a profile to nose cones', () => {
    const nose = findByName(demon.rocket.components, 'Nose Cone');
    const p = nose!.params as any;
    expect(p.profile).toBeDefined();
    expect(p.profile.length).toBe(51);
    expect(p.profile[0][1]).toBeCloseTo(0, 5);
    expect(p.profile[50][1]).toBeCloseTo(0.02667, 4);
  });

  it('adds a planform to trapezoid fins', () => {
    const fins = findByName(demon.rocket.components, 'Trapezoidal Fin Set');
    const p = fins!.params as any;
    expect(p.planform).toBeDefined();
    expect(p.planform.length).toBeGreaterThan(4);
    expect(p.planform[0][0]).toBeCloseTo(0, 5);
    expect(p.planform[0][1]).toBeCloseTo(0, 5);
  });

  it('adds mass estimates to components with materials', () => {
    const nose = findByName(demon.rocket.components, 'Nose Cone');
    expect((nose as any).mass).toBeGreaterThan(0);
    const body = findByName(demon.rocket.components, 'Body Tube');
    expect((body as any).mass).toBeGreaterThan(0);
  });
});