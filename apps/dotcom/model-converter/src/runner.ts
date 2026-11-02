import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Model3dConvertJob } from '@tldraw/dotcom-shared'
import { reportStatus } from './job'

// web-ifc recurses deeply on some files ("Maximum call stack size exceeded" in StreamAllMeshes).
// Keep --stack-size (KiB) well under the 8 MiB thread stack, or V8 overruns it and segfaults.
// WASM memory sits outside the V8 heap, so the old space only holds the JS-side copies.
export const JOB_EXEC_ARGV = ['--max-old-space-size=8192', '--stack-size=4000']

/** The current process's loader flags (tsx) plus the job flags. */
export function childExecArgv() {
	return [...process.execArgv, ...JOB_EXEC_ARGV]
}

const JOB_PROCESS = fileURLToPath(new URL('./jobProcess.ts', import.meta.url))

/**
 * Runs a job in its own process so a crash, an out-of-memory abort or a WASM trap cannot take the
 * service down, and kills it at `limits.timeoutMs` or when `signal` aborts. Always resolves; reports
 * the failure itself if the child exits without reporting a terminal status, unless it was stopped
 * for a newer attempt, whose token the worker now holds the row for.
 */
export function runJobInChild(job: Model3dConvertJob, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const child = fork(JOB_PROCESS, [], { execArgv: childExecArgv() })
		let reported = false
		let timedOut = false
		let finished = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, job.limits.timeoutMs)
		const stop = () => child.kill('SIGKILL')
		signal?.addEventListener('abort', stop, { once: true })

		const finish = async (reason: string) => {
			if (finished) return
			finished = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', stop)
			if (!reported && !signal?.aborted) {
				const errorCode = timedOut ? 'conversion_timeout' : 'conversion_failed'
				const message = timedOut ? `Timed out after ${job.limits.timeoutMs} ms` : reason
				console.error(`[${job.modelId}] ${errorCode}: ${message}`)
				await reportStatus(job, { status: 'failed', errorCode, message }).catch((error) =>
					console.error(`[${job.modelId}] could not report failure: ${error.message}`)
				)
			}
			resolve()
		}

		child.on('message', (message) => {
			if (message === 'reported') reported = true
		})
		child.on('exit', (code, signal) => finish(`Converter process exited (${signal ?? code})`))
		child.on('error', (error) => finish(`Converter process error: ${error.message}`))
		child.send(job)
	})
}
