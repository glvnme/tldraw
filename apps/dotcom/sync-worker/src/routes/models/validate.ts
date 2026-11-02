import {
	CompleteUploadRequest,
	CreateModelRequest,
	MODEL3D_SOURCE_FORMATS,
	Model3dConvertStage,
	Model3dErrorCode,
	Model3dJobStatusRequest,
	Model3dManifest,
	Model3dSourceFormat,
} from '@tldraw/dotcom-shared'
import { MODEL_MAX_NAME_LENGTH } from './modelConfig'

// Hand-written rather than a validator package: the worker bundle has a size budget and these
// shapes are small.

const STAGES: readonly Model3dConvertStage[] = ['fetching', 'parsing', 'optimizing', 'uploading']
const ERROR_CODES: readonly Model3dErrorCode[] = [
	'unauthorized',
	'forbidden',
	'not_found',
	'bad_request',
	'unsupported_format',
	'too_large',
	'invalid_state',
	'upload_incomplete',
	'invalid_token',
	'converter_unavailable',
	'conversion_failed',
	'conversion_timeout',
	'internal_error',
]
const UNITS: readonly Model3dManifest['units'][] = ['m', 'mm', 'cm', 'in', 'ft', 'unknown']

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0
}

function isVec3(value: unknown): value is [number, number, number] {
	return Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n))
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (list as readonly string[]).includes(value)
}

export function isModel3dSourceFormat(value: unknown): value is Model3dSourceFormat {
	return isOneOf(MODEL3D_SOURCE_FORMATS, value)
}

export function parseCreateModelRequest(body: unknown): CreateModelRequest | null {
	if (!isObj(body)) return null
	const { name, sourceFormat, sourceBytes, fileId } = body
	if (typeof name !== 'string' || !name.trim() || name.length > MODEL_MAX_NAME_LENGTH) return null
	if (!isModel3dSourceFormat(sourceFormat)) return null
	if (!isCount(sourceBytes) || sourceBytes === 0) return null
	if (typeof fileId !== 'string' || !fileId) return null
	return { name: name.trim(), sourceFormat, sourceBytes, fileId }
}

/** `parts` may be empty: the client retries a failed conversion with `{ parts: [] }`. */
export function parseCompleteUploadRequest(body: unknown): CompleteUploadRequest | null {
	if (!isObj(body) || !Array.isArray(body.parts)) return null
	const parts: CompleteUploadRequest['parts'] = []
	for (const part of body.parts) {
		if (!isObj(part) || !isPartNumber(part.partNumber) || typeof part.etag !== 'string') {
			return null
		}
		parts.push({ partNumber: part.partNumber, etag: part.etag })
	}
	return { parts }
}

export function isPartNumber(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10_000
}

export function parseJobStatusRequest(body: unknown): Model3dJobStatusRequest | null {
	if (!isObj(body)) return null
	switch (body.status) {
		case 'converting': {
			const { stage, progress } = body
			if (!isOneOf(STAGES, stage) || typeof progress !== 'number' || !Number.isFinite(progress)) {
				return null
			}
			return { status: 'converting', stage, progress: Math.min(1, Math.max(0, progress)) }
		}
		case 'ready':
			return { status: 'ready' }
		case 'failed': {
			const { errorCode, message } = body
			if (!isOneOf(ERROR_CODES, errorCode)) return null
			return {
				status: 'failed',
				errorCode,
				...(typeof message === 'string' ? { message: message.slice(0, 1000) } : null),
			}
		}
		default:
			return null
	}
}

export function parseModel3dManifest(value: unknown): Model3dManifest | null {
	if (!isObj(value) || value.version !== 1) return null
	const { bounds, transform, converter, meshes } = value
	if (!isObj(bounds) || !isVec3(bounds.min) || !isVec3(bounds.max)) return null
	if (!isOneOf(UNITS, value.units)) return null
	if (
		!isObj(transform) ||
		!isVec3(transform.recentreOffset) ||
		typeof transform.scale !== 'number' ||
		!Number.isFinite(transform.scale) ||
		(transform.upAxis !== 'y' && transform.upAxis !== 'z')
	) {
		return null
	}
	if (!isCount(value.triangleCount) || !isCount(value.nodeCount)) return null
	if (!isCount(value.textureBytesEstimate) || !isCount(value.glbBytes)) return null
	if (
		!Array.isArray(meshes) ||
		!meshes.every((m) => isObj(m) && typeof m.name === 'string' && isCount(m.triangleCount))
	) {
		return null
	}
	if (
		!isObj(converter) ||
		typeof converter.name !== 'string' ||
		typeof converter.version !== 'string' ||
		!Array.isArray(converter.args) ||
		!converter.args.every((a) => typeof a === 'string')
	) {
		return null
	}
	if (!isModel3dSourceFormat(value.sourceFormat)) return null
	return value as unknown as Model3dManifest
}
