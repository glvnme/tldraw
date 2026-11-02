import {
	CreateModelResponse,
	Model3dManifest,
	signModel3dJobToken,
	TlaModel,
} from '@tldraw/dotcom-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeKysely } from '../../test/fakeKysely'
import { createFakeR2 } from '../../test/fakeR2'
import { Environment } from '../../types'
import { MODEL_PART_SIZE } from './modelConfig'

vi.mock('../../postgres', () => ({ createPostgresConnectionPool: vi.fn() }))
vi.mock('../../utils/tla/getAuth', () => ({ getAuth: vi.fn() }))

const { createPostgresConnectionPool } = await import('../../postgres')
const { getAuth } = await import('../../utils/tla/getAuth')
const { modelRoutes } = await import('./modelRoutes')

const SECRET = 'test-model-job-secret'
const USER_ID = 'user-1'
const GROUP_ID = 'group-1'
const MODEL_ID = 'model-1'
const JOB_ID = 'job-1'

// Multipart on top of the shared fake, and stream bodies for put.
function createModelsBucket() {
	const bucket = createFakeR2() as any
	const put = bucket.put
	bucket.put = async (key: string, body: any, options?: any) =>
		put(
			key,
			body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body,
			options
		)
	const uploads = new Map<string, Map<number, Uint8Array>>()
	bucket.createMultipartUpload = async (key: string) => {
		const uploadId = `upload-${uploads.size + 1}`
		uploads.set(uploadId, new Map())
		return { key, uploadId }
	}
	bucket.resumeMultipartUpload = (key: string, uploadId: string) => ({
		uploadPart: async (partNumber: number, body: ReadableStream) => {
			const parts = uploads.get(uploadId) ?? new Map()
			parts.set(partNumber, new Uint8Array(await new Response(body).arrayBuffer()))
			return { partNumber, etag: `etag-${partNumber}` }
		},
		complete: async (parts: { partNumber: number }[]) => {
			const stored = uploads.get(uploadId)
			if (!stored) throw new Error('no such upload')
			const bytes = parts.map((p) => stored.get(p.partNumber)!)
			await bucket.put(key, await new Blob(bytes as BlobPart[]).arrayBuffer())
			return bucket.head(key)
		},
	})
	return bucket as R2Bucket
}

function mockDb(resultSets: unknown[][]) {
	const fake = createFakeKysely(resultSets)
	vi.mocked(createPostgresConnectionPool).mockReturnValue(fake.db)
	return fake
}

function modelRow(overrides: Partial<TlaModel> = {}): TlaModel {
	return {
		id: MODEL_ID,
		owningGroupId: GROUP_ID,
		createdBy: USER_ID,
		name: 'Bridge',
		sourceFormat: 'ifc',
		sourceBytes: 3,
		status: 'converting',
		stage: 'parsing',
		progress: 0.3,
		errorCode: null,
		manifest: null,
		uploadId: null,
		jobId: JOB_ID,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	}
}

const MANIFEST: Model3dManifest = {
	version: 1,
	bounds: { min: [0, 0, 0], max: [1, 1, 1] },
	units: 'm',
	transform: { recentreOffset: [0, 0, 0], scale: 1, upAxis: 'z' },
	triangleCount: 12,
	nodeCount: 1,
	meshes: [{ name: 'mesh 0', triangleCount: 12 }],
	textureBytesEstimate: 0,
	glbBytes: 4,
	converter: { name: '@tldraw/model-converter', version: '0.0.0', args: ['-cc'] },
	sourceFormat: 'ifc',
}

let env: Environment
let waitUntil: ReturnType<typeof vi.fn>

function call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
	const request = new Request(`http://127.0.0.1:8787${path}`, init)
	return modelRoutes.fetch(request, env, {
		waitUntil,
	} as unknown as ExecutionContext) as Promise<Response>
}

async function bearer(modelId = MODEL_ID, expiresAt = Date.now() + 60_000, jobId = JOB_ID) {
	const token = await signModel3dJobToken(SECRET, modelId, jobId, expiresAt)
	return { authorization: `Bearer ${token}` }
}

beforeEach(() => {
	env = {
		MODELS: createModelsBucket(),
		MODEL_JOB_SECRET: SECRET,
		BOTCOM_POSTGRES_POOLED_CONNECTION_STRING: 'postgres://test',
	} as unknown as Environment
	waitUntil = vi.fn()
	vi.mocked(getAuth).mockResolvedValue({ userId: USER_ID } as any)
})

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe('job token', () => {
	beforeEach(async () => {
		await env.MODELS!.put(`m/${MODEL_ID}/source`, new Uint8Array([1, 2, 3]))
	})

	it('serves the source to a valid token', async () => {
		const response = await call(`/app/models/${MODEL_ID}/source`, { headers: await bearer() })
		expect(response.status).toBe(200)
		expect(response.headers.get('content-length')).toBe('3')
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
	})

	it.each([
		['no token', async () => ({})],
		['a token for another model', () => bearer('model-2')],
		['an expired token', () => bearer(MODEL_ID, Date.now() - 1)],
		[
			'a token signed with another secret',
			async () => ({
				authorization: `Bearer ${await signModel3dJobToken('other', MODEL_ID, JOB_ID, Date.now() + 60_000)}`,
			}),
		],
	])('refuses %s on every converter route', async (_, headers) => {
		const routes: [string, RequestInit][] = [
			[`/app/models/${MODEL_ID}/source`, {}],
			[`/app/models/${MODEL_ID}/artifacts/model.glb`, { method: 'PUT', body: 'abcd' }],
			[`/app/models/${MODEL_ID}/job-status`, { method: 'POST', body: '{"status":"ready"}' }],
		]
		for (const [path, init] of routes) {
			const response = await call(path, { ...init, headers: await headers() })
			expect(response.status).toBe(401)
			expect(await response.json()).toEqual({ error: 'invalid_token' })
		}
		expect(createPostgresConnectionPool).not.toHaveBeenCalled()
	})

	it('does not accept a user session in place of a token', async () => {
		const response = await call(`/app/models/${MODEL_ID}/source`, {
			headers: { authorization: 'Bearer some-clerk-session' },
		})
		expect(response.status).toBe(401)
		expect(getAuth).not.toHaveBeenCalled()
	})
})

describe('artifacts and job status', () => {
	it('stores a valid manifest in R2 and on the row', async () => {
		const db = mockDb([[modelRow()]])
		const response = await call(`/app/models/${MODEL_ID}/artifacts/manifest.json`, {
			method: 'PUT',
			headers: { ...(await bearer()), 'content-length': String(JSON.stringify(MANIFEST).length) },
			body: JSON.stringify(MANIFEST),
		})
		expect(response.status).toBe(200)
		expect(await (await env.MODELS!.get(`m/${MODEL_ID}/manifest.json`))!.json()).toEqual(MANIFEST)
		expect(db.queries.at(-1)!.sql).toMatch(/^update "model" set "manifest" = \$1/)
		expect(db.queries.at(-1)!.sql).toContain('"jobId" = $')
		expect(db.queries.at(-1)!.parameters).toEqual([MANIFEST, expect.any(Number), MODEL_ID, JOB_ID])
	})

	it('refuses writes from a job that a retry has replaced', async () => {
		const stale = await bearer(MODEL_ID, Date.now() + 60_000, 'job-0')
		mockDb([[modelRow()]])
		const artifact = await call(`/app/models/${MODEL_ID}/artifacts/model.glb`, {
			method: 'PUT',
			headers: { ...stale, 'content-length': '4' },
			body: 'glTF',
		})
		expect(artifact.status).toBe(409)
		expect(await env.MODELS!.head(`m/${MODEL_ID}/model.glb`)).toBeNull()

		const db = mockDb([[modelRow()]])
		const status = await call(`/app/models/${MODEL_ID}/job-status`, {
			method: 'POST',
			headers: stale,
			body: JSON.stringify({ status: 'failed', errorCode: 'conversion_failed' }),
		})
		expect(status.status).toBe(409)
		expect(db.queries).toHaveLength(1)
	})

	it('rejects an invalid manifest', async () => {
		mockDb([[modelRow()]])
		const body = JSON.stringify({ ...MANIFEST, bounds: { min: [0, 0], max: [1, 1, 1] } })
		const response = await call(`/app/models/${MODEL_ID}/artifacts/manifest.json`, {
			method: 'PUT',
			headers: { ...(await bearer()), 'content-length': String(body.length) },
			body,
		})
		expect(response.status).toBe(400)
		expect(await env.MODELS!.head(`m/${MODEL_ID}/manifest.json`)).toBeNull()
	})

	it('requires Content-Length on an artifact', async () => {
		const response = await call(`/app/models/${MODEL_ID}/artifacts/model.glb`, {
			method: 'PUT',
			headers: await bearer(),
			body: 'glTF',
		})
		expect(response.status).toBe(411)
	})

	it('refuses ready until both artifacts exist', async () => {
		mockDb([[modelRow({ manifest: MANIFEST })]])
		const response = await call(`/app/models/${MODEL_ID}/job-status`, {
			method: 'POST',
			headers: await bearer(),
			body: JSON.stringify({ status: 'ready' }),
		})
		expect(response.status).toBe(409)
	})

	it('marks the model ready once both artifacts exist', async () => {
		await env.MODELS!.put(`m/${MODEL_ID}/model.glb`, new Uint8Array([1, 2, 3, 4]))
		await env.MODELS!.put(`m/${MODEL_ID}/manifest.json`, JSON.stringify(MANIFEST))
		const db = mockDb([[modelRow({ manifest: MANIFEST })], [{ id: MODEL_ID }]])
		const response = await call(`/app/models/${MODEL_ID}/job-status`, {
			method: 'POST',
			headers: await bearer(),
			body: JSON.stringify({ status: 'ready' }),
		})
		expect(response.status).toBe(200)
		const update = db.queries.at(-1)!
		expect(update.sql).toContain('where "id" = $')
		expect(update.sql).toContain('"status" in (')
		expect(update.sql).toContain('"jobId" = $')
		expect(update.parameters).toEqual(expect.arrayContaining(['ready', 1, MODEL_ID, JOB_ID]))
	})

	it('refuses a status update for a model that already finished', async () => {
		mockDb([[modelRow({ status: 'ready' })]])
		const response = await call(`/app/models/${MODEL_ID}/job-status`, {
			method: 'POST',
			headers: await bearer(),
			body: JSON.stringify({ status: 'converting', stage: 'optimizing', progress: 0.5 }),
		})
		expect(response.status).toBe(409)
	})
})

describe('user routes', () => {
	it('requires a signed-in user', async () => {
		vi.mocked(getAuth).mockResolvedValue(null)
		const response = await call(`/app/models/${MODEL_ID}`)
		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({ error: 'unauthorized' })
	})

	it('refuses a model outside the caller’s workspaces', async () => {
		mockDb([[{ ...modelRow(), role: null }]])
		const response = await call(`/app/models/${MODEL_ID}`)
		expect(response.status).toBe(403)
	})

	it('returns the status to a member', async () => {
		mockDb([[{ ...modelRow(), role: 'member' }]])
		const response = await call(`/app/models/${MODEL_ID}`)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			modelId: MODEL_ID,
			name: 'Bridge',
			sourceFormat: 'ifc',
			status: 'converting',
			stage: 'parsing',
			progress: 0.3,
			errorCode: null,
			manifest: null,
		})
	})

	it('refuses a source over the size cap at create', async () => {
		const response = await call('/app/models', {
			method: 'POST',
			body: JSON.stringify({
				name: 'Huge',
				sourceFormat: 'ifc',
				sourceBytes: 2 * 1024 ** 3,
				fileId: 'file-1',
			}),
		})
		expect(response.status).toBe(413)
	})

	it('creates the row and the multipart upload for a member', async () => {
		const db = mockDb([
			[{ id: 'file-1', owningGroupId: GROUP_ID, isDeleted: false, role: 'member' }],
		])
		const response = await call('/app/models', {
			method: 'POST',
			body: JSON.stringify({
				name: 'Bridge',
				sourceFormat: 'ifc',
				sourceBytes: 3,
				fileId: 'file-1',
			}),
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as CreateModelResponse
		expect(body).toEqual({
			modelId: expect.any(String),
			uploadId: 'upload-1',
			partSize: MODEL_PART_SIZE,
		})
		const insert = db.queries.at(-1)!
		expect(insert.sql).toMatch(/^insert into "model"/)
		expect(insert.parameters).toEqual(
			expect.arrayContaining([body.modelId, GROUP_ID, USER_ID, 'uploading', 'upload-1'])
		)
	})

	it('uploads parts and completes into a queued conversion', async () => {
		const upload = await env.MODELS!.createMultipartUpload(`m/${MODEL_ID}/source`)
		const uploading = modelRow({ status: 'uploading', stage: null, uploadId: upload.uploadId })
		mockDb([[{ ...uploading, role: 'owner' }]])
		const part = await call(`/app/models/${MODEL_ID}/parts/1`, {
			method: 'PUT',
			headers: { 'content-length': '3' },
			body: new Uint8Array([7, 8, 9]),
		})
		expect(await part.json()).toEqual({ partNumber: 1, etag: 'etag-1' })

		const db = mockDb([[{ ...uploading, role: 'owner' }], [{ ...uploading, status: 'queued' }]])
		const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))
		vi.stubGlobal('fetch', fetchMock)
		const response = await call(`/app/models/${MODEL_ID}/complete`, {
			method: 'POST',
			body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'etag-1' }] }),
		})
		expect(await response.json()).toEqual({ status: 'queued' })
		expect(db.queries[1].parameters).toEqual(expect.arrayContaining(['queued', null, 3]))
		expect((await env.MODELS!.get(`m/${MODEL_ID}/source`))!.size).toBe(3)

		await waitUntil.mock.calls[0][0]
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('http://127.0.0.1:8790/jobs')
		expect(JSON.parse(init.body as string)).toMatchObject({
			modelId: MODEL_ID,
			sourceFormat: 'ifc',
			sourceUrl: `http://127.0.0.1:8787/app/models/${MODEL_ID}/source`,
			artifactUrlBase: `http://127.0.0.1:8787/app/models/${MODEL_ID}/artifacts`,
			statusUrl: `http://127.0.0.1:8787/app/models/${MODEL_ID}/job-status`,
		})
	})

	it('finishes a complete that was interrupted after R2 completed the upload', async () => {
		await env.MODELS!.put(`m/${MODEL_ID}/source`, new Uint8Array([1, 2, 3]))
		const uploading = modelRow({ status: 'uploading', stage: null, uploadId: 'gone' })
		const db = mockDb([
			[{ ...uploading, role: 'owner' }],
			[uploading],
			[{ ...uploading, status: 'queued' }],
		])
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 202 }))
		)
		const response = await call(`/app/models/${MODEL_ID}/complete`, {
			method: 'POST',
			body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'etag-1' }] }),
		})
		expect(await response.json()).toEqual({ status: 'queued' })
		expect(db.queries.at(-1)!.parameters).toEqual(
			expect.arrayContaining(['queued', 3, 'uploading'])
		)
	})

	it('refuses an interrupted complete whose source does not match the declared size', async () => {
		await env.MODELS!.put(`m/${MODEL_ID}/source`, new Uint8Array([1, 2]))
		const uploading = modelRow({ status: 'uploading', stage: null, uploadId: 'gone' })
		mockDb([[{ ...uploading, role: 'owner' }], [uploading]])
		const response = await call(`/app/models/${MODEL_ID}/complete`, {
			method: 'POST',
			body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'etag-1' }] }),
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ error: 'upload_incomplete' })
	})

	it('refuses to complete an upload with no parts', async () => {
		mockDb([[{ ...modelRow({ status: 'uploading', uploadId: 'upload-1' }), role: 'owner' }]])
		const response = await call(`/app/models/${MODEL_ID}/complete`, {
			method: 'POST',
			body: JSON.stringify({ parts: [] }),
		})
		expect(response.status).toBe(400)
	})

	it('refuses a part without Content-Length', async () => {
		mockDb([[{ ...modelRow({ status: 'uploading', uploadId: 'upload-1' }), role: 'owner' }]])
		const response = await call(`/app/models/${MODEL_ID}/parts/1`, {
			method: 'PUT',
			body: new Uint8Array([7, 8, 9]),
		})
		expect(response.status).toBe(411)
	})

	it('re-queues a failed model whose source exists, and marks it failed if the converter is down', async () => {
		await env.MODELS!.put(`m/${MODEL_ID}/source`, new Uint8Array([1, 2, 3]))
		await env.MODELS!.put(`m/${MODEL_ID}/model.glb`, new Uint8Array([1]))
		const failed = modelRow({ status: 'failed', errorCode: 'conversion_failed' })
		const db = mockDb([[{ ...failed, role: 'member' }], [{ ...failed, status: 'queued' }]])
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')))
		)

		const response = await call(`/app/models/${MODEL_ID}/complete`, {
			method: 'POST',
			body: JSON.stringify({ parts: [] }),
		})
		expect(await response.json()).toEqual({ status: 'queued' })
		expect(await env.MODELS!.head(`m/${MODEL_ID}/model.glb`)).toBeNull()

		// The dispatch runs after the response, on a pool of its own.
		const dispatchDb = mockDb([])
		await waitUntil.mock.calls[0][0]
		expect(db.queries.at(-1)!.sql).toMatch(/^update "model" set "status" = \$1, "stage"/)
		const markFailed = dispatchDb.queries.at(-1)!
		expect(markFailed.sql).toMatch(/^update "model" set "status" = \$1, "errorCode" = \$2/)
		expect(markFailed.parameters).toEqual(
			expect.arrayContaining(['failed', 'converter_unavailable', MODEL_ID, 'queued'])
		)
	})

	it('treats complete on a converting model as a no-op', async () => {
		mockDb([[{ ...modelRow(), role: 'member' }]])
		vi.stubGlobal('fetch', vi.fn())
		const response = await call(`/app/models/${MODEL_ID}/complete`, {
			method: 'POST',
			body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'etag-1' }] }),
		})
		expect(await response.json()).toEqual({ status: 'converting' })
		expect(waitUntil).not.toHaveBeenCalled()
	})
})
