# 3MF

|                  |                                                                            |
| ---------------- | -------------------------------------------------------------------------- |
| Status           | Planned (order 7)                                                          |
| Extensions       | `.3mf`                                                                     |
| Magic            | ZIP (`PK\x03\x04`) containing `3D/3dmodel.model` (path from `_rels/.rels`) |
| Reader           | Our own TypeScript, with no zip library                                    |
| Source format id | `'3mf'`                                                                    |

## The format, briefly

3D Manufacturing Format (ISO/IEC 25422:2025, royalty-free spec from the 3MF Consortium). An OPC ZIP package. The main part is XML:

```xml
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <basematerials id="1"><base name="Red" displaycolor="#FF0000"/></basematerials>
    <object id="2" type="model" name="Part" pid="1" pindex="0">
      <mesh><vertices><vertex x="0" y="0" z="0"/>…</vertices>
            <triangles><triangle v1="0" v2="1" v3="2"/>…</triangles></mesh>
    </object>
    <object id="3"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>
  </resources>
  <build><item objectid="3" transform="…"/></build>
</model>
```

Exported by Rhino, Fusion, slicers and some BIM tools for printing physical models.

## Dependency and licence

None. Unzip with `node:zlib` `inflateRawSync` in Node, or `DecompressionStream('deflate-raw')` in the browser, reading the ZIP central directory ourselves (about 120 lines). Parse the XML with a small streaming tokenizer: the subset is only elements and attributes, so no DOM is needed and it works in workers.

## Conversion steps

1. **ZIP:** find the end-of-central-directory record, read entries, and inflate only `_rels/.rels` and the model parts it points to. Stored entries are method 0, deflate is method 8; reject other methods. Cap the total inflated size at 4 × `maxSourceBytes` (zip bomb guard) and the entry count at 10,000.
2. **XML:** read `unit` (micron, millimeter, centimeter, inch, foot, meter; default millimeter), `basematerials`, `colorgroup` (materials extension), `object` meshes and `components`, and `build/item`.
3. **Build items:** for each item, `emit(object, itemTransform)`. Components recurse with composed transforms (depth limit 16, cycle guard). The 3MF `transform` is a 3×4 row-major matrix: `m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`, with the translation in the last row.
4. **Meshes:** vertices and triangles map directly. Per-triangle `pid` and `p1` select materials; group triangles by resolved colour into `Rgba` materials. `displaycolor` is `#RRGGBB` or `#RRGGBBAA`.
5. **Identity:** `sourceId` = object `UUID` from the production extension (`p:UUID`) if present, otherwise `file-local` with the object id plus the component path. `name` = object `name`.
6. **Units** from `unit`, `basis: 'file'`. Z-up → Y-up.
7. Skip objects with `type="support"` (count them). Treat `type="surface"` and `"solidsupport"` as meshes.
8. Ignore beam lattice, slice and volumetric extensions, with a warning `unsupported_entity`.

The ghost reference takes `authoring` from the `<metadata name="Application">` element when present.

## Estimate

About 800 lines and under 1 week, including the ZIP reader.

## Tests

- Fixtures from the 3MF Consortium `3mf-samples` repository: a basic mesh, components with transforms, base materials, colour groups, and a production-extension file with UUIDs.
- A zip bomb fixture is rejected with `too_large`.

## Instructions for users

Export 3MF from Rhino, Fusion, SolidWorks, PrusaSlicer or Bambu Studio. For architecture models, prefer [3DM](3dm.md), [IFC](ifc.md) or GLB, which keep layers and object identity.
