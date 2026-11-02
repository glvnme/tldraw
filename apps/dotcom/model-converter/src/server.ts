import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Model3dConvertJob } from '@tldraw/dotcom-shared'
import { log } from './errors'
import { parseConvertJob } from './job'
import { runJobInChild } from './runner'

const PORT = Number(process.env.PORT ?? 8790)
const MAX_BODY_BYTES = 64 * 1024

const queue: Model3dConvertJob[] = []
let running: Model3dConvertJob | null = null

async function drain() {
	if (running) return
	while ((running = queue.shift() ?? null)) {
		log(`[${running.modelId}] start (${running.sourceFormat}), ${queue.length} queued`)
		await runJobInChild(running)
	}
}

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
		return send(res, 200, { ok: true, running: running?.modelId ?? null, queued: queue.length })
	}
	if (req.method === 'POST' && req.url === '/jobs') {
		let job
		try {
			job = parseConvertJob(JSON.parse(await readBody(req)))
		} catch {
			job = null
		}
		if (!job) return send(res, 400, { error: 'bad_request' })
		queue.push(job)
		send(res, 202, { queued: queue.length })
		void drain()
		return
	}
	send(res, 404, { error: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => {
	log(`model converter listening on http://127.0.0.1:${PORT}`)
})
