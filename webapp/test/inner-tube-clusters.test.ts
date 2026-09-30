/**
 * Inner-tube clusters.
 *
 * A `Clusterable` is not written with an `instancecount`, so the FeatureScript's
 * angular patterning had nothing to pick up and a multi-motor cluster built as a
 * single tube. These check the expansion against an independent transcription of
 * `InnerTube.getClusterPoints()`, so the test is a cross-check of the port
 * rather than a restatement of it.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseOrkFile } from '../src/parser';
import { computeDerivedData } from '../src/geometry';
import type { RocketComponent } from '../src/types';

/** ClusterConfiguration's layouts, transcribed from the vendored Java. */
const LAYOUTS: Record<string, Array<[number, number]>> = {
  single: [[0, 0]],
  double: [[-0.5, 0], [0.5, 0]],
  '3-row': [[-1, 0], [0, 0], [1, 0]],
  '4-row': [[-1.5, 0], [-0.5, 0], [0.5, 0], [1.5, 0]],
  '3-ring': [[-0.5, -1 / (2 * Math.sqrt(3))], [0.5, -1 / (2 * Math.sqrt(3))], [0, 1 / Math.sqrt(3)]],
  '4-ring': [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]],
};

/** getClusterPoints(): rotate by `rotation`, scale by `separation`, offset. */
function expectedOffsets(
  layout: string,
  outerRadius: number,
  scale: number,
  rotationDegrees: number
): Array<{ r: number; a: number }> {
  const separation = 2 * outerRadius * scale;
  const rotation = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return LAYOUTS[layout].map(([x, y]) => {
    const px = x * cos + y * sin;
    const py = -x * sin + y * cos;
    return { r: Math.hypot(px, py) * separation, a: Math.atan2(py, px) };
  });
}

async function parseCluster(inner: string) {
  const xml = `<openrocket version="1.10" creator="t"><rocket><subcomponents>
    <stage><name>S</name><subcomponents>
      <bodytube><name>TUBE</name>
        <material type="bulk" density="1850" group="C">Fiberglass</material>
        <length>0.4</length><outerradius>0.025</outerradius><thickness>0.002</thickness>
        <subcomponents>${inner}</subcomponents>
      </bodytube>
    </subcomponents></stage>
  </subcomponents></rocket></openrocket>`;
  const zip = new JSZip();
  zip.file('rocket.ork', xml);
  const json = await parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
  computeDerivedData(json);
  return json;
}

const tubes = (json: any): RocketComponent[] =>
  json.rocket.components[0].children[0].children.filter((c: RocketComponent) => c.type === 'innertube');

const tube = (layout: string, scale: number, rotation: number, children = '') => `
  <innertube><name>CLUSTER</name>
    <material type="bulk" density="1040" group="P">ABS</material>
    <length>0.07</length><outerradius>0.0095</outerradius><thickness>0.001</thickness>
    <clusterconfiguration>${layout}</clusterconfiguration>
    <clusterscale>${scale}</clusterscale>
    <clusterrotation>${rotation}</clusterrotation>
    <subcomponents>${children}</subcomponents>
  </innertube>`;

describe('inner-tube clusters', () => {
  it('expands a 4-ring into four tubes at the offsets the vendored Java computes', async () => {
    const json = await parseCluster(tube('4-ring', 1.1, 0));
    const built = tubes(json);

    expect(built).toHaveLength(4);
    const expected = expectedOffsets('4-ring', 0.0095, 1.1, 0);
    built.forEach((comp, i) => {
      expect(comp.position.radialPosition).toBeCloseTo(expected[i].r, 12);
      expect(comp.position.radialDirection).toBeCloseTo(expected[i].a, 12);
    });
    // A 4-ring has no tube on the axis: every one of the four is off it.
    for (const comp of built) expect(comp.position.radialPosition).toBeGreaterThan(0);
  });

  it('applies clusterRotation and clusterScale', async () => {
    const json = await parseCluster(tube('3-ring', 2.5, 27.5));
    const built = tubes(json);

    expect(built).toHaveLength(3);
    const expected = expectedOffsets('3-ring', 0.0095, 2.5, 27.5);
    built.forEach((comp, i) => {
      expect(comp.position.radialPosition).toBeCloseTo(expected[i].r, 12);
      expect(comp.position.radialDirection).toBeCloseTo(expected[i].a, 12);
    });
    // scale 2.5 spreads the tubes well beyond the touching distance of 2r.
    for (const comp of built) expect(comp.position.radialPosition).toBeGreaterThan(2 * 0.0095);
  });

  it('lays a 3-row cluster out along one diameter', async () => {
    const json = await parseCluster(tube('3-row', 1, 0));
    const built = tubes(json);

    expect(built).toHaveLength(3);
    // The middle tube of a 3-row sits on the axis; the outer two are one tube
    // diameter either side of it, 180 degrees apart.
    expect(built[1].position.radialPosition).toBeCloseTo(0, 12);
    expect(built[0].position.radialPosition).toBeCloseTo(2 * 0.0095, 12);
    expect(built[2].position.radialPosition).toBeCloseTo(2 * 0.0095, 12);
    expect(
      Math.abs(built[0].position.radialDirection - built[2].position.radialDirection)
    ).toBeCloseTo(Math.PI, 12);
  });

  it('leaves an unclustered tube completely alone', async () => {
    const json = await parseCluster(tube('single', 1, 0));
    const built = tubes(json);

    expect(built).toHaveLength(1);
    expect(built[0].name).toBe('CLUSTER');
    expect(built[0].position.radialPosition).toBe(0);
    expect(built[0].position.radialDirection).toBe(0);
    expect((built[0].params as any).clusterConfiguration).toBe('single');
  });

  it("clones the tube's own children onto every clustered tube", async () => {
    const ring = `
      <engineblock><name>RING</name>
        <material type="bulk" density="1040" group="P">ABS</material>
        <length>0.01</length><outerradius>0.0094</outerradius><thickness>0.004</thickness>
      </engineblock>`;
    const json = await parseCluster(tube('3-ring', 1, 0, ring));
    const built = tubes(json);

    // Each clustered tube is a complete motor mount, so each carries its own
    // thrust ring, and distinct ids: the FeatureScript builds sketch ids from them.
    expect(built).toHaveLength(3);
    for (const comp of built) {
      expect(comp.children).toHaveLength(1);
      expect(comp.children[0].type).toBe('engineblock');
      expect(comp.children[0].id).not.toBe('');
    }
    expect(new Set(built.map((c) => c.id)).size).toBe(3);
  });

  it('does not re-expand on a second derived-data pass', async () => {
    const json = await parseCluster(tube('4-ring', 1.1, 0));
    expect(tubes(json)).toHaveLength(4);
    computeDerivedData(json);
    expect(tubes(json)).toHaveLength(4);
  });

  it('warns and builds a single tube for an unknown cluster layout', async () => {
    const json = await parseCluster(tube('7-ring', 1, 0));
    expect(tubes(json)).toHaveLength(1);
    expect(json.warnings.some((w: string) => w.includes('7-ring'))).toBe(true);
  });
});
