import type {
	Model3dArtifactName,
	Model3dConvertJob,
	Model3dConvertStage,
	Model3dJobStatusRequest,
	Model3dSourceFormat,
} from '@tldraw/dotcom-shared'
import { ConvertError, errorCodeOf, log } from './errors'
import { convertModel, OnStage } from './pipeline'

// dotcom-shared is imported for types only; at runtime it would pull in the whole app schema.
const SOURCE_FORMATS: readonly string[] = [
	'3dm',
	'ifc',
	'glb',
	'obj',
	'stl',
] satisfies Model3dSourceFormat[]

function isString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

function isPositive(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function parseConvertJob(value: unknown): Model3dConvertJob | null {
	if (typeof value !== 'object' || value === null) return null
	const job = value as Record<string, any>
	const limits = job.limits
	if (
		!isString(job.modelId) ||
		!SOURCE_FORMATS.includes(job.sourceFormat) ||
		(job.sourceName !== undefined && !isString(job.sourceName)) ||
		![job.sourceUrl, job.artifactUrlBase, job.statusUrl, job.token].every(isString) ||
		typeof limits !== 'object' ||
		limits === null ||
		![limits.maxSourceBytes, limits.maxGlbBytes, limits.maxTriangles, limits.timeoutMs].every(
			isPositive
		)
	) {
		return null
	}
	return job as Model3dConvertJob
}

// Every request to the worker is bounded, body included (undici aborts the body stream on the same
// signal). An unbounded status report after a child died stalls the whole queue behind it.
const STATUS_TIMEOUT_MS = 30_000
// A floor of 1 MiB/s keeps a 1 GiB source under 20 minutes on a slow local R2.
const MIN_BYTES_PER_MS = 1024 ** 2 / 1000

export function transferTimeoutMs(bytes: number) {
	return STATUS_TIMEOUT_MS + Math.ceil(bytes / MIN_BYTES_PER_MS)
}

// IFC parsing blocks the event loop for longer than the worker's keep-alive timeout, so the next
// request can go out on a pooled socket the worker has already closed and fail with EPIPE before
// the worker sees it. Such a request is sent once more, on a new socket.
async function fetchWorker(url: string, init: () => RequestInit): Promise<Response> {
	try {
		return await fetch(url, init())
	} catch (error) {
		const code = ((error as Error).cause as { code?: unknown } | undefined)?.code
		if (code !== 'EPIPE' && code !== 'ECONNRESET') throw error
		return fetch(url, init())
	}
}

export async function reportStatus(job: Model3dConvertJob, status: Model3dJobStatusRequest) {
	const response = await fetchWorker(job.statusUrl, () => ({
		method: 'POST',
		headers: { authorization: `Bearer ${job.token}`, 'content-type': 'application/json' },
		body: JSON.stringify(status),
		signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
	}))
	if (!response.ok) {
		throw new Error(`status ${status.status} refused: ${response.status} ${await response.text()}`)
	}
}

async function fetchSource(job: Model3dConvertJob): Promise<Uint8Array> {
	const response = await fetch(job.sourceUrl, {
		headers: { authorization: `Bearer ${job.token}` },
		signal: AbortSignal.timeout(transferTimeoutMs(job.limits.maxSourceBytes)),
	})
	if (!response.ok) {
		throw new ConvertError('conversion_failed', `Source fetch failed: ${response.status}`)
	}
	const length = Number(response.headers.get('content-length'))
	if (length > job.limits.maxSourceBytes) {
		await response.body?.cancel()
		throw new ConvertError('too_large', `Source is larger than ${job.limits.maxSourceBytes} bytes`)
	}
	return new Uint8Array(await response.arrayBuffer())
}

async function putArtifact(job: Model3dConvertJob, name: Model3dArtifactName, body: Uint8Array) {
	const response = await fetchWorker(`${job.artifactUrlBase}/${name}`, () => ({
		method: 'PUT',
		headers: {
			authorization: `Bearer ${job.token}`,
			'content-type': name === 'model.glb' ? 'model/gltf-binary' : 'application/json',
		},
		// Always ArrayBuffer-backed: gltfpack output and TextEncoder output.
		body: body as Uint8Array<ArrayBuffer>,
		signal: AbortSignal.timeout(transferTimeoutMs(body.byteLength)),
	}))
	if (!response.ok) {
		throw new Error(`${name} upload refused: ${response.status} ${await response.text()}`)
	}
}

/** Runs one job to a terminal status. Only throws if the terminal status cannot be reported. */
export async function runJob(job: Model3dConvertJob) {
	const started = Date.now()
	// Progress is best effort and coalesced: IFC parsing blocks the event loop, so only the latest
	// value is worth sending once it yields.
	let latest: { stage: Model3dConvertStage; progress: number } | null = null
	let sending: Promise<void> | null = null
	const progress: OnStage = (stage, value) => {
		latest = { stage, progress: value }
		sending ??= (async () => {
			while (latest) {
				const next = latest
				latest = null
				await reportStatus(job, { status: 'converting', ...next }).catch((error) =>
					console.warn(`[${job.modelId}] progress report failed: ${error.message}`)
				)
			}
			sending = null
		})()
	}
	const progressSettled = async () => {
		while (sending) await sending
	}

	try {
		progress('fetching', 0)
		const source = await fetchSource(job)
		const { glb, manifest } = await convertModel(
			source,
			job.sourceFormat,
			job.limits,
			progress,
			job.sourceName
		)
		progress('uploading', 0.9)
		await putArtifact(job, 'model.glb', glb)
		await putArtifact(job, 'manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
		await progressSettled()
		await reportStatus(job, { status: 'ready' })
		log(
			`[${job.modelId}] ready: ${source.byteLength} -> ${glb.byteLength} bytes, ` +
				`${manifest.triangleCount} triangles, ${Date.now() - started} ms`
		)
	} catch (error) {
		const errorCode = errorCodeOf(error)
		const message = (error as Error).message ?? String(error)
		console.error(`[${job.modelId}] failed: ${errorCode} ${message}`)
		await progressSettled()
		await reportStatus(job, { status: 'failed', errorCode, message })
	}
}
