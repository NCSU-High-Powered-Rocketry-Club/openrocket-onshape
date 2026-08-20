/**
 * OpenRocket .ork file parser.
 *
 * The .ork file is a ZIP archive containing:
 *   - rocket.ork  — the main XML document
 *   - thrustcurves/ — motor thrust curve files (ignored)
 *   - images/ — decal images (ignored)
 *
 * Actual .ork XML structure (verified against real files, format 1.8–1.10):
 *   <openrocket version="1.10">
 *     <rocket>
 *       <name>...</name>
 *       <subcomponents>
 *         <stage>                    <!-- stages appear DIRECTLY, no wrapper -->
 *           <subcomponents>
 *             <nosecone>...</nosecone>
 *             <bodytube>...</bodytube>
 *             <bodytube>
 *               <subcomponents>
 *                 <trapezoidfinset>...</trapezoidfinset>
 *               </subcomponents>
 *             </bodytube>
 *           </subcomponents>
 *         </stage>
 *       </subcomponents>
 *     </rocket>
 *   </openrocket>
 *
 * Position is encoded as:
 *   <axialoffset method="bottom">0.1219</axialoffset>
 *   <position type="bottom">0.1219</position>
 *   <radiusoffset method="surface">0.0</radiusoffset>
 *   <angleoffset method="relative">0.0</angleoffset>
 *   <rotation>0.0</rotation>              <!-- fins: rotation in degrees -->
 *
 * Materials:
 *   <material type="bulk" density="1850.0" group="Composites">Fiberglass</material>
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type {
  RocketJson,
  RocketComponent,
  Rocket,
  Material,
  Position,
  SymmetricParams,
  BodyTubeParams,
  TrapezoidFinParams,
  EllipticalFinParams,
  FreeformFinParams,
  TubeFinParams,
  LaunchLugParams,
  RailButtonParams,
  RingComponentParams,
  RecoveryDeviceParams,
  ComponentType,
  AxialMethod,
  AngleMethod,
  RadiusMethod,
  FinCrossSection,
  SymmetricShape,
} from './types';

// ---------- XML parsing helpers ----------

const xmlOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false, // keep everything as strings; we convert manually
  parseAttributeValue: false,
  allowBooleanAttributes: true,
};

// Prettified parser: groups repeated sibling tags into arrays (loses their
// interleaved order across groups). This is used for extracting field values.
const xmlParser = new XMLParser(xmlOptions);

// Ordered parser: preserves exact document order of children (including which
// sibling arrives before/after another when two tags alternate, e.g.
// bodytube / transition / bodytube / transition). This is used ONLY to recover
// the true sibling order that the prettified parse collapses.
const xmlParserOrdered = new XMLParser({ ...xmlOptions, preserveOrder: true });

/** Parse a numeric value, handling "auto" prefixes like "auto 0.025". */
function parseNum(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  if (s === 'auto' || s === '') return fallback;
  // Handle "auto 0.025" — take the numeric part
  const m = s.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/);
  if (!m) return fallback;
  return parseFloat(m[0]);
}

/** Parse a boolean value. */
function parseBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return fallback;
}

/** Check if a value is "auto" (e.g. "auto 0.025" or "auto"). */
function isAuto(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return String(value).trim().toLowerCase().startsWith('auto');
}

/** Check if a value is "filled" (solid body). */
function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return String(value).trim().toLowerCase() === 'filled';
}

/** Get the text content of an element that may be a string or {#text: '...'}. */
function textValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Object with #text
  const t = (v as Record<string, unknown>)['#text'];
  if (t !== undefined) return String(t);
  return '';
}

/** Get a string child value from a raw XML element. */
function str(el: Record<string, unknown> | undefined, key: string): string {
  if (!el) return '';
  return textValue(el[key]);
}

/** Get a numeric child value from a raw XML element. */
function num(el: Record<string, unknown> | undefined, key: string, fallback = 0): number {
  if (!el) return fallback;
  return parseNum(el[key], fallback);
}

/** Get a boolean child value from a raw XML element. */
function bool(el: Record<string, unknown> | undefined, key: string, fallback = false): boolean {
  if (!el) return fallback;
  return parseBool(el[key], fallback);
}

/** Get an attribute value from an element object. */
function attr(el: Record<string, unknown> | undefined, key: string): string {
  if (!el) return '';
  const v = el[`@_${key}`];
  if (v === undefined || v === null) return '';
  return String(v);
}

/** Get the value of an element with its method attribute (e.g. axialoffset). */
function valWithMethod(el: Record<string, unknown> | undefined): { value: number; method: string } {
  if (!el) return { value: 0, method: '' };
  return { value: parseNum(el['#text'] ?? el['value'], 0), method: attr(el, 'method') };
}

/** Convert a value to an array (handles single vs array). */
function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------- Material parsing ----------

function parseMaterial(el: Record<string, unknown> | undefined): Material | undefined {
  if (!el) return undefined;
  const name = textValue(el['#text'] ?? el['value']);
  if (!name) return undefined;
  const type = (attr(el, 'type') || 'bulk') as Material['type'];
  return {
    name,
    type,
    density: parseNum(attr(el, 'density'), 0),
    shearModulus: parseNum(attr(el, 'shearModulus'), 0),
    group: attr(el, 'group') || '',
  };
}

// ---------- Position parsing ----------

function parsePosition(el: Record<string, unknown>): Position {
  // Axial position: <axialoffset method="bottom">0.1219</axialoffset>
  // Also <position type="bottom">0.1219</position> (redundant in newer files)
  const axial = valWithMethod(el['axialoffset'] as Record<string, unknown>);
  const radius = valWithMethod(el['radiusoffset'] as Record<string, unknown>);
  const angle = valWithMethod(el['angleoffset'] as Record<string, unknown>);
  const rotation = valWithMethod(el['rotation'] as Record<string, unknown>);

  const axialMethod = (axial.method || 'after') as AxialMethod;
  const radiusMethod = (radius.method || 'coaxial') as RadiusMethod;
  const angleMethod = (angle.method || 'relative') as AngleMethod;

  // The `rotation` element is the true base rotation for fin sets; `angleoffset`
  // is the position of the component around the body axis. For line-instanced
  // components both represent the same rotation offset. Use angleoffset if present.
  const angleDeg = angle.method !== '' ? angle.value : rotation.value;

  return {
    axialMethod,
    axialOffset: axial.value,
    position: [0, 0, 0], // absolute [x,y,z] computed later in geometry pass
    instanceCount: Math.max(1, num(el, 'instancecount', 1)),
    instanceSeparation: num(el, 'instanceseparation'),
    angleOffset: angleDeg * (Math.PI / 180), // stored in degrees
    angleMethod,
    radiusOffset: radius.value,
    radiusMethod,
  };
}

// ---------- Component parsing ----------

function parseSymmetricParams(el: Record<string, unknown>): SymmetricParams {
  const shape = (str(el, 'shape') || 'conical') as SymmetricShape;
  const thicknessRaw = str(el, 'thickness');
  const filled = isFilled(thicknessRaw);

  return {
    shape,
    shapeParameter: num(el, 'shapeparameter', 1),
    shapeClipped: bool(el, 'shapeclipped'),
    length: num(el, 'length'),
    foreRadius: num(el, 'foreradius'),
    aftRadius: num(el, 'aftradius'),
    thickness: filled ? -1 : parseNum(thicknessRaw, 0),
    filled,
    shoulderFore: {
      radius: num(el, 'foreshoulderradius'),
      length: num(el, 'foreshoulderlength'),
      thickness: num(el, 'foreshoulderthickness'),
      capped: bool(el, 'foreshouldercapped'),
    },
    shoulderAft: {
      radius: num(el, 'aftshoulderradius'),
      length: num(el, 'aftshoulderlength'),
      thickness: num(el, 'aftshoulderthickness'),
      capped: bool(el, 'aftshouldercapped'),
    },
    flipped: bool(el, 'isflipped'),
    baseRadiusAutomatic: isAuto(el['aftradius']),
  };
}

function parseBodyTubeParams(el: Record<string, unknown>): BodyTubeParams {
  const thicknessRaw = str(el, 'thickness');
  const filled = isFilled(thicknessRaw);

  // Body tubes use <radius> for outer radius
  const radiusVal = el['radius'] !== undefined ? el['radius'] : el['outerradius'];
  const radiusAuto = isAuto(radiusVal);

  let motorMount: BodyTubeParams['motorMount'];
  if (el['motormount']) {
    const mm = el['motormount'] as Record<string, unknown>;
    const motors = toArray<Record<string, unknown>>(
      (mm['motor'] as Record<string, unknown> | Record<string, unknown>[] | undefined)
    );
    const motor = motors[0];
    motorMount = {
      overhang: num(mm, 'overhang'),
      designation: motor ? str(motor, 'designation') : '',
      diameter: motor ? num(motor, 'diameter') : 0,
      length: motor ? num(motor, 'length') : 0,
      ignitionDelay: num(mm, 'ignitiondelay'),
    };
  }

  return {
    length: num(el, 'length'),
    outerRadius: parseNum(radiusVal, 0),
    thickness: filled ? -1 : parseNum(thicknessRaw, 0),
    filled,
    isMotorMount: el['motormount'] !== undefined,
    motorMount,
    // Track auto flag
    ...(radiusAuto ? { autoOuterRadius: true as const } : {}),
  };
}

function parseFinCommon(el: Record<string, unknown>): {
  finCount: number;
  thickness: number;
  crossSection: FinCrossSection;
  cantAngle: number;
  baseRotation: number;
  tab: { height: number; length: number; position: number; positionMethod: 'top' | 'bottom' | 'middle' };
  filletRadius: number;
  filletMaterial?: Material;
} {
  const crossSection = (str(el, 'crosssection') || 'square') as FinCrossSection;

  // Tab position: <tabposition relativeto="center">0.01016</tabposition>
  const tabPos = el['tabposition'] as Record<string, unknown> | undefined;
  let tabPosition = 0;
  let tabPositionMethod: 'top' | 'bottom' | 'middle' = 'middle';
  if (tabPos) {
    const rel = attr(tabPos, 'relativeto').toLowerCase();
    // Newer files also emit a method-style attribute; map to enum
    if (rel === 'front' || rel === 'top') tabPositionMethod = 'top';
    else if (rel === 'end' || rel === 'bottom') tabPositionMethod = 'bottom';
    else tabPositionMethod = 'middle';
    tabPosition = parseNum(tabPos['#text'] ?? tabPos['value'], 0);
  }

  return {
    finCount: Math.max(1, num(el, 'fincount', 1)),
    thickness: num(el, 'thickness'),
    crossSection,
    cantAngle: parseNum(el['cant'], 0) * (Math.PI / 180), // stored in degrees
    baseRotation: parseNum(el['rotation'], 0) * (Math.PI / 180), // stored in degrees
    tab: {
      height: num(el, 'tabheight'),
      length: num(el, 'tablength'),
      position: tabPosition,
      positionMethod: tabPositionMethod,
    },
    filletRadius: num(el, 'filletradius'),
    filletMaterial: parseMaterial(el['filletmaterial'] as Record<string, unknown> | undefined),
  };
}

function parseTrapezoidFinParams(el: Record<string, unknown>): TrapezoidFinParams {
  const common = parseFinCommon(el);
  return {
    ...common,
    rootChord: num(el, 'rootchord'),
    tipChord: num(el, 'tipchord'),
    sweepLength: num(el, 'sweeplength'),
    height: num(el, 'height'),
  };
}

function parseEllipticalFinParams(el: Record<string, unknown>): EllipticalFinParams {
  const common = parseFinCommon(el);
  return {
    ...common,
    rootChord: num(el, 'rootchord'),
    height: num(el, 'height'),
  };
}

function parseFreeformFinParams(el: Record<string, unknown>): FreeformFinParams {
  const common = parseFinCommon(el);
  const points: Array<[number, number]> = [];
  const finpoints = el['finpoints'] as Record<string, unknown> | undefined;
  if (finpoints) {
    const pts = toArray<Record<string, unknown>>(
      (finpoints['point'] as Record<string, unknown> | Record<string, unknown>[] | undefined)
    );
    for (const p of pts) {
      points.push([parseNum(attr(p, 'x'), 0), parseNum(attr(p, 'y'), 0)]);
    }
  }
  return { ...common, points };
}

function parseTubeFinParams(el: Record<string, unknown>): TubeFinParams {
  return {
    finCount: Math.max(1, num(el, 'fincount', 1)),
    length: num(el, 'length'),
    outerRadius: parseNum(el['radius'] ?? el['outerradius'], 0),
    thickness: num(el, 'thickness'),
    baseRotation: parseNum(el['rotation'], 0) * (Math.PI / 180),
  };
}

function parseLaunchLugParams(el: Record<string, unknown>): LaunchLugParams {
  return {
    outerRadius: parseNum(el['radius'] ?? el['outerradius'], 0),
    innerRadius: num(el, 'innerradius'),
    thickness: num(el, 'thickness'),
    length: num(el, 'length'),
  };
}

function parseRailButtonParams(el: Record<string, unknown>): RailButtonParams {
  // Rail buttons typically use presets; the dimensions come from the preset
  // database which we don't ship. Fall back to the parsed values if present.
  return {
    outerDiameter: num(el, 'outerdiameter'),
    innerDiameter: num(el, 'innerdiameter'),
    totalHeight: num(el, 'height'),
    flangeHeight: num(el, 'flangeheight'),
    baseHeight: num(el, 'baseheight'),
    screwHeight: num(el, 'screwheight'),
  };
}

function parseRingComponentParams(el: Record<string, unknown>): RingComponentParams {
  let motorMount: RingComponentParams['motorMount'];
  if (el['motormount']) {
    const mm = el['motormount'] as Record<string, unknown>;
    const motors = toArray<Record<string, unknown>>(
      (mm['motor'] as Record<string, unknown> | Record<string, unknown>[] | undefined)
    );
    const motor = motors[0];
    motorMount = {
      overhang: num(mm, 'overhang'),
      designation: motor ? str(motor, 'designation') : '',
      diameter: motor ? num(motor, 'diameter') : 0,
      length: motor ? num(motor, 'length') : 0,
      ignitionDelay: num(mm, 'ignitiondelay'),
    };
  }

  return {
    outerRadius: num(el, 'outerradius'),
    innerRadius: num(el, 'innerradius'),
    thickness: num(el, 'thickness'),
    length: num(el, 'length'),
    clusterConfiguration: str(el, 'clusterconfiguration') || 'single',
    clusterScale: num(el, 'clusterscale', 1),
    clusterRotation: num(el, 'clusterrotation'),
    radialPosition: num(el, 'radialposition'),
    radialDirection: parseNum(el['radialdirection'], 0) * (Math.PI / 180),
    isMotorMount: el['motormount'] !== undefined,
    motorMount,
  };
}

function parseRecoveryParams(el: Record<string, unknown>): RecoveryDeviceParams {
  return {
    packedLength: num(el, 'packedlength'),
    packedRadius: num(el, 'packedradius'),
    radialPosition: num(el, 'radialposition'),
    radialDirection: parseNum(el['radialdirection'], 0) * (Math.PI / 180),
    material: parseMaterial(el['material'] as Record<string, unknown> | undefined),
    diameter: num(el, 'diameter'),
    stripLength: num(el, 'striplength'),
    stripWidth: num(el, 'stripwidth'),
    cordLength: num(el, 'cordlength'),
    mass: num(el, 'mass'),
  };
}

// ---------- Component dispatch ----------

const COMPONENT_TAGS: Record<string, ComponentType> = {
  nosecone: 'nosecone',
  transition: 'transition',
  bodytube: 'bodytube',
  trapezoidfinset: 'trapezoidfinset',
  ellipticalfinset: 'ellipticalfinset',
  freeformfinset: 'freeformfinset',
  tubefinset: 'tubefinset',
  launchlug: 'launchlug',
  railbutton: 'railbutton',
  innertube: 'innertube',
  tubecoupler: 'tubecoupler',
  centeringring: 'centeringring',
  bulkhead: 'bulkhead',
  engineblock: 'engineblock',
  parachute: 'parachute',
  streamer: 'streamer',
  shockcord: 'shockcord',
  masscomponent: 'masscomponent',
  podset: 'podset',
  parallelstage: 'parallelstage',
  boosterset: 'parallelstage', // legacy tag (pre-1.8)
};

// ---------- Document-order recovery ----------
//
// fast-xml-parser's default ("prettified") output groups repeated sibling tags
// into arrays keyed by tag name, so when two different tags alternate
// (e.g. bodytube / transition / bodytube / transition) the true interleaved
// order is lost. We build an `OrderLevel` tree from a `preserveOrder` parse and
// use it in parseChildren() to emit siblings in real XML document order.

/** The ordered (interleaved) sibling sequence of a `<subcomponents>` container. */
interface OrderLevel {
  /** Tags of the container's children, in exact XML document order. */
  order: string[];
  /** One OrderLevel per child (same index), describing that child's own children. */
  children: OrderLevel[];
}

const EMPTY_ORDER: OrderLevel = { order: [], children: [] };

/**
 * Build an OrderLevel from the ordered (preserveOrder-parse) content array of a
 * `<subcomponents>` container.
 *
 * Each entry is an element object shaped `{ tagName: childContentArray, (":@": attrs) }`
 * (a self-closing element stores a plain string instead of an array). We skip
 * non-element entries and recurse only into an element's own `<subcomponents>`.
 */
function buildOrderLevel(orderedChildren: unknown[] | Record<string, unknown>): OrderLevel {
  if (!Array.isArray(orderedChildren)) {
    return EMPTY_ORDER;
  }
  const order: string[] = [];
  const children: OrderLevel[] = [];

  for (const item of orderedChildren) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    // The element's tag is the one key that isn't a reserved/metadata key.
    const tag = Object.keys(entry).find(
      (k) => k !== ':@' && k !== '#text' && !k.startsWith('#')
    );
    if (!tag) continue;

    order.push(tag);
    let level: OrderLevel = EMPTY_ORDER;

    const content = entry[tag];
    if (Array.isArray(content)) {
      // Find this element's nested `<subcomponents>` container, if any.
      for (const child of content) {
        if (typeof child !== 'object' || child === null) continue;
        const ce = child as Record<string, unknown>;
        if (ce['subcomponents'] !== undefined) {
          const sub = ce['subcomponents'];
          level = buildOrderLevel(sub as Record<string, unknown>[]);
          break;
        }
      }
    }
    children.push(level);
  }

  return { order, children };
}

/**
 * Resolve the OrderLevel of the rocket element's `<subcomponents>` container
 * from the ordered (preserveOrder-parse) output tree.
 */
function rocketOrderLevel(
  orderedRoot: Record<string, unknown> | Array<Record<string, unknown>>
): OrderLevel {
  const root = Array.isArray(orderedRoot) ? orderedRoot : [orderedRoot];
  const openrocket = root.find((x) => x && typeof x === 'object' && 'openrocket' in x);
  const oeChildren = openrocket
    ? Array.isArray(openrocket.openrocket)
      ? openrocket.openrocket
      : [openrocket.openrocket]
    : [];
  const rocket = oeChildren.find(
    (x) => x && typeof x === 'object' && 'rocket' in x
  ) as (Record<string, unknown> & { rocket: unknown }) | undefined;
  const rocketChildren = rocket
    ? Array.isArray(rocket.rocket)
      ? rocket.rocket
      : [rocket.rocket]
    : [];
  const sub = rocketChildren.find(
    (x) => x && typeof x === 'object' && 'subcomponents' in x
  );
  if (!sub || sub['subcomponents'] === undefined) return EMPTY_ORDER;
  return buildOrderLevel(sub['subcomponents'] as Record<string, unknown>[]);
}

function parseComponent(
  el: Record<string, unknown>,
  warnings: string[],
  type: ComponentType,
  order: OrderLevel = EMPTY_ORDER
): RocketComponent {
  const material = parseMaterial(el['material'] as Record<string, unknown> | undefined);

  let params: RocketComponent['params'];
  switch (type) {
    case 'nosecone':
    case 'transition':
      params = parseSymmetricParams(el);
      break;
    case 'bodytube':
      params = parseBodyTubeParams(el);
      break;
    case 'trapezoidfinset':
      params = parseTrapezoidFinParams(el);
      break;
    case 'ellipticalfinset':
      params = parseEllipticalFinParams(el);
      break;
    case 'freeformfinset':
      params = parseFreeformFinParams(el);
      break;
    case 'tubefinset':
      params = parseTubeFinParams(el);
      break;
    case 'launchlug':
      params = parseLaunchLugParams(el);
      break;
    case 'railbutton':
      params = parseRailButtonParams(el);
      break;
    case 'innertube':
    case 'tubecoupler':
    case 'centeringring':
    case 'bulkhead':
    case 'engineblock':
      params = parseRingComponentParams(el);
      break;
    case 'parachute':
    case 'streamer':
    case 'shockcord':
    case 'masscomponent':
      params = parseRecoveryParams(el);
      break;
    default:
      params = {} as RocketComponent['params'];
  }

  return {
    type,
    name: str(el, 'name') || type,
    id: str(el, 'id'),
    material,
    position: parsePosition(el),
    params,
    children: parseChildren(el, warnings, order),
  };
}

function parseChildren(
  el: Record<string, unknown>,
  warnings: string[],
  order: OrderLevel = EMPTY_ORDER
): RocketComponent[] {
  const sub = el['subcomponents'];
  if (sub === undefined || typeof sub !== 'object') return [];

  // Sibling order comes from the `preserveOrder` parse (true document order);
  // field values come from the prettified parse (`sub` is grouped by tag).
  // Because both trees come from the same document, the nth occurrence of a tag
  // in the ordered list is exactly the nth element under that tag in `sub`.
  const grouped = sub as Record<string, unknown>;
  const components: RocketComponent[] = [];
  const consumed: Record<string, number> = {};

  for (let i = 0; i < order.order.length; i++) {
    const tag = order.order[i];
    if (tag === '@_type') continue;
    const type = COMPONENT_TAGS[tag] ?? (tag === 'stage' ? 'stage' : null);
    if (!type) {
      warnings.push(`Unknown component tag: <${tag}> — skipped`);
      continue;
    }
    const occurrence = consumed[tag] ?? 0;
    consumed[tag] = occurrence + 1;

    const value = grouped[tag];
    if (value === undefined) continue;
    const c = toArray<Record<string, unknown>>(
      value as Record<string, unknown> | Record<string, unknown>[]
    )[occurrence];
    if (typeof c === 'object') {
      components.push(parseComponent(c, warnings, type, order.children[i]));
    }
  }
  return components;
}

// ---------- Main entry point ----------

/**
 * Parse an .ork file (as ArrayBuffer) into a RocketJson structure.
 */
export async function parseOrkFile(buffer: ArrayBuffer): Promise<RocketJson> {
  const warnings: string[] = [];

  // 1. Unzip the .ork archive
  const zip = await JSZip.loadAsync(buffer);
  const rocketFile = zip.file('rocket.ork');
  if (!rocketFile) {
    throw new Error('Invalid .ork file: missing rocket.ork entry');
  }
  const xmlText = await rocketFile.async('string');

  console.log(xmlText);

  // 2. Parse the XML
  const parsed = xmlParser.parse(xmlText);
  const root = parsed['openrocket'] as Record<string, unknown> | undefined;
  if (!root) {
    throw new Error('Invalid .ork file: missing <openrocket> root element');
  }

  // Also parse with preserveOrder so we can recover exact sibling document order
  // (the prettified parse above collapses interleaved tag groups). The ordered
  // root is used only to resolve ordering, never for field values.
  const orderedParsed = xmlParserOrdered.parse(xmlText) as
    | Record<string, unknown>
    | Array<Record<string, unknown>>;
  const rocketOrder = rocketOrderLevel(orderedParsed);

  const version = textValue(root['@_version']) || 'unknown';
  const rocketEl = root['rocket'] as Record<string, unknown> | undefined;
  if (!rocketEl) {
    throw new Error('Invalid .ork file: missing <rocket> element');
  }

  // Record file format version
  warnings.push(`OpenRocket file format version: ${version}`);

  // 3. Build the RocketJson
  const components = parseChildren(rocketEl, warnings, rocketOrder);

  const rocket: Rocket = {
    name: str(rocketEl, 'name') || 'Unnamed Rocket',
    designer: str(rocketEl, 'designer'),
    revision: str(rocketEl, 'revision'),
    designType: str(rocketEl, 'designtype') || 'original',
    kitName: str(rocketEl, 'kitname'),
    referenceType: str(rocketEl, 'referencetype') || 'maximum',
    referenceLength: num(rocketEl, 'customreference'),
    unitSystem: 'SI',
    components,
  };

  return {
    schemaVersion: '1.0',
    rocket,
    warnings,
  };
}