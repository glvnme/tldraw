# DWG

|                  |                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planned (order 4). Pending owner decision: LibreDWG on the server                                                                        |
| Extensions       | `.dwg`                                                                                                                                   |
| Magic            | First 6 bytes: version string, e.g. `AC1015` (2000), `AC1018` (2004), `AC1021` (2007), `AC1024` (2010), `AC1027` (2013), `AC1032` (2018) |
| Reader           | LibreDWG `dwg2dxf` (native binary in the converter image), then our [DXF](dxf.md) reader                                                 |
| Runtime          | Server only. Never in the browser                                                                                                        |
| Source format id | `'dwg'`                                                                                                                                  |

## The format, briefly

AutoCAD's closed binary format. Autodesk doesn't publish it. The Open Design Alliance's reverse-engineered "Open Design Specification for .dwg files" (v5.4.1, R13 to R2018) describes its layout. Sections are compressed and versioned, and objects are bit-packed. It holds the same entity model as DXF (handles, layers, blocks, model and paper space).

The 3D solids are the hard part: `3DSOLID`, `BODY`, `REGION` and `SURFACE` store ACIS SAT/SAB data. Even ODA's spec says it doesn't have a complete decryption of these. Turning ACIS into triangles needs an ACIS kernel. ODA sells one; nothing open exists. Rendering a DWG without ACIS works for meshes (`3DFACE`, polyface, `MESH`) and extruded 2D, as in [DXF](dxf.md).

## Options considered

| Option                                                       | Verdict                                                                                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LibreDWG 0.14** (C, GPL-3.0-or-later, released 2026-06-27) | **Chosen.** `dwg2dxf` produces DXF that our reader handles. Its maintainers estimate about 90% DXF coverage, and some R2010+ objects are skipped. It passes ACIS data through without tessellating it |
| `@mlightcad/libredwg-web` 0.8.3 (WASM, 10.9 MB, GPL-3.0)     | Rejected for the browser. Shipping it would distribute GPL code. Server-side WASM has no advantage over the native binary                                                                             |
| ODA File Converter (free download, proprietary)              | Rejected: its terms for server automation and redistribution aren't published                                                                                                                         |
| ODA Drawings SDK plus ACIS modeler (paid membership)         | The only route to solids. Not planned; revisit only if solid-heavy DWGs turn out to matter                                                                                                            |
| Autodesk APS Model Derivative (hosted)                       | Rejected: it would send the original to Autodesk, which conflicts with the ghost reference                                                                                                            |
| Our own DWG decoder                                          | Rejected: a multi-person, multi-month reverse-engineering effort plus ongoing upkeep                                                                                                                  |

## Dependency and licence

| Code                                                                                            | Licence          | Obligation                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LibreDWG 0.14 `dwg2dxf`, unmodified, built in the converter Dockerfile from the release tarball | GPL-3.0-or-later | It runs as a separate process on our server and is never distributed, so there's nothing to release. If the converter image is ever published, publish LibreDWG's source alongside it |

## Conversion steps

1. Check the magic: reject unknown versions (`unsupported_format`), and files from before R13 (`AC1012`).
2. Write the source to a per-job temporary directory (`mkdtemp`, mode 0700).
3. Run `dwg2dxf --as r2018 -o out.dxf in.dwg` with a timeout (half the job timeout), a memory limit (`prlimit --as`), no network, and the temp directory as working directory. A non-zero exit or empty output means `conversion_failed`, with the first stderr line in the message.
4. Pass `out.dxf` to the DXF reader with `format: 'dwg'`. Handles are DWG handles, so `sourceIdKind: 'dwg-handle'`.
5. Count ACIS entities (`3DSOLID`, `BODY`, `REGION`, `SURFACE`) under `unsupported_entity` with the type in the samples. Count `ACAD_PROXY_ENTITY` the same way. Unresolved xrefs become `external_reference_missing`.
6. If nothing produced triangles, throw `no_geometry` and list what the drawing held, for example "This drawing has 37 solids that need to be converted to meshes in AutoCAD first".
7. Delete the temp directory in a `finally`.

The ghost reference takes `formatVersion` from the magic and `authoring.application = 'AutoCAD-compatible'`, unless `$ACADMAINTVER` or the header says more.

## Measuring before promising

How much of a real architectural DWG renders without ACIS hasn't been measured. Before calling DWG supported, run 10 to 20 real files (2D plans, 3D mesh models, solid models, xref-heavy sets) and record, per file: entity counts by type, triangles produced, the share of visible geometry that is ACIS, and a visual comparison with AutoCAD or DWG TrueView.

## Tests

- Docker build test: `dwg2dxf --version` is present and matches the pinned version.
- Fixtures: LibreDWG's own test DWGs (`test/test-data`) for R2000, R2004, R2010 and R2018. Assert that it doesn't crash and that the counts match the DXF path.
- A solid-only DWG gives `no_geometry` with an ACIS count. A DWG with `3DFACE` gives triangles.
- Timeout and memory limit: a pathological file is killed and reported as `conversion_failed`.

## Instructions for users

- **Best:** export from the tool that made the model. Revit → IFC, Rhino → 3DM, SketchUp → GLB.
- **From AutoCAD with 3D solids:** run `CONVTOMESH` on the solids, then save. Or export FBX if your AutoCAD version still has `FBXEXPORT`.
- Bind xrefs before uploading (`XREF` → Bind).
- 2D plans have no 3D geometry. Upload them as images or PDF on the board instead.
