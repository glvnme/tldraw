import { createHash } from 'node:crypto'
import { pack } from 'gltfpack'
import { beforeAll, describe, expect, it } from 'vitest'
import { readGlb } from './glb'
import { convertModel } from './pipeline'
import { release } from './rhinoMesher'
import { loadRhino, threedmToScene } from './threedm'

const LIMITS = { maxSourceBytes: 10e6, maxGlbBytes: 10e6, maxTriangles: 1e6, timeoutMs: 1e4 }
let rhino: Awaited<ReturnType<typeof loadRhino>>
beforeAll(async () => {
	rhino = await loadRhino()
})

function triangle() {
	const mesh = new rhino.Mesh()
	for (const p of [
		[0, 0, 0],
		[1000, 0, 0],
		[0, 1000, 0],
	])
		mesh.vertices().add(p[0], p[1], p[2])
	mesh.faces().addTriFace(0, 1, 2)
	return mesh
}

function documentBytes(
	setup: (doc: InstanceType<typeof rhino.File3dm>) => void,
	units = rhino.UnitSystem.Millimeters
) {
	const doc = new rhino.File3dm()
	try {
		doc.settings().modelUnitSystem = units
		const layer = new rhino.Layer()
		layer.name = 'Default'
		doc.layers().add(layer)
		release(layer)
		setup(doc)
		return doc.toByteArray()
	} finally {
		release(doc)
	}
}

function addTriangle(doc: InstanceType<typeof rhino.File3dm>, name: string) {
	const mesh = triangle(),
		attributes = new rhino.ObjectAttributes()
	try {
		attributes.name = name
		attributes.layerIndex = 0
		attributes.setUserString('discipline', 'architecture')
		return doc.objects().addMesh(mesh, attributes)
	} finally {
		release(mesh)
		release(attributes)
	}
}

describe('3DM conversion', () => {
	it('checks the archive header before parsing', async () => {
		await expect(
			threedmToScene(new TextEncoder().encode('not a 3dm'), LIMITS)
		).rejects.toMatchObject({ code: 'unsupported_format' })
	})

	it('converts mesh objects to metres and preserves identity and source facts through packing', async () => {
		const ids: string[] = []
		const bytes = documentBytes((doc) => {
			ids.push(addTriangle(doc, 'First'), addTriangle(doc, 'Second'))
		})
		const { glb, manifest } = await convertModel(
			bytes,
			'3dm',
			LIMITS,
			undefined,
			'/private/path/site.3dm'
		)
		expect(manifest.version).toBe(2)
		if (manifest.version !== 2) throw new Error('Expected manifest v2')
		expect(manifest.source).toMatchObject({
			filename: 'site.3dm',
			bytes: bytes.length,
			format: '3dm',
			sha256: createHash('sha256').update(bytes).digest('hex'),
			units: { name: 'Millimeters', metresPerUnit: 0.001, basis: 'file' },
		})
		expect(manifest.glbSha256).toBe(createHash('sha256').update(glb).digest('hex'))
		expect(manifest.coverage).toEqual({
			sourceObjects: 2,
			renderedObjects: 2,
			skippedObjects: 0,
			hiddenObjects: 0,
			missingFaces: 0,
			fallbackFaces: 0,
		})
		expect(manifest.bounds.min[0]).toBeCloseTo(-0.5, 3)
		expect(manifest.bounds.max[0]).toBeCloseTo(0.5, 3)
		const json = readGlb(glb).json
		expect(json.asset?.extras?.weave?.features.map((feature) => feature.sourceId)).toEqual(ids)
		expect(json.asset?.extras?.weave?.features.map((feature) => feature.userStrings)).toEqual([
			{ discipline: 'architecture' },
			{ discipline: 'architecture' },
		])
		expect(
			json
				.meshes!.flatMap((mesh) => mesh.primitives)
				.every((primitive) => primitive.attributes._BATCHID !== undefined)
		).toBe(true)
		// Repack without compression to inspect the feature IDs after material merging.
		const files = new Map([['in.glb', glb]])
		await pack(['-i', 'in.glb', '-o', 'out.glb', '-noq'], {
			read: (name) => files.get(name)!,
			write: (name, data) => {
				files.set(name, new Uint8Array(data))
			},
		})
		const decoded = readGlb(files.get('out.glb')!)
		const raw = decoded.json as unknown as {
			meshes: { primitives: { attributes: Record<string, number> }[] }[]
			accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number }[]
			bufferViews: { byteOffset?: number; byteStride?: number }[]
		}
		const values = new Set<number>()
		for (const primitive of raw.meshes.flatMap((mesh) => mesh.primitives)) {
			const accessor = raw.accessors[primitive.attributes._BATCHID],
				view = raw.bufferViews[accessor.bufferView]
			const data = new DataView(
				decoded.bin!.buffer,
				decoded.bin!.byteOffset,
				decoded.bin!.byteLength
			)
			for (let i = 0; i < accessor.count; i++)
				values.add(
					data.getFloat32(
						(view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 4),
						true
					)
				)
		}
		expect([...values].sort()).toEqual([0, 1])
	})

	it('meshes a box saved without render caches', async () => {
		const bytes = documentBytes((doc) => {
			const box = rhino.Brep.createFromBoundingBox(
				new rhino.BoundingBox([0, 0, 0], [1000, 2000, 3000])
			)
			const attr = new rhino.ObjectAttributes()
			attr.layerIndex = 0
			doc.objects().addBrep(box, attr)
			release(box)
			release(attr)
		})
		const result = await threedmToScene(bytes, LIMITS)
		expect(result.coverage).toMatchObject({ renderedObjects: 1, missingFaces: 0, fallbackFaces: 6 })
		expect(result.scene.meshes.reduce((count, mesh) => count + mesh.indices.length / 3, 0)).toBe(12)
		expect(result.warnings).toEqual([{ code: 'approximate_mesh', count: 6 }])
	})

	it.each([
		['feet', 'Feet', 0.3048],
		['unitless', 'None', 0.001],
	] as const)('converts %s and records unit assumptions', async (_, unit, scale) => {
		const bytes = documentBytes((doc) => {
			addTriangle(doc, 'Units')
		}, rhino.UnitSystem[unit])
		const result = await threedmToScene(bytes, LIMITS)
		expect(result.transform.scale).toBe(scale)
		expect(result.source.units.basis).toBe(unit === 'None' ? 'assumed' : 'file')
		expect(result.warnings.some((warning) => warning.code === 'units_assumed')).toBe(
			unit === 'None'
		)
	})

	it('skips objects on hidden parent layers', async () => {
		const bytes = documentBytes((doc) => {
			addTriangle(doc, 'Visible')
			const parent = new rhino.Layer()
			parent.name = 'Hidden'
			parent.visible = false
			const parentIndex = doc.layers().add(parent)
			const storedParent = doc.layers().get(parentIndex)
			const child = new rhino.Layer()
			child.name = 'Child'
			child.parentLayerId = storedParent.id
			const index = doc.layers().add(child)
			const mesh = triangle(),
				attr = new rhino.ObjectAttributes()
			attr.layerIndex = index
			doc.objects().addMesh(mesh, attr)
			release(mesh)
			release(attr)
			release(child)
			release(storedParent)
			release(parent)
		})
		const result = await threedmToScene(bytes, LIMITS)
		expect(result.coverage).toMatchObject({ renderedObjects: 1, hiddenObjects: 1 })
	})

	it.each(['sphere', 'cylinder'] as const)(
		'meshes an uncached untrimmed %s and produces finite positions',
		async (kind) => {
			const bytes = documentBytes((doc) => {
				const shape =
					kind === 'sphere'
						? rhino.Brep.createFromSphere(new rhino.Sphere([0, 0, 0], 100))
						: rhino.Brep.createFromCylinder(
								new rhino.Cylinder(new rhino.Circle([0, 0, 0], 100), 200),
								true,
								true
							)
				const attr = new rhino.ObjectAttributes()
				attr.layerIndex = 0
				doc.objects().addBrep(shape, attr)
				release(shape)
				release(attr)
			})
			const result = await threedmToScene(bytes, LIMITS)
			expect(result.coverage).toMatchObject({ renderedObjects: 1, missingFaces: 0 })
			expect(result.coverage.fallbackFaces).toBeGreaterThan(0)
			expect(
				result.scene.meshes.every((mesh) => Array.from(mesh.positions).every(Number.isFinite))
			).toBe(true)
		}
	)

	it('preserves small details far from the origin', async () => {
		const bytes = documentBytes((doc) => {
			const mesh = new rhino.Mesh()
			for (const p of [
				[1e9, 0, 0],
				[1e9 + 0.25, 0, 0],
				[1e9, 0.25, 0],
			])
				mesh.vertices().addPoint3d(p[0], p[1], p[2])
			mesh.faces().addTriFace(0, 1, 2)
			const attr = new rhino.ObjectAttributes()
			attr.layerIndex = 0
			doc.objects().addMesh(mesh, attr)
			release(mesh)
			release(attr)
		}, rhino.UnitSystem.Meters)
		const result = await threedmToScene(bytes, LIMITS)
		expect(Array.from(result.scene.meshes[0].positions)).toEqual([
			-0.125, 0, 0.125, 0.125, 0, 0.125, -0.125, 0, -0.125,
		])
	})

	it('expands nested and mirrored blocks with distinct occurrence IDs and outward winding', async () => {
		const bytes = documentBytes((doc) => {
			const mesh = triangle(),
				attr = new rhino.ObjectAttributes()
			attr.name = 'Block member'
			attr.layerIndex = 0
			const index = doc.instanceDefinitions().add('Inner', '', '', '', [0, 0, 0], [mesh], [attr])
			const inner = doc.instanceDefinitions().get(index)
			const Reference = rhino.InstanceReference as unknown as {
				new (id: string, xform: import('rhino3dm').Transform): import('rhino3dm').InstanceReference
			}
			const identity = new rhino.Transform(1)
			const member = new Reference(inner.id, identity)
			const outerIndex = doc
				.instanceDefinitions()
				.add('Outer', '', '', '', [0, 0, 0], [member], [attr])
			const outer = doc.instanceDefinitions().get(outerIndex)
			const regular = new Reference(outer.id, identity)
			doc.objects().add(regular, attr)
			const mirrored = new rhino.Transform(1)
			mirrored.m00 = -1
			mirrored.m03 = 2000
			const reference = new Reference(outer.id, mirrored)
			doc.objects().add(reference, attr)
			for (const object of [
				reference,
				mirrored,
				regular,
				outer,
				member,
				identity,
				inner,
				mesh,
				attr,
			])
				release(object)
		})
		const result = await threedmToScene(bytes, LIMITS)
		expect(result.scene.weave!.features.map((feature) => feature.instancePath.length)).toEqual([
			2, 2,
		])
		expect(result.scene.weave!.features[0].sourceId).toBe(result.scene.weave!.features[1].sourceId)
		expect(result.scene.weave!.features[0].instancePath).not.toEqual(
			result.scene.weave!.features[1].instancePath
		)
		expect(result.scene.meshes.map((mesh) => Array.from(mesh.batchIds!))).toEqual([
			[0, 0, 0],
			[1, 1, 1],
		])
		for (const mesh of result.scene.meshes) expect(mesh.normals![1]).toBeCloseTo(1)
		await expect(threedmToScene(bytes, { maxTriangles: 1 })).rejects.toMatchObject({
			code: 'too_large',
		})
	})

	it('keeps holes in uncached extrusion caps', async () => {
		const bytes = documentBytes((doc) => {
			const rectangle = (min: number, max: number) =>
				new rhino.PolylineCurve([
					[min, min, 0],
					[max, min, 0],
					[max, max, 0],
					[min, max, 0],
					[min, min, 0],
				])
			const outer = rectangle(0, 100),
				inner = rectangle(40, 60)
			const extrusion = rhino.Extrusion.create(outer, 10, true)
			expect(extrusion.addInnerProfile(inner)).toBe(true)
			const attr = new rhino.ObjectAttributes()
			attr.layerIndex = 0
			doc.objects().add(extrusion, attr)
			for (const object of [attr, extrusion, inner, outer]) release(object)
		})
		const result = await threedmToScene(bytes, LIMITS)
		let capArea = 0
		for (const mesh of result.scene.meshes)
			for (let i = 0; i < mesh.indices.length; i += 3) {
				const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3)).map((index) =>
					Array.from(mesh.positions.subarray(index * 3, index * 3 + 3))
				)
				if (Math.abs(a[1] - b[1]) < 1e-8 && Math.abs(a[1] - c[1]) < 1e-8)
					capArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2
			}
		expect(capArea).toBeCloseTo(0.0192, 6)
		expect(result.coverage.missingFaces).toBe(0)
	})

	it('enforces the triangle budget before packing', async () => {
		const bytes = documentBytes((doc) => {
			addTriangle(doc, 'First')
			addTriangle(doc, 'Second')
		})
		await expect(threedmToScene(bytes, { maxTriangles: 1 })).rejects.toMatchObject({
			code: 'too_large',
		})
	})

	it('ignores curves when it measures coverage', async () => {
		const bytes = documentBytes((doc) => {
			addTriangle(doc, 'Wall')
			const line = new rhino.LineCurve([0, 0, 0], [1000, 0, 0]),
				attributes = new rhino.ObjectAttributes()
			try {
				doc.objects().add(line, attributes)
			} finally {
				release(line)
				release(attributes)
			}
		})
		const { coverage, warnings } = await threedmToScene(bytes, LIMITS)
		expect(coverage).toMatchObject({ sourceObjects: 1, renderedObjects: 1, skippedObjects: 0 })
		// One triangle is all the file holds, which the review flags rather than shows as complete.
		expect(warnings).toEqual([{ code: 'near_empty', count: 1 }])
	})

	it('refuses more objects than the cap', async () => {
		const bytes = documentBytes((doc) => {
			addTriangle(doc, 'First')
			addTriangle(doc, 'Second')
		})
		await expect(threedmToScene(bytes, { ...LIMITS, maxObjects: 1 })).rejects.toMatchObject({
			code: 'too_large',
		})
	})

	it('caps user strings and names', async () => {
		const bytes = documentBytes((doc) => {
			const mesh = triangle(),
				attributes = new rhino.ObjectAttributes()
			try {
				attributes.name = 'n'.repeat(1000)
				attributes.layerIndex = 0
				for (let i = 0; i < 100; i++) attributes.setUserString(`key${i}`, 'v'.repeat(5000))
				doc.objects().addMesh(mesh, attributes)
			} finally {
				release(mesh)
				release(attributes)
			}
		})
		const [feature] = (await threedmToScene(bytes, LIMITS)).scene.weave!.features
		expect(feature.name).toHaveLength(256)
		expect(Object.keys(feature.userStrings)).toHaveLength(64)
		expect(Object.values(feature.userStrings).every((value) => value.length === 2048)).toBe(true)
	})

	it('rejects a document with no supported geometry', async () => {
		const bytes = documentBytes(() => {})
		await expect(threedmToScene(bytes, LIMITS)).rejects.toMatchObject({ code: 'no_render_meshes' })
	})
})
