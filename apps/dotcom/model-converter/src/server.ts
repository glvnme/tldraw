import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { log } from './errors'
import { parseConvertJob } from './job'
import { JobQueue } from './queue'
import { runJobInChild } from './runner'

const PORT = Number(process.env.PORT ?? 8790)
const MAX_BODY_BYTES = 64 * 1024

const jobs = new JobQueue(runJobInChild)

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

const server = createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/health') {
		return send(res, 200, { ok: true, ...jobs.status() })
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

server.listen(PORT, '127.0.0.1', () => {
	log(`model converter listening on http://127.0.0.1:${PORT}`)
})
