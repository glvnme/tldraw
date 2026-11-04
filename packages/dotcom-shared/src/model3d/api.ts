import { Model3dManifest, Model3dSourceFormat } from './manifest'

export type Model3dStatus = 'uploading' | 'queued' | 'converting' | 'ready' | 'failed'

export const MODEL3D_TERMINAL_STATUSES: readonly Model3dStatus[] = ['ready', 'failed']

export type Model3dConvertStage = 'fetching' | 'parsing' | 'optimizing' | 'uploading'

export type Model3dArtifactName = 'model.glb' | 'manifest.json'

export const MODEL3D_ERROR_CODES = [
	'unauthorized',
	'forbidden',
	'not_found',
	'bad_request',
	'unsupported_format',
	'no_render_meshes',
	'source_required',
	'draco_unsupported',
	'too_large',
	'invalid_state',
	'upload_incomplete',
	'invalid_token',
	'converter_unavailable',
	'conversion_failed',
	'conversion_timeout',
	'internal_error',
] as const

export type Model3dErrorCode = (typeof MODEL3D_ERROR_CODES)[number]

export interface Model3dErrorResponse {
	error: Model3dErrorCode
	message?: string
}

/**
 * Sync worker routes, as itty-router patterns. The client reaches them under its `/api` prefix;
 * the converter gets absolute URLs in its job body.
 */
export const MODEL3D_ROUTES = {
	create: '/app/models',
	status: '/app/models/:modelId',
	uploadPart: '/app/models/:modelId/parts/:partNumber',
	completeUpload: '/app/models/:modelId/complete',
	glb: '/app/models/:modelId/glb',
	// converter-facing, authorized by the job token
	source: '/app/models/:modelId/source',
	artifact: '/app/models/:modelId/artifacts/:name',
	jobStatus: '/app/models/:modelId/job-status',
} as const

export const model3dPaths = {
	create: () => MODEL3D_ROUTES.create,
	status: (modelId: string) => `/app/models/${encodeURIComponent(modelId)}`,
	uploadPart: (modelId: string, partNumber: number) =>
		`/app/models/${encodeURIComponent(modelId)}/parts/${partNumber}`,
	completeUpload: (modelId: string) => `/app/models/${encodeURIComponent(modelId)}/complete`,
	glb: (modelId: string) => `/app/models/${encodeURIComponent(modelId)}/glb`,
	source: (modelId: string) => `/app/models/${encodeURIComponent(modelId)}/source`,
	artifact: (modelId: string, name: Model3dArtifactName) =>
		`/app/models/${encodeURIComponent(modelId)}/artifacts/${name}`,
	jobStatus: (modelId: string) => `/app/models/${encodeURIComponent(modelId)}/job-status`,
}

/** POST `create`. The workspace is resolved from `fileId`. */
export interface CreateModelRequest {
	name: string
	sourceFormat: Model3dSourceFormat
	sourceBytes: number
	fileId: string
}

export interface CreateModelResponse {
	modelId: string
	uploadId: string
	/** Every part but the last is exactly this many bytes. */
	partSize: number
}

/** PUT `uploadPart`; the body is the raw part bytes. */
export interface UploadPartResponse {
	partNumber: number
	etag: string
}

/** POST `completeUpload`. */
export interface CompleteUploadRequest {
	parts: { partNumber: number; etag: string }[]
}

export interface CompleteUploadResponse {
	status: Model3dStatus
}

/** GET `status`. Poll while the status is not terminal. */
export interface GetModelStatusResponse {
	modelId: string
	name: string
	sourceFormat: Model3dSourceFormat
	status: Model3dStatus
	stage: Model3dConvertStage | null
	/** 0 to 1. */
	progress: number
	errorCode: Model3dErrorCode | null
	manifest: Model3dManifest | null
}

/** POSTed by the worker to the converter service. */
export interface Model3dConvertJob {
	modelId: string
	sourceFormat: Model3dSourceFormat
	/** GET with `Authorization: Bearer <token>`. */
	sourceUrl: string
	sourceName?: string
	/** PUT `${artifactUrlBase}/model.glb` and `${artifactUrlBase}/manifest.json`. */
	artifactUrlBase: string
	/** POST `Model3dJobStatusRequest`. */
	statusUrl: string
	token: string
	limits: {
		maxSourceBytes: number
		maxGlbBytes: number
		maxTriangles: number
		timeoutMs: number
	}
}

/**
 * GET `<converter>/jobs/:modelId`, the worker's liveness probe: the attempt the converter holds for
 * the model, or 404 if it holds none.
 */
export interface Model3dConverterJobProbe {
	jobId: string
	state: 'queued' | 'running'
}

/** POST `jobStatus`, from the converter. */
export type Model3dJobStatusRequest =
	| { status: 'converting'; stage: Model3dConvertStage; progress: number }
	| { status: 'ready' }
	| { status: 'failed'; errorCode: Model3dErrorCode; message?: string }

export interface Model3dJobStatusResponse {
	ok: true
}
