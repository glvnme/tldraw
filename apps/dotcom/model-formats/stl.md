# STL

|                  |                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Implemented (`model-converter/src/stl.ts`)                                                                                                      |
| Extensions       | `.stl`                                                                                                                                          |
| Magic            | Binary: 80-byte header, then a uint32 triangle count, with file length = 84 + 50 × count. ASCII: starts with `solid` and the length check fails |
| Reader           | Our own TypeScript (`parseStl`)                                                                                                                 |
| Source format id | `'stl'`                                                                                                                                         |

## The format, briefly

Triangle soup: one normal plus three vertices per triangle, in ASCII or binary. It has no units, no colours (except non-standard binary colour bits), no names (binary) or one name (`solid name` in ASCII), and no object structure.

## Dependency and licence

None.

## Current behaviour

- `isBinaryStl`: binary when the size matches 84 + 50n, even if the header starts with `solid` (many exporters write that). Otherwise ASCII if it starts with `solid`.
- Positions only. Normals are recomputed flat (`computeFlatNormals`), and indices are sequential (gltfpack welds vertices).
- Units: assumed millimetres (scale 0.001). Axes: assumed Z-up, rotated to Y-up. Material: grey 0.7.

## Conversion steps (v2 changes)

1. Keep the parser.
2. ASCII files with several `solid … endsolid` blocks: one feature per block, `name` = the solid name. Otherwise one feature for the file.
3. Mark units `basis: 'assumed'` with a `units_assumed` warning (today it's silent), and let the user pick the unit (mm, cm, m, in, ft).
4. Recentre on bounds. Today the STL path has a zero `recentreOffset`, so far-from-origin STLs lose precision.
5. Optional: binary colour bits (VisCAM/SolidView convention, bit 15 flag) become materials. Low priority.

## Tests

Existing `stl.test.ts`, plus multi-solid ASCII, a binary file whose header starts with `solid`, a truncated binary file, and unit overrides.

## Instructions for users

Prefer GLB, 3MF or 3DM, which keep units, colours and object names. If you export STL, use millimetres (Weave's default assumption), binary, one file per model.
