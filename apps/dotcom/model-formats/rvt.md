# RVT, RFA (Revit)

|                     |                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Status              | Export only. Possible spike later                                                                                        |
| Extensions          | `.rvt` (project), `.rfa` (family), `.rte`, `.rft` (templates)                                                            |
| Magic               | Microsoft Compound File Binary (`D0 CF 11 E0 A1 B1 1A E1`) with Revit streams (`BasicFileInfo`, `Global/…`, `Formats/…`) |
| Behaviour on upload | Recognised, then refused with the export instructions below (`unsupported_format`)                                       |

## Why there's no reader

Revit's format is closed, changes with every yearly release, and stores parametric elements rather than meshes. Revit regenerates geometry itself. The options:

| Option                                            | Verdict                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autodesk APS Model Derivative (hosted)            | Rejected: it sends the original to Autodesk, which breaks the ghost reference, and it costs money                                                                                                                                                                                                                                              |
| ODA BimRv SDK (paid)                              | Rejected for now (commercial terms)                                                                                                                                                                                                                                                                                                            |
| **rvt-rs** (`rvt` crate 0.12.2, Rust, Apache-2.0) | Watch. A clean-room reader that claims typed geometry for Revit 2023–2025 and exports to IFC and glTF. Published 2026-11-03, five weeks old with 14 releases, and its claims are untested. Spike it later on real files: if it works, run it as a native binary (`rvt → glTF`) feeding the [glTF](gltf-glb.md) path, with an Apache-2.0 notice |
| Read `BasicFileInfo` only                         | Cheap. Shows "Revit 2024 project, saved by …" in the refusal message                                                                                                                                                                                                                                                                           |

## Instructions for users

Revit → **File → Export → IFC**:

1. Setup: "IFC4 Reference View" (smaller, better for review) or "IFC2x3 Coordination View 2.0".
2. Export only the current view (so hidden categories stay out) via "Export only elements visible in view".
3. Leave "Export base quantities" off, and turn on "Include IFC site elevation in the site local placement" for correct georeference.
4. Upload the `.ifc`. Weave keeps GlobalIds, so comments carry over when you re-export.

For a lighter visual-only model: **File → Export → FBX** (3D view), or a glTF exporter add-in, then upload as [FBX](fbx.md) or [GLB](gltf-glb.md).
