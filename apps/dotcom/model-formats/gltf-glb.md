# glTF and GLB

|                  |                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Status           | GLB implemented. Multi-file `.gltf` planned (order 9)                                     |
| Extensions       | `.glb`; `.gltf` with its `.bin` and image files                                           |
| Magic            | GLB: `glTF` (0x46546C67), then version 2. `.gltf`: JSON with `"asset": {"version": "2.0"` |
| Reader           | gltfpack reads it directly; `readGlb` checks extensions first                             |
| Source format id | `'glb'`; `'gltf'` planned                                                                 |

## The format, briefly

Khronos glTF 2.0, which is also our native format. GLB holds JSON plus one binary chunk. `.gltf` is JSON that references external `.bin` buffers and images by relative URI (or embeds them as `data:` URIs).

## Dependency and licence

gltfpack 1.3.0 (MIT, already a dependency). No new code beyond the multi-file handling.

## Current behaviour (`pipeline.ts`, case `'glb'`)

- `readGlb` parses the JSON chunk. Files using `KHR_draco_mesh_compression` are rejected with `draco_unsupported`, because the gltfpack WASM build can't decode Draco.
- gltfpack runs with `-cc -mm`, reading only the one input file from memory. Transform: identity, Y-up, units `'m'` (glTF is metres by spec).

## Conversion steps (v2)

1. **Validate:** a GLB header with version 2, chunk lengths within the file, and JSON that parses. Check `extensionsRequired` against the set gltfpack supports (reject `KHR_draco_mesh_compression` and unknown required extensions with `unsupported_format`, naming the extension).
2. **Identity before packing:** gltfpack's `-mm` drops node names and extras (Astra's spike). Before packing, walk the node tree, give each mesh-bearing node occurrence a dense `featureId`, and write that ID as a `_BATCHID` attribute into its primitives. Primitives shared across nodes are duplicated first, which is the baking rule. Write the feature table into `asset.extras.weave` with `sourceId` = node name path (`file-local`), `name` = node name, and the node's `extras` as `userStrings` (string values only).
   - This means rewriting the GLB before gltfpack. Use a small in-repo glTF reader and writer that keeps all accessors, materials and textures (not `writeGlb`, which drops textures). About 300 lines.
   - If the file already has `_BATCHID` or `_FEATURE_ID_0`, keep it and only build the table.
3. **Pack** with gltfpack as today. Textures pass through uncompressed (no BasisU in the WASM build).
4. **Transform:** identity rotation, metres. Recentre on bounds like every other format (a v1 gap: GLB inputs currently aren't recentred). `basis: 'file'`.
5. **Animations, skins, morph targets:** gltfpack keeps them unless told otherwise. The viewer shows the bind pose. Count them under `unsupported_entity` for information only.

### Multi-file `.gltf`

1. The client accepts a multi-file drop or a folder: one `.gltf` plus everything it references. It reads the `.gltf` JSON, lists `buffers[].uri` and `images[].uri`, and refuses with a message naming any missing file.
2. URIs are relative paths only. Reject absolute paths, `..` segments, `http(s)` URLs and anything outside the dropped set (`external_reference_missing`).
3. Either pack the files client-side into one GLB before upload (simplest; the upload contract stays single-file, `format: 'glb'`, and the ghost reference lists the original file names), or upload a ZIP and let the converter populate gltfpack's `read` map. Client-side packing is preferred.

The ghost reference takes `authoring` = `asset.generator` and `formatVersion` = `asset.version`. For multi-file uploads, `filename` = the `.gltf` name, with `bytes` and `sha256` over the concatenation in sorted path order.

## Tests

- Existing Draco rejection test.
- Two nodes sharing one mesh produce two features after packing.
- Node names survive as feature names, and `asset.extras.weave` survives.
- `.gltf` plus `.bin` plus a PNG, with a missing `.bin` refused and a `../` URI refused.

## Instructions for users

GLB is the best fallback for any tool Weave can't read directly:

- **Blender:** File → Export → glTF 2.0, format "glTF Binary (.glb)", with "Compression" (Draco) **off**.
- **Rhino 7+:** Save As → glTF Binary.
- **SketchUp 2025+:** File → Export → 3D Model → glTF Binary.
- **3ds Max 2023+:** File → Export → glTF.
- **Cinema 4D:** File → Export → glTF.

Turn Draco compression off. Weave rejects Draco-compressed files.
