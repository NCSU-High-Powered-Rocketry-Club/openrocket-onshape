/**
 * `<isflipped>` — nose cone / tail cone support.
 *
 * A flipped nose cone is the case where the .ork file is misleading on its face.
 * `NoseConeSaver` writes the cone's BASE radius and BASE shoulder into the
 * `<aftradius>` / `<aftshoulder*>` elements (via the flip-independent
 * `getBaseRadius()` / `getShoulderRadius()` accessors) and omits `<foreradius>` /
 * `<foreshoulder*>` entirely, so a tail cone is stored identically to a normal
 * nose cone and only the flag distinguishes them. These tests pin the swap the
 * parser performs, and the geometry/consistency consequences of it.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseOrkFile } from '../src/parser';
import { computeDerivedData, symmetricProfile, estimateComponentMass } from '../src/geometry';
import { validateRocketJson } from '../src/validation';
import type { RocketComponent, RocketJson } from '../src/types';

/** Wrap component XML in a minimal .ork document, zipped as the parser expects. */
async function orkFrom(inner: string): Promise<RocketJson> {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<openrocket version="1.10" creator="OpenRocket 25.03">
  <rocket>
    <name>Synthetic</name>
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
  return parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
}

/** The `<aft*>` block NoseConeSaver writes, shared by the flipped/unflipped pair. */
function coneXml(opts: { flipped: boolean; baseRadius: string; shoulder?: string }): string {
  return `<nosecone>
    <name>Tail Cone</name>
    <id>cone-1</id>
    <material type="bulk" density="1800.0" group="Other">Fiberglass, G10, bulk</material>
    <length>0.2</length>
    <thickness>0.001</thickness>
    <shape>ogive</shape>
    <shapeparameter>1.0</shapeparameter>
    <aftradius>${opts.baseRadius}</aftradius>
    <aftshoulderradius>${opts.shoulder ?? '0'}</aftshoulderradius>
    <aftshoulderlength>${opts.shoulder ? '0.02' : '0.0'}</aftshoulderlength>
    <aftshoulderthickness>${opts.shoulder ? '0.001' : '0.0'}</aftshoulderthickness>
    <aftshouldercapped>${opts.shoulder ? 'true' : 'false'}</aftshouldercapped>
    <isflipped>${opts.flipped}</isflipped>
  </nosecone>`;
}

/** The stage's nose cone, located by type so sibling components may be present. */
function firstCone(json: RocketJson): RocketComponent {
  const nose = json.rocket.components[0].children.find((c) => c.type === 'nosecone');
  expect(nose, 'expected the stage to contain a nose cone').toBeDefined();
  return nose as RocketComponent;
}

/** Run the same pipeline main.ts does, so tests cover parse + derive + validate. */
function pipeline(json: RocketJson): RocketJson {
  computeDerivedData(json);
  validateRocketJson(json);
  return json;
}

describe('nose cone flip (tail cone)', () => {
  it('leaves a non-flipped nose cone untouched', async () => {
    const p = firstCone(await orkFrom(coneXml({ flipped: false, baseRadius: '0.02667' }))).params as any;
    expect(p.flipped).toBe(false);
    // Tip forward at y = length, base aft at y = 0 -- the normal orientation.
    expect(p.foreRadius).toBe(0);
    expect(p.aftRadius).toBeCloseTo(0.02667, 5);
    expect(p.shoulderFore.radius).toBe(0);
    expect(p.shoulderAft.radius).toBe(0);
  });

  it('moves the base to the fore end and the tip to the aft end when flipped', async () => {
    const p = firstCone(await orkFrom(coneXml({ flipped: true, baseRadius: '0.02667' }))).params as any;
    expect(p.flipped).toBe(true);
    // `<aftradius>` held the BASE; after the flip the base is at the fore end and
    // the aft end is the point the tip resets to.
    expect(p.foreRadius).toBeCloseTo(0.02667, 5);
    expect(p.aftRadius).toBe(0);
  });

  it('moves the shoulder to the fore end and clears the aft end', async () => {
    const p = firstCone(
      await orkFrom(coneXml({ flipped: true, baseRadius: '0.02667', shoulder: '0.02' }))
    ).params as any;

    expect(p.shoulderFore.radius).toBeCloseTo(0.02, 6);
    expect(p.shoulderFore.length).toBeCloseTo(0.02, 6);
    expect(p.shoulderFore.capped).toBe(true);
    // The tip end has no shoulder once flipped.
    expect(p.shoulderAft.radius).toBe(0);
    expect(p.shoulderAft.length).toBe(0);
  });

  it('keeps the base shoulder on the aft end of an unflipped cone', async () => {
    const p = firstCone(
      await orkFrom(coneXml({ flipped: false, baseRadius: '0.02667', shoulder: '0.02' }))
    ).params as any;
    expect(p.shoulderAft.radius).toBeCloseTo(0.02, 6);
    expect(p.shoulderFore.radius).toBe(0);
  });

  it('builds a mirrored profile, not a copy of the nose cone profile', async () => {
    const noseParams = firstCone(
      await orkFrom(coneXml({ flipped: false, baseRadius: '0.02667' }))
    ).params as any;
    const tailParams = firstCone(
      await orkFrom(coneXml({ flipped: true, baseRadius: '0.02667' }))
    ).params as any;

    const nose = symmetricProfile(noseParams);
    const tail = symmetricProfile(tailParams);

    // A tail cone is the same solid facing the other way, so at every axial
    // station its radius is the nose cone's radius at the MIRRORED station.
    // Both profiles are [radius, y] with the aft end at y = 0, so the mirror
    // swaps only the radius, not y. Before the fix the two profiles were
    // identical and the tail cone rendered pointing forward.
    expect(tail.profile).toHaveLength(nose.profile.length);
    tail.profile.forEach((pt, i) => {
      const mirrored = nose.profile[nose.profile.length - 1 - i];
      expect(pt[0]).toBeCloseTo(mirrored[0], 9);
      expect(pt[1]).toBeCloseTo(nose.profile[i][1], 9);
    });
  });

  it('gives the tail cone its full radius at the fore end and a point at the aft end', async () => {
    const json = pipeline(
      await orkFrom(coneXml({ flipped: true, baseRadius: '0.02667' }))
    );
    const profile = (firstCone(json).params as any).profile as Array<[number, number]>;

    // profile is [radius, y] with the aft end at y = 0 and fore at y = length.
    const atFore = profile.reduce((best, pt) => (pt[1] > best[1] ? pt : best));
    const atAft = profile.reduce((best, pt) => (pt[1] < best[1] ? pt : best));
    expect(atFore[0]).toBeCloseTo(0.02667, 5);
    expect(atAft[0]).toBeCloseTo(0, 9);
  });

  it('places a tail-cone shoulder beyond the fore end of the body', async () => {
    const json = pipeline(
      await orkFrom(coneXml({ flipped: true, baseRadius: '0.02667', shoulder: '0.02' }))
    );
    const p = firstCone(json).params as any;

    expect(p.shoulderProfile.fore).not.toBeNull();
    expect(p.shoulderProfile.aft).toBeNull();
    // The fore shoulder grows FORWARD of the body: every y is at or past length.
    for (const pt of p.shoulderProfile.fore.profile) {
      expect(pt[1]).toBeGreaterThanOrEqual(p.length - 1e-9);
    }
    // And the axial extent includes it.
    expect(p.totalLength).toBeCloseTo(0.22, 6);
  });

  it('estimates a tail cone from its base, not its zero-radius tip', async () => {
    const base = 0.02667;
    const nose = firstCone(await orkFrom(coneXml({ flipped: false, baseRadius: String(base) })));
    const tail = firstCone(await orkFrom(coneXml({ flipped: true, baseRadius: String(base) })));

    const noseMass = estimateComponentMass(nose);
    const tailMass = estimateComponentMass(tail);

    // Same cone, same material, mirrored: the masses must match. Keying the
    // estimate off the aft radius reported a tail cone as essentially massless.
    expect(noseMass).not.toBeNull();
    expect(tailMass).toBeCloseTo(noseMass as number, 12);
    expect(tailMass as number).toBeGreaterThan(0);
  });

  it('does not report a valid tail cone as malformed', async () => {
    const json = pipeline(
      await orkFrom(coneXml({ flipped: true, baseRadius: '0.02667' }))
    );
    const flagged = (json.warningDetails ?? []).filter((w) => /radius/i.test(w.message));
    expect(flagged).toEqual([]);
  });

  it('still reports a tail cone whose base radius is genuinely missing', async () => {
    const json = pipeline(await orkFrom(coneXml({ flipped: true, baseRadius: '0' })));
    const flagged = (json.warningDetails ?? []).filter((w) => /Base radius/i.test(w.message));
    expect(flagged.length).toBeGreaterThan(0);
  });

  describe('automatic base radius', () => {
    /** A body tube ahead of the cone is what a tail cone's base auto-resolves from. */
    const bodyTube = `<bodytube>
      <name>Body Tube</name><id>bt-1</id>
      <material type="bulk" density="1800.0" group="Other">Fiberglass, G10, bulk</material>
      <length>0.3</length><radius>0.03</radius><thickness>0.001</thickness>
    </bodytube>`;

    it('resolves an auto base from the PREVIOUS component when flipped', async () => {
      // A tail cone's base sits at its fore end, so -- unlike a normal nose cone
      // (which resolves from the NEXT sibling) -- it must resolve from the one in
      // front of it.
      const json = pipeline(
        await orkFrom(bodyTube + coneXml({ flipped: true, baseRadius: 'auto 0.0' }))
      );
      expect((firstCone(json).params as any).foreRadius).toBeCloseTo(0.03, 6);
    });

    it('carries the auto marker onto the fore end, not the aft end', async () => {
      const p = firstCone(
        await orkFrom(coneXml({ flipped: true, baseRadius: 'auto 0.0' }))
      ).params as any;
      expect(p.foreRadiusAutomatic).toBe(true);
      expect(p.baseRadiusAutomatic).toBe(false);
    });

    it('still resolves a normal nose cone auto base from the NEXT component', async () => {
      const json = pipeline(
        await orkFrom(coneXml({ flipped: false, baseRadius: 'auto 0.0' }) + bodyTube)
      );
      expect((firstCone(json).params as any).aftRadius).toBeCloseTo(0.03, 6);
    });
  });

  it('leaves transitions alone, which have no flip', async () => {
    const json = await orkFrom(`<transition>
      <name>Taper</name><id>t-1</id>
      <material type="bulk" density="1800.0" group="Other">Fiberglass, G10, bulk</material>
      <length>0.1</length><thickness>0.001</thickness>
      <shape>conical</shape>
      <foreradius>0.01</foreradius><aftradius>0.02</aftradius>
      <!-- A malformed file may carry the element anyway; it must be ignored. -->
      <isflipped>true</isflipped>
    </transition>`);
    const taper = json.rocket.components[0].children[0];
    expect(taper.type).toBe('transition');
    const p = taper.params as any;
    expect(p.flipped).toBe(false);
    expect(p.foreRadius).toBeCloseTo(0.01, 6);
    expect(p.aftRadius).toBeCloseTo(0.02, 6);
  });
});

