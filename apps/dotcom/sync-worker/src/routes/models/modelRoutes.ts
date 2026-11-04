import {
	CompleteUploadResponse,
	CreateModelResponse,
	DB,
	GetModelStatusResponse,
	MODEL3D_RETRYABLE_ERRORS,
	MODEL3D_ROUTES,
	Model3dArtifactName,
	Model3dConvertJob,
	Model3dConverterJobProbe,
	Model3dErrorCode,
	Model3dErrorResponse,
	Model3dJobStatusResponse,
	Model3dStatus,
	TlaModel,
	can,
	model3dPaths,
	signModel3dJobToken,
	verifyModel3dJobToken,
} from '@tldraw/dotcom-shared'
import { uniqueId } from '@tldraw/utils'
import { createRouter } from '@tldraw/worker-shared'
import { IRequest } from 'itty-router'
import { Kysely } from 'kysely'
import { createPostgresConnectionPool } from '../../postgres'
import { Environment } from '../../types'
import { getAuth } from '../../utils/tla/getAuth'
import { getFileRecordWithRole } from '../../utils/tla/getRole'
import { buildGlbResponse, rangeNotSatisfiable } from './glbResponse'
import {
	MODEL_ARTIFACT_NAMES,
	MODEL_JOB_EXPIRY_MS,
	MODEL_JOB_LIMITS,
	MODEL_JOB_PROBE_AFTER_MS,
	MODEL_JOB_PROBE_TIMEOUT_MS,
	MODEL_JOB_TOKEN_TTL_MS,
	MODEL_MAX_MANIFEST_BYTES,
	MODEL_MAX_SOURCE_BYTES,
	MODEL_PART_SIZE,
	getConverterJobProbeUrl,
	getConverterUrl,
	getModelWorkerOrigin,
	modelKeys,
} from './modelConfig'
import {
	isPartNumber,
	parseCompleteUploadRequest,
	parseCreateModelRequest,
	parseJobStatusRequest,
	parseModel3dManifest,
} from './validate'

class ModelError extends Error {
	constructor(
		readonly status: number,
		readonly code: Model3dErrorCode,
		message?: string
	) {
		super(message ?? code)
	}
}

function fail(status: number, code: Model3dErrorCode, message?: string): never {
	throw new ModelError(status, code, message)
}

type Handler = (request: IRequest, env: Environment, ctx: ExecutionContext) => Promise<Response>

function handle(handler: Handler): Handler {
	return async (request, env, ctx) => {
		try {
			return await handler(request, env, ctx)
		} catch (error) {
			if (!(error instanceof ModelError)) throw error
			const body: Model3dErrorResponse = { error: error.code }
			if (error.message !== error.code) body.message = error.message
			return Response.json(body, { status: error.status })
		}
	}
}

async function withDb<T>(env: Environment, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
	const db = createPostgresConnectionPool(env, 'sync-worker/models')
	try {
		return await fn(db)
	} finally {
		await db.destroy()
	}
}

function getBucket(env: Environment): R2Bucket {
	return env.MODELS ?? fail(503, 'internal_error', 'The MODELS bucket is not bound')
}

async function requireUserId(request: IRequest, env: Environment): Promise<string> {
	const auth = await getAuth(request, env)
	return auth?.userId ?? fail(401, 'unauthorized')
}

function isMember(role: string | null) {
	return can(role, 'accessFiles')
}

function modelIdParam(request: IRequest): string {
	const modelId = request.params.modelId
	return typeof modelId === 'string' && modelId ? modelId : fail(404, 'not_found')
}

const CONVERTING: Model3dStatus[] = ['queued', 'converting']

async function loadModel(db: Kysely<DB>, modelId: string): Promise<TlaModel> {
	const model = await db
		.selectFrom('model')
		.selectAll()
		.where('id', '=', modelId)
		.executeTakeFirst()
	return model ?? fail(404, 'not_found')
}

async function loadModelForMember(
	db: Kysely<DB>,
	modelId: string,
	userId: string
): Promise<TlaModel> {
	const row = await db
		.selectFrom('model')
		.selectAll('model')
		.select((eb) =>
			eb
				.selectFrom('group_user')
				.select('group_user.role')
				.whereRef('group_user.groupId', '=', 'model.owningGroupId')
				.where('group_user.userId', '=', userId)
				.as('role')
		)
		.where('model.id', '=', modelId)
		.executeTakeFirst()
	if (!row) fail(404, 'not_found')
	const { role, ...model } = row
	if (!isMember(role ?? null)) fail(403, 'forbidden')
	return model
}

function contentLength(request: IRequest): number {
	const header = request.headers.get('content-length')
	const length = header === null ? NaN : Number(header)
	return Number.isSafeInteger(length) && length >= 0
		? length
		: fail(411, 'bad_request', 'Content-Length is required')
}

async function readJson(request: IRequest): Promise<unknown> {
	return request.json().catch(() => fail(400, 'bad_request', 'Invalid JSON'))
}

// User-facing routes.

async function createModel(request: IRequest, env: Environment): Promise<Response> {
	const userId = await requireUserId(request, env)
	const body = parseCreateModelRequest(await readJson(request)) ?? fail(400, 'bad_request')
	if (body.sourceBytes > MODEL_MAX_SOURCE_BYTES) fail(413, 'too_large')
	const bucket = getBucket(env)

	return withDb(env, async (db) => {
		const record = await getFileRecordWithRole(db, body.fileId, userId)
		if (!record || record.file.isDeleted) fail(404, 'not_found')
		const groupId = record.file.owningGroupId
		if (!groupId || !isMember(record.role)) fail(403, 'forbidden')

		const modelId = uniqueId()
		const upload = await bucket.createMultipartUpload(modelKeys.source(modelId))
		const now = Date.now()
		await db
			.insertInto('model')
			.values({
				id: modelId,
				owningGroupId: groupId,
				createdBy: userId,
				name: body.name,
				sourceFormat: body.sourceFormat,
				sourceBytes: body.sourceBytes,
				status: 'uploading',
				stage: null,
				progress: 0,
				errorCode: null,
				manifest: null,
				uploadId: upload.uploadId,
				jobId: null,
				createdAt: now,
				updatedAt: now,
			})
			.execute()

		const response: CreateModelResponse = {
			modelId,
			uploadId: upload.uploadId,
			partSize: MODEL_PART_SIZE,
		}
		return Response.json(response)
	})
}

async function uploadModelPart(request: IRequest, env: Environment): Promise<Response> {
	const modelId = modelIdParam(request)
	const partNumber = Number(request.params.partNumber)
	if (!isPartNumber(partNumber)) fail(400, 'bad_request', 'Invalid part number')
	const userId = await requireUserId(request, env)
	const bucket = getBucket(env)
	const model = await withDb(env, async (db) => {
		const model = await loadModelForMember(db, modelId, userId)
		// Lets other tabs tell a live upload from an abandoned one.
		if (model.status === 'uploading') {
			await db
				.updateTable('model')
				.set({ updatedAt: Date.now() })
				.where('id', '=', modelId)
				.where('status', '=', 'uploading')
				.execute()
		}
		return model
	})
	if (model.status !== 'uploading' || !model.uploadId) fail(409, 'invalid_state')
	if (partNumber > Math.ceil(model.sourceBytes / MODEL_PART_SIZE)) {
		fail(400, 'bad_request', 'Part number past the declared size')
	}
	const length = contentLength(request)
	if (length === 0 || !request.body) fail(400, 'bad_request', 'Empty part')
	if (length > MODEL_PART_SIZE) fail(413, 'too_large')

	const upload = bucket.resumeMultipartUpload(modelKeys.source(modelId), model.uploadId)
	const part = await upload
		.uploadPart(partNumber, request.body)
		.catch((error: Error) => fail(400, 'bad_request', error.message))
	return Response.json({ partNumber, etag: part.etag })
}

async function completeModelUpload(
	request: IRequest,
	env: Environment,
	ctx: ExecutionContext
): Promise<Response> {
	const modelId = modelIdParam(request)
	const userId = await requireUserId(request, env)
	const body = parseCompleteUploadRequest(await readJson(request)) ?? fail(400, 'bad_request')
	const bucket = getBucket(env)

	const status = await withDb(env, async (db): Promise<Model3dStatus> => {
		const model = await loadModelForMember(db, modelId, userId)
		const now = Date.now()

		if (model.status === 'uploading') {
			if (!model.uploadId) fail(409, 'invalid_state')
			if (body.parts.length === 0) fail(400, 'bad_request', 'No parts to complete')
			let size: number
			try {
				const upload = bucket.resumeMultipartUpload(modelKeys.source(modelId), model.uploadId)
				size = (await upload.complete(body.parts)).size
			} catch (error) {
				// A concurrent complete got there first.
				const current = await loadModel(db, modelId)
				if (current.status !== 'uploading') return current.status
				// Or an earlier complete finished in R2 and was interrupted before the update below,
				// which would otherwise leave the row uploading for good.
				const source = await bucket.head(modelKeys.source(modelId))
				if (source?.size !== model.sourceBytes) {
					fail(400, 'upload_incomplete', (error as Error).message)
				}
				size = source.size
			}
			const claimed = await db
				.updateTable('model')
				.set({
					status: 'queued',
					uploadId: null,
					sourceBytes: size,
					jobId: uniqueId(),
					updatedAt: now,
				})
				.where('id', '=', modelId)
				.where('status', '=', 'uploading')
				.returningAll()
				.executeTakeFirst()
			if (!claimed) return (await loadModel(db, modelId)).status
			ctx.waitUntil(dispatchJob(env, claimed))
			return 'queued'
		}

		// The client's retry: run the conversion again from the stored source. The new attempt writes
		// under its own job id, so the old attempt's artifacts are left where they are.
		if (model.status === 'failed') {
			if (!(await bucket.head(modelKeys.source(modelId)))) fail(409, 'source_required')
			const claimed = await db
				.updateTable('model')
				.set({
					status: 'queued',
					stage: null,
					progress: 0,
					errorCode: null,
					manifest: null,
					jobId: uniqueId(),
					updatedAt: now,
				})
				.where('id', '=', modelId)
				.where('status', '=', 'failed')
				.returningAll()
				.executeTakeFirst()
			if (!claimed) return (await loadModel(db, modelId)).status
			ctx.waitUntil(dispatchJob(env, claimed))
			return 'queued'
		}

		return model.status
	})

	const response: CompleteUploadResponse = { status }
	return Response.json(response)
}

// Jobs the converter confirmed, by job id, with when. Per isolate: a fresh isolate probes again.
const confirmedJobs = new Map<string, number>()

/**
 * Asks the converter whether it still holds the row's attempt. A miss is the error to fail the row
 * with; null means the job is alive, or was confirmed less than a probe interval ago.
 */
async function probeConverterJob(
	env: Environment,
	model: TlaModel
): Promise<Model3dErrorCode | null> {
	const now = Date.now()
	const jobId = model.jobId
	if (!jobId) return 'conversion_failed'
	for (const [id, at] of confirmedJobs) {
		if (now - at >= MODEL_JOB_PROBE_AFTER_MS) confirmedJobs.delete(id)
	}
	if (confirmedJobs.has(jobId)) return null
	let response: Response
	try {
		response = await fetch(getConverterJobProbeUrl(env, model.id), {
			signal: AbortSignal.timeout(MODEL_JOB_PROBE_TIMEOUT_MS),
		})
	} catch {
		return 'converter_unavailable'
	}
	if (response.status === 404) return 'conversion_failed'
	if (!response.ok) return 'converter_unavailable'
	const probe = (await response.json().catch(() => null)) as Model3dConverterJobProbe | null
	if (probe?.jobId !== jobId) return 'conversion_failed'
	confirmedJobs.set(jobId, now)
	return null
}

/**
 * A converter crash or restart forgets its queue, leaving the row queued or converting for good.
 * Failed here, as the client polls, so its Retry appears: once the row has been quiet for a probe
 * interval and the converter does not confirm the job, or at the expiry whatever the converter
 * says. The `updatedAt` match keeps this from overwriting a report that landed meanwhile, and the
 * attempt check keeps the old job from writing over the retry should it turn out to be alive.
 */
async function expireAbandonedJob(
	env: Environment,
	db: Kysely<DB>,
	model: TlaModel
): Promise<TlaModel> {
	if (!CONVERTING.includes(model.status)) return model
	const quietMs = Date.now() - model.updatedAt
	const errorCode =
		quietMs > MODEL_JOB_EXPIRY_MS
			? 'conversion_timeout'
			: quietMs > MODEL_JOB_PROBE_AFTER_MS
				? await probeConverterJob(env, model)
				: null
	if (!errorCode) return model
	const expired = await db
		.updateTable('model')
		.set({ status: 'failed', stage: null, errorCode, updatedAt: Date.now() })
		.where('id', '=', model.id)
		.where('jobId', '=', model.jobId)
		.where('status', 'in', CONVERTING)
		.where('updatedAt', '=', model.updatedAt)
		.returningAll()
		.executeTakeFirst()
	return expired ?? (await loadModel(db, model.id))
}

async function getModelStatus(request: IRequest, env: Environment): Promise<Response> {
	const modelId = modelIdParam(request)
	const userId = await requireUserId(request, env)
	const model = await withDb(env, async (db) =>
		expireAbandonedJob(env, db, await loadModelForMember(db, modelId, userId))
	)
	const response: GetModelStatusResponse = {
		modelId: model.id,
		name: model.name,
		sourceFormat: model.sourceFormat,
		status: model.status,
		stage: model.stage,
		progress: model.progress,
		errorCode: model.errorCode,
		manifest: model.manifest,
		updatedAt: model.updatedAt,
	}
	return Response.json(response, { headers: { 'cache-control': 'no-store' } })
}

async function getModelGlb(request: IRequest, env: Environment): Promise<Response> {
	const modelId = modelIdParam(request)
	const userId = await requireUserId(request, env)
	const bucket = getBucket(env)
	const model = await withDb(env, (db) => loadModelForMember(db, modelId, userId))
	if (model.status !== 'ready' || !model.jobId) fail(409, 'invalid_state')

	const key = modelKeys.artifact(modelId, model.jobId, 'model.glb')
	let object: R2Object | R2ObjectBody | null
	try {
		object = await bucket.get(key, { range: request.headers, onlyIf: request.headers })
	} catch (error) {
		// R2 rejects a range it cannot satisfy.
		if (!request.headers.has('range')) throw error
		return rangeNotSatisfiable((await bucket.head(key))?.size ?? null)
	}
	return object ? buildGlbResponse(object, request) : fail(404, 'not_found')
}

// Converter-facing routes, authorized by the job token alone.

/** The conversion attempt the token was issued for. */
async function requireJobToken(
	request: IRequest,
	env: Environment,
	modelId: string
): Promise<string> {
	const secret = env.MODEL_JOB_SECRET ?? fail(503, 'internal_error', 'MODEL_JOB_SECRET is not set')
	const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')
	const jobId = match && (await verifyModel3dJobToken(secret, match[1], modelId))
	return jobId || fail(401, 'invalid_token')
}

/** Refuses a job a retry has replaced, so it cannot write over the newer attempt. */
function requireCurrentJob(model: TlaModel, jobId: string) {
	if (model.jobId !== jobId) fail(409, 'invalid_state', 'Superseded by a newer conversion')
	if (!CONVERTING.includes(model.status)) fail(409, 'invalid_state')
}

async function getModelSource(request: IRequest, env: Environment): Promise<Response> {
	const modelId = modelIdParam(request)
	const jobId = await requireJobToken(request, env, modelId)
	await withDb(env, async (db) => requireCurrentJob(await loadModel(db, modelId), jobId))
	const object = await getBucket(env).get(modelKeys.source(modelId))
	if (!object) fail(404, 'not_found')
	return new Response(object.body, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(object.size),
		},
	})
}

async function putModelArtifact(request: IRequest, env: Environment): Promise<Response> {
	const modelId = modelIdParam(request)
	const jobId = await requireJobToken(request, env, modelId)
	const name = request.params.name as Model3dArtifactName
	if (!MODEL_ARTIFACT_NAMES.includes(name)) fail(404, 'not_found')
	const bucket = getBucket(env)
	const length = contentLength(request)
	const maxBytes = name === 'model.glb' ? MODEL_JOB_LIMITS.maxGlbBytes : MODEL_MAX_MANIFEST_BYTES
	if (length > maxBytes) fail(413, 'too_large')
	if (length === 0 || !request.body) fail(400, 'bad_request', 'Empty artifact')

	return withDb(env, async (db) => {
		const model = await loadModel(db, modelId)
		requireCurrentJob(model, jobId)
		const key = modelKeys.artifact(modelId, jobId, name)

		if (name === 'model.glb') {
			await bucket.put(key, request.body, {
				httpMetadata: { contentType: 'model/gltf-binary' },
			})
		} else {
			const text = await request.text()
			let manifest
			try {
				manifest = parseModel3dManifest(JSON.parse(text))
			} catch {
				manifest = null
			}
			if (!manifest) fail(400, 'bad_request', 'Invalid manifest')
			if (
				manifest.sourceFormat !== model.sourceFormat ||
				(model.sourceFormat === '3dm' &&
					(manifest.version !== 2 || manifest.source.bytes !== model.sourceBytes))
			)
				fail(400, 'bad_request', 'Manifest does not match the source')
			await bucket.put(key, text, { httpMetadata: { contentType: 'application/json' } })
			await db
				.updateTable('model')
				.set({ manifest, updatedAt: Date.now() })
				.where('id', '=', modelId)
				.where('jobId', '=', jobId)
				.execute()
		}
		return Response.json({ ok: true })
	})
}

async function postModelJobStatus(request: IRequest, env: Environment): Promise<Response> {
	const modelId = modelIdParam(request)
	const jobId = await requireJobToken(request, env, modelId)
	const body = parseJobStatusRequest(await readJson(request)) ?? fail(400, 'bad_request')
	const bucket = getBucket(env)

	return withDb(env, async (db) => {
		const now = Date.now()
		const model = await loadModel(db, modelId)
		requireCurrentJob(model, jobId)
		let update: Partial<TlaModel>
		switch (body.status) {
			case 'converting':
				update = { status: 'converting', stage: body.stage, progress: body.progress }
				break
			case 'ready': {
				const [glb, manifest] = await Promise.all(
					MODEL_ARTIFACT_NAMES.map((name) => bucket.head(modelKeys.artifact(modelId, jobId, name)))
				)
				if (!glb || !manifest || !model.manifest) {
					fail(409, 'invalid_state', 'Artifacts are missing')
				}
				if (glb.size !== model.manifest.glbBytes) {
					fail(409, 'invalid_state', 'model.glb does not match the manifest')
				}
				update = { status: 'ready', stage: null, progress: 1, errorCode: null }
				break
			}
			case 'failed':
				console.error(`model ${modelId} failed: ${body.errorCode} ${body.message ?? ''}`)
				update = { status: 'failed', stage: null, errorCode: body.errorCode }
				break
		}
		const updated = await db
			.updateTable('model')
			.set({ ...update, updatedAt: now })
			.where('id', '=', modelId)
			.where('jobId', '=', jobId)
			.where('status', 'in', CONVERTING)
			.returning('id')
			.executeTakeFirst()
		if (!updated) fail(409, 'invalid_state')
		// The converter has decided about the file itself, so a retry could not do better. A retryable
		// failure keeps the source for Retry.
		const isFinal =
			body.status === 'ready' ||
			(body.status === 'failed' && !MODEL3D_RETRYABLE_ERRORS.includes(body.errorCode))
		if (model.sourceFormat === '3dm' && isFinal) {
			await queueSourceDelete(env, model)
			await bucket
				.delete(modelKeys.source(modelId))
				.catch((error) => console.error('3DM source deletion queued', error))
		}
		const response: Model3dJobStatusResponse = { ok: true }
		return Response.json(response)
	})
}

export async function buildConvertJob(
	env: Environment,
	model: TlaModel
): Promise<Model3dConvertJob> {
	const secret = env.MODEL_JOB_SECRET ?? fail(503, 'internal_error', 'MODEL_JOB_SECRET is not set')
	if (!model.jobId) fail(500, 'internal_error', 'The model has no job id')
	const origin = getModelWorkerOrigin(env)
	return {
		modelId: model.id,
		sourceFormat: model.sourceFormat,
		sourceName: model.name,
		sourceUrl: origin + model3dPaths.source(model.id),
		artifactUrlBase: `${origin}${model3dPaths.status(model.id)}/artifacts`,
		statusUrl: origin + model3dPaths.jobStatus(model.id),
		token: await signModel3dJobToken(
			secret,
			model.id,
			model.jobId,
			Date.now() + MODEL_JOB_TOKEN_TTL_MS
		),
		limits: MODEL_JOB_LIMITS,
	}
}

async function dispatchJob(env: Environment, model: TlaModel) {
	try {
		const response = await fetch(getConverterUrl(env), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(await buildConvertJob(env, model)),
			signal: AbortSignal.timeout(10_000),
		})
		if (response.ok) return
		console.error(`model converter refused job ${model.id}: ${response.status}`)
	} catch (error) {
		console.error(`model converter unreachable for job ${model.id}`, error)
	}
	// The source stays, so Retry works once the converter is back.
	await withDb(env, (db) =>
		db
			.updateTable('model')
			.set({ status: 'failed', errorCode: 'converter_unavailable', updatedAt: Date.now() })
			.where('id', '=', model.id)
			.where('jobId', '=', model.jobId)
			.where('status', '=', 'queued')
			.execute()
	).catch((error) => console.error(`could not mark model ${model.id} failed`, error))
}

export const modelRoutes = createRouter<Environment>()
	.post(MODEL3D_ROUTES.create, handle(createModel))
	.get(MODEL3D_ROUTES.status, handle(getModelStatus))
	.put(MODEL3D_ROUTES.uploadPart, handle(uploadModelPart))
	.post(MODEL3D_ROUTES.completeUpload, handle(completeModelUpload))
	.get(MODEL3D_ROUTES.glb, handle(getModelGlb))
	.get(MODEL3D_ROUTES.source, handle(getModelSource))
	.put(MODEL3D_ROUTES.artifact, handle(putModelArtifact))
	.post(MODEL3D_ROUTES.jobStatus, handle(postModelJobStatus))

/** Sent after the terminal commit and best effort, so a queue outage cannot block the status. */
async function queueSourceDelete(env: Environment, model: TlaModel) {
	if (model.sourceFormat !== '3dm' || !model.jobId) return
	await env.QUEUE.send({
		type: 'model-source-delete',
		modelId: model.id,
		jobId: model.jobId,
	}).catch((error) => console.error(`could not queue source deletion for model ${model.id}`, error))
}

/** Throws on an R2 failure so queue delivery retries; deleting a missing key succeeds. */
export async function deleteModelSource(env: Environment, modelId: string, jobId: string) {
	await withDb(env, async (db) => {
		const model = await db
			.selectFrom('model')
			.selectAll()
			.where('id', '=', modelId)
			.executeTakeFirst()
		if (!model || model.jobId !== jobId || model.sourceFormat !== '3dm') return
		if (CONVERTING.includes(model.status)) throw new Error('Model conversion has not finished')
		if (model.status === 'ready' || model.status === 'failed')
			await getBucket(env).delete(modelKeys.source(modelId))
	})
}
