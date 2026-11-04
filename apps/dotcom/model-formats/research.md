# Format conversion research record

How the decisions in [plan.md](plan.md) and the format specs were reached. Date: 2026-11-03.

## Method

Four discovery agents, all at high reasoning effort, worked from one shared brief: convert every major architecture and design format into the native GLB plus manifest, with 3DM first, as native as possible with the fewest dependencies, a one-line licence obligation per library, and a ghost reference instead of keeping originals.

| Agent         | Lane                                                                 | Spikes run                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sonnet 5.5    | 3DM in depth, other formats at survey depth                          | Converted 13 public `.3dm` files to GLB with `rhino3dm` and gltfpack; validated the output with the Khronos validator; wrote a 60-line archive walker; built synthetic block files |
| Haiku 5.5     | Breadth: every format, general-purpose tools                         | A `rhino3dm` sphere Brep round trip (no mesh); a DXF `3DFACE` through assimpjs                                                                                                     |
| GPT-6.1 Terra | DWG, DXF, SKP, STEP; B-rep kernels                                   | `dxf-parser` on a 2.7 MB public DXF (209 ms, 2D only)                                                                                                                              |
| GPT-6 Astra   | Pipeline architecture, ghost reference, browser vs service, metadata | gltfpack metadata survival across flag sets; gltfpack's non-Node `init()` path                                                                                                     |

A follow-up review checked the reports against each other and ran two more spikes (scripts in `/tmp/weave-3d-formats/opus/scripts/`).

The raw reports were in `/tmp/weave-3d-formats/reports/{sonnet,haiku,terra,astra}.md` (scratch storage). This file keeps what mattered.

## Findings everyone agreed on

- No single tool covers the set. assimp (BSD-3) is the only permissive multi-format reader, and it covers mesh formats only: not DWG, RVT, NWD, SKP, 3DM, PLN, VWX or MAX.
- `rhino3dm` (MIT, 2.67 MB WASM, no dependencies) is the right 3DM reader. It exposes meshes, cached Brep and Extrusion render meshes, SubD (via the control net), blocks, layers, materials, user strings, units, base point, earth anchor and document metadata.
- Neither `rhino3dm` nor openNURBS can mesh a Brep. McNeel says meshing won't be added to `rhino3dm`, and `ON_Brep::CreateMesh` has no public definition.
- DWG's 3D solids are ACIS data. Open readers (LibreDWG) are GPL and don't tessellate ACIS. Every other route is paid or hosted.
- RVT, NWD, PLN, VWX, MAX and C4D have no realistic open reader: ask for IFC or GLB exports.
- Blender in the converter image and hosted services (APS, Rhino Compute) don't fit the goals.

## Key measurements

| Measurement                                             | Result                                                                                           | Source           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------- |
| `rhino3dm` conversion speed                             | 0.17 to 0.62 s per file up to 9.7 MB, peak RSS 164 MB                                            | Sonnet           |
| Files with no cached meshes                             | 3 of 11 real samples gave zero triangles; 1 kept 1 of 8 solids                                   | Sonnet           |
| `_BATCHID` through `gltfpack -cc -mm`                   | Survives                                                                                         | Sonnet, Astra    |
| Node names and extras through `-cc -mm`, and with `-ke` | Lost. Kept only with `-kn -ke`, which blocks merging                                             | Astra            |
| `asset.extras` through all flag sets                    | Survives                                                                                         | Astra            |
| `rhino3dm` `Surface.isPlanar()`                         | Returns true for curved faces (97 of 97 teapot faces; a sampled test found 6 flat)               | follow-up review |
| Faces without cached meshes that are flat or untrimmed  | 100% in 9 of 11 such files, 92% and 69% in the other two                                         | follow-up review |
| gltfpack WASM                                           | 328 KB. Browser use needs an explicit `init()`, and it blocks the thread, so it goes in a worker | Astra            |

## Where the reports disagreed, and the resolution

| Topic                              | Positions                                                                                                                                              | Resolution                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Files without cached render meshes | All four: unrecoverable without Rhino; fail with export instructions                                                                                   | Partly wrong. Our own mesher recovers flat and untrimmed faces (3DM spec, fallback mesher)                           |
| Effort to write our own 3DM reader | Sonnet: 2.5 to 3.5k lines, 3 to 5 weeks (cached meshes only, with a working framing walker). Terra: 10 to 30k+ lines, months. Astra: tens of thousands | Sonnet's scope is the relevant one. It's deferred anyway, because it only removes a 1 MB gzipped WASM file           |
| Where object metadata lives        | Sonnet: a separate `objects.json`. Astra: `asset.extras.weave` in the GLB                                                                              | `asset.extras.weave`: keeps two artifacts and is verified to survive packing                                         |
| `.gltf` with external buffers      | Haiku: a bug in the current converter                                                                                                                  | A missing format, not a bug: `.gltf` isn't an accepted input. Planned as a multi-file drop                           |
| openNURBS licence                  | Haiku: the repo says "All Rights Reserved" with a zlib grant, while McNeel's site says no restrictions. Sonnet: a custom notice                        | Moot: we use `rhino3dm` (MIT) and read openNURBS only as a reference                                                 |
| GPL in the browser                 | Haiku: shipping `libredwg-web` would make the client GPL                                                                                               | Moot: LibreDWG runs as a server-side native process only                                                             |
| ODA File Converter                 | Terra: a conditional option                                                                                                                            | Rejected: its terms aren't published                                                                                 |
| DXF reader                         | Haiku: 600 to 900 lines. Terra: 1.5 to 4k lines, 2 to 5 weeks                                                                                          | Terra's range, because it includes blocks, the arbitrary axis algorithm, thickness, colour inheritance and hardening |

## Licence summary

| Code                                                                        | Licence              | Where it runs             | Obligation                                                         |
| --------------------------------------------------------------------------- | -------------------- | ------------------------- | ------------------------------------------------------------------ |
| gltfpack / meshoptimizer                                                    | MIT                  | service, browser          | notice                                                             |
| web-ifc                                                                     | MPL-2.0              | service, browser          | notice; publish changes to its files (none planned)                |
| rhino3dm                                                                    | MIT                  | service, browser          | notice                                                             |
| earcut (vendored)                                                           | ISC                  | service, browser          | keep the header                                                    |
| OpenSKP (if adopted)                                                        | MIT                  | service                   | notice                                                             |
| occt-import-js / OCCT                                                       | LGPL-2.1             | service                   | notice and a source link; the WASM is a separate, replaceable file |
| ufbx                                                                        | public domain option | service                   | none                                                               |
| LibreDWG `dwg2dxf`                                                          | GPL-3.0+             | service, separate process | none while not distributed                                         |
| rvt-rs (if a spike passes)                                                  | Apache-2.0           | service                   | notice                                                             |
| Our own readers (DXF, 3MF, PLY, OBJ, STL, DAE, 3DS) and the fallback mesher | ours                 | anywhere                  | none                                                               |

## Owner questions raised

1. Real `.3dm` files: three to five from actual projects.
2. Conversion location for v1: service first, deleting the source after conversion (recommended), or the browser first.
3. Source retention after a failed conversion: delete at once (recommended) or keep for a short window.
4. LibreDWG on the server for DWG.
