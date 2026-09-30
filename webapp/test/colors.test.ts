import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { guessMaterialColor, MATERIAL_COLORS } from '../src/colors';
import { parseOrkFile } from '../src/parser';

function material(name: string) {
  return { name, type: 'bulk' as const, density: 0, shearModulus: 0, group: '' };
}

async function parseSyntheticBody(body: string, appearance = '') {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <openrocket version="1.10"><rocket><name>Color test</name>
      <subcomponents><stage><name>Sustainer</name><subcomponents>
        <bodytube><name>Body</name><material type="bulk" density="680">${body}</material>${appearance}</bodytube>
      </subcomponents></stage></subcomponents>
    </rocket></openrocket>`;
  const zip = new JSZip();
  zip.file('rocket.ork', xml);
  const result = await parseOrkFile(await zip.generateAsync({ type: 'arraybuffer' }));
  return result.rocket.components[0].children[0];
}

describe('guessed component colors', () => {
  it('maps common material names with case and whitespace normalization', () => {
    expect(guessMaterialColor(material('  CARDBOARD  '))).toEqual(MATERIAL_COLORS.cardboard);
    expect(guessMaterialColor(material('Balsa Wood'))).toBeDefined();
    expect(guessMaterialColor(material('Unknown rocket material'))).toBeUndefined();
  });

  it('matches descriptive OpenRocket material names', () => {
    expect(guessMaterialColor(material('Fiberglass, G10, bulk'))).toEqual(MATERIAL_COLORS.fiberglass);
  });

  it('uses a material guess when appearance paint is absent', async () => {
    const component = await parseSyntheticBody('Cardboard');
    expect(component.color).toEqual(MATERIAL_COLORS.cardboard);
  });

  it('preserves explicitly specified appearance paint', async () => {
    const component = await parseSyntheticBody(
      'Cardboard',
      '<appearance><paint red="255" green="0" blue="0" alpha="255"/></appearance>',
    );
    expect(component.color).toEqual({ red: 1, green: 0, blue: 0, alpha: 1 });
  });
});
