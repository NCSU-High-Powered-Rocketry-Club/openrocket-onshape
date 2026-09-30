/**
 * TypeScript types matching the JSON schema consumed by the Onshape custom feature.
 * All dimensions are in SI units (meters, radians). Densities in kg/m³.
 */

// ---------- Materials ----------

export type MaterialType = 'bulk' | 'surface' | 'line';

export interface Material {
  name: string;
  type: MaterialType;
  density: number; // kg/m³
  shearModulus: number; // Pa
  group: string;
}

// ---------- Positioning ----------

export type AxialMethod = 'absolute' | 'after' | 'top' | 'middle' | 'bottom';

/**
 * How `<angleoffset>` is interpreted.
 *
 * Deliberately narrower than OpenRocket's `AngleMethod` enum, which also has
 * `MIRROR_XY`. `AngleMethod.choices()` returns `[RELATIVE]` only, and no writer
 * in OpenRocket's source ever emits `MIRROR_XY`, so advertising it here would
 * invite a hand-edited payload the consumer cannot honour. The parser warns and
 * falls back to `relative` if a file carries one.
 *
 * - `relative` — the offset is added to the parent's angle.
 * - `fixed` — `AngleMethod.FIXED.getAngle()` returns 0: the component keeps its
 *   parent's angle and the stored offset is ignored.
 */
export type AngleMethod = 'relative' | 'fixed';

/**
 * How `<radiusoffset>` is interpreted.
 *
 * `surface` is not in `RadiusMethod.choices()` (which offers `[FREE,
 * RELATIVE]`), but it is what the saver writes by default for a component
 * mounted on its parent's outside, so it is by far the most common value in
 * real files -- 61 of the 79 `<radiusoffset>` elements across OpenRocket's own
 * 17 example designs and this project's 7 test designs.
 */
export type RadiusMethod = 'coaxial' | 'free' | 'relative' | 'surface';

export interface Position {
  axialMethod: AxialMethod;
  axialOffset: number; // meters
  position: [number, number, number]; // absolute [x, y, z] relative to parent
  instanceCount: number;
  instanceSeparation: number; // meters
  angleOffset: number; // radians
  angleMethod: AngleMethod;
  radiusOffset: number; // meters
  radiusMethod: RadiusMethod;
  // Radial displacement of the component's center from the center of its
  // parent (0 = coaxial). Magnitude in meters, direction in radians where 0
  // points along +Y. Read from <radialposition> / <radialdirection>.
  radialPosition: number; // meters
  radialDirection: number; // radians
  // Derived radius a `relative` or `surface` radiusOffset is measured from:
  // the parent's SURFACE radius at this component's own axial station (so a lug
  // on a tapered transition uses the radius *there*, not the parent's maximum).
  // For component assemblies it is the parent assembly's bounding radius plus
  // the positioned assembly's own, matching OpenRocket RadiusMethod.RELATIVE.
  //
  // Left undefined for component types that place themselves on the parent
  // surface through `params.offsetRadius` instead (fin sets, tube fins, launch
  // lugs, rail buttons) -- see computeDerivedData, which owns that decision.
  parentRadius?: number;
}

// ---------- Symmetric body components (NoseCone / Transition / BodyTube) ----------

export type SymmetricShape =
  | 'conical'
  | 'ogive'
  | 'ellipsoid'
  | 'power'
  | 'parabolic'
  | 'haack';

export type Finish =
  | 'rough'
  | 'roughunfinished'
  | 'unfinished'
  | 'normal'
  | 'smooth'
  | 'optimum'
  | 'polished'
  | 'finishedpolished'
  | 'mirror';

export interface Shoulder {
  radius: number; // 0 = no shoulder
  length: number;
  thickness: number;
  capped: boolean;
}

export interface SymmetricParams {
  shape: SymmetricShape;
  shapeParameter: number;
  shapeClipped: boolean;
  length: number;
  foreRadius: number; // 0 for full nose cone
  aftRadius: number;
  thickness: number; // 'filled' -> Number.POSITIVE_INFINITY sentinel? Use -1
  filled: boolean;
  /** Nose cones and transitions only; every other component type has none. */
  shoulderFore: Shoulder;
  shoulderAft: Shoulder;
  /**
   * `<isflipped>` — nose cones only: the cone is mounted as a TAIL cone.
   *
   * The .ork file does NOT mirror the stored dimensions when a cone is flipped;
   * `NoseConeSaver` still writes the base radius/shoulder into the `<aft*>`
   * elements. The parser therefore applies the fore/aft swap while parsing, so
   * `foreRadius`/`aftRadius` and `shoulderFore`/`shoulderAft` always describe the
   * component's true physical orientation (a tail cone has a full-radius
   * `foreRadius` and tapers to a point at `aftRadius === 0`). This flag is kept
   * for faithful round-tripping and so consumers can label the part a tail cone;
   * geometry itself needs no notion of the flip.
   */
  flipped: boolean; // nose cones only
  baseRadiusAutomatic: boolean; // aft/base radius marked "auto" in XML
  foreRadiusAutomatic: boolean; // fore radius marked "auto" in XML (e.g. <foreradius>auto 0.025</foreradius>)

  // ---- Derived by computeDerivedData (symmetricProfile) ----
  /** Outer surface of the body alone, fore to aft. Shoulders excluded. */
  profile?: Array<[number, number]>;
  /** Bore surface of the body alone, fore to aft, clipped to the axis. */
  innerProfile?: Array<[number, number]>;
  /** Solid component: the bore is the axis, so `innerProfile` is two points. */
  innerIsAxis?: boolean;
  /**
   * One meridian polygon per shoulder, revolved separately and unioned on.
   * `null` on either end means that end has no shoulder.
   */
  shoulderProfile?: {
    fore: import('./geometry').ShoulderProfileResult | null;
    aft: import('./geometry').ShoulderProfileResult | null;
  };
  /** Axial extent actually occupied: `length` plus both shoulder lengths. */
  totalLength?: number;
}

// ---------- Body Tube ----------

/**
 * One `<motor>` from a `<motormount>`: a single flight configuration's motor.
 *
 * A mount holds one of these per configuration, and the rocket-level
 * `<motorconfiguration configid="..." default="true">` says which one is
 * actually loaded. `MotorMountParams` carries every candidate so the choice is
 * inspectable rather than silent.
 */
export interface MotorConfiguration {
  /** `configid` attribute; the key the rocket-level configuration links by. */
  configId: string;
  /** Motor code, e.g. `C6`, `H250G`. */
  designation: string;
  manufacturer: string;
  /**
   * Hash into OpenRocket's thrust-curve database. This is how OpenRocket
   * recovers the motor's MASS — the .ork stores no mass of its own, so a digest
   * with no matching database entry is a motor we cannot weigh.
   */
  digest: string;
  diameter: number;
  length: number;
}

export interface MotorMountParams {
  overhang: number;
  designation: string;
  manufacturer: string;
  /** Thrust-curve digest of the selected motor; '' when unknown. */
  digest: string;
  diameter: number;
  length: number;
  ignitionDelay: number;
  /**
   * How many `<motor>` configurations the mount declares. Only the one matching
   * the rocket's default configuration is used for geometry, so this is what
   * tells the caller that the choice was a choice -- and now that the motor is
   * turned into geometry, which configuration was picked actually decides the
   * solid that gets built.
   */
  configurationCount?: number;
  /** Every configuration's motor, in document order. Selected one first in use. */
  configurations?: MotorConfiguration[];
}

export interface BodyTubeParams {
  length: number;
  outerRadius: number;
  thickness: number;
  filled: boolean;
  isMotorMount: boolean;
  motorMount?: MotorMountParams;
}

// ---------- Fin Sets ----------

export type FinCrossSection = 'square' | 'rounded' | 'airfoil';

/**
 * A fin tab's axial reference.  `FinSet.tabOffsetMethod` is a full `AxialMethod`
 * and `FinSetSaver` writes its name verbatim, so all five values -- including
 * 'absolute' and 'after' -- really do appear in a file.  This is `AxialMethod`
 * plus the legacy front/center/end spellings the saver also writes, for files
 * predating the modern vocabulary.
 */
export type FinTabPositionMethod = AxialMethod | 'front' | 'end' | 'center';

export interface FinTab {
  height: number;
  length: number;
  /**
   * Axial offset, in METRES, of the tab's leading edge from the fin's leading
   * edge, resolved by `positionMethod`.  A LENGTH, not a fraction: this comment
   * used to say "fraction along root chord [0..1]", which was wrong and came
   * from the old assumption that a tab could not be longer than its fin.  That
   * assumption is gone -- a tab may overhang either end and the overhang is
   * bridged -- and OpenRocket's own `<tabposition>` element has always held a
   * length, so nothing here or in the parser scales it.  It may legitimately be
   * NEGATIVE: centring a tab that is longer than the chord pushes its start
   * backwards past the fin's leading edge.
   */
  position: number;
  positionMethod: FinTabPositionMethod;
}

export interface FinFillet {
  radius: number;
  material: Material;
}

export interface FinCommonParams {
  finCount: number;
  thickness: number;
  crossSection: FinCrossSection;
  cantAngle: number; // radians
  baseRotation: number; // radians
  tab: FinTab;
  filletRadius: number; // 0 = none
  filletMaterial?: Material;
}

export interface TrapezoidFinParams extends FinCommonParams {
  rootChord: number;
  tipChord: number;
  sweepLength: number;
  height: number;
}

export interface EllipticalFinParams extends FinCommonParams {
  rootChord: number;
  height: number;
}

export interface FreeformFinParams extends FinCommonParams {
  points: Array<[number, number]>; // ordered [x, y] points
  /** Axial length = max x distance between any two points; added by computeDerivedData. */
  length?: number;
}

export interface TubeFinParams {
  finCount: number;
  length: number;
  outerRadius: number;
  thickness: number;
  baseRotation: number;
  /** `true` when <radius> was marked `auto`; resolved in the derived-data pass. */
  autoOuterRadius?: boolean;
}

// ---------- Launch Lug / Rail Button ----------

export interface LaunchLugParams {
  outerRadius: number;
  innerRadius: number;
  thickness: number;
  length: number;
  /** Derived: parent's surface radius at the lug's axial position. Added by computeDerivedData. */
  offsetRadius?: number;
}

export interface RailButtonParams {
  outerDiameter: number;
  innerDiameter: number;
  totalHeight: number;
  flangeHeight: number;
  baseHeight: number;
  screwHeight: number;
  /** Derived: parent's surface radius at the button's axial position — rail buttons always sit on the parent's surface. Added by computeDerivedData. */
  offsetRadius?: number;
}

// ---------- Ring components ----------

export interface RingComponentParams {
  outerRadius: number;
  innerRadius: number; // 0 for bulkhead (solid disc)
  /** `true` when <outerradius> was marked `auto` (nil value); resolved in the derived-data pass. */
  autoOuterRadius?: boolean;
  /** `true` when <innerradius> was marked `auto` (nil value); resolved from the motor-tube OD in the derived-data pass. */
  autoInnerRadius?: boolean;
  thickness: number; // wall thickness for thickness rings
  length: number;
  clusterConfiguration: string; // inner tubes only
  clusterScale: number;
  clusterRotation: number; // degrees
  isMotorMount: boolean;
  motorMount?: MotorMountParams;
}

// ---------- Component assemblies ----------

export interface StageSeparationParams {
  event?: string;
  altitude?: number; // meters
  delay?: number; // seconds
}

export interface AssemblyParams {
  /** Derived assembly length: the sum of its AFTER-positioned direct children. */
  length?: number;
  /** Present on parallel stages; simulation metadata, not solid geometry. */
  separation?: StageSeparationParams;
}

// ---------- Recovery / mass ----------

export interface RecoveryDeviceParams {
  packedLength: number;
  packedRadius: number;
  material?: Material;
  // Parachute
  diameter?: number;
  // Streamer
  stripLength?: number;
  stripWidth?: number;
  // Shock cord
  cordLength?: number;
  // Mass component
  mass?: number;
}

// ---------- Component ----------

export type ComponentType =
  | 'nosecone'
  | 'transition'
  | 'bodytube'
  | 'trapezoidfinset'
  | 'ellipticalfinset'
  | 'freeformfinset'
  | 'tubefinset'
  | 'launchlug'
  | 'railbutton'
  | 'innertube'
  | 'tubecoupler'
  | 'centeringring'
  | 'bulkhead'
  | 'engineblock'
  | 'parachute'
  | 'streamer'
  | 'shockcord'
  | 'masscomponent'
  | 'podset'
  | 'parallelstage'
  | 'stage';

export interface Color {
  red: number; // 0..1
  green: number; // 0..1
  blue: number; // 0..1
  alpha: number; // 0..1 (1 = opaque)
}

export interface RocketComponent {
  type: ComponentType;
  name: string;
  id: string;
  /** Estimated mass in kg, when the component has a computable material and volume. */
  mass?: number;
  material?: Material;
  color?: Color; // RGBA (0..1) from <appearance><paint .../>; matches the Onshape Color API; undefined if unpainted
  position: Position;
  params:
    | SymmetricParams
    | BodyTubeParams
    | TrapezoidFinParams
    | EllipticalFinParams
    | FreeformFinParams
    | TubeFinParams
    | LaunchLugParams
    | RailButtonParams
    | RingComponentParams
    | RecoveryDeviceParams
    | AssemblyParams;
  children: RocketComponent[];
}

// ---------- Rocket ----------

// ---------- Center of pressure ----------

/**
 * Every usable `CP location` sample from one saved flight-data branch.
 *
 * Diagnostic payload, so the CP candidates can be inspected before deciding
 * which one the Onshape feature should draw. It is NOT read by the
 * FeatureScript — `Rocket.centerOfPressure` is what the feature consumes.
 */
export interface CenterOfPressureBranch {
  /** `<name>` of the enclosing `<simulation>`, e.g. `Simulation 1`. */
  simulation: string;
  /** `name` attribute of the `<databranch>` — OpenRocket's stage/configuration. */
  branch: string;
  /** How many usable samples this branch contributed. */
  count: number;
  /** First usable sample; this is the launch transient, and it reads low. */
  first: number;
  /** Median of `values`; what `Rocket.centerOfPressure` uses for the first branch. */
  median: number;
  /** Lowest usable sample. */
  min: number;
  /** Highest usable sample. */
  max: number;
  /**
   * True when the post-apogee samples (Mach < 0.05) were dropped. False means
   * the branch never reached the threshold — a slow glider — and every sample
   * was kept, noisy ones included.
   */
  machFiltered: boolean;
  /** How many `CP > 0` samples the Mach filter dropped. */
  apogeeSamples: number;
  /** All usable samples, in flight order, in meters from the nose. */
  values: number[];
}

export interface Rocket {
  name: string;
  designer: string;
  revision: string;
  designType: string;
  kitName: string;
  referenceType: string;
  referenceLength: number;
  unitSystem: 'SI';
  components: RocketComponent[];
  /**
   * Axial distance from the rocket nose to the center of pressure, in meters.
   *
   * This is the MEDIAN of the `CP location` column of the first simulation that
   * carries usable flight data, not its first row: OpenRocket writes `NaN`
   * before the rocket leaves the launch rod, an exact `0` for every row after
   * the rocket has landed (a "no forces" sentinel, not a measurement), and the
   * first real row is a launch transient that reads low. See
   * `parseCenterOfPressure` in parser.ts.
   */
  centerOfPressure?: number;
  /**
   * Index into `centerOfPressureBranches` that `centerOfPressure` came from —
   * which saved simulation the user picked. `0` when they took the default.
   */
  centerOfPressureSource?: number;
  /** Every usable CP sample, one entry per flight-data branch. Diagnostic only. */
  centerOfPressureBranches?: CenterOfPressureBranch[];
}

export type WarningSeverity = 'info' | 'error' | 'high' | 'medium' | 'low';

export interface WarningDetail {
  severity: WarningSeverity;
  message: string;
  componentId?: string;
  componentType?: ComponentType;
}

export interface RocketJson {
  schemaVersion: string;
  rocket: Rocket;
  /** Backward-compatible human-readable warning messages. */
  warnings: string[];
  /** Structured warnings for UI consumers and downstream tools. */
  warningDetails?: WarningDetail[];
}

// ---------- Raw XML intermediate types (from fast-xml-parser) ----------

// Recursive raw XML element
export interface RawXml {
  [key: string]: string | number | boolean | object | undefined;
  __rawName?: string;
}

export interface RawRocket extends RawXml {
  name?: string;
  designer?: string;
  revision?: string;
  designtype?: string;
  kitname?: string;
  referencetype?: string;
  customreference?: string;
  subcomponents?: { rocketcomponent?: RawXml[] | RawXml };
}