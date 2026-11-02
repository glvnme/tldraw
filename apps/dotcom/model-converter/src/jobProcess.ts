import type { Model3dConvertJob } from '@tldraw/dotcom-shared'
import { runJob } from './job'

process.once('message', async (job: Model3dConvertJob) => {
	try {
		await runJob(job)
		process.send!('reported', () => process.exit(0))
	} catch (error) {
		console.error(`[${job.modelId}] ${(error as Error).message}`)
		process.exit(1)
	}
})
