# BLEND (Blender)

|                     |                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Status              | Export only                                                                                                                                   |
| Extensions          | `.blend`                                                                                                                                      |
| Magic               | `BLENDER` then pointer size and endianness (`_v` or `-v`) and a version, e.g. `BLENDER-v402`. Zstd-compressed files start with the zstd magic |
| Behaviour on upload | Recognised, then refused with the export instructions below (`unsupported_format`)                                                            |

## Why there's no reader

The `.blend` file is a memory dump of Blender's DNA structs. The struct layout is self-described, but evaluated geometry (modifiers, geometry nodes, curves, instancing) only exists after Blender evaluates the scene. Running headless Blender in the converter image would work, but it adds hundreds of MB, a GPL binary, and Python script execution from untrusted files (which would need `--disable-autoexec` and sandboxing). That doesn't fit "native, minimal dependencies". assimp deprecated its BLEND importer.

## Instructions for users

Blender → **File → Export → glTF 2.0 (.glb/.gltf)**:

- Format: **glTF Binary (.glb)**
- Include: selected objects or visible objects
- Transform: +Y Up (the default)
- Mesh: Apply Modifiers **on**
- Compression: **off** (Weave rejects Draco)

Upload the `.glb` ([GLB](gltf-glb.md)). Object names become features.

For BIM models made with Bonsai (BlenderBIM), upload the `.ifc` instead.
