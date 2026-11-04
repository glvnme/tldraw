# SKP (SketchUp)

|                  |                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Spike first (order 5). Adopt only if the spike passes                                                                                                            |
| Extensions       | `.skp`                                                                                                                                                           |
| Magic            | SketchUp 2013–2020 (MFC container): UTF-16LE `SketchUp Model` near the start. SketchUp 2021+ (VFF container): a different header, which the spike has to confirm |
| Reader           | OpenSKP 1.4.0 (TypeScript, reverse-engineered), if the spike passes. Otherwise user export                                                                       |
| Source format id | `'skp'`                                                                                                                                                          |

## The format, briefly

Closed and undocumented. Trimble's SketchUp C SDK is the official reader, but it runs on Windows and macOS only, needs an access request, and its redistribution terms aren't public, so it doesn't fit a Linux converter or a browser. SketchUp geometry is already a mesh: faces (planar polygons with holes), edges, groups and component instances (definition plus transform), tags (layers), and materials with optional textures. Internal units are inches.

## Options considered

| Option                                                                                       | Verdict                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenSKP 1.4.0** (MIT; TS, Python, .NET, Dart and C++ implementations; released 2026-10-27) | **Spike.** Its own version sweep reports success on 2014–2018, 2020, 2021 and 2025, and failure on V3, V4, V6–V8, 2013 and 2019. It is very new |
| SketchUp C SDK                                                                               | Rejected: no Linux build, gated access, terms unknown                                                                                           |
| skppy 0.10.0 (Python)                                                                        | Fallback reference only                                                                                                                         |
| Our own reader                                                                               | Rejected: reverse engineering more than 10k lines plus version upkeep. Reuse OpenSKP instead                                                    |
| User export to GLB                                                                           | **Always available** as the fallback                                                                                                            |

## Dependency and licence

| Code                            | Licence | Obligation                                                |
| ------------------------------- | ------- | --------------------------------------------------------- |
| `openskp` 1.4.0, pinned exactly | MIT     | Notice in `THIRD_PARTY_NOTICES.md`. Its writer isn't used |

## Spike (2 to 3 days)

Pass criteria, all on real files:

1. At least 8 real `.skp` files from SketchUp 2017–2025, including nested components, groups, hidden geometry, tags, front/back materials and textures.
2. Triangle output matches SketchUp's own GLB export of the same file within 1% of the triangle count, with visually equal bounds and placement.
3. Persistent entity IDs (or another stable key) exist and survive a save–edit–save cycle.
4. Runs in Node in under 10 s and 2 GB for a 100 MB file.

If any criterion fails, ship SKP as "export GLB from SketchUp" only, and accept `.skp` uploads with an `unsupported_format` error that explains how to export.

## Conversion steps (if adopted)

1. Parse with OpenSKP, then walk the model's entities.
2. **Faces:** each face is a planar polygon with inner loops. Triangulate with the vendored earcut in the face's plane, as in the [3DM](3dm.md) flat-face mesher. Skip hidden faces and faces on hidden tags.
3. **Groups and component instances:** compose transforms and recurse (depth limit 16). A negative determinant flips winding. `definitionId` = component definition, `instancePath` = instance IDs.
4. **Materials:** a face's front material, or the inherited instance material when the face has the default. A colour or the texture's average colour becomes `Rgba`. With textures, warn `material_approximated`.
5. **Identity:** `sourceId` = persistent ID if OpenSKP exposes one (`skp-pid`), otherwise `file-local`.
6. **Units:** inches → metres (0.0254). Z-up → Y-up. `basis: 'file'`.
7. **Layers:** SketchUp tags (layers before 2020), including tag folders as parents.

The ghost reference takes `formatVersion` = SketchUp version and `authoring.application = 'SketchUp'`.

## Instructions for users

- **SketchUp 2025 and later, with a plan that includes it:** File → Export → 3D Model → **glTF Binary (.glb)**. Upload the `.glb`.
- **Older versions:** File → Export → 3D Model → COLLADA (`.dae`) or OBJ. Weave reads OBJ today. DAE isn't supported yet, so prefer OBJ.
- **For BIM data,** SketchUp Pro: File → Export → 3D Model → IFC.
- Hidden geometry and hidden tags aren't exported. Unhide what you want reviewed first.
