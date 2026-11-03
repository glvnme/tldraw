import { createRequire } from 'node:module'
import type {
	Model3dConvertJob,
	Model3dConvertStage,
	Model3dManifest,
	Model3dSourceFormat,
} from '@tldraw/dotcom-shared'
import { pack } from 'gltfpack'
import { ConvertError } from './errors'
import { readGlb, Rgba, writeGlb } from './glb'
import { summarizeGltf } from './gltfInfo'
import { ifcToScene } from './ifc'
import { computeFlatNormals, parseStl } from './stl'

const require = createRequire(import.meta.url)
const CONVERTER_VERSION: string = require('../package.json').version
const GLTFPACK_VERSION: string = require('gltfpack/package.json').version

// -mm bakes repeated meshes into one (gltfpack otherwise keeps deduplicated IFC geometry as
// instances, a draw call each). No -kn: kept nodes block merging and inflate output many times
// over. No -mi: instancing would lose per-product _BATCHID. No texture flags: no BasisU in WASM.
export const GLTFPACK_FLAGS = ['-cc', '-mm']

const STL_GREY: Rgba = [0.7, 0.7, 0.7, 1]

export type Limits = Model3dConvertJob['limits']

export interface ConvertResult {
	glb: Uint8Array
	manifest: Model3dManifest
}

export type OnStage = (stage: Model3dConvertStage, progress: number) => void

interface PackInput {
	name: string
	bytes: Uint8Array
	transform: Model3dManifest['transform']
	units: Model3dManifest['units']
	versions: string[]
}

export async function convertModel(
	source: Uint8Array,
	format: Model3dSourceFormat,
	limits: Limits,
	onStage: OnStage = () => {}
): Promise<ConvertResult> {
	if (source.byteLength > limits.maxSourceBytes) {
		throw new ConvertError('too_large', `Source is larger than ${limits.maxSourceBytes} bytes`)
	}
	onStage('parsing', 0.1)
	const input = await prepareInput(source, format, limits, onStage)

	onStage('optimizing', 0.5)
	const args = ['-i', input.name, '-o', 'out.glb', ...GLTFPACK_FLAGS]
	const glb = await runGltfpack(input, args)
	if (glb.byteLength > limits.maxGlbBytes) {
		throw new ConvertError('too_large', `Output GLB is larger than ${limits.maxGlbBytes} bytes`)
	}

	const summary = summarizeGltf(readGlb(glb).json)
	if (!summary.bounds || summary.triangleCount === 0) {
		throw new ConvertError('conversion_failed', 'The model has no triangles')
	}
	if (summary.triangleCount > limits.maxTriangles) {
		throw new ConvertError('too_large', `Model has more than ${limits.maxTriangles} triangles`)
	}

	return {
		glb,
		manifest: {
			version: 1,
			bounds: summary.bounds,
			units: input.units,
			transform: input.transform,
			triangleCount: summary.triangleCount,
			nodeCount: summary.nodeCount,
			meshes: summary.meshes,
			textureBytesEstimate: summary.textureBytesEstimate,
			glbBytes: glb.byteLength,
			converter: {
				name: '@tldraw/model-converter',
				version: [CONVERTER_VERSION, `gltfpack ${GLTFPACK_VERSION}`, ...input.versions].join(', '),
				args,
			},
			sourceFormat: format,
		},
	}
}

async function prepareInput(
	source: Uint8Array,
	format: Model3dSourceFormat,
	limits: Limits,
	onStage: OnStage
): Promise<PackInput> {
	switch (format) {
		case 'ifc': {
			const ifc = await ifcToScene(source, {
				maxTriangles: limits.maxTriangles,
				onProgress: throttle((fraction) => onStage('parsing', 0.1 + 0.35 * fraction)),
			})
			if (ifc.scene.meshes.length === 0) {
				throw new ConvertError('conversion_failed', 'The IFC file has no geometry')
			}
			// web-ifc's translation is in Y-up axes; the offset is its negation in the Z-up source.
			const [tx, ty, tz] = ifc.coordinationMatrix.slice(12, 15)
			return {
				name: 'in.glb',
				bytes: writeGlb(ifc.scene),
				transform: { recentreOffset: [-tx, tz, -ty], scale: 1, upAxis: 'z' },
				units: 'm',
				versions: [`web-ifc ${ifc.webIfcVersion}`],
			}
		}
		case 'stl': {
			const { positions } = parseStl(source, limits.maxTriangles)
			// No units in STL: assume millimetres, and Z-up like most CAD and print tools.
			const scale = 0.001
			for (let i = 0; i < positions.length; i += 3) {
				const y = positions[i + 1]
				positions[i] *= scale
				positions[i + 1] = positions[i + 2] * scale
				positions[i + 2] = -y * scale
			}
			const indices = new Uint32Array(positions.length / 3)
			for (let i = 0; i < indices.length; i++) indices[i] = i
			return {
				name: 'in.glb',
				bytes: writeGlb({
					meshes: [{ positions, normals: computeFlatNormals(positions), indices, material: 0 }],
					materials: [STL_GREY],
					nodes: [{ mesh: 0 }],
				}),
				transform: { recentreOffset: [0, 0, 0], scale, upAxis: 'z' },
				units: 'm',
				versions: [],
			}
		}
		case 'obj':
			return {
				name: 'in.obj',
				bytes: source,
				transform: { recentreOffset: [0, 0, 0], scale: 1, upAxis: 'y' },
				// OBJ carries no units.
				units: 'unknown',
				versions: [],
			}
		case 'glb': {
			let json
			try {
				json = readGlb(source).json
			} catch (error) {
				throw new ConvertError('unsupported_format', (error as Error).message)
			}
			const extensions = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]
			if (extensions.includes('KHR_draco_mesh_compression')) {
				throw new ConvertError('draco_unsupported', 'Draco-compressed GLB is not supported')
			}
			return {
				name: 'in.glb',
				bytes: source,
				transform: { recentreOffset: [0, 0, 0], scale: 1, upAxis: 'y' },
				units: 'm',
				versions: [],
			}
		}
		default:
			throw new ConvertError('unsupported_format', `Unknown format ${format satisfies never}`)
	}
}

async function runGltfpack(input: PackInput, args: string[]): Promise<Uint8Array> {
	const files = new Map([[input.name, input.bytes]])
	try {
		await pack(args, {
			// Only the input exists: a missing MTL or external buffer is gltfpack's to tolerate or
			// fail on, and nothing on disk is ever read.
			read: (path) => {
				const file = files.get(path)
				if (!file) throw new Error(`${path} is not available`)
				return file
			},
			write: (path, data) => files.set(path, new Uint8Array(data)),
		})
	} catch (error) {
		throw new ConvertError(
			'conversion_failed',
			`gltfpack: ${String((error as Error).message ?? error).trim()}`
		)
	}
	const out = files.get('out.glb')
	if (!out) throw new ConvertError('conversion_failed', 'gltfpack wrote no output')
	return out
}

function throttle(fn: (fraction: number) => void, intervalMs = 1000) {
	let last = 0
	return (fraction: number) => {
		const now = Date.now()
		if (now - last < intervalMs) return
		last = now
		fn(fraction)
	}
}
