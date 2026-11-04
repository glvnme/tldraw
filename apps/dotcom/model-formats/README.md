# Model formats

How Weave turns 3D and CAD files into its native model format. The original file is converted once and then deleted, and only a ghost reference to it is kept.

- [native-format.md](native-format.md): the target format (GLB, manifest v2, feature table, ghost reference), the reader interface, and rules every reader follows. **Read this first.**
- [plan.md](plan.md): staged implementation plan, timeline, owner decisions.
- [research.md](research.md): how the choices were made, measurements, and disagreements resolved.

## Formats

| Format              | Spec                         | Status                                      | Reader                                  | New dependency                      | Order |
| ------------------- | ---------------------------- | ------------------------------------------- | --------------------------------------- | ----------------------------------- | ----- |
| Rhino 3DM           | [3dm.md](3dm.md)             | Implemented in service                      | `rhino3dm` plus our own fallback mesher | `rhino3dm` (MIT), earcut (ISC)      | 1     |
| IFC                 | [ifc.md](ifc.md)             | Implemented; v2 metadata planned            | web-ifc                                 | none                                | 2     |
| DXF                 | [dxf.md](dxf.md)             | Planned                                     | our own TS                              | none                                | 3     |
| DWG                 | [dwg.md](dwg.md)             | Planned, pending decision                   | LibreDWG `dwg2dxf` → DXF reader         | LibreDWG binary (GPL, server only)  | 4     |
| SketchUp SKP        | [skp.md](skp.md)             | Spike first                                 | OpenSKP, or user export                 | `openskp` (MIT) if the spike passes | 5     |
| STEP, IGES          | [step-iges.md](step-iges.md) | Planned                                     | occt-import-js                          | `occt-import-js` (LGPL-2.1)         | 6     |
| 3MF                 | [3mf.md](3mf.md)             | Planned                                     | our own TS                              | none                                | 7     |
| PLY                 | [ply.md](ply.md)             | Planned                                     | our own TS                              | none                                | 7     |
| FBX                 | [fbx.md](fbx.md)             | Planned                                     | ufbx built to WASM                      | ufbx (public domain)                | 8     |
| glTF, GLB           | [gltf-glb.md](gltf-glb.md)   | GLB implemented; multi-file `.gltf` planned | gltfpack                                | none                                | 9     |
| OBJ                 | [obj.md](obj.md)             | Implemented; our own reader planned         | gltfpack, then our own TS               | none                                | —     |
| STL                 | [stl.md](stl.md)             | Implemented                                 | our own TS                              | none                                | —     |
| COLLADA DAE         | [dae.md](dae.md)             | Export only, own reader if needed           | —                                       | none                                | later |
| 3DS                 | [3ds.md](3ds.md)             | Export only, own reader if needed           | —                                       | none                                | later |
| Revit RVT, RFA      | [rvt.md](rvt.md)             | Export only; rvt-rs spike later             | —                                       | —                                   | —     |
| Navisworks NWD, NWC | [nwd.md](nwd.md)             | Export only                                 | —                                       | —                                   | —     |
| Archicad PLN        | [pln.md](pln.md)             | Export only                                 | —                                       | —                                   | —     |
| Vectorworks VWX     | [vwx.md](vwx.md)             | Export only                                 | —                                       | —                                   | —     |
| 3ds Max MAX         | [max.md](max.md)             | Export only                                 | —                                       | —                                   | —     |
| Cinema 4D C4D       | [c4d.md](c4d.md)             | Export only                                 | —                                       | —                                   | —     |
| Blender BLEND       | [blend.md](blend.md)         | Export only                                 | —                                       | —                                   | —     |
| USD, USDZ           | [usd.md](usd.md)             | Export only, deferred                       | —                                       | —                                   | —     |

"Export only" formats are still recognised on drop. The client refuses them with the export steps from their spec, instead of a generic "unsupported file" message.

## Quick export guide for users

| You have                     | Upload this                     | How                                                    |
| ---------------------------- | ------------------------------- | ------------------------------------------------------ |
| Rhino                        | `.3dm`                          | Save from a shaded viewport (not `SaveSmall`)          |
| Revit                        | `.ifc`                          | File → Export → IFC (IFC4 Reference View)              |
| Archicad                     | `.ifc`                          | File → Save As → IFC                                   |
| Vectorworks                  | `.ifc` or `.3dm`                | File → Export → Export IFC Project or Export Rhino 3DM |
| SketchUp                     | `.skp`, or `.glb`               | File → Export → 3D Model → glTF Binary (2025+)         |
| AutoCAD (3D)                 | `.dwg` or `.dxf`                | Run `CONVTOMESH` on solids first                       |
| Navisworks                   | `.fbx`                          | Output → Export Scene → FBX                            |
| 3ds Max, Cinema 4D, Blender  | `.glb`                          | File → Export → glTF Binary, Draco off                 |
| Fusion, SolidWorks, Inventor | `.step` or `.3mf`               | Export STEP AP214/AP242                                |
| Scans, photogrammetry        | `.glb`, `.ply` (mesh) or `.obj` | Export a decimated mesh                                |

## Adding a format

1. Write its spec here from an existing one: the format, dependency and licence, conversion steps, mapping, ghost reference fields, tests, user instructions.
2. Add the id to `Model3dSourceFormat` and `MODEL3D_SOURCE_FORMATS` (`packages/dotcom-shared/src/model3d/manifest.ts`), the converter's `job.ts` allowlist, and the CLI usage.
3. Add magic-byte detection, then a `SceneReader` in `apps/dotcom/model-converter/src/` registered in `prepareInput`.
4. Add any licence notice to `apps/dotcom/model-converter/THIRD_PARTY_NOTICES.md`.
5. Tests: reader fixtures, a pipeline round trip (every `_BATCHID` resolves to a feature after packing), coverage, and limits.
6. Run `pnpm test run` in `apps/dotcom/model-converter`, then `pnpm typecheck` from the repo root for the shared contract change.
