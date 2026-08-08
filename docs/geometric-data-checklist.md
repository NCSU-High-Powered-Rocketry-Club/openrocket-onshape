# OpenRocket Geometric Data Extraction Checklist

This document catalogs all geometric and material data available in OpenRocket files (versions 22.02+, 23.09+, 24.12+) that can be extracted for building a complete 3D model in Onshape.

> **Source:** OpenRocket 24.12 (unstable branch) — `core/src/main/java/info/openrocket/core/rocketcomponent/`
>
> **File format versions covered (2021+):**
> - **1.8** (OpenRocket 22.02, 2023-02-08): RailButton, PodSet, ParallelStage, inside appearance, override CD
> - **1.9** (OpenRocket 23.09, 2023-11-16): Component IDs
> - **1.10** (OpenRocket 24.12, 2025-07-27): DesignType, kit name, document preferences
> - **1.11** (unreleased): Simulation step method, preview image, gravity model

---

## 1. Rocket-Level Data

| # | Data Field | Description | Source Class | Include? |
|---|-----------|-------------|-------------|----------|
| 1.1 | Rocket name | User-defined rocket name | `RocketComponent.name` | [ ] |
| 1.2 | Designer | Designer name | `Rocket.designer` | [ ] |
| 1.3 | Revision | Revision string | `Rocket.revision` | [ ] |
| 1.4 | Design type | ORIGINAL, COMMERCIAL_KIT, CLONE_KIT, UPSCALE_KIT, DOWNSCALE_KIT, MODIFIED_KIT, KIT_BASH | `Rocket.designType` | [ ] |
| 1.5 | Kit name | Name of kit if applicable | `Rocket.kitName` | [ ] |
| 1.6 | Reference type | NOSECONE, MAXIMUM, CUSTOM | `Rocket.refType` | [ ] |
| 1.7 | Custom reference length | Only if refType=CUSTOM | `Rocket.customReferenceLength` | [ ] |
| 1.8 | Flight configurations | Motor configurations with stage activeness | `Rocket.configSet` | [ ] |
| 1.9 | Component ID | UUID per component (file format 1.9+) | `RocketComponent.id` | [ ] |

---

## 2. Common Component Data (All Components)

| # | Data Field | Description | Source Class | Include? |
|---|-----------|-------------|-------------|----------|
| 2.1 | Component name | User-defined or default name | `RocketComponent.name` | [ ] |
| 2.2 | Component type | XML element tag (e.g. `bodytube`, `nosecone`) | Saver classes | [ ] |
| 2.3 | Axial position method | ABSOLUTE, AFTER, TOP, MIDDLE, BOTTOM | `RocketComponent.axialMethod` | [ ] |
| 2.4 | Axial offset | Offset value relative to position method | `RocketComponent.axialOffset` | [ ] |
| 2.5 | Component position (X) | Absolute X position relative to parent | `RocketComponent.position` | [ ] |
| 2.6 | Instance count | Number of instances of this component | `RocketComponent.getInstanceCount()` | [ ] |
| 2.7 | Instance separation | Front-front separation for line-instanced components | `LineInstanceable.instanceSeparation` | [ ] |
| 2.8 | Angle offset | Rotation angle in radians (for angle-positionable) | `AnglePositionable.getAngleOffset()` | [ ] |
| 2.9 | Angle method | RELATIVE, FIXED, MIRROR_XY | `AngleMethod` | [ ] |
| 2.10 | Radius offset | Radial distance from parent centerline | `RadiusPositionable.getRadiusOffset()` | [ ] |
| 2.11 | Radius method | COAXIAL, FREE, RELATIVE, SURFACE | `RadiusMethod` | [ ] |
| 2.12 | Material | Name, type (BULK/SURFACE/LINE), density (kg/m³), shear modulus | `Material` | [ ] |
| 2.13 | Finish | ROUGH, ROUGHUNFINISHED, UNFINISHED, NORMAL, SMOOTH, OPTIMUM, POLISHED, FINISHPOLISHED, MIRROR | `ExternalComponent.Finish` | [ ] |
| 2.14 | Override mass | Manual mass override | `RocketComponent.overrideMass` | [ ] |
| 2.15 | Override CG | Manual CG X override | `RocketComponent.overrideCGX` | [ ] |
| 2.16 | Override CD | Manual CD override | `RocketComponent.overrideCD` | [ ] |
| 2.17 | Comment | User comment | `RocketComponent.comment` | [ ] |

### 2A. Appearance (Optional)

| # | Data Field | Description | Source Class | Include? |
|---|-----------|-------------|-------------|----------|
| 2A.1 | Outside paint color | RGBA color | `Appearance.getPaint()` | [ ] |
| 2A.2 | Outside shine | 0–1 shine value | `Appearance.getShine()` | [ ] |
| 2A.3 | Texture/decal | Decal image reference | `Appearance.getTexture()` | [ ] |
| 2A.4 | Inside appearance | Separate inside color | `InsideColorComponentHandler` | [ ] |
| 2A.5 | Line style | SOLID, DASHED, etc. | `RocketComponent.lineStyle` | [ ] |
| 2A.6 | Component color | Override color | `RocketComponent.color` | [ ] |

---

## 3. NoseCone / Transition / Shoulders

**Class:** `NoseCone`, `Transition` (NoseCone extends Transition)
**XML tags:** `<nosecone>`, `<transition>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 3.1 | Shape type | CONICAL, OGIVE, ELLIPSOID, POWER, PARABOLIC, HAACK | [ ] |
| 3.2 | Shape parameter | For OGIVE (0–1), POWER (0–1), PARABOLIC (0–1), HAACK (0–1/3) | [ ] |
| 3.3 | Shape clipped | Boolean — clipped shape for non-zero fore radius | [ ] |
| 3.4 | Length | Transition length (X-axis) | [ ] |
| 3.5 | Fore radius | Front radius (0 for nose cone; `auto` flag supported) | [ ] |
| 3.6 | Aft radius | Rear radius (`auto` flag supported) | [ ] |
| 3.7 | Wall thickness | Thickness of the shell (`filled` keyword for solid) | [ ] |
| 3.8 | Fore shoulder radius | Front shoulder outer radius | [ ] |
| 3.9 | Fore shoulder length | Front shoulder length | [ ] |
| 3.10 | Fore shoulder thickness | Front shoulder wall thickness | [ ] |
| 3.11 | Fore shoulder capped | Whether front shoulder end is capped | [ ] |
| 3.12 | Aft shoulder radius | Rear shoulder outer radius | [ ] |
| 3.13 | Aft shoulder length | Rear shoulder length | [ ] |
| 3.14 | Aft shoulder thickness | Rear shoulder wall thickness | [ ] |
| 3.15 | Aft shoulder capped | Whether rear shoulder end is capped | [ ] |
| 3.16 | Is flipped (NoseCone only) | Whether nose cone is a tail cone | [ ] |
| 3.17 | Base radius automatic | Whether base radius auto-derived from neighbor | [ ] |

**Note:** Transition shapes are defined parametrically. Profile can be regenerated from shape type + parameter via `Shape.getRadius(x, radius, length, param)`.

---

## 4. BodyTube

**Class:** `BodyTube`
**XML tag:** `<bodytube>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 4.1 | Length | Tube length | [ ] |
| 4.2 | Outer radius | Outer radius (`auto` flag supported) | [ ] |
| 4.3 | Wall thickness | Shell thickness (`filled` keyword for solid) | [ ] |
| 4.4 | Motor mount | Whether the tube acts as a motor mount | [ ] |

### 4A. Motor Mount Parameters (if motor mount)

| # | Data Field | Description | Source Class | Include? |
|---|-----------|-------------|-------------|----------|
| 4A.1 | Motor overhang | Overhang length | `MotorMount.getMotorOverhang()` | [ ] |
| 4A.2 | Ignition event | Motor ignition event | `MotorConfiguration.getIgnitionEvent()` | [ ] |
| 4A.3 | Ignition delay | Ignition delay in seconds | `MotorConfiguration.getIgnitionDelay()` | [ ] |
| 4A.4 | Motor designation | e.g. "C6-7" | `Motor.getDesignation()` | [ ] |
| 4A.5 | Motor diameter | Motor outer diameter | `Motor.getDiameter()` | [ ] |
| 4A.6 | Motor length | Motor length | `Motor.getLength()` | [ ] |

---

## 5. Fin Sets

### 5A. Trapezoidal Fin Set

**Class:** `TrapezoidFinSet` (extends `FinSet`)
**XML tag:** `<trapezoidfinset>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 5A.1 | Fin count | Number of fins (1–8) | [ ] |
| 5A.2 | Root chord | Length of the root edge (== `length`) | [ ] |
| 5A.3 | Tip chord | Length of the tip edge | [ ] |
| 5A.4 | Sweep length | Horizontal sweep distance | [ ] |
| 5A.5 | Height | Fin height (span) | [ ] |
| 5A.6 | Thickness | Fin thickness | [ ] |
| 5A.7 | Cross-section | SQUARE, ROUNDED, AIRFOIL | [ ] |
| 5A.8 | Cant angle | Fin cant in degrees (max ±15°) | [ ] |
| 5A.9 | Base rotation / angle offset | Rotation of first fin | [ ] |
| 5A.10 | Fin tab height | Tab height (0 if no tab) | [ ] |
| 5A.11 | Fin tab length | Tab length | [ ] |
| 5A.12 | Fin tab position | Tab position along root chord | [ ] |
| 5A.13 | Fillet radius | Fillet radius (0 if none) | [ ] |
| 5A.14 | Fillet material | Material of the fillet | [ ] |

### 5B. Elliptical Fin Set

**Class:** `EllipticalFinSet`
**XML tag:** `<ellipticalfinset>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 5B.1 | Fin count | Number of fins (1–8) | [ ] |
| 5B.2 | Root chord | Length of the fin (== `length`) | [ ] |
| 5B.3 | Height | Fin height (span) | [ ] |
| 5B.4 | Thickness | Fin thickness | [ ] |
| 5B.5 | Cross-section | SQUARE, ROUNDED, AIRFOIL | [ ] |
| 5B.6 | Cant angle | Fin cant in degrees | [ ] |
| 5B.7 | Base rotation / angle offset | Rotation of first fin | [ ] |
| 5B.8 | Fin tab height/length/position | Tab parameters (same as trapezoid) | [ ] |
| 5B.9 | Fillet radius/material | Fillet parameters (same as trapezoid) | [ ] |

### 5C. Freeform Fin Set

**Class:** `FreeformFinSet`
**XML tag:** `<freeformfinset>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 5C.1 | Fin count | Number of fins (1–8) | [ ] |
| 5C.2 | Fin points | Ordered list of (X, Y) coordinate pairs defining fin shape | [ ] |
| 5C.3 | Thickness | Fin thickness | [ ] |
| 5C.4 | Cross-section | SQUARE, ROUNDED, AIRFOIL | [ ] |
| 5C.5 | Cant angle | Fin cant in degrees | [ ] |
| 5C.6 | Base rotation / angle offset | Rotation of first fin | [ ] |
| 5C.7 | Fin tab height/length/position | Tab parameters (same as trapezoid) | [ ] |
| 5C.8 | Fillet radius/material | Fillet parameters (same as trapezoid) | [ ] |

---

## 6. Tube Fin Set

**Class:** `TubeFinSet`
**XML tag:** `<tubefinset>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 6.1 | Fin count | Number of tubes (1–8) | [ ] |
| 6.2 | Length | Tube length | [ ] |
| 6.3 | Outer radius | Tube outer radius (`auto` flag supported) | [ ] |
| 6.4 | Wall thickness | Tube wall thickness | [ ] |
| 6.5 | Base rotation / angle offset | Rotation of first tube | [ ] |

---

## 7. Launch Lug

**Class:** `LaunchLug`
**XML tag:** `<launchlug>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 7.1 | Outer radius | Lug outer radius | [ ] |
| 7.2 | Inner radius | Lug inner radius | [ ] |
| 7.3 | Thickness | Wall thickness | [ ] |
| 7.4 | Length | Lug length | [ ] |
| 7.5 | Angle offset | Rotation angle in radians | [ ] |
| 7.6 | Instance count | Number of lugs | [ ] |
| 7.7 | Instance separation | Front-front spacing | [ ] |

---

## 8. Rail Button

**Class:** `RailButton`
**XML tag:** `<railbutton>` (file format 1.8+)

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 8.1 | Outer diameter | OD of the button | [ ] |
| 8.2 | Inner diameter | ID of the button | [ ] |
| 8.3 | Total height | Overall height | [ ] |
| 8.4 | Flange height | Height of the raised flange | [ ] |
| 8.5 | Base height | Height of the base / standoff | [ ] |
| 8.6 | Screw height | Height of the mounting screw | [ ] |
| 8.7 | Angle offset | Rotation angle | [ ] |
| 8.8 | Instance count | Number of buttons | [ ] |
| 8.9 | Instance separation | Front-front spacing | [ ] |

---

## 9. Internal Components

### 9A. Inner Tube

**Class:** `InnerTube` (extends `ThicknessRingComponent`)
**XML tag:** `<innertube>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 9A.1 | Outer radius | Outer radius (`auto` flag supported) | [ ] |
| 9A.2 | Thickness | Wall thickness | [ ] |
| 9A.3 | Length | Tube length | [ ] |
| 9A.4 | Cluster configuration | single, double, 3-row…9-grid, 9-star | [ ] |
| 9A.5 | Cluster scale | Scaling factor (1.0 = touching) | [ ] |
| 9A.6 | Cluster rotation | Rotation in degrees | [ ] |
| 9A.7 | Motor mount | Whether a motor mount (same params as BodyTube) | [ ] |
| 9A.8 | Radial position | Radial offset from parent centerline | [ ] |
| 9A.9 | Radial direction | Direction angle for radial offset (radians) | [ ] |

### 9B. Tube Coupler

**Class:** `TubeCoupler` (extends `ThicknessRingComponent`)
**XML tag:** `<tubecoupler>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 9B.1 | Outer radius | Outer radius (`auto` flag supported) | [ ] |
| 9B.2 | Thickness | Wall thickness | [ ] |
| 9B.3 | Length | Coupler length | [ ] |

### 9C. Centering Ring

**Class:** `CenteringRing` (extends `RadiusRingComponent`)
**XML tag:** `<centeringring>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 9C.1 | Outer radius | Outer radius (`auto` flag supported) | [ ] |
| 9C.2 | Inner radius | Inner radius (`auto` flag supported) | [ ] |
| 9C.3 | Length | Ring length | [ ] |
| 9C.4 | Instance count | Number of rings | [ ] |
| 9C.5 | Instance separation | Front-front spacing | [ ] |

### 9D. Bulkhead

**Class:** `Bulkhead` (extends `RadiusRingComponent`)
**XML tag:** `<bulkhead>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 9D.1 | Outer radius | Outer radius (`auto` flag supported) | [ ] |
| 9D.2 | Length | Bulkhead length (inner radius always 0) | [ ] |
| 9D.3 | Instance count | Number of bulkheads | [ ] |
| 9D.4 | Instance separation | Front-front spacing | [ ] |

### 9E. Engine Block

**Class:** `EngineBlock` (extends `ThicknessRingComponent`)
**XML tag:** `<engineblock>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 9E.1 | Outer radius | Outer radius (`auto` flag supported) | [ ] |
| 9E.2 | Thickness | Wall thickness | [ ] |
| 9E.3 | Length | Block length | [ ] |

---

## 10. Recovery Devices & Mass Components

### 10A. Parachute

**Class:** `Parachute` (extends `RecoveryDevice`)
**XML tag:** `<parachute>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 10A.1 | Diameter | Canopy diameter | [ ] |
| 10A.2 | Line count | Number of shroud lines | [ ] |
| 10A.3 | Line length | Shroud line length (`auto` flag supported) | [ ] |
| 10A.4 | Line material | Material of the lines | [ ] |
| 10A.5 | Surface material | Material of the canopy | [ ] |
| 10A.6 | CD | Drag coefficient (`auto` flag supported) | [ ] |
| 10A.7 | Deployment event | APOGEE, etc. | [ ] |
| 10A.8 | Deployment altitude | Deployment altitude | [ ] |
| 10A.9 | Deployment delay | Deployment delay | [ ] |

### 10B. Streamer

**Class:** `Streamer` (extends `RecoveryDevice`)
**XML tag:** `<streamer>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 10B.1 | Strip length | Length of the streamer strip | [ ] |
| 10B.2 | Strip width | Width of the streamer strip | [ ] |
| 10B.3 | Surface material | Material of the strip | [ ] |
| 10B.4 | CD | Drag coefficient | [ ] |

### 10C. Shock Cord

**Class:** `ShockCord` (extends `MassObject`)
**XML tag:** `<shockcord>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 10C.1 | Cord length | Length (`auto` = 3× rocket length) | [ ] |
| 10C.2 | Line material | Material of the cord | [ ] |

### 10D. Mass Component

**Class:** `MassComponent` (extends `MassObject`)
**XML tag:** `<masscomponent>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 10D.1 | Mass | Component mass in kg | [ ] |
| 10D.2 | Component type | MASSCOMPONENT, ALTIMETER, FLIGHTCOMPUTER, DEPLOYMENTCHARGE, TRACKER, PAYLOAD, RECOVERYHARDWARE, BATTERY | [ ] |

### 10E. MassObject Base

**Class:** `MassObject`
**XML tags:** inherited by all above

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 10E.1 | Packed length | Length of the packed object | [ ] |
| 10E.2 | Packed radius | Radius of the packed object (`auto` flag supported) | [ ] |
| 10E.3 | Radial position | Radial offset from centerline | [ ] |
| 10E.4 | Radial direction | Direction angle for radial position | [ ] |

---

## 11. Stages & Assemblies

### 11A. Axial Stage

**Class:** `AxialStage`
**XML tag:** `<stage>`

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 11A.1 | Stage number | 0-based index of the stage | [ ] |
| 11A.2 | Separation event | Stage separation trigger | [ ] |
| 11A.3 | Separation altitude | Separation altitude in meters | [ ] |
| 11A.4 | Separation delay | Separation delay in seconds | [ ] |

### 11B. Parallel Stage (Booster)

**Class:** `ParallelStage` (extends `AxialStage`)
**XML tag:** `<parallelstage>` / `<boosterset>` (file format 1.8+)

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 11B.1 | Instance count | Number of boosters | [ ] |
| 11B.2 | Angle separation | Angle between boosters (2π/count) | [ ] |
| 11B.3 | Angle offset | Rotation of first booster | [ ] |
| 11B.4 | Radius offset | Radial distance of boosters from centerline | [ ] |
| 11B.5 | Radius method | RELATIVE, FREE, etc. | [ ] |

### 11C. Pod Set

**Class:** `PodSet` (extends `ComponentAssembly`)
**XML tag:** `<podset>` (file format 1.8+)

| # | Data Field | Description | Include? |
|---|-----------|-------------|----------|
| 11C.1 | Instance count | Number of pods in the set | [ ] |
| 11C.2 | Angle separation | Angle between pods | [ ] |
| 11C.3 | Angle offset | Rotation of first pod | [ ] |
| 11C.4 | Radius offset | Radial distance of pods from centerline | [ ] |
| 11C.5 | Radius method | RELATIVE, FREE, etc. | [ ] |

---

## 12. Derived Geometry (Computed by Parser, Not Stored in File)

These values are **not stored directly in the .ork XML** but are **computable** from the stored parameters.

| # | Derived Data | Formula / Source | Include? |
|---|-------------|-----------------|----------|
| 12.1 | Auto radius resolution | Components with `auto` radius derive from adjacent symmetric component | [ ] |
| 12.2 | Absolute component position (X) | Compose parent positions + offsets along the assembly tree | [ ] |
| 12.3 | Instance locations | `getComponentLocations()` — multiplies parent × own instancing | [ ] |
| 12.4 | Instance angles | `getComponentAngles()` — cumulative rotations from parents | [ ] |
| 12.5 | Transition/nose cone profile | Reconstruct radius via `Transition.Shape.getRadius(x, radius, length, param)` | [ ] |
| 12.6 | Fin geometry (trapezoid) | Points: `(0,0)`, `(sweep,height)`, `(sweep+tipChord,height)`, `(rootChord,0)` | [ ] |
| 12.7 | Fin geometry (elliptical) | Half-ellipse discretization | [ ] |
| 12.8 | Fin geometry (freeform) | Direct point list from `<finpoints>` | [ ] |
| 12.9 | Tube fin touching radius | `r_body × sin(π/n) / (1 − sin(π/n))` for auto radius | [ ] |
| 12.10 | Cluster positions | `ClusterConfiguration.getPoints(rotation)` with scale | [ ] |
| 12.11 | Reference diameter | From `ReferenceType` enum (NOSECONE/MAXIMUM/CUSTOM) | [ ] |
| 12.12 | Component mass | `volume × material.density` for external components | [ ] |
| 12.13 | Component CG | Computed per component type | [ ] |
| 12.14 | Wet area | `2πrL` for tubes, planform areas for fins | [ ] |

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

## 14. Suggested Extraction Priority

| Priority | Component / Data | Reason |
|----------|-----------------|--------|
| **P0** | NoseCone, Transition (shape, radii, length, thickness, shoulders) | Fundamental geometry |
| **P0** | BodyTube (length, outer radius, thickness) | Backbone of the rocket |
| **P0** | Fin sets (trapezoid, elliptical, freeform) | External geometry |
| **P0** | Component positions (axial, angle, radius) | Assembly layout |
| **P0** | Materials (name, density, type) | Mass properties |
| **P1** | InnerTube, TubeCoupler, CenteringRing, Bulkhead, EngineBlock | Internal structure |
| **P1** | LaunchLug, RailButton | External mounting hardware |
| **P1** | TubeFinSet | Alternative fin type |
| **P2** | Parachute, Streamer, ShockCord, MassComponent | Non-geometric / recovery |
| **P2** | Cluster configurations | Multi-motor layouts |
| **P3** | Appearance (color, shine, decals) | Visual only |
| **P3** | Flight configurations, motor data | Simulation only |
| **P3** | Overrides (mass, CG, CD) | Simulation only |

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