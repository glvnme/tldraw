# NWD, NWC, NWF (Navisworks)

|                     |                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------- |
| Status              | Export only                                                                        |
| Extensions          | `.nwd` (published model), `.nwc` (cache), `.nwf` (links to other files)            |
| Behaviour on upload | Recognised, then refused with the export instructions below (`unsupported_format`) |

## Why there's no reader

The format is proprietary and undocumented, and no open reader exists. Readers are the Windows-only Navisworks .NET API, the ODA BimNv SDK (paid), HOOPS Exchange (paid) and Autodesk APS (hosted, which would send the original away). `.nwf` holds only references to other files, so it has no geometry of its own.

## Instructions for users

From Navisworks Manage or Simulate:

- **Output → Export Scene → FBX**, then upload the `.fbx` ([FBX](fbx.md)). Names and the selection tree survive as node names. Properties don't.
- Or go back to the source models (Revit → IFC, Civil 3D → IFC or DWG) and upload those. For coordination reviews this is better, because IFC keeps GlobalIds.
