import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { parseConvertJob } from './job'
import { JobQueue } from './queue'

const MAX_BODY_BYTES = 64 * 1024

async function readBody(req: IncomingMessage): Promise<string> {
	let size = 0
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		size += chunk.length
		if (size > MAX_BODY_BYTES) throw new Error('Body too large')
		chunks.push(chunk)
	}
	return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'content-type': 'application/json' })
	res.end(JSON.stringify(body))
}

/**
 * The job API. It runs in the parent process, so the worker's liveness probe gets an answer even
 * while a long IFC parse blocks the job's own process.
 */
export function createConverterServer(jobs: JobQueue) {
	return createServer(async (req, res) => {
		if (req.method === 'GET' && req.url === '/health') {
			return send(res, 200, { ok: true, ...jobs.status() })
		}
		const probe = req.method === 'GET' && /^\/jobs\/([^/?]+)$/.exec(req.url ?? '')
		if (probe) {
			let modelId: string
			try {
				modelId = decodeURIComponent(probe[1])
			} catch {
				return send(res, 400, { error: 'bad_request' })
			}
			const job = jobs.probe(modelId)
			return job ? send(res, 200, job) : send(res, 404, { error: 'not_found' })
		}
		if (req.method === 'POST' && req.url === '/jobs') {
			let job
			try {
				job = parseConvertJob(JSON.parse(await readBody(req)))
			} catch {
				job = null
			}
			if (!job) return send(res, 400, { error: 'bad_request' })
			const admission = jobs.admit(job)
			return send(res, 202, { admission, ...jobs.status() })
		}
		send(res, 404, { error: 'not_found' })
	})
}
