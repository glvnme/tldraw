/* eslint-disable no-restricted-globals -- runs in the Vite dev server (Node), not the browser */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BufferAttribute, BufferGeometry } from 'three'
import { z } from 'zod'

export type Agent = 'claude' | 'codex'

export interface AgentPick {
	model: string
	effort: string
}

/** The models and reasoning levels the test canvas offers; anything else is rejected. */
export const agentChoices: Record<
	Agent,
	{ models: { id: string; label: string }[]; efforts: string[]; default: AgentPick }
> = {
	claude: {
		models: [
			{ id: 'opus', label: 'Opus' },
			{ id: 'sonnet', label: 'Sonnet' },
			{ id: 'haiku', label: 'Haiku' },
		],
		efforts: ['medium', 'high', 'xhigh'],
		default: { model: 'opus', effort: 'high' },
	},
	codex: {
		models: [
			{ id: 'gpt-6-astra', label: 'Astra' },
			{ id: 'gpt-6.1-sol', label: '6.1 Sol' },
			{ id: 'gpt-6.1-terra', label: '6.1 Terra' },
		],
		efforts: ['medium', 'high'],
		default: { model: 'gpt-6.1-terra', effort: 'high' },
	},
}

export function isAgentPick(agent: Agent, pick: AgentPick) {
	const choices = agentChoices[agent]
	return (
		choices.models.some((model) => model.id === pick.model) && choices.efforts.includes(pick.effort)
	)
}

export interface AgentImage {
	bytes: Buffer
	contentType: string
}

const TIMEOUT_MS = 10 * 60_000
const MAX_PARTS = 400

const vector = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }

// Strict structured output (Codex) needs every property required and no extras.
const sceneJsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['name', 'notes', 'parts'],
	properties: {
		name: { type: 'string' },
		notes: { type: 'string' },
		parts: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['label', 'kind', 'position', 'rotation', 'size', 'footprint', 'color'],
				properties: {
					label: { type: 'string' },
					kind: {
						type: 'string',
						enum: ['box', 'cylinder', 'cone', 'sphere', 'gable', 'extrusion'],
					},
					position: vector,
					rotation: vector,
					size: vector,
					footprint: {
						type: 'array',
						items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
					},
					color: { type: 'string' },
				},
			},
		},
	},
}

const triple = z.tuple([z.number(), z.number(), z.number()])
const sceneSchema = z.object({
	name: z.string(),
	notes: z.string(),
	parts: z
		.array(
			z.object({
				label: z.string(),
				kind: z.enum(['box', 'cylinder', 'cone', 'sphere', 'gable', 'extrusion']),
				position: triple,
				rotation: triple,
				size: triple,
				footprint: z.array(z.tuple([z.number(), z.number()])),
				color: z.string(),
			})
		)
		.max(MAX_PARTS),
})
export type MassingScene = z.infer<typeof sceneSchema>

const PROMPT = `You are making a quick 3D massing model for an architecture review board.
The attached images show one site, building, room or object, possibly from several views or as a sketch.
Rebuild what you see from simple solid parts and return only the JSON the schema asks for.

Conventions:
- Units are meters at real-world scale. Y is up and the ground is y = 0. X points right and Z points toward the camera of the first image.
- position is the centre of the part's base (its lowest face). rotation is degrees about X, Y and Z, applied around that point.
- size is [width along X, height along Y, depth along Z] before rotation.
- box: a cuboid. cylinder: size X and Z are diameters. cone: base diameters, point up. sphere: an ellipsoid resting on position.
- gable: a triangular prism for pitched roofs. size X is the span, size Y the ridge height above the eaves, size Z the ridge length; the ridge runs along Z.
- extrusion: footprint is [[x, z], ...] in meters relative to position, at least 3 points, extruded up by size Y. size X and Z are ignored. Use it for irregular plans, terraces and paths.
- footprint is [] for every kind except extrusion.
- color is #rrggbb matching the material you see.

Model the ground or floor slab, the main volumes, roofs, large openings (dark boxes about 3 cm proud of the wall), and the key landscape or furniture items. Use between 20 and 200 parts. Proportions and placement matter more than small detail.
In notes, say in one or two sentences what you assumed about scale and the sides you cannot see.

If you cannot see the images, or they show no building, room, site or object, never invent a placeholder: return an empty parts list and say why in notes.`

export function agentAvailable(agent: Agent) {
	return (process.env.PATH ?? '')
		.split(path.delimiter)
		.some((directory) => directory && existsSync(path.join(directory, agent)))
}

export async function runAgent(
	agent: Agent,
	pick: AgentPick,
	images: AgentImage[],
	directory: string
) {
	if (!isAgentPick(agent, pick))
		throw new Error(`${agent} cannot run ${pick.model} at ${pick.effort}.`)
	const files = await Promise.all(
		images.map(async (image, index) => {
			const file = path.join(
				directory,
				`input-${index + 1}.${image.contentType.split('/')[1].replace('jpeg', 'jpg')}`
			)
			await writeFile(file, image.bytes)
			return file
		})
	)
	const raw =
		agent === 'claude'
			? await runClaude(pick, images, directory)
			: await runCodex(pick, files, directory)
	await writeFile(path.join(directory, 'response.json'), JSON.stringify(raw, null, 2))
	const parsed = sceneSchema.safeParse(raw)
	if (!parsed.success)
		throw new Error(
			`The ${agent} answer did not match the model format: ${parsed.error.message.slice(0, 300)}`
		)
	if (parsed.data.parts.length === 0)
		throw new Error(`${agent} could not build a model: ${parsed.data.notes || 'no reason given'}`)
	return parsed.data
}

/**
 * The agents read untrusted images, so they get no provider keys or key file paths. A nested
 * Claude Code also refuses to start when it sees its parent session's variables.
 */
export function childEnv(env: NodeJS.ProcessEnv) {
	return Object.fromEntries(
		Object.entries(env).filter(
			([name]) =>
				!name.startsWith('CLAUDECODE') &&
				!name.startsWith('FAL_KEY') &&
				!name.startsWith('WORLDLABS_API_KEY')
		)
	)
}

function run(command: string, args: string[], cwd: string, stdin: string) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: childEnv(process.env),
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		const timer = setTimeout(() => {
			child.kill('SIGTERM')
			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
			}, 5000).unref()
			reject(new Error(`${command} did not finish within ${TIMEOUT_MS / 60_000} minutes`))
		}, TIMEOUT_MS)
		child.stdout.on('data', (chunk) => (stdout += chunk))
		child.stderr.on('data', (chunk) => (stderr += chunk))
		child.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0) resolve(stdout)
			else
				reject(
					new Error(
						`${command} exited with ${code}: ${(stderr || stdout).trim().slice(-400) || 'no output'}`
					)
				)
		})
		child.stdin.end(stdin)
	})
}

async function runClaude(pick: AgentPick, images: AgentImage[], directory: string) {
	const message = {
		type: 'user',
		message: {
			role: 'user',
			content: [
				...images.map((image) => ({
					type: 'image',
					source: {
						type: 'base64',
						media_type: image.contentType,
						data: image.bytes.toString('base64'),
					},
				})),
				{ type: 'text', text: PROMPT },
			],
		},
	}
	const output = await run(
		'claude',
		[
			'-p',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--json-schema',
			JSON.stringify(sceneJsonSchema),
			'--tools',
			'',
			'--strict-mcp-config',
			'--disable-slash-commands',
			'--no-session-persistence',
			'--model',
			pick.model,
			'--effort',
			pick.effort,
		],
		directory,
		JSON.stringify(message) + '\n'
	)
	const result = output
		.split('\n')
		.flatMap((line) => {
			// The CLI can print warnings between events; only the result event matters.
			try {
				return [JSON.parse(line) as Record<string, unknown>]
			} catch {
				return []
			}
		})
		.findLast((event) => event.type === 'result')
	if (!result) throw new Error(`Claude returned no result: ${output.trim().slice(-300)}`)
	const { structured_output: _, ...summary } = result
	await writeFile(path.join(directory, 'claude-result.json'), JSON.stringify(summary, null, 2))
	if (result.is_error) throw new Error(`Claude failed: ${String(result.result).slice(0, 300)}`)
	return result.structured_output ?? parseJson('Claude', String(result.result))
}

async function runCodex(pick: AgentPick, files: string[], directory: string) {
	const schema = path.join(directory, 'schema.json')
	const answer = path.join(directory, 'answer.json')
	await writeFile(schema, JSON.stringify(sceneJsonSchema))
	await run(
		'codex',
		[
			'exec',
			'--model',
			pick.model,
			'--config',
			`model_reasoning_effort="${pick.effort}"`,
			'--skip-git-repo-check',
			'--ephemeral',
			'--sandbox',
			'read-only',
			'--cd',
			directory,
			'--output-schema',
			schema,
			'--output-last-message',
			answer,
			// --image takes several values, so it goes last and the prompt comes from stdin.
			...files.flatMap((file) => ['--image', file]),
		],
		directory,
		PROMPT
	)
	if (!existsSync(answer)) throw new Error('Codex finished without an answer.')
	return parseJson('Codex', await readFile(answer, 'utf8'))
}

function parseJson(agent: string, text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
	try {
		return JSON.parse((fenced ? fenced[1] : text).trim())
	} catch {
		throw new Error(`${agent} did not answer with JSON: ${text.trim().slice(0, 200)}`)
	}
}

export async function sceneToGlb(scene: MassingScene) {
	const THREE = await import('three')
	const materials: string[] = []
	const meshes: Parameters<typeof writeGlb>[1] = []
	// One malformed part should not throw away a run that took the agent a minute or more.
	const skipped: string[] = []
	for (const part of scene.parts) {
		if (part.kind === 'extrusion' && Math.abs(footprintArea(part.footprint)) < 1e-4) {
			skipped.push(part.label)
			continue
		}
		const [w, h, d] = part.size.map((value) => Math.max(Math.abs(value), 0.01))
		let geometry: BufferGeometry
		switch (part.kind) {
			case 'box':
				geometry = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0)
				break
			case 'cylinder':
			case 'cone':
				geometry = new THREE.CylinderGeometry(part.kind === 'cone' ? 0 : 0.5, 0.5, 1, 32)
					.translate(0, 0.5, 0)
					.scale(w, h, d)
				break
			case 'sphere':
				geometry = new THREE.SphereGeometry(0.5, 32, 16).translate(0, 0.5, 0).scale(w, h, d)
				break
			case 'gable':
				geometry = new THREE.ExtrudeGeometry(
					new THREE.Shape([
						new THREE.Vector2(-w / 2, 0),
						new THREE.Vector2(w / 2, 0),
						new THREE.Vector2(0, h),
					]),
					{ depth: d, bevelEnabled: false }
				).translate(0, 0, -d / 2)
				break
			case 'extrusion': {
				// The shape is drawn in XY and extruded along Z; turning it upright maps shape y to -z.
				geometry = new THREE.ExtrudeGeometry(
					new THREE.Shape(part.footprint.map(([x, z]) => new THREE.Vector2(x, -z))),
					{ depth: h, bevelEnabled: false }
				).rotateX(-Math.PI / 2)
				break
			}
		}
		const toRadians = Math.PI / 180
		geometry.applyMatrix4(
			new THREE.Matrix4().compose(
				new THREE.Vector3(...part.position),
				new THREE.Quaternion().setFromEuler(
					new THREE.Euler(
						part.rotation[0] * toRadians,
						part.rotation[1] * toRadians,
						part.rotation[2] * toRadians
					)
				),
				new THREE.Vector3(1, 1, 1)
			)
		)
		const flat = geometry.index ? geometry.toNonIndexed() : geometry
		const position = (flat.getAttribute('position') as BufferAttribute).array as Float32Array
		const normal = (flat.getAttribute('normal') as BufferAttribute).array as Float32Array
		if (position.length === 0 || position.some((value) => !Number.isFinite(value))) {
			skipped.push(part.label)
			continue
		}
		const color = /^#[0-9a-f]{6}$/i.test(part.color) ? part.color.toLowerCase() : '#9a9a9a'
		if (!materials.includes(color)) materials.push(color)
		meshes.push({ name: part.label, position, normal, material: materials.indexOf(color) })
	}
	if (meshes.length === 0) throw new Error('None of the parts could be built.')
	return { glb: writeGlb(scene.name, meshes, materials), skipped }
}

/** Fewer than 3 points, or points on one line, give zero area and only sliver walls. */
function footprintArea(points: [number, number][]) {
	let area = 0
	for (let i = 0; i < points.length; i++) {
		const [x1, z1] = points[i]
		const [x2, z2] = points[(i + 1) % points.length]
		area += x1 * z2 - x2 * z1
	}
	return area / 2
}

function writeGlb(
	name: string,
	meshes: { name: string; position: Float32Array; normal: Float32Array; material: number }[],
	colors: string[]
) {
	const chunks: Buffer[] = []
	const bufferViews: object[] = []
	const accessors: object[] = []
	let offset = 0
	const addAccessor = (values: Float32Array, withBounds: boolean) => {
		const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength)
		chunks.push(bytes)
		bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 })
		offset += bytes.length
		const min = [Infinity, Infinity, Infinity]
		const max = [-Infinity, -Infinity, -Infinity]
		if (withBounds)
			for (let i = 0; i < values.length; i += 3)
				for (let axis = 0; axis < 3; axis++) {
					min[axis] = Math.min(min[axis], values[i + axis])
					max[axis] = Math.max(max[axis], values[i + axis])
				}
		accessors.push({
			bufferView: bufferViews.length - 1,
			componentType: 5126,
			count: values.length / 3,
			type: 'VEC3',
			...(withBounds ? { min, max } : {}),
		})
		return accessors.length - 1
	}
	const toLinear = (channel: number) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
	const gltf = {
		asset: { version: '2.0', generator: 'Weave massing' },
		scene: 0,
		scenes: [{ name, nodes: meshes.map((_, index) => index) }],
		nodes: meshes.map((mesh, index) => ({ name: mesh.name, mesh: index })),
		meshes: meshes.map((mesh) => ({
			name: mesh.name,
			primitives: [
				{
					attributes: {
						POSITION: addAccessor(mesh.position, true),
						NORMAL: addAccessor(mesh.normal, false),
					},
					material: mesh.material,
				},
			],
		})),
		materials: colors.map((color) => ({
			name: color,
			pbrMetallicRoughness: {
				baseColorFactor: [1, 3, 5]
					.map((start) => toLinear(parseInt(color.slice(start, start + 2), 16) / 255))
					.concat(1),
				metallicFactor: 0,
				roughnessFactor: 0.85,
			},
		})),
		accessors,
		bufferViews,
		buffers: [{ byteLength: offset }],
	}
	const pad = (buffer: Buffer, fill: number) =>
		Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)])
	const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20)
	const bin = pad(Buffer.concat(chunks), 0)
	const header = Buffer.alloc(12)
	header.writeUInt32LE(0x46546c67, 0)
	header.writeUInt32LE(2, 4)
	header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
	const chunkHeader = (length: number, type: number) => {
		const buffer = Buffer.alloc(8)
		buffer.writeUInt32LE(length, 0)
		buffer.writeUInt32LE(type, 4)
		return buffer
	}
	return Buffer.concat([
		header,
		chunkHeader(json.length, 0x4e4f534a),
		json,
		chunkHeader(bin.length, 0x004e4942),
		bin,
	])
}
