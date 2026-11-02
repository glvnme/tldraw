import { getModel3dFormat, planUploadParts } from './upload'

describe('getModel3dFormat', () => {
	it.each([
		['tower.ifc', 'ifc'],
		['Tower.IFC', 'ifc'],
		['chair.glb', 'glb'],
		['mesh.v2.obj', 'obj'],
		['part.stl', 'stl'],
		['scene.gltf', null],
		['ifc', null],
		['notes.txt', null],
	])('%s -> %s', (name, format) => {
		expect(getModel3dFormat(name)).toBe(format)
	})
})

describe('planUploadParts', () => {
	it('splits into equal parts with a shorter last part', () => {
		expect(planUploadParts(25, 10)).toEqual([
			{ partNumber: 1, start: 0, end: 10 },
			{ partNumber: 2, start: 10, end: 20 },
			{ partNumber: 3, start: 20, end: 25 },
		])
	})

	it('does not add an empty part when the size is a multiple of the part size', () => {
		expect(planUploadParts(20, 10)).toEqual([
			{ partNumber: 1, start: 0, end: 10 },
			{ partNumber: 2, start: 10, end: 20 },
		])
	})

	it('uses one part for a file smaller than the part size', () => {
		expect(planUploadParts(3, 16 * 1024 * 1024)).toEqual([{ partNumber: 1, start: 0, end: 3 }])
	})
})
