# Model format conversion plan

Status: 3DM service conversion implemented, 2026-11-03. Builds on the prototype in `apps/dotcom/model-converter` and the contracts in `packages/dotcom-shared/src/model3d`. The target format is specified in [native-format.md](native-format.md), each source format has its own spec (index in [README.md](README.md)), and the research behind the choices is in [research.md](research.md).

## Current implementation

The 3DM service path is implemented in `model-converter/src/threedm.ts` and `rhinoMesher.ts`. It is connected to the upload picker, job parser, CLI, GLB writer, manifest validator, and source cleanup queue. See [3dm.md](3dm.md) for use and limits.

Stages 3A and the flat/untrimmed subset of 3B are implemented. Stage 3C stores a ghost reference in manifest v2 and deletes the staged source after a terminal result. It uses the existing model row and queue. A retry selects a file and creates a new model. Database lineage, duplicate matching, client-side source hashing, per-attempt upload keys, and the browser path remain planned. Curved grid boundaries still need shared-edge snapping.

The sections below retain the full design for later work. They are not a statement that every stage is complete.

## Decisions

1. **The native format stays as it is.** One meshopt GLB per model version (Y-up, metres, recentred, `gltfpack -cc -mm`) plus `manifest.json`. Every source format converts into the in-memory `GlbScene` that `writeGlb` already takes, so gltfpack, `summarizeGltf` and the viewer don't change.
2. **We store only the converted model, plus a ghost reference to the original.** The original's bytes are never kept after conversion. The ghost reference lives in manifest v2 (`source`), and the few fields needed for lookup live in database columns.
3. **Source object identity goes inside the GLB.** Each displayed object gets a dense integer `_BATCHID`. The object and layer table goes in `asset.extras.weave`. Astra's spike showed that node names and node `extras` don't survive `-mm`, even with `-ke`, while `asset.extras` and `_BATCHID` do.
4. **3DM is first.** It reads through `rhino3dm` and gets our own fallback mesher for Breps that have no cached render mesh.
5. **Dependency order:** our own TypeScript first, then a single permissive WASM or JS library, then a native binary in the converter image. Hosted services aren't used.

## The ghost reference

```ts
interface GhostReference {
	filename: string
	bytes: number
	sha256: string // of the original bytes, hashed by whoever saw them
	format: Model3dSourceFormat
	formatVersion?: string // 3DM archive version, IFC schema, DWG release
	fileLastModifiedMs?: number
	authoring?: { application: string; version?: string } // "Rhinoceros 8", build string
	document?: { revision?: string; createdAt?: string; modifiedAt?: string; createdBy?: string }
	units: { name: string; metresPerUnit: number | null; basis: 'file' | 'user' | 'assumed' }
	basePoint?: [number, number, number]
	georeference?: {
		latitude: number
		longitude: number
		elevation: number
		north?: [number, number]
	}
	counts: { objects: number; rendered: number; skipped: number; layers: number; blocks: number }
	sourceIdsHash?: string // hash of the sorted source object IDs, for revision matching
	provenance: 'service' | 'browser'
}
```

Database columns on `model`: `sourceSha256`, `sourceState` (`staged | delete_pending | deleted | never_uploaded`), `lineageId`, `parentModelId`, `revisionNumber`. A new revision of a model gets a new immutable row. It never overwrites the old one, because old comments and camera views point at the old geometry.

Matching a re-upload:

1. Same SHA-256 and size: the same file. Reuse the ready model if the converter settings also match.
2. Different hash: treat it as a new revision only when the user picks "new revision of…". Filename, Rhino `revision`, and overlap in source object IDs (Rhino UUID, IFC GlobalId) only rank the suggestions.
3. Comments move to the new revision only when their source object ID still exists. Otherwise they stay on the old revision, marked unmatched.

Without the source, a failed conversion can't be retried from storage. Retry asks the user to pick the file again, then checks its hash against the ghost reference.

## 3DM, in stages

### Evidence

| Check                                         | Result                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rhino3dm` 8.35.0 on 13 public files (Sonnet) | Valid GLB in 0.17 to 0.62 s, peak RSS 164 MB. Names, layers, user strings, blocks and `_BATCHID` survive `-cc -mm`. SubD meshes from its control net.                                                                                                                                                |
| Files without cached render meshes            | 3 of 11 real files gave zero triangles. One kept 1 of 8 solids, which the current `triangleCount === 0` check would accept.                                                                                                                                                                          |
| Brep meshing in open source                   | Unavailable. `rhino3dm` has none and McNeel says it won't add any. `ON_Brep::CreateMesh` has no public definition in openNURBS.                                                                                                                                                                      |
| `rhino3dm` `Surface.isPlanar()` (new)         | **Unreliable.** It returned true for all 97 teapot faces and every curved face of the Rhino logo. A sampled flatness test found 6 and 6 flat faces. Don't use it.                                                                                                                                    |
| Our own fallback mesher, coverage spike (new) | Classified every face that has no cached mesh as flat, curved but untrimmed, or curved and trimmed. Flat and untrimmed faces are recoverable: 100% of uncached faces in 9 of 11 such files, 92% in `v5_example_file`, 69% in `v5_teapot`. Script: `/tmp/weave-3d-formats/opus/scripts/coverage.mjs`. |

So "no render meshes" isn't a dead end for architectural files. Walls, slabs, extrusions and box massing are flat or untrimmed faces. Only trimmed curved faces stay out of reach without a real mesher.

### Stage 3A: reader on cached meshes (about 1 week)

- Add `'3dm'` to `Model3dSourceFormat`, `MODEL3D_SOURCE_FORMATS`, the converter's `job.ts` allowlist and the CLI. Detect the format by its magic bytes (`3D Geometry File Format `), not only by extension.
- Add `rhino3dm` (pinned to exactly 8.35.0) to `model-converter`. New file `src/threedm.ts`: `threedmToScene(bytes, limits) → { scene, features, ghost, coverage, transform }`, which mirrors `ifc.ts`. Sonnet's `/tmp/weave-3d-formats/sonnet/scripts/convert.mjs` is a working draft of it.
- Read Mesh objects directly, cached meshes per Brep face, cached meshes for Extrusions, and SubD via its control net. Bake block instances with composed transforms. Flip winding for mirrored instances.
- Resolve colour in this order: object, layer, parent layer, material, then grey. Skip hidden layers and hidden objects, and count them.
- Convert units to metres, with `None` treated as millimetres and `basis: 'assumed'`. Rotate Z-up to Y-up, and recentre in double precision before casting to float32.
- Coverage check: if no solid has a mesh, fail with a new `no_render_meshes` error. If only some do, convert what exists and write `warnings` and `coverage` into the manifest. 3B removes most of these failures.
- Run in the existing child process with its kill timer. Abort early at `maxTriangles`, because baked blocks multiply triangles.
- Tests: the public corpus (`mcneel/opennurbs/example_files`, `mcneel/rhino3dm/tests/models`, three.js `examples/models/3dm`) plus the owner's real files. Assert triangle counts, coverage, and that every `_BATCHID` resolves to a feature after packing.

### Stage 3B: our own fallback mesher (1 to 2 weeks)

For Brep faces with no cached mesh:

- **Flat faces.** Sample each Brep edge once, by edge index, so neighbouring faces share points and don't crack. Build the outer and inner loops from the trims, project them onto the face plane, then triangulate with earcut. Use our own flatness test, never `isPlanar()`.
- **Untrimmed curved faces.** Sample the surface on a grid sized by its span count and curvature (`Surface.pointAt` and `normalAt`). Snap the boundary rows to the shared edge samples.
- **Trimmed curved faces.** Skip and count them, as in 3A. A later stage could add them: invert the 3D edge samples to UV with Newton iteration on the surface, triangulate in UV with the trim loops as constraints, then map back. That's roughly 2 to 3 weeks, and only worth it if real files need it.
- Record `meshedBy: 'rhino' | 'weave'` per feature, so the viewer can show "approximate mesh" if needed.
- earcut is one ISC-licensed file (about 700 lines). Copy it into `src/vendor/earcut.ts` with its licence header kept, which meets its only condition. No new npm dependency.

### Stage 3C: ghost reference and source deletion (about 1 week)

- Manifest v2: `source: GhostReference`, `transform.sourceToModel` (a column-major 4×4 matrix replacing the unclear `recentreOffset`), `coverage`, `warnings`, `features: { count, attribute: '_BATCHID', storage: 'glb-asset-extras' }`, structured converter versions, and the GLB's own SHA-256. Keep reading v1.
- The converter hashes the source it fetched and checks it against the size and hash the client declared, before parsing.
- Source key per attempt: `m/{modelId}/source/{attemptId}`. `getModelSource` checks the current attempt, not just the token.
- On `ready`: commit the result and set `sourceState = delete_pending` in the same transaction, then delete. Retry deletion from a sweep. On a terminal failure: delete straight away and return `source_required` on retry.
- Client: on `source_required`, ask the user to pick the file again and verify its hash.

### Stage 3D: conversion in the browser (1 to 2 weeks, optional)

- Run the same reader, `writeGlb` and gltfpack in a dedicated Web Worker, so the original never leaves the machine. Upload only the GLB and manifest, through a new `converted` create mode. Astra checked gltfpack 1.3.0's explicit `init()` path outside Node. Check it in Chromium and Vite before relying on it.
- The server treats the uploaded GLB as untrusted: it checks the chunk structure, that there are no external URIs, that the feature table is consistent, and that the hash matches. `provenance: 'browser'`.
- Start with a 64 MiB source limit in the browser and fall back to the service above it. Tune that number on the owner's machine.
- This stage needs the reader split into a portable core (no `node:` imports) and a Node host.

### Later, optional: our own 3DM reader instead of `rhino3dm`

Reading cached meshes plus Brep topology from the archive is about 2,500 to 3,500 lines and 3 to 5 weeks. Sonnet's estimate is grounded: a 60-line walker already matched `rhino3dm`'s object counts on Rhino 4, 6 and 8 files. Terra and Astra estimated "tens of thousands of lines", but for a full reader, not this subset. Doing it would remove a 1 MB gzipped WASM file and no capability gaps. Defer it. If it's ever done, use `rhino3dm` as the test oracle and openNURBS as a reference only, without copying its code.

## Other formats

| Order | Format                                  | Path                                                                                                                                                                                           | Runtime      | Licence (obligation)                                                   | Effort            |
| ----- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------- | ----------------- |
| 2     | IFC                                     | Keep web-ifc 0.0.78. Add GlobalId, name, type and storey to the feature table, and use dense `_BATCHID` instead of ExpressID.                                                                  | WASM         | MPL-2.0 (unmodified: keep its notice)                                  | 1 to 2 weeks      |
| 3     | DXF                                     | Own TS reader: group codes, LAYER and BLOCK tables, INSERT (nested), 3DFACE, POLYFACE and polygon mesh, MESH, and extruded 2D with thickness. Count 3DSOLID, BODY and REGION as skipped.       | TS           | none                                                                   | 2 to 4 weeks      |
| 4     | DWG                                     | LibreDWG `dwg2dxf` as a native binary in the converter image, feeding the DXF reader. ACIS solids are skipped with a warning that suggests exporting from the CAD app as DXF mesh, 3DM or IFC. | native       | GPL-3.0 (server only, unmodified, not distributed: nothing to release) | 1 week after DXF  |
| 5     | SKP                                     | Spike OpenSKP 1.4.0 (TS, reverse-engineered) on real files. If it holds up, it becomes the reader. Otherwise users export GLB from SketchUp (File, Export, 3D Model, glTF binary).             | TS           | MIT (keep notice)                                                      | spike 2 to 3 days |
| 6     | STEP / IGES                             | occt-import-js 0.0.23, server side.                                                                                                                                                            | WASM, 7.6 MB | LGPL-2.1 (unmodified: notice plus a link to its source)                | 1 week            |
| 7     | 3MF, PLY                                | Own TS. 3MF unzips with `node:zlib` `inflateRawSync` or the browser's `DecompressionStream('deflate-raw')`, so no zip library is needed.                                                       | TS           | none                                                                   | under 1 week each |
| 8     | FBX                                     | ufbx (one C file) compiled to WASM by us.                                                                                                                                                      | WASM         | public domain option (no notice)                                       | 1 to 2 weeks      |
| 9     | glTF with separate files                | Accept a `.gltf` plus its `.bin` and textures as one multi-file drop, and feed them to gltfpack's `read` callback.                                                                             | TS           | none                                                                   | days              |
| —     | RVT                                     | Later: spike rvt-rs (Rust, Apache-2.0, five weeks old, its claims untested). For now, export IFC.                                                                                              | native       | Apache-2.0 (notice)                                                    | spike only        |
| —     | NWD/NWC, PLN, VWX, MAX, C4D, BLEND, USD | Ask for an IFC or GLB export. No direct reader.                                                                                                                                                | —            | —                                                                      | —                 |

Rejected: Blender in the converter image (hundreds of MB, GPL), assimp and assimpjs (the WASM build is from 2023, and per-format readers are smaller), ODA SDKs and File Converter (proprietary, terms not public), Autodesk APS and Rhino Compute (hosted, and they would receive the original file).

## Licence and attribution

The converter runs as a service and isn't distributed, so only the browser path (3D) ships third-party code. Keep one `THIRD_PARTY_NOTICES.md` in `model-converter`, and bundle it with the client once 3D ships.

| Code                       | Licence                                                        | What we do                                               |
| -------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| rhino3dm                   | MIT                                                            | Keep the McNeel copyright and MIT text in the notices.   |
| gltfpack / meshoptimizer   | MIT                                                            | Same (already a dependency).                             |
| web-ifc                    | MPL-2.0                                                        | Notice. Only matters if we edit its files.               |
| earcut (vendored)          | ISC                                                            | Keep the header in the vendored file.                    |
| OpenSKP                    | MIT                                                            | Notice, if adopted.                                      |
| ufbx                       | MIT or public domain                                           | Choose public domain, so no notice is needed.            |
| occt-import-js             | LGPL-2.1                                                       | Notice and a source link. Server only by default.        |
| LibreDWG                   | GPL-3.0                                                        | Server-side process only, never in the browser bundle.   |
| openNURBS                  | McNeel custom text (Haiku found the repo and website disagree) | Don't copy its code. Read it as a format reference only. |
| Own readers and the mesher | ours                                                           | none                                                     |

## Corrections to the research

- "A Brep with no cached mesh is lost" (all four reports) is too pessimistic. A fallback mesher of our own recovers flat and untrimmed faces (see the spike above).
- `Surface.isPlanar()` in `rhino3dm` 8.35.0 can't be trusted. None of the reports caught this.
- Haiku's ".gltf with external buffers fails today" describes a missing format, not a bug: `.gltf` isn't an accepted input.
- Sonnet's separate `objects.json` and Astra's `asset.extras.weave` are the same idea. The plan uses `asset.extras.weave`, which keeps the existing two-artifact API. Split it into its own artifact only if measured size requires it.
- The estimates for writing our own 3DM reader varied about tenfold. They agree once the scope is fixed to cached meshes plus Brep topology.

## Owner decisions

1. **Real 3DM files.** Three to five from your own work: one large, one with blocks, one saved small if you have one. They are the main test corpus for 3A and 3B.
2. **Where 3DM converts in v1.** Recommended: on the server, deleting the original after conversion (3A to 3C), then the browser in 3D. Or the browser first, so the original never leaves the machine from day one.
3. **Source retention after a failure.** Recommended: delete at once and ask for the file again. Or keep it for a short window, for example 24 hours, so retry works without picking the file again.
4. **LibreDWG on the server** for DWG (GPL, server only). Yes or no.

## Timeline

| Week   | Work                                                                     |
| ------ | ------------------------------------------------------------------------ |
| 1      | 3A (`rhino3dm` reader, coverage check, corpus tests)                     |
| 2 to 3 | 3B (fallback mesher), 3C (manifest v2, ghost reference, source deletion) |
| 4      | IFC feature table; 3D browser worker if wanted                           |
| 5 to 8 | DXF, then DWG through LibreDWG; OpenSKP spike; STEP; 3MF and PLY         |
