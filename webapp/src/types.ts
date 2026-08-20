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
export type AngleMethod = 'relative' | 'fixed' | 'mirror_xy';
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
  shoulderFore: Shoulder;
  shoulderAft: Shoulder;
  flipped: boolean; // nose cones only
  baseRadiusAutomatic: boolean; // aft/base radius marked "auto" in XML
  foreRadiusAutomatic: boolean; // fore radius marked "auto" in XML (e.g. <foreradius>auto 0.025</foreradius>)
}

// ---------- Body Tube ----------

export interface MotorMountParams {
  overhang: number;
  designation: string;
  diameter: number;
  length: number;
  ignitionDelay: number;
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

export interface FinTab {
  height: number;
  length: number;
  position: number; // fraction along root chord [0..1]
  positionMethod: 'top' | 'bottom' | 'middle';
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
}

export interface TubeFinParams {
  finCount: number;
  length: number;
  outerRadius: number;
  thickness: number;
  baseRotation: number;
}

// ---------- Launch Lug / Rail Button ----------

export interface LaunchLugParams {
  outerRadius: number;
  innerRadius: number;
  thickness: number;
  length: number;
}

export interface RailButtonParams {
  outerDiameter: number;
  innerDiameter: number;
  totalHeight: number;
  flangeHeight: number;
  baseHeight: number;
  screwHeight: number;
}

// ---------- Ring components ----------

export interface RingComponentParams {
  outerRadius: number;
  innerRadius: number; // 0 for bulkhead (solid disc)
  thickness: number; // wall thickness for thickness rings
  length: number;
  clusterConfiguration: string; // inner tubes only
  clusterScale: number;
  clusterRotation: number; // degrees
  radialPosition: number;
  radialDirection: number; // radians
  isMotorMount: boolean;
  motorMount?: MotorMountParams;
}

// ---------- Recovery / mass ----------

export interface RecoveryDeviceParams {
  packedLength: number;
  packedRadius: number;
  radialPosition: number;
  radialDirection: number;
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

export interface RocketComponent {
  type: ComponentType;
  name: string;
  id: string;
  material?: Material;
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
    | RecoveryDeviceParams;
  children: RocketComponent[];
}

// ---------- Rocket ----------

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
}

export interface RocketJson {
  schemaVersion: string;
  rocket: Rocket;
  warnings: string[];
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