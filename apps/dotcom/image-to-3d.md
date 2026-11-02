# Image and sketch to 3D

Status: proposal, 2026-11-02. Builds on the 3D review board's local prototype track (`3d-review-board.md` and `3d-review-board-implementation.md`, "Local prototype track (current)"). Where they disagree with this file on the 3D pipeline itself, they win; this file only adds a way to make models from images.

Research by five agents (open models, hosted APIs, sketch and depth and splats, this machine's hardware, the repo), a primary-source fact check, then council review by GPT-6 Astra and GPT-6.1 Sol (round 1: both 7/10; round 2: 8/10 and 9/10; round 3: both confirmed the fixes, no blocking issues; changes listed at the end).

## Decisions in one list

- Scope: "Make 3D" turns a selection on the board (one image shape, or any mix of shapes such as a hand sketch) into a `model3d` shape next to it. Two modes: **object** (a closed textured mesh from a hosted generator) and **relief** (a 2.5D mesh of what is visible, from a local depth model). Sketches go straight to object mode in v1. **Render sketch**, which turns a sketch into an ordinary image shape the user approves before making 3D, follows once v1 works.
- Inference: hosted for object mode, local CPU for relief. This machine cannot run any image-to-3D model (see "Hardware").
- Provider: one `Generator` interface in the converter with one adapter, fal. One key reaches TRELLIS.2, Hunyuan3D 3.1, Tripo H3.1 and Meshy 6 (and later the image-edit models Render sketch needs), so a short trial on architectural inputs picks the object generator instead of a guess. v1 ships one object generator and one depth model; there is no model picker.
- Trial first: before any feature code, a throwaway trial runs a fixed set of architectural inputs through the four fal candidates and the two depth candidates on this CPU, and records quality, time and cost. Its results settle owner decision 3 and the depth model.
- Licences: Weave is a personal prototype, used from Mexico and not monetized, so licence terms do not narrow the choice. Hunyuan models and non-commercial weights are allowed.
- Pipeline reuse: an image is a new source format, `image`, and generation is its importer. The converter turns the image into a GLB (from the provider, or from the depth mesh writer), then runs the existing GLB path (validate, gltfpack, manifest). Everything after that is the same as an uploaded GLB: status polling, the `model3d` shape, the viewer, thumbnails, revisions.
- Input: the client uploads the input image through the existing model upload routes. One image shape with no crop, flip or rotation sends the original file. Anything else is captured with `editor.toImage`.
- Data: one new server-only table, `model_generation`, one row per generated model, holding mode, generator, version, seed, prompt, parameters, input hash, provider task id, estimated cost and lineage. The `model` table gains no columns. `model3d` shape props do not change; provenance on the board is `meta.generatedFrom` with the source shape ids.
- Iteration: Regenerate creates a new model and places a new shape beside the old one, so variants sit side by side on the board. Nothing is replaced in place. Retry resumes the same model and never pays twice for a result it already has.
- Spend: a prepaid fal balance with automatic top-up off is the cap. No spend accounting in the app beyond the catalog estimate recorded per run.
- Secrets: provider keys live only in the converter's environment. The sync worker never calls a provider.
- Not in v1: Render sketch, a generator picker, Gaussian splats, standalone multi-view generation, direct sketch-to-3D models, scene generation (World Labs Marble), multi-photo reconstruction, self-hosted GPU inference, browser-side depth, cancel.

## Hardware

Checked on this machine on 2026-11-02:

| Part | Value                                                                      | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPU  | NVIDIA GTX 970M (GM204, Maxwell, sm_52), 3 GiB, nouveau driver, NVK Vulkan | No CUDA today. The proprietary driver for Maxwell is the legacy 580 branch ([590 supported chips](https://download.nvidia.com/XFree86/Linux-x86_64/590.48.01/README/supportedchips.html) omits GM204), CUDA 13 dropped pre-Turing ([release notes](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/index.html)), and PyTorch 2.15 drops Maxwell ([notice](https://dev-discuss.pytorch.org/t/notice-cuda-12-6-wheels-will-no-longer-be-published-from-pytorch-2-15-drops-maxwell-pascal-volta/3432)). Even with CUDA, 3 GiB fits none of the generators (6 to 24 GB). |
| iGPU | Intel HD 530 (Gen9)                                                        | Browser WebGPU on Linux is unreliable on Gen9, so no in-browser inference in v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CPU  | i7-6700HQ, 4 cores, 8 threads, AVX2                                        | Enough for a small depth model through ONNX Runtime (estimated 1 to 3 s per image; the trial measures it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RAM  | 23 GiB, about 14 GiB free                                                  | Enough for the converter, the depth model and gltfpack.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

So relief runs locally and object mode is hosted. If hosted cost or availability becomes the blocker, the same adapter interface takes a self-hosted TRELLIS.2 on Modal (L4 at about $0.80 per hour, [pricing](https://modal.com/pricing)); that is the documented fallback, not a v1 task.

## Approaches compared

### Single image to 3D mesh, open weights

| Model                                                                                                                                                           | Output                           | GPU                      | Licence                                                                                   | Architecture fit                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (Dec 2025)                                                                                                  | PBR GLB                          | 24 GB; 3 to 60 s on H100 | MIT                                                                                       | Objects, massing models                     |
| [TRELLIS](https://github.com/microsoft/TRELLIS) (Dec 2024)                                                                                                      | GLB, splats                      | 16 GB                    | MIT                                                                                       | Objects                                     |
| [Hunyuan3D 2.0, 2.1, Omni](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)                                                                                    | PBR mesh                         | 6 to 29 GB               | Tencent community licence                                                                 | Objects; among the strongest open models    |
| Hunyuan3D 2.5, 3.x                                                                                                                                              | PBR mesh                         | hosted only              | Tencent Cloud API, or [fal](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d) | Objects; trial candidate                    |
| [SF3D](https://github.com/Stability-AI/stable-fast-3d), [SPAR3D](https://github.com/Stability-AI/stable-point-aware-3d)                                         | UV-textured GLB                  | 6 to 10 GB, under 1 s    | Stability Community, free under $1M revenue, outputs yours                                | Objects, fast, lower quality                |
| [TripoSG](https://github.com/VAST-AI-Research/TripoSG) (+ scribble model)                                                                                       | Untextured GLB                   | 8 GB                     | MIT                                                                                       | Objects; the only sketch-trained open model |
| [Step1X-3D](https://github.com/stepfun-ai/Step1X-3D), [Direct3D-S2](https://github.com/DreamTechAI/Direct3D-S2), [Hi3DGen](https://github.com/Stable-X/Hi3DGen) | Mesh                             | 10 to 29 GB              | Apache-2.0, MIT, MIT                                                                      | Objects                                     |
| [Hi3D v1.0](https://github.com/hi3d-official/Hi3Dv1.0) (Oct 2026)                                                                                               | Geometry                         | sm80+, large             | Commercial with conditions                                                                | Objects; ten days old                       |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR), [InstantMesh](https://github.com/TencentARC/InstantMesh)                                                | Mesh                             | 6 GB                     | MIT, Apache-2.0                                                                           | Superseded                                  |
| [SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects) (Nov 2025)                                                                                 | Splat plus GLB per masked object |                          | SAM licence, commercial allowed                                                           | Furniture in real rooms                     |

Every one of these is object-centric: one normalized closed object with invented hidden sides, no absolute scale ([Hi3D README](https://github.com/hi3d-official/Hi3Dv1.0) says so directly). They suit massing sketches, building renders on a plain background, furniture and fixtures. They do poorly on street photos of facades and on interiors, where they invent a back and a scale that never existed.

### Hosted APIs

| Service                                                                              | Price per textured run                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [fal](https://fal.ai/models/fal-ai/trellis-2)                                        | TRELLIS.2 $0.25 to $0.35; [Hunyuan3D 3.1 Pro](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d) $0.375; [Tripo H3.1](https://fal.ai/models/tripo3d/h3.1/image-to-3d) $0.20 to $0.40; Meshy 6 $0.80 | Queue API with polling; one key for many models. Request history kept 90 days unless `X-Fal-Store-IO: 0` ([retention](https://fal.ai/docs/model-apis/data-retention)); CDN files have a separate lifecycle setting ([media expiration](https://fal.ai/docs/documentation/model-apis/media-expiration)) |
| [Tripo direct](https://www.tripo3d.ai/api)                                           | 20 to 30 credits at $0.01                                                                                                                                                                                      | Signed webhooks, PBR GLB, multiview input                                                                                                                                                                                                                                                              |
| [Meshy direct](https://docs.meshy.ai/en/api/image-to-3d)                             | [30 credits](https://docs.meshy.ai/en/api/pricing), about $0.60 on Pro                                                                                                                                         | API needs a paid plan; multi-image, remesh, PBR; outputs deleted after 3 days                                                                                                                                                                                                                          |
| [Rodin](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5)                   | unclear credit price                                                                                                                                                                                           | Multipart upload only                                                                                                                                                                                                                                                                                  |
| [Stability SPAR3D](https://docs.stability.ai/api-reference/3d/stable-point-aware-3d) | $0.04                                                                                                                                                                                                          | Synchronous, cheap, lower quality                                                                                                                                                                                                                                                                      |
| [Tencent Cloud Hunyuan 3D](https://www.tencentcloud.com/document/product/1284/75281) | 15 to 35 credits at $0.02                                                                                                                                                                                      | Pro lists a sketch mode (not tested); the same models are on fal                                                                                                                                                                                                                                       |

Output retention runs from one hour (Replicate) to days (Meshy 3, Rodin 7), so the converter copies the GLB to R2 at once.

### Sketch to 3D

Direct sketch-to-3D models (Magic3DSketch, SketchDream, SS2M) are research code on object datasets. TripoSG's scribble model is the only maintained one, and it is untextured. Hosted products have no sketch endpoint; their "sketch" claims mean feeding the sketch in as the image. A single sketch is weak evidence for geometry, so the generator invents depth and materials.

The mature route is two steps: sketch, then a rendered image from an image-edit model, then image to 3D. The middle image is where the architect corrects intent before paying for 3D. Image-edit models with hosted endpoints: [FLUX.2 klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) ([fal edit](https://fal.ai/models/fal-ai/flux-2/klein/4b/edit), $0.01 per megapixel) and [Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) ([fal](https://fal.ai/models/fal-ai/qwen-image-edit-2511), $0.03 per megapixel).

Decision: v1 sends sketches straight to object mode, which the trial tests. Render sketch comes after v1 as its own action that places an image shape (see "After v1").

### Multi-view generation

Zero123++, SV3D, Era3D and MV-Adapter were a separate step before native 3D generators. TRELLIS.2 and the hosted models now take one image directly. For buildings, users usually have several real photos, which beat generated views. Not in v1; multi-image input to a provider (Meshy and Tripo take 1 to 4 images) is the later step.

### Monocular depth to a 2.5D relief

| Model                                                                                                                   | Licence                                                                    | Output                                       | Runs                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MoGe-2](https://github.com/microsoft/MoGe)                                                                             | MIT code and [weights](https://huggingface.co/Ruicheng/moge-2-vitl-normal) | Metric point map and normals                 | [ONNX export](https://github.com/microsoft/MoGe/blob/main/docs/onnx.md) is the raw forward pass; focal and shift recovery and reprojection must be ported |
| [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3) Small, Base, Metric-Large, Mono-Large, Large-1.1 | Apache-2.0 (original Large and Giant are CC BY-NC)                         | Small and Base relative; Metric-Large metric | [ONNX on Hugging Face](https://huggingface.co/onnx-community/depth-anything-v3-small)                                                                     |
| [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) Small                                           | Apache-2.0 (others CC BY-NC)                                               | Relative depth                               | ONNX, transformers.js                                                                                                                                     |
| Depth Pro, UniDepth                                                                                                     | research and CC BY-NC weights                                              | Metric                                       | heavier on CPU than MoGe-2, no gain for this use                                                                                                          |
| Marigold                                                                                                                | OpenRAIL++-M                                                               | Affine-invariant, diffusion, slow            | not worth it on CPU                                                                                                                                       |

The converter turns depth into a mesh: a 256 to 512 grid displaced along camera rays, triangles cut where depth jumps, simplified, textured with the photo, written with the converter's own GLB writer, then gltfpack. MoGe-2 ViT-S is the candidate because its metric points give an estimated real scale and it recovers the camera. Its ONNX export is only the forward pass, so the converter ports the focal and shift recovery and the reprojection, and the trial checks the port against the reference Python output before anything else is built. Depth Anything 3 Small is the alternative: simpler, but relative depth only, so its relief has unknown scale. The trial keeps one of the two.

A relief shows what the camera saw and nothing behind it. It holds up for camera moves of about 10 to 20 degrees, not an orbit, so the converter writes the recovered source camera into the manifest and the viewer opens a relief at that camera with orbit clamped. Glass, mirrors and repeated window grids confuse every depth model, and depth and scale are predictions, not measurements. Its value for a review board is that it invents no hidden geometry.

### Gaussian splats versus meshes

Splats look photographic, and three.js can show them through [Spark](https://github.com/sparkjsdev/spark) (MIT). [KHR_gaussian_splatting](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_gaussian_splatting) is ratified. They lose on everything else a review needs: no surface to measure or snap to, sectioning needs shader work, meshopt and gltfpack do not apply, files are tens of megabytes, and a single-image splat is only coherent near the source view. Single-image splat models exist (Apple SHARP, HY-World 2.0), but from one photo they add little over a relief. Splats stay out until there is a multi-photo capture feature that needs them.

### Buildings and interiors

| Input                                                              | Mode        | Why                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Massing sketch, building render on a plain background, model photo | object      | One dominant object, the case these models were trained for                                                                                                                                                                             |
| Furniture, fixture, product photo                                  | object      | Same                                                                                                                                                                                                                                    |
| Street photo of a facade, interior photo                           | relief      | Visible surfaces only, no invented back, estimated scale with MoGe-2                                                                                                                                                                    |
| Whole room or street as a navigable 3D scene                       | not offered | Open scene models (HY-World 2.0, MIDI) need large GPUs and have no hosted endpoint. [World Labs Marble](https://docs.worldlabs.ai/api/pricing) is the candidate later, at about $1.20 per world plus $2.80 per high-quality mesh export |

The dialog defaults to object mode and says in one line when relief is the better choice. It does not try to classify the image.

## Canvas flow

1. The user selects one or more shapes and runs **Make 3D** from the context menu. No keyboard shortcut in v1; the obvious ones are taken by the OS or by tldraw. The action is disabled for a selection that is only `model3d` shapes.
2. A small dialog picks the mode (object or relief, with one line saying relief suits facade and interior photos), an optional prompt if the chosen generator takes one, and the seed (random, shown so it can be reused). It names the provider for object mode and shows the catalog's cost estimate.
3. The client fixes the input and the placement before any network call:
   - One image shape with no crop, no flip and no rotation, whose asset is PNG, JPEG or WebP: fetch the asset's original `src` (user content is served with `access-control-allow-origin: *`, `packages/worker-shared/src/userAssetUploads.ts:188`) and upload those bytes.
   - Anything else: `editor.toImage(ids, { format: 'png', background: true, darkMode: false, padding: 32, pixelRatio: undefined, scale })`, with `scale` chosen so the long edge lands between 1024 and 2048 px. Passing `pixelRatio: undefined` makes image shapes inside the selection export from their original files, not from a downscaled CDN variant (`getSvgJsx.tsx:275`); rasterization still uses 2x. White background and light mode, because generators expect dark lines on a light ground.
   - Input above 10 MB or 4096 px is downscaled on the client.
   - The placement is computed now: to the right of the selection bounds, aspect matched to the input.
4. The client calls the existing `POST /app/models` with `sourceFormat: 'image'` and a `generation` block, uploads the bytes through the existing part route, and completes the upload. For a capture it also uploads the PNG through the normal asset store, to use as the pending thumbnail.
5. Once those requests succeed, and only if the editor and the target page still exist, one synchronous `editor.run` after a history mark creates the asset (for a capture) and the `model3d` shape with `meta.generatedFrom = { sourceShapeIds }`, so one undo removes both. While pending, the shape's `assetId` points at the input image (the existing asset for an untouched image shape, the new one for a capture) and the shape shows it dimmed with the stage and percentage from the status poll (`Generating 40%`, then `Optimizing`).
6. When the model is ready, the shape behaves like any uploaded model: the viewer opens on double-click, and the first open replaces the thumbnail with a real render (the stage 2b behaviour).
7. A generated shape's context menu adds **Regenerate** (same input, new seed, optional new prompt) and **Select source shapes** (selects the ids in `meta.generatedFrom` that still exist). Regenerate copies the input on the server from the previous model, so it works after the sketch is edited or deleted. Running Make 3D again on an edited sketch is the normal way to iterate on the drawing itself.

Failure leaves the shape in place with the error and **Retry**, which re-dispatches the same model and resumes from whatever it already has (see "Recovery").

## Pipeline and contract changes

### Where it fits the stage 1 and 2a pipeline

- `image` joins `Model3dSourceFormat`. The source object in R2 is the input image, under the same key an uploaded model's source uses.
- The converter's pipeline dispatch gains `pipeline/image.ts`. For object mode it calls the generator, stores the raw provider GLB as the `generated.glb` artifact (providers delete outputs within hours to days, and keeping it allows re-packing without paying again), then hands the file to the existing `glb.ts` and `pack.ts`. For relief it runs the depth model, builds the mesh, writes a GLB with the existing writer (extended to carry one base-colour texture and UVs, if 2a's writer does not), then `pack.ts`.
- Status, stage, progress, error codes, the HMAC job token, the artifact routes, the status poll and the manifest all stay as they are, with the additions below.

### Where it does not fit

- **Converter network rule.** The prototype converter fetches only the worker's own URLs. Generation calls fal and downloads fal's result URLs, so the converter gets an egress allowlist in one fetch wrapper: the worker origin, plus host suffixes `fal.run` and `fal.media` (results come from several hosts such as `v3.fal.media` and `v3b.fal.media`) and fal's storage upload host, confirmed against real responses and redirects in the trial.
- **One job at a time.** An object job holds the converter's single slot for one to five minutes while the provider works, so an IFC conversion queued behind it waits. Acceptable for one user; a separate network lane is a later change if it hurts.
- **Recovery.** The prototype's converter is stateless and a crash loses the job. Generation costs money, so see "Recovery" below.
- **Scale.** Object-mode models have no real scale; the manifest records `units: 'unknown'`. Relief with MoGe-2 records `'m'`, shown as estimated; relief with Depth Anything 3 Small records `'unknown'`.
- **Cost.** Uploads cost nothing per model; generations cost money. fal does not return a billed amount, so the row stores the catalog estimate, and the prepaid balance is the hard limit.
- **New runtime package.** The prototype allows only `three`, `web-ifc` and `gltfpack`. Relief adds `onnxruntime-node` to the converter. It has a postinstall script, so it needs an `allowBuilds` entry in `pnpm-workspace.yaml`; its CPU binaries ship in the package, so `false` should work, which G2 confirms.

### Recovery

1. Before submitting, the converter posts `stage: 'generating'` and waits for the worker to acknowledge it; if that fails it does not submit. After the provider accepts, it posts `providerTaskId` at once, before polling.
2. The converter writes `generated.glb` before packing. The job token also authorizes reading it back.
3. When the client's status poll sees a `converting` job with no update for two minutes, the worker re-dispatches it with a fresh token and a `resume` block: if `generated.glb` exists, the converter skips generation; if only `providerTaskId` exists, it resumes polling the provider; if neither exists and the stored stage is `generating`, the provider may have accepted a request whose id was lost, so the job fails with `generation_failed` and a message rather than paying again blindly. That rule applies to hosted object jobs only; a relief job has nothing to pay for and simply restarts from the stored source.
4. Retry (user action) follows the same order. Only Regenerate, or Retry on a job that never reached the provider, submits a new paid request.

### Contract changes in `packages/dotcom-shared/src/model3d/`

- `manifest.ts`: `Model3dSourceFormat` adds `'image'`, and an optional `sourceView: Model3dCamera` is written for reliefs. The viewer uses it as the opening camera when the shape has no `defaultView`, with orbit clamped to about 20 degrees.
- `api.ts`:
  - `Model3dConvertStage` adds `'generating'`.
  - `Model3dErrorCode` adds `'generation_failed'`, `'generation_rejected'` (the provider refused the input, for example moderation) and `'provider_unavailable'` (no key, quota, outage).
  - `Model3dArtifactName` adds `'generated.glb'`.
  - `CreateModelRequest` gains `generation?: Model3dGenerationRequest` (required when `sourceFormat` is `'image'`) and `regenerateFrom?: string` (an image-sourced model whose input is copied).
  - `CreateModelResponse` becomes a union: the existing upload variant, or `{ modelId, status: 'queued' }` for `regenerateFrom`, which needs no upload.
  - `Model3dConvertJob` gains `generation?: Model3dGenerationJob` (mode, generator id, params, seed, prompt) and `resume?: { providerTaskId: string | null; hasGeneratedGlb: boolean }`.
  - The `converting` variant of `Model3dJobStatusRequest` gains optional `generation` fields: `providerTaskId`, `generatorVersion` (nullable, providers may not report one), `inputSha256` (computed by the converter after it reads the source), and the resolved `seed` and `params`.
  - `GetModelStatusResponse` gains `generation: Model3dGenerationSummary | null` (mode, generator, generator version, seed, prompt, params, estimated cost, parent model id).
  - Route `retry: '/app/models/:modelId/retry'`, which runs the recovery decision for a failed model.
- New `generators.ts`: the catalog. Each entry has an id, kind (`object` or `relief`), provider endpoint, label, estimated cost and time, and whether it takes a prompt or a seed. v1 has the trial's winners only, one per kind. The worker rejects ids that are not in the catalog.
- New `generation.ts`: the request, job and summary types and their validators, and `Model3dGeneratedFromMeta`.

No shape prop changes and no shape migration. The `model3d` shape is the same record whether its model came from an upload or a generator.

### Table

Migration `055_model_generation.sql`, server-only like `model`:

| Column                     | Type                                        | Notes                                                                |
| -------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `modelId`                  | VARCHAR PK, FK to `model` ON DELETE CASCADE | one row per generated model                                          |
| `mode`                     | VARCHAR, CHECK `object` or `relief`         |                                                                      |
| `generator`                | VARCHAR                                     | catalog id                                                           |
| `generatorVersion`         | VARCHAR NULL                                | what the provider reports, or the weights hash for local models      |
| `params`                   | JSONB                                       | resolution, texture flag, and other per-generator settings           |
| `prompt`                   | TEXT NULL                                   |                                                                      |
| `seed`                     | BIGINT NULL                                 |                                                                      |
| `inputSha256`              | VARCHAR NULL                                | set by the converter once it has read the source                     |
| `parentModelId`            | VARCHAR NULL                                | set by Regenerate                                                    |
| `providerTaskId`           | VARCHAR NULL                                | stored as soon as the provider accepts, so recovery never pays twice |
| `estimatedCostUsd`         | NUMERIC NULL                                | from the catalog; fal does not report billed cost                    |
| `createdAt`, `completedAt` | BIGINT, BIGINT NULL                         |                                                                      |

A sibling table, not columns on `model`, because the upload path never touches these fields and every column would be null for uploaded models. The `model` row's `sourceFormat` is `'image'` and its `sourceBytes` the input size.

Prompts, seeds and generator versions are recorded in this table and nowhere else; the client sees them through the status response. The board document records only `meta.generatedFrom`, because shape ids can go stale under deletion and copy and should not be the source of truth.

## Licences

Weave is a personal prototype, used from Mexico and not monetized. Licence terms therefore do not narrow the choice: Hunyuan, whose licence excludes only the EU, UK and South Korea, and non-commercial weights are both allowed. The licence columns above stay as a pointer in case that changes.

## Risks

1. Object generators may simply be poor on architectural inputs. The trial runs a fixed set (massing sketch, pencil sketch, plain-background render, facade photo, interior photo, furniture photo) through each candidate first. If none is useful, v1 ships relief only.
2. The MoGe-2 port may not match the reference output, or may be too slow on this CPU. The trial checks both before G0; Depth Anything 3 Small is the fallback, at the cost of unknown scale.
3. Spend. Regenerates are cheap individually and add up. The prepaid balance with top-up off bounds it; the dialog shows the estimate.
4. Provider churn. Endpoints, prices and versions change monthly. The catalog is one file and `generatorVersion` records what ran when the provider reports it.
5. A lost provider task id between acceptance and the first status post. Rare; the job fails visibly rather than paying again.
6. Generated GLBs with 4K PBR textures exceed the viewer's texture budget. The existing GLB path applies texture limits; generator params request 2K where offered.
7. Room growth: each run adds one image asset and one shape. Negligible against the 25 MB cap, which is a soft warning (`packages/dotcom-shared/src/constants.ts:4`).

## Rejected options

- **Self-hosted open models on a rented GPU** (TRELLIS.2 on Modal or RunPod). Cheapest at volume and fully under our control, but it needs a 24 GB GPU, a Python service with CUDA to own, and cold starts. Too much for a solo prototype; it remains the fallback behind the same adapter interface.
- **Meshy direct as the default.** Good quality and features, and the owner's first suggestion, but the API needs a subscription and it is the most expensive at about $0.60 a run. Meshy 6 stays in the trial through fal.
- **Tripo direct as the only adapter.** A good API, but it reaches only Tripo's models, and Tripo H3.1 is on fal anyway.
- **A generator picker, a second depth model, and a separate network lane.** Cut in council round 1. The trial picks one of each; the picker and lane can come back if real use asks for them.
- **An in-app monthly spend cap.** Concurrent jobs, unbilled estimates and failed-but-billed runs make it leaky; the provider's prepaid balance is an exact cap for one user.
- **Calling providers from the sync worker.** Would put keys in the worker and need Durable Object alarms to poll multi-minute jobs, and the GLB still has to reach gltfpack in the converter.
- **A new `model3d-generated` shape or new props.** The record would differ only by provenance, which belongs on the server; a second shape type doubles the schema registration sites.
- **A provenance binding.** Real bindings need a `BindingUtil`, a schema entry and migrations, for a link that is fine being stale.
- **Replacing a model in place on regenerate.** Loses the comparison that makes a canvas useful and complicates undo.
- **In-browser depth (transformers.js).** Unreliable WebGPU on this hardware, and it would split the pipeline in two. Possible later as an instant preview.
- **Gaussian splats, multi-view generation, direct sketch models, scene generation.** See above.
- **Cancel.** Providers bill on submit; deleting the shape is enough in a prototype.

## After v1

- **Render sketch.** Captures a sketch, sends it with an optional prompt to an image-edit model on fal through a worker route and a converter endpoint, and places the result as an ordinary image shape with `meta.renderedFrom`. It has no `model` row. The user then runs Make 3D on the image.
- Multi-image input for object mode, a second adapter (Tripo direct or self-hosted TRELLIS.2 on Modal), and Marble for whole rooms, each only if v1 use asks for it.

## Decisions the owner makes

1. The object generator, chosen from the trial results, or relief only if none is useful.
2. The prepaid fal balance (suggested $20) with automatic top-up off, set before stage T sends its first request.

## Changes after council round 1

Both reviewers scored the draft 7/10 and agreed on the main choices. Changes:

- A trial before G0 picks one object generator and one depth model, measures this CPU, and records endpoint terms. The generator picker, the second depth model and the network lane are cut. Render sketch moves after v1.
- MoGe-2's ONNX export needs its post-processing ported and checked against the reference. Relief keeps the source camera, opens at it with clamped orbit, and labels scale as estimated or unknown. "Invents nothing" became "invents no hidden geometry".
- Recovery moved from hardening into G1 and G2: task id stored at acceptance, `generated.glb` readable on resume, re-dispatch from the status poll, no blind resubmission.
- Contracts: a queued variant of `CreateModelResponse` for Regenerate, nullable input hash set by the converter, generator version and resolved params in the callback, params and estimated cost in the summary, `approved` catalog entries instead of a licence-string test.
- The in-app spend cap became a prepaid balance.
- The client fixes input and placement before network calls and creates the asset and shape in one synchronous `editor.run`. Flipped or rotated images are captured, not sent as originals.
- fal egress is matched by host suffix and its CDN retention is configured separately from request history.
- `onnxruntime-node` is a recorded exception to the prototype's package list, with an `allowBuilds` entry.

## Changes after council round 2

Astra 8/10, Sol 9/10. Both asked for the same two fixes, and Astra for a third:

- The converter stores `generating`, acknowledged by the worker, before any paid submit, so a crash after acceptance can never look like a safe restart.
- The prepaid balance and approval of the trial's endpoints and inputs come before stage T, not at integration.
- The "possibly accepted" failure applies to hosted object jobs only; relief restarts from the source.

## Changes after owner review

The owner works from Mexico on a personal prototype that will not be monetized, and asked to drop the licensing work. Removed: the licensing section, the Tencent and non-commercial exclusions, catalog approval records, the endpoint-terms step in the trial, and the jurisdiction, provider-terms and client-drawings decisions. Added: Hunyuan3D 3.1 on fal as a fourth trial candidate.
