import type { Model3dConvertJob, Model3dConverterJobProbe } from '@tldraw/dotcom-shared'
import { log } from './errors'

export type RunJob = (job: Model3dConvertJob, signal: AbortSignal) => Promise<void>

export type Admission = 'queued' | 'replaced' | 'duplicate'

/**
 * Runs one job at a time and holds at most one job per model. Each conversion attempt has its own
 * token and the worker refuses writes from any attempt but the latest, so a job with a new token
 * for a model replaces the queued one or stops the running one. The same token again is a
 * duplicate and changes nothing.
 */
export class JobQueue {
	private readonly queue: Model3dConvertJob[] = []
	private running: { job: Model3dConvertJob; controller: AbortController } | null = null

	constructor(private readonly run: RunJob) {}

	status() {
		return { running: this.running?.job.modelId ?? null, queued: this.queue.length }
	}

	/**
	 * The attempt held for a model, read from its token without verifying it. A queued attempt wins
	 * over a running one for the same model: that one was stopped for it and is on its way out.
	 */
	probe(modelId: string): Model3dConverterJobProbe | null {
		const queued = this.queue.find((job) => job.modelId === modelId)
		const job = queued ?? (this.running?.job.modelId === modelId ? this.running.job : null)
		const jobId = job && /^\d+\.([A-Za-z0-9_-]+)\./.exec(job.token)?.[1]
		return jobId ? { jobId, state: queued ? 'queued' : 'running' } : null
	}

	admit(job: Model3dConvertJob): Admission {
		if (this.running?.job.modelId === job.modelId) {
			if (this.running.job.token === job.token) return 'duplicate'
			log(`[${job.modelId}] superseded by a newer attempt, stopping`)
			this.running.controller.abort()
		}
		const index = this.queue.findIndex((queued) => queued.modelId === job.modelId)
		if (index >= 0) {
			const duplicate = this.queue[index].token === job.token
			this.queue[index] = job
			return duplicate ? 'duplicate' : 'replaced'
		}
		this.queue.push(job)
		void this.drain()
		return 'queued'
	}

	private async drain() {
		if (this.running) return
		let job: Model3dConvertJob | undefined
		while ((job = this.queue.shift())) {
			const controller = new AbortController()
			this.running = { job, controller }
			log(`[${job.modelId}] start (${job.sourceFormat}), ${this.queue.length} queued`)
			try {
				await this.run(job, controller.signal)
			} catch (error) {
				console.error(`[${job.modelId}] runner failed: ${(error as Error).message}`)
			}
		}
		this.running = null
	}
}
