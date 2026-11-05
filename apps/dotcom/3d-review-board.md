# 3D review board: models on the canvas

Status: proposal, 2026-11-02, revised after five council rounds. Research by five agents (renderer and formats, tldraw integration, Cloudflare backend, TanStack fit, competitor and BCF review), checked against the code in this worktree, then reviewed over five rounds by GPT-6 Astra and GPT-6.1 Sol.

## Decisions in one list

- Renderer: three.js with `WebGLRenderer`, version pinned, loaded only when a viewer opens. No WebGPU in v1. three-mesh-bvh, clipping planes and 3D Tiles are phase 2 tools, not v1 dependencies.
- Runtime format: one meshopt-compressed GLB per model version (`KHR_mesh_quantization`, `EXT_meshopt_compression`, `EXT_mesh_gpu_instancing`, KTX2 textures) produced by gltfpack, plus a small versioned manifest. Models above measured limits are rejected with a clear message. Chunked delivery through 3D Tiles is deferred.
- Conversion: one Docker image with a job API (start with signed GET and PUT URLs, heartbeat, completion callback). It runs in Cloudflare Containers driven by a Workflow by default. If the spike shows real IFC files need more than 12 GiB, the same image runs on Modal or Fly Machines behind the same job API. One runner at a time, never two.
- v1 input formats: IFC (2x3, 4, 4.3) and self-contained GLB first. OBJ and STL follow once the main flow works. FBX, 3DM, loose glTF with external files, RVT and SKP are deferred.
- Thumbnails: captured from the viewer's own renderer on the first successful render, uploaded once per model version. No separate OffscreenCanvas renderer in v1, no Browser Rendering.
- Canvas integration: two custom shapes. `model3d` is the thumbnail that references a backend model by id. `model3d-revision` is a frame-like shape whose body is the snapshot and whose children are the sketch strokes. The 3D viewer is a React overlay in `InFrontOfTheCanvas`, not a route and not a tool.
- Revisions: drafts live in the board document and are editable. Publishing freezes the strokes, exports a transparent PNG, and writes an immutable `revision` row (camera, snapshot key, overlay key, `supersedesRevisionId`). The overlay is a backend artifact, not a tldraw asset. The camera is stored in a BCF 3.0 compatible shape.
- Sketching is editor-only in v1. Comment-only reviewers can open the viewer and see revisions but cannot sketch. This is an explicit product decision, revisited in phase 2.
- Ownership: models belong to a workspace (`owningGroupId`), the same way files do. No `project` table or project screens in v1. A project grouping can be a column added later.
- Backend: a small `model-worker` for conversion control, upload signing and artifact delivery. Identity and board access decisions stay in the sync worker and are reached through a service binding. Five new Postgres tables replicated through Zero. Two new R2 buckets. Multipart presigned uploads straight to R2. GLBs served from an R2 custom domain behind a cache rule and an HMAC gate.
- Not adopting: TanStack, xeokit, Autodesk APS Viewer, WebGPU in v1, SharedArrayBuffer and cross-origin isolation.

## Decisions the owner makes before implementation

1. Editor-only sketching in v1 (recommended) or comment-only reviewers sketching at launch. The second choice moves revisions to Postgres-backed records now and cuts other phase 1 work.
2. Whether sharing a board by link exposes the exact model versions attached to it (recommended, with a per-board toggle) or never exposes models to link guests.
3. Whether the snapshot copied onto a board as a normal image asset may live in the public uploads bucket (recommended, since the board itself is what is being shared) or must stay private.
4. The supported model size for launch, set from spike measurements, and the matching rejection message.
5. Staffing. The phase 1 estimate assumes two engineers who already know this repository.

## User flow

1. The user drops an IFC or GLB on a board. The client starts a multipart upload to R2, creates a `model3d` shape in a pending state, and the server records a `board_model` grant. Conversion status reaches the shape through Zero.
2. When conversion finishes, the first client to open the model captures a 512 px WebP thumbnail from the viewer and uploads it. Until then the shape shows the bounding box and triangle count from the manifest.
3. The user presses play on the shape or double-clicks it. A three.js overlay covers the canvas area. The toolbar is hidden, the editor is blurred so shortcuts stop, and sync stays connected. The user orbits, pans and zooms. On exit the last camera is saved per user, and the shape's shared default view can be updated by an explicit action.
4. In 3D the user presses lock. The client reads the WebGL canvas into a PNG, uploads it as an image asset, creates a `model3d-revision` shape sized to the viewport, points the tldraw camera at it, locks the camera, hides every other shape, and pauses the overlay. The user sketches with the normal tools. New strokes parent into the revision shape.
5. The user presses publish. The client freezes the stroke set, exports it with a transparent background, uploads the PNG under a publish request id, and the server writes a `revision` row. Back in 3D, the viewer animates to the saved pose, letterboxes to the saved aspect ratio, and shows the overlay. The overlay hides as soon as the camera changes.

## Client 3D stack

### Renderer

three.js (MIT, r187 as of late October 2026, about 186 KB min+gzip for the WebGL build) loads meshopt, Draco, KTX2, GPU instancing and quantization through `GLTFLoader`. A three.js forum project from August 2026 renders a 37M-triangle building at 60 FPS, but it uses `BatchedMesh`, LOD and a BVH. That proves the engine can reach the scale, not that a plain GLB load will. The spike measures what plain loading does on our files.

Why not the others:

- Babylon.js (Apache-2.0) has the most mature WebGPU path and clip planes and gizmos, but it does not remove any of the integration work, and it has no BIM tooling. It is the fallback if WebGPU-first becomes a requirement.
- That Open Engine (MIT, three.js based) ships a clipper, measurement, highlighter, BCF topics and its Fragments format. Fragments is its own data and rendering pipeline, so adopting it later is a real integration, not a plug-in. It becomes relevant when element properties, sections and measurement are required.
- xeokit has the best BIM feature fit but is AGPL-3.0 with a paid commercial license.
- Autodesk APS Viewer is proprietary, must load from Autodesk, and bills Flex tokens per translation.
- Speckle viewer 2 targets Speckle's pre-2026.9 data format and viewer 3 is unreleased.
- model-viewer, PlayCanvas, Filament, Needle, Zea, Bevy: single-model widgets, game engines, stale web packages, paid seats, or multi-MB WASM with their own event loops.

WebGPU waits because the r187 WebGPU backend draws `BatchedMesh` as a loop of `drawIndexed` calls (no multi-draw indirect, which Chrome exposes only behind a flag), some addons do not support it, and Chrome on Linux enables WebGPU by default only on recent Intel and NVIDIA under Wayland.

### Runtime format

Meshopt over Draco:

|                          | Meshopt                    | Draco                                                      |
| ------------------------ | -------------------------- | ---------------------------------------------------------- |
| Decoder in three.js repo | 29 KB inline WASM          | 192 KB WASM plus 58 KB wrapper                             |
| Decode speed             | 1 to 3 GB/s with WASM SIMD | slower; glTF-Transform calls meshopt "considerably faster" |
| Vertex order             | preserved                  | reordered, lossy                                           |
| Written by gltfpack      | yes                        | no                                                         |

Meshopt output is meant to be brotli or gzip compressed on the wire. `model/gltf-binary` is not in Cloudflare's default compressible types, so the models host needs an explicit compression rule, or the converter stores pre-compressed objects with the right `Content-Encoding`.

gltfpack in v1 merges meshes for draw-call count. Element identity (`-kn -ke`, or `_FEATURE_ID` attributes) is a phase 2 trade-off, because keeping named nodes restricts merging. `-mi` writes GPU instancing. `-tc` writes KTX2 (the 527 KB transcoder loads only when a model has textures). gltfpack does not accept Draco-compressed input, so the converter runs glTF-Transform first to validate and decompress uploaded GLBs. glTF positions are float32, so georeferenced models are recentred on the server and the full transform (offset, units, axis convention per source format) is stored in the manifest.

The manifest (`manifest.json`, versioned) holds bounds, units, the coordinate transform, converter version and arguments, artifact hashes, triangle and node counts, texture memory estimate, and the thumbnail key.

Chunked delivery is deferred. 3D Tiles ADD refinement adds child content to parent content, so it does not by itself reduce the geometry drawn in a whole-building view. It helps loading and culling, not frame rate, and it is the wrong first tool. The CDN caches objects up to 512 MB on non-Enterprise plans, which sets the hard ceiling for a single GLB.

### Chromium-first APIs

- Compression Streams can gzip IFC before upload. Deferred from v1; multipart upload is enough.
- File System Access for directory drops and `FileSystemObserver` re-upload prompts are phase 2.
- WebCodecs has no still-image encoder. Use `convertToBlob`.
- No SharedArrayBuffer. COOP and COEP would break tldraw's iframe embeds and Clerk. The meshopt, Draco and Basis decoders are believed to work without it. The spike confirms this.
- WebGPU is revisited once multi-draw indirect ships in stable Chrome.

## Source formats and conversion

| Format                   | Tool                                                                       | License                | Phase                         |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------- | ----------------------------- |
| IFC 2x3, 4, 4.3          | IfcConvert (IfcOpenShell) writes GLB; web-ifc as a fallback                | LGPL-3.0; MPL-2.0      | v1                            |
| GLB, self-contained      | glTF-Transform validate and decompress, then gltfpack                      | MIT                    | v1                            |
| OBJ, STL                 | OBJ through gltfpack directly; STL through assimp or trimesh to glTF first | MIT, BSD-3             | v1, after the main flow works |
| glTF with external files | package validation and path safety first                                   | MIT                    | phase 2                       |
| FBX                      | headless Blender (ufbx importer), separate process                         | GPL (process boundary) | phase 2                       |
| 3DM                      | rhino3dm, render meshes only                                               | MIT                    | phase 2                       |
| DAE                      | assimp (Blender 5 removed COLLADA)                                         | BSD-3                  | phase 2                       |
| USD, USDZ                | OpenUSD or Blender                                                         | Apache-2.0             | phase 2                       |
| STEP                     | OCCT                                                                       | LGPL-2.1               | phase 2                       |
| RVT                      | Autodesk APS Model Derivative to IFC, then IfcConvert                      | paid                   | phase 2                       |
| SKP                      | no Linux SDK; users export FBX, OBJ or USDZ                                | n/a                    | phase 2                       |
| DWG, DXF                 | 2D underlays; 3D solids need ODA or APS                                    | paid                   | later                         |
| E57, LAS, LAZ            | PDAL to COPC, separate point renderer                                      | BSD                    | later                         |

gltfpack reads only `.gltf`, `.glb`, `.obj` and `.ply`. Every other format needs an importer before it.

### The converter contract

The converter is one Docker image exposing a job API. A job starts with a signed GET URL for the source, signed PUT URLs for artifacts, a job id and limits. It heartbeats every few seconds with stage and percent, and calls back on completion with artifact hashes. Repeated start requests with the same job id are no-ops.

Limits the converter enforces, with values set by the spike: source bytes, expanded input bytes, decoded triangle count, texture dimensions, disk use (Containers give 20 GB, which must hold source and intermediates), wall time, memory, and concurrent jobs per workspace. It never fetches external resources referenced by a file. It records converter version, arguments and artifact hashes in the manifest. Bad input fails with a user-safe error code; details go to Sentry.

### Where it runs

Cloudflare Containers have been generally available on the Workers Paid plan since 2026-04-13. The largest instance is 4 vCPU, 12 GiB memory and 20 GB disk. Billing is per 10 ms of use. A Workflow drives the job: mark `converting`, mint URLs, start the container, poll with `step.sleep`, verify artifacts with `head`, publish the `derived_artifact` rows and flip status in one transaction, and guarantee a terminal state with a final catch step. Queue consumers are the wrong tool because of their 15-minute wall limit.

The council split on this. One reviewer prefers Containers because they fit the existing platform. The other prefers an external runner first because 12 GiB is an avoidable IFC risk (one public report shows a 7 GB IFC exhausting 64 GB). The middle ground is the job API above. The spike runs the largest IFC we expect through the image. If it fits in 12 GiB with headroom, Containers. If not, the same image runs on Modal (32 GiB configurations are documented) or Fly Machines (Fly already hosts zero-cache), started through the outbox with an authenticated completion callback and a recovery sweep for lost callbacks. Containers also run locally through `wrangler dev` with Docker, so local development is the same either way.

## tldraw integration

### Shapes

`model3d` extends `BaseBoxShapeUtil`. Props: `w`, `h`, `modelId`, `modelVersion`, `assetId` (the thumbnail as an ordinary `TLImageAsset`), `defaultView` (nullable camera), `altText`. The prop is named `assetId` because copy and paste (`Editor.ts`, asset collection), `.tldr` asset pruning in `TLFileDurableObject`, and `TLAssetShape` all inspect only `props.assetId`. It renders an `img` through `useImageOrVideoAsset`, which gives resized URLs from the image worker. Aspect ratio is locked. `toSvg` returns an `image` element like the video shape does. No live WebGL inside the shape; Chrome allows about 16 WebGL contexts.

The play button follows `HyperlinkButton`, which marks pointer events as handled. `onDoubleClick` opens the viewer and returns a no-op partial, because `Idle.onDoubleClick` otherwise creates a text shape. `canEditInReadonly` is true so view-only users can open the viewer.

`model3d-revision` extends `BaseFrameLikeShapeUtil`, which clips children and accepts new ones. Props: `w`, `h`, `modelId`, `modelVersion`, `assetId` (the snapshot), `pose`, `viewport` (`w`, `h`, `dpr`), `revisionId` (nullable until published), `pendingPublish` (nullable `{ requestId, strokeHash, startedAt }`, informational only; the server owns the lease), `name`. Hollow geometry so clicks reach the strokes. `isExportBoundsContainer` is true. Override `shouldClipChild` to clip arrows too; the base class exempts them. The revision shape is never locked, because a locked frame-like shape refuses children and locks every stroke inside.

The overlay PNG is not a tldraw asset and has no shape prop. It lives in R2 under the revision row, because copy, paste and export would not carry a second asset reference. A `.tldr` export therefore keeps the visible snapshot and strokes, and the 3D linkage works only where the backend row exists.

Revision ids are not stored on the model shape. The viewer lists revisions for a model from Zero rows. Two-way references drift under undo, paste and concurrent edits.

### Why not a model asset type

Asset types are pluggable in this fork (`AssetUtil`, `TLGlobalAssetPropsMap`, `handledAssetTypes`), and an example exists at `apps/examples/src/examples/data/assets/custom-asset-type`. We still reference models by id because the asset pipeline is wrong for them: uploads are bound to one board through `validateUpload` and `confirmUpload`, the client caps files at 10 MB (`DEFAULT_MAX_ASSET_SIZE`), MIME gating rejects `.ifc` (Chrome reports an empty type), the whole file is hashed on the main thread, and the worker buffers the body in a 128 MB isolate. Models are workspace-owned and converted asynchronously, which does not fit one `upload()` call that returns a URL.

Drops route through `SneakyTldrawFileDropHandler`, which already owns the single `files` handler in the dotcom client.

### The 3D overlay

Render the viewer in `InFrontOfTheCanvas`, next to `CommentsOnCanvas`, driven by a per-editor atom held in a `WeakCache<Editor, Atom>` like the commenting package does. The atom holds `{ shapeId, mode: 'orbit' | 'sketch' } | null`. It is not stored in `instance.meta`, because session state is persisted per user and would reopen the board in 3D.

Input handling:

- The in-front wrapper marks pointer down and up as handled.
- The wheel listener is bound to `.tl-canvas` only, so OrbitControls gets the wheel.
- Shortcuts live on `body` and are gated only on `isFocused`. Call `editor.blur({ blurContainer: false })` on enter and `editor.focus()` on exit. Do not touch `isReadonly`, which the sync mode reaction owns.
- Hide the toolbar while in 3D, or clicks switch tools underneath.
- Handle WebGL context loss: show a retry, do not leave a half-captured thumbnail.

A route was rejected because `TlaEditor` is keyed by `fileSlug` and leaving the subtree closes the socket. A `StateNode` tool was rejected because tools only receive canvas-routed events while three.js owns its own pointer stream. "Open in 3D" is exposed as an action through `useFileEditorOverrides`.

Camera persistence: the per-user last view goes to localStorage keyed by model version in v1, with a `file_state`-like table later. The shared default view is written to shape props with `editor.run(fn, { history: 'ignore', ignoreShapeLock: true })`, because writes to locked shapes are otherwise skipped silently. Presence `meta` can show who is in 3D.

### Lock, sketch, publish

1. Read the WebGL canvas in the same frame (or use `preserveDrawingBuffer`) at viewport size times device pixel ratio.
2. Create a `TLImageAsset` with `pixelRatio`, call `createTemporaryAssetPreview`, then `editor.uploadAsset`. Never inline data URLs. Rooms are capped at 25 MB.
3. Create the revision shape at viewport screen size near the thumbnail. Save the 2D camera, set the camera so the shape fills the viewport at zoom 1, call `setCameraOptions({ isLocked: true })`, and pause the overlay.
4. Hide every other shape through `getShapeVisibility`. The callback is captured once at construction, so it must read an atom, as the dotcom one does.
5. Sketch. Strokes parent into the revision through `canReceiveNewChildrenOfType`.
6. Publish. Generate a publish request id. Collect the frozen inputs in one synchronous read: the revision shape, its descendants, their bindings, and the snapshot asset record, plus a `strokeHash` over the descendant records. Call the server's begin-publish endpoint with the request id, `strokeHash`, camera, snapshot key, model ids and `supersedesRevisionId`. It creates a `publish_lease` row holding all of them with `status: active` and `expiresAt` five minutes out, so the server can finish the publish later without any further input from a client. Then write `pendingPublish: { requestId, strokeHash, startedAt }` to the shape with `history: 'ignore'`, so other clients can see that a publish is in flight and know which request id to ask the server about. The document never carries lease timing; the server does. The publishing client renews the lease while an upload is still running.
7. Export from an isolated editor, not the live one. `editor.toImage` reads the live store and waits for fonts, so concurrent edits would leak into the result. Mount a hidden `Tldraw` with a snapshot built from the frozen records, exactly as `thumbnail-render.tsx` does for board thumbnails, and call `toImage([revisionId], { format: 'png', background: false, padding: 0, pixelRatio: dpr, darkMode: false })` on that editor. Exporting a single frame-like shape skips the container, so the result is only the strokes, transparent and aligned (`getSvgJsx.tsx`). Dispose the hidden editor afterwards.
8. Upload the overlay to `rev/{requestId}/overlay.png`, then call the complete-publish endpoint with the request id only. On success the client sets `revisionId` and clears `pendingPublish` with `history: 'ignore'`. Restore the 2D camera and camera options.

The lease is server-owned. Every lease operation runs in one Postgres transaction that locks the `publish_lease` row (`SELECT ... FOR UPDATE`), so renewal, recovery, cancellation and completion cannot interleave:

- Renew: if `status` is `active` and not expired, extend `expiresAt`. Otherwise reject.
- Complete: if a `revision` row with this `publishRequestId` exists, return it (idempotent retry). Else if `status` is `active`, not expired, and the overlay object exists in R2, insert the `revision` row from the lease's stored inputs and set `status: completed` in the same transaction. Otherwise reject as late or cancelled.
- Recover: if completed, return the revision. If `active` and not expired, answer "in progress" and the caller waits. If expired and the overlay object exists in R2, insert the missing `revision` row from the lease's stored inputs, set `status: completed`, and return it. If expired without an overlay, or cancelled, set `status: expired` (or leave `cancelled`) and answer "not uploaded".
- Cancel: if `active`, set `status: cancelled`.

Recovery. Any client that sees `pendingPublish` on a shape calls recover with that request id; it needs nothing from the document except the request id, because the camera and keys were sent at begin or are derived from the request id. "In progress" means leave the shape alone and ask again later. A revision means set `revisionId` and clear `pendingPublish`. "Not uploaded" means clear `pendingPublish` so the user can publish again, which costs nothing because the strokes are still in the document. A stale view of the document cannot cause a wrong clear, because the server decides from its own lease row, and a publisher whose lease was marked expired by a recover call is rejected on complete. This covers upload succeeded but the row insert failed, row inserted but the client disconnected, reload mid-export, and any number of clients racing on recovery. Undo that removes the draft after publish leaves the row standing, and the shape can be recreated from it. `strokeHash` in the row records which stroke set the overlay shows, so a later edit to the draft is detectable. Leases older than 24 hours and their `rev/{requestId}/` prefixes without a revision row are swept.

### Schema and sync changes

- Put props, validators and migrations in a React-free module in `@tldraw/dotcom-shared`. Import it from the client store, every `Tldraw` mount, and the server schemas.
- Prop migrations use the sequence `com.tldraw.shape.<type>`. Open each new sequence with an identity migration that has no `down`, as comments do, so old clients get `CLIENT_TOO_OLD` instead of records they cannot validate.
- Server sites that build the default schema today and must add the shapes: `TLFileDurableObject.ts` (`createTLSchema({ records: commentSchemaRecords })`), `utils/validateSnapshot.ts`, `routes/tla/createFiles.ts`.
- Client sites: `useSync` in `TlaFileSyncHost.tsx` (passing `shapeUtils` replaces the defaults, so spread `defaultShapeUtils`), `embedShapeUtils` used by `TlaEditor`, `TlaPublishEditor`, `TlaLegacySnapshotEditor`, `TlaLegacyFileEditor` and `thumbnail-render.tsx`, plus `.tldr` import in `TldrawApp.ts` and `importFromUrl.ts`.
- Deploy the server first. A client with a sequence the server lacks gets `SERVER_TOO_OLD`.

Record authorizers run synchronously inside the commit with no I/O (`TLSyncRoom.ts`), so they cannot check model access against Postgres, and a vetoed create is silently skipped with the client self-correcting. The `model3d` shape therefore has no grant check in its authorizer. A model reference is allowed to exist in any document, granted or not, and the shape itself never conveys access. Access is enforced only by the server endpoints that serve manifests, GLBs and revisions, which require a `board_model` grant for the file. The grant is created by an attach endpoint after checking the caller can read the model and the exact version. A shape whose manifest request returns 403 renders a "no access, attach this model" placeholder.

Revision shapes ride the document lane, which `isReadonly` gates. Comment-only reviewers therefore cannot sketch in v1. Note that moving revisions to the object lane would not fix this by itself: the comment authorizer's `canComment` also defaults to `!isReadonly` and this app does not override it. Reviewer sketching needs an explicit server policy whichever storage is chosen.

## Backend

### Where things live today

Boards are `TLFileDurableObject` instances persisted to R2 `ROOMS`, capped at 25 MB. Images go through `tldrawusercontent-worker` into R2 `UPLOADS`, validated by the sync worker RPC `validateUpload` and queued as `asset` rows. The legacy `asset-upload-worker` is the unauthenticated path. Reads of uploads are unauthenticated and immutable, with no per-file authorization. Postgres is reached through Hyperdrive in staging and production and pgbouncer elsewhere. The Zero schema is `packages/dotcom-shared/src/tlaSchema.ts`, with synced queries in `queries.ts` and custom mutators in `mutators.ts`. Migrations are `apps/dotcom/zero-cache/migrations/NNN_name.sql` (latest 053), and a replicated table needs `ALTER PUBLICATION zero_data ADD TABLE`. Async work runs through a Queue and the trigger-written `effect_outbox` drained by `TLFileEffectProcessor`, which retries with attempt counts. There are no Workflows or Containers yet. The sync worker has a 1.55 MB bundle check.

### Tables

Follow existing conventions (varchar ids, bigint epoch milliseconds, camelCase, `isDeleted`).

- `model(id, owningGroupId, name, currentVersionId, createdBy, createdAt, updatedAt, isDeleted)`. Workspace-owned like `file`.
- `model_version(id, modelId, owningGroupId, number, sourceFormat, sourceBytes, status, stage, progress, errorCode, createdBy, createdAt)`. Status is `uploading`, `queued`, `converting`, `ready` or `failed`. `owningGroupId` is denormalized so every access check is one hop.
- `derived_artifact(id, modelVersionId, owningGroupId, kind, r2Key, bytes, contentType, sha256, meta)`. Kind is `glb`, `manifest`, `thumbnail`.
- `revision(id, modelId, modelVersionId, owningGroupId, fileId, shapeId, authorId, publishRequestId unique, supersedesRevisionId, strokeHash, camera, snapshotKey, overlayKey, createdAt, isDeleted)`. Published content is immutable. Deletion state is the only mutable field.
- `board_model(fileId, modelId, modelVersionId, grantedBy, createdAt)`. The server-side grant that authorizes a board to load a model version.

- `publish_lease(requestId primary key, fileId, shapeId, modelId, modelVersionId, authorId, strokeHash, camera, snapshotKey, supersedesRevisionId, status, expiresAt, createdAt)`. Server-only, not in the Zero publication. Status is `active`, `completed`, `expired` or `cancelled`. It holds every input a `revision` row needs, so recovery can insert a missing row without a client.

Server-only columns (`uploadId`, `errorDetail`, job ids) stay out of the Zero schema.

R2 keys are immutable: `m/{modelId}/v/{versionId}/source`, `.../model.glb`, `.../manifest.json`, `.../thumb.webp`, `rev/{publishRequestId}/snapshot.png`, `rev/{publishRequestId}/overlay.png`.

Attachment rules: the document may contain `model3d` shapes with or without a grant, because the sync authorizer does not check grants. Pasting or duplicating a shape into another board creates an ungranted reference, which renders as "no access, attach this model" until a member with access calls the attach endpoint. Deleting a board deletes its grants. Revoking workspace membership stops new manifest requests immediately. Unlinking a model from a board deletes the grant and the shape keeps showing its cached thumbnail.

### Upload

Workers cap request bodies at 100 MB on Free and Pro plans and isolates have 128 MB, so bytes never pass through a Worker. The model worker signs R2 S3 multipart operations with `aws4fetch`. The browser PUTs 64 MiB parts, four in flight, with one-hour URLs. Resume uses ListParts. An R2 lifecycle rule aborts incomplete uploads and a sweep removes `uploading` versions older than 24 hours. The bucket needs CORS allowing PUT and exposing `ETag`. Presigned URLs work only on the S3 domain, not custom domains. Completing an upload is idempotent per version and starts at most one conversion job.

### Serving

`models.<zone>` is an R2 custom domain (r2.dev supports neither cache nor WAF). A cache rule sets a one-year edge TTL and ignores the query string. `POST /app/models/:versionId/manifest?fileId=` checks the `board_model` grant and returns the manifest plus a GLB URL with a ten-minute `?verify=` HMAC that a WAF rule validates with `is_timed_hmac_valid_v0`. The WAF runs before the cache, so cached bytes stay gated. That function needs a Pro plan or above. If the plan is lower, a Worker validates the same HMAC and passes through. Token expiry limits how long a leaked URL works; it does not revoke bytes already in a browser cache or saved to disk. CORS echoes only app origins and exposes `Content-Range`, `Content-Length` and `ETag`. The client CSP gains the models host in `connect-src` and `'wasm-unsafe-eval'` in `script-src`.

### Thumbnails, snapshots, overlays

Thumbnails are captured from the viewer's first successful render with a first-writer-wins conditional PUT, and retried if the first client closes or loses its GL context. Browser Rendering is not used because its sessions have no GPU and would load the full GLB inside a billed session; its idle timeout (60 seconds by default, extendable to 20 minutes) is not the reason. Snapshots and overlays go to `POST /app/models/:modelId/revisions`, two PNGs of at most 10 MB each, checked by signature, written to the private artifacts bucket. When a revision is placed on a board, the snapshot is also copied in as a normal image asset so link guests see the board; that copy lands in the public uploads bucket, which is decision 3 above.

### Permissions

Model access is membership in `model.owningGroupId`, with new capabilities such as `uploadModels` and `attachModels` in `capabilities.ts`. Synced queries use a single `exists` gate, because `queries.ts` documents Zero union fan-in bugs with OR gates. A viewer of a shared board can fetch manifests only for model versions in that board's `board_model` rows, which is decision 2 above.

### Local development

Add `model-worker` to `process-compose.yaml`. Containers run locally through `wrangler dev` with Docker. Miniflare R2 has no S3 endpoint, so a dev route uses the binding's `createMultipartUpload` behind the same client uploader. A dev route streams from R2 with Range and checks the same HMAC. Previews call the staging converter.

## Revision model and BCF

A revision maps to a BCF 3.0 viewpoint. Stored camera: projection type, eye position (float64, model coordinates), target, up vector, vertical field of view in degrees for perspective or view height for orthographic, aspect ratio, snapshot pixel size, and the model version plus transform. BCF stores the same fields (`CameraViewPoint`, `CameraDirection`, `CameraUpVector`, `FieldOfView`, `AspectRatio`, `ViewToWorldScale`) and allows one snapshot of at most 1500 px on the long side. Section planes and visibility join the camera in phase 2.

Showing the sketch back in 3D uses a screen-space overlay at the saved pose, letterboxed to the saved aspect ratio, hidden as soon as the camera changes, with a return-to-view action. A billboard quad is misplaced as soon as the camera moves because near and far strokes cannot share one plane. Depth projection onto geometry breaks over sky and openings and distorts text. Pins placed by raycasting are deferred for the same reason.

Lessons taken from the competitor review: the camera pose is the source of truth and the snapshot is metadata; published revisions are immutable; markup is anchored to the viewpoint, not geometry; element identity needs IFC GUIDs with a fallback; per-view state is bounded (BCF warns above 1000 components); round trips are lossy, so BCF import gets fixtures before any promise.

## Phasing

The lane-by-lane implementation plan, with file ownership and instructions for parallel work, is `3d-review-board-implementation.md` next to this file.

Week 1, spike, before any product code: run three representative customer models (the largest IFC we expect, a typical IFC, a large GLB) and one deliberately bad file through the converter image. Measure conversion memory, disk and time, then in a standalone three.js page measure load time, draw calls, decoded geometry and texture memory, peak browser memory, frame rate and time to first interaction on a mid-range laptop GPU. Confirm the decoders run without SharedArrayBuffer. Pick the runner and set the launch limits from these numbers.

Weeks 2 to 3: workspace-owned models, private multipart upload, conversion status through Zero, one GLB plus manifest, `model3d` shape, viewer overlay, client thumbnails, server and client schema registration, grant endpoint and manifest endpoint.

Weeks 4 to 5: lock, sketch, publish with the request id protocol, immutable revisions, return-to-view overlay with letterboxing, reload and disconnect recovery, viewport size changes.

Weeks 6 to 8: IFC in production, permissions, copy and import behavior, cleanup sweeps, clear failure states, OBJ and STL if time allows, customer acceptance on real files.

Phase 2: FBX, 3DM and loose glTF, element identity and picking, section planes and measurement (three-mesh-bvh or That Open), 3D Tiles for very large models, BCF export, revision history views, RVT through APS to IFC, reviewer sketching policy, project grouping and screens.

Deferred without a date: SketchUp native import, point clouds, WebGPU, depth-projected strokes, pins, file watching, upload compression, fly-through video export.

## Risks

1. IFC conversion memory on real files. Mitigated by the runner decision gate in week 1.
2. three.js frame rate and memory on large plain GLBs on integrated GPUs. Measured in week 1; launch limits follow the numbers.
3. The 25 MB room cap and 1 MB sync message chunking under long sketch sessions. Draw shapes are dense.
4. Shared boards exposing model versions to link guests, and public snapshot copies. Both are owner decisions above.
5. Schema deploy ordering across five client mounts and three server schema sites. One missed site rejects boards.
6. Publishing spans three stores. The request id protocol covers the failure cases, but this is still the hardest client code in phase 1.
7. API churn in three.js (removals each release from r183 to r187). Pin the version.
8. Unrelated but pending: react-router v6 reached end of life in June 2026 and the client pins `^6.28.2`. Upgrade to v7 or v8 as a separate chore.

## Rejected options

- TanStack: react-router stays (upgrade pending). Zero covers synced data and would conflict with Query or DB caches. TanStack Virtual or Table may appear on a model library or an admin jobs table later. Forms stay native plus zod.
- xeokit (AGPL), APS Viewer (proprietary, token billing), Speckle viewer (format transition), WebGPU in v1 (no multi-draw indirect), Browser Rendering thumbnails (no GPU), 3D Tiles in v1 (does not reduce drawn geometry), a separate route (closes the socket), a `StateNode` tool (no access to the three.js pointer stream), a `TLModelAsset` (asset pipeline limits), locking the revision frame (locks the strokes), an `overlayAssetId` prop (copy and export carry only `assetId`), a `project` table in v1 (workspace ownership is enough).

## Changes after council round 1

- Dropped 3D Tiles chunking, FBX, 3DM and loose glTF from v1. Formats are IFC and GLB first, OBJ and STL after.
- Replaced the fixed Containers choice with a runner-neutral converter image and a week 1 decision gate.
- Removed the `project` table and project screens; models are workspace-owned.
- Removed `overlayAssetId`; the overlay is a backend artifact. Added `revisionId` to the revision shape.
- Added the publish request id protocol and its failure cases, `supersedesRevisionId`, and the `board_model` grant endpoint with paste, duplicate, delete and revoke rules.
- Added the converter contract (limits, no external fetches, recorded versions and hashes, full transform).
- Added arrow clipping override, letterboxing, hide-on-camera-change, and GL context loss handling. Dropped pins.
- Corrected gltfpack inputs (no STL, no Draco input), Containers local development, and the Browser Rendering timeout statement. Added the explicit compression rule for `model/gltf-binary`.
- Listed the five owner decisions and made editor-only sketching explicit.

## Changes after council round 2

Both reviewers scored the revised plan 8/10, accepted the runner middle ground, and named the same two gaps.

- Removed the grant check from the shape authorizer. Ungranted model references are legal in the document; only the manifest, GLB and revision endpoints enforce `board_model`. This resolves the conflict with the paste placeholder rule.
- Made publishing durable and frozen. `pendingPublish` is written to the shape before any upload, the export runs in a hidden isolated editor built from frozen records (the `thumbnail-render.tsx` precedent), the overlay key is derived from the request id, the server verifies the overlay exists before inserting the row, and `strokeHash` records which strokes the overlay shows.

## Changes after council round 3

Sol confirmed both blockers closed at 9/10. Astra confirmed the authorizer fix and found a recovery race: a second client could see `pendingPublish` before the upload finished, receive "not uploaded", and clear it mid-publish.

- Added an expiring lease. First as `expiresAt` in the shape props; Astra then showed in round 4 that a client reading a stale `expiresAt` from the document could still clear a renewed attempt. The lease is now a server-owned `publish_lease` row, and renew, complete, recover and cancel each run in one transaction that locks that row. The document carries only the request id. Sol's round 4 asked for the same server-owned lease and added that recovery must be able to insert a missing revision row when the overlay was uploaded but completion never arrived; the lease row stores every input for that.
