# 3DM (Rhino)

|                  |                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Status           | Implemented in the service. Browser conversion is deferred. See [plan.md](plan.md)                    |
| Extensions       | `.3dm`                                                                                                |
| Magic            | First 24 bytes: `3D Geometry File Format ` (with trailing space), then an 8-character archive version |
| Reader           | `rhino3dm` 8.35.0 (WASM) plus our own fallback mesher                                                 |
| Runtime          | Converter child process first; browser worker later (same code)                                       |
| Source format id | `'3dm'`                                                                                               |

## Implemented use

Drop a `.3dm` file on a board in a workspace, or select it with **Upload 3D**. The existing model service converts it. The viewer and saved camera views use the same native GLB path as other formats.

For local conversion, run this command from the repository root. Use absolute input and output paths:

```sh
pnpm --filter @tldraw/model-converter exec tsx src/cli.ts convert /path/site.3dm /path/site.glb
```

This writes `site.glb` and `site.manifest.json`. The CLI reads the local source file and leaves it in place.

The service deletes its staged source once the converter reports a result about the file: `ready`, or `failed` with an error that a retry cannot fix (for example `no_render_meshes`). After the terminal database update it deletes the source and sends a best-effort cleanup message, which the queue retries until R2 confirms the deletion. The queue checks the model and job IDs before it deletes anything. The source stays after `converter_unavailable`, an expired or abandoned job, and other retryable failures, so **Retry** converts it again. A retryable failure that is never retried keeps its source. Incomplete multipart uploads are outside this change.

When the source is gone, a failed 3DM import has **Select the file again**. This creates a new model row and replaces the failed model on that canvas shape, keeping its default view. It does not create a revision of the old model. The client does not claim that a selected file matches the old source hash.

The ghost reference is in manifest v2: safe filename, byte count, SHA-256, archive version, application, document facts, units, base point, optional earth location, and object counts. The GLB has its own hash. No new database columns are needed for this path. File deduplication and revision matching are deferred.

Current mesh fallback:

- Flat faces use shared adaptive edge samples and earcut. Holes are kept. Slit, curve-on-surface and point loops are not holes and are ignored. A triangulation whose area differs from the outer loop minus its holes by more than 0.1% counts the face as missing.
- Untrimmed curved faces use a surface grid. Its density per direction follows iso-curve sag against the model tolerance, capped at 0.2% of the face size and at 64 steps, so a ruled wall gets one row. The reader requires agreement between the trim boundary and all four surface boundaries before it uses this grid. Triangles that collapse at singular sides (sphere poles) are dropped.
- Curved grid boundaries are not snapped to adjacent face samples, so small cracks can show between adjacent curved faces. Gaps up to about 10 times the model tolerance were measured. These meshes have an approximation warning.
- Trimmed curved faces without a stored mesh are skipped and counted. Partial models have a visible warning. A model with no triangles fails with `no_render_meshes`.
- SubD uses a copy of the control net with three subdivisions. Source geometry is not changed. Each SubD counts as an approximate face.
- Only meshes, Breps, extrusions, SubDs and bare surfaces count toward coverage. Curves, points, text, hatches and clipping planes are ignored without a warning.
- Block members are meshed once per definition and copied per placement.
- Colours are converted from sRGB to linear for glTF. Alpha is at least 0.2, so fully transparent glass stays visible. A pure black layer colour (Rhino's default) shades grey.
- Textures and vertex colours are not converted.
- Limits for hostile files: at most 200,000 objects (`too_large`), 64 user strings per object (keys up to 256 characters, values up to 2,048), and 256 characters for names and document fields. The worker rejects a manifest with longer source fields or more than 16 warnings.
- A result with fewer than 12 triangles carries a `near_empty` warning.

The reader uses double-precision mesh vertices and transform components. It subtracts the origin before it writes float32 positions. Rhino's `toThreejsBuffers` and `Transform.toFloatArray` lose precision before this step and are not used.

## Implementation checks

The converter tests create real 3DM archives in memory. They cover mesh packing and feature IDs, units, hidden parent layers, uncached boxes, caps with holes, nested and mirrored blocks, precision far from the origin, empty input, and triangle limits. Model route tests cover manifest v2, source mismatch rejection, current-job tokens, source deletion, failed deletion, and delayed queue delivery.

A local run on 19 public samples converted 18 files, and all 18 GLBs pass the Khronos validator with no errors or warnings. Every `_BATCHID` resolves to a feature after packing. `v8_caps_and_joins.3dm` had no supported surfaces and returned `no_render_meshes`. The teapot and example-file samples reported missing faces. No file larger than 10 MB was checked. Large project files still need validation before production use.

### Fallback accuracy against Rhino's own meshes (2026-11-04)

The fallback mesher was run on faces that do have cached meshes, with Rhino's mesh as the reference. Orientation always agreed (area-weighted normal dot product at least 0.991), no face filled a trimmed-away area, and all 39 flat faces with holes kept them. Coverage is the limit:

| File            | Faces the fallback rejects | Share of surface area |
| --------------- | -------------------------- | --------------------- |
| `v4_RhinoPhone` | 183 of 370                 | 63%                   |
| `v6_rhino_logo` | 7 of 22                    | 89%                   |
| `v5_disk_brake` | 458 of 888                 | 16%                   |

These are trimmed curved faces. So a curved product-style model saved without render meshes loses most of its surface. Box, slab and extrusion massing converts fully. Meshing trimmed curved faces in UV (edge samples mapped through `closestPoint`, earcut plus interior points, then lifted to 3D) is the next mesher step if real files need it.

## The format, briefly

A chunked binary archive written by openNURBS. Tables: properties (including a preview bitmap, often most of the file), settings (units, tolerance, base point, earth anchor), bitmaps, materials, linetypes, layers, groups, fonts, dimension styles, lights, hatch patterns, **instance definitions**, **objects**, history, user data. Length fields are 4 bytes up to archive version 4 and 8 bytes from version 5.

There is no standalone spec. The openNURBS source (`opennurbs_3dm.h`, `opennurbs_archive.cpp`, `opennurbs_brep_io.cpp`, `opennurbs_mesh.cpp`) is the de facto reference.

Geometry that matters to us:

| Object                                                                   | What the file holds                                                               | How we get triangles                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Mesh`                                                                   | Triangles and quads                                                               | Read directly                                                  |
| `Brep` (polysurface)                                                     | NURBS surfaces, trims, edges, loops; **optionally** a cached render mesh per face | Cached mesh if present, otherwise our fallback mesher          |
| `Extrusion`                                                              | Profile and path; optionally a cached mesh                                        | Cached mesh, otherwise `toBrep(true)` then the fallback mesher |
| `SubD`                                                                   | Control net                                                                       | `subdivide(3)` then `Mesh.createFromSubDControlNet`            |
| `InstanceReference`                                                      | Definition id plus a 4×4 transform                                                | Expand the definition's objects, compose transforms            |
| `Surface` (untrimmed)                                                    | One NURBS surface                                                                 | Grid mesher                                                    |
| Curves, points, point clouds, text, dimensions, hatches, clipping planes | —                                                                                 | Skipped and counted (`skipped_annotation`)                     |

**Render meshes are a cache.** Rhino writes them when a viewport has been shaded or rendered, and `SaveSmall` strips them. Files written by scripts, Grasshopper bakes or other tools often have none. No open-source code can mesh a Brep the way Rhino does: `rhino3dm` has no mesher (McNeel: "will not be" added, forum, May 2025), and `ON_Brep::CreateMesh` has no public definition in openNURBS. Hence our fallback mesher.

## Dependency and licence

| Code                              | Licence                                                      | Obligation                                              | Size                                                                       |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `rhino3dm` 8.35.0, pinned exactly | MIT, © Robert McNeel & Associates                            | Copyright and MIT text in `THIRD_PARTY_NOTICES.md`      | `rhino3dm.wasm` 2.67 MB (1.03 MB gzip), JS 114 KB; no runtime dependencies |
| earcut 3.0.2, pinned package      | ISC, © Mapbox                                                | Keep the ISC text in `THIRD_PARTY_NOTICES.md`           | about 700 lines                                                            |
| openNURBS                         | McNeel custom text (repo `LICENSE` and the website disagree) | Don't copy its code. Read it only as a format reference | —                                                                          |

Typings drift in `rhino3dm`: `BrepFace.setMesh` is declared `(meshType, mesh)` but the binding takes `(mesh, meshType)`. `SubD.subdivide` and `Mesh.createFromSubDControlNet` take arguments the typings don't list. Wrap these calls in one module with local types.

## Reader design and remaining work

The steps below describe the full target. The implementation above defines current support. Shared boundary snapping, adaptive surface grids, and revision matching remain work for later.

`src/threedm.ts` exports `threedmToScene`. `pipeline.ts` loads this module only for 3DM jobs.

1. **Open.** `const rhino = await rhino3dm()` once per process. `File3dm.fromByteArray(bytes)`. If it returns null, throw `unsupported_format`.
2. **Document facts** (for the ghost reference and the transform):
   - `settings().modelUnitSystem` → metres per unit (table below). `None` → millimetres, `basis: 'assumed'`, warning `units_assumed`.
   - `settings().modelAbsoluteTolerance` → mesher chord tolerance.
   - `settings().modelBasePoint`, `settings().earthAnchorPoint` (unset when latitude equals the sentinel `-1.23432101234321e+308`).
   - `applicationName`, `applicationDetails`, `archiveVersion`, `createdBy`, `lastEditedBy`, `created`, `lastEdited`, `revision`.
3. **Tables.** Layers: `id`, `fullPath`, `color`, `visible`, `parentLayerId`, `renderMaterialIndex`. A layer is visible only if every ancestor is. Materials: `diffuseColor`, `transparency`, `name`. Instance definitions: `id`, `name`, `getObjectIds()`.
4. **Walk top-level objects**, skipping those with `attributes.isInstanceDefinitionObject` (they're reached through references). For each object, call `emit(object, transform = identity, instancePath = [])`:
   - Hidden object, or hidden layer: count `hidden_skipped` and stop.
   - `InstanceReference`: look up `parentIdefId`, compose `transform × xform` (`xform.toFloatArray(false)` is column-major), push the reference id onto `instancePath`, and recurse into the definition's objects. Guard against cycles and stop at depth 16 (`instance_depth_limit`).
   - `Mesh`: `toThreejsBuffers(false)` → positions, normals, indices (quads already split).
   - `Brep`: per face, `face.getMesh(MeshType.Any)`. Faces with no mesh go to the fallback mesher, which needs the whole Brep for shared edges.
   - `Extrusion`: `getMesh(MeshType.Any)`. If there is none, `toBrep(true)` and treat it as a Brep.
   - `SubD`: `subdivide(3)`, then `Mesh.createFromSubDControlNet(subd, false)`.
   - `Surface`: grid mesher.
   - Anything else: count by type (`skipped_annotation` or `unsupported_entity`).
5. **Per emitted occurrence:** assign the next `featureId`. Fill `batchIds` with it. Resolve the colour: object material (if `materialSource` is the object), layer material, parent layer, then `colorSource` (object colour, layer colour, parent), falling back to grey `[0.7, 0.7, 0.7, 1]`. Alpha is `1 - transparency`. Apply the composed transform in double precision; if its determinant is negative, flip triangle winding and negate normals.
6. **Feature record:** `sourceId` = object attribute `id` (UUID), `sourceIdKind: 'rhino-guid'`, `name`, `type` (`Brep`, `Extrusion`, `Mesh`, `SubD`), `layerId`, `definitionId` and `instancePath` for block members, `userStrings` from `getUserStrings()` (drop Rhino's internal `$block-instance-original-object-id$`), `meshedBy`.
7. **Transform.** Bounds of all emitted positions in source units, then origin = (centre X, centre Y, min Z). `sourceToModel` = Z-up→Y-up rotation × scale(metresPerUnit) × translate(-origin). Apply it in float64 and write float32.
8. **Coverage.** `sourceObjects` counts visible geometry objects. A Brep counts as rendered when at least one face produced triangles, and each face that didn't is counted under `missing_render_mesh`. If no object rendered, throw `no_render_meshes` with the user instructions below.
9. **Free WASM objects** (`.delete()`) as each object is done. The spike didn't, and peaked at 164 MB on files up to 9.7 MB. Large files need it.
10. Return the `ReadSceneResult`. The pipeline writes the GLB and runs gltfpack as for every format.

### Unit table

| `UnitSystem` | m per unit     |     | `UnitSystem` | m per unit                                      |
| ------------ | -------------- | --- | ------------ | ----------------------------------------------- |
| Millimeters  | 0.001          |     | Inches       | 0.0254                                          |
| Centimeters  | 0.01           |     | Feet         | 0.3048                                          |
| Meters       | 1              |     | Yards        | 0.9144                                          |
| Kilometers   | 1000           |     | Miles        | 1609.344                                        |
| Microns      | 1e-6           |     | Mils         | 2.54e-5                                         |
| None         | 0.001, assumed |     | CustomUnits  | `customUnitScale` if exposed, otherwise assumed |

## Fallback mesher

For Brep faces with no cached mesh (stage 3B). It lives in `src/mesher/` and is our own code.

### Classify each face

Never use `Surface.isPlanar()`: in 8.35.0 it returned true for all 97 faces of the teapot sample and every curved face of the Rhino logo. Use these tests instead:

- **Flat:** sample the surface on a 9×9 grid over its domain. The face is flat if every sample is within `max(1e-6 × extent, tolerance / 10)` of the plane through the centre point with the centre normal.
- **Untrimmed:** the face has one loop, and every edge's start, quarter, middle, three-quarter and end points lie within tolerance of the surface's four boundary iso-curves.
- **Trimmed curved:** everything else.

### Shared edge sampling

Sample each Brep edge once, by edge index, and reuse the points for every face that uses it, so neighbouring faces don't crack. Lines get two points. Other curves get `n = clamp(ceil(length / chord), 4, 256)` points, where `chord` comes from tolerance and curvature (start with tolerance × 50, then tune on the corpus). `BrepTrim.isReversed` gives direction within a loop. If it disagrees with the previous point's position, orient by continuity.

### Flat faces

1. Build each loop's polygon from the trims' edge samples (outer loop first, then inner loops as holes).
2. Project onto the face plane with an orthonormal basis `(ex, ey)` derived from the normal.
3. Triangulate with earcut (outer ring plus hole indices).
4. Lift back to 3D using the original edge points, not the projection, so vertices match neighbouring faces exactly.
5. Orientation: the normal is the surface normal, flipped if `face.orientationIsReversed`. Re-wind the triangles if earcut's output disagrees with it.

### Untrimmed curved faces

1. Grid resolution per direction: `max(spanCount × 4, ceil(arcLength / chord))`, capped at 128.
2. Evaluate `pointAt(u, v)` and `normalAt(u, v)` on the grid. Replace the boundary rows with the shared edge samples (resampled to the grid count where the counts differ, inserting a fan strip when they don't match exactly).
3. Two triangles per cell. Drop degenerate triangles at singular sides (poles, `isSingular(side)`).
4. Flip for `orientationIsReversed`.

### Trimmed curved faces (deferred)

Count them under `missing_render_mesh`. A later stage could add them: invert edge samples into UV with Newton iteration on the surface (rhino3dm exposes no 2D trim curves or closest-point), build UV trim polygons, triangulate a UV grid clipped by the trims (constrained triangulation), then evaluate. That's about 2 to 3 weeks, so do it only if real files need it.

### Measured coverage (2026-11-03 spike)

Faces without a cached mesh, from public samples. "Recoverable" means flat or untrimmed. Script: `/tmp/weave-3d-formats/opus/scripts/coverage.mjs`.

| File                       | Faces  | Cached | Flat | Untrimmed curved | Trimmed curved | Recoverable |
| -------------------------- | ------ | ------ | ---- | ---------------- | -------------- | ----------- |
| `r3dm_blocks`              | 10     | 0      | 8    | 2                | 0              | 100%        |
| `r3dm_file3dm_stuff`       | 30     | 1      | 29   | 0                | 0              | 100%        |
| `r3dm_groups`              | 31     | 0      | 30   | 1                | 0              | 100%        |
| `r3dm_object_UserStrings`  | 6      | 0      | 6    | 0                | 0              | 100%        |
| `v2_my_brep`, `v5_my_brep` | 6 each | 0      | 1    | 5                | 0              | 100%        |
| `v5_extrusions`            | 48     | 0      | 39   | 9                | 0              | 100%        |
| `v8_selective_clipping`    | 21     | 3      | 18   | 0                | 0              | 100%        |
| `v5_example_file`          | 24     | 0      | 18   | 4                | 2              | 92%         |
| `v5_teapot`                | 97     | 0      | 6    | 61               | 30             | 69%         |

This spike classified faces only. Triangle quality and cracks still have to be checked in 3B.

## Measured conversion (cached meshes, 2026-11-03)

`rhino3dm` 8.35.0, Node 22, gltfpack `-cc -mm`. Raw GLBs pass the Khronos validator with 0 errors.

| File                    | Rhino | Size    | Triangles | Packed GLB | Time   | Peak RSS |
| ----------------------- | ----- | ------- | --------- | ---------- | ------ | -------- |
| `v4_RhinoPhone`         | 4     | 7.31 MB | 156,214   | 551 KB     | 622 ms | 163 MB   |
| `v6_rhino_logo`         | 6     | 928 KB  | 32,044    | 128 KB     | 272 ms | 107 MB   |
| `v7_rhino_logo_subd`    | 7     | 509 KB  | 99,904    | 351 KB     | 509 ms | 164 MB   |
| `v8_selective_clipping` | 8     | 867 KB  | 66,048    | 209 KB     | 370 ms | 115 MB   |
| `v5_disk_brake`         | 5     | 9.68 MB | 60,844    | 292 KB     | 481 ms | 164 MB   |

Nothing above 10 MB has been tested yet.

## Ghost reference fields

`formatVersion` = archive version. `authoring` = `applicationName` plus the build string. `document` = `revision`, `created`, `lastEdited`, `createdBy`. `units` from settings. `basePoint` = `modelBasePoint`. `georeference` from `earthAnchorPoint` when set. `counts` from the walk. `sourceIdsHash` = SHA-256 of the sorted object UUIDs.

Rhino object UUIDs are expected to persist across saves, but this hasn't been verified. Test it before relying on it for revision matching: save, edit, save again, then compare.

## Tests

- **Corpus:** `mcneel/opennurbs/example_files` (Rhino 1 to 8), `mcneel/rhino3dm/tests/models`, three.js `examples/models/3dm`, plus the owner's real files. Keep small fixtures in the repo and fetch large ones in a script.
- **Reader:** units (mm, ft, None), nested blocks, a mirrored block, hidden layer inheritance, colour precedence, user strings, SubD, a mesh object, a Brep with and without cached meshes.
- **Mesher:** a flat face with a hole, a cylinder wall (untrimmed), a sphere (singular sides). Check vertices match along shared edges (no cracks), outward orientation, and triangle counts within bounds.
- **Pipeline:** decode the packed GLB and check that every `_BATCHID` resolves to a feature, that two objects with the same material keep separate IDs after `-mm`, and that `asset.extras.weave` survives.
- **Coverage:** `r3dm_file3dm_stuff` must not pass silently. It has to report its partial coverage.

## Instructions for users

When Weave reports `no_render_meshes`, or warns that some faces are missing:

1. In Rhino, set a viewport to **Shaded** or **Rendered** so Rhino builds render meshes, then use **Save** or **Save As**. Don't use `SaveSmall`, which strips them.
2. Alternatively, export a mesh: **File → Export Selected** (or **Save As**), then choose **glTF Binary (.glb)** in Rhino 7 and later, or **OBJ** or **STL**. Upload that file instead. Layer and object metadata is lost in OBJ and STL.
3. For curved solids that look faceted, raise the render mesh quality (**Document Properties → Mesh → Smooth & slower**) before saving.

## Open questions

- Real architecture files: how many have cached meshes, how large they get, and how deep their blocks go. The owner's sample files decide this.
- Whether the browser can run `rhino3dm` and gltfpack together in one worker within the memory budget.
- Whether the wasm64 build of `rhino3dm` is needed for files above about 1 GB.
