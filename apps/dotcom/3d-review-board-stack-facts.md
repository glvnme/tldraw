# 3D review board: verified stack facts

Research for the local prototype track, 2026-11-02. Each fact was tested in a scratch directory unless marked unverified. Read with `3d-review-board-implementation.md`, section "Local prototype track (current)".

## gltfpack (npm 1.3.0, MIT, WASM)

- Programmatic, in memory, no temp files:
  ```js
  import { pack } from 'gltfpack'
  const files = new Map([['in.glb', glb]])
  const log = await pack(['-i', 'in.glb', '-o', 'out.glb', '-cc'], {
  	read: (p) => files.get(p) ?? fs.readFileSync(p),
  	write: (p, d) => files.set(p, new Uint8Array(d)),
  })
  ```
  Throws `Error(log)` on failure.
- Works: `-cc`, `-km`, `-si`, `-mi`. `-kn` blocks merging and inflates output (2000 named boxes: 184 KB to 1.5 MB), so do not use it.
- No texture compression in the WASM build. `-tc` and `-tw` fail on textured input ("built without BasisU support"). Without them, textures pass through unchanged. Cap texture bytes instead.
- Inputs: `.obj` (with MTL through the `read` callback), `.gltf`, `.glb`.
- Draco input fails ("file requires Draco mesh compression support"). Detect `KHR_draco_mesh_compression` in the JSON and reject with an error code.
- 32-bit address space. Measured: 144 MB in, 0.8 GB RSS, 3 s; 720 MB in, 3.7 GB RSS, 15 s; 1.8 GB in, `unreachable` trap. Practical cap about 1 GB of input GLB. Run in a child process.
- Custom attribute `_BATCHID` survives `-cc` as float32 (exact to 16.7 M ids). Gives per-product picking without `-kn`. Do not use `-mi` if per-product ids matter.

## web-ifc (0.0.78, MPL-2.0) in Node 22

```js
import * as WebIFC from 'web-ifc/web-ifc-api-node.js'
const api = new WebIFC.IfcAPI()
await api.Init(undefined, true) // force single thread
const id = api.OpenModel(new Uint8Array(buf), {
	COORDINATE_TO_ORIGIN: true,
	CIRCLE_SEGMENTS: 12,
	MEMORY_LIMIT: 3 * 1024 ** 3,
	TAPE_SIZE: 67108864,
})
api.StreamAllMeshes(id, (mesh) => {
	for (let i = 0; i < mesh.geometries.size(); i++) {
		const pg = mesh.geometries.get(i) // { color: {x,y,z,w}, geometryExpressID, flatTransformation: number[16] }
		const g = api.GetGeometry(id, pg.geometryExpressID)
		const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize()) // Float32Array view
		const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize()) // Uint32Array view
		// copy v and ix before delete: they are views into WASM memory
		g.delete()
	}
})
api.CloseModel(id)
api.Dispose()
```

- Vertex layout: interleaved, 6 floats per vertex (position xyz, normal xyz). Color RGBA 0..1.
- `flatTransformation` is column-major, usable directly as glTF `node.matrix`.
- Do not call `mesh.delete()` inside the stream callback; it throws.
- Output is Z-up. Add a root rotation of -90 degrees about X for glTF. `StreamAllMeshes` applies the unit scale by default, so expect metres (millimetre files unverified).
- Turn on `COORDINATE_TO_ORIGIN` and store `GetCoordinationMatrix(id)` in the manifest.
- Group by `mesh.expressID`. `api.GetLine(id, expressID).GlobalId.value` gives the GlobalId, `GetLineType` the type code. Write `expressID` into `_BATCHID` and keep an `expressID -> { globalId, ifcType, name }` map next to the manifest.
- 13 MB IFC2X3 sample: 2586 products, 4896 placements, 174k triangles, 0.8 s, 267 MB RSS. Larger files unverified. A known "Maximum call stack size exceeded" in `StreamAllMeshes` is fixed with `node --stack-size`. Run in a child process with a kill timer.

## Hand-written GLB

- 12-byte header (`0x46546C67`, version 2, total length), JSON chunk (`0x4E4F534A`) padded with spaces to 4 bytes, BIN chunk (`0x004E4942`) padded with zeros to 4 bytes, little-endian, chunk lengths include padding.
- Align every bufferView to 4 bytes. `target` 34962 for vertices, 34963 for indices. Component types: 5126 float32, 5125 uint32, 5123 uint16, 5121 uint8.
- POSITION `min` and `max` are required. `buffers[0].byteLength` is the padded BIN length.
- For IFC: one mesh per `(geometryExpressID, color)`, one node per placement with `matrix = flatTransformation`. Alpha below 1 goes to `alphaMode: 'BLEND'`, `doubleSided: true`. gltfpack merges unnamed nodes by material.
- A tested 45-line writer exists at `/tmp/r1s/glb.mjs` on the dev machine.

## STL

- Binary: 80-byte header, uint32 count, 50 bytes per facet. Detect by size first: binary if `byteLength === 84 + 50 * n`, even when the header starts with `solid`. Else ASCII if it starts with `solid`. Else binary.
- No units in the format. Assume millimetres, scale to metres, record the unit in the manifest. Assume Z-up, rotate like IFC. Recompute normals from winding. One grey material. Ignore color extensions.

## wrangler dev and R2 (wrangler 4.156.1)

- No practical local body limit (600 MB PUT streamed). Deployed limit is 100 MB on Free and Pro.
- Local multipart works: `createMultipartUpload`, `resumeMultipartUpload(key, uploadId)`, `uploadPart(n, body)`, `complete(parts)`.
- Parts 1 to N-1 must be equal and at least 5 MiB, at most 10,000 parts. A small non-last part fails at `complete` (10011), unequal parts fail with 10048, a bogus upload id fails with 10024.
- `uploadPart(n, request.body)` works only with a `Content-Length`. The browser must PUT `Blob.slice()` parts.
- Range: `bucket.get(key, { range: req.headers })` returns correct ranges, including suffix ranges. Build `Content-Range` from `o.range` and `o.size`, set `Accept-Ranges`. `onlyIf: req.headers` handles `If-None-Match`.
- Use equal 16 MiB parts.

## three.js r187

- `GLTFLoader` from `three/addons/loaders/GLTFLoader.js`, `OrbitControls` from `three/addons/controls/OrbitControls.js`, `MeshoptDecoder` from `three/addons/libs/meshopt_decoder.module.js`, then `loader.setMeshoptDecoder(MeshoptDecoder)`. The decoder needs no SharedArrayBuffer or COOP and COEP. No `KTX2Loader` needed.
- `loader.setRequestHeader({ Authorization: 'Bearer ...' })` applies to the glTF fetch and textures.
- Renderer: `powerPreference: 'high-performance'`, `antialias: true`, `reversedDepthBuffer: true` (new in r187, needs `EXT_clip_control`, falls back with a warning). Leave `preserveDrawingBuffer` off.
- Capture: `renderer.render()` then `canvas.toBlob()` in the same task.
- Render on demand from the controls `change` event, load completion and resize. No `setAnimationLoop`. Leave `enableDamping` off, since damping needs a continuous loop.
- Dispose: traverse and dispose geometries, materials and textures, then `controls.dispose()`, `renderer.dispose()`, `renderer.forceContextLoss()`, remove the canvas.
- Minimal import set: about 653 KB minified, 167 KB gzip. Load it with a dynamic import.

## Repo facts

- CSP (`apps/dotcom/client/src/utils/csp.ts`): add `'wasm-unsafe-eval'` to `script-src`. Model traffic goes through `/api/app/models/*`, which the Vite proxy sends to the sync worker on 8787, so `connect-src 'self'` covers it. Absolute `http://localhost:8787` URLs would be blocked.
- `process-compose.yaml`: add the converter with the TCP readiness probe pattern used for zero-cache.
- The `MODELS` R2 binding follows the `ROOMS` pattern in the sync worker `wrangler.toml`, per environment.

## Unverified

web-ifc beyond 13 MB, millimetre IFC units, georeferenced `COORDINATE_TO_ORIGIN`, `-mi` emitting instancing, Chrome's minimum version for `'wasm-unsafe-eval'`, deployed Worker behavior.
