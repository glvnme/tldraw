# PLN, PLA (Archicad)

|                     |                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Status              | Export only                                                                                   |
| Extensions          | `.pln` (solo project), `.pla` (archive with libraries), `.tpl`; `.bimx` (BIMx viewer package) |
| Behaviour on upload | Recognised, then refused with the export instructions below (`unsupported_format`)            |

## Why there's no reader

Graphisoft's format is closed, with no public spec and no third-party reader. Geometry is parametric (GDL library parts), so even a decoder would need Archicad's GDL engine to produce meshes.

## Instructions for users

Archicad → **File → Save As → IFC 4 (`.ifc`)**:

1. Translator: "General translator" or "Coordination View".
2. Filter by the current 3D view or a selected set to keep the file small.
3. Upload the `.ifc` ([IFC](ifc.md)). Storeys, layers and GlobalIds carry over.

For a visual-only model: **File → Save As → 3D Studio / OBJ**, or the glTF option in newer versions, then upload as [OBJ](obj.md) or [GLB](gltf-glb.md).
