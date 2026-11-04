# OBJ

|                  |                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Status           | Implemented (gltfpack reads it). Planned: groups as features, optional MTL                       |
| Extensions       | `.obj`, optional `.mtl`                                                                          |
| Magic            | None. Text lines starting with `v `, `vn `, `vt `, `f `, `o `, `g `, `usemtl `, `mtllib ` or `#` |
| Reader           | gltfpack today; our own small reader planned                                                     |
| Source format id | `'obj'`                                                                                          |

## The format, briefly

Wavefront OBJ: plain text vertices and polygon faces (1-based indices, negative indices are relative), optional object (`o`) and group (`g`) names, and materials in a separate `.mtl` file. It has no units, no axis convention (most tools write Y-up; some CAD tools write Z-up), and no instancing.

## Dependency and licence

gltfpack (MIT, existing). The planned reader is our own code (about 400 lines).

## Current behaviour (`pipeline.ts`, case `'obj'`)

gltfpack reads `in.obj` directly. The `mtllib` file isn't available (only the input is in gltfpack's read map), so materials fall back to defaults. Transform: identity, Y-up, units `'unknown'`. There's no recentring and no `_BATCHID`.

## Conversion steps (v2)

Replace the direct gltfpack path with our own reader, so OBJ gets identity and recentring:

1. Stream lines: `v` (with optional per-vertex RGB after xyz, a common extension), `vn`, `f` (forms `v`, `v/vt`, `v//vn`, `v/vt/vn`, with negative indices), `o`, `g`, `usemtl`, `mtllib`. Ignore `vt`, `s`, `l`, `p` and curves (counted).
2. Each `o`, or `g` when there is no `o`, starts a feature. `sourceId` = `file-local` name (with an occurrence suffix if repeated), `name` = the name.
3. Fan-triangulate faces. Use `vn` normals if present, otherwise compute flat normals.
4. Materials: with a multi-file drop, read `.mtl` `Kd` (diffuse) and `d`/`Tr` (opacity) for each `newmtl`. Otherwise use grey and a `material_approximated` warning.
5. Units: unknown. Default to metres with `units_assumed`, and let the user pick (mm, cm, m, in, ft) at upload or afterwards (a re-convert under the same lineage).
6. Axes: default Y-up. Let the user switch to Z-up.
7. Recentre and write `sourceToModel` as for every format.

The ghost reference takes `authoring` from leading `#` comments that name a tool (for example `# Rhino`, `# Blender v4.2`).

## Tests

Faces in all four index forms; negative indices; `o` and `g` splitting; quads and n-gons; a missing `.mtl`; unit and axis overrides change `settingsHash`.

## Instructions for users

Prefer GLB, which carries units and materials. If you export OBJ: set units to metres, Y-up, include the `.mtl`, and drop both files together.
