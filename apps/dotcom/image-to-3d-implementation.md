# Image and sketch to 3D: staged plan

Status: plan, 2026-11-02. Companion to `image-to-3d.md`, which holds the design and the reasons. Same rules as the 3D review board's "Local prototype track (current)": local only, no feature flag, no deploy work, solo owner, each stage a commit series on the integration branch, reviewed before any stage that depends on it starts. One recorded exception to that track: the converter may add `onnxruntime-node`.

## Prerequisites

| Prototype stage                        | Needed by | Why                                                                                                                   |
| -------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| 1, core baseline (done on this branch) | G0        | Contracts, `model` table, shape utils, overlay mount                                                                  |
| 2a, backend                            | G1, G2    | Model routes in the sync worker, `MODELS` binding, the converter with its pipeline dispatch, GLB writer and `pack.ts` |
| 2b, viewer                             | G3        | The `model3d` shape that polls status and shows progress and thumbnails, and the viewer                               |

## Stages

| Stage          | Content                                                                                                                                                                                                                                                                             | Depends on | Runs in parallel with |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------- |
| T, trial       | Owner decision 2 first. Then throwaway scripts outside the app: the fal candidates on a fixed input set, the MoGe-2 ONNX port checked against the reference, Depth Anything 3 Small, CPU timings, fal hosts and retention headers. Picks one object generator and one depth model   | nothing    | prototype 2a and 2b   |
| G0, contracts  | `image` source format, generation types and validators, the catalog with the trial's two winners, stage and error codes, artifact name, response union, status summary, manifest `sourceView`, migration 055 and its `DB` type, the overrides and context menu hooks in `TlaEditor` | T, stage 1 | prototype 2a and 2b   |
| G1, worker     | Create with `generation` and `regenerateFrom`, `model_generation` writes, job body, status summary, callback fields, `generated.glb` read and write, stale-job re-dispatch with `resume`                                                                                            | G0, 2a     | G2, G3                |
| G2, converter  | `pipeline/image.ts`, the `Generator` interface and fal adapter, egress wrapper, resume order, relief (the trial's depth model, mesh builder, textured GLB), weights script, env loading                                                                                             | G0, 2a     | G1, G3                |
| G3, client     | Make 3D action and dialog, capture, upload, placement, pending thumbnail, `meta.generatedFrom`, Regenerate, Select source shapes, Retry, relief opening camera in the viewer                                                                                                        | G0, 2b     | G1, G2                |
| I, integration | The end-to-end checks below, fixes, failure messages per error code                                                                                                                                                                                                                 | G1, G2, G3 | none                  |

Render sketch is not a stage of v1; it follows I if the owner wants it (design, "After v1").

## Checks

Each stage has a stub check that needs only its own dependencies; the integrated checks run in I.

| Stage | Stub check                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T     | `trial-results.md` exists with a row per input and candidate (time, cost, triangles, texture size, GLB bytes, a one-line quality note from viewing the GLB in a local glTF viewer), the MoGe-2 port's maximum point error against the reference, CPU time and peak memory, and the fal hosts seen |
| G0    | `pnpm --filter @tldraw/dotcom-shared test run`, `pnpm --filter @tldraw/zero-cache test run`, `pnpm typecheck`; migration 055 applies on a fresh `pnpm dev-app`                                                                                                                                    |
| G1    | Unit tests for request validation and the re-dispatch decision; a `curl` script creates an image model, uploads a PNG and sees the job body with `generation` arrive at a stub HTTP listener on the converter port                                                                                |
| G2    | `pnpm --filter @tldraw/model-converter test run`; the converter's `--once job.json` mode turns a PNG into `model.glb` and `manifest.json` in both modes against a local stub of the worker routes                                                                                                 |
| G3    | `pnpm --filter dotcom test run` for capture sizing and placement; on a local board with a stub converter, Make 3D creates the pending shape with the input as thumbnail, and one undo removes it                                                                                                  |

Integrated checks in I, on a local board with the real stack:

1. Make 3D on an image shape and on a pencil sketch, in the trial's object generator, opens in the viewer.
2. Relief on a facade photo opens at the source camera with clamped orbit and an estimated or unknown scale label.
3. Regenerate places a second shape beside the first with a new seed; Select source shapes selects the sketch.
4. Killing the converter during generation and restarting it finishes the job without a second fal request (checked in fal's request history).
5. A provider failure leaves the shape with the error and Retry.

## File ownership

Stages that run in parallel (G1, G2, G3) never touch the same file. A stage that needs a change in a file it does not own stops and asks; G0's owner makes contract edits in a separate commit, and the others rebase. G0 runs alongside prototype 2a and 2b, which own none of the G0 files; if 2a needs a contract change while G0 is open, it lands as a G0 commit. The owner is one person, so "owner" means which stage's branch the change belongs to.

| Path                                                                                                                                                                    | Stage                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/dotcom-shared/src/model3d/manifest.ts`, `api.ts`, `index.ts`                                                                                                  | G0                                                                                                                      |
| `packages/dotcom-shared/src/model3d/generation.ts`, `generators.ts` (new) and their tests                                                                               | G0                                                                                                                      |
| `packages/dotcom-shared/src/tlaSchema.ts` (the `model_generation` row type and `DB` entry only)                                                                         | G0                                                                                                                      |
| `apps/dotcom/zero-cache/migrations/055_model_generation.sql`                                                                                                            | G0                                                                                                                      |
| `apps/dotcom/client/src/tla/components/TlaEditor/TlaEditor.tsx` (one entry in `editorOverrides`, one `ContextMenu` component)                                           | G0                                                                                                                      |
| `apps/dotcom/client/src/tla/model3d/generate/overrides.ts`, `ContextMenu.tsx`                                                                                           | G0 creates placeholders, G3 fills them                                                                                  |
| The 2a model route files, for the `create`, `status`, `artifact` and `job-status` handlers                                                                              | G1                                                                                                                      |
| `apps/dotcom/sync-worker/src/routes/models/generation.ts` (new: validation, row writes, re-dispatch decision)                                                           | G1                                                                                                                      |
| `apps/dotcom/sync-worker/src/types.ts`, `wrangler.toml` `[env.dev.vars]`, if G1 needs a new variable                                                                    | G1                                                                                                                      |
| `apps/dotcom/model-converter/src/pipeline/image.ts` (new) and the one-line dispatch entry in the 2a pipeline index                                                      | G2                                                                                                                      |
| `apps/dotcom/model-converter/src/generate/**` (new: `Generator.ts`, `fal.ts`, `egress.ts`, `resume.ts`)                                                                 | G2                                                                                                                      |
| `apps/dotcom/model-converter/src/relief/**` (new: `depth.ts`, `mesh.ts`)                                                                                                | G2                                                                                                                      |
| The 2a GLB writer, for texture and UV support if it lacks them                                                                                                          | G2                                                                                                                      |
| `apps/dotcom/model-converter/scripts/fetch-weights.ts`, `package.json`                                                                                                  | G2                                                                                                                      |
| `pnpm-workspace.yaml` (`allowBuilds` entry for `onnxruntime-node`), `pnpm-lock.yaml`                                                                                    | G2                                                                                                                      |
| `apps/dotcom/process-compose.yaml` (converter command gains `--env-file-if-exists=.env.local`)                                                                          | G2                                                                                                                      |
| `apps/dotcom/client/src/tla/model3d/generate/**` other than the two G0 placeholders                                                                                     | G3                                                                                                                      |
| The 2b viewer files, for the relief opening camera and orbit clamp, and `Model3dShapeUtil.tsx` for the pending input and stage label if 2b does not already render them | G3 (2b has merged by then, so nothing runs in parallel on them)                                                         |
| Trial scripts                                                                                                                                                           | T, in a scratch directory outside the repo; only `trial-results.md` is committed, at `apps/dotcom/image-to-3d-trial.md` |

`FAL_KEY` lives in `apps/dotcom/model-converter/.env.local`, gitignored, loaded by Node's `--env-file-if-exists`, the same pattern as `sync-worker/.dev.vars`. No `dotenv` package. Nothing in the `packages/*` SDK packages changes.

## Stage briefs

Each brief can be pasted to an agent with `image-to-3d.md` and this file.

### T, trial

Goal: the evidence that picks one object generator and one depth model, before any contract is written.

0. Before the first paid request: the prepaid fal balance is set with automatic top-up off (owner decision 2).
1. Inputs: six to ten images (massing sketch, pencil sketch exported with `editor.toImage`, plain-background render, facade photo, interior photo, furniture photo).
2. Object: run each input through fal's TRELLIS.2, Hunyuan3D 3.1 Pro, Tripo H3.1 and Meshy 6 endpoints with plain `fetch` against the queue API, `X-Fal-Store-IO: 0` and the media lifecycle header set. Record time, the estimate, output size, triangle and texture counts, every host the responses and redirects touch, and whether the result is usable for review.
3. Depth: export MoGe-2 ViT-S to ONNX per the repo's `docs/onnx.md`, port the focal and shift recovery and the reprojection to TypeScript, and compare against the reference `.infer()` on three inputs. Run Depth Anything 3 Small from `onnx-community`. Measure CPU time and peak memory on this machine at 518 px.
4. Write `apps/dotcom/image-to-3d-trial.md` and a recommendation: the object generator (or none) and the depth model.

Done when the owner has picked both, which settles owner decision 1.

### G0, contracts

Goal: every type, validator, catalog entry and table the other stages need, so G1, G2 and G3 never edit shared files.

1. `manifest.ts`: `'image'` in `Model3dSourceFormat` and `MODEL3D_SOURCE_FORMATS`; optional `sourceView: Model3dCamera`.
2. `api.ts`: the stage, error code, artifact name, `CreateModelResponse` union, job `generation` and `resume`, callback fields and status summary listed in the design's "Contract changes".
3. `generation.ts`: `Model3dGenerationMode`, `Model3dGenerationRequest` (`mode`, `generator`, `seed`, `prompt`, `params`), `Model3dGenerationJob`, `Model3dGenerationSummary`, `Model3dGeneratedFromMeta`, with `T` validators the worker uses on request bodies.
4. `generators.ts`: the two trial winners as a frozen array, plus lookup by id and kind. Tests: ids are unique, every `relief` entry is local.
5. `055_model_generation.sql` with the columns in the design, a CHECK on `mode`, an index on `parentModelId`; not in `zero_data`. The row type and `DB` entry in `tlaSchema.ts`.
6. `TlaEditor.tsx`: `model3dGenerateOverrides` in `editorOverrides` and `ContextMenu: Model3dContextMenu` in `components`. The placeholders return the overrides unchanged and render `DefaultContextMenu` with `DefaultContextMenuContent`.

### G1, worker

Goal: the sync worker accepts generation requests, records them, passes them through and recovers stale jobs, without ever calling a provider.

1. `create`: for `sourceFormat: 'image'`, require a `generation` whose generator is in the catalog and of the matching kind; reject inputs above 10 MB. Insert `model` and `model_generation` in one transaction. With `regenerateFrom`, check access to that model and that its source is an image, copy its source object within `MODELS`, set `parentModelId`, return the queued variant and dispatch.
2. Dispatch: add `generation` to the job body; set `limits.timeoutMs` per mode (object 10 minutes, relief 2 minutes).
3. `job-status`: store `providerTaskId`, `generatorVersion`, `inputSha256`, resolved `seed` and `params` when present; set `completedAt` on a terminal status.
4. `artifact`: accept `generated.glb` for PUT, and for GET with the job token.
5. `status`: join `model_generation` into `generation`. When the row is `converting` and `updatedAt` is more than two minutes old, re-dispatch with a fresh token and `resume`, or fail with `generation_failed` when an object job's stored stage is `generating` with no `providerTaskId` (design, "Recovery"); relief jobs always re-dispatch. Guard re-dispatch with a conditional update on `updatedAt` so two polls cannot dispatch twice.
6. Retry: `POST /app/models/:modelId/retry` runs the same decision for a failed model.

### G2, converter

Goal: a PNG in, a meshopt GLB and manifest out, in both modes, with resume.

1. `generate/Generator.ts`: `submit(input, request) → taskId`, `poll(taskId) → { state, progress, resultUrl, version }`, `fetchResult(url) → file`. Plain `fetch`, no provider SDK.
2. `generate/fal.ts`: the queue API, input uploaded to fal storage, the retention headers from the trial, catalog id mapped to endpoint and params.
3. `generate/egress.ts`: one fetch wrapper allowing the worker origin and the host suffixes the trial recorded.
4. `pipeline/image.ts`: read the source, hash it, report `inputSha256`. Object: post `stage: 'generating'` and wait for the worker's acknowledgement (no submit if it fails), submit, post `providerTaskId` at once, poll with progress, download, PUT `generated.glb`, then the existing `glb.ts` and `pack.ts`. Relief: `relief/depth.ts` with the trial's model and port, `relief/mesh.ts` (grid, discontinuity cut, simplify, UVs from the photo), the GLB writer with one base-colour texture, `pack.ts`, and `sourceView` in the manifest.
5. `generate/resume.ts`: with `resume.hasGeneratedGlb`, GET it and skip to packing; with only `providerTaskId`, poll it; otherwise start fresh only if the stored stage never reached `generating`. Relief jobs always restart from the source.
6. `scripts/fetch-weights.ts`: download the chosen checkpoint to a cache directory outside the repo and check its SHA-256 against a pinned value.
7. `onnxruntime-node` in `package.json`; `allowBuilds` entry in `pnpm-workspace.yaml` set to `false` after confirming the CPU binaries load without the postinstall script.

Tests: `relief/mesh.ts` on a synthetic depth map (a step edge must be cut), the depth post-processing against fixture outputs from the trial, the egress wrapper, the resume decision (including a crash after provider acceptance but before `providerTaskId` is stored, which must fail rather than resubmit), and the fal adapter against recorded responses.

### G3, client

Goal: the canvas flow in the design.

1. `generate/capture.ts`: the untouched-image fast path (no crop, flip or rotation; PNG, JPEG or WebP) and the `editor.toImage` path with the design's options, scale for a 1024 to 2048 px long edge, and a downscale for oversized input.
2. `generate/MakeModelDialog.tsx`: mode, prompt when the generator takes one, seed, provider name and cost estimate.
3. `generate/run.ts`: capture and placement first; then create, upload, complete, and the asset store upload for a capture; then, if the editor and page still exist, one history mark and one synchronous `editor.run` creating the asset and the shape with `meta.generatedFrom`, then select it.
4. `generate/overrides.ts` and `ContextMenu.tsx`: Make 3D for a selection that is not only `model3d` shapes; Regenerate and Select source shapes for a generated `model3d` shape; Retry on a failed one.
5. Viewer: open at `manifest.sourceView` when the shape has no `defaultView`, clamp orbit for reliefs, show the scale label.

Tests: capture sizing and placement as pure functions.

### I, integration

Run the integrated checks. Write one message per new error code. Update the design's decisions list with anything the build changed.

## Order for a solo owner

T while 2a is being built, then G0, then G1 and G2 in two worktrees, then G3 once 2b has merged, then I. The trial is the first point where the owner sees whether object mode is worth having for architectural inputs; if no candidate is useful, G0 catalogs relief only, G2 skips the fal adapter, and the dialog has no mode choice.
