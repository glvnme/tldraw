# Native model format

Every source format converts into this format. A format spec describes only how to fill it in. Status: v1 is used by existing formats. 3DM uses v2 with a ghost reference, feature table, matrix transform, coverage, and warnings. See [3dm.md](3dm.md) for the implemented subset. The remaining cross-format changes are in [plan.md](plan.md).

## Current contract

The TypeScript contracts in `packages/dotcom-shared/src/model3d/manifest.ts` define the implemented shape. The service accepts both manifest versions. Version 2 keeps the v1 `recentreOffset`, `scale`, and `upAxis` fields and adds `sourceToModel`.

For 3DM, `asset.extras.weave` contains `features` and `layers`. A feature has a dense `id`, source UUID, name, type, layer ID, instance path, user strings, and `meshedBy` (`rhino`, `weave`, or `mixed`). `_BATCHID` refers to this dense ID. The manifest feature descriptor gives the count and storage location.

The source ghost reference is in the manifest JSON stored on the existing model row. The new database columns, general reader interface, lineage matching, browser conversion, and feature-table design below are targets for later changes. They are not required to read the current 3DM output.

## Artifacts

Each conversion attempt writes two files under `m/{modelId}/{jobId}/`:

| File            | Content                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model.glb`     | glTF 2.0 binary. Y-up, metres, recentred near the origin. Optimised by gltfpack 1.3.0 with `-cc -mm`, so geometry uses `EXT_meshopt_compression`. Carries `_BATCHID` per vertex and the feature table in `asset.extras.weave`. |
| `manifest.json` | Small JSON summary (under 8 MiB, the route cap): bounds, counts, units, transform, ghost reference, coverage, warnings, converter versions. Also copied into the `model` row.                                                  |

The original source file is not an artifact. It is held only as temporary job input and deleted after the attempt ends (see [Ghost reference](#ghost-reference)).

## Conversion pipeline

```
source bytes
  └─ detect format (magic bytes first, extension second)
  └─ reader (one per format)  →  ReadSceneResult { scene, features, ghost, coverage, warnings, sourceToModel }
  └─ writeGlb(scene)          →  raw GLB in memory
  └─ gltfpack -cc -mm         →  optimised GLB (wasm32, in-memory I/O only)
  └─ summarizeGltf            →  bounds, triangle and mesh counts
  └─ checks                   →  limits, coverage, empty output
  └─ manifest v2 + artifacts
```

Paths: `apps/dotcom/model-converter/src/pipeline.ts` (`convertModel`, `prepareInput`), `glb.ts` (`GlbScene`, `writeGlb`, `readGlb`), `gltfInfo.ts`.

### Reader interface

New readers implement this. IFC and STL get thin wrappers around `ifcToScene` and `parseStl`.

```ts
interface ReadSceneOptions {
	maxTriangles: number
	maxObjects: number
	unitOverride?: { name: string; metresPerUnit: number }
	onProgress?(fraction: number): void
}

interface ReadSceneResult {
	scene: GlbScene // meshes, materials, nodes, as writeGlb takes today
	features: FeatureTable // goes into asset.extras.weave
	ghost: GhostReference // without sha256, which the host fills in
	coverage: { sourceObjects: number; renderedObjects: number; skippedObjects: number }
	warnings: ConversionWarning[]
	sourceToModel: Mat4 // column-major, source units and axes → GLB metres, Y-up, recentred
	reader: { name: string; version: string }
}

type SceneReader = (bytes: Uint8Array, options: ReadSceneOptions) => Promise<ReadSceneResult>
```

The Node host (`job.ts`, `runner.ts`, `jobProcess.ts`) owns fetching, hashing, the job token, status calls, the child process and its kill timer. A synchronous WASM call can't be interrupted, so cancellation and timeouts are enforced by killing the child (or terminating the browser worker).

Formats that gltfpack reads directly (OBJ, GLB, multi-file glTF) skip `writeGlb`, but still get a manifest and a feature table where the source has object identity.

## Rules every reader follows

### Coordinates and units

1. Read the source unit. If the file has none, assume one, record `basis: 'assumed'` and say so in a warning. Never label an assumption as a file fact.
2. Compute the recentre origin in **double precision, in source coordinates**: the centre of the X/Y (plan) bounds and the minimum of the up axis. Subtract it before casting to float32. Casting first loses precision on georeferenced files.
3. Scale to metres and rotate to Y-up: Z-up sources map `(x, y, z) → (x, z, -y)`.
4. Write `sourceToModel`, the one matrix that does steps 2 and 3, so any picked point can be mapped back to source coordinates.
5. Base points and georeference (Rhino earth anchor, IFC `IfcMapConversion`) go into the ghost reference. They don't move the GLB.

### Geometry

- Triangles only. Quads and polygons are triangulated by the reader. Curves, points, text, hatches, dimensions and point clouds are skipped and counted.
- Every triangle's three vertices carry the same `_BATCHID`. Vertices are split at object boundaries.
- Instances (blocks, components, mapped items) are **baked**: transforms are composed and applied to vertices. A mirrored instance (negative determinant) has its winding flipped and its normals negated. `-mm` merges everything by material afterwards, so baking costs triangles, not draw calls. GPU instancing is a later, whole-pipeline change, because a shared mesh can't carry per-occurrence IDs.
- Colours become `Rgba` materials. Textures aren't carried yet, and the reader warns with `material_approximated` when the source had them.
- Abort as soon as the running triangle count passes `maxTriangles`, because baked instances multiply triangles.

### Identity: `_BATCHID` and the feature table

`_BATCHID` is a dense integer, starting at 0, one per **displayed occurrence** of a source object. A block member placed three times gets three IDs. The ID is stored as float32, so it stays below 2^24. It is a lookup key inside one GLB only, never a persistent identifier.

```ts
interface FeatureTable {
	schemaVersion: 1
	objects: {
		featureId: number // = _BATCHID
		sourceId: string // persistent: Rhino object UUID, IFC GlobalId, DWG handle, SKP entity id
		sourceIdKind: 'rhino-guid' | 'ifc-globalid' | 'dwg-handle' | 'skp-pid' | 'file-local'
		localId?: string // IFC ExpressID and the like: file-local, not stable across exports
		name?: string
		type?: string // IfcWall, Brep, Extrusion, 3DFACE, ...
		layerId?: string
		levelId?: string
		materialId?: string
		definitionId?: string // block or component definition
		instancePath?: string[] // outer to inner instance ids, for block members
		meshedBy?: 'source' | 'weave' // 'weave' when our fallback mesher produced the triangles
		userStrings?: Record<string, string>
	}[]
	layers: { id: string; name: string; parentId?: string; colour?: Rgba; visible: boolean }[]
	levels?: { id: string; name: string; elevation?: number }[]
}
// GLB JSON: asset.extras.weave = FeatureTable
```

Why `asset.extras`: Astra's spike packed two objects with distinct node names and node `extras`. After `-cc -mm`, and after `-cc -mm -ke`, both `_BATCHID` values survived but the node names and extras were gone. `asset.extras` survived every flag set tested. Script: `/tmp/weave-3d-formats/astra/scripts/gltfpack-spike.mjs`. Keep a regression test for this in the repo.

The client reads `asset.extras.weave` from the parsed glTF JSON (`GLTFLoader.parseAsync` returns it; the viewer keeps only `.scene` today). On a raycast hit, it reads the triangle's `_batchid` attribute (three.js lower-cases custom attributes) and resolves the feature. A comment or selection stores `{ modelId, sourceId, instancePath, featureId }`.

### Coverage, warnings and errors

Readers count source objects, rendered objects and skipped objects separately. The UI shows "N objects could not be converted" with the reasons. Partial output is never presented as complete.

| Warning code                 | Meaning                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `missing_render_mesh`        | A solid had no mesh in the file and our mesher could not cover it                              |
| `approximate_mesh`           | Our fallback mesher produced the triangles                                                     |
| `unsupported_entity`         | Entity type with no reader support (ACIS solid, proxy, NURBS curve and so on), counted by type |
| `skipped_annotation`         | Curves, text, dimensions, hatches, points                                                      |
| `hidden_skipped`             | Objects on hidden layers or marked hidden                                                      |
| `units_assumed`              | No unit in the file; a default was applied                                                     |
| `material_approximated`      | Textures or PBR data reduced to a colour                                                       |
| `external_reference_missing` | Xref, external texture or `.bin` not provided                                                  |
| `instance_depth_limit`       | Nested instances deeper than the limit were cut                                                |

`ConversionWarning = { code, count, sampleSourceIds?: string[] }`, with at most 20 samples per code.

Errors use `MODEL3D_ERROR_CODES` in `packages/dotcom-shared/src/model3d/api.ts`. New codes:

| Error              | When                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `no_render_meshes` | 3DM: nothing renderable, even after the fallback mesher                                           |
| `no_geometry`      | Any format: the file parsed but has no triangles or meshable entities (for example a 2D-only DWG) |
| `source_required`  | Retry after the source was deleted; the user must pick the file again                             |
| `source_mismatch`  | The re-selected file's hash differs from the ghost reference                                      |

## Manifest v2

```ts
interface Model3dManifestV2 {
	version: 2
	bounds: { min: Vec3; max: Vec3 } // GLB space
	units: 'm' // GLB is always metres
	transform: {
		sourceToModel: Mat4 // column-major
		sourceUpAxis: 'y' | 'z'
	}
	triangleCount: number
	nodeCount: number
	meshes: { name: string; triangleCount: number }[]
	textureBytesEstimate: number
	glbBytes: number
	source: GhostReference
	features: { schemaVersion: 1; count: number; attribute: '_BATCHID'; storage: 'glb-asset-extras' }
	coverage: { sourceObjects: number; renderedObjects: number; skippedObjects: number }
	warnings: ConversionWarning[]
	converter: {
		name: '@tldraw/model-converter'
		version: string
		runtime: 'service' | 'browser'
		readers: { name: string; version: string }[] // e.g. rhino3dm 8.35.0, web-ifc 0.0.78
		optimizer: { name: 'gltfpack'; version: string; args: string[] }
		settingsHash: string // reader versions + optimizer args + unit choice + mesher settings
	}
	artifacts: { glb: { bytes: number; sha256: string } }
}
```

The route validator accepts v1 and v2. v1's `recentreOffset` is never reinterpreted as v2.

## Ghost reference

What we keep about the original, instead of the original itself.

```ts
interface GhostReference {
	filename: string
	bytes: number
	sha256: string
	format: Model3dSourceFormat
	formatVersion?: string
	fileLastModifiedMs?: number // from the browser File, not the document
	authoring?: { application: string; version?: string }
	document?: { revision?: string; createdAt?: string; modifiedAt?: string; createdBy?: string }
	units: { name: string; metresPerUnit: number | null; basis: 'file' | 'user' | 'assumed' }
	basePoint?: Vec3 // source units
	georeference?: {
		latitude: number
		longitude: number
		elevation: number
		north?: [number, number]
		crs?: string
	}
	counts: {
		objects: number
		rendered: number
		skipped: number
		layers: number
		definitions: number
	}
	sourceIdsHash?: string // SHA-256 of the sorted source object IDs
	provenance: 'service' | 'browser'
}
```

Never store the user's absolute local path or the file contents.

### Database columns (`model` table)

| Column                                         | Purpose                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `sourceSha256`                                 | Exact-file lookup, index `(owningGroupId, sourceSha256, sourceBytes)`        |
| `sourceReference`                              | JSONB ghost reference, available before the manifest exists                  |
| `sourceState`                                  | `staged`, `delete_pending`, `deleted`, `never_uploaded` (browser conversion) |
| `lineageId`, `parentModelId`, `revisionNumber` | Revisions of one model; unique `(lineageId, revisionNumber)`                 |
| `conversionSettingsHash`                       | Reuse only when source hash and settings both match                          |

### Source lifecycle (service conversion)

1. The client hashes the file (in a worker, incrementally for large files) and sends the ghost reference with `create`.
2. The source uploads to `m/{modelId}/source/{attemptId}`.
3. The converter fetches the source, hashes it, and fails with `source_mismatch` if the hash differs from the declared one.
4. On `ready`: one transaction commits the result and sets `sourceState = delete_pending`, then the source is deleted. A sweep retries failed deletes and removes abandoned multipart uploads.
5. On a terminal failure: delete the source. A retry returns `source_required`, the client asks for the file and checks its hash.

Browser conversion never uploads the source. `sourceState = never_uploaded` and `provenance: 'browser'`. The server validates the uploaded GLB as untrusted input: chunk structure, no external URIs, feature table consistent with `_BATCHID`, size and hash match.

### Matching a re-upload

1. Same `sha256` and `bytes`: same file. Reuse the ready model if `conversionSettingsHash` matches; otherwise convert again under the same lineage.
2. Different hash: a new revision only when the user chooses "new revision of…". Rank the suggestions by filename stem, authoring document revision, and `sourceIdsHash` or ID overlap.
3. Comments carry over to a new revision by `sourceId` (plus `instancePath`). If the ID is gone, the comment stays on the old revision, marked unmatched. Nothing moves silently.

## Limits

From `sync-worker/src/routes/models/modelConfig.ts`: source 1 GiB, GLB 512 MiB, 50 million triangles, 30-minute timeout. The converter child gets an 8 GiB V8 heap. gltfpack is wasm32 (4 GiB address space at most). The prototype measured a 720 MB input at about 3.7 GB RSS and a 1.8 GB input trapping. Browser conversion starts at a 64 MiB source limit, to be tuned on real hardware.

## Third-party notices

`apps/dotcom/model-converter/THIRD_PARTY_NOTICES.md` lists every library whose licence asks for a notice, with the full licence text. It is bundled with the client when browser conversion ships. Each format spec has a "Dependency and licence" section saying what goes in it.
