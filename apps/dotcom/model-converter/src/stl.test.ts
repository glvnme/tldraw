import { describe, expect, it } from 'vitest'
import { ConvertError } from './errors'
import { computeFlatNormals, isBinaryStl, parseStl } from './stl'

const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0]

function binaryStl(triangles: number[][], header = '') {
	const bytes = new Uint8Array(84 + 50 * triangles.length)
	bytes.set(new TextEncoder().encode(header).subarray(0, 80))
	const view = new DataView(bytes.buffer)
	view.setUint32(80, triangles.length, true)
	triangles.forEach((triangle, t) => {
		triangle.forEach((v, k) => view.setFloat32(84 + t * 50 + 12 + k * 4, v, true))
	})
	return bytes
}

const ASCII = `solid part
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 1e0 1 0
      vertex 0 1 0
      vertex 1 0 0
    endloop
  endfacet
endsolid part
`

describe('parseStl', () => {
	it('parses binary STL', () => {
		const mesh = parseStl(binaryStl([TRIANGLE, TRIANGLE.map((v) => v + 1)]))
		expect(mesh.triangleCount).toBe(2)
		expect([...mesh.positions]).toEqual([...TRIANGLE, ...TRIANGLE.map((v) => v + 1)])
	})

	it('parses ASCII STL', () => {
		const mesh = parseStl(new TextEncoder().encode(ASCII))
		expect(mesh.triangleCount).toBe(2)
		expect([...mesh.positions]).toEqual([...TRIANGLE, 1, 1, 0, 0, 1, 0, 1, 0, 0])
	})

	it('parses binary STL whose header starts with "solid" by its size', () => {
		const bytes = binaryStl([TRIANGLE], 'solid exported by a CAD tool')
		expect(isBinaryStl(bytes)).toBe(true)
		expect(parseStl(bytes).triangleCount).toBe(1)
	})

	it('rejects truncated binary STL', () => {
		const bytes = binaryStl([TRIANGLE, TRIANGLE]).subarray(0, 84 + 50)
		expect(() => parseStl(bytes)).toThrow('STL is truncated')
	})

	it('rejects STL over the triangle limit as too large', () => {
		for (const bytes of [binaryStl([TRIANGLE, TRIANGLE]), new TextEncoder().encode(ASCII)]) {
			let error: unknown
			try {
				parseStl(bytes, 1)
			} catch (e) {
				error = e
			}
			expect(error).toBeInstanceOf(ConvertError)
			expect((error as ConvertError).code).toBe('too_large')
		}
	})

	it('rejects STL with no triangles', () => {
		expect(() => parseStl(new TextEncoder().encode('solid empty\nendsolid empty\n'))).toThrow(
			'STL has no triangles'
		)
	})
})

describe('computeFlatNormals', () => {
	it('follows the counter-clockwise winding', () => {
		const normals = computeFlatNormals(new Float32Array([...TRIANGLE, 0, 0, 0, 0, 1, 0, 1, 0, 0]))
		expect([...normals].map((v) => v + 0)).toEqual([
			0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
		])
	})
})
