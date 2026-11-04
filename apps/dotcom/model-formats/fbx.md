# FBX

|                  |                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Status           | Planned (order 8)                                                                             |
| Extensions       | `.fbx`                                                                                        |
| Magic            | Binary: `Kaydara FBX Binary  \0` (23 bytes) plus a uint32 version. ASCII: starts with `; FBX` |
| Reader           | ufbx (single C file) compiled to WASM by us                                                   |
| Source format id | `'fbx'`                                                                                       |

## The format, briefly

Autodesk's interchange format for DCC tools (3ds Max, Maya, Cinema 4D, Navisworks export, Revit through 3ds Max, Twinmotion). A node tree of objects with properties and connections, in binary (most files) or ASCII. Meshes are polygons with layered attributes (normals, UVs, colours, material indices). It carries units (`UnitScaleFactor` in centimetres) and an axis system (`UpAxis`, `FrontAxis`, `CoordAxis`). The official FBX SDK is closed and proprietary, and there's no public spec.

## Options considered

| Option                                    | Verdict                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **ufbx** 0.23.1 (C, MIT or public domain) | **Chosen.** A single `ufbx.c`/`ufbx.h` pair, robust against malformed files, with helpers to triangulate and normalise units and axes |
| Autodesk FBX SDK, FBX2glTF                | Rejected: proprietary SDK                                                                                                             |
| assimp / assimpjs                         | Rejected: assimpjs is from 2023, and assimp is a large build for one format                                                           |
| three.js `FBXLoader`                      | Possible browser path, but it needs three in the converter. Rejected for the service                                                  |
| Our own binary FBX reader                 | 10k+ lines and versioned. Rejected                                                                                                    |

## Dependency and licence

| Code                                                                                                                                                                            | Licence                                         | Obligation |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------- |
| ufbx 0.23.1, vendored in `model-converter/native/ufbx/`                                                                                                                         | Choose the **public domain** option (Unlicense) | None       |
| Our build: Emscripten or `clang --target=wasm32-wasi` producing `ufbx.wasm` (about 300 to 600 KB, unverified) plus a small C shim exposing `load(bytes) → JSON + typed buffers` | ours                                            | none       |

Build it in CI from the vendored source, then commit the `.wasm` and its build script so the converter needs no toolchain at run time.

## Conversion steps

1. `ufbx_load_memory` with `target_axes = ufbx_axes_right_handed_y_up`, `target_unit_meters = 1`, `space_conversion = UFBX_SPACE_CONVERSION_TRANSFORM_ROOT` (or `MODIFY_GEOMETRY`), `generate_missing_normals = true`, and `ignore_animation = true`.
2. For each `ufbx_node` with a mesh, for each material part: `ufbx_triangulate_face` into indices, then read `vertex_position` and `vertex_normal` at the triangulated corners. Apply `node->geometry_to_world` in double precision.
3. Instances: ufbx exposes shared meshes across nodes. Bake them (same rule as all formats).
4. Material colour: `material->pbr.base_color` (or `fbx.diffuse_color`) → `Rgba`. Textures give `material_approximated`.
5. Identity: `sourceId` = node `element_id` plus name (`file-local`). FBX has no stable IDs across exports. `name` = node name, and `instancePath` = the node chain.
6. Units and axes come from the scene settings. The ghost reference records `UnitScaleFactor` and `OriginalUpAxis`, `basis: 'file'`.
7. Skip lights, cameras, bones and NURBS (count them). Skinned meshes use the bind pose.

The ghost reference takes `formatVersion` = the FBX version (for example 7400) and `authoring` = `ufbx_scene.metadata.creator`.

## Estimate

1 to 2 weeks, including the WASM build.

## Tests

Fixtures from the ufbx test data: binary 7.4 and 7.7, ASCII, cm and m units, Z-up (3ds Max), instanced meshes, multi-material meshes, and a malformed file.

## Instructions for users

- **3ds Max, Maya, Cinema 4D:** File → Export → FBX, with "Embed media" off and units set to metres or centimetres. GLB export, where available, is preferred.
- **Navisworks:** Output → Export Scene → FBX.
- **Twinmotion and Unreal:** export GLB or FBX of static meshes.
