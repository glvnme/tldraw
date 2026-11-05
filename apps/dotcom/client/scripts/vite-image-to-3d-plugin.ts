/* eslint-disable no-restricted-globals -- runs in the Vite dev server (Node), not the browser */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Plugin } from 'vite'
import { z } from 'zod'
import {
	agentAvailable,
	agentChoices,
	isAgentPick,
	runAgent,
	sceneToGlb,
	type Agent,
} from './image-to-3d-agents'

const ROOT = '/__image-to-3d'
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_AGENT_IMAGES = 6
// Each CLI takes a few hundred MB, and this laptop already runs close to its memory limit.
const MAX_AGENT_RUNS = 2
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const WORLDLABS_API = 'https://api.worldlabs.ai/marble/v1'
const WORLDLABS_CREDITS_PER_USD = 1250

type Provider = 'fal' | 'worldlabs'

const providers: Record<Provider, { label: string; env: string; timeoutMs: number }> = {
	fal: { label: 'fal', env: 'FAL_KEY', timeoutMs: 10 * 60_000 },
	worldlabs: { label: 'World Labs', env: 'WORLDLABS_API_KEY', timeoutMs: 20 * 60_000 },
}

interface BaseConfiguration {
	id: string
	label: string
	/** Objects are one closed mesh; scenes are a whole place around the camera; massing is built from parts. */
	kind: 'object' | 'scene' | 'massing'
	/** Null when a CLI subscription covers the run instead of a per-request charge. */
	costUsd: number | null
}

type Configuration =
	| (BaseConfiguration & {
			provider: 'fal'
			endpoint: string
			input(imageUrl: string): Record<string, unknown>
	  })
	| (BaseConfiguration & { provider: 'worldlabs'; model: string })
	| (BaseConfiguration & { provider: 'agent'; agent: Agent })

interface Generated {
	glb: Buffer
	response: unknown
	requestId: string
	costUsd: number
	worldUrl?: string
}

interface MarbleOperation {
	operation_id: string
	done: boolean
	error?: { code?: number | null; message?: string | null } | null
	cost?: { total_credits: number } | null
	response?: {
		world_marble_url?: string
		assets?: { mesh?: { collider_mesh_url?: string | null } | null } | null
	} | null
}

const configurations: Configuration[] = [
	{
		id: 'fal-trellis-2',
		label: 'TRELLIS.2',
		kind: 'object',
		provider: 'fal',
		endpoint: 'fal-ai/trellis-2',
		costUsd: 0.3,
		input: (imageUrl) => ({ image_url: imageUrl, resolution: 1024, texture_size: 2048 }),
	},
	{
		id: 'fal-hunyuan-3.1',
		label: 'Hunyuan3D 3.1 Pro',
		kind: 'object',
		provider: 'fal',
		endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
		costUsd: 0.375,
		input: (imageUrl) => ({ input_image_url: imageUrl }),
	},
	{
		id: 'fal-tripo-h3.1',
		label: 'Tripo H3.1',
		kind: 'object',
		provider: 'fal',
		endpoint: 'tripo3d/h3.1/image-to-3d',
		costUsd: 0.3,
		input: (imageUrl) => ({ image_url: imageUrl, texture: true, pbr: true }),
	},
	// Prices are for a non-panorama image, which includes World Labs' 80-credit panorama step.
	{
		id: 'marble-draft',
		label: 'Marble draft (scene)',
		kind: 'scene',
		provider: 'worldlabs',
		model: 'marble-1.0-draft',
		costUsd: 230 / WORLDLABS_CREDITS_PER_USD,
	},
	{
		id: 'marble-1.1',
		label: 'Marble 1.1 (scene)',
		kind: 'scene',
		provider: 'worldlabs',
		model: 'marble-1.1',
		costUsd: 1580 / WORLDLABS_CREDITS_PER_USD,
	},
	{
		id: 'claude-massing',
		label: 'Claude massing',
		kind: 'massing',
		provider: 'agent',
		agent: 'claude',
		costUsd: null,
	},
	{
		id: 'codex-massing',
		label: 'Codex massing',
		kind: 'massing',
		provider: 'agent',
		agent: 'codex',
		costUsd: null,
	},
]

export function imageTo3dPlugin(): Plugin {
	const data = process.env.WEAVE_IMAGE_TO_3D_DIR ?? path.join(homedir(), 'models/weave-3d')
	// Paid results are kept so the trial can be written up without paying for them again.
	const results = path.join(data, 'results')
	const samples = new Map([
		['interior', 'samples/interior.jpg'],
		['office', 'samples/office.jpg'],
		['house', 'samples/house.png'],
	])
	const artifacts = new Map<string, string>()
	let agentRuns = 0

	const keyFor = async (provider: Provider) => {
		const { env } = providers[provider]
		if (process.env[env]) return process.env[env]
		const file = process.env[`${env}_FILE`]
		return file && existsSync(file) ? (await readFile(file, 'utf8')).trim() : null
	}

	const log = (entry: Record<string, unknown>) =>
		appendFile(path.join(results, 'runs.jsonl'), JSON.stringify(entry) + '\n')

	const download = async (url: string) => {
		const response = await fetch(url)
		if (!response.ok) throw new Error(`Could not download the model (${response.status}).`)
		return Buffer.from(await response.arrayBuffer())
	}

	const pollUntil = async <T>(
		provider: Provider,
		poll: () => Promise<T | null>,
		intervalMs: number
	) => {
		const started = Date.now()
		for (;;) {
			if (Date.now() - started > providers[provider].timeoutMs)
				throw new Error(
					`${providers[provider].label} did not finish within ${providers[provider].timeoutMs / 60_000} minutes`
				)
			await new Promise((resolve) => setTimeout(resolve, intervalMs))
			const result = await poll()
			if (result) return result
		}
	}

	const runFal = async (
		configuration: Extract<Configuration, { provider: 'fal' }>,
		key: string,
		image: Buffer,
		contentType: string
	): Promise<Generated> => {
		const headers = {
			authorization: `Key ${key}`,
			'content-type': 'application/json',
			'x-fal-store-io': '0',
		}
		const dataUri = `data:${contentType};base64,${image.toString('base64')}`
		const submitted = await fetch(`https://queue.fal.run/${configuration.endpoint}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(configuration.input(dataUri)),
		})
		if (!submitted.ok)
			throw new Error(`fal rejected the request (${submitted.status}): ${await submitted.text()}`)
		const queued = (await submitted.json()) as {
			request_id: string
			status_url: string
			response_url: string
		}
		await log({ event: 'submitted', model: configuration.id, requestId: queued.request_id })
		await pollUntil(
			'fal',
			async () => {
				const status = await fetch(queued.status_url, { headers })
				if (!status.ok) return null
				return ((await status.json()) as { status: string }).status === 'COMPLETED' ? true : null
			},
			3000
		)
		const response = await fetch(queued.response_url, { headers })
		const result = (await response.json()) as Record<string, unknown>
		if (!response.ok)
			throw new Error(`fal failed (${response.status}): ${JSON.stringify(result).slice(0, 500)}`)
		const glbUrl = findGlbUrl(result)
		if (!glbUrl) throw new Error(`fal returned no GLB: ${JSON.stringify(result).slice(0, 500)}`)
		return {
			glb: await download(glbUrl),
			response: result,
			requestId: queued.request_id,
			costUsd: configuration.costUsd ?? 0,
		}
	}

	const runMarble = async (
		configuration: Extract<Configuration, { provider: 'worldlabs' }>,
		key: string,
		image: Buffer,
		extension: string
	): Promise<Generated> => {
		const headers = { 'wlt-api-key': key, 'content-type': 'application/json' }
		const submitted = await fetch(`${WORLDLABS_API}/worlds:generate`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: configuration.model,
				display_name: `Weave ${new Date().toISOString().slice(0, 16)}`,
				world_prompt: {
					type: 'image',
					image_prompt: {
						source: 'data_base64',
						data_base64: image.toString('base64'),
						extension,
					},
				},
			}),
		})
		if (submitted.status === 402) throw new Error('The World Labs balance is too low for this run.')
		if (!submitted.ok)
			throw new Error(
				`World Labs rejected the request (${submitted.status}): ${await submitted.text()}`
			)
		const accepted = (await submitted.json()) as MarbleOperation
		await log({ event: 'submitted', model: configuration.id, requestId: accepted.operation_id })
		const operation = accepted.done
			? accepted
			: await pollUntil(
					'worldlabs',
					async () => {
						const status = await fetch(`${WORLDLABS_API}/operations/${accepted.operation_id}`, {
							headers,
						})
						if (!status.ok) return null
						const body = (await status.json()) as MarbleOperation
						return body.done ? body : null
					},
					5000
				)
		if (operation.error)
			throw new Error(
				`Marble failed: ${operation.error.message ?? `code ${operation.error.code ?? 'unknown'}`}`
			)
		const glbUrl = operation.response?.assets?.mesh?.collider_mesh_url
		if (!glbUrl)
			throw new Error(`Marble returned no mesh: ${JSON.stringify(operation).slice(0, 500)}`)
		return {
			glb: await download(glbUrl),
			response: operation,
			requestId: operation.operation_id,
			costUsd: operation.cost
				? operation.cost.total_credits / WORLDLABS_CREDITS_PER_USD
				: (configuration.costUsd ?? 0),
			worldUrl: operation.response?.world_marble_url,
		}
	}

	return {
		name: 'image-to-3d',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const url = new URL(req.url ?? '/', 'http://localhost')
				if (!url.pathname.startsWith(`${ROOT}/`)) return next()
				const json = (status: number, value: unknown) => {
					res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
					res.end(JSON.stringify(value))
				}
				let current:
					| {
							model: string
							directory: string
							started: number
							details?: Record<string, unknown>
					  }
					| undefined
				try {
					if (
						req.headers['sec-fetch-site'] === 'cross-site' ||
						(req.headers.origin && URL.parse(req.headers.origin)?.host !== req.headers.host)
					) {
						return json(403, { error: 'Use the local canvas to run this test.' })
					}
					if (req.method === 'GET' && url.pathname === `${ROOT}/health`) {
						const keys = {
							fal: (await keyFor('fal')) !== null,
							worldlabs: (await keyFor('worldlabs')) !== null,
						}
						return json(200, {
							models: configurations.map((configuration) => {
								const { id, label, kind, costUsd } = configuration
								const agent = configuration.provider === 'agent' ? configuration.agent : null
								const ready = agent
									? agentAvailable(agent)
									: keys[configuration.provider as Provider]
								const missing = agent
									? `${agent} CLI not found`
									: `no ${providers[configuration.provider as Provider].label} key`
								return {
									id,
									label,
									kind,
									costUsd,
									ready,
									missing: ready ? null : missing,
									choices: agent ? agentChoices[agent] : null,
								}
							}),
						})
					}
					const sample = samples.get(url.pathname.slice(`${ROOT}/samples/`.length))
					if (req.method === 'GET' && url.pathname.startsWith(`${ROOT}/samples/`) && sample) {
						const bytes = await readFile(path.join(data, sample))
						res.writeHead(200, {
							'content-type': sample.endsWith('.png') ? 'image/png' : 'image/jpeg',
						})
						return res.end(bytes)
					}
					const artifact = artifacts.get(url.pathname)
					if (req.method === 'GET' && artifact) {
						const bytes = await readFile(artifact)
						res.writeHead(200, {
							'content-type': 'model/gltf-binary',
							'content-length': bytes.length,
						})
						return res.end(bytes)
					}
					if (req.method !== 'POST' || url.pathname !== `${ROOT}/generate`)
						return json(404, { error: 'Not found' })
					const configuration = configurations.find(
						(item) => item.id === url.searchParams.get('model')
					)
					if (!configuration) return json(400, { error: 'Choose an available model.' })
					if (configuration.provider === 'agent') {
						if (agentRuns >= MAX_AGENT_RUNS)
							return json(429, {
								error: `Wait for the ${MAX_AGENT_RUNS} running massing models to finish.`,
							})
						agentRuns++
						try {
							const body = await readBody(req, MAX_AGENT_IMAGES * MAX_IMAGE_BYTES * 1.4)
							if (!body) return json(413, { error: 'Select fewer or smaller images.' })
							const parsed = agentRequestSchema.safeParse(parseOrNull(body.toString('utf8')))
							if (!parsed.success)
								return json(400, {
									error: `Send 1 to ${MAX_AGENT_IMAGES} PNG, JPEG or WebP images.`,
								})
							const images = parsed.data.images.map((image) => ({
								contentType: image.contentType,
								bytes: Buffer.from(image.base64, 'base64'),
							}))
							const unreadable = images.findIndex(
								(image) => !isImageFile(image.bytes, image.contentType)
							)
							if (unreadable !== -1)
								return json(400, {
									error: `Image ${unreadable + 1} is not a readable PNG, JPEG or WebP file.`,
								})
							const pick = { model: parsed.data.model, effort: parsed.data.effort }
							if (!isAgentPick(configuration.agent, pick))
								return json(400, {
									error: `${configuration.label} cannot run ${pick.model} at ${pick.effort} reasoning.`,
								})
							const started = Date.now()
							const directory = path.join(results, `${started}-${configuration.id}`)
							await mkdir(directory, { recursive: true })
							const details = { agentModel: pick.model, effort: pick.effort }
							current = { model: configuration.id, directory, started, details }
							await log({
								event: 'submitted',
								model: configuration.id,
								...details,
								images: images.length,
							})
							const scene = await runAgent(configuration.agent, pick, images, directory)
							const { glb, skipped } = await sceneToGlb(scene)
							const output = path.join(directory, 'model.glb')
							await writeFile(output, glb)
							const metadata = {
								seconds: (Date.now() - started) / 1000,
								parts: scene.parts.length - skipped.length,
								skipped: skipped.length,
								notes: scene.notes,
								glbBytes: glb.length,
								...details,
							}
							await log({ event: 'completed', model: configuration.id, directory, ...metadata })
							const modelUrl = `${ROOT}/models/${randomUUID()}.glb`
							artifacts.set(modelUrl, output)
							return json(200, { url: modelUrl, metadata })
						} finally {
							agentRuns--
						}
					}
					const contentType = req.headers['content-type'] ?? ''
					if (!IMAGE_TYPES.has(contentType))
						return json(415, { error: 'Send a PNG, JPEG or WebP image.' })
					const key = await keyFor(configuration.provider)
					const { env } = providers[configuration.provider]
					if (!key) return json(409, { error: `Start the dev server with ${env} or ${env}_FILE.` })
					const image = await readBody(req, MAX_IMAGE_BYTES)
					if (!image) return json(413, { error: 'Select a smaller image.' })
					if (!isImageFile(image, contentType))
						return json(400, { error: 'The image is not a readable PNG, JPEG or WebP file.' })
					const extension = contentType.split('/')[1].replace('jpeg', 'jpg')
					const started = Date.now()
					const directory = path.join(results, `${started}-${configuration.id}`)
					await mkdir(directory, { recursive: true })
					current = { model: configuration.id, directory, started }
					await writeFile(path.join(directory, `input.${extension}`), image)
					const generated =
						configuration.provider === 'fal'
							? await runFal(configuration, key, image, contentType)
							: await runMarble(configuration, key, image, extension)
					const output = path.join(directory, 'model.glb')
					await writeFile(output, generated.glb)
					await writeFile(
						path.join(directory, 'response.json'),
						JSON.stringify(generated.response, null, 2)
					)
					const metadata = {
						seconds: (Date.now() - started) / 1000,
						costUsd: generated.costUsd,
						glbBytes: generated.glb.length,
						worldUrl: generated.worldUrl,
					}
					await log({
						event: 'completed',
						model: configuration.id,
						requestId: generated.requestId,
						directory,
						...metadata,
					})
					const modelUrl = `${ROOT}/models/${randomUUID()}.glb`
					artifacts.set(modelUrl, output)
					return json(200, { url: modelUrl, metadata })
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					server.config.logger.error(`[image-to-3d] ${message}`)
					// A failed run still leaves its inputs on disk; record why so it is not mistaken for one still running.
					if (current) {
						const { model, directory, started, details } = current
						await Promise.all([
							writeFile(path.join(directory, 'error.txt'), message + '\n'),
							log({
								event: 'failed',
								model,
								...details,
								directory,
								seconds: (Date.now() - started) / 1000,
								error: message,
							}),
						]).catch((logError: unknown) =>
							server.config.logger.error(`[image-to-3d] could not record the failure: ${logError}`)
						)
					}
					return json(500, { error: message.slice(0, 300) })
				}
			})
		},
	}
}

const agentRequestSchema = z.object({
	images: z
		.array(
			z.object({
				contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
				base64: z.string().min(1),
			})
		)
		.min(1)
		.max(MAX_AGENT_IMAGES),
	model: z.string(),
	effort: z.string(),
})

/** A corrupt file is still billed by fal and World Labs, and an agent invents a placeholder for it. */
export function isImageFile(bytes: Buffer, contentType: string) {
	if (contentType === 'image/png')
		return bytes
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	if (contentType === 'image/jpeg')
		return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
	if (contentType === 'image/webp')
		return (
			bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
			bytes.subarray(8, 12).toString('latin1') === 'WEBP'
		)
	return false
}

function parseOrNull(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		// The schema check that follows turns this into a 400.
		return null
	}
}

async function readBody(req: AsyncIterable<Uint8Array>, limit: number) {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) return null
		chunks.push(Buffer.from(chunk))
	}
	return Buffer.concat(chunks)
}

function findGlbUrl(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	if (typeof record.url === 'string') {
		const name = typeof record.file_name === 'string' ? record.file_name : record.url
		if (/\.glb(\?|$)/i.test(name) || record.content_type === 'model/gltf-binary') return record.url
	}
	for (const preferred of ['model_glb', 'model_mesh', 'model_urls']) {
		const found = findGlbUrl(record[preferred])
		if (found) return found
	}
	for (const [name, child] of Object.entries(record)) {
		if (typeof child === 'string' && /\.glb(\?|$)/i.test(child) && name !== 'url') return child
		const found = typeof child === 'object' ? findGlbUrl(child) : null
		if (found) return found
	}
	return null
}
