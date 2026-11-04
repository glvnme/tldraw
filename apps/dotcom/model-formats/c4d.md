# C4D (Cinema 4D)

|                     |                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------- |
| Status              | Export only                                                                        |
| Extensions          | `.c4d`                                                                             |
| Behaviour on upload | Recognised, then refused with the export instructions below (`unsupported_format`) |

## Why there's no reader

The format is proprietary. Maxon's Cineware SDK reads it, but assimp's C4D importer depends on that non-free SDK and isn't built by default. Geometry is largely procedural (generators, deformers, MoGraph).

## Instructions for users

Cinema 4D → **File → Export → glTF** (`.glb`, with Draco off) → [GLB](gltf-glb.md), or **FBX** → [FBX](fbx.md). Make generators editable ("Current State to Object") or bake MoGraph clones first, so the export contains real meshes.
