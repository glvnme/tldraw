import { ConvertError } from './errors'

export interface StlMesh {
	/** Three vertices per triangle, unindexed, in the source units and axes. */
	positions: Float32Array
	triangleCount: number
}

/**
 * Binary when the size matches the facet count in the header, even if the 80-byte header starts
 * with "solid" (many exporters write that); otherwise ASCII if it starts with "solid".
 */
export function isBinaryStl(bytes: Uint8Array): boolean {
	if (bytes.byteLength >= 84) {
		const count = new DataView(bytes.buffer, bytes.byteOffset, 84).getUint32(80, true)
		if (84 + 50 * count === bytes.byteLength) return true
	}
	const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart()
	return !head.startsWith('solid')
}

export function parseStl(bytes: Uint8Array, maxTriangles = Infinity): StlMesh {
	const mesh = isBinaryStl(bytes)
		? parseBinaryStl(bytes, maxTriangles)
		: parseAsciiStl(bytes, maxTriangles)
	if (mesh.triangleCount === 0) throw new ConvertError('conversion_failed', 'STL has no triangles')
	return mesh
}

function tooManyTriangles(maxTriangles: number) {
	return new ConvertError('too_large', `STL has more than ${maxTriangles} triangles`)
}

function parseBinaryStl(bytes: Uint8Array, maxTriangles: number): StlMesh {
	if (bytes.byteLength < 84) throw new ConvertError('conversion_failed', 'STL is too short')
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const triangleCount = view.getUint32(80, true)
	if (triangleCount > maxTriangles) throw tooManyTriangles(maxTriangles)
	if (84 + 50 * triangleCount > bytes.byteLength) {
		throw new ConvertError('conversion_failed', 'STL is truncated')
	}
	const positions = new Float32Array(triangleCount * 9)
	for (let t = 0; t < triangleCount; t++) {
		// Skip the stored normal; it is often wrong and gets recomputed from the winding.
		const base = 84 + t * 50 + 12
		for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(base + k * 4, true)
	}
	return { positions, triangleCount }
}

function parseAsciiStl(bytes: Uint8Array, maxTriangles: number): StlMesh {
	const text = new TextDecoder().decode(bytes)
	const values: number[] = []
	const maxValues = maxTriangles * 9
	const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g
	for (let m = vertex.exec(text); m; m = vertex.exec(text)) {
		values.push(Number(m[1]), Number(m[2]), Number(m[3]))
		if (values.length > maxValues) throw tooManyTriangles(maxTriangles)
	}
	const triangleCount = Math.floor(values.length / 9)
	if (values.length !== triangleCount * 9 || values.some((v) => !Number.isFinite(v))) {
		throw new ConvertError('conversion_failed', 'Malformed ASCII STL')
	}
	return { positions: new Float32Array(values), triangleCount }
}

/** Flat normals from the counter-clockwise winding, three per triangle. */
export function computeFlatNormals(positions: Float32Array): Float32Array {
	const normals = new Float32Array(positions.length)
	for (let i = 0; i < positions.length; i += 9) {
		const ux = positions[i + 3] - positions[i]
		const uy = positions[i + 4] - positions[i + 1]
		const uz = positions[i + 5] - positions[i + 2]
		const vx = positions[i + 6] - positions[i]
		const vy = positions[i + 7] - positions[i + 1]
		const vz = positions[i + 8] - positions[i + 2]
		let nx = uy * vz - uz * vy
		let ny = uz * vx - ux * vz
		let nz = ux * vy - uy * vx
		const length = Math.hypot(nx, ny, nz)
		if (length > 0) {
			nx /= length
			ny /= length
			nz /= length
		}
		for (let k = 0; k < 9; k += 3) {
			normals[i + k] = nx
			normals[i + k + 1] = ny
			normals[i + k + 2] = nz
		}
	}
	return normals
}
