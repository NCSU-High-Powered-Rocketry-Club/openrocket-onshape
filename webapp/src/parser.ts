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
import { guessMaterialColor } from './colors';
import type {
  RocketJson,
  RocketComponent,
  Rocket,
  Material,
  Position,
  SymmetricParams,
  Shoulder,
  MotorMountParams,
  MotorConfiguration,
  RocketMotorConfiguration,
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
  FinTabPositionMethod,
  SymmetricShape,
  CenterOfPressureBranch,
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

/** The `method` attribute of `<angleoffset>`, validated against what we honour. */
function parseAngleMethod(method: string, warnings: string[], name: string): AngleMethod {
  if (method === '' || method === 'relative') return 'relative';
  if (method === 'fixed') return 'fixed';
  // OpenRocket's AngleMethod also has MIRROR_XY, but `choices()` returns only
  // RELATIVE and no writer emits it, so this can only be a hand-edit. Fall back
  // to `relative` -- what the FeatureScript already did by ignoring the value --
  // and say so, rather than building a silently-wrong angle.
  warnings.push(
    `[MEDIUM] ${name}: <angleoffset method="${method}"> is not supported — treated as ` +
      `"relative". OpenRocket's own UI cannot produce this value.`
  );
  return 'relative';
}

/** The `method` attribute of `<radiusoffset>`, validated against what we honour. */
function parseRadiusMethod(
  method: string,
  isRingAssembly: boolean,
  warnings: string[],
  name: string
): RadiusMethod {
  const fallback: RadiusMethod = isRingAssembly ? 'relative' : 'coaxial';
  if (method === '') return fallback;
  if (method === 'coaxial' || method === 'free' || method === 'relative' || method === 'surface') {
    return method;
  }
  warnings.push(
    `[MEDIUM] ${name}: <radiusoffset method="${method}"> is not a known RadiusMethod — ` +
      `treated as "${fallback}".`
  );
  return fallback;
}

function parsePosition(
  el: Record<string, unknown>,
  type: ComponentType,
  warnings: string[],
  name: string
): Position {
  // Axial position: <axialoffset method="bottom">0.1219</axialoffset>
  // Also <position type="bottom">0.1219</position> (redundant in newer files)
  const axial = valWithMethod(el['axialoffset'] as Record<string, unknown>);
  const radius = valWithMethod(el['radiusoffset'] as Record<string, unknown>);
  const angle = valWithMethod(el['angleoffset'] as Record<string, unknown>);
  const rotation = valWithMethod(el['rotation'] as Record<string, unknown>);

  // OpenRocket ComponentAssembly defaults differ from ordinary components.
  // Pod sets and parallel stages are off-axis, two-instance assemblies whose
  // fore ends default to the parent's aft (BOTTOM) end. Axial stages remain on
  // the centreline and are implicitly positioned AFTER the preceding stage.
  const isRingAssembly = type === 'podset' || type === 'parallelstage';
  const axialMethod = (axial.method || (isRingAssembly ? 'bottom' : 'after')) as AxialMethod;
  const angleMethod = parseAngleMethod(angle.method, warnings, name);
  const radiusMethod = parseRadiusMethod(
    radius.method,
    isRingAssembly,
    warnings,
    name
  );

  // The `rotation` element is the true base rotation for fin sets; `angleoffset`
  // is the position of the component around the body axis. For line-instanced
  // components both represent the same rotation offset. Use angleoffset if present.
  const angleDeg = angle.method !== '' ? angle.value : rotation.value;

  // `<radialdirection>` is the legacy (OpenRocket 15.03-era) spelling of the
  // same angle.  RocketComponentSaver writes it from the identical value it
  // writes into `<angleoffset>` for components that are neither fin sets,
  // parallel stages, pod sets, nor rail buttons -- so a current file carries
  // both.  They are one angle, not two: reading both and applying both rotates
  // the component twice (a 180 degree launch lug ends up back at 0).  Only
  // fall back to `<radialdirection>` when the modern elements are absent.
  const hasModernAngle = el['angleoffset'] !== undefined || el['rotation'] !== undefined;

  return {
    axialMethod,
    axialOffset: axial.value,
    position: [0, 0, 0], // absolute [x,y,z] computed later in geometry pass
    instanceCount: Math.max(1, num(el, 'instancecount', isRingAssembly ? 2 : 1)),
    instanceSeparation: num(el, 'instanceseparation'),
    angleOffset: angleDeg * (Math.PI / 180), // stored in degrees
    angleMethod,
    radiusOffset: radius.value,
    radiusMethod,
    // Radial displacement (magnitude in meters, direction degrees in the XML,
    // converted to radians here). Defaults to coaxial (0).
    radialPosition: num(el, 'radialposition'),
    radialDirection: hasModernAngle ? 0 : parseNum(el['radialdirection'], 0) * (Math.PI / 180),
  };
}

// ---------- Appearance / color parsing ----------

/**
 * Extract the component's color, as RGBA with each channel between 0 and 1
 * (inclusive), matching the Onshape `Color` API. Returns undefined if neither
 * source is present, so the caller can fall back to a material guess.
 *
 * Two independent elements can carry a color, and OpenRocket writes them
 * separately:
 *
 *   - `<color red="255" green="0" blue="0" alpha="255"/>` — the *figure* color
 *     (`RocketComponent.getColor()`), emitted by `RocketComponentSaver` for any
 *     component that is neither the Rocket nor an assembly.
 *   - `<appearance><paint .../></appearance>` — the render appearance
 *     (`getAppearance().getPaint()`).
 *
 * A component can legitimately have either, both, or neither: the saver emits
 * each independently, so a file whose only colour is `<color>` would otherwise
 * have lost its paint entirely and fallen back to a material guess — a
 * plausible but wrong display colour. The appearance is preferred when both are
 * present because it is the one the appearance editor actually sets. (In the
 * 7 test rockets all 3 `<color>` elements happen to sit beside an `<appearance>`,
 * so this fallback is currently latent rather than live; a hand-edited or
 * older-format file is what it is here for.)
 */
function parseComponentColor(
  el: Record<string, unknown>
): RocketComponent['color'] | undefined {
  const paint = el['appearance'] as Record<string, unknown> | undefined;
  const source =
    paint && typeof paint === 'object'
      ? (paint['paint'] as Record<string, unknown> | undefined)
      : (el['color'] as Record<string, unknown> | undefined);
  if (!source || typeof source !== 'object') return undefined;
  const channel = (v: unknown) =>
    Math.min(1, Math.max(0, parseNum(v, 0) / 255));
  return {
    red: channel(source['@_red']),
    green: channel(source['@_green']),
    blue: channel(source['@_blue']),
    // Alpha in .ork files is on the same 0-255 scale as the color channels
    alpha: Math.min(1, Math.max(0, parseNum(source['@_alpha'], 255) / 255)),
  };
}

// ---------- Component parsing ----------

/**
 * The `relativeto` values that only the MODERN (2021+) fin-tab spelling uses.
 * A current-format file writes two <tabposition> elements -- the legacy
 * front/center/end one first, the modern one second -- so when both are
 * present the modern entry is the one to read, and these three keywords are
 * how it is identified.  See FinSetSaver.java and parseFinCommon.
 */
// AxialMethod's five values, as FinSetSaver writes them (the enum name, lowercased).
// The legacy front/center/end spellings are also written, for files predating the
// modern vocabulary, and are mapped onto the modern ones.  'absolute' and 'after'
// used to be folded into 'middle' here, which silently put the tab in the wrong
// place -- see the note on FinTabPositionMethod in types.ts.
const MODERN_TAB_METHODS = new Set([
  'top',
  'middle',
  'bottom',
  'absolute',
  'after',
]);

const TAB_METHOD_ALIASES: Record<string, FinTabPositionMethod> = {
  top: 'top',
  front: 'top',
  middle: 'middle',
  center: 'middle',
  centre: 'middle',
  bottom: 'bottom',
  end: 'bottom',
  absolute: 'absolute',
  tip: 'absolute',
  after: 'after',
  aftersibling: 'after',
  aftersiblings: 'after',
};

/**
 * Parse the symmetric-body parameters shared by nose cones and transitions.
 *
 * NOSE CONE FLIP (tail cone)
 * -------------------------
 * `<isflipped>` turns a nose cone into a tail cone, and it is subtle because
 * OpenRocket does NOT mirror the stored numbers. `NoseConeSaver` writes the
 * cone's BASE radius into `<aftradius>` and its BASE shoulder into
 * `<aftshoulder*>` -- both via the flip-independent `getBaseRadius()` /
 * `getShoulderRadius()` / `getShoulderLength()` / `getShoulderThickness()` /
 * `isShoulderCapped()` accessors -- and it never writes `<foreradius>` or
 * `<foreshoulder*>` at all (`DocumentConfig` explicitly disables those setters
 * for nose cones). So a tail cone arrives here byte-for-byte identical to a
 * normal nose cone, and `<isflipped>` is the ONLY evidence of the flip.
 *
 * `NoseCone.setFlipped(true)` gives the meaning of the flag: the base moves to
 * the fore end and the tip is reset to a point at the aft end
 * (`resetAftRadius()`), and the shoulders move with it. This function performs
 * exactly that swap, ONCE, at the point where the file format is known, so that
 * every downstream consumer -- `symmetricProfile`, `shoulderProfile`, the
 * auto-radius resolution pass, mass estimation and fin mounting -- can treat a
 * tail cone as an ordinary symmetric body with its true fore/aft radii and needs
 * no notion of "flip" at all.
 *
 * The `flipped` flag itself is still recorded on the params, both to round-trip
 * the file faithfully and so consumers can label the component a tail cone.
 */
function parseSymmetricParams(el: Record<string, unknown>, isNoseCone = false): SymmetricParams {
  const shape = (str(el, 'shape') || 'conical') as SymmetricShape;
  const thicknessRaw = str(el, 'thickness');
  const filled = isFilled(thicknessRaw);

  // `<isflipped>` is a nose-cone-only element; a transition never carries one.
  const flipped = isNoseCone && bool(el, 'isflipped');

  // As stored: the `<aft*>` elements hold the cone's BASE end, flip-independent.
  const storedForeRadius = num(el, 'foreradius');
  const storedAftRadius = num(el, 'aftradius');
  const storedForeShoulder: Shoulder = {
    radius: num(el, 'foreshoulderradius'),
    length: num(el, 'foreshoulderlength'),
    thickness: num(el, 'foreshoulderthickness'),
    capped: bool(el, 'foreshouldercapped'),
  };
  const storedAftShoulder: Shoulder = {
    radius: num(el, 'aftshoulderradius'),
    length: num(el, 'aftshoulderlength'),
    thickness: num(el, 'aftshoulderthickness'),
    capped: bool(el, 'aftshouldercapped'),
  };
  const storedBaseAuto = isAuto(el['aftradius']);
  const storedForeAuto = isAuto(el['foreradius']);

  // A tail cone is a base-at-the-fore body tapering to a point at the aft end,
  // so the ends swap and the aft (tip) end carries no auto flag or shoulder.
  const foreRadius = flipped ? storedAftRadius : storedForeRadius;
  const aftRadius = flipped ? 0 : storedAftRadius;
  const shoulderFore = flipped ? storedAftShoulder : storedForeShoulder;
  const shoulderAft = flipped
    ? { radius: 0, length: 0, thickness: 0, capped: false }
    : storedAftShoulder;
  // The auto marker travels with the base, so on a tail cone it is a FORE auto.
  const baseRadiusAutomatic = flipped ? storedForeAuto : storedBaseAuto;
  const foreRadiusAutomatic = flipped ? storedBaseAuto : storedForeAuto;

  return {
    shape,
    shapeParameter: num(el, 'shapeparameter', 1),
    shapeClipped: bool(el, 'shapeclipped'),
    length: num(el, 'length'),
    foreRadius,
    aftRadius,
    thickness: filled ? -1 : parseNum(thicknessRaw, 0),
    filled,
    shoulderFore,
    shoulderAft,
    flipped,
    baseRadiusAutomatic,
    foreRadiusAutomatic,
  };
}

/**
 * Every rocket-level `<motorconfiguration>`, in document order.
 *
 * These are OpenRocket's flight configurations -- the old tag name is preserved
 * for backwards compatibility (see `RocketSaver`). Each one is a candidate for
 * "which motors are loaded", and each carries the stage activeness that tells a
 * single-stage rocket from a booster with a live sustainer and a spent booster,
 * so the webapp can label the dropdown with something better than a bare UUID.
 * The `<name>` is only written when the designer overrode it, hence the ''
 * fallback.
 *
 * This pairing is what says WHICH motor is actually loaded. A `<motormount>`
 * holds one `<motor>` per configuration, each tagged with the `configid` it
 * belongs to, and the `default="true"` flag below says which of those
 * configurations the designer considers the default one. `motors[0]` is only
 * the first one written, which is document order and nothing more.
 *
 * They differ on 4 of the 7 test rockets: `demon 54.ork` opens with H250G but
 * its default configuration is I200W; `Antar` opens with C6, default D20W;
 * `Bell X-1` D12 vs E12; `ExamplePods` A8 vs C6. Taking `motors[0]` therefore
 * drew the wrong motor on more than half the corpus.
 */
function parseMotorConfigurations(rocketEl: Record<string, unknown>): RocketMotorConfiguration[] {
  return toArray<Record<string, unknown>>(
    rocketEl['motorconfiguration'] as Record<string, unknown> | Record<string, unknown>[] | undefined
  ).map((cfg) => ({
    configId: attr(cfg, 'configid'),
    name: str(cfg, 'name'),
    isDefault: parseBool(cfg['@_default'], false),
    stages: toArray<Record<string, unknown>>(
      cfg['stage'] as Record<string, unknown> | Record<string, unknown>[] | undefined
    ).map((stage) => ({
      number: parseNum(attr(stage, 'number'), 0),
      active: parseBool(attr(stage, 'active'), false),
    })),
  }));
}

/**
 * The `configid` every motor mount should be resolved against.
 *
 * A user pick wins over the file's `default="true"`: the dropdown exists so a
 * designer can build the *other* flight configuration, and re-resolving from
 * scratch is what makes the whole payload -- not just a patched motor block --
 * agree with that choice. A pick that names a configuration the file does not
 * declare falls back to the default rather than silently resolving to nothing.
 */
function selectMotorConfigId(configs: RocketMotorConfiguration[], requested?: string): string {
  if (requested && configs.some((c) => c.configId === requested)) return requested;
  return configs.find((c) => c.isDefault)?.configId ?? '';
}

/**
 * Resolve one `<motormount>`: the motor belonging to the selected configuration,
 * plus the full candidate list so a caller can see what else was on offer.
 *
 * When NO configuration could be resolved at all (the file declares none, or
 * none is flagged default) the first motor is taken, because a mount that
 * defines motors clearly has one loaded and reporting none would be a worse
 * answer than a possibly-wrong one.
 *
 * But once a configuration IS resolved, a mount that declares no motor for it
 * genuinely has nothing loaded there -- a booster parked for this flight, say --
 * and that is reported as no motor. Falling back to the first motor in that case
 * would fabricate geometry for a motor this configuration never loads: the old
 * code could get away with it because the default configuration loads a motor in
 * every mount by definition, but it is wrong as soon as the user picks a
 * different one. `Kerbal.ork` has three such configurations, and each used to
 * silently build the default's C6.
 */
function parseMotorMount(
  mm: Record<string, unknown>,
  selectedConfigId: string
): MotorMountParams {
  const motors = toArray<Record<string, unknown>>(
    mm['motor'] as Record<string, unknown> | Record<string, unknown>[] | undefined
  );

  const candidates: MotorConfiguration[] = motors.map((motor) => ({
    configId: attr(motor, 'configid'),
    designation: str(motor, 'designation'),
    manufacturer: str(motor, 'manufacturer'),
    digest: str(motor, 'digest'),
    diameter: num(motor, 'diameter'),
    length: num(motor, 'length'),
  }));

  const selected =
    selectedConfigId !== ''
      ? candidates.find((c) => c.configId === selectedConfigId)
      : candidates[0];

  return {
    overhang: num(mm, 'overhang'),
    designation: selected?.designation ?? '',
    manufacturer: selected?.manufacturer ?? '',
    digest: selected?.digest ?? '',
    diameter: selected?.diameter ?? 0,
    length: selected?.length ?? 0,
    ignitionDelay: num(mm, 'ignitiondelay'),
    configurationCount: motors.length,
    ...(candidates.length > 0 ? { configurations: candidates } : {}),
    // '' when the fallback fired, so "took the first motor" is distinguishable
    // from "this configuration loads a motor here".
    selectedConfigId: selected?.configId ?? '',
  };
}

function parseBodyTubeParams(el: Record<string, unknown>, selectedConfigId: string): BodyTubeParams {
  const thicknessRaw = str(el, 'thickness');
  const filled = isFilled(thicknessRaw);

  // Body tubes use <radius> for outer radius
  const radiusVal = el['radius'] !== undefined ? el['radius'] : el['outerradius'];
  const radiusAuto = isAuto(radiusVal);

  let motorMount: BodyTubeParams['motorMount'];
  if (el['motormount']) {
    const mm = el['motormount'] as Record<string, unknown>;
    motorMount = parseMotorMount(mm, selectedConfigId);
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
  tab: { height: number; length: number; position: number; positionMethod: FinTabPositionMethod };
  filletRadius: number;
  filletMaterial?: Material;
} {
  const crossSection = (str(el, 'crosssection') || 'square') as FinCrossSection;

  // Tab position.  OpenRocket's FinSetSaver writes the SAME offset TWICE for
  // backward compatibility: once with the legacy `relativeto` vocabulary
  // (front/center/end) and once with the modern one (top/middle/bottom) -- see
  // FinSetSaver.java.  A current-format file therefore carries two sibling
  // <tabposition> elements, fast-xml-parser hands both back as an array, and
  // `attr()` on an array yields ''.  Reading it as a single object is what made
  // every tab silently fall back to `middle` at position 0.
  //
  // So: take the array, and prefer the entry whose `relativeto` is a MODERN
  // keyword.  The legacy spelling is only a fallback, for pre-2021 files that
  // write just the one element.
  const tabEntries = toArray<Record<string, unknown>>(el['tabposition'] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const modernEntry = tabEntries.find((e) => MODERN_TAB_METHODS.has(attr(e, 'relativeto').toLowerCase()));
  const tabPos = modernEntry ?? tabEntries[0];
  let tabPosition = 0;
  let tabPositionMethod: FinTabPositionMethod = 'middle';
  if (tabPos) {
    // A modern file may also spell it as a `method` attribute; `relativeto` is
    // what the saver actually writes, so it is checked first.
    const rel = (attr(tabPos, 'relativeto') || attr(tabPos, 'method')).toLowerCase();
    tabPositionMethod = TAB_METHOD_ALIASES[rel] ?? 'middle';
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
  const radiusValue = el['radius'] ?? el['outerradius'];
  const outerRadiusAutomatic = isAuto(radiusValue);
  return {
    finCount: Math.max(1, num(el, 'fincount', 1)),
    length: num(el, 'length'),
    outerRadius: outerRadiusAutomatic ? 0 : parseNum(radiusValue, 0),
    thickness: num(el, 'thickness'),
    baseRotation: parseNum(el['rotation'], 0) * (Math.PI / 180),
    ...(outerRadiusAutomatic ? { autoOuterRadius: true as const } : {}),
  };
}

function parseLaunchLugParams(el: Record<string, unknown>): LaunchLugParams {
  // `LaunchLugSaver` writes only <radius>, <length> and <thickness>; it never
  // writes <innerradius>, because the bore is not an independent quantity --
  // `LaunchLug.getInnerRadius()` DERIVES it as `radius - thickness`. So a file
  // written by any OpenRocket version can never carry the element, and reading
  // it yields 0 for every real lug. Reading the derived value here (rather than
  // leaving it 0) is what makes the lug an annulus in the mass estimate instead
  // of a solid disc, which overstated it by 1.9x-5.4x.
  const outerRadius = parseNum(el['radius'] ?? el['outerradius'], 0);
  const thickness = num(el, 'thickness');
  // `setThickness` clamps to [0, radius], so this is >= 0 for any real file; the
  // max() only guards a hand-edited one.
  const derivedInnerRadius = Math.max(0, outerRadius - thickness);
  // An explicit <innerradius> would be a hand-edit (or another writer's), so it
  // still wins -- but it is floored the same way, to keep a negative bore from
  // producing a negative volume.
  const innerRadius = Math.max(0, num(el, 'innerradius', derivedInnerRadius));

  return {
    outerRadius,
    innerRadius,
    thickness,
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

function parseRingComponentParams(
  el: Record<string, unknown>,
  selectedConfigId: string
): RingComponentParams {
  let motorMount: RingComponentParams['motorMount'];
  if (el['motormount']) {
    motorMount = parseMotorMount(el['motormount'] as Record<string, unknown>, selectedConfigId);
  }

  const outerRadiusAuto = isAuto(el['outerradius']);
  const innerRadiusAuto = isAuto(el['innerradius']);

  return {
    outerRadius: outerRadiusAuto ? 0 : num(el, 'outerradius'),
    innerRadius: innerRadiusAuto ? 0 : num(el, 'innerradius'),
    ...(outerRadiusAuto ? { autoOuterRadius: true as const } : {}),
    ...(innerRadiusAuto ? { autoInnerRadius: true as const } : {}),
    thickness: num(el, 'thickness'),
    length: num(el, 'length'),
    clusterConfiguration: str(el, 'clusterconfiguration') || 'single',
    clusterScale: num(el, 'clusterscale', 1),
    clusterRotation: num(el, 'clusterrotation'),
    isMotorMount: el['motormount'] !== undefined,
    motorMount,
  };
}

function parseRecoveryParams(el: Record<string, unknown>): RecoveryDeviceParams {
  return {
    packedLength: num(el, 'packedlength'),
    packedRadius: num(el, 'packedradius'),
    material: parseMaterial(el['material'] as Record<string, unknown> | undefined),
    diameter: num(el, 'diameter'),
    stripLength: num(el, 'striplength'),
    stripWidth: num(el, 'stripwidth'),
    cordLength: num(el, 'cordlength'),
    // An absent mass is meaningful: it means the component has no explicit
    // mass override. Do not turn it into zero, which would be a false warning.
    ...(el['mass'] === undefined ? {} : { mass: num(el, 'mass') }),
  };
}

function parseAssemblyParams(el: Record<string, unknown>, type: ComponentType) {
  if (type !== 'parallelstage') return {};
  return {
    separation: {
      event: str(el, 'separationevent') || undefined,
      altitude: el['separationaltitude'] === undefined ? undefined : num(el, 'separationaltitude'),
      delay: el['separationdelay'] === undefined ? undefined : num(el, 'separationdelay'),
    },
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
  order: OrderLevel = EMPTY_ORDER,
  selectedConfigId = ''
): RocketComponent {
  const material = parseMaterial(el['material'] as Record<string, unknown> | undefined);

  let params: RocketComponent['params'];
  switch (type) {
    case 'nosecone':
      // Only a nose cone can be flipped into a tail cone (`<isflipped>`).
      params = parseSymmetricParams(el, true);
      break;
    case 'transition':
      params = parseSymmetricParams(el);
      break;
    case 'bodytube':
      params = parseBodyTubeParams(el, selectedConfigId);
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
      params = parseRingComponentParams(el, selectedConfigId);
      break;
    case 'parachute':
    case 'streamer':
    case 'shockcord':
    case 'masscomponent':
      params = parseRecoveryParams(el);
      break;
    case 'stage':
    case 'podset':
    case 'parallelstage':
      params = parseAssemblyParams(el, type);
      break;
    default:
      params = {} as RocketComponent['params'];
  }

  const name = str(el, 'name') || type;

  // `<overridemass>` / `<overridecg>` / `<overridecd>` are written by
  // RocketComponentSaver only when the corresponding `isXxxOverridden()` is
  // true, so an absent element means "not overridden" rather than zero. Each
  // `<overridesubcomponentsXxx>` sibling is a boolean the saver always emits
  // alongside its parent; it is not surfaced here because the web app does not
  // roll child masses up into a parent total.
  const overrideMass = num(el, 'overridemass');
  const overrideCG = num(el, 'overridecg');
  const overrideCD = num(el, 'overridecd');

  return {
    type,
    name,
    id: str(el, 'id'),
    material,
    color: parseComponentColor(el) ?? guessMaterialColor(material),
    // Only carry an override when the element was actually present, so that
    // "overridden to exactly 0" stays distinguishable from "not overridden".
    ...(el['overridemass'] !== undefined ? { overrideMass } : {}),
    ...(el['overridecg'] !== undefined ? { overrideCG } : {}),
    ...(el['overridecd'] !== undefined ? { overrideCD } : {}),
    position: parsePosition(el, type, warnings, name),
    params,
    children: parseChildren(el, warnings, order, selectedConfigId),
  };
}

function parseChildren(
  el: Record<string, unknown>,
  warnings: string[],
  order: OrderLevel = EMPTY_ORDER,
  selectedConfigId = ''
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
      warnings.push(`[MEDIUM] Unknown or unsupported component tag: <${tag}> — skipped`);
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
      components.push(
        parseComponent(c, warnings, type, order.children[i], selectedConfigId)
      );
    }
  }
  return components;
}

// ---------- Center of pressure ----------

/** Median of a non-empty numeric array; mean of the two middles when even. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Below this Mach the rocket is coasting past apogee rather than flying, and
 * OpenRocket's own `SymmetricComponentCalc.getLiftCP` applies a `mul` correction
 * for `Mach < 0.05 && AOA > 45 deg` with the comment "This causes an anomaly to
 * the flight results with the CP jumping at apogee". So the same samples are
 * noise for us. On `ExamplePods-airframe and winglets.ork` the raw column
 * bottoms out at 0.316 m at t=2.85 s, AOA=41 deg, Mach=0.008; drop that regime
 * and the column tightens to 0.336-0.342.
 */
const CP_MIN_MACH = 0.05;

/**
 * Collect every usable `CP location` sample from every saved flight-data
 * branch, one entry per branch and in flight order.
 *
 * A sample is usable when the column parses to a finite number STRICTLY
 * GREATER THAN ZERO. OpenRocket packs three unusable regions into that one
 * column, all of them visible in `ExamplePods-airframe and winglets.ork`:
 *
 *  1. `NaN` for every row before the rocket clears the launch rod (48 leading
 *     rows there).
 *  2. An exact `0` for every row after the simulation has finished and the
 *     rocket has landed. That is a "no forces" sentinel, not a measurement —
 *     a `cp >= 0` guard would accept it and park the marker on the nose tip.
 *  3. A low-reading launch transient in the first real row: that file's column
 *     opens at 0.334 and then sits at 0.342 for the rest of the flight.
 *
 * The post-apogee rows are then dropped by Mach (see `CP_MIN_MACH`), unless
 * that would leave the branch with nothing at all — a slow glider may never
 * exceed the threshold, and "no CP" is a worse answer than a noisy one.
 */
function collectCenterOfPressure(
  rocketEl: Record<string, unknown>,
  rootEl?: Record<string, unknown>
): CenterOfPressureBranch[] {
  // Current OpenRocket files store <simulations> as a sibling of <rocket>;
  // some exporters/older synthetic files place it inside <rocket>.
  const simulationsEl = (rocketEl['simulations'] ?? rootEl?.['simulations']) as Record<string, unknown> | undefined;
  const simulations = toArray<Record<string, unknown>>(simulationsEl?.['simulation'] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const branches: CenterOfPressureBranch[] = [];

  for (const simulation of simulations) {
    const simulationName = str(simulation, 'name');
    const flightData = simulation['flightdata'] as Record<string, unknown> | undefined;
    const rawBranches = toArray<Record<string, unknown>>(flightData?.['databranch'] as Record<string, unknown> | Record<string, unknown>[] | undefined);
    for (const branch of rawBranches) {
      const types = String(branch['@_types'] ?? branch['types'] ?? '').split(',');
      const cpIndex = types.findIndex((type) => type.trim() === 'CP location');
      if (cpIndex < 0) continue;
      const machIndex = types.findIndex((type) => type.trim() === 'Mach number');
      const points = toArray<string | Record<string, unknown>>(branch['datapoint'] as string | Record<string, unknown> | (string | Record<string, unknown>)[] | undefined);

      const usable: Array<{ cp: number; mach: number }> = [];
      for (const point of points) {
        const columns = textValue(point).split(',');
        const cp = parseNum(columns[cpIndex], Number.NaN);
        // `> 0`, not `>= 0`: the post-flight sentinel is a literal zero.
        if (!Number.isFinite(cp) || cp <= 0) continue;
        const mach = machIndex >= 0 ? parseNum(columns[machIndex], Number.NaN) : Number.NaN;
        usable.push({ cp, mach });
      }
      if (usable.length === 0) continue;

      const flying = usable.filter((s) => Number.isFinite(s.mach) && s.mach >= CP_MIN_MACH);
      const kept = flying.length > 0 ? flying : usable;
      const values = kept.map((s) => s.cp);

      branches.push({
        simulation: simulationName,
        branch: attr(branch, 'name'),
        count: values.length,
        first: values[0],
        median: median(values),
        min: Math.min(...values),
        max: Math.max(...values),
        machFiltered: flying.length > 0,
        apogeeSamples: usable.length - kept.length,
        values,
      });
    }
  }

  return branches;
}

/**
 * The single CP the Onshape feature draws: the MEDIAN of the selected branch
 * (the first one unless the caller picks another). Median rather than first row
 * because the first row is the launch transient, which reads low (0.334 vs the
 * settled 0.342 on `ExamplePods-airframe and winglets.ork` — an 8 mm error in
 * the marker).
 *
 * Note this is a *simulated* CP from one saved flight, NOT the static CP that
 * OpenRocket's design view draws. The design view is the worst case over 360
 * roll angles at M = 0.3 and alpha = 0; for the pods/winglets rocket that is
 * ~0.301 m against the ~0.340 m this returns, a systematic ~39 mm gap. See
 * local/feature-support-audit.md section 3.9a.
 */
function parseCenterOfPressure(
  rocketEl: Record<string, unknown>,
  rootEl?: Record<string, unknown>,
  branchIndex = 0
): { centerOfPressure?: number; centerOfPressureSource?: number; centerOfPressureBranches: CenterOfPressureBranch[] } {
  const branches = collectCenterOfPressure(rocketEl, rootEl);
  if (branches.length === 0) {
    return { centerOfPressureBranches: branches };
  }
  const selected = branches[Math.min(Math.max(branchIndex, 0), branches.length - 1)];
  return {
    centerOfPressure: selected.median,
    centerOfPressureSource: branches.indexOf(selected),
    centerOfPressureBranches: branches,
  };
}

// ---------- Main entry point ----------

export interface ParseOrkOptions {
  /**
   * Which saved flight-data branch to take the center of pressure from, as an
   * index into `rocket.centerOfPressureBranches`. The UI exposes this so the
   * user can pick a simulation; out-of-range values clamp to the last branch.
   * Defaults to the first branch that carries usable data.
   */
  centerOfPressureBranch?: number;
  /**
   * Which flight configuration to load motors from, as the `configId` of one of
   * `rocket.motorConfigurations`. The UI exposes this so the user can build a
   * configuration other than the file's `default="true"` one; an id the file
   * does not declare falls back to the default. Omitted means "use the default".
   */
  motorConfiguration?: string;
}

/**
 * Parse an .ork file (as ArrayBuffer) into a RocketJson structure.
 */
export async function parseOrkFile(buffer: ArrayBuffer, options: ParseOrkOptions = {}): Promise<RocketJson> {
  const warnings: string[] = [];

  // 1. Unzip the .ork archive
  const zip = await JSZip.loadAsync(buffer);
  const rocketFile = zip.file('rocket.ork');
  if (!rocketFile) {
    throw new Error('Invalid .ork file: missing rocket.ork entry');
  }
  const xmlText = await rocketFile.async('string');

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
  // The motor configuration is resolved ONCE, at the rocket level, and handed
  // down: it is a property of the rocket, not of any one mount, and every mount
  // has to be resolved against the same one. The file's default is used unless
  // the caller asked for another, so the webapp can switch configurations by
  // re-parsing rather than by patching the JSON afterwards.
  const motorConfigurations = parseMotorConfigurations(rocketEl);
  const selectedMotorConfig = selectMotorConfigId(motorConfigurations, options.motorConfiguration);
  const components = parseChildren(rocketEl, warnings, rocketOrder, selectedMotorConfig);
  const { centerOfPressure, centerOfPressureSource, centerOfPressureBranches } =
    parseCenterOfPressure(rocketEl, root, options.centerOfPressureBranch);

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
    ...(centerOfPressure !== undefined ? { centerOfPressure } : {}),
    ...(centerOfPressureSource !== undefined ? { centerOfPressureSource } : {}),
    // Diagnostic only; the FeatureScript reads `centerOfPressure`, never this.
    ...(centerOfPressureBranches.length > 0 ? { centerOfPressureBranches } : {}),
    // Also diagnostic: the motors themselves are already resolved into each
    // mount's `motorMount`, which is what the FeatureScript reads.
    ...(motorConfigurations.length > 0 ? { motorConfigurations } : {}),
    ...(selectedMotorConfig ? { motorConfigurationSource: selectedMotorConfig } : {}),
  };

  return {
    // Keep in step with EXPECTED_SCHEMA_VERSION in osFeature/main.fs.  1.2: the
    // meridian section (profile/innerProfile) is the body ALONE; shoulders moved
    // to their own `shoulderProfile.fore`/`.aft` polygons, each revolved
    // separately and boolean-unioned on by the FeatureScript.
    schemaVersion: '1.2',
    rocket,
    warnings,
    warningDetails: [],
  };
}