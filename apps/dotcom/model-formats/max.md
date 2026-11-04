# MAX (3ds Max)

|                     |                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Status              | Export only                                                                                                                    |
| Extensions          | `.max`                                                                                                                         |
| Behaviour on upload | Recognised (Compound File Binary with 3ds Max streams), then refused with the export instructions below (`unsupported_format`) |

## Why there's no reader

The format is a proprietary serialisation of the 3ds Max scene graph: plugins, modifiers and procedural objects that only 3ds Max can evaluate. No open reader exists, and assimp doesn't list it.

## Instructions for users

3ds Max → **File → Export**:

- **glTF (`.glb`)** in 3ds Max 2023 and later, with Draco off → [GLB](gltf-glb.md).
- Or **FBX** with units in metres, "Embed media" off, and "Triangulate" on → [FBX](fbx.md).

Collapse heavy modifiers (TurboSmooth, scatter) or lower their render iterations before exporting.
