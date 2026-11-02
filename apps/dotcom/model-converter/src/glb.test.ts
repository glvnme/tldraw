import { pack } from 'gltfpack'
import { describe, expect, it } from 'vitest'
import { GlbScene, readGlb, writeGlb, Z_UP_TO_Y_UP } from './glb'
import { summarizeGltf } from './gltfInfo'

// One triangle (3 vertices, 3 indices) so the index view ends unaligned to 8 but every view still
// starts on a 4-byte boundary.
function triangleScene(): GlbScene {
	return {
		meshes: [
			{
				positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, -1]),
				normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
				batchIds: new Float32Array([7, 7, 7]),
				indices: new Uint32Array([0, 1, 2]),
				material: 0,
			},
		],
		materials: [[1, 0, 0, 0.5]],
		nodes: [{ mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1] }],
	}
}

describe('writeGlb', () => {
	it('writes a valid header and 4-byte padded chunks', () => {
		const glb = writeGlb(triangleScene())
		const view = new DataView(glb.buffer)
		expect(view.getUint32(0, true)).toBe(0x46546c67)
		expect(view.getUint32(4, true)).toBe(2)
		expect(view.getUint32(8, true)).toBe(glb.byteLength)

		const jsonLength = view.getUint32(12, true)
		expect(view.getUint32(16, true)).toBe(0x4e4f534a)
		expect(jsonLength % 4).toBe(0)
		const jsonText = new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))
		expect(jsonText.trimEnd()).toBe(jsonText.replace(/ +$/, ''))
		expect(() => JSON.parse(jsonText)).not.toThrow()

		const binOffset = 20 + jsonLength
		const binLength = view.getUint32(binOffset, true)
		expect(view.getUint32(binOffset + 4, true)).toBe(0x004e4942)
		expect(binLength % 4).toBe(0)
		expect(binOffset + 8 + binLength).toBe(glb.byteLength)
		expect(JSON.parse(jsonText).buffers).toEqual([{ byteLength: binLength }])
	})

	it('aligns buffer views and records position bounds', () => {
		const { json } = readGlb(writeGlb(triangleScene())) as { json: any }
		for (const view of json.bufferViews) expect(view.byteOffset % 4).toBe(0)
		const primitive = json.meshes[0].primitives[0]
		expect(json.accessors[primitive.attributes.POSITION]).toMatchObject({
			componentType: 5126,
			count: 3,
			type: 'VEC3',
			min: [0, 0, -1],
			max: [2, 3, 0],
		})
		expect(json.accessors[primitive.attributes._BATCHID]).toMatchObject({
			count: 3,
			type: 'SCALAR',
		})
		expect(json.accessors[primitive.indices]).toMatchObject({ componentType: 5125, count: 3 })
		expect(json.materials[0]).toMatchObject({ alphaMode: 'BLEND', doubleSided: true })
	})

	it('adds a root node above every node for the root matrix', () => {
		const { json } = readGlb(writeGlb({ ...triangleScene(), rootMatrix: Z_UP_TO_Y_UP })) as {
			json: any
		}
		expect(json.scenes[0].nodes).toEqual([1])
		expect(json.nodes[1]).toEqual({ matrix: Z_UP_TO_Y_UP, children: [0] })
	})

	it('round-trips through gltfpack with bounds and _BATCHID intact', async () => {
		const files = new Map([['in.glb', writeGlb({ ...triangleScene(), rootMatrix: Z_UP_TO_Y_UP })]])
		await pack(['-i', 'in.glb', '-o', 'out.glb', '-cc', '-mm'], {
			read: (path) => files.get(path)!,
			write: (path, data) => files.set(path, new Uint8Array(data)),
		})
		const { json } = readGlb(files.get('out.glb')!)
		expect(json.extensionsUsed).toContain('EXT_meshopt_compression')
		expect(json.meshes![0].primitives[0].attributes).toHaveProperty('_BATCHID')

		const summary = summarizeGltf(json)
		expect(summary.triangleCount).toBe(1)
		// The node moves x by 10, then Z-up becomes Y-up: (x, y, z) -> (x, z, -y).
		const expected = { min: [10, -1, -3], max: [12, 0, 0] }
		for (const key of ['min', 'max'] as const) {
			summary.bounds![key].forEach((v, k) => expect(v).toBeCloseTo(expected[key][k], 2))
		}
	})
})

describe('readGlb', () => {
	it('rejects files that are not GLB', () => {
		expect(() => readGlb(new TextEncoder().encode('{"asset":{}}'))).toThrow('Not a GLB file')
	})
})
