import {
	CompleteUploadRequest,
	CompleteUploadResponse,
	CreateModelRequest,
	CreateModelResponse,
	MODEL3D_SOURCE_FORMATS,
	Model3dSourceFormat,
	UploadPartResponse,
	model3dPaths,
} from '@tldraw/dotcom-shared'
import { atom, TLShapeId } from 'tldraw'
import { GetModel3dToken, model3dFetch } from './api'

// gltfpack's 32-bit address space tops out around 1 GB of input (see the stack facts doc).
export const MODEL3D_MAX_SOURCE_BYTES = 1024 ** 3
const PARTS_IN_FLIGHT = 3

/** By extension: Chrome reports an empty MIME type for `.ifc`. */
export function getModel3dFormat(fileName: string): Model3dSourceFormat | null {
	const dot = fileName.lastIndexOf('.')
	if (dot < 0) return null
	const ext = fileName.slice(dot + 1).toLowerCase()
	return (MODEL3D_SOURCE_FORMATS as readonly string[]).includes(ext)
		? (ext as Model3dSourceFormat)
		: null
}

export interface Model3dUploadPart {
	partNumber: number
	start: number
	end: number
}

/** R2 needs every part but the last to be exactly `partSize`; part numbers start at 1. */
export function planUploadParts(size: number, partSize: number): Model3dUploadPart[] {
	const parts: Model3dUploadPart[] = []
	for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber++) {
		parts.push({ partNumber, start, end: Math.min(start + partSize, size) })
	}
	return parts
}

export interface Model3dLocalUpload {
	status: 'uploading' | 'failed'
	/** Null until the create call returns. */
	modelId: string | null
	/** 0 to 1, bytes acknowledged by the server. */
	progress: number
	error: string | null
}

/** Uploads in progress in this tab, by shape. Other tabs see the server status instead. */
export const model3dLocalUploads = atom<ReadonlyMap<TLShapeId, Model3dLocalUpload>>(
	'model3d local uploads',
	new Map()
)

function setLocalUpload(shapeId: TLShapeId, upload: Model3dLocalUpload | null) {
	model3dLocalUploads.update((prev) => {
		const next = new Map(prev)
		if (upload) next.set(shapeId, upload)
		else next.delete(shapeId)
		return next
	})
}

interface UploadJob {
	file: File
	format: Model3dSourceFormat
	fileId: string
	getToken: GetModel3dToken
	onCreated(modelId: string): void
	created: CreateModelResponse | null
	etags: Map<number, string>
	abort: AbortController
}

// A failed job stays here so Retry can resume it; it leaves on success or cancel.
const jobs = new Map<TLShapeId, UploadJob>()

export function startModel3dUpload(
	shapeId: TLShapeId,
	opts: Omit<UploadJob, 'created' | 'etags' | 'abort'>
) {
	jobs.set(shapeId, { ...opts, created: null, etags: new Map(), abort: new AbortController() })
	void runUpload(shapeId)
}

/** Resumes a failed upload from this tab: only the missing parts are sent again. */
export function retryModel3dUpload(shapeId: TLShapeId) {
	if (!jobs.has(shapeId)) return false
	void runUpload(shapeId)
	return true
}

/** For a deleted shape or a disposed editor. Drops the file and the callbacks. */
export function cancelModel3dUpload(shapeId: TLShapeId) {
	const job = jobs.get(shapeId)
	if (!job) return
	jobs.delete(shapeId)
	job.abort.abort()
	setLocalUpload(shapeId, null)
}

async function runUpload(shapeId: TLShapeId) {
	const job = jobs.get(shapeId)!
	const abort = new AbortController()
	job.abort = abort
	const { signal } = abort
	const isCancelled = () => jobs.get(shapeId) !== job
	const { file, getToken } = job
	const report = () => {
		if (isCancelled()) return
		const total = job.created ? Math.max(1, Math.ceil(file.size / job.created.partSize)) : 1
		setLocalUpload(shapeId, {
			status: 'uploading',
			modelId: job.created?.modelId ?? null,
			progress: job.etags.size / total,
			error: null,
		})
	}
	report()
	try {
		if (!job.created) {
			const body: CreateModelRequest = {
				name: file.name,
				sourceFormat: job.format,
				sourceBytes: file.size,
				fileId: job.fileId,
			}
			const created = await model3dFetch<CreateModelResponse>(getToken, model3dPaths.create(), {
				method: 'POST',
				body: JSON.stringify(body),
				signal,
			})
			if (isCancelled()) return
			job.created = created
			job.onCreated(created.modelId)
			report()
		}
		const { modelId, partSize } = job.created
		const pending = planUploadParts(file.size, partSize).filter((p) => !job.etags.has(p.partNumber))
		let next = 0
		const worker = async () => {
			while (next < pending.length && !signal.aborted) {
				const part = pending[next++]
				// A Blob body gets an exact Content-Length, which R2's uploadPart requires.
				const res = await model3dFetch<UploadPartResponse>(
					getToken,
					model3dPaths.uploadPart(modelId, part.partNumber),
					{ method: 'PUT', body: file.slice(part.start, part.end), signal }
				)
				job.etags.set(part.partNumber, res.etag)
				report()
			}
		}
		await Promise.all(
			Array.from({ length: Math.min(PARTS_IN_FLIGHT, pending.length) }, () =>
				worker().catch((e) => {
					abort.abort()
					throw e
				})
			)
		)
		const complete: CompleteUploadRequest = {
			parts: [...job.etags]
				.sort(([a], [b]) => a - b)
				.map(([partNumber, etag]) => ({ partNumber, etag })),
		}
		await model3dFetch<CompleteUploadResponse>(getToken, model3dPaths.completeUpload(modelId), {
			method: 'POST',
			body: JSON.stringify(complete),
			signal,
		})
		if (isCancelled()) return
		jobs.delete(shapeId)
		setLocalUpload(shapeId, null)
	} catch (e) {
		if (isCancelled()) return
		setLocalUpload(shapeId, {
			status: 'failed',
			modelId: job.created?.modelId ?? null,
			progress: model3dLocalUploads.get().get(shapeId)?.progress ?? 0,
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

/** Asks the server to convert again after a failure; the source is already in R2. */
export async function requeueModel3d(getToken: GetModel3dToken, modelId: string) {
	const body: CompleteUploadRequest = { parts: [] }
	await model3dFetch<CompleteUploadResponse>(getToken, model3dPaths.completeUpload(modelId), {
		method: 'POST',
		body: JSON.stringify(body),
	})
}
