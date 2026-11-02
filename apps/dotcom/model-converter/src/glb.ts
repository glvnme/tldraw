// A minimal glTF 2.0 binary writer and reader: enough to hand meshes to gltfpack and to read its
// output back. https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const ARRAY_BUFFER = 34962
const ELEMENT_ARRAY_BUFFER = 34963
const FLOAT = 5126
const UNSIGNED_INT = 5125

export type Rgba = [number, number, number, number]

export interface GlbMesh {
	positions: Float32Array
	normals?: Float32Array
	/** Per-vertex feature id, written as the `_BATCHID` attribute. */
	batchIds?: Float32Array
	indices: Uint32Array
	material: number
}

export interface GlbNode {
	mesh: number
	/** Column-major 4x4. */
	matrix?: number[]
}

export interface GlbScene {
	meshes: GlbMesh[]
	materials: Rgba[]
	nodes: GlbNode[]
	/** Applied above every node, e.g. a Z-up to Y-up rotation. */
	rootMatrix?: number[]
}

/** Rotates -90 degrees about X: Z-up source coordinates to glTF's Y-up. */
export const Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]

const pad4 = (n: number) => (4 - (n % 4)) % 4

export function writeGlb(scene: GlbScene): Uint8Array {
	const chunks: Uint8Array[] = []
	const bufferViews: object[] = []
	const accessors: object[] = []
	let offset = 0

	const pushView = (data: Float32Array | Uint32Array, target: number) => {
		// Typed arrays are 4-byte elements, so every view stays 4-byte aligned without padding.
		chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
		bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target })
		offset += data.byteLength
		return bufferViews.length - 1
	}
	const pushAccessor = (accessor: object) => {
		accessors.push(accessor)
		return accessors.length - 1
	}

	const meshes = scene.meshes.map((mesh) => {
		const { min, max } = vec3Bounds(mesh.positions)
		const attributes: Record<string, number> = {
			POSITION: pushAccessor({
				bufferView: pushView(mesh.positions, ARRAY_BUFFER),
				componentType: FLOAT,
				count: mesh.positions.length / 3,
				type: 'VEC3',
				min,
				max,
			}),
		}
		if (mesh.normals) {
			attributes.NORMAL = pushAccessor({
				bufferView: pushView(mesh.normals, ARRAY_BUFFER),
				componentType: FLOAT,
				count: mesh.normals.length / 3,
				type: 'VEC3',
			})
		}
		if (mesh.batchIds) {
			attributes._BATCHID = pushAccessor({
				bufferView: pushView(mesh.batchIds, ARRAY_BUFFER),
				componentType: FLOAT,
				count: mesh.batchIds.length,
				type: 'SCALAR',
			})
		}
		const indices = pushAccessor({
			bufferView: pushView(mesh.indices, ELEMENT_ARRAY_BUFFER),
			componentType: UNSIGNED_INT,
			count: mesh.indices.length,
			type: 'SCALAR',
		})
		return { primitives: [{ attributes, indices, material: mesh.material }] }
	})

	const materials = scene.materials.map((color) => ({
		pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1 },
		...(color[3] < 1 ? { alphaMode: 'BLEND' } : null),
		doubleSided: true,
	}))

	const nodes: object[] = scene.nodes.map((node) => ({
		mesh: node.mesh,
		...(node.matrix ? { matrix: node.matrix } : null),
	}))
	let sceneNodes = nodes.map((_, i) => i)
	if (scene.rootMatrix) {
		nodes.push({ matrix: scene.rootMatrix, children: sceneNodes })
		sceneNodes = [nodes.length - 1]
	}

	const json = {
		asset: { version: '2.0', generator: '@tldraw/model-converter' },
		scene: 0,
		scenes: [{ nodes: sceneNodes }],
		nodes,
		meshes,
		materials,
		accessors,
		bufferViews,
		buffers: [{ byteLength: offset }],
	}

	const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
	const jsonLength = jsonBytes.length + pad4(jsonBytes.length)
	const total = 12 + 8 + jsonLength + 8 + offset
	const out = new Uint8Array(total)
	const view = new DataView(out.buffer)
	view.setUint32(0, GLB_MAGIC, true)
	view.setUint32(4, 2, true)
	view.setUint32(8, total, true)
	view.setUint32(12, jsonLength, true)
	view.setUint32(16, CHUNK_JSON, true)
	out.set(jsonBytes, 20)
	out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength)
	let p = 20 + jsonLength
	view.setUint32(p, offset, true)
	view.setUint32(p + 4, CHUNK_BIN, true)
	p += 8
	for (const chunk of chunks) {
		out.set(chunk, p)
		p += chunk.byteLength
	}
	return out
}

export function vec3Bounds(values: Float32Array) {
	const min = [Infinity, Infinity, Infinity]
	const max = [-Infinity, -Infinity, -Infinity]
	for (let i = 0; i < values.length; i += 3) {
		for (let k = 0; k < 3; k++) {
			const v = values[i + k]
			if (v < min[k]) min[k] = v
			if (v > max[k]) max[k] = v
		}
	}
	return { min, max }
}

/** The glTF JSON as written by gltfpack or this writer; only the fields the converter reads. */
export interface GltfJson {
	extensionsUsed?: string[]
	extensionsRequired?: string[]
	scene?: number
	scenes?: { nodes?: number[] }[]
	nodes?: {
		mesh?: number
		children?: number[]
		matrix?: number[]
		translation?: number[]
		rotation?: number[]
		scale?: number[]
	}[]
	meshes?: {
		name?: string
		primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[]
	}[]
	accessors?: {
		count: number
		componentType: number
		normalized?: boolean
		min?: number[]
		max?: number[]
	}[]
	bufferViews?: { byteLength: number }[]
	images?: { bufferView?: number; uri?: string }[]
}

export function readGlb(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
		throw new Error('Not a GLB file')
	}
	if (view.getUint32(4, true) !== 2) throw new Error('Unsupported GLB version')
	const length = Math.min(view.getUint32(8, true), bytes.byteLength)
	let json: GltfJson | null = null
	let bin: Uint8Array | null = null
	for (let p = 12; p + 8 <= length; ) {
		const chunkLength = view.getUint32(p, true)
		const type = view.getUint32(p + 4, true)
		const data = bytes.subarray(p + 8, p + 8 + chunkLength)
		if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data))
		else if (type === CHUNK_BIN && !bin) bin = data
		p += 8 + chunkLength
	}
	if (!json) throw new Error('GLB has no JSON chunk')
	return { json, bin }
}
