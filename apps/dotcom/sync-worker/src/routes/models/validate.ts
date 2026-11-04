import {
	CompleteUploadRequest,
	CreateModelRequest,
	MODEL3D_ERROR_CODES,
	MODEL3D_SOURCE_FORMATS,
	Model3dConvertStage,
	Model3dJobStatusRequest,
	Model3dManifest,
	Model3dSourceFormat,
} from '@tldraw/dotcom-shared'
import { MODEL_MAX_NAME_LENGTH } from './modelConfig'

// Hand-written rather than a validator package: the worker bundle has a size budget and these
// shapes are small.

const STAGES: readonly Model3dConvertStage[] = ['fetching', 'parsing', 'optimizing', 'uploading']
const UNITS: readonly Model3dManifest['units'][] = ['m', 'mm', 'cm', 'in', 'ft', 'unknown']
const MANIFEST_MAX_TEXT_LENGTH = 256
const MANIFEST_MAX_WARNINGS = 16

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
			if (!isOneOf(MODEL3D_ERROR_CODES, errorCode)) return null
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
	if (!isObj(value) || (value.version !== 1 && value.version !== 2)) return null
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
	if (value.version === 2) {
		const { source, coverage, features, warnings } = value
		const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
		// File metadata is shown and stored as is, so a hostile file must not make it large.
		const text = (v: unknown) => typeof v === 'string' && v.length <= MANIFEST_MAX_TEXT_LENGTH
		if (
			!isObj(source) ||
			!text(source.filename) ||
			/[\\/]/.test(source.filename as string) ||
			!isCount(source.bytes) ||
			!hash(source.sha256) ||
			source.format !== value.sourceFormat ||
			!text(source.formatVersion) ||
			source.provenance !== 'service' ||
			!isObj(source.authoring) ||
			!text(source.authoring.application) ||
			!text(source.authoring.details) ||
			!isObj(source.document) ||
			!isCount(source.document.revision) ||
			!text(source.document.createdBy) ||
			!text(source.document.lastEditedBy) ||
			!isVec3(source.basePoint) ||
			(source.georeference !== undefined &&
				(!isObj(source.georeference) ||
					!['latitude', 'longitude', 'elevation'].every((key) =>
						Number.isFinite((source.georeference as Obj)[key])
					))) ||
			!isObj(source.units) ||
			!text(source.units.name) ||
			typeof source.units.metresPerUnit !== 'number' ||
			!Number.isFinite(source.units.metresPerUnit) ||
			source.units.metresPerUnit <= 0 ||
			!['file', 'assumed'].includes(source.units.basis as string) ||
			!isObj(source.counts) ||
			!['objects', 'rendered', 'skipped', 'layers', 'definitions'].every((key) =>
				isCount((source.counts as Obj)[key])
			) ||
			!Array.isArray(transform.sourceToModel) ||
			transform.sourceToModel.length !== 16 ||
			!transform.sourceToModel.every(Number.isFinite) ||
			!isObj(coverage) ||
			![
				'sourceObjects',
				'renderedObjects',
				'skippedObjects',
				'hiddenObjects',
				'missingFaces',
				'fallbackFaces',
			].every((key) => isCount(coverage[key])) ||
			!isObj(features) ||
			!isCount(features.count) ||
			features.attribute !== '_BATCHID' ||
			features.storage !== 'glb-asset-extras' ||
			!Array.isArray(warnings) ||
			warnings.length > MANIFEST_MAX_WARNINGS ||
			!warnings.every(
				(warning) =>
					isObj(warning) &&
					isCount(warning.count) &&
					[
						'units_assumed',
						'missing_render_mesh',
						'approximate_mesh',
						'unsupported_entity',
						'instance_depth_limit',
						'near_empty',
					].includes(warning.code as string)
			) ||
			!hash(value.glbSha256)
		)
			return null
	}
	return value as unknown as Model3dManifest
}
