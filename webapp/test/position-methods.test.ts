/**
 * `<angleoffset method>` and `<radiusoffset method>` handling.
 *
 * The two questions these cover are (a) does the payload say what the file
 * said, and (b) does the derived geometry put the component where OpenRocket
 * would -- for a `surface` offset measured against a parent that is not a
 * constant-radius body tube.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseOrkFile } from '../src/parser';
import { computeDerivedData } from '../src/geometry';
import type { RocketComponent } from '../src/types';

async function parse(body: string) {
  const xml = `<openrocket version="1.10" creator="t"><rocket><subcomponents>
    <stage><name>S</name><subcomponents>${body}</subcomponents></stage>
  </subcomponents></rocket></openrocket>`;
  const zip = new JSZip();
  zip.file('rocket.ork', xml);
  const json = await parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
  computeDerivedData(json);
  return json;
}

function flatten(components: RocketComponent[]): RocketComponent[] {
  const all: RocketComponent[] = [];
  for (const c of components) {
    all.push(c);
    all.push(...flatten(c.children));
  }
  return all;
}

const find = (json: any, name: string) =>
  flatten(json.rocket.components).find((c) => c.name === name)!;

const TUBE = (children: string) => `
  <bodytube><name>TUBE</name>
    <material type="bulk" density="1850" group="C">Fiberglass</material>
    <length>0.4</length><outerradius>0.025</outerradius><thickness>0.002</thickness>
    <subcomponents>${children}</subcomponents>
  </bodytube>`;

const LUG = (extra: string, name = 'LUG') => `
  <launchlug><name>${name}</name>
    <material type="bulk" density="2700" group="M">Al</material>
    <outerradius>0.005</outerradius><innerradius>0.003</innerradius>
    <thickness>0.002</thickness><length>0.05</length>${extra}
  </launchlug>`;

describe('angle methods', () => {
  it('carries `fixed` through instead of dropping it', async () => {
    const json = await parse(
      TUBE(`<tubefinset><name>TF</name><fincount>4</fincount><length>0.1</length>
        <outerradius>0.004</outerradius><thickness>0.001</thickness>
        <angleoffset method="fixed">30.0</angleoffset></tubefinset>`)
    );
    const tf = find(json, 'TF');
    // `fixed` is a real AngleMethod, and the FeatureScript honours it the way
    // AngleMethod.FIXED does upstream: the component keeps its parent's angle
    // and the stored offset is not applied.
    expect(tf.position.angleMethod).toBe('fixed');
    expect(tf.position.angleOffset).toBeCloseTo(Math.PI / 6, 9);
  });

  it('keeps `relative` as the plain reading', async () => {
    const json = await parse(
      TUBE(`<tubefinset><name>TF</name><fincount>4</fincount><length>0.1</length>
        <outerradius>0.004</outerradius><thickness>0.001</thickness>
        <angleoffset method="relative">30.0</angleoffset></tubefinset>`)
    );
    expect(find(json, 'TF').position.angleMethod).toBe('relative');
  });

  it('rejects mirror_xy loudly rather than building a silently wrong angle', async () => {
    const json = await parse(
      TUBE(`<tubefinset><name>TF</name><fincount>4</fincount><length>0.1</length>
        <outerradius>0.004</outerradius><thickness>0.001</thickness>
        <angleoffset method="mirror_xy">30.0</angleoffset></tubefinset>`)
    );
    expect(find(json, 'TF').position.angleMethod).toBe('relative');
    const warning = json.warnings.find((w: string) => w.includes('mirror_xy'));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/MEDIUM/);
  });
});

describe('radius methods', () => {
  it('warns and falls back on an unknown method instead of casting it through', async () => {
    const json = await parse(TUBE(LUG('<radiusoffset method="sideways">0.01</radiusoffset>')));
    expect(find(json, 'LUG').position.radiusMethod).toBe('coaxial');
    expect(json.warnings.some((w: string) => w.includes('sideways'))).toBe(true);
  });

  it('puts a surface-mounted lug on the parent surface exactly once', async () => {
    const json = await parse(TUBE(LUG('<radiusoffset method="surface">0.010</radiusoffset>')));

    const lug = find(json, 'LUG');
    // The lug places itself through offsetRadius -- the FeatureScript adds this
    // and its own outer radius to the revolve origin -- so the centre lands at
    // the parent's surface radius plus the lug's own.
    expect((lug.params as any).offsetRadius).toBeCloseTo(0.025, 9);
    expect(0.025 + (lug.params as any).outerRadius).toBeCloseTo(0.03, 9);
    // It must NOT also carry a parentRadius: the FeatureScript would add the
    // parent's radius a second time and throw the lug clear off the body.
    expect((lug.position as any).parentRadius).toBeUndefined();
  });

  it("uses the surface radius at the lug's own station on a tapered transition", async () => {
    const json = await parse(`
      <transition><name>TAPER</name>
        <material type="bulk" density="700" group="W">Birch</material>
        <length>0.1</length><thickness>0.002</thickness><shape>conical</shape>
        <foreradius>0.05</foreradius><aftradius>0.01</aftradius>
        <subcomponents>
          ${LUG('<axialoffset method="top">0.0</axialoffset>', 'LUG_FORE')}
          ${LUG('<axialoffset method="top">0.1</axialoffset>', 'LUG_AFT')}
        </subcomponents>
      </transition>`);

    // A cone is linear, so the fore station sees 50 mm and the aft station 10 mm.
    // A "parentRadius = the parent's biggest radius" shortcut gets both wrong.
    expect((find(json, 'LUG_FORE').params as any).offsetRadius).toBeCloseTo(0.05, 9);
    expect((find(json, 'LUG_AFT').params as any).offsetRadius).toBeCloseTo(0.01, 9);
  });

  it('gives a surface-offset pod the derived radius the FeatureScript needs', async () => {
    const json = await parse(
      TUBE(`
        <podset><name>POD</name>
          <radiusoffset method="surface">0.0</radiusoffset>
          <axialoffset method="bottom">0.0</axialoffset>
          <subcomponents>
            <bodytube><name>PODTUBE</name>
              <material type="bulk" density="1850" group="C">Fiberglass</material>
              <length>0.2</length><outerradius>0.012</outerradius><thickness>0.002</thickness>
            </bodytube>
          </subcomponents>
        </podset>`)
    );

    const pod = find(json, 'POD');
    // A pod set is positioned by the FeatureScript through parentRadius, and
    // `surface` used to leave that undefined -- so the pod built on the rocket
    // axis. The value is the parent's surface radius plus the assembly's own
    // bounding radius, which is what RadiusMethod.SURFACE asks for.
    expect(pod.position.radiusMethod).toBe('surface');
    expect((pod.position as any).parentRadius).toBeCloseTo(0.025 + 0.012, 9);
  });
});
