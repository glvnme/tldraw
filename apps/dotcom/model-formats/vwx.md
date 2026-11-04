# VWX (Vectorworks)

|                     |                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------- |
| Status              | Export only                                                                        |
| Extensions          | `.vwx`                                                                             |
| Behaviour on upload | Recognised, then refused with the export instructions below (`unsupported_format`) |

## Why there's no reader

The format is proprietary and undocumented, with no third-party reader. Geometry is Parasolid-based with parametric objects.

## Instructions for users

- **BIM model:** File → Export → **Export IFC Project**, IFC4 → upload as [IFC](ifc.md).
- **Visual model:** File → Export → **Export glTF** (newer versions), or Export OBJ or 3DS → upload as [GLB](gltf-glb.md) or [OBJ](obj.md).
- **Rhino round trip:** File → Export → Export Rhino 3DM → upload as [3DM](3dm.md). This keeps layers and classes as layers.
