import type { Model3dConvertJob } from '@tldraw/dotcom-shared'
import { describe, expect, it, vi } from 'vitest'
import { JobQueue } from './queue'

vi.mock('./errors', () => ({ log: () => {} }))

function job(modelId: string, token: string) {
	return { modelId, token, sourceFormat: 'stl' } as Model3dConvertJob
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((r) => (resolve = r))
	return { promise, resolve }
}

describe('JobQueue', () => {
	it('admits the same job once while it is running or queued', async () => {
		const gate = deferred()
		const run = vi.fn(() => gate.promise)
		const jobs = new JobQueue(run)
		expect(jobs.admit(job('m1', 't1'))).toBe('queued')
		expect(jobs.admit(job('m2', 't2'))).toBe('queued')
		expect(jobs.admit(job('m1', 't1'))).toBe('duplicate')
		expect(jobs.admit(job('m2', 't2'))).toBe('duplicate')
		expect(jobs.status()).toEqual({ running: 'm1', queued: 1 })
		gate.resolve()
		await vi.waitFor(() => expect(jobs.status()).toEqual({ running: null, queued: 0 }))
		expect(run.mock.calls.map(([j]) => j.modelId)).toEqual(['m1', 'm2'])
	})

	it('replaces a queued job with a newer attempt for the same model', async () => {
		const gate = deferred()
		const run = vi.fn(() => gate.promise)
		const jobs = new JobQueue(run)
		jobs.admit(job('m1', 't1'))
		jobs.admit(job('m2', 'old'))
		expect(jobs.admit(job('m2', 'new'))).toBe('replaced')
		gate.resolve()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		expect(run.mock.calls[1][0].token).toBe('new')
	})

	it('stops a running job when a newer attempt for its model arrives, then runs the new one', async () => {
		const signals: AbortSignal[] = []
		const run = vi.fn((_: Model3dConvertJob, signal: AbortSignal) => {
			signals.push(signal)
			return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
		})
		const jobs = new JobQueue(run)
		jobs.admit(job('m1', 'old'))
		expect(jobs.admit(job('m1', 'new'))).toBe('queued')
		expect(signals[0].aborted).toBe(true)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		expect(run.mock.calls[1][0].token).toBe('new')
	})
})
