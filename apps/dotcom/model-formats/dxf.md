# DXF

|                  |                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Status           | Planned (order 3). Also the back end for [DWG](dwg.md)                                                      |
| Extensions       | `.dxf`                                                                                                      |
| Magic            | ASCII: group code `0` / `SECTION` within the first lines. Binary: `AutoCAD Binary DXF\r\n\x1a\0` (22 bytes) |
| Reader           | Our own TypeScript (`src/dxf/`)                                                                             |
| Source format id | `'dxf'`                                                                                                     |

## The format, briefly

Autodesk publishes the DXF reference, so the format is public. A DXF file is a flat stream of `(group code, value)` pairs in sections: `HEADER` (variables such as `$INSUNITS`, `$ACADVER`, `$EXTMIN`/`$EXTMAX`), `CLASSES`, `TABLES` (`LAYER`, `LTYPE`, `BLOCK_RECORD`, ...), `BLOCKS` (block definitions), `ENTITIES` (model space and paper space), and `OBJECTS`. Every entity has a handle (code 5), a layer (8), a colour (62 ACI or 420 true colour), an extrusion direction (210/220/230) and an owner.

Most architectural DXF is 2D. 3D content can be:

| Entity                                                                               | 3D?                                                                           | Our handling                                                                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `3DFACE`                                                                             | Triangle or quad                                                              | Mesh directly                                                                                                    |
| `POLYLINE`, polyface mesh (flag 64)                                                  | Vertices plus faces                                                           | Mesh directly                                                                                                    |
| `POLYLINE`, polygon mesh (flag 16)                                                   | M×N grid                                                                      | Mesh directly                                                                                                    |
| `MESH` (AutoCAD 2010+)                                                               | Subdivision mesh, level 0 cage                                                | Mesh the cage; subdivision is optional, later                                                                    |
| `LINE`, `LWPOLYLINE`, `CIRCLE`, `ARC` with nonzero thickness (code 39)               | Extruded surface                                                              | Extrude along the extrusion direction into walls; closed polylines get no caps (thickness doesn't imply a solid) |
| `SOLID` / `TRACE` with thickness                                                     | Extruded quad prism                                                           | Extrude                                                                                                          |
| `INSERT`                                                                             | Block reference: position, scale, rotation, extrusion, and a column/row array | Expand the block, compose transforms                                                                             |
| `3DSOLID`, `BODY`, `REGION`, `SURFACE`                                               | ACIS SAT/SAB data                                                             | **Not supported**: count under `unsupported_entity`                                                              |
| `HATCH`, `TEXT`, `MTEXT`, `DIMENSION`, `LEADER`, `POINT`, `SPLINE` without thickness | 2D annotation                                                                 | Skip and count (`skipped_annotation`)                                                                            |
| `ACAD_PROXY_ENTITY`                                                                  | Proxy graphics                                                                | Not supported; count                                                                                             |
| `XREF` blocks                                                                        | External file                                                                 | `external_reference_missing`                                                                                     |

## Dependency and licence

None: our own code. `dxf-parser` (MIT, last release 2021) and `@tarikjabiri/dxf` (MIT) were considered. Both parse entities but leave meshing, block expansion and colour inheritance to us, which is most of the work. They're useful only as cross-check oracles in tests.

## Conversion steps

1. **Tokenise.** ASCII: read lines in pairs, trim the code, and decode values by code range (strings 0–9, doubles 10–59, ints 60–99, ...). Detect the encoding from `$DWGCODEPAGE` (pre-2007 files are often `ANSI_1252`), otherwise UTF-8. Binary DXF: 1-byte codes (2 bytes from R14), typed values. Binary support comes in a second step; most files are ASCII.
2. **HEADER:** `$INSUNITS` → unit (table below; `0` means unitless, so assume millimetres and warn `units_assumed`). `$ACADVER` → `formatVersion`.
3. **TABLES:** `LAYER` gives name, colour (negative ACI means off), and frozen flag (code 70 bit 1). A layer is hidden if it's off or frozen.
4. **BLOCKS:** collect each block's base point and entities. Skip `*Paper_Space*` blocks.
5. **ENTITIES:** model space only (code 67 ≠ 1). For each entity, `emit(entity, transform, instancePath)`:
   - Apply the Arbitrary Axis Algorithm for entities with OCS coordinates (`LWPOLYLINE`, `CIRCLE`, `ARC`, `INSERT`, `SOLID`, ...) when the extrusion direction isn't `(0, 0, 1)`.
   - `INSERT`: transform = translate(insertion) × rotate Z(rotation) × scale(x, y, z) × translate(-basePoint), repeated over the column and row array. Recurse with a depth limit of 16. A negative determinant flips winding.
   - Colour: ACI 256 = BYLAYER, 0 = BYBLOCK (inherit from the insert), otherwise the ACI palette or the 420 true colour.
   - Layer `0` inside a block inherits the insert's layer.
6. **Triangulate:** quads split along the shorter diagonal. Polyface faces with negative vertex indices (invisible edges) are still faces. Arcs and circles with thickness are tessellated at 64 segments per full circle.
7. **Identity:** `sourceId` = entity handle (`dwg-handle` kind; DXF from DWG keeps DWG handles). Block members get `definitionId` = block name and `instancePath` = the insert handles.
8. **Transform:** Z-up, unit from `$INSUNITS`. Recentre on the bounds of emitted geometry, not `$EXTMIN`/`$EXTMAX` (often stale).
9. **Coverage:** if no entity produced triangles, throw `no_geometry` with "This drawing has no 3D geometry Weave can show" and a count of what it held (for example "4,210 lines, 37 ACIS solids").

### Units (`$INSUNITS`)

| Code | Unit        | m              |     | Code | Unit        | m      |
| ---- | ----------- | -------------- | --- | ---- | ----------- | ------ |
| 0    | Unitless    | 0.001, assumed |     | 5    | Centimetres | 0.01   |
| 1    | Inches      | 0.0254         |     | 6    | Metres      | 1      |
| 2    | Feet        | 0.3048         |     | 7    | Kilometres  | 1000   |
| 3    | Miles       | 1609.344       |     | 10   | Yards       | 0.9144 |
| 4    | Millimetres | 0.001          |     | 14   | Decimetres  | 0.1    |

## Ghost reference fields

`formatVersion` = `$ACADVER` (for example `AC1032` = AutoCAD 2018). `document.modifiedAt` = `$TDUPDATE` (Julian date). `counts.layers`, `counts.definitions` = blocks. `sourceIdsHash` = hash of sorted handles.

## Estimate

1,500 to 4,000 lines and 2 to 4 weeks for ASCII with blocks, meshes and thickness. Binary DXF, more code pages, and malformed-input hardening add 1 to 3 weeks.

## Tests

- Fixtures: a single `3DFACE`; a polyface mesh; a polygon mesh; a `LWPOLYLINE` with thickness and a non-default extrusion; nested `INSERT` with a mirror and an array; BYBLOCK and BYLAYER colours; a frozen layer; a file with only `3DSOLID` (expects `no_geometry` with an ACIS count); a 2D floor plan (expects `no_geometry`).
- Cross-check entity counts against `dxf-parser` on public samples (its `samples/data`).

## Instructions for users

For 3D DXF from AutoCAD:

1. Solids (`3DSOLID`) can't be read. Convert them to meshes first with `CONVTOMESH` (choose smooth or faceted), or export them in a mesh format (`STLOUT` for single solids).
2. `SAVEAS` → DXF, in AutoCAD 2018 DXF or an earlier version.
3. Bind xrefs first (`XREF` → Bind), because external files aren't uploaded with the drawing.

From SketchUp, Rhino or Revit, prefer their GLB, 3DM or IFC exports over DXF.
