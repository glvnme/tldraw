# 3D review board: phased implementation plan

Status: plan, 2026-11-02. Companion to `3d-review-board.md`, which holds the design and the reasons behind it. This file says who builds what, in which order, and how several people or agents work on it at the same time without editing the same files.

Week numbers count from the first Monday after the owner approves the design. Each phase ends in a checkpoint with exit criteria. Nothing ships to users until phase 3; everything before that merges to `main` behind the `models_3d` feature flag, off by default.

## Local prototype track (current)

Decided 2026-11-02 by the owner: Weave is a solo local project with no users. The first build is a lean, fast local prototype. Where this section and the rest of this file or the design doc disagree, this section wins. The lane plan below stays as the reference for a later production build.

1. Local only. No feature flag, no deploy scripts, no preview or staging work, no Cloudflare Containers, no WAF or CDN rules.
2. No new worker. Model routes live in the sync worker under `/app/models/*` with a new `MODELS` R2 bucket binding.
3. One server-only Postgres table, `model`, in migration `054_models.sql`, typed in the `DB` interface but not in the Zero schema or publication. Columns: `id`, `owningGroupId`, `createdBy`, `name`, `sourceFormat`, `sourceBytes`, `status` (`uploading`, `queued`, `converting`, `ready`, `failed`), `stage`, `progress`, `errorCode`, `manifest` (jsonb), `uploadId`, `createdAt`, `updatedAt`. The client polls `GET /app/models/:id` while the status is not terminal.
4. Upload goes from the browser through the sync worker into the R2 binding's multipart API. No presigned URLs.
5. The converter is a Node service, `apps/dotcom/model-converter`, on localhost, started by `process-compose.yaml`. The worker posts a job to it. The converter pulls the source and pushes `model.glb` and `manifest.json` back through worker routes authorized by an HMAC job token (WebCrypto, no package), and reports stage, progress and the terminal state. IFC goes through web-ifc. STL is parsed natively. OBJ and GLB go straight to gltfpack. A small native GLB writer feeds gltfpack. One job at a time, each in a child process so a crash cannot take the service down.
6. Access is membership in the model's owning workspace, checked with the existing role helpers. The GLB is fetched with the user's bearer token. A shape pasted into another workspace renders the no-access placeholder.
7. Thumbnails are captured by the viewer and uploaded through the normal tldraw image asset path, which sets the shape's `assetId`. No backend thumbnail route. The capture is the `defaultView` camera (or a fit when there is none) on a transparent background, trimmed to the model, and the shape takes the image's aspect so it renders like an image shape. Set as default view re-captures and replaces `assetId`.
8. Revisions live in the board document only. No `revision` table, no publish lease, no overlay object in R2. A `model3d-revision` shape holds the snapshot asset, the camera pose and the viewport, and its children are the strokes. Publishing sets `publishedAt` and `strokeHash` and locks the stroke children. The viewer lists the revision shapes for the model on the current board and renders the overlay by exporting the revision's children with `editor.toImage`, cached by `strokeHash`.
9. Camera: per-user last view in localStorage, shared `defaultView` in the shape props.
10. Tests only where the logic is pure and cheap: the GLB writer, the STL parser, upload part planning, the job token, `strokeHash`. One manual check script per stage. No e2e until the flow is complete.
11. Prefer platform APIs and code we own over new packages. The allowed new runtime packages are `three` on the client, and `web-ifc` and `gltfpack` in the converter.

Stages, each a commit series on the integration branch, each reviewed before the next starts:

| Stage            | Content                                                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, core baseline | Shared `model3d` module in dotcom-shared (shape props and migrations, manifest type, API types, job token helpers), schema registration at every server and client site, placeholder shape utils, overlay mount and hidden-shapes atom in `TlaEditor`, migration 054 |
| 2a, backend      | Sync worker model routes, `MODELS` binding, converter service, process-compose entry                                                                                                                                                                                 |
| 2b, viewer       | Drop handler, uploader, `model3d` shape, three.js overlay, thumbnails, camera persistence                                                                                                                                                                            |
| 3, revisions     | Lock, sketch, publish, revision overlay in the viewer                                                                                                                                                                                                                |
| 4, hardening     | Fixes from the milestone reviews, failure states, one e2e scenario                                                                                                                                                                                                   |

## How the work is split

Six lanes. Each lane is one git worktree, one branch, one owner (an engineer or an agent thread), and a series of small pull requests into one integration branch, `feat/3d-review-board`.

| Lane | Name                       | Area                                                                                 | Runs in      |
| ---- | -------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| A    | Contracts and plumbing     | `packages/dotcom-shared`, schema registration, migration, flag, fixture worker       | week 1       |
| B    | Model shape and viewer     | `model3d` shape, drop handler, three.js overlay, thumbnails, uploader client         | weeks 2 to 5 |
| C    | Model worker               | upload signing, conversion control, manifest and GLB serving, grants, leases, sweeps | weeks 2 to 6 |
| D    | Converter image            | Docker image with the job API, IFC, GLB, OBJ, STL pipelines, the spike               | weeks 1 to 7 |
| E    | Revision shape and publish | `model3d-revision` shape, sketch mode, frozen export, publish, recovery              | weeks 3 to 5 |
| F    | Permissions and acceptance | capability checks, link guest rule, failure states, e2e, user manual                 | weeks 6 to 8 |

Four rules keep the lanes apart:

1. Lane A owns every shared file (the table in "Shared files and their owners" below). Other lanes never edit those files. When a lane needs a change there, it stops and reports the exact change; lane A, or the integration owner once lane A has closed, makes it in a separate pull request.
2. Lanes talk to each other only through the contracts in `packages/dotcom-shared/src/model3d/` and through the model worker's fixture mode. A contract change is a lane A pull request first, then the lanes that depend on it rebase.
3. No lane changes `packages/*` SDK packages in phases 1 to 3. The whole feature lives in `apps/dotcom/*` and `packages/dotcom-shared`. An SDK gap is reported, not patched in place; the integration owner handles it as a separate pull request with `pnpm api-check`.
4. Every pull request runs its lane's checks plus `pnpm typecheck` from the repo root, and rebases on the integration branch at least daily.

Each lane section below is written so it can be pasted as a brief to an engineer or an agent: goal, what it owns, what it must not touch, the contract it implements, what it runs against, the work items, the checks, and the done criteria.

## Timeline

| Week | Active lanes | Milestone                                                                                                  |
| ---- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| 1    | A, D         | Contracts frozen, fixture worker boots, spike numbers, runner decided, owner decisions 1, 4 and 5 recorded |
| 2    | B, C, D      | Real upload path and viewer against the fixture worker                                                     |
| 3    | B, C, D, E   | Checkpoint 1: drop, upload, convert, thumbnail, orbit, on a preview deploy                                 |
| 4    | B, C, E, D   | Lease endpoints, sketch mode, frozen export                                                                |
| 5    | B, C, E      | Checkpoint 2: publish round trip survives reload, disconnect and a second client                           |
| 6    | C, D, F      | IFC conversion in staging on the chosen runner                                                             |
| 7    | D, F         | Permissions, failure states, e2e scenario, OBJ and STL if lane D is done                                   |
| 8    | F            | Checkpoint 3: acceptance on three customer files, flag on for the pilot workspace                          |

## Phase 0, week 1: contracts, skeletons, spike

Lanes A and D start on day 1 and do not depend on each other. The week ends with a 30 minute gate meeting: spike numbers, the runner decision, and owner decisions 1, 4 and 5 written into the decisions section of the design doc. Lanes B, C and E start on Monday of week 2 whichever runner wins, because the job API is the same.

### Lane A: contracts and plumbing

Goal: land every shared type, every schema registration site, the migration, the feature flag and a model worker that answers from fixtures, so the other lanes can build without touching shared files.

Owns: everything in the shared files table. Nothing else.

Does not touch: `apps/dotcom/model-converter/`, the bodies of the two shape utils beyond a placeholder render, any viewer code.

Work items:

1. `packages/dotcom-shared/src/model3d/`, React-free. `shapes.ts` holds the props validators and migrations for `model3d` and `model3d-revision` exactly as the design lists them, plus `model3dShapeSchemas`, an object the server spreads into `createTLSchema({ shapes: { ...defaultShapeSchemas, ...model3dShapeSchemas }, records: commentSchemaRecords })`. Each migration sequence is `com.tldraw.shape.<type>` and opens with an identity migration that has no `down`, the same pattern as the comment records. `manifest.ts` holds the manifest v1 type and validator. `camera.ts` holds the BCF-compatible camera type and validator. `api.ts` holds every model worker route path, request and response type, and the error code union. `converter.ts` holds the job API types (start body, heartbeat body, callback body, limits). `keys.ts` builds the R2 keys. `viewer.ts` holds the `ViewerHandle` interface lane E builds against: `captureFrame()`, `getCamera()`, `setCamera(camera, animate)`, `onCameraChange(cb)`, `pause()`, `resume()`. Export the module from `index.ts`. `@tldraw/dotcom-shared` already depends on `@tldraw/tlschema` and `@tldraw/validate`, so no new dependency is needed.
2. Migration `apps/dotcom/zero-cache/migrations/054_models.sql`: `model`, `model_version`, `derived_artifact`, `revision`, `board_model`, `publish_lease`, with indexes on `model_version.modelId`, `derived_artifact.modelVersionId`, `revision.modelId`, `revision.fileId`, `board_model.fileId`, and `publish_lease.expiresAt`. Add the first five to the `zero_data` publication. `publish_lease` stays out of the publication. Then `tlaSchema.ts`: table definitions, relationships, `DB` entries, row types. Then `capabilities.ts` gains `uploadModels` and `attachModels`, and `roles.ts` maps them (members get both, guests get neither). Then `queries.ts` gains `modelVersionsForFile(fileId)`, `revisionsForModel(modelId)` and `modelsForWorkspace(groupId)`, each with a single `exists` gate, no OR.
3. Feature flag `models_3d`: the key in `@tldraw/dotcom-shared`, the default in the client `featureFlags.ts` and in the sync worker `getFlagDefaults`, and a `useIsModels3dEnabled()` hook next to `useIsCommentingEnabled`.
4. Client registration. Create `apps/dotcom/client/src/utils/dotcomShapeUtils.ts` exporting `[...embedShapeUtils, Model3dShapeUtil, Model3dRevisionShapeUtil]` and switch the five `Tldraw` mounts (`TlaEditor`, `TlaPublishEditor`, `TlaLegacySnapshotEditor`, `TlaLegacyFileEditor`, `thumbnail-render.tsx`) from `embedShapeUtils` to it. In `TlaFileSyncHost.tsx` pass `shapeUtils: [...defaultShapeUtils, ...dotcomShapeUtils]` to `useSync`, because passing `shapeUtils` replaces the defaults. Give `TldrawApp.ts` and `importFromUrl.ts` a `createDotcomSchema()` helper so `.tldr` import parses the new shapes. The two shape util files in `apps/dotcom/client/src/tla/model3d/` are placeholders: correct `static type`, `static props` and `static migrations` taken from dotcom-shared, a grey box render with the shape type as text, and nothing else. Lanes B and E replace the bodies.
5. Server registration. Replace the three `createTLSchema` calls (`TLFileDurableObject.ts`, `utils/validateSnapshot.ts`, `routes/tla/createFiles.ts`) with one `createFileSyncSchema()` exported from dotcom-shared so the three sites cannot drift. Confirm the sync worker bundle check still passes.
6. `TlaEditor.tsx` plumbing. `InFrontOfTheCanvas` renders both `CommentsOnCanvas` and a `Model3dOverlayMount` from `tla/model3d/overlay.tsx` (a placeholder that returns null), gated by the flag. `getShapeVisibility` reads a `hiddenShapeIds` atom from `tla/model3d/visibility.ts` in addition to the existing `hideAllShapes` atom. Lanes B and E fill in the module bodies; they never open `TlaEditor.tsx`.
7. `apps/dotcom/model-worker/` skeleton, copied from `image-resize-worker`: `package.json` named `@tldraw/model-worker` so the filter commands in this plan resolve, `wrangler.toml` with dev, preview, staging and production environments and a `SYNC_WORKER` service binding, `src/worker.ts` with itty-router, a health route, and `MODEL_API_MODE=fixture`. Fixture mode implements every route in `api.ts` from memory and disk: begin and complete upload return canned ids and flip a version to `ready` after a short delay, the manifest route serves `fixtures/manifest.json` with a GLB URL pointing at `fixtures/model.glb`, thumbnail PUT stores in memory, attach always succeeds, and the lease routes run the real lease state machine against an in-memory map. Add `scripts/make-fixtures.ts`, which builds the fixture GLB with glTF-Transform and the meshoptimizer encoder from a few boxes so no binary is committed by hand. Add the worker to `process-compose.yaml` after `sync-worker`, and `MODEL_WORKER_URL` to the client `config.ts`. Fixture responses are validated in a test by the validators from `api.ts`, so the fixtures cannot drift from the contract.

Checks: `pnpm --filter @tldraw/dotcom-shared test run`, `pnpm --filter @tldraw/zero-cache test run` (filename validation), `pnpm --filter dotcom test run`, `pnpm --filter @tldraw/dotcom-worker test run`, `pnpm --filter @tldraw/dotcom-worker check-bundle-size`, `pnpm typecheck`, `pnpm lint-current`. Manual: `pnpm dev-app` boots with the model worker in fixture mode, a placeholder `model3d` shape created from the debug menu syncs between two tabs and survives reload, a `.tldr` export and reimport keeps it, and the `client-too-old` e2e scenario still passes.

Done when: a fresh worktree off the integration branch installs, typechecks and runs the dev stack, and lanes B, C, D and E can each start without a single edit to the shared files table.

### Lane D: converter image and the spike

Goal: one Docker image that turns IFC, GLB, OBJ and STL into a meshopt GLB plus manifest through the job API in `converter.ts`, and the week 1 measurements the runner decision and the size limits depend on.

Owns: `apps/dotcom/model-converter/**`, a workspace package named `@tldraw/model-converter`.

Does not touch: anything else. The job API types come from lane A; until they land, lane D codes against the types as written in the design doc and rebases.

Contract: the job API in the design's "The converter contract" section. Start is idempotent per job id. Heartbeat carries stage and percent. Completion carries artifact hashes. The converter never fetches a URL that is not one of the signed URLs it was given.

Work items:

1. `Dockerfile`: Debian slim, pinned IfcOpenShell `IfcConvert`, pinned gltfpack, Node 22, glTF-Transform, and one of assimp or trimesh for STL (pick one, record why in the README). Non-root user, read-only filesystem except `/work`, no network beyond the signed URLs (document the egress rule for the runner).
2. `src/server.ts`: the job API over HTTP, plus a `--once` mode that reads one job from a JSON file for local runs and the spike.
3. `src/pipeline/`: `ifc.ts` (IfcConvert to GLB, units and axis normalized, model recentred with the full transform recorded), `glb.ts` (glTF-Transform validate and decompress, reject external references), `obj.ts`, `stl.ts`, then the shared `pack.ts` step (gltfpack with quantization, meshopt, GPU instancing, KTX2 when textured) and `manifest.ts` (bounds, units, transform, counts, texture memory estimate, converter version and arguments, artifact hashes, limits applied).
4. Limits: source bytes, expanded bytes, triangles, texture dimensions, disk, wall time, memory, read from the job body and enforced with user-safe error codes.
5. `test/`: the lane A fixture GLB, one small public IFC sample, one OBJ, one STL, one corrupt file, with golden manifests. The corrupt file must fail with `E_INPUT_INVALID` and leave the process alive.
6. `scripts/spike.ts`: runs a folder of models through the container, records peak memory from the cgroup, disk high-water mark, wall time, output bytes and triangle count, and writes `spike-results.md`. `spike-viewer/index.html`: a standalone three.js page with no COOP or COEP headers that loads a GLB and prints load time, draw calls from `renderer.info`, geometry and texture memory, `performance.memory`, frame rate over ten seconds, and time to first interaction. Both scripts and their output format are the week 1 deliverable.
7. Week 2 onward: IFC hardening on the customer files, OBJ and STL, the image published to the registry lane C pulls from, and in phase 3 the production deploy step.

Checks: `docker build` succeeds, `pnpm --filter @tldraw/model-converter test run` runs the fixtures end to end inside the container, `pnpm typecheck` includes the package.

Done when: the spike results for the largest expected IFC, a typical IFC, a large GLB and one bad file are in `spike-results.md`, and the gate meeting has a runner and a limits table.

### Gate at the end of week 1

Inputs: `spike-results.md`, the browser numbers from the spike viewer, owner decisions 1, 4 and 5.

Outputs written into the design doc: the runner (Containers if the largest IFC fits in 12 GiB with headroom, else Modal or Fly behind the same job API), the launch limits and rejection copy, and the staffing map from "Staffing" below. If decision 1 becomes "reviewers sketch at launch", lane A reopens for one more week to move revision records to the object lane and lane C gains a policy endpoint; every other lane keeps its scope.

## Phase 1, weeks 2 to 3: upload, convert, view

Lanes B and C start together on Monday of week 2. Lane D continues. Lane E starts in week 3 on the export pipeline, which needs no 3D code.

### Lane B: model shape and viewer

Goal: a dropped GLB or IFC becomes a `model3d` shape that shows conversion progress, gets a thumbnail, and opens a three.js overlay the user can orbit, with the camera remembered.

Owns: `apps/dotcom/client/src/tla/model3d/**` except `Model3dRevisionShapeUtil.tsx`, `sketch/` and `publish/`; `apps/dotcom/client/src/tla/components/TlaEditor/sneaky/SneakyFileDropHandler.tsx`; `apps/dotcom/client/src/tla/components/TlaEditor/useFileEditorOverrides.ts`; `apps/dotcom/client/src/utils/csp.ts`; the client `package.json` for `three` and `@types/three`, pinned to an exact version.

Does not touch: the shared files table, the revision shape, anything in `apps/dotcom/model-worker` or `apps/dotcom/sync-worker`.

Contract: `shapes.ts`, `manifest.ts`, `camera.ts`, `api.ts` and `viewer.ts` from lane A. The overlay exposes `ViewerHandle` exactly; lane E builds against it with a fake.

Runs against: the model worker in fixture mode from `pnpm dev-app`; from week 3, lane C's worker on a preview deploy.

Work items:

1. `Model3dShapeUtil.tsx` real body per the design: `BaseBoxShapeUtil`, locked aspect ratio, `img` through `useImageOrVideoAsset`, pending state showing bounds and triangle count from the manifest while the thumbnail is missing, the play button following `HyperlinkButton`, `onDoubleClick` returning a no-op partial, `canEditInReadonly` true, `toSvg` returning an `image`, and the "no access, attach this model" placeholder when the manifest request returns 403.
2. `upload.ts`: begin, parts, complete, following `api.ts`. 64 MiB parts, four in flight, resume through the parts route, progress callback, abort on navigation. Rejects files over the launch limit with the agreed copy before any network call.
3. Drop handling in `SneakyFileDropHandler.tsx`: `.ifc`, `.glb`, `.obj` and `.stl` (by extension, since Chrome reports an empty MIME type for `.ifc`) go to `upload.ts` and create the shape in a pending state; everything else keeps the current path. Status reaches the shape through the `modelVersionsForFile` query.
4. `Model3dViewer.tsx` and `viewerState.ts`: the per-editor atom in a `WeakCache`, lazy `import('three')` and the loader addons so the main bundle does not grow, `GLTFLoader` with the meshopt decoder and KTX2 loader, fit to the manifest bounds, OrbitControls, resize observer, context loss handling with a retry, toolbar hidden while open, `editor.blur({ blurContainer: false })` on enter and `editor.focus()` on exit, pointer and wheel handling as the design lists, presence `meta` set while in 3D. Per-user last camera in localStorage keyed by model version. "Set as default view" writes `defaultView` inside `editor.run(fn, { history: 'ignore', ignoreShapeLock: true })`. "Open in 3D" added as an action in `useFileEditorOverrides.ts`. `overlay.tsx` renders the viewer when the atom is set.
5. Thumbnails: on the first successful render, a 512 px WebP through `convertToBlob`, uploaded once as a board image asset so the shape gets `assetId`, and PUT once to the model worker thumbnail route with first-writer-wins so other boards can reuse it. Retry if the first client closes or loses the context before the capture.
6. `csp.ts`: the models host in `connect-src`, `'wasm-unsafe-eval'` in `script-src`.

Checks: `pnpm --filter dotcom test run` (unit tests on the pure parts: part planning and resume, fit-to-bounds, camera serialization round trip, localStorage key format, the 403 placeholder decision), `pnpm --filter dotcom lint`, `pnpm typecheck`. Manual script: drop the fixture GLB, watch pending turn ready, see the thumbnail, open the viewer, orbit, close, reopen to the same camera, confirm two tabs show one shape, a view-only visitor can open the viewer, the toolbar is hidden in 3D, keyboard shortcuts and undo are dead in 3D, and the main bundle size reported by the deploy script did not grow by more than the overlay chunk loader.

Done when: the checkpoint 1 flow works against fixture mode and against lane C's preview deploy, and `ViewerHandle` is implemented completely.

### Lane C: model worker

Goal: the real `model-worker`: multipart uploads straight to R2, conversion driven through a runner interface, grant-checked manifests with HMAC-gated GLB URLs, thumbnails, attach and detach, and in phase 2 the lease endpoints.

Owns: `apps/dotcom/model-worker/**` from the skeleton onward, keeping fixture mode working; `apps/dotcom/model-worker/wrangler.toml`; the model worker entry in `internal/scripts/deploy-dotcom.ts`; in the sync worker, a new `src/modelAccess.ts` with its test and the RPC methods it adds to `worker.ts`.

Does not touch: the shared files table (the Zero schema, queries, capabilities and migration belong to lane A), the client, the converter image internals.

Contract: `api.ts`, `converter.ts`, `keys.ts`, `manifest.ts` from lane A. The converter job API from lane D.

Runs against: the local dev stack (Postgres through the compose file, the sync worker), a dev R2 bucket through the binding, and a `FakeRunner` until lane D's image is in the registry.

Work items:

1. Postgres through Hyperdrive in staging and production and pgbouncer locally, following `postgres.ts` in the sync worker, with Kysely over the `DB` types from dotcom-shared.
2. Identity and access: `SYNC_WORKER.authorizeModelRequest(authHeader, { fileId?, modelId?, groupId? })` in the sync worker returns the user id, role and read and write answers, reusing `getRole` and `hasReadAccessToFile`. The model worker never duplicates membership logic.
3. Upload: `POST /app/models` creates `model` and `model_version` in `uploading`, begins the S3 multipart upload with `aws4fetch`, and returns the first batch of one-hour part URLs. `POST /app/models/:versionId/parts` issues more URLs and lists uploaded parts for resume. `POST /app/models/:versionId/complete` completes the multipart upload, is idempotent per version, flips to `queued`, and starts at most one conversion. Declared size is checked against the launch limit at begin. The README records the bucket CORS rule and the lifecycle rule for incomplete uploads.
4. Conversion control behind a `ConverterRunner` interface with three implementations: `FakeRunner` (copies the fixture GLB and manifest to the destination keys after a delay), `ContainerRunner` (a Workflow drives a Container: mark converting, mint URLs, start, poll with `step.sleep`, verify with `head`, insert `derived_artifact` rows and flip status in one transaction, final catch step guarantees a terminal state) and `ExternalRunner` (starts a Modal or Fly job through the outbox, accepts an HMAC-signed callback at `POST /app/models/jobs/:jobId/callback`, and sweeps lost callbacks). The gate decision selects one by environment variable. Only the chosen one ships to production in phase 3, but the fake stays for tests.
5. Serving: `POST /app/models/:versionId/manifest` with the `fileId` query checks the `board_model` grant and the caller's board access, then returns the manifest and a GLB URL with a ten-minute timed HMAC in the format `is_timed_hmac_valid_v0` verifies. `GET /app/models/dev/:versionId/model.glb` streams from the binding with Range and checks the same HMAC, for local development and for plans below Pro. Thumbnail PUT with `onlyIf` for first-writer-wins. `POST /app/files/:fileId/models` attaches (caller needs read on the model version and write on the file), `DELETE` detaches, `GET` lists.
6. Sweeps on a cron trigger: `uploading` versions older than 24 hours, leases older than 24 hours, `rev/` prefixes without a revision row.
7. Deploy: the `deploy-dotcom.ts` entry depending on the multiplayer worker, preview naming, bucket names per environment, `MODEL_WORKER_URL` passed to the client like `USER_CONTENT_URL`, Sentry through the shared `createSentry` pattern and `version_metadata` repeated per environment.

Checks: `pnpm --filter @tldraw/model-worker test run` (HMAC against a known vector, part planning, the grant matrix, the lease state machine as a pure function in phase 2), `pnpm --filter @tldraw/dotcom-worker test run` for `modelAccess.ts`, `pnpm typecheck`, `wrangler dev` with the fake runner against the dev stack.

Done when: a preview deploy accepts a real upload, runs it through the chosen runner, and serves the manifest and the GLB behind the HMAC to lane B's client.

### Lane E, week 3 start: the export pipeline

Goal: the parts of publishing that need no 3D: freezing the stroke set and exporting it from an isolated editor.

Owns: `apps/dotcom/client/src/tla/model3d/publish/**`.

Work items: `freeze.ts` collects the revision shape, its descendants, their bindings and the snapshot asset record in one synchronous read and computes `strokeHash` over the sorted records with volatile fields removed. `exportOverlay.ts` mounts a hidden `Tldraw` with a snapshot built from the frozen records, as `thumbnail-render.tsx` does, calls `toImage([revisionId], { format: 'png', background: false, padding: 0, pixelRatio, darkMode: false })`, and disposes the editor. `publishApi.ts` is the client for the lease routes in `api.ts` with a `FakePublishApi` for tests.

Checks: `pnpm --filter dotcom test run`. Tests prove `strokeHash` is deterministic and order independent, that the export of a frame-like shape with one draw child is a transparent PNG of the requested pixel size containing stroke pixels and no frame pixels, and that the hidden editor is disposed.

### Checkpoint 1, end of week 3

On a preview deploy with the flag on for the test workspace:

1. Drop the fixture GLB and a typical IFC on a board.
2. Both shapes show pending, then conversion progress, then ready with a thumbnail.
3. Open each in 3D, orbit, close, reopen to the same camera.
4. A second tab sees the shapes and the thumbnails without reloading.
5. A view-only link guest opens the viewer; a signed-out guest on a board whose owner disabled guest models gets the placeholder (or the default, pending decision 2).
6. Paste a shape into a board in another workspace: placeholder until attached.
7. Record time from drop to ready, time from play to first frame, and the frame rate on an integrated GPU.

Exit criteria: all seven pass, the sync worker bundle check passes, the client main bundle did not grow beyond the loader stub, and no shared file was edited outside lane A.

## Phase 2, weeks 4 to 5: lock, sketch, publish

### Lane E: revision shape, sketch mode, publish, recovery

Goal: lock a view, sketch over it with the normal tools, publish an immutable revision, and see it back in 3D, with every failure case in the design's recovery section covered.

Owns: `Model3dRevisionShapeUtil.tsx`, `tla/model3d/sketch/**`, `tla/model3d/publish/**`, and a `RevisionOverlay.tsx` component that lane B's viewer renders when given a revision. Adds one action to `useFileEditorOverrides.ts` ("Publish revision"), which is the only edit outside its folders.

Does not touch: the viewer internals (uses `ViewerHandle`), the shared files table, the model worker.

Contract: `ViewerHandle`, `camera.ts`, the lease routes in `api.ts`.

Runs against: the fake viewer handle and `FakePublishApi` for tests; the model worker in fixture mode (its lease routes run the real state machine in memory); lane C's lease endpoints from week 4.

Work items:

1. `Model3dRevisionShapeUtil.tsx`: `BaseFrameLikeShapeUtil`, hollow geometry, `isExportBoundsContainer` true, `shouldClipChild` returns true for arrows too, never locked, snapshot rendered as the body, `name` shown like a frame label.
2. `sketch/enter.ts` and `exit.ts`: read the WebGL canvas through `captureFrame()`, create the `TLImageAsset` with `pixelRatio`, `createTemporaryAssetPreview`, `editor.uploadAsset`, create the revision shape at viewport size next to the thumbnail, save the 2D camera, point the camera at the shape at zoom 1, `setCameraOptions({ isLocked: true })`, set `hiddenShapeIds` to everything else, `pause()` the overlay. Exit restores the camera and camera options, clears the hidden set, resumes the overlay. Handle a viewport resize during sketch by keeping the shape size fixed and letting the camera refit.
3. `publish/publish.ts`: the eight steps in the design in order, with `pendingPublish` written through `history: 'ignore'` after begin succeeds, renew on a timer while uploading, overlay PUT to `rev/{requestId}/overlay.png`, complete with the request id only, then `revisionId` set and `pendingPublish` cleared with `history: 'ignore'`.
4. `publish/recover.ts`: any client that sees `pendingPublish` calls recover and acts on the three answers (in progress: leave it and retry later; revision: set `revisionId` and clear; not uploaded: clear). Runs on board load and on a timer while a pending shape exists.
5. `RevisionOverlay.tsx`: given a revision, `setCamera(camera, animate)`, letterbox to the saved aspect ratio, draw the overlay PNG in screen space, hide it on the first `onCameraChange` beyond a threshold, show a return-to-view button. The viewer lists revisions for the model from the `revisionsForModel` query.
6. Undo semantics: undo after publish removes the draft but the row stands; a "restore from revision" action recreates the shape from the row.

Checks: `pnpm --filter dotcom test run`. Tests cover the recovery decision table, the enter and exit state restoring camera options, arrow clipping, the publish sequence against `FakePublishApi` with injected failures at each step, and the letterbox math. `pnpm typecheck`.

Done when: checkpoint 2 passes.

### Lane C: lease endpoints

Work items: `begin`, `renew`, `complete`, `recover` and `cancel` each in one Postgres transaction with `SELECT ... FOR UPDATE` on the `publish_lease` row, following the operation table in the design word for word; snapshot and overlay PUT routes, 10 MB each, PNG signature checked, written to the private artifacts bucket; `GET /app/models/:modelId/revisions`. The pure state machine lives in one file with a table-driven test. An integration test against the local Postgres runs two concurrent recover and complete calls and proves exactly one revision row results.

### Lane B: viewer additions

Work items: `setCamera` with animation, `pause()` and `resume()` through `setAnimationLoop`, same-frame readback at device pixel ratio for `captureFrame()`, the `onCameraChange` threshold, and rendering `RevisionOverlay` when the atom carries a revision.

### Checkpoint 2, end of week 5

1. Lock, sketch three strokes and an arrow, publish, return to 3D, see the overlay, orbit, see it hide, return to view.
2. Reload during the export, during the overlay upload, and after the upload but before complete. Each time the shape ends published or cleanly unpublished, never stuck, and never with two rows.
3. Open the board in a second tab mid-publish; the second tab shows pending and does not clear it.
4. Undo after publish, then restore from the revision.
5. Sketch for 30 minutes with dense draw shapes; the room stays under the size cap and sync message chunking shows no errors.
6. A view-only visitor sees published revisions in 3D and cannot enter sketch mode.

## Phase 3, weeks 6 to 8: production and acceptance

### Lanes C and D: IFC in production

The chosen runner goes to staging in week 6 with the customer IFC files, then production in week 7. For Containers this is the image build in the deploy job (Docker on the runner) and the `[[containers]]` binding; for Modal or Fly it is their deploy step and the callback secret. Observability: Sentry in the worker and the converter, stage and percent on the shape, user-safe error codes with a retry or replace action, and a jobs view on the admin routes. Lane D finishes OBJ and STL if time allows.

### Lane F: permissions, failure states, acceptance

Goal: the feature is safe to turn on for one workspace.

Owns: `apps/dotcom/client/e2e/**` additions, `apps/dotcom/user-manual.md` (a new section), UI polish inside `tla/model3d/` by agreement with lanes B and E after they close, analytics events.

Work items:

1. Capability checks in the UI: no upload affordance without `uploadModels`, no attach without `attachModels`, matching the server answers.
2. Decision 2 and decision 3 as built: the per-board guest toggle if chosen (a `file` column through a lane A style migration by the integration owner), and the snapshot copy bucket.
3. Failure states: conversion failed, model deleted, grant missing, context lost, upload interrupted, over limit. Each has copy, an action and a test.
4. Copy, paste, duplicate, `.tldr` export and import, and publish-to-web behavior verified for both shapes.
5. `models.scenario.spec.ts` with `scenario.uploadModel` and `scenario.openIn3d` helpers following the e2e README: upload the fixture GLB, wait for ready, open the viewer, lock, sketch, publish, see the revision in a second actor's tab. Headless Chromium runs WebGL on SwiftShader; if the CI runner refuses, pass `--use-angle=swiftshader` in the scenarios project and keep the viewer assertions to presence and camera state rather than pixels.
6. Acceptance: the three customer files and the bad file through the whole flow with the owner, timings recorded against the checkpoint 1 numbers.

### Checkpoint 3, end of week 8

The flag turns on for the pilot workspace. Exit criteria: the e2e scenario is green on CI, every failure state has copy and a test, the acceptance sheet is signed, and the flag is still off everywhere else.

## Shared files and their owners

| Path                                                                                                                                                                | Owner                                              | Others may                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `packages/dotcom-shared/src/model3d/**`                                                                                                                             | A                                                  | request a change                                           |
| `packages/dotcom-shared/src/{tlaSchema,queries,capabilities,roles,index}.ts`                                                                                        | A                                                  | nothing                                                    |
| `apps/dotcom/zero-cache/migrations/*`                                                                                                                               | A for 054, integration owner after                 | nothing                                                    |
| `apps/dotcom/client/src/utils/dotcomShapeUtils.ts`                                                                                                                  | A                                                  | nothing; placeholders already import the final class names |
| `apps/dotcom/client/src/tla/components/TlaEditor/TlaEditor.tsx`                                                                                                     | A                                                  | nothing; B and E work inside `tla/model3d/`                |
| `TlaFileSyncHost.tsx`, `TlaPublishEditor.tsx`, `TlaLegacySnapshotEditor.tsx`, `TlaLegacyFileEditor.tsx`, `thumbnail-render.tsx`, `TldrawApp.ts`, `importFromUrl.ts` | A                                                  | nothing                                                    |
| `apps/dotcom/client/src/tla/model3d/{overlay,visibility,Model3dShapeUtil,Model3dRevisionShapeUtil}.tsx`                                                             | A creates, then B owns the first three, E the last | as listed                                                  |
| `.../sneaky/SneakyFileDropHandler.tsx`, `useFileEditorOverrides.ts`, `utils/csp.ts`, client `package.json`                                                          | B                                                  | E adds one action to the overrides in phase 2              |
| `apps/dotcom/sync-worker/src/{TLFileDurableObject,utils/validateSnapshot,routes/tla/createFiles}.ts`                                                                | A                                                  | nothing                                                    |
| `apps/dotcom/sync-worker/src/worker.ts` RPC methods, `src/modelAccess.ts`                                                                                           | C                                                  | nothing                                                    |
| `apps/dotcom/model-worker/**`                                                                                                                                       | A for the skeleton, then C                         | B and E read only                                          |
| `apps/dotcom/model-converter/**`                                                                                                                                    | D                                                  | C reads the job API                                        |
| `apps/dotcom/process-compose.yaml`                                                                                                                                  | A                                                  | nothing                                                    |
| `internal/scripts/deploy-dotcom.ts`                                                                                                                                 | C                                                  | nothing                                                    |
| `apps/dotcom/client/e2e/**`                                                                                                                                         | F                                                  | nothing                                                    |
| `apps/dotcom/3d-review-board.md` decisions section                                                                                                                  | integration owner                                  | nothing                                                    |

## Running the lanes in parallel

Setup, once:

```bash
git checkout -b feat/3d-review-board main
git add apps/dotcom/3d-review-board.md apps/dotcom/3d-review-board-implementation.md
git commit -m "docs(dotcom): 3D review board design and implementation plan"
```

Per lane, from the repo root:

```bash
git worktree add .claude/worktrees/3d-lane-a -b feat/3d-lane-a feat/3d-review-board
cd .claude/worktrees/3d-lane-a && pnpm install
```

Daily in each lane: fetch and rebase on `feat/3d-review-board`. Pull requests target the integration branch, use semantic titles (`feat(dotcom): model worker multipart upload`), stay under about 600 changed lines, and carry the lane letter in the branch name so the integration owner can see conflicts coming.

The integration owner is one person. Merge order: lane A first and alone; then B, C and D as they arrive; E after B's `ViewerHandle` has landed; F last. After every merge: `pnpm typecheck`, the merged lane's checks, and the client and sync worker bundle checks. Once a week the integration branch merges to `main` with the flag off, so the branch never drifts far from `main`. The integration owner also keeps the design doc's decisions section current and runs the three checkpoints.

Report format, used at the end of every pull request description and every agent run:

1. What landed, as a list of work item numbers from this plan.
2. Checks run, each with pass or fail and the failing output if any.
3. Shared file changes requested from lane A, as exact edits.
4. Contract gaps or design doc corrections found.
5. Open questions for the owner.

Agent brief template. Paste the lane section from this plan under it:

```text
You are implementing lane <letter> of apps/dotcom/3d-review-board-implementation.md in the worktree <path>.
Read first: apps/dotcom/3d-review-board.md (sections <list>), the lane section below, AGENTS.md, and the files the lane section names.
Work only inside the paths the lane owns. If you need any other file changed, stop, write the exact change under "Shared file changes requested", and continue with work that does not depend on it.
Implement the contracts in packages/dotcom-shared/src/model3d exactly as they are. Do not change them.
Run against: <fixture mode, preview URL, or fake>.
Before you report, run the checks in the lane section and pnpm typecheck from the repo root, and include their output.
Do not commit or push unless told to. Report in the five-part format from the plan.
```

## Staffing

With two engineers, the design's assumption:

| Engineer | Week 1 | Weeks 2 to 3     | Weeks 4 to 5   | Weeks 6 to 8                      |
| -------- | ------ | ---------------- | -------------- | --------------------------------- |
| 1        | A      | B, then E export | E, B additions | F client side                     |
| 2        | D      | C, D             | C leases, D    | C and D production, F server side |

With agents on each lane and the two engineers reviewing and integrating, every lane runs at once from week 2 and the calendar compresses to about five weeks; the week 1 gate and the three checkpoints stay as they are, because they depend on real files and real deploys, not on coding time.

## Decision deadlines

| Decision                  | Blocks                                                                                                     | Needed by                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1, editor-only sketching  | nothing if yes; if reviewers sketch at launch, lane A reopens for a week and lane C adds a policy endpoint | end of week 1                 |
| 2, link guests see models | lane C's manifest grant rule, lane F's toggle                                                              | end of week 3                 |
| 3, public snapshot copy   | lane E step 2 bucket choice                                                                                | end of week 3                 |
| 4, launch size limit      | lane C's begin check, lane D's limits, lane B's rejection copy                                             | end of week 1, from the spike |
| 5, staffing               | which column of the staffing table applies                                                                 | now                           |

## Risks that come from working in parallel

1. Contract churn. The `model3d` module is frozen at the end of week 1. After that, a change is either additive and versioned (the manifest carries `version`, routes are under `/app/models`) or batched into one Monday pull request that every lane rebases on.
2. Two lanes in one file. The ownership table forbids it, and the placeholder mounts in lane A exist so that B and E never need `TlaEditor.tsx` or the five mounts.
3. Fixture drift. Fixture mode answers are validated by the contract validators in a test, and the fake runner copies the real fixture GLB, so a client that works against fixtures works against the worker.
4. The converter arrives late. Lane C builds against `FakeRunner`; only the runner adapter waits for lane D's image.
5. Lane E depends on lane B's handle. `ViewerHandle` is a lane A type, so E codes against a fake and swaps in the real overlay when B lands.
6. SDK gaps. If a lane finds that a `ShapeUtil` hook or an editor API is missing, it reports the gap instead of forking the SDK package; the integration owner lands it on `main` with `pnpm api-check` and the lane rebases.
