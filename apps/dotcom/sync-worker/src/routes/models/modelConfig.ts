import { Model3dArtifactName, Model3dConvertJob } from '@tldraw/dotcom-shared'
import { Environment } from '../../types'

export const MODEL_MAX_SOURCE_BYTES = 1024 ** 3
// R2 requires every part but the last to be the same size and at least 5 MiB.
export const MODEL_PART_SIZE = 16 * 1024 ** 2
export const MODEL_MAX_NAME_LENGTH = 256
export const MODEL_MAX_MANIFEST_BYTES = 8 * 1024 ** 2

export const MODEL_JOB_LIMITS: Model3dConvertJob['limits'] = {
	maxSourceBytes: MODEL_MAX_SOURCE_BYTES,
	maxGlbBytes: 512 * 1024 ** 2,
	maxTriangles: 50_000_000,
	timeoutMs: 30 * 60_000,
}

// A row that has not changed for this long is checked with the converter's liveness probe, and
// then no more than once per this long while the converter confirms it holds the job.
export const MODEL_JOB_PROBE_AFTER_MS = 60_000
export const MODEL_JOB_PROBE_TIMEOUT_MS = 2_000

// The backstop behind the probe. A job that has not reported for this long is abandoned: the
// converter kills a job at its timeout and reports on start, so a live one always reports sooner. A
// job queued behind more than this much work is expired too; its Retry replaces the queued entry
// rather than adding one.
export const MODEL_JOB_EXPIRY_MS = MODEL_JOB_LIMITS.timeoutMs + 5 * 60_000

// The converter runs one job at a time, so a token must outlive the queue ahead of it.
export const MODEL_JOB_TOKEN_TTL_MS = 24 * 60 * 60_000

const DEFAULT_CONVERTER_URL = 'http://127.0.0.1:8790/jobs'
const DEFAULT_WORKER_ORIGIN = 'http://127.0.0.1:8787'

export function getConverterUrl(env: Environment) {
	return env.MODEL_CONVERTER_URL || DEFAULT_CONVERTER_URL
}

/** The converter's liveness probe for a model, next to its jobs endpoint. */
export function getConverterJobProbeUrl(env: Environment, modelId: string) {
	return `${getConverterUrl(env).replace(/\/+$/, '')}/${encodeURIComponent(modelId)}`
}

export function getModelWorkerOrigin(env: Environment) {
	return (env.MODEL_WORKER_ORIGIN || DEFAULT_WORKER_ORIGIN).replace(/\/+$/, '')
}

export const modelKeys = {
	source: (modelId: string) => `m/${modelId}/source`,
	artifact: (modelId: string, name: Model3dArtifactName) => `m/${modelId}/${name}`,
}

export const MODEL_ARTIFACT_NAMES: readonly Model3dArtifactName[] = ['model.glb', 'manifest.json']
