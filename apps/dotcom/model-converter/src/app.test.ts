import type { AddressInfo } from 'node:net'
import type { Model3dConvertJob } from '@tldraw/dotcom-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConverterServer } from './app'
import { JobQueue } from './queue'

vi.mock('./errors', () => ({ log: () => {} }))

function job(modelId: string, jobId: string) {
	return { modelId, token: `123.${jobId}.sig`, sourceFormat: 'ifc' } as Model3dConvertJob
}

let close: () => void = () => {}

afterEach(() => close())

async function start(jobs: JobQueue) {
	const server = createConverterServer(jobs)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	close = () => server.close()
	const { port } = server.address() as AddressInfo
	return (path: string) => fetch(`http://127.0.0.1:${port}${path}`)
}

describe('GET /jobs/:modelId', () => {
	it('names the attempt the converter holds for a model, running or queued', async () => {
		const jobs = new JobQueue(() => new Promise(() => {}))
		jobs.admit(job('m1', 'job-a'))
		jobs.admit(job('m 2', 'job-b'))
		const get = await start(jobs)

		const running = await get('/jobs/m1')
		expect(running.status).toBe(200)
		expect(await running.json()).toEqual({ jobId: 'job-a', state: 'running' })
		expect(await (await get('/jobs/m%202')).json()).toEqual({ jobId: 'job-b', state: 'queued' })
	})

	it('names the newer attempt while a superseded one is still stopping', async () => {
		// The stopped run never resolves here, so the old attempt stays the running one.
		const jobs = new JobQueue(() => new Promise(() => {}))
		jobs.admit(job('m1', 'old'))
		jobs.admit(job('m1', 'new'))
		const get = await start(jobs)
		expect(await (await get('/jobs/m1')).json()).toEqual({ jobId: 'new', state: 'queued' })
	})

	it('returns 404 for a model it holds no job for', async () => {
		const get = await start(new JobQueue(async () => {}))
		const response = await get('/jobs/m1')
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ error: 'not_found' })
	})
})
