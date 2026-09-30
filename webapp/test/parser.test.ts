import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import JSZip from 'jszip';
import { parseOrkFile } from '../src/parser';
import { computeDerivedData, symmetricProfile } from '../src/geometry';
import { validateRocketJson } from '../src/validation';
import type { RocketJson, RocketComponent, Position } from '../src/types';

const ORK_DIR = join(__dirname, 'ork');

function loadOrk(name: string): ArrayBuffer {
  const buf = readFileSync(join(ORK_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Build a minimal .ork document around the supplied component XML. Lets a test
 * exercise a single element without adding a whole binary fixture -- needed for
 * file-format quirks (like the legacy `<radialdirection>`) that none of the
 * checked-in test rockets happen to contain.
 */
function syntheticOrk(inner: string): Promise<ArrayBuffer> {
  return syntheticOrkWithRocketPreamble('', inner);
}

/**
 * As `syntheticOrk`, but `rocketPreamble` is emitted directly under `<rocket>`,
 * BEFORE `<subcomponents>`. Rocket-level declarations -- notably
 * `<motorconfiguration default="true">` -- have to sit there to be found; nested
 * inside the stage they are invisible to the parser, which is exactly the
 * mistake this variant exists to make impossible.
 */
function syntheticOrkWithRocketPreamble(rocketPreamble: string, inner: string): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<openrocket version="1.10" creator="OpenRocket 25.03">
  <rocket>
    <name>Synthetic</name>
    ${rocketPreamble}
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <subcomponents>${inner}</subcomponents>
      </stage>
    </subcomponents>
  </rocket>
</openrocket>`;
  const zip = new JSZip();
  zip.file('rocket.ork', xml);
  return zip.generateAsync({ type: 'arraybuffer' });
}

/**
 * A .ork carrying only `<simulations>`, so a test can drive the center-of-pressure
 * extraction without a binary fixture. `branches` is one array of `<datapoint>`
 * rows per simulation; the databranch always exposes Time, CP location and Mach
 * number, which is all the CP path reads.
 */
function cpOrk(...branches: string[][]): string {
  const simulations = branches
    .map(
      (points, i) => `<simulation><name>Simulation ${i + 1}</name><flightdata>
        <databranch name="Sustainer" types="Time,CP location,Mach number">${points.join('')}</databranch>
      </flightdata></simulation>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
  <openrocket version="1.10"><rocket><name>CP test</name>
    <subcomponents><stage><name>Sustainer</name><subcomponents></subcomponents></stage></subcomponents>
    <simulations>${simulations}</simulations>
  </rocket></openrocket>`;
}

async function cpOrkBuffer(xml: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('rocket.ork', xml);
  return zip.generateAsync({ type: 'arraybuffer' });
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

/** The motor mount params of a named component, for the motor tests below. */
function mountOf(rocket: RocketJson, name: string): any {
  return (findByName(rocket.rocket.components, name)!.params as any).motorMount;
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

  it('takes the median center of pressure, not the first row', async () => {
    // The launch transient reads low and then settles: OpenRocket's own plot for
    // this rocket sits on the settled value, so the marker must too.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <openrocket version="1.10"><rocket><name>CP test</name>
      <subcomponents><stage><name>Sustainer</name><subcomponents></subcomponents></stage></subcomponents>
      <simulations><simulation><flightdata><databranch types="Time,CP location">
        <datapoint>0,NaN</datapoint>
        <datapoint>0.1,0.40</datapoint>
        <datapoint>0.2,0.42</datapoint>
        <datapoint>0.3,0.42</datapoint>
        <datapoint>0.4,0.42</datapoint>
        <datapoint>0.5,0.42</datapoint>
      </databranch></flightdata></simulation></simulations>
    </rocket></openrocket>`;
    const zip = new JSZip();
    zip.file('rocket.ork', xml);
    const result = await parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(result.rocket.centerOfPressure).toBeCloseTo(0.42, 6);
  });

  it('ignores the exact 0 OpenRocket writes after the rocket has landed', async () => {
    // Once the simulation finishes, every remaining row is a literal 0 -- a
    // "no forces" sentinel, not a measurement. Accepting it would park the
    // marker on the nose tip.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <openrocket version="1.10"><rocket><name>CP test</name>
      <subcomponents><stage><name>Sustainer</name><subcomponents></subcomponents></stage></subcomponents>
      <simulations><simulation><flightdata><databranch types="Time,CP location">
        <datapoint>0,NaN</datapoint>
        <datapoint>0.1,0.42</datapoint>
        <datapoint>9.0,0</datapoint>
        <datapoint>9.2,0</datapoint>
        <datapoint>9.4,0</datapoint>
        <datapoint>9.6,0</datapoint>
        <datapoint>9.8,0</datapoint>
      </databranch></flightdata></simulation></simulations>
    </rocket></openrocket>`;
    const zip = new JSZip();
    zip.file('rocket.ork', xml);
    const result = await parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(result.rocket.centerOfPressure).toBeCloseTo(0.42, 6);
  });

  it('falls through to a later simulation when the first has no usable CP', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <openrocket version="1.10"><rocket><name>CP test</name>
      <subcomponents><stage><name>Sustainer</name><subcomponents></subcomponents></stage></subcomponents>
      <simulations>
        <simulation><name>Aborted</name><flightdata><databranch types="Time,CP location">
          <datapoint>0,NaN</datapoint><datapoint>0.1,NaN</datapoint>
        </databranch></flightdata></simulation>
        <simulation><name>Good</name><flightdata><databranch types="Time,CP location">
          <datapoint>0,NaN</datapoint><datapoint>0.1,0.30</datapoint>
          <datapoint>0.2,0.30</datapoint><datapoint>0.3,0.30</datapoint>
        </databranch></flightdata></simulation>
      </simulations>
    </rocket></openrocket>`;
    const zip = new JSZip();
    zip.file('rocket.ork', xml);
    const result = await parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(result.rocket.centerOfPressure).toBeCloseTo(0.30, 6);
  });

  it('leaves center of pressure undefined when no simulation data exists', async () => {
    const result = await parseOrkFile(await syntheticOrk(''));
    expect(result.rocket.centerOfPressure).toBeUndefined();
  });

  it('leaves center of pressure undefined when every CP sample is a sentinel', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <openrocket version="1.10"><rocket><name>CP test</name>
      <subcomponents><stage><name>Sustainer</name><subcomponents></subcomponents></stage></subcomponents>
      <simulations><simulation><flightdata><databranch types="Time,CP location">
        <datapoint>0,NaN</datapoint><datapoint>1,0</datapoint><datapoint>2,0</datapoint>
      </databranch></flightdata></simulation></simulations>
    </rocket></openrocket>`;
    const zip = new JSZip();
    zip.file('rocket.ork', xml);
    const result = await parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(result.rocket.centerOfPressure).toBeUndefined();
  });

  it('extracts the Bell X-1 center of pressure from its saved simulations', () => {
    expect(bellX1.rocket.centerOfPressure).toBeCloseTo(0.243, 6);
  });

  it('puts the pods/winglets marker where OpenRocket draws it', async () => {
    // Regression: the column opens at 0.334 (launch transient) and settles at
    // 0.342; OpenRocket's design view, corrected to zero angle of attack from
    // the file's own CN/AOA data, is 0.342. The old first-row read put the
    // marker 8 mm forward of that.
    const result = await parseOrkFile(loadOrk('ExamplePods-airframe and winglets.ork'));
    expect(result.rocket.centerOfPressure).toBeCloseTo(0.34, 6);
  });

  it('lists every usable center of pressure, one entry per data branch', async () => {
    const result = await parseOrkFile(loadOrk('ExamplePods-airframe and winglets.ork'));
    const branches = result.rocket.centerOfPressureBranches ?? [];
    // Five saved simulations, one Sustainer branch each.
    expect(branches).toHaveLength(5);
    expect(branches[0].simulation).toBe('Simulation 1');
    expect(branches[0].branch).toBe('Sustainer');

    // Every sample is a positive finite number -- no NaN, no post-flight zero.
    for (const b of branches) {
      expect(b.values.length).toBe(b.count);
      expect(b.values.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
      expect(b.first).toBe(b.values[0]);
      expect(b.min).toBe(Math.min(...b.values));
      expect(b.max).toBe(Math.max(...b.values));
    }
    // The launch transient is visible as `first` sitting below `max`.
    expect(branches[0].first).toBeLessThan(branches[0].max);
  });

  it('summarises each branch and uses the first branch median for the marker', async () => {
    const result = await parseOrkFile(loadOrk('ExamplePods-airframe and winglets.ork'));
    const branches = result.rocket.centerOfPressureBranches ?? [];
    const sorted = [...branches[0].values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    expect(branches[0].median).toBeCloseTo(sorted[mid], 6);
    expect(result.rocket.centerOfPressure).toBe(branches[0].median);
  });

  it('omits the branch list when the file has no simulation data', async () => {
    const result = await parseOrkFile(await syntheticOrk(''));
    expect(result.rocket.centerOfPressureBranches).toBeUndefined();
  });

  it('drops the post-apogee samples OpenRocket flags as a CP anomaly', async () => {
    // Mach < 0.05 is the threshold SymmetricComponentCalc.getLiftCP uses for its
    // apogee correction. Those rows must not reach the marker.
    const xml = cpOrk([
      '<datapoint>0.1,0.42,0.30</datapoint>',
      '<datapoint>0.2,0.42,0.30</datapoint>',
      '<datapoint>0.3,0.42,0.30</datapoint>',
      '<datapoint>3.0,0.10,0.010</datapoint>',
      '<datapoint>3.2,0.11,0.020</datapoint>',
      '<datapoint>3.4,0.12,0.030</datapoint>',
      '<datapoint>3.6,0.13,0.040</datapoint>',
      '<datapoint>3.8,0.14,0.049</datapoint>',
    ]);
    const result = await parseOrkFile(await cpOrkBuffer(xml));
    const branch = result.rocket.centerOfPressureBranches?.[0];
    expect(branch?.machFiltered).toBe(true);
    expect(branch?.apogeeSamples).toBe(5);
    expect(branch?.count).toBe(3);
    expect(branch?.values).toEqual([0.42, 0.42, 0.42]);
    expect(result.rocket.centerOfPressure).toBeCloseTo(0.42, 6);
  });

  it('keeps every sample when the flight never reaches Mach 0.05', async () => {
    // A slow glider: filtering would empty the branch, which is a worse answer
    // than a noisy one. `machFiltered` reports that the filter did not apply.
    const xml = cpOrk([
      '<datapoint>0.1,0.30,0.010</datapoint>',
      '<datapoint>0.2,0.31,0.020</datapoint>',
      '<datapoint>0.3,0.32,0.030</datapoint>',
    ]);
    const result = await parseOrkFile(await cpOrkBuffer(xml));
    const branch = result.rocket.centerOfPressureBranches?.[0];
    expect(branch?.machFiltered).toBe(false);
    expect(branch?.apogeeSamples).toBe(0);
    expect(branch?.count).toBe(3);
    expect(result.rocket.centerOfPressure).toBeCloseTo(0.31, 6);
  });

  it('takes the center of pressure from the branch the caller selects', async () => {
    const xml = cpOrk(
      [
        '<datapoint>0.1,0.30,0.3</datapoint>',
        '<datapoint>0.2,0.30,0.3</datapoint>',
        '<datapoint>0.3,0.30,0.3</datapoint>',
      ],
      [
        '<datapoint>0.1,0.50,0.3</datapoint>',
        '<datapoint>0.2,0.50,0.3</datapoint>',
        '<datapoint>0.3,0.50,0.3</datapoint>',
      ]
    );
    const buffer = await cpOrkBuffer(xml);

    const first = await parseOrkFile(buffer);
    expect(first.rocket.centerOfPressure).toBeCloseTo(0.30, 6);
    expect(first.rocket.centerOfPressureSource).toBe(0);

    const second = await parseOrkFile(buffer, { centerOfPressureBranch: 1 });
    expect(second.rocket.centerOfPressure).toBeCloseTo(0.50, 6);
    expect(second.rocket.centerOfPressureSource).toBe(1);
    // The full list is unaffected by the choice, so the UI can keep offering it.
    expect(second.rocket.centerOfPressureBranches).toHaveLength(2);
  });

  it('clamps an out-of-range branch selection to the last branch', async () => {
    const xml = cpOrk(
      [
        '<datapoint>0.1,0.30,0.3</datapoint>',
        '<datapoint>0.2,0.30,0.3</datapoint>',
        '<datapoint>0.3,0.30,0.3</datapoint>',
      ],
      [
        '<datapoint>0.1,0.50,0.3</datapoint>',
        '<datapoint>0.2,0.50,0.3</datapoint>',
        '<datapoint>0.3,0.50,0.3</datapoint>',
      ]
    );
    const buffer = await cpOrkBuffer(xml);
    const result = await parseOrkFile(buffer, { centerOfPressureBranch: 99 });
    expect(result.rocket.centerOfPressureSource).toBe(1);
    expect(result.rocket.centerOfPressure).toBeCloseTo(0.50, 6);
  });

  it('leaves centerOfPressureSource unset when there is nothing to pick from', async () => {
    const result = await parseOrkFile(await syntheticOrk(''));
    expect(result.rocket.centerOfPressureSource).toBeUndefined();
  });

  it('skips a branch with no usable CP rather than emitting an empty entry', async () => {
    // Bell X-1's "Simulation 1" has flight data but no usable CP column, so the
    // list starts at Simulation 2.
    expect(bellX1.rocket.centerOfPressureBranches?.[0].simulation).toBe('Simulation 2');
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

  it('resolves an automatic tube fin radius from the parent body', async () => {
    const xml = `<bodytube>
      <name>Body</name>
      <radius>0.05</radius>
      <length>0.2</length>
      <thickness>0.001</thickness>
      <subcomponents><tubefinset>
        <name>Auto Tube Fins</name>
        <fincount>3</fincount>
        <length>0.1</length>
        <radius>auto</radius>
        <thickness>0.001</thickness>
      </tubefinset></subcomponents>
    </bodytube>`;
    const result = await parseOrkFile(await syntheticOrk(xml));
    const fin = findByName(result.rocket.components, 'Auto Tube Fins');
    expect(fin).toBeDefined();
    expect((fin!.params as any).autoOuterRadius).toBe(true);
    computeDerivedData(result);
    const expected = 0.05 * Math.sin(Math.PI / 3) / (1 - Math.sin(Math.PI / 3));
    expect((fin!.params as any).outerRadius).toBeCloseTo(expected, 8);
  });

  it('parses elliptical fin set dimensions and derives its planform', async () => {
    const xml = `<ellipticalfinset>
      <name>Elliptical Fins</name>
      <fincount>4</fincount>
      <rootchord>0.1</rootchord>
      <height>0.06</height>
      <thickness>0.002</thickness>
      <axialoffset method="bottom">0.05</axialoffset>
    </ellipticalfinset>`;
    const result = await parseOrkFile(await syntheticOrk(xml));
    const fin = findByName(result.rocket.components, 'Elliptical Fins');
    expect(fin).toBeDefined();
    expect(fin!.type).toBe('ellipticalfinset');
    expect(fin!.params).toMatchObject({ finCount: 4, rootChord: 0.1, height: 0.06, thickness: 0.002 });
    computeDerivedData(result);
    const planform = (fin!.params as any).planform;
    expect(planform.length).toBeGreaterThan(10);
    expect(Math.max(...planform.map((point: [number, number]) => Math.abs(point[1])))).toBeCloseTo(0.06, 6);
  });

  it('parses tube fin set dimensions and count', async () => {
    const xml = `<tubefinset>
      <name>Tube Fins</name>
      <fincount>3</fincount>
      <length>0.12</length>
      <radius>0.018</radius>
      <thickness>0.001</thickness>
      <rotation>15</rotation>
      <axialoffset method="bottom">0.05</axialoffset>
    </tubefinset>`;
    const result = await parseOrkFile(await syntheticOrk(xml));
    const fin = findByName(result.rocket.components, 'Tube Fins');
    expect(fin).toBeDefined();
    expect(fin!.type).toBe('tubefinset');
    expect(fin!.params).toMatchObject({
      finCount: 3,
      length: 0.12,
      outerRadius: 0.018,
      thickness: 0.001,
      baseRotation: 15 * Math.PI / 180,
    });
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
    // The file writes <tabposition> TWICE -- legacy `center` then modern
    // `middle`, both 0.01016 -- and reading it as a single object used to yield
    // position 0. See the tab-position block in parseFinCommon.
    expect(p.tab.position).toBeCloseTo(0.01016, 5);
  });

  it('reads the modern tabposition sibling, not the legacy one', async () => {
    // OpenRocket's FinSetSaver emits <tabposition> twice for pre-2021
    // compatibility: the legacy front/center/end spelling first, the modern
    // top/middle/bottom one second. They are two elements, so fast-xml-parser
    // returns an array and reading it as one object silently lost both the
    // offset and the method.
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>BT</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>
        <subcomponents>
          <trapezoidfinset><name>F</name><fincount>3</fincount><rootchord>0.15</rootchord>
            <tipchord>0.05</tipchord><sweeplength>0.05</sweeplength><height>0.06</height>
            <thickness>0.003</thickness>
            <tabheight>0.0127</tabheight><tablength>0.05</tablength>
            <tabposition relativeto="center">0.02</tabposition>
            <tabposition relativeto="top">0.02</tabposition>
          </trapezoidfinset>
        </subcomponents>
      </bodytube>`));
    const p = findByName(result.rocket.components, 'F')!.params as any;
    expect(p.tab.positionMethod).toBe('top');
    expect(p.tab.position).toBeCloseTo(0.02, 6);
  });

  it.each([
    ['top', 'front'],
    ['bottom', 'end'],
    ['middle', 'center'],
  ])('maps the modern %s tab position, ignoring the legacy %s one', async (modern, legacy) => {
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>BT</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>
        <subcomponents>
          <trapezoidfinset><name>F</name><fincount>3</fincount><rootchord>0.15</rootchord>
            <tipchord>0.05</tipchord><sweeplength>0.05</sweeplength><height>0.06</height>
            <thickness>0.003</thickness>
            <tabheight>0.0127</tabheight><tablength>0.05</tablength>
            <tabposition relativeto="${legacy}">0.03</tabposition>
            <tabposition relativeto="${modern}">0.03</tabposition>
          </trapezoidfinset>
        </subcomponents>
      </bodytube>`));
    const p = findByName(result.rocket.components, 'F')!.params as any;
    expect(p.tab.positionMethod).toBe(modern);
    expect(p.tab.position).toBeCloseTo(0.03, 6);
  });

  // FinSet.tabOffsetMethod is a full AxialMethod and FinSetSaver writes its
  // name verbatim, so a tab positioned from the tip of the rocket or from after
  // a sibling really does appear in a file.  Both used to be folded into
  // 'middle', which put the tab in the wrong place silently.
  it.each(['absolute', 'after'])('preserves the %s tab position method', async (method) => {
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>BT</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>
        <subcomponents>
          <trapezoidfinset><name>F</name><fincount>3</fincount><rootchord>0.15</rootchord>
            <tipchord>0.05</tipchord><sweeplength>0.05</sweeplength><height>0.06</height>
            <thickness>0.003</thickness>
            <tabheight>0.0127</tabheight><tablength>0.05</tablength>
            <tabposition relativeto="${method}">0.02</tabposition>
          </trapezoidfinset>
        </subcomponents>
      </bodytube>`));
    const p = findByName(result.rocket.components, 'F')!.params as any;
    expect(p.tab.positionMethod).toBe(method);
    expect(p.tab.position).toBeCloseTo(0.02, 6);
  });

  it('still reads a pre-2021 tab carrying only the legacy spelling', async () => {
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>BT</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>
        <subcomponents>
          <trapezoidfinset><name>F</name><fincount>3</fincount><rootchord>0.15</rootchord>
            <tipchord>0.05</tipchord><sweeplength>0.05</sweeplength><height>0.06</height>
            <thickness>0.003</thickness>
            <tabheight>0.0127</tabheight><tablength>0.05</tablength>
            <tabposition relativeto="end">0.04</tabposition>
          </trapezoidfinset>
        </subcomponents>
      </bodytube>`));
    const p = findByName(result.rocket.components, 'F')!.params as any;
    expect(p.tab.positionMethod).toBe('bottom');
    expect(p.tab.position).toBeCloseTo(0.04, 6);
  });

  it('defaults the tab to a centred position when the file has none', async () => {
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>BT</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>
        <subcomponents>
          <trapezoidfinset><name>F</name><fincount>3</fincount><rootchord>0.15</rootchord>
            <tipchord>0.05</tipchord><sweeplength>0.05</sweeplength><height>0.06</height>
            <thickness>0.003</thickness>
          </trapezoidfinset>
        </subcomponents>
      </bodytube>`));
    const p = findByName(result.rocket.components, 'F')!.params as any;
    expect(p.tab).toEqual({ height: 0, length: 0, position: 0, positionMethod: 'middle' });
  });

  it('reads the motor mount, and counts its configurations', async () => {
    // The mount is a bodytube/innertube attribute block, not a component.  Its
    // size and position now drive real geometry, so the fields that decide them
    // have to be right.
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>BT</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>
        <motormount>
          <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
          <overhang>0.0127</overhang>
          <motor configid="a"><type>single</type><designation>C6</designation>
            <diameter>0.018</diameter><length>0.07</length><delay>0.0</delay></motor>
        </motormount>
      </bodytube>`));
    const p = findByName(result.rocket.components, 'BT')!.params as any;
    expect(p.isMotorMount).toBe(true);
    expect(p.motorMount.overhang).toBeCloseTo(0.0127, 6);
    expect(p.motorMount.designation).toBe('C6');
    expect(p.motorMount.diameter).toBeCloseTo(0.018, 6);
    expect(p.motorMount.length).toBeCloseTo(0.07, 6);
    expect(p.motorMount.configurationCount).toBe(1);
  });

  it('does not warn about a mount that merely holds several motors', async () => {
    // Which configuration is used is now an explicit choice made in the open by
    // the webapp's dropdown, and recorded in the JSON. Warning about it on every
    // multi-motor rocket only trained the eye to skip the warning list.
    const motor = (id: string, designation: string, length: string) =>
      `<motor configid="${id}"><type>single</type><designation>${designation}</designation>
         <diameter>0.018</diameter><length>${length}</length><delay>0.0</delay></motor>`;
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>Motor Tube</name><length>0.3</length><radius>0.012</radius><thickness>0.001</thickness>
        <motormount>
          <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
          <overhang>0.0127</overhang>
          ${motor('a', 'C6', '0.07')}
          ${motor('b', 'D12', '0.095')}
        </motormount>
      </bodytube>`));

    const p = findByName(result.rocket.components, 'Motor Tube')!.params as any;
    expect(p.motorMount.designation).toBe('C6');
    expect(p.motorMount.length).toBeCloseTo(0.07, 6);
    expect(p.motorMount.configurationCount).toBe(2);

    validateRocketJson(result);
    expect(
      result.warnings.some((w) => w.includes('Motor Tube') && w.includes('motor configurations'))
    ).toBe(false);
  });

  it('selects the motor belonging to the DEFAULT motor configuration', async () => {
    // A mount holds one <motor> per configuration and the rocket-level
    // <motorconfiguration default="true"> says which is loaded. Document order is
    // NOT that choice: on 4 of the 7 real test rockets they disagree.
    const motor = (id: string, designation: string, length: string) =>
      `<motor configid="${id}"><type>single</type><manufacturer>Estes</manufacturer>
         <digest>d${id}</digest><designation>${designation}</designation>
         <diameter>0.018</diameter><length>${length}</length><delay>0.0</delay></motor>`;
    const result = await parseOrkFile(await syntheticOrkWithRocketPreamble(`
      <motorconfiguration configid="cfg-1"><stage number="0" active="true"/></motorconfiguration>
      <motorconfiguration configid="cfg-2" default="true"><stage number="0" active="true"/></motorconfiguration>`,
      `
      <bodytube><name>Motor Tube</name><length>0.3</length><radius>0.012</radius><thickness>0.001</thickness>
        <motormount>
          <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
          <overhang>0.0127</overhang>
          ${motor('cfg-1', 'C6', '0.07')}
          ${motor('cfg-2', 'D12', '0.095')}
        </motormount>
      </bodytube>`));

    const p = findByName(result.rocket.components, 'Motor Tube')!.params as any;
    // cfg-2 is the default, so D12 wins even though C6 is written first.
    expect(p.motorMount.designation).toBe('D12');
    expect(p.motorMount.length).toBeCloseTo(0.095, 6);
    expect(p.motorMount.manufacturer).toBe('Estes');
    expect(p.motorMount.digest).toBe('dcfg-2');
    // Every candidate is retained, so the choice is inspectable.
    expect(p.motorMount.configurations.map((c: any) => c.designation)).toEqual(['C6', 'D12']);
  });

  it('falls back to the first motor when no default configuration is declared', async () => {
    const result = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>Motor Tube</name><length>0.3</length><radius>0.012</radius><thickness>0.001</thickness>
        <motormount>
          <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
          <overhang>0.0127</overhang>
          <motor configid="a"><designation>C6</designation><diameter>0.018</diameter><length>0.07</length></motor>
          <motor configid="b"><designation>D12</designation><diameter>0.024</diameter><length>0.095</length></motor>
        </motormount>
      </bodytube>`));
    const p = findByName(result.rocket.components, 'Motor Tube')!.params as any;
    expect(p.motorMount.designation).toBe('C6');
  });

  it('picks each mount against the same default configuration', () => {
    // The default configuration is a property of the ROCKET, so every mount --
    // including one nested in a booster stage -- resolves against the same id.
    // These are the default configuration's motors, NOT the first one written:
    // Antar opens C6/D13W/D20W and flies D20W, Bell X-1 opens D12 and flies E12.
    expect(mountOf(demon, 'Inner Tube').designation).toBe('I200W');
    expect(mountOf(antar, 'Motor tube').designation).toBe('D20W');
    expect(mountOf(bellX1, 'Motor Mount Tube').designation).toBe('E12');
  });

  it('leaves a mount with no motor alone, and keeps every candidate on a real rocket', async () => {
    // TestBooster's first mount is a motor mount with nothing loaded in it; a
    // fallback to "no motor" must not delete the motor on the second mount.
    const booster = await parseOrkFile(loadOrk('TestBooster.ork'));
    const mounts = flatten(booster.rocket.components).filter((c) => (c.params as any)?.isMotorMount);
    expect(mounts).toHaveLength(2);
    expect((mounts[0].params as any).motorMount.designation).toBe('');
    expect((mounts[0].params as any).motorMount.diameter).toBe(0);
    expect((mounts[1].params as any).motorMount.designation).toBe('1/2A6');

    const dem = mountOf(demon, 'Inner Tube');
    expect(dem.configurations).toHaveLength(5);
    expect(dem.configurations.map((c: any) => c.designation)).toEqual([
      'H250G', 'I200W', 'H180W', 'H268R', 'H128W',
    ]);
    // The digest is what OpenRocket resolves the motor's MASS from, so it has to
    // survive parsing even though the mass itself is not in the file.
    expect(dem.digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it('lists every motor configuration, flagging the file default', async () => {
    // `demon 54.ork` declares five, and the default is the second one -- the
    // ordering the webapp's dropdown renders in document order.
    const configs = demon.rocket.motorConfigurations!;
    expect(configs).toHaveLength(5);
    expect(configs.map((c) => c.isDefault)).toEqual([false, true, false, false, false]);
    // No <name> is written unless the designer overrode it, so most are ''.
    expect(configs.every((c) => c.name === '')).toBe(true);
    expect(configs[0].stages).toEqual([{ number: 0, active: true }]);
    // The default is what the mounts resolved against when nothing was asked for.
    expect(demon.rocket.motorConfigurationSource).toBe(configs[1].configId);
  });

  it('keeps a configuration name and multi-stage activeness for the booster', async () => {
    // TestBooster's only configuration has two stages, which is the shape the
    // dropdown label has to survive.
    const booster = await parseOrkFile(loadOrk('TestBooster.ork'));
    const config = booster.rocket.motorConfigurations![0];
    expect(config.isDefault).toBe(true);
    expect(config.stages).toEqual([
      { number: 0, active: true },
      { number: 1, active: true },
    ]);
  });

  it('resolves every mount against a user-picked motor configuration', async () => {
    // The whole point of the dropdown: build a configuration that is not the
    // file's default. `demon 54.ork` opens with H250G and flies I200W, so
    // asking for the opening configuration must put H250G back.
    const first = demon.rocket.motorConfigurations![0].configId;
    const picked = await parseOrkFile(loadOrk('demon 54.ork'), { motorConfiguration: first });
    const mount = mountOf(picked, 'Inner Tube');
    expect(picked.rocket.motorConfigurationSource).toBe(first);
    expect(mount.designation).toBe('H250G');
    expect(mount.selectedConfigId).toBe(first);
    // The candidates are unchanged -- only the resolution moved.
    expect(mount.configurations).toHaveLength(5);

    // And the default still wins when no option is passed.
    expect(mountOf(demon, 'Inner Tube').designation).toBe('I200W');
  });

  it('falls back to the default when the requested configuration is unknown', async () => {
    // A stale id must not silently resolve to "no motor anywhere".
    const picked = await parseOrkFile(loadOrk('demon 54.ork'), { motorConfiguration: 'not-a-config' });
    expect(picked.rocket.motorConfigurationSource).toBe(demon.rocket.motorConfigurationSource);
    expect(mountOf(picked, 'Inner Tube').designation).toBe('I200W');
  });

  it('omits the configuration list for a file that declares none', async () => {
    const plain = await parseOrkFile(await syntheticOrk(`
      <bodytube><name>BT</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>
        <motormount>
          <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
          <overhang>0.0127</overhang>
          <motor configid="a"><designation>C6</designation><diameter>0.018</diameter><length>0.07</length></motor>
        </motormount>
      </bodytube>`));
    expect(plain.rocket.motorConfigurations).toBeUndefined();
    expect(plain.rocket.motorConfigurationSource).toBeUndefined();
    // No configuration to match, so the first motor is taken and says so.
    const mount = mountOf(plain, 'BT');
    expect(mount.designation).toBe('C6');
    expect(mount.selectedConfigId).toBe('a');
  });

  it('builds NO motor for a configuration that loads none, and says so', async () => {
    // The one genuinely silent case, and a real bug before this change: the
    // parser fell back to the first motor whenever the selected configuration
    // had none for that mount. That is defensible for the file's DEFAULT
    // configuration (which loads a motor in every mount by definition) but not
    // for one the user picked -- it fabricated a motor the configuration never
    // loads, contradicting the dropdown's own "no motors" label.
    const motor = (id: string, designation: string, length: string) =>
      `<motor configid="${id}"><type>single</type><designation>${designation}</designation>
         <diameter>0.018</diameter><length>${length}</length><delay>0.0</delay></motor>`;
    const preamble = `
      <motorconfiguration configid="cfg-1"><name>Loaded</name><stage number="0" active="true"/></motorconfiguration>
      <motorconfiguration configid="cfg-2" default="true"><name>Parked</name><stage number="0" active="true"/></motorconfiguration>`;
    // The mount only defines a motor for cfg-1, so cfg-2 genuinely has none.
    const body = `
      <bodytube><name>Motor Tube</name><length>0.3</length><radius>0.012</radius><thickness>0.001</thickness>
        <motormount>
          <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
          <overhang>0.0127</overhang>
          ${motor('cfg-1', 'C6', '0.07')}
        </motormount>
      </bodytube>`;

    const parked = await parseOrkFile(await syntheticOrkWithRocketPreamble(preamble, body));
    const p = parked.rocket.components[0].children[0] as any;
    expect(p.params.motorMount.designation).toBe('');
    expect(p.params.motorMount.selectedConfigId).toBe('');
    expect(p.params.motorMount.diameter).toBe(0);
    // The candidates are still there, so the emptiness is explainable.
    expect(p.params.motorMount.configurations.map((c: any) => c.designation)).toEqual(['C6']);

    validateRocketJson(parked);
    const detail = parked.warningDetails?.find((w) => w.message.includes('loads no motor'));
    expect(detail).toBeDefined();
    expect(detail!.message).toContain('Motor Tube');
    expect(detail!.message).toContain('C6');
    // Low, not medium: it must not block the auto-download the old one did.
    expect(detail!.severity).toBe('low');

    // The configuration that DOES load a motor is unaffected and unremarkable.
    const loaded = await parseOrkFile(await syntheticOrkWithRocketPreamble(preamble, body), {
      motorConfiguration: 'cfg-1',
    });
    expect((loaded.rocket.components[0].children[0] as any).params.motorMount.designation).toBe('C6');
    validateRocketJson(loaded);
    expect(loaded.warningDetails?.some((w) => w.message.includes('loads no motor'))).toBe(false);
  });

  it('leaves a genuinely motorless mount alone, with no warning at all', async () => {
    // TestBooster's first mount is a motor mount with nothing in it in ANY
    // configuration. That is not a configuration choice, so it is not our
    // business to warn about.
    const booster = await parseOrkFile(loadOrk('TestBooster.ork'));
    validateRocketJson(booster);
    const mounts = flatten(booster.rocket.components).filter((c) => (c.params as any)?.isMotorMount);
    expect((mounts[0].params as any).motorMount.configurationCount).toBe(0);
    expect(booster.warnings.some((w) => w.includes('loads no motor'))).toBe(false);
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

  it('derives a centering ring auto inner radius only from OVERLAPPING motor tubes (Antar)', async () => {
    // 'Centering Ring - R' has <innerradius>auto</innerradius>. It sits at the
    // bottom of the body tube, overlapping the 'Motor tube' but NOT the
    // 'Retainer Ring' (which is farther forward). OpenRocket's
    // CenteringRing.getInnerRadius() only counts inner-tube siblings whose
    // axial span overlaps the ring, so the hole matches the motor tube — the
    // larger outer radius of the non-overlapping retainer ring must be ignored.
    const antarCopy = await parseOrkFile(loadOrk('Antar - Estes 7310.ork'));
    computeDerivedData(antarCopy);

    const rear = flatten(antarCopy.rocket.components).find(
      (c) => c.type === 'centeringring' && c.name === 'Centering Ring - R'
    )!;
    expect(rear).toBeDefined();
    const parent = flatten(antarCopy.rocket.components).find(
      (c) => c.children.some((k) => k.id === rear.id)
    )!;
    expect(parent).toBeDefined();
    const innertubes = parent.children.filter((s) => s.type === 'innertube');
    expect(innertubes.length).toBeGreaterThanOrEqual(2);

    // The motor tube is the only sibling inner tube that overlaps the ring.
    const motorTube = innertubes.find((s) => s.name === 'Motor tube')!;
    expect(motorTube).toBeDefined();
    const motorOuter = (motorTube.params as any).outerRadius as number;
    expect(motorOuter).toBeGreaterThan(0);

    const resolved = (rear.params as any).innerRadius as number;
    expect(resolved).toBeCloseTo(motorOuter, 6);

    // A non-overlapping inner tube with a LARGER outer radius (Retainer Ring)
    // must not define the ring hole.
    const maxInner = Math.max(0, ...innertubes.map((s) => (s.params as any).outerRadius ?? 0));
    expect(resolved).toBeLessThan(maxInner);
  });

  it('resolves a centering ring auto OUTER radius to the enclosing tube inner radius (Antar)', async () => {
    // The rear ring's explicit outer radius (0.0201168) equals its parent body
    // tube's inner radius (outer 0.020828 − wall 0.0007112). If it were marked
    // `auto`, the pass must synthesize the same value from the parent instead
    // of leaving it 0.
    const antarCopy = await parseOrkFile(loadOrk('Antar - Estes 7310.ork'));
    const rear = flatten(antarCopy.rocket.components).find(
      (c) => c.type === 'centeringring' && c.name === 'Centering Ring - R'
    )!;
    const parent = flatten(antarCopy.rocket.components).find(
      (c) => c.children.some((k) => k.id === rear.id)
    )!;

    // Force the outer radius to be auto by blanking the stored value.
    (rear.params as any).autoOuterRadius = true;
    (rear.params as any).outerRadius = 0;

    computeDerivedData(antarCopy);

    const pp = parent.params as any;
    const parentInner = Math.max(0, pp.outerRadius - pp.thickness);
    expect(parentInner).toBeGreaterThan(0);
    expect((rear.params as any).outerRadius).toBeCloseTo(parentInner, 6);
  });

  it('parses transition (in Antar)', () => {
    const trans = findByName(antar.rocket.components, 'Transition');
    expect(trans).toBeDefined();
    expect(trans!.type).toBe('transition');
    const p = trans!.params as any;
    expect(p.shape).toBeDefined();
    expect(p.length).toBeGreaterThan(0);
  });

  it('flags auto fore radius on transitions (Bell X-1)', () => {
    // Bell X-1's first transition has <foreradius>auto 0.025</foreradius>
    const trans = flatten(bellX1.rocket.components).find(
      (c) => c.type === 'transition' && (c.params as any).foreRadiusAutomatic
    );
    expect(trans).toBeDefined();
    const p = trans!.params as any;
    expect(p.foreRadius).toBeCloseTo(0.025, 4);
  });

  it('parses freeform fin set (in Antar)', () => {
    const fins = flatten(antar.rocket.components).filter((c) => c.type === 'freeformfinset');
    expect(fins.length).toBeGreaterThan(0);
    const p = fins[0].params as any;
    expect(p.points.length).toBeGreaterThan(2);
    expect(Array.isArray(p.points[0])).toBe(true);
    expect(p.points[0].length).toBe(2);
  });

  it('adds the freeform fin root chord to params', async () => {
    const antarCopy = await parseOrkFile(loadOrk('Antar - Estes 7310.ork'));
    computeDerivedData(antarCopy);
    const fins = flatten(antarCopy.rocket.components).filter((c) => c.type === 'freeformfinset');
    expect(fins.length).toBeGreaterThan(0);
    const p = fins[0].params as any;
    // The fin's axial length is its ROOT CHORD: the first planform point to
    // the last (OpenRocket FinSet.getLength() -> getRootChord()). It is not
    // the max(x) - min(x) span, which overstates a swept freeform outline.
    const first = p.points[0][0] as number;
    const last = p.points[p.points.length - 1][0] as number;
    const expected = Math.max(0, last - first);
    expect(expected).toBeGreaterThan(0);
    expect(p.length).toBeCloseTo(expected, 6);
  });

  it('parses pod set with children (in Antar)', () => {
    const pods = flatten(antar.rocket.components).filter((c) => c.type === 'podset');
    expect(pods.length).toBeGreaterThan(0);
    expect(pods[0].children.length).toBeGreaterThan(0);
    expect(pods[0].position.radiusOffset).toBeGreaterThan(0);
    // A pod's sideways offset is stored as <radiusoffset method="free">:
    // the distance from the parent's centre.  It must survive parsing under
    // that name -- the feature script branches on it to move the pod (and,
    // through it, its children) off the rocket axis.
    expect(pods[0].position.radiusMethod).toBe('free');
  });

  it('parses parallel stages as radial booster assemblies with children', async () => {
    const result = await parseOrkFile(await syntheticOrk(`
      <parallelstage>
        <name>Booster Set</name>
        <separationevent>ejection</separationevent>
        <separationaltitude>200</separationaltitude>
        <separationdelay>1.5</separationdelay>
        <subcomponents>
          <bodytube>
            <name>Booster Tube</name>
            <length>0.4</length>
            <outerradius>0.025</outerradius>
            <thickness>0.002</thickness>
            <subcomponents>
              <trapezoidfinset>
                <name>Booster Fins</name>
                <fincount>3</fincount><rootchord>0.08</rootchord>
                <height>0.04</height><thickness>0.003</thickness>
              </trapezoidfinset>
            </subcomponents>
          </bodytube>
        </subcomponents>
      </parallelstage>`));

    const stage = result.rocket.components.find((component) => component.type === 'stage')!;
    const booster = stage.children.find((component) => component.type === 'parallelstage')!;
    expect(booster.name).toBe('Booster Set');
    expect(booster.position).toMatchObject({
      axialMethod: 'bottom',
      axialOffset: 0,
      instanceCount: 2,
      angleMethod: 'relative',
      angleOffset: 0,
      radiusMethod: 'relative',
      radiusOffset: 0,
    });
    expect(booster.params).toMatchObject({
      separation: { event: 'ejection', altitude: 200, delay: 1.5 },
    });
    expect(booster.children[0].name).toBe('Booster Tube');
    expect(booster.children[0].children[0].name).toBe('Booster Fins');

    computeDerivedData(result);
    expect((booster.params as any).length).toBeCloseTo(0.4, 6);
    // RadiusMethod.RELATIVE adds the booster's ComponentAssembly bounding radius.
    expect((booster.position as any).parentRadius).toBeCloseTo(0.025, 6);
    // An off-axis BOTTOM assembly is not an AFTER child and must not lengthen
    // the centreline stage.
    expect((stage.params as any).length).toBeCloseTo(1e-9, 12);
  });

  it('normalizes the legacy boosterset tag to parallelstage', async () => {
    const result = await parseOrkFile(await syntheticOrk(`
      <boosterset><name>Legacy Boosters</name><instancecount>3</instancecount>
        <subcomponents><bodytube><name>Tube</name><length>0.2</length>
          <outerradius>0.02</outerradius><thickness>0.001</thickness></bodytube></subcomponents>
      </boosterset>`));
    const stage = result.rocket.components.find((component) => component.type === 'stage')!;
    const booster = stage.children[0];
    expect(booster.type).toBe('parallelstage');
    expect(booster.position.instanceCount).toBe(3);
    expect(booster.position.axialMethod).toBe('bottom');
    expect(booster.position.radiusMethod).toBe('relative');
  });

  it('keeps a pod set at its declared instance count and defaults the rest to two', async () => {
    // OpenRocket's PodSet initialises instanceCount to 2 and the saver always
    // writes <instancecount>, so an explicit value must win and a missing one
    // must fall back to 2 rather than 1 -- otherwise the modeller gets one pod
    // where the design asked for two.
    const result = await parseOrkFile(await syntheticOrk(`
      <podset><name>Two pods</name><length>0.2</length>
        <instancecount>2</instancecount><radiusoffset method="relative">0.05</radiusoffset>
        <axialoffset method="bottom">0.1</axialoffset>
        <subcomponents><bodytube><name>Tube</name><length>0.2</length>
          <outerradius>0.02</outerradius><thickness>0.001</thickness></bodytube></subcomponents>
      </podset>
      <podset><name>Default pods</name><length>0.2</length>
        <radiusoffset method="relative">0.05</radiusoffset>
        <axialoffset method="bottom">0.3</axialoffset>
        <subcomponents><bodytube><name>Tube</name><length>0.2</length>
          <outerradius>0.02</outerradius><thickness>0.001</thickness></bodytube></subcomponents>
      </podset>
      <bodytube><name>Plain</name><length>0.2</length>
        <outerradius>0.02</outerradius><thickness>0.001</thickness></bodytube>`));
    const pods = flatten(result.rocket.components).filter((c) => c.type === 'podset');
    const two = pods.find((p) => p.name === 'Two pods')!;
    const fallback = pods.find((p) => p.name === 'Default pods')!;
    const plain = flatten(result.rocket.components).find((c) => c.name === 'Plain')!;

    expect(two.position.instanceCount).toBe(2);
    expect(fallback.position.instanceCount).toBe(2);
    // A non-assembly component must still default to a single instance.
    expect(plain.position.instanceCount).toBe(1);
  });

  it('derives pod set length as the sum of the direct child lengths', async () => {
    const lowBoomCopy = await parseOrkFile(loadOrk('Low-Boom SST.ork'));
    computeDerivedData(lowBoomCopy);
    const pods = flatten(lowBoomCopy.rocket.components).filter((c) => c.type === 'podset');
    expect(pods.length).toBeGreaterThan(0);
    let positiveFound = false;
    for (const pod of pods) {
      const expected = pod.children.reduce(
        (sum, child) => {
          const p = child.params as any;
          return sum + (p.rootChord ?? p.length ?? 0);
        },
        0
      );
      if (expected > 0) positiveFound = true;
      expect((pod.params as any).length).toBeCloseTo(expected, 6);
    }
    // The cockpit pod contains a nose cone + transition, so at least one pod
    // must resolve to a strictly positive length.
    expect(positiveFound).toBe(true);
  });


  it('parses launch lug (in Kerbal)', () => {
    const lugs = flatten(kerbal.rocket.components).filter((c) => c.type === 'launchlug');
    expect(lugs.length).toBeGreaterThan(0);
    const p = lugs[0].params as any;
    expect(p.outerRadius).toBeGreaterThan(0);
    expect(p.length).toBeGreaterThan(0);
  });

  it('derives the launch lug offset radius from its parent surface', () => {
    computeDerivedData(kerbal);
    const lugs = flatten(kerbal.rocket.components).filter((c) => c.type === 'launchlug');
    expect(lugs.length).toBeGreaterThan(0);
    // Parent is a body tube, so the offset equals the parent's outer radius
    const p = lugs[0].params as any;
    expect(p.offsetRadius).toBeCloseTo(0.020828, 6);
  });

  it('derives the rail button offset radius from its parent surface', () => {
    computeDerivedData(demon);
    const rails = flatten(demon.rocket.components).filter((c) => c.type === 'railbutton');
    expect(rails.length).toBeGreaterThan(0);
    // Rail buttons always sit on the parent's surface, so the derived offset
    // must be the parent's surface radius (> 0).
    for (const rail of rails) {
      expect((rail.params as any).offsetRadius).toBeGreaterThan(0);
    }
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
    // FeatureScript uses packedLength as the component length when resolving
    // MIDDLE placement, matching OpenRocket's MassObject.getLength().
    expect(p.packedLength).toBeGreaterThan(0);
    expect(p.packedRadius).toBeGreaterThan(0);
  });

  it('parses materials with density and type', () => {
    const nose = findByName(demon.rocket.components, 'Nose Cone');
    expect(nose!.material).toBeDefined();
    expect(nose!.material!.name).toContain('Fiberglass');
    expect(nose!.material!.type).toBe('bulk');
    expect(nose!.material!.density).toBeCloseTo(1800, 0);
  });

  it('parses component color from appearance paint (Bell X-1 launch lug)', () => {
    const lugs = flatten(bellX1.rocket.components).filter((c) => c.type === 'launchlug');
    expect(lugs.length).toBeGreaterThan(0);
    // <paint red="255" green="102" blue="0" alpha="0"/> → RGBA 0..1 (Onshape Color)
    expect(lugs[0].color).toEqual({ red: 1, green: 0.4, blue: 0, alpha: 0 });
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

  // RocketComponentSaver writes `<radialdirection>` alongside `<angleoffset>` from
  // the same value for components that are not fin sets / pod sets / parallel
  // stages / rail buttons. They are the same angle, so honouring both would spin
  // such a component by twice its angle.
  it('does not apply <radialdirection> on top of <angleoffset>', async () => {
    const json = await parseOrkFile(
      await syntheticOrk(`
        <launchlug>
          <name>Launch lug</name>
          <angleoffset method="relative">180.0</angleoffset>
          <radialdirection>180.0</radialdirection>
        </launchlug>`),
    );
    const lug = findByName(json.rocket.components, 'Launch lug');
    expect(lug).toBeDefined();
    expect(lug!.position.angleOffset).toBeCloseTo(Math.PI, 6);
    expect(lug!.position.radialDirection).toBe(0);
  });

  it('still honours <radialdirection> in legacy files with no modern angle', async () => {
    const json = await parseOrkFile(
      await syntheticOrk(`
        <launchlug>
          <name>Launch lug</name>
          <radialdirection>90.0</radialdirection>
        </launchlug>`),
    );
    const lug = findByName(json.rocket.components, 'Launch lug');
    expect(lug).toBeDefined();
    expect(lug!.position.angleOffset).toBe(0);
    expect(lug!.position.radialDirection).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('computeDerivedData', () => {
  let demon: RocketJson;

  beforeAll(async () => {
    demon = await parseOrkFile(loadOrk('demon 54.ork'));
    computeDerivedData(demon);
  });

  it('adds a profile to nose cones (x=radius, fore at y=length)', () => {
    const nose = findByName(demon.rocket.components, 'Nose Cone');
    const p = nose!.params as any;
    expect(p.profile).toBeDefined();
    expect(p.profile.length).toBe(51);
    // fore (first point): (radius 0, y = length)
    expect(p.profile[0][0]).toBeCloseTo(0, 5);
    expect(p.profile[0][1]).toBeCloseTo(0.2413, 3);
    // aft (last point): (aft radius, y = 0)
    expect(p.profile[50][0]).toBeCloseTo(0.02667, 4);
    expect(p.profile[50][1]).toBeCloseTo(0, 5);
  });

  it('adds a planform to trapezoid fins', () => {
    const fins = findByName(demon.rocket.components, 'Trapezoidal Fin Set');
    const p = fins!.params as any;
    expect(p.planform).toBeDefined();
    expect(p.planform.length).toBeGreaterThan(4);
    expect(p.planform[0][0]).toBeCloseTo(0, 5);
    expect(p.planform[0][1]).toBeCloseTo(0, 5);
  });

  it('clamps an exactly-zero length, but leaves a zero packedLength alone', () => {
    // These two look like the same case and are NOT. A zero `length` is a
    // degenerate loft/fillet waiting to happen, so it is nudged positive. A zero
    // `packedLength` is a real, meaningful value -- a mass marker with no axial
    // extent -- and OpenRocket's MassObject.getLength() returns it unchanged.
    // Clamping it fabricated a 1 nm tall section whose revolve failed with
    // REVOLVE_FAILED, so the zero is now passed through for the FeatureScript to
    // honour (see the packedCanisterSketch guard).
    const mkPos = (overrides: Partial<Position>): Position => ({
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
      ...overrides,
    });
    const rocketJson: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: '', designer: '', revision: '', designType: '', kitName: '',
        referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [
          {
            type: 'stage', name: 'S', id: 's',
            position: mkPos({}),
            params: {} as any,
            children: [
              {
                type: 'parachute', name: 'Chute', id: 'c',
                position: mkPos({}),
                params: { packedLength: 0, packedRadius: 0.01 },
                children: [],
              },
              {
                type: 'bodytube', name: 'Tube', id: 'b',
                position: mkPos({}),
                params: { length: 0, outerRadius: 0.02, innerRadius: 0.018 },
                children: [],
              },
            ],
          },
        ],
      },
      warnings: [],
    };
    computeDerivedData(rocketJson);
    const chute = rocketJson.rocket.components[0].children[0];
    const tube = rocketJson.rocket.components[0].children[1];
    // The mass marker keeps its zero ...
    expect((chute.params as any).packedLength).toBe(0);
    // ... while a zero `length` is still nudged positive.
    expect((tube.params as any).length).toBeCloseTo(1e-9, 12);
  });

  it('keeps a missing recovery mass undefined instead of coercing it to zero', async () => {
    const json = await parseOrkFile(await syntheticOrk('<parachute><name>Chute</name><diameter>1</diameter><packedlength>0.1</packedlength><packedradius>0.05</packedradius></parachute>'));
    const chute = flatten(json.rocket.components).find((component) => component.type === 'parachute')!;
    expect((chute.params as any).mass).toBeUndefined();
  });

  it('adds mass estimates to components with materials', () => {
    const nose = findByName(demon.rocket.components, 'Nose Cone');
    expect((nose as any).mass).toBeGreaterThan(0);
    const body = findByName(demon.rocket.components, 'Body Tube');
    expect((body as any).mass).toBeGreaterThan(0);
  });

  it('derives stage length as the sum of direct child lengths', () => {
    const stage = demon.rocket.components.find((c) => c.type === 'stage')!;
    const expected = stage.children.reduce(
      (sum, child) => {
        const p = child.params as any;
        return sum + (p.rootChord ?? p.length ?? 0);
      },
      0
    );
    expect(stage.children.length).toBeGreaterThan(0);
    expect((stage.params as any).length).toBeCloseTo(expected, 6);
    // Sanity: the body tube alone contributes its full length
    const body = stage.children.find((c) => c.type === 'bodytube')! as any;
    expect(expected).toBeGreaterThanOrEqual(body.params.length);
  });

  it('gives the derived parent radius to relative AND surface, but never to a surface-mounted part', () => {
    // No bundled .ork uses <radiusoffset method="relative">, so build a
    // minimal rocket: stage → bodytube → launchlug (relative) + fin (surface)
    const mkPos = (overrides: Partial<Position>): Position => ({
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
      ...overrides,
    });
    // A pod set is positioned by the FeatureScript through position.parentRadius
    // rather than through params.offsetRadius, which makes it the component that
    // actually exercises the derived radius.
    const pod = (id: string, method: Position['radiusMethod']): RocketJson['rocket']['components'][number] => ({
      type: 'podset', name: `Pod ${id}`, id,
      position: mkPos({ radiusMethod: method, axialMethod: 'bottom' }),
      params: {} as any,
      children: [
        {
          type: 'bodytube', name: `Pod tube ${id}`, id: `${id}t`,
          position: mkPos({}),
          params: { length: 0.1, outerRadius: 0.012, thickness: 0.002, filled: false, isMotorMount: false },
          children: [],
        },
      ],
    });
    const rocketJson: RocketJson = {
      schemaVersion: '1.0',
      rocket: {
        name: '', designer: '', revision: '', designType: '', kitName: '',
        referenceType: 'maximum', referenceLength: 0, unitSystem: 'SI',
        components: [
          {
            type: 'stage', name: 'S', id: 's',
            position: mkPos({}),
            params: {} as any,
            children: [
              {
                type: 'bodytube', name: 'Body', id: 'b',
                position: mkPos({}),
                params: { length: 0.2, outerRadius: 0.025, thickness: 0.002, filled: false, isMotorMount: false },
                children: [
                  {
                    type: 'launchlug', name: 'Lug', id: 'l',
                    position: mkPos({ radiusMethod: 'relative' }),
                    params: { outerRadius: 0.005, innerRadius: 0.004, thickness: 0.001, length: 0.01 },
                    children: [],
                  },
                  {
                    type: 'trapezoidfinset', name: 'Fins', id: 'f',
                    position: mkPos({ radiusMethod: 'surface' }),
                    params: { finCount: 3, thickness: 0.003, crossSection: 'square', cantAngle: 0, baseRotation: 0,
                      tab: { height: 0, length: 0, position: 0, positionMethod: 'middle' }, filletRadius: 0,
                      rootChord: 0.05, tipChord: 0.02, sweepLength: 0.02, height: 0.03 },
                    children: [],
                  },
                  pod('pr', 'relative'),
                  pod('ps', 'surface'),
                  pod('pc', 'coaxial'),
                ],
              },
            ],
          },
        ],
      },
      warnings: [],
    };
    computeDerivedData(rocketJson);

    const body = rocketJson.rocket.components[0].children[0];
    const [lug, fins, relativePod, surfacePod, coaxialPod] = body.children;

    // Both surface-measured methods need the derived radius. `surface` is the
    // encoding the saver writes by default and the most common value in real
    // files, so keying this off 'relative' alone left the common case with no
    // radius to offset from and the FeatureScript dropped it on the rocket axis.
    expect(relativePod.position.radiusMethod).toBe('relative');
    expect((relativePod.position as any).parentRadius).toBeCloseTo(0.025 + 0.012, 6);
    expect(surfacePod.position.radiusMethod).toBe('surface');
    expect((surfacePod.position as any).parentRadius).toBeCloseTo(0.025 + 0.012, 6);

    // 'coaxial' measures from the axis, so it needs no parent radius.
    expect((coaxialPod.position as any).parentRadius).toBeUndefined();

    // A launch lug and a fin set place themselves through params.offsetRadius,
    // which the FeatureScript already folds into the revolve origin. Handing them
    // a parentRadius as well would displace them by the parent's radius twice.
    expect((lug.position as any).parentRadius).toBeUndefined();
    expect((lug.params as any).offsetRadius).toBeCloseTo(0.025, 6);
    expect((fins.position as any).parentRadius).toBeUndefined();
    expect((fins.params as any).offsetRadius).toBeCloseTo(0.025, 6);

    expect((body.position as any).parentRadius).toBeUndefined();
  });
});

describe('derived nose-cone / transition payloads', () => {
  it('gives every nose cone and transition a bore, whatever its shape or wall', async () => {
    // The FeatureScript's `sketchProfile` is typed, so a component arriving
    // without `innerProfile` is a COMPILE error there, not a runtime fallback:
    //   convertProfilePoints(params.innerProfile, …) does not match (array, …)
    // A payload missing it aborts the whole regeneration, so guard the invariant
    // across every checked-in rocket rather than trusting one shape by hand.
    for (const name of readdirSync(ORK_DIR).filter((f) => f.endsWith('.ork'))) {
      const json = await parseOrkFile(loadOrk(name));
      computeDerivedData(json);

      let symmetric = 0;
      const visit = (comps: RocketComponent[]) => {
        for (const c of comps) {
          if (c.type === 'nosecone' || c.type === 'transition') {
            const p = c.params as any;
            const where = `${name} / ${c.name}`;
            expect(p.profile, where).toBeDefined();
            expect(Array.isArray(p.profile) && p.profile.length > 1, where).toBe(true);
            expect(p.innerProfile, where).toBeDefined();
            expect(Array.isArray(p.innerProfile) && p.innerProfile.length > 1, where).toBe(true);
            expect(p.innerIsAxis, where).toBeDefined();
            // `totalLength` must be at least the bare cone/transition length.
            expect(p.totalLength, where).toBeGreaterThanOrEqual(p.length - 1e-12);
            symmetric += 1;
          }
          visit(c.children);
        }
      };
      visit(json.rocket.components);
      expect(symmetric, name).toBeGreaterThan(0);
    }
  });

  it('publishes a self-contained polygon for every shoulder that exists', async () => {
    // `sketchShoulder` is typed too, so a shoulder arriving without a usable
    // `profile`/`innerProfile` pair is a compile error in the FeatureScript. Both
    // keys are always present: `null` for an end with no shoulder, which the
    // FeatureScript reads as "nothing to revolve and nothing to union".
    for (const name of readdirSync(ORK_DIR).filter((f) => f.endsWith('.ork'))) {
      const json = await parseOrkFile(loadOrk(name));
      computeDerivedData(json);

      const visit = (comps: RocketComponent[]) => {
        for (const c of comps) {
          if (c.type === 'nosecone' || c.type === 'transition') {
            const p = c.params as any;
            const where = `${name} / ${c.name}`;
            expect(p.shoulderProfile, where).toBeDefined();
            for (const which of ['fore', 'aft'] as const) {
              const s = p.shoulderProfile[which];
              const key = which === 'fore' ? 'shoulderFore' : 'shoulderAft';
              const declared = p[key] ?? { radius: 0, length: 0 };
              const exists = declared.radius > 0 && declared.length > 0;
              if (!exists) {
                expect(s, `${where} / ${which}`).toBeNull();
                continue;
              }
              expect(Array.isArray(s?.profile) && s.profile.length > 1, `${where} / ${which}`).toBe(
                true
              );
              expect(
                Array.isArray(s?.innerProfile) && s.innerProfile.length > 1,
                `${where} / ${which}`
              ).toBe(true);
              expect(typeof s.innerIsAxis, `${where} / ${which}`).toBe('boolean');
            }
          }
          visit(c.children);
        }
      };
      visit(json.rocket.components);
    }
  });

  it('leaves a zero packed length at zero instead of fabricating a sliver', async () => {
    // `Bell X-1` carries a mass component "screw  eye (SE-1)" with
    // <packedlength>0.0</packedlength>: a mass marker with no axial extent, which
    // OpenRocket's MassObject.getLength() returns unchanged and renders no solid
    // for. The geometry pass used to clamp it to 1e-9 "so feature creation still
    // succeeds", which fabricated a 1 nm tall, 12.5 mm wide section -- and the
    // revolve of that failed with REVOLVE_FAILED. The clamp created the
    // degenerate feature it was meant to prevent.
    const json = await parseOrkFile(loadOrk('Bell X-1 - Starfire Design.ork'));
    computeDerivedData(json);

    const visit = (comps: RocketComponent[]) => {
      for (const c of comps) {
        if (c.type === 'masscomponent') {
          const p = c.params as any;
          if ((p.packedRadius ?? 0) > 0 && p.packedLength === 0) {
            // Found it: the marker, still exactly zero after the geometry pass.
            expect(p.packedLength, c.name).toBe(0);
          }
          // No mass component may be left with a non-zero-but-absurd length.
          expect(p.packedLength, c.name).not.toBe(1e-9);
        }
        visit(c.children);
      }
    };
    visit(json.rocket.components);
  });

  it('keeps the body section clear of the shoulders', async () => {
    // The refactor's whole point: the body's meridian section no longer moves
    // because a shoulder is present, so a component with shoulders must have a
    // section identical to the same component without them. The scan across all
    // six rockets is what caught the original bug.
    for (const name of readdirSync(ORK_DIR).filter((f) => f.endsWith('.ork'))) {
      const json = await parseOrkFile(loadOrk(name));
      computeDerivedData(json);

      const visit = (comps: RocketComponent[]) => {
        for (const c of comps) {
          if (c.type === 'nosecone' || c.type === 'transition') {
            const p = c.params as any;
            const where = `${name} / ${c.name}`;
            const bare = {
              ...p,
              shoulderFore: { radius: 0, length: 0, thickness: 0, capped: false },
              shoulderAft: { radius: 0, length: 0, thickness: 0, capped: false },
            };
            const withShoulders = symmetricProfile(p);
            const without = symmetricProfile(bare);
            expect(withShoulders.profile, where).toEqual(without.profile);
            expect(withShoulders.innerProfile, where).toEqual(without.innerProfile);
            // And nothing in the body section may sit outside the component.
            const maxOuter = Math.max(...withShoulders.profile.map((pt: [number, number]) => pt[0]));
            for (const pt of withShoulders.profile) {
              expect(pt[1], where).toBeLessThanOrEqual(p.length + 1e-12);
              expect(pt[1], where).toBeGreaterThanOrEqual(-1e-12);
              expect(pt[0], where).toBeLessThanOrEqual(maxOuter + 1e-9);
            }
          }
          visit(c.children);
        }
      };
      visit(json.rocket.components);
    }
  });
});