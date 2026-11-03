import type { Model3dManifestMesh, Model3dVec3 } from '@tldraw/dotcom-shared'
import { GltfJson } from './glb'

export interface GltfSummary {
	bounds: { min: Model3dVec3; max: Model3dVec3 } | null
	triangleCount: number
	nodeCount: number
	meshes: Model3dManifestMesh[]
	textureBytesEstimate: number
}

type Mat4 = number[]

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Column-major a * b. */
function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Array<number>(16)
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0
			for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k]
			out[col * 4 + row] = sum
		}
	}
	return out
}

function fromTrs(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]): Mat4 {
	const [x, y, z, w] = r
	return [
		(1 - 2 * (y * y + z * z)) * s[0],
		2 * (x * y + z * w) * s[0],
		2 * (x * z - y * w) * s[0],
		0,
		2 * (x * y - z * w) * s[1],
		(1 - 2 * (x * x + z * z)) * s[1],
		2 * (y * z + x * w) * s[1],
		0,
		2 * (x * z + y * w) * s[2],
		2 * (y * z - x * w) * s[2],
		(1 - 2 * (x * x + y * y)) * s[2],
		0,
		t[0],
		t[1],
		t[2],
		1,
	]
}

// Normalized integer attributes (gltfpack's quantized positions may be) store min/max unscaled.
function dequantize(value: number, componentType: number, normalized: boolean | undefined) {
	if (!normalized) return value
	switch (componentType) {
		case 5120:
			return Math.max(value / 127, -1)
		case 5121:
			return value / 255
		case 5122:
			return Math.max(value / 32767, -1)
		case 5123:
			return value / 65535
		default:
			return value
	}
}

function primitiveTriangles(
	json: GltfJson,
	primitive: { attributes: Record<string, number>; indices?: number; mode?: number }
) {
	const accessor = json.accessors?.[primitive.indices ?? primitive.attributes.POSITION]
	const count = accessor?.count ?? 0
	switch (primitive.mode ?? 4) {
		case 4:
			return Math.floor(count / 3)
		case 5:
		case 6:
			return Math.max(0, count - 2)
		default:
			return 0
	}
}

/** Counts and world-space bounds of a glTF scene, from accessor min/max and node transforms. */
export function summarizeGltf(json: GltfJson): GltfSummary {
	const meshes = (json.meshes ?? []).map((mesh, i) => ({
		name: mesh.name ?? `mesh ${i}`,
		triangleCount: mesh.primitives.reduce((sum, p) => sum + primitiveTriangles(json, p), 0),
	}))

	const min = [Infinity, Infinity, Infinity]
	const max = [-Infinity, -Infinity, -Infinity]
	let triangleCount = 0

	const visit = (nodeIndex: number, parent: Mat4, depth: number) => {
		const node = json.nodes?.[nodeIndex]
		if (!node || depth > 256) return
		const local = node.matrix ?? fromTrs(node.translation, node.rotation, node.scale)
		const world = multiply(parent, local)
		if (node.mesh !== undefined && json.meshes?.[node.mesh]) {
			triangleCount += meshes[node.mesh].triangleCount
			for (const primitive of json.meshes[node.mesh].primitives) {
				const accessor = json.accessors?.[primitive.attributes.POSITION]
				if (!accessor?.min || !accessor.max) continue
				const lo = accessor.min.map((v) =>
					dequantize(v, accessor.componentType, accessor.normalized)
				)
				const hi = accessor.max.map((v) =>
					dequantize(v, accessor.componentType, accessor.normalized)
				)
				for (let corner = 0; corner < 8; corner++) {
					const p = [
						corner & 1 ? hi[0] : lo[0],
						corner & 2 ? hi[1] : lo[1],
						corner & 4 ? hi[2] : lo[2],
					]
					for (let k = 0; k < 3; k++) {
						const v = world[k] * p[0] + world[4 + k] * p[1] + world[8 + k] * p[2] + world[12 + k]
						if (v < min[k]) min[k] = v
						if (v > max[k]) max[k] = v
					}
				}
			}
		}
		for (const child of node.children ?? []) visit(child, world, depth + 1)
	}
	for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, IDENTITY, 0)

	const textureBytesEstimate = (json.images ?? []).reduce(
		(sum, image) =>
			sum +
			(image.bufferView === undefined
				? 0
				: (json.bufferViews?.[image.bufferView]?.byteLength ?? 0)),
		0
	)

	return {
		bounds: Number.isFinite(min[0]) ? { min: min as Model3dVec3, max: max as Model3dVec3 } : null,
		triangleCount,
		nodeCount: json.nodes?.length ?? 0,
		meshes,
		textureBytesEstimate,
	}
}
