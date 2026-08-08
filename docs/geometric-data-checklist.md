# OpenRocket Geometric Data Extraction Checklist

This document catalogs all geometric and material data available in OpenRocket files (versions 22.02+, 23.09+, 24.12+) that can be extracted for building a complete 3D model in Onshape.

> **Purpose** — Use the checkboxes to mark which data fields the static web app will include in its JSON output for the Onshape custom feature.
>
> **Priority legend:**
> - **P0** = Critical — required for a complete 3D model (geometry + assembly + materials)
> - **P1** = High — important for structural/internal detail
> - **P2** = Medium — useful but optional (recovery, mass, clusters)
> - **P3** = Low — cosmetic or simulation-only (skip for initial version)
>
> **Deprecated:** Marks data that is only kept for backward compatibility with pre-2021 OpenRocket (≤15.03). Consider skipping.

> **Source:** OpenRocket 24.12 (unstable branch) — `core/src/main/java/info/openrocket/core/rocketcomponent/`
>
> **File format versions covered (2021+):**
> - **1.8** (OpenRocket 22.02, 2023-02-08): RailButton, PodSet, ParallelStage, inside appearance, override CD
> - **1.9** (OpenRocket 23.09, 2023-11-16): Component IDs
> - **1.10** (OpenRocket 24.12, 2025-07-27): DesignType, kit name, document preferences
> - **1.11** (unreleased): Simulation step method, preview image, gravity model

---

## 1. Rocket-Level Data

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 1.1 | Rocket name | User-defined rocket name; used as the Onshape document/part title | P0 | No | [ ] |
| 1.2 | Designer | Designer name string; metadata only, not geometry | P3 | No | [ ] |
| 1.3 | Revision | Revision string; metadata only, not geometry | P3 | No | [ ] |
| 1.4 | Design type | ORIGINAL, COMMERCIAL_KIT, CLONE_KIT, UPSCALE_KIT, DOWNSCALE_KIT, MODIFIED_KIT, KIT_BASH; metadata only, not geometry | P3 | No | [ ] |
| 1.5 | Kit name | Name of commercial kit; metadata only, not geometry | P3 | No | [ ] |
| 1.6 | Reference type | NOSECONE, MAXIMUM, CUSTOM — defines the reference diameter used in sims | P2 | No | [ ] |
| 1.7 | Custom reference length | Custom reference diameter (only if refType=CUSTOM) | P2 | No | [ ] |
| 1.8 | Flight configurations | Motor configurations with per-stage activeness; simulation-only, not geometry | P3 | No | [ ] |
| 1.9 | Component ID | UUID per component (file format 1.9+, OR 23.09+); useful for tracking parts across Onshape rebuilds | P1 | No | [ ] |

---

## 2. Common Component Data (All Components)

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 2.1 | Component name | User-defined or default name; used for Onshape part naming | P0 | No | [ ] |
| 2.2 | Component type | XML element tag (e.g. `bodytube`, `nosecone`); determines which geometry builder runs | P0 | No | [ ] |
| 2.3 | Axial position method | ABSOLUTE, AFTER, TOP, MIDDLE, BOTTOM — how X position is measured relative to parent | P0 | No | [ ] |
| 2.4 | Axial offset | Offset value for the axial position method; primary positioning input | P0 | No | [ ] |
| 2.5 | Component position (X) | Absolute X coordinate of component origin in parent frame; useful instead of deriving from method+offset | P0 | No | [ ] |
| 2.6 | Instance count | How many copies of this component exist (e.g. 4 fins, 2 lugs) | P0 | No | [ ] |
| 2.7 | Instance separation | Front-front axial spacing between copies for line-instanced components | P1 | No | [ ] |
| 2.8 | Angle offset | Rotation angle (radians) of the first instance around the parent's X axis | P0 | No | [ ] |
| 2.9 | Angle method | RELATIVE, FIXED, MIRROR_XY — how instance angle is combined with parent angle | P2 | Mirror uncommon; all 3 current | [ ] |
| 2.10 | Radius offset | Radial distance of the component from the parent centerline (for lugs, rails, pods) | P0 | No | [ ] |
| 2.11 | Radius method | COAXIAL, FREE, RELATIVE, SURFACE — how the radius offset is interpreted | P2 | No | [ ] |
| 2.12 | Material | Name, type (BULK/SURFACE/LINE), density (kg/m³), shear modulus; used for mass properties in Onshape | P0 | No | [ ] |
| 2.13 | Finish | Surface finish enum (ROUGH→MIRROR) with roughness values; simulation-only, not geometry | P3 | No | [ ] |
| 2.14 | Override mass | Manual mass override; simulation-only, not geometry | P3 | No | [ ] |
| 2.15 | Override CG | Manual CG-X override; simulation-only, not geometry | P3 | No | [ ] |
| 2.16 | Override CD | Manual CD override; simulation-only, not geometry | P3 | No | [ ] |
| 2.17 | Comment | User comment text; metadata only | P3 | No | [ ] |

### 2A. Appearance (Optional)

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 2A.1 | Outside paint color | RGBA color; used for Onshape part appearance | P3 | No | [ ] |
| 2A.2 | Outside shine | 0–1 shine/gloss value for appearance | P3 | No | [ ] |
| 2A.3 | Texture/decal | Decal image reference (image is a separate file inside the .ork zip); hard to map to Onshape | P3 | No | [ ] |
| 2A.4 | Inside appearance | Separate inside color for hollow tubes/nose cones; Onshape appearance only | P3 | No | [ ] |
| 2A.5 | Line style | Line style enum (SOLID, DASHED...); legacy display only | P3 | Yes — legacy (pre-2021 display feature) | [ ] |
| 2A.6 | Component color | Per-component color override; Onshape appearance only | P3 | No | [ ] |

---

## 3. NoseCone / Transition / Shoulders

**Classes:** `NoseCone`, `Transition` (NoseCone extends Transition)
**XML tags:** `<nosecone>`, `<transition>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 3.1 | Shape type | CONICAL, OGIVE, ELLIPSOID, POWER, PARABOLIC, HAACK — determines the profile curve | P0 | No | [ ] |
| 3.2 | Shape parameter | Per-shape parameter (OGIVE 0–1, POWER 0–1, PARABOLIC 0–1, HAACK 0–1/3); needed to regenerate the profile | P0 | No | [ ] |
| 3.3 | Shape clipped | Boolean — whether the shape is clipped (truncated) for non-zero fore radius | P0 | No | [ ] |
| 3.4 | Length | Transition length along X axis | P0 | No | [ ] |
| 3.5 | Fore radius | Front radius (0 for nose cone; `auto` flag supported — derive from neighbor) | P0 | No | [ ] |
| 3.6 | Aft radius | Rear radius (`auto` flag supported — derive from neighbor) | P0 | No | [ ] |
| 3.7 | Wall thickness | Shell thickness; special value `filled` = solid body | P0 | No | [ ] |
| 3.8 | Fore shoulder radius | Front shoulder outer radius; 0 = no shoulder | P0 | No | [ ] |
| 3.9 | Fore shoulder length | Front shoulder length | P0 | No | [ ] |
| 3.10 | Fore shoulder thickness | Front shoulder wall thickness | P1 | No | [ ] |
| 3.11 | Fore shoulder capped | Whether the front shoulder end has a cap face | P1 | No | [ ] |
| 3.12 | Aft shoulder radius | Rear shoulder outer radius; 0 = no shoulder | P0 | No | [ ] |
| 3.13 | Aft shoulder length | Rear shoulder length | P0 | No | [ ] |
| 3.14 | Aft shoulder thickness | Rear shoulder wall thickness | P1 | No | [ ] |
| 3.15 | Aft shoulder capped | Whether the rear shoulder end has a cap face | P1 | No | [ ] |
| 3.16 | Is flipped (NoseCone only) | Whether the nose cone is a reversed tail cone (fore/aft dimensions swapped) | P1 | No | [ ] |
| 3.17 | Base radius automatic | Whether the base/aft radius is auto-derived from the adjacent symmetric component | P1 | No | [ ] |

**Note:** Transition shapes are defined parametrically. Profile can be regenerated from shape type + parameter via `Transition.Shape.getRadius(x, radius, length, param)`.

---

## 4. BodyTube

**Class:** `BodyTube`
**XML tag:** `<bodytube>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 4.1 | Length | Tube length along X axis | P0 | No | [ ] |
| 4.2 | Outer radius | Outer radius; `auto` flag means derive from adjacent symmetric component | P0 | No | [ ] |
| 4.3 | Wall thickness | Shell thickness; special value `filled` = solid rod | P0 | No | [ ] |
| 4.4 | Motor mount | Whether the tube acts as a motor mount (enables motor mount params below) | P1 | No | [ ] |

### 4A. Motor Mount Parameters (if motor mount)

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 4A.1 | Motor overhang | How far the motor sticks out of the rear of the tube | P2 | No | [ ] |
| 4A.2 | Ignition event | Motor ignition event (LAUNCH, APOGEE...); simulation-only | P3 | No | [ ] |
| 4A.3 | Ignition delay | Ignition delay in seconds; simulation-only | P3 | No | [ ] |
| 4A.4 | Motor designation | Motor name e.g. "C6-7"; could be used to model the motor casing | P2 | No | [ ] |
| 4A.5 | Motor diameter | Motor outer diameter; geometry for motor casing model | P2 | No | [ ] |
| 4A.6 | Motor length | Motor length; geometry for motor casing model | P2 | No | [ ] |

---

## 5. Fin Sets

### 5A. Trapezoidal Fin Set

**Class:** `TrapezoidFinSet` (extends `FinSet`)
**XML tag:** `<trapezoidfinset>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 5A.1 | Fin count | Number of fins (1–8); angular spacing = 2π/count | P0 | No | [ ] |
| 5A.2 | Root chord | Length of the fin root edge that attaches to the body | P0 | No | [ ] |
| 5A.3 | Tip chord | Length of the fin tip edge | P0 | No | [ ] |
| 5A.4 | Sweep length | Horizontal sweep distance of the leading edge | P0 | No | [ ] |
| 5A.5 | Height | Fin span (radial height from body) | P0 | No | [ ] |
| 5A.6 | Thickness | Fin thickness | P0 | No | [ ] |
| 5A.7 | Cross-section | SQUARE, ROUNDED, AIRFOIL — affects edge profile shape | P1 | No | [ ] |
| 5A.8 | Cant angle | Fin cant (max ±15°) — twists each fin around its root for roll | P1 | No | [ ] |
| 5A.9 | Base rotation / angle offset | Rotation of the first fin | P0 | No | [ ] |
| 5A.10 | Fin tab height | Tab protrusion below body surface; 0 = no tab | P1 | No | [ ] |
| 5A.11 | Fin tab length | Tab length along the root chord | P1 | No | [ ] |
| 5A.12 | Fin tab position | Tab position along the root chord (relative to front/center/end) | P1 | Legacy `relativeto="front|center|end"` attr for OR 15.03 compat — parse new method attr only | [ ] |
| 5A.13 | Fillet radius | Root fillet radius; 0 = no fillet | P2 | No | [ ] |
| 5A.14 | Fillet material | Material used for the fillet (mass calc only) | P3 | No | [ ] |

### 5B. Elliptical Fin Set

**Class:** `EllipticalFinSet`
**XML tag:** `<ellipticalfinset>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 5B.1 | Fin count | Number of fins (1–8); angular spacing = 2π/count | P0 | No | [ ] |
| 5B.2 | Root chord | Length of the fin (along body axis) | P0 | No | [ ] |
| 5B.3 | Height | Fin span (radial height) | P0 | No | [ ] |
| 5B.4 | Thickness | Fin thickness | P0 | No | [ ] |
| 5B.5 | Cross-section | SQUARE, ROUNDED, AIRFOIL | P1 | No | [ ] |
| 5B.6 | Cant angle | Fin cant (max ±15°) | P1 | No | [ ] |
| 5B.7 | Base rotation / angle offset | Rotation of the first fin | P0 | No | [ ] |
| 5B.8 | Fin tab height/length/position | Same as trapezoid (P1) | P1 | Same tab-position legacy note as 5A.12 | [ ] |
| 5B.9 | Fillet radius/material | Same as trapezoid (P2/P3) | P2 | No | [ ] |

### 5C. Freeform Fin Set

**Class:** `FreeformFinSet`
**XML tag:** `<freeformfinset>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 5C.1 | Fin count | Number of fins (1–8); angular spacing = 2π/count | P0 | No | [ ] |
| 5C.2 | Fin points | Ordered list of (X, Y) coordinate pairs defining the fin planform | P0 | No | [ ] |
| 5C.3 | Thickness | Fin thickness | P0 | No | [ ] |
| 5C.4 | Cross-section | SQUARE, ROUNDED, AIRFOIL | P1 | No | [ ] |
| 5C.5 | Cant angle | Fin cant (max ±15°) | P1 | No | [ ] |
| 5C.6 | Base rotation / angle offset | Rotation of the first fin | P0 | No | [ ] |
| 5C.7 | Fin tab height/length/position | Same as trapezoid (P1) | P1 | Same tab-position legacy note as 5A.12 | [ ] |
| 5C.8 | Fillet radius/material | Same as trapezoid (P2/P3) | P2 | No | [ ] |

---

## 6. Tube Fin Set

**Class:** `TubeFinSet`
**XML tag:** `<tubefinset>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 6.1 | Fin count | Number of tubes (1–8) | P1 | No | [ ] |
| 6.2 | Length | Tube length along X axis | P1 | No | [ ] |
| 6.3 | Outer radius | Tube outer radius; `auto` flag = tubes just touching each other | P1 | No | [ ] |
| 6.4 | Wall thickness | Tube wall thickness | P1 | No | [ ] |
| 6.5 | Base rotation / angle offset | Rotation of the first tube | P1 | No | [ ] |

---

## 7. Launch Lug

**Class:** `LaunchLug`
**XML tag:** `<launchlug>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 7.1 | Outer radius | Lug outer radius; typically small (~0.5–4 mm) | P1 | No | [ ] |
| 7.2 | Inner radius | Lug inner radius (derived from thickness) | P1 | No | [ ] |
| 7.3 | Thickness | Wall thickness of the lug | P1 | No | [ ] |
| 7.4 | Length | Lug length along X axis | P1 | No | [ ] |
| 7.5 | Angle offset | Rotation of the lug around the body | P1 | No | [ ] |
| 7.6 | Instance count | Number of lugs (e.g. 1 or 2) | P1 | No | [ ] |
| 7.7 | Instance separation | Front-front axial spacing between lugs | P1 | No | [ ] |

---

## 8. Rail Button

**Class:** `RailButton`
**XML tag:** `<railbutton>` (file format 1.8+, OR 22.02+)

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 8.1 | Outer diameter | OD of the button (typical 15–25 mm) | P1 | No | [ ] |
| 8.2 | Inner diameter | ID of the button | P1 | No | [ ] |
| 8.3 | Total height | Overall height above the body | P1 | No | [ ] |
| 8.4 | Flange height | Height of the raised flange ring | P1 | No | [ ] |
| 8.5 | Base height | Height of the base/standoff disc | P1 | No | [ ] |
| 8.6 | Screw height | Height of the mounting screw section | P1 | No | [ ] |
| 8.7 | Angle offset | Rotation of the button around the body | P1 | No | [ ] |
| 8.8 | Instance count | Number of buttons (e.g. 2) | P1 | No | [ ] |
| 8.9 | Instance separation | Front-front axial spacing between buttons | P1 | No | [ ] |

---

## 9. Internal Components

### 9A. Inner Tube

**Class:** `InnerTube` (extends `ThicknessRingComponent`)
**XML tag:** `<innertube>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 9A.1 | Outer radius | Outer radius; `auto` flag = derive from parent inner radius | P1 | No | [ ] |
| 9A.2 | Thickness | Wall thickness | P1 | No | [ ] |
| 9A.3 | Length | Tube length | P1 | No | [ ] |
| 9A.4 | Cluster configuration | single, double, 3-row…9-grid, 9-star — layout of clustered motor tubes | P2 | No | [ ] |
| 9A.5 | Cluster scale | Scaling factor for cluster spacing (1.0 = tubes touching) | P2 | No | [ ] |
| 9A.6 | Cluster rotation | Rotation of the cluster pattern in degrees | P2 | No | [ ] |
| 9A.7 | Motor mount | Whether a motor mount (same params as BodyTube 4A) | P2 | No | [ ] |
| 9A.8 | Radial position | Radial offset of the inner tube from the parent centerline | P1 | No | [ ] |
| 9A.9 | Radial direction | Direction angle for the radial offset (radians) | P1 | No | [ ] |

### 9B. Tube Coupler

**Class:** `TubeCoupler` (extends `ThicknessRingComponent`)
**XML tag:** `<tubecoupler>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 9B.1 | Outer radius | Outer radius; `auto` flag = derive from parent | P1 | No | [ ] |
| 9B.2 | Thickness | Wall thickness | P1 | No | [ ] |
| 9B.3 | Length | Coupler length | P1 | No | [ ] |

### 9C. Centering Ring

**Class:** `CenteringRing` (extends `RadiusRingComponent`)
**XML tag:** `<centeringring>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 9C.1 | Outer radius | Outer radius; `auto` flag = derive from parent | P1 | No | [ ] |
| 9C.2 | Inner radius | Inner radius; `auto` flag = derive from motor tube OD | P1 | No | [ ] |
| 9C.3 | Length | Ring length (usually thin, ~3–10 mm) | P1 | No | [ ] |
| 9C.4 | Instance count | Number of rings (e.g. 2 per stage) | P1 | No | [ ] |
| 9C.5 | Instance separation | Front-front axial spacing between rings | P1 | No | [ ] |

### 9D. Bulkhead

**Class:** `Bulkhead` (extends `RadiusRingComponent`)
**XML tag:** `<bulkhead>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 9D.1 | Outer radius | Outer radius; `auto` flag = derive from parent | P1 | No | [ ] |
| 9D.2 | Length | Bulkhead length; inner radius is always 0 (solid disc) | P1 | No | [ ] |
| 9D.3 | Instance count | Number of bulkheads | P1 | No | [ ] |
| 9D.4 | Instance separation | Front-front axial spacing | P1 | No | [ ] |

### 9E. Engine Block

**Class:** `EngineBlock` (extends `ThicknessRingComponent`)
**XML tag:** `<engineblock>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 9E.1 | Outer radius | Outer radius; `auto` flag = derive from parent | P1 | No | [ ] |
| 9E.2 | Thickness | Wall thickness | P1 | No | [ ] |
| 9E.3 | Length | Block length | P1 | No | [ ] |

---

## 10. Recovery Devices & Mass Components

### 10A. Parachute

**Class:** `Parachute` (extends `RecoveryDevice`)
**XML tag:** `<parachute>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 10A.1 | Diameter | Canopy diameter; geometry for a simplified folded/packed model | P2 | No | [ ] |
| 10A.2 | Line count | Number of shroud lines | P3 | No | [ ] |
| 10A.3 | Line length | Shroud line length; `auto` flag supported | P3 | No | [ ] |
| 10A.4 | Line material | Material of the shroud lines (mass calc) | P3 | No | [ ] |
| 10A.5 | Surface material | Material of the canopy (mass calc) | P2 | No | [ ] |
| 10A.6 | CD | Drag coefficient; `auto` flag supported; simulation-only | P3 | No | [ ] |
| 10A.7 | Deployment event | APOGEE, etc.; simulation-only | P3 | No | [ ] |
| 10A.8 | Deployment altitude | Deployment altitude in m; simulation-only | P3 | No | [ ] |
| 10A.9 | Deployment delay | Deployment delay in s; simulation-only | P3 | No | [ ] |

### 10B. Streamer

**Class:** `Streamer` (extends `RecoveryDevice`)
**XML tag:** `<streamer>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 10B.1 | Strip length | Length of the streamer strip; geometry for a simplified folded model | P2 | No | [ ] |
| 10B.2 | Strip width | Width of the streamer strip | P2 | No | [ ] |
| 10B.3 | Surface material | Material of the strip (mass calc) | P2 | No | [ ] |
| 10B.4 | CD | Drag coefficient; simulation-only | P3 | No | [ ] |

### 10C. Shock Cord

**Class:** `ShockCord` (extends `MassObject`)
**XML tag:** `<shockcord>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 10C.1 | Cord length | Length; `auto` = 3× rocket length; geometry for a simplified cord | P2 | No | [ ] |
| 10C.2 | Line material | Material of the cord (mass calc) | P2 | No | [ ] |

### 10D. Mass Component

**Class:** `MassComponent` (extends `MassObject`)
**XML tag:** `<masscomponent>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 10D.1 | Mass | Component mass in kg; used for Onshape mass properties | P1 | No | [ ] |
| 10D.2 | Component type | MASSCOMPONENT, ALTIMETER, FLIGHTCOMPUTER, DEPLOYMENTCHARGE, TRACKER, PAYLOAD, RECOVERYHARDWARE, BATTERY — for naming/appearance | P2 | No | [ ] |

### 10E. MassObject Base

**Class:** `MassObject`
**XML tags:** inherited by all above

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 10E.1 | Packed length | Length of the packed object; used for simplified cylinder representation | P2 | No | [ ] |
| 10E.2 | Packed radius | Radius of the packed object; `auto` flag supported | P2 | No | [ ] |
| 10E.3 | Radial position | Radial offset of the object from centerline | P2 | No | [ ] |
| 10E.4 | Radial direction | Direction angle for radial position (radians) | P2 | No | [ ] |

---

## 11. Stages & Assemblies

### 11A. Axial Stage

**Class:** `AxialStage`
**XML tag:** `<stage>`

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 11A.1 | Stage number | 0-based index of the stage; used for grouping components in Onshape | P0 | No | [ ] |
| 11A.2 | Separation event | Stage separation trigger; simulation-only | P3 | No | [ ] |
| 11A.3 | Separation altitude | Separation altitude in m; simulation-only | P3 | No | [ ] |
| 11A.4 | Separation delay | Separation delay in s; simulation-only | P3 | No | [ ] |

### 11B. Parallel Stage (Booster)

**Class:** `ParallelStage` (extends `AxialStage`)
**XML tag:** `<parallelstage>` / `<boosterset>` (file format 1.8+, OR 22.02+)

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 11B.1 | Instance count | Number of boosters (e.g. 2, 3, 4) | P1 | No | [ ] |
| 11B.2 | Angle separation | Angle between boosters (2π/count) | P1 | No | [ ] |
| 11B.3 | Angle offset | Rotation of the first booster | P1 | No | [ ] |
| 11B.4 | Radius offset | Radial distance of boosters from the centerline | P1 | No | [ ] |
| 11B.5 | Radius method | RELATIVE, FREE, etc. — how the radius is interpreted | P1 | No | [ ] |

### 11C. Pod Set

**Class:** `PodSet` (extends `ComponentAssembly`)
**XML tag:** `<podset>` (file format 1.8+, OR 22.02+)

| # | Data Field | What It Is | Priority | Deprecated? | Include? |
|---|-----------|------------|----------|-------------|----------|
| 11C.1 | Instance count | Number of pods in the set | P1 | No | [ ] |
| 11C.2 | Angle separation | Angle between pods | P1 | No | [ ] |
| 11C.3 | Angle offset | Rotation of the first pod | P1 | No | [ ] |
| 11C.4 | Radius offset | Radial distance of pods from the centerline | P1 | No | [ ] |
| 11C.5 | Radius method | RELATIVE, FREE, etc. | P1 | No | [ ] |

---

## 12. Derived Geometry (Computed by Parser, Not Stored in File)

These values are **not stored directly in the .ork XML** but are **computable** from the stored parameters. The web app parser must implement these.

| # | Derived Data | What It Is | Priority | Deprecated? | Include? |
|---|-------------|------------|----------|-------------|----------|
| 12.1 | Auto radius resolution | Resolve components flagged `auto` by reading adjacent symmetric component's radius | P0 | No | [ ] |
| 12.2 | Absolute component position (X) | Compose parent positions + axial offsets along the assembly tree | P0 | No | [ ] |
| 12.3 | Instance locations | Full 3D coordinates of every instance (parent instancing × own instancing) | P0 | No | [ ] |
| 12.4 | Instance angles | Cumulative X-rotation angles for every instance (from parent assemblies) | P0 | No | [ ] |
| 12.5 | Transition/nose cone profile | Reconstruct radius at any x via `Transition.Shape.getRadius(x, r, L, param)` | P0 | No | [ ] |
| 12.6 | Fin geometry (trapezoid) | Build planform points: `(0,0)`, `(sweep,height)`, `(sweep+tipChord,height)`, `(rootChord,0)` | P0 | No | [ ] |
| 12.7 | Fin geometry (elliptical) | Half-ellipse discretization (31 points, OpenRocket's POINT_X/POINT_Y tables) | P0 | No | [ ] |
| 12.8 | Fin geometry (freeform) | Direct point list from `<finpoints>` | P0 | No | [ ] |
| 12.9 | Tube fin touching radius | `r_body × sin(π/n) / (1 − sin(π/n))` for `auto` tube fin radius | P1 | No | [ ] |
| 12.10 | Cluster positions | `ClusterConfiguration.getPoints(rotation)` scaled by cluster scale | P2 | No | [ ] |
| 12.11 | Reference diameter | From `ReferenceType` enum (NOSECONE/MAXIMUM/CUSTOM) | P2 | No | [ ] |
| 12.12 | Component mass | `volume × material.density` for external components (needed for Onshape mass props) | P1 | No | [ ] |
| 12.13 | Component CG | Computed per component type (needed for Onshape mass props) | P1 | No | [ ] |
| 12.14 | Wet area | `2πrL` for tubes, planform areas for fins; display only | P3 | No | [ ] |

---

## 13. Recommended JSON Schema (For Onshape Custom Feature)

```json
{
  "schemaVersion": "1.0",
  "rocket": {
    "name": "My Rocket",
    "designer": "Jane Doe",
    "designType": "original",
    "referenceLength": 0.098,
    "units": "SI"
  },
  "components": [
    {
      "type": "nosecone",
      "name": "Nose Cone",
      "id": "uuid-here",
      "axialMethod": "absolute",
      "axialOffset": 0.0,
      "position": [0.0, 0.0, 0.0],
      "material": { "name": "Balsa", "type": "bulk", "density": 150.0 },
      "params": {
        "shapeType": "ogive",
        "shapeParameter": 1.0,
        "clipped": false,
        "length": 0.15,
        "foreRadius": 0.0,
        "aftRadius": 0.025,
        "thickness": 0.002,
        "aftShoulderRadius": 0.023,
        "aftShoulderLength": 0.02,
        "aftShoulderThickness": 0.002,
        "aftShoulderCapped": false
      }
    },
    {
      "type": "bodytube",
      "name": "Body Tube",
      "axialMethod": "after",
      "axialOffset": 0.0,
      "position": [0.15, 0.0, 0.0],
      "params": { "length": 0.5, "outerRadius": 0.025, "thickness": 0.0015 }
    }
  ]
}
```

---

## 14. Suggested Extraction Priority Summary

| Priority | Component / Data | Reason |
|----------|-----------------|--------|
| **P0 — Critical** | NoseCone, Transition (shape, radii, length, thickness, shoulders) | Fundamental geometry of the rocket |
| **P0 — Critical** | BodyTube (length, outer radius, thickness) | Backbone of the rocket |
| **P0 — Critical** | Fin sets (trapezoid, elliptical, freeform) | External geometry |
| **P0 — Critical** | Component positions (axial, angle, radius) | Assembly layout |
| **P0 — Critical** | Materials (name, density, type) | Mass properties |
| **P1 — High** | InnerTube, TubeCoupler, CenteringRing, Bulkhead, EngineBlock | Internal structure |
| **P1 — High** | LaunchLug, RailButton | External mounting hardware |
| **P1 — High** | TubeFinSet | Alternative fin type |
| **P1 — High** | Component IDs, Stage numbers | Part tracking / grouping in Onshape |
| **P2 — Medium** | Parachute, Streamer, ShockCord, MassComponent | Non-geometric / recovery |
| **P2 — Medium** | Cluster configurations | Multi-motor layouts |
| **P2 — Medium** | RailButton (if using launch lugs) | External hardware |
| **P3 — Low** | Appearance (color, shine, decals) | Visual only |
| **P3 — Low** | Flight configurations, motor data | Simulation only |
| **P3 — Low** | Overrides (mass, CG, CD), Finish, roughness | Simulation only |

---

## 15. Process Documentation

### How the Data Was Collected

1. **Explored the OpenRocket repository** at `openrocket-unstable/openrocket-unstable/core/src/main/java/`
2. **Reviewed all rocket component classes** in `info.openrocket.core.rocketcomponent/`
3. **Examined all 34 saver classes** in `info.openrocket.core.file.openrocket.savers/` to determine exactly what is serialized to the `.ork` XML
4. **Reviewed the file format & ReleaseNotes** to filter for versions from 2021+ (file formats 1.8 – 1.11)

### Key Findings

- The `.ork` file is a **zipped XML** file — the web app must unzip it and parse the XML.
- All dimensions are stored in **SI units** (meters, kg, radians).
- Components with `auto` radius flags require **resolving the value from neighboring components** in the assembly tree.
- The XML structure is hierarchical: `<rocket>` → `<stage>` → `<subcomponents>` → components.
- Position uses `axialoffset` (X), `angleoffset` (rotation), and `radiusoffset` (radial) methods.
- Instanceable components (fins, launch lugs, rail buttons, pods, boosters) repeat via rotation and/or linear offsets.
- The parser must handle `<thickness>filled</thickness>` (solid vs shell geometry).
- Component IDs (UUIDs) are available for file format 1.9+.
- There is **no Sleeve component** in the .ork file format — it exists only in RockSim export/import.
- **Deprecated / legacy items to skip:** `LineStyle` (2A.5), the old tab `relativeto="front|center|end"` attribute (5A.12 / 5B.8 / 5C.7 — kept only for OR 15.03 compatibility).

### Key Files Examined

| File | Purpose |
|------|---------|
| `rocketcomponent/NoseCone.java` | Nose cone geometry |
| `rocketcomponent/Transition.java` | Transition shapes + shoulders |
| `rocketcomponent/BodyTube.java` | Body tube + motor mount |
| `rocketcomponent/FinSet.java` | Fin base (tabs, fillets, cant) |
| `rocketcomponent/TrapezoidFinSet.java` | Trapezoid fin dimensions |
| `rocketcomponent/EllipticalFinSet.java` | Elliptical fin dimensions |
| `rocketcomponent/FreeformFinSet.java` | Freeform fin points |
| `rocketcomponent/TubeFinSet.java` | Tube fin geometry |
| `rocketcomponent/LaunchLug.java` | Launch lug |
| `rocketcomponent/RailButton.java` | Rail button |
| `rocketcomponent/InnerTube.java` | Inner tube + cluster |
| `rocketcomponent/RadiusRingComponent.java` | Centering ring / bulkhead |
| `rocketcomponent/ThicknessRingComponent.java` | Tube coupler / engine block |
| `rocketcomponent/PodSet.java` | Pod assembly |
| `rocketcomponent/ParallelStage.java` | Booster assembly |
| `rocketcomponent/Material.java` | Material types / density |
| `rocketcomponent/position/*.java` | Axial / Angle / Radius positioning |
| `file/openrocket/savers/*.java` | XML serialization format |
| `fileformat.txt` | File format versions |
| `ReleaseNotes.md` | Feature timeline since 2021 |