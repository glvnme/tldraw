# IFC

|                  |                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Status           | Implemented (`model-converter/src/ifc.ts`). Planned: feature table, dense IDs, units and georeference in v2 |
| Extensions       | `.ifc` (STEP physical file). `.ifczip` and `.ifcxml` are not supported                                      |
| Magic            | `ISO-10303-21;` at the start, then a `FILE_SCHEMA(('IFC2X3'))`, `IFC4` or `IFC4X3` header                   |
| Reader           | web-ifc 0.0.78 (WASM)                                                                                       |
| Source format id | `'ifc'`                                                                                                     |

## The format, briefly

A text file of numbered entity instances (`#123=IFCWALL(...)`) defined by the buildingSMART EXPRESS schema (IFC 4.3 is ISO 16739-1:2024). Products (`IfcWall`, `IfcSlab`, `IfcDoor`, ...) carry a 22-character `GlobalId`, a name, a type, an `ObjectPlacement` and a `Representation`. Geometry is implicit (extrusions, swept solids, booleans, B-reps, tessellations), so a geometry kernel is needed to triangulate it. Spatial structure: `IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey → products`, linked by `IfcRelContainedInSpatialStructure` and `IfcRelAggregates`. Units come from `IfcUnitAssignment`. Georeference (IFC4 and later) comes from `IfcMapConversion` and `IfcProjectedCRS`.

## Dependency and licence

| Code                                                   | Licence  | Obligation                                                                                                          |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| web-ifc 0.0.78 (already a dependency)                  | MPL-2.0  | Notice in `THIRD_PARTY_NOTICES.md`. Changes to web-ifc's own files would have to be published; we don't change them |
| IfcOpenShell / IfcConvert (fallback only, not planned) | LGPL-3.0 | Only if a corpus shows web-ifc failures that it fixes                                                               |

Writing our own IFC geometry kernel isn't realistic (tens of thousands of lines). Reading metadata ourselves is easy, but web-ifc already exposes it, so we don't.

## Current behaviour

- `OpenModel` with `COORDINATE_TO_ORIGIN: true`, `CIRCLE_SEGMENTS: 12`, `MEMORY_LIMIT: 3 GiB`.
- `StreamAllMeshes`: one mesh per (product, geometry, colour), one node per placement. web-ifc's placement matrices are already Y-up.
- `_BATCHID` = the product's ExpressID (file-local, can be large, changes on re-export).
- Transform: `recentreOffset` derived from the coordination matrix. Units are hard-coded to `'m'` (web-ifc normalises geometry to metres).

## Conversion steps (v2)

1. **Open** as today. Read the schema from the header for `formatVersion`.
2. **Metadata pass** before streaming meshes:
   - Products: `GetLineIDsWithType` for `IFCPRODUCT` subtypes, or `GetAllLines` filtered. For each, collect `GlobalId`, `Name`, the type name (`GetNameFromTypeCode`), and `ObjectType`.
   - Spatial tree: walk `IfcRelAggregates` and `IfcRelContainedInSpatialStructure` from `IfcProject`. Storeys become `levels` (`id` = storey GlobalId, `name`, `elevation` in metres).
   - Layers: `IfcPresentationLayerAssignment` (`Name`, `AssignedItems`) maps to `layers`. Products without one use their storey as `layerId`.
   - Units: the `IfcUnitAssignment` length unit (with prefix) gives `units.name` and `metresPerUnit` for the ghost reference. Geometry is already in metres.
   - Georeference: `IfcMapConversion` (`Eastings`, `Northings`, `OrthogonalHeight`, `XAxisAbscissa/Ordinate`, `Scale`) and `IfcProjectedCRS.Name`. Without them, `IfcSite.RefLatitude`, `RefLongitude` and `RefElevation`.
   - Authoring: `IfcOwnerHistory` → `IfcApplication` (`ApplicationFullName`, `Version`) and the header's `FILE_NAME` (originating system, timestamp).
3. **Dense IDs.** Map ExpressID to `featureId` in order of first appearance while streaming. `batchIds` use the feature ID, not the ExpressID.
4. **Feature record:** `sourceId` = GlobalId (`ifc-globalid`), `localId` = ExpressID, `name`, `type` (`IfcWall` and so on), `levelId` = containing storey, `layerId`, `materialId` = colour key.
5. **Opening elements and spaces:** web-ifc already subtracts openings. Skip `IfcSpace` and `IfcOpeningElement` geometry by default, count them, and expose spaces later as a toggle.
6. **Transform:** `sourceToModel` = the coordination matrix (already Y-up, metres) composed with the Z-up→Y-up rotation that web-ifc applied. Write it explicitly and test it against known points. Don't apply a second axis rotation.
7. **Coverage:** products with a representation but no triangles count under `unsupported_entity` (type in the sample).

## Mapping

| IFC                                    | Native                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `GlobalId`                             | `sourceId`                                                               |
| ExpressID                              | `localId`, never persisted outside one GLB                               |
| `IfcBuildingStorey`                    | `levels[]`, `levelId`                                                    |
| `IfcPresentationLayerAssignment`       | `layers[]`, `layerId`                                                    |
| `IfcStyledItem` / surface style colour | `Rgba` material (as today)                                               |
| Property sets (`IfcPropertySet`)       | Not in v1. Later as a lazily fetched artifact, because they can be large |
| `IfcMapConversion`                     | `ghost.georeference`                                                     |

## Ghost reference fields

`formatVersion` = schema. `authoring` = `IfcApplication`. `document.createdAt` = header timestamp. `units` from `IfcUnitAssignment`. `georeference` as above. `sourceIdsHash` = hash of the sorted GlobalIds, which makes IFC revision matching reliable (GlobalIds survive most re-exports from the same authoring tool).

## Tests

- Existing tests stay green.
- Fixtures: IFC2X3 and IFC4 samples from the buildingSMART sample files, in millimetres and in feet, one with `IfcMapConversion`, and one with storeys and layers.
- After packing, every `_BATCHID` resolves to a feature with a valid 22-character GlobalId, and storeys match the spatial tree.
- Known-point test: a product placed at a known source coordinate lands at `sourceToModel × point`.

## Instructions for users

Export IFC from the authoring tool:

- **Revit:** File → Export → IFC. Use IFC4 Reference View or IFC2x3 Coordination View 2.0, and keep "Export base quantities" off for smaller files.
- **Archicad:** File → Save As → IFC. Use a translator such as "General translator".
- **Vectorworks:** File → Export → Export IFC Project.
- **Tekla, Allplan, BricsCAD BIM, FreeCAD and Blender (BlenderBIM/Bonsai):** use the native IFC export.

Large IFC files: split by storey or discipline in the authoring tool before exporting.
