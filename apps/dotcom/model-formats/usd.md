# USD, USDZ

|                     |                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Status              | Export only for now. Deferred                                                                                    |
| Extensions          | `.usd`, `.usda` (text), `.usdc` (binary crate, magic `PXR-USDC`), `.usdz` (uncompressed ZIP of USD and textures) |
| Behaviour on upload | Recognised, then refused with the export instructions below (`unsupported_format`)                               |

## Why there's no reader yet

USD's value is its composition: layers, references, payloads, variants and instancing. A mesh-only reader covers little of it. The options:

| Option                                                                                                                        | Verdict                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenUSD v26.11.1 (native, Tomorrow Open Source Technology License 1.0, which is Apache-2.0 with a different trademark clause) | Too heavy for the converter image unless USD demand appears                                                                                                                         |
| LightUSD (formerly tinyusdz; C++, WASM and JS builds, Apache-2.0, v1.0 RC)                                                    | Best candidate if USD is needed. Spike it then: mesh, xform and instancing support haven't been verified                                                                            |
| three.js `USDZLoader`                                                                                                         | Browser only and partial (USDZ with `usda`/`usdc` meshes)                                                                                                                           |
| Our own `.usda` subset reader                                                                                                 | Possible for simple exports (`def Mesh` with `points`, `faceVertexCounts`, `faceVertexIndices`, `xformOp`s). Several thousand lines, and it fails on anything composed. Not planned |

If adopted, the plan is LightUSD as a native binary or WASM: compose the stage, flatten instances, then emit meshes with `sourceId` = prim path (stable across exports from the same pipeline), `units` from `metersPerUnit`, and the axis from `upAxis`. The obligation is an Apache-2.0 notice.

## Instructions for users

- **Omniverse, Houdini, Blender (USD import):** export GLB → [GLB](gltf-glb.md).
- **Apple Reality Composer and Object Capture (USDZ):** open in Reality Composer or Blender, export GLB or OBJ.
