import type { Model3dCoverage, Model3dFeature, Model3dManifestV2 } from '@tldraw/dotcom-shared'
import rhino3dm, {
	Brep,
	Extrusion,
	GeometryBase,
	Mesh,
	ObjectAttributes,
	SubD,
	Surface,
	MeshType,
} from 'rhino3dm'
import { ConvertError } from './errors'
import { GlbScene, Rgba } from './glb'
import {
	createEdgeSampler,
	cross,
	meshRhinoFace,
	meshRhinoSurface,
	release,
	RhinoMeshData,
	subtract,
} from './rhinoMesher'

let runtime: ReturnType<typeof rhino3dm> | undefined
export function loadRhino() {
	return (runtime ??= rhino3dm())
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const UNIT_SCALE: Record<string, number> = {
	Angstroms: 1e-10,
	Nanometers: 1e-9,
	Microns: 1e-6,
	Millimeters: 1e-3,
	Centimeters: 1e-2,
	Decimeters: 0.1,
	Meters: 1,
	Dekameters: 10,
	Hectometers: 100,
	Kilometers: 1e3,
	Megameters: 1e6,
	Microinches: 2.54e-8,
	Mils: 2.54e-5,
	Inches: 0.0254,
	Feet: 0.3048,
	Yards: 0.9144,
	Miles: 1609.344,
	PrinterPoints: 0.0254 / 72,
	PrinterPicas: 0.0254 / 6,
	NauticalMiles: 1852,
	AstronomicalUnits: 149597870700,
	LightYears: 9460730472580800,
	Parsecs: 30856775814913670,
}
function enumName(values: object, value: unknown) {
	return Object.entries(values).find(([, entry]) => entry === value)?.[0] ?? 'Unknown'
}
function multiply(a: number[], b: number[]) {
	const out = Array<number>(16).fill(0)
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++)
			for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
	return out
}
const determinant = (m: number[]) =>
	m[0] * (m[5] * m[10] - m[9] * m[6]) -
	m[4] * (m[1] * m[10] - m[9] * m[2]) +
	m[8] * (m[1] * m[6] - m[5] * m[2])

export interface RhinoScene {
	scene: GlbScene
	transform: Model3dManifestV2['transform']
	source: Omit<Model3dManifestV2['source'], 'filename' | 'bytes' | 'sha256'>
	coverage: Model3dCoverage
	warnings: Model3dManifestV2['warnings']
}

export async function threedmToScene(
	bytes: Uint8Array,
	options: { maxTriangles: number; onProgress?(fraction: number): void }
): Promise<RhinoScene> {
	if (!new TextDecoder().decode(bytes.subarray(0, 24)).startsWith('3D Geometry File Format ')) {
		throw new ConvertError('unsupported_format', 'The file has no 3DM header')
	}
	const rhino = await loadRhino()
	const doc = rhino.File3dm.fromByteArray(bytes)
	if (!doc) throw new ConvertError('unsupported_format', 'Cannot read this 3DM archive')
	const owned: unknown[] = []
	try {
		const settings = doc.settings()
		owned.push(settings)
		const earth = settings.earthAnchorPoint
		owned.push(earth)
		const unitName = enumName(rhino.UnitSystem, settings.modelUnitSystem)
		const knownScale = UNIT_SCALE[unitName]
		const scale = knownScale ?? 0.001
		const tolerance = Math.max(
			1e-7,
			Number.isFinite(settings.modelAbsoluteTolerance) ? settings.modelAbsoluteTolerance : 0.01
		)
		const layers = Array.from({ length: doc.layers().count }, (_, i) => doc.layers().get(i))
		const materials = Array.from({ length: doc.materials().count }, (_, i) =>
			doc.materials().get(i)
		)
		const definitions = Array.from({ length: doc.instanceDefinitions().count }, (_, i) =>
			doc.instanceDefinitions().get(i)
		)
		owned.push(...layers, ...materials, ...definitions)
		const layerById = new Map(layers.map((layer) => [layer.id, layer]))
		const layerByIndex = new Map(layers.map((layer) => [layer.index, layer]))
		const materialByIndex = new Map(materials.map((material, index) => [index, material]))
		const definitionById = new Map(definitions.map((definition) => [definition.id, definition]))
		const table = doc.objects()
		const entries = Array.from({ length: table.count }, (_, i) => {
			const object = table.get(i),
				geometry = object.geometry(),
				attributes = object.attributes()
			owned.push(object, geometry, attributes)
			return { geometry, attributes }
		})
		const byId = new Map(entries.map((entry) => [entry.attributes.id, entry]))
		const coverage: Model3dCoverage = {
			sourceObjects: 0,
			renderedObjects: 0,
			skippedObjects: 0,
			hiddenObjects: 0,
			missingFaces: 0,
			fallbackFaces: 0,
		}
		const warnings: RhinoScene['warnings'] = []
		const features: Model3dFeature[] = []
		const leaves: { mesh: RhinoMeshData; color: Rgba; feature: number }[] = []
		let triangles = 0,
			visits = 0,
			depthSkipped = 0
		const min = [Infinity, Infinity, Infinity],
			max = [-Infinity, -Infinity, -Infinity]
		function visible(attributes: ObjectAttributes) {
			if (!attributes.visible || attributes.mode === rhino.ObjectMode.Hidden) return false
			let layer = layerByIndex.get(attributes.layerIndex)
			const seen = new Set<string>()
			while (layer) {
				if (!layer.visible || seen.has(layer.id)) return false
				seen.add(layer.id)
				layer = layerById.get(layer.parentLayerId)
			}
			return true
		}
		function color(attributes: ObjectAttributes, parent?: Rgba): Rgba {
			const layer = layerByIndex.get(attributes.layerIndex)
			const rgba = (value: unknown, alpha = 1): Rgba => {
				const c = value as { r: number; g: number; b: number }
				return [c.r / 255, c.g / 255, c.b / 255, alpha]
			}
			if (attributes.materialSource === rhino.ObjectMaterialSource.MaterialFromParent && parent)
				return parent
			const material = materialByIndex.get(
				attributes.materialSource === rhino.ObjectMaterialSource.MaterialFromObject
					? attributes.materialIndex
					: (layer?.renderMaterialIndex ?? -1)
			)
			if (material) return rgba(material.diffuseColor, 1 - material.transparency)
			if (attributes.colorSource === rhino.ObjectColorSource.ColorFromObject)
				return rgba(attributes.objectColor)
			if (attributes.colorSource === rhino.ObjectColorSource.ColorFromParent && parent)
				return parent
			return layer ? rgba(layer.color) : [0.7, 0.7, 0.7, 1]
		}
		function meshData(mesh: Mesh | null): RhinoMeshData | null {
			if (!mesh) return null
			const vertices = mesh.vertices(),
				faces = mesh.faces()
			const triangleCount = faces.triangleCount + 2 * faces.quadCount
			if (!vertices.count || !triangleCount) return null
			if (triangleCount > options.maxTriangles - triangles)
				throw new ConvertError('too_large', '3DM triangle limit exceeded')
			// toThreejsBuffers casts to float32 before recentering and loses small details at large coordinates.
			const positions = vertices.toPoint3dArray().flat()
			const indices: number[] = []
			for (let i = 0; i < faces.count; i++) {
				const [a, b, c, d] = faces.get(i)
				indices.push(a, b, c)
				if (c !== d) indices.push(a, c, d)
			}
			return { positions, indices }
		}
		function cached(owner: { getMesh(type: MeshType): Mesh }) {
			const mesh = owner.getMesh(rhino.MeshType.Any)
			try {
				return meshData(mesh)
			} finally {
				release(mesh)
			}
		}
		function extract(geometry: GeometryBase): {
			meshes: RhinoMeshData[]
			fallback: boolean
			cached: boolean
		} {
			const meshes: RhinoMeshData[] = []
			let fallback = false,
				fromCache = false
			const type = geometry.objectType
			if (type === rhino.ObjectType.Mesh) {
				const mesh = meshData(geometry as Mesh)
				if (mesh) meshes.push(mesh)
				fromCache = true
			} else if (type === rhino.ObjectType.Brep || type === rhino.ObjectType.Extrusion) {
				if (type === rhino.ObjectType.Extrusion) {
					const mesh = cached(geometry as Extrusion)
					if (mesh) return { meshes: [mesh], fallback: false, cached: true }
				}
				const brep =
					type === rhino.ObjectType.Extrusion
						? (geometry as Extrusion).toBrep(true)
						: (geometry as Brep)
				if (!brep) {
					coverage.missingFaces++
					return { meshes, fallback, cached: fromCache }
				}
				try {
					const faces = brep.faces(),
						sample = createEdgeSampler(brep, tolerance)
					let faceTriangles = 0
					for (let i = 0; i < faces.count; i++) {
						const face = faces.get(i)
						try {
							let mesh = cached(face)
							if (mesh) fromCache = true
							else {
								mesh = meshRhinoFace(face, sample, tolerance)
								if (mesh?.indices.length) {
									fallback = true
									coverage.fallbackFaces++
								} else {
									coverage.missingFaces++
									continue
								}
							}
							faceTriangles += mesh.indices.length / 3
							if (faceTriangles > options.maxTriangles - triangles)
								throw new ConvertError('too_large', '3DM triangle limit exceeded')
							meshes.push(mesh)
						} finally {
							release(face)
						}
					}
				} finally {
					if (brep !== geometry) release(brep)
				}
			} else if (type === rhino.ObjectType.SubD) {
				// These two bindings require arguments absent from the package declarations.
				const subd = geometry.duplicate() as SubD
				try {
					;(subd.subdivide as unknown as (levels: number) => void)(3)
					const mesh = (
						rhino.Mesh.createFromSubDControlNet as unknown as (
							value: SubD,
							includeTexture: boolean
						) => Mesh
					)(subd, false)
					try {
						const data = meshData(mesh)
						if (data) meshes.push(data)
					} finally {
						release(mesh)
					}
					fallback = true
				} finally {
					release(subd)
				}
			} else if (geometry instanceof rhino.Surface) {
				meshes.push(meshRhinoSurface(geometry as Surface))
				fallback = true
				coverage.fallbackFaces++
			}
			return { meshes, fallback, cached: fromCache }
		}
		function emit(
			entry: (typeof entries)[number],
			world: number[],
			path: string[],
			parentColor?: Rgba
		) {
			if (++visits > 1_000_000)
				throw new ConvertError('too_large', '3DM instance expansion limit exceeded')
			const { geometry, attributes } = entry
			if (!visible(attributes)) {
				coverage.hiddenObjects++
				return
			}
			const rgba = color(attributes, parentColor)
			if (geometry.objectType === rhino.ObjectType.InstanceReference) {
				if (path.length >= 16 || path.includes(attributes.id)) {
					depthSkipped++
					return
				}
				const reference = geometry as import('rhino3dm').InstanceReference
				const definition = definitionById.get(reference.parentIdefId)
				if (!definition) {
					coverage.skippedObjects++
					return
				}
				const xform = reference.xform
				let matrix: number[]
				try {
					// toFloatArray loses sub-unit translations far from the origin.
					const values = Array.from(
						{ length: 16 },
						(_, i) => (xform as unknown as Record<string, number>)[`m${i % 4}${Math.floor(i / 4)}`]
					)
					matrix = multiply(world, values)
				} finally {
					release(xform)
				}
				for (const id of definition.getObjectIds() as string[]) {
					const member = byId.get(id)
					if (member) emit(member, matrix, [...path, attributes.id], rgba)
				}
				return
			}
			coverage.sourceObjects++
			const extracted = extract(geometry)
			if (!extracted.meshes.length) {
				coverage.skippedObjects++
				return
			}
			const feature = features.length
			const userStrings = Object.fromEntries(
				attributes.getUserStrings() as unknown as [string, string][]
			)
			delete userStrings['$block-instance-original-object-id$']
			features.push({
				id: feature,
				sourceId: attributes.id,
				sourceIdKind: 'rhino-guid',
				name: attributes.name,
				type: geometry.constructor.name,
				layerId: layerByIndex.get(attributes.layerIndex)?.id ?? '',
				instancePath: path,
				userStrings,
				meshedBy: extracted.fallback ? (extracted.cached ? 'mixed' : 'weave') : 'rhino',
			})
			for (const mesh of extracted.meshes) {
				triangles += mesh.indices.length / 3
				if (triangles > options.maxTriangles)
					throw new ConvertError('too_large', '3DM triangle limit exceeded')
				for (let i = 0; i < mesh.positions.length; i += 3) {
					const [x, y, z] = mesh.positions.slice(i, i + 3)
					for (let k = 0; k < 3; k++) {
						const v = world[k] * x + world[4 + k] * y + world[8 + k] * z + world[12 + k]
						if (!Number.isFinite(v))
							throw new ConvertError('conversion_failed', '3DM has invalid coordinates')
						mesh.positions[i + k] = v
						min[k] = Math.min(min[k], v)
						max[k] = Math.max(max[k], v)
					}
				}
				if (determinant(world) < 0)
					for (let i = 0; i < mesh.indices.length; i += 3)
						[mesh.indices[i + 1], mesh.indices[i + 2]] = [mesh.indices[i + 2], mesh.indices[i + 1]]
				leaves.push({ mesh, color: rgba, feature })
			}
			coverage.renderedObjects++
		}
		entries.forEach((entry, i) => {
			if (!entry.attributes.isInstanceDefinitionObject) emit(entry, IDENTITY, [])
			options.onProgress?.((i + 1) / entries.length)
		})
		if (!triangles)
			throw new ConvertError(
				'no_render_meshes',
				'No 3DM faces could be converted. Save in Rhino with a Shaded viewport, or export GLB, OBJ, or STL.'
			)
		const offset = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]] as [
			number,
			number,
			number,
		]
		const palette: Rgba[] = [],
			paletteIds = new Map<string, number>()
		const meshes = leaves.map(({ mesh, color, feature }) => {
			const positions = new Float32Array(mesh.positions.length)
			for (let i = 0; i < positions.length; i += 3) {
				positions[i] = (mesh.positions[i] - offset[0]) * scale
				positions[i + 1] = (mesh.positions[i + 2] - offset[2]) * scale
				positions[i + 2] = -(mesh.positions[i + 1] - offset[1]) * scale
			}
			const key = color.join(',')
			let material = paletteIds.get(key)
			if (material === undefined) {
				material = palette.push(color) - 1
				paletteIds.set(key, material)
			}
			return {
				positions,
				indices: new Uint32Array(mesh.indices),
				normals: indexedNormals(positions, mesh.indices),
				batchIds: new Float32Array(positions.length / 3).fill(feature),
				material,
			}
		})
		if (knownScale === undefined) warnings.push({ code: 'units_assumed', count: 1 })
		if (coverage.missingFaces)
			warnings.push({ code: 'missing_render_mesh', count: coverage.missingFaces })
		if (coverage.fallbackFaces)
			warnings.push({ code: 'approximate_mesh', count: coverage.fallbackFaces })
		if (coverage.skippedObjects)
			warnings.push({ code: 'unsupported_entity', count: coverage.skippedObjects })
		if (depthSkipped) warnings.push({ code: 'instance_depth_limit', count: depthSkipped })
		return {
			scene: {
				meshes,
				materials: palette,
				nodes: meshes.map((_, i) => ({ mesh: i })),
				weave: {
					features,
					layers: layers.map((layer) => ({
						id: layer.id,
						name: layer.fullPath,
						parentId: layer.parentLayerId,
					})),
				},
			},
			transform: {
				recentreOffset: offset,
				scale,
				upAxis: 'z',
				sourceToModel: [
					scale,
					0,
					0,
					0,
					0,
					0,
					-scale,
					0,
					0,
					scale,
					0,
					0,
					-offset[0] * scale,
					-offset[2] * scale,
					offset[1] * scale,
					1,
				],
			},
			source: {
				format: '3dm',
				formatVersion: String(doc.archiveVersion),
				authoring: { application: doc.applicationName, details: doc.applicationDetails },
				document: {
					revision: doc.revision,
					createdBy: doc.createdBy,
					lastEditedBy: doc.lastEditedBy,
					createdAt: isoDate(doc.created),
					modifiedAt: isoDate(doc.lastEdited),
				},
				basePoint: settings.modelBasePoint,
				...(earth.earthLocationIsSet()
					? {
							georeference: {
								latitude: earth.earthBasepointLatitude,
								longitude: earth.earthBasepointLongitude,
								elevation: earth.earthBasepointElevation,
							},
						}
					: {}),
				units: {
					name: unitName,
					metresPerUnit: scale,
					basis: knownScale === undefined ? 'assumed' : 'file',
				},
				counts: {
					objects: table.count,
					rendered: coverage.renderedObjects,
					skipped: coverage.skippedObjects,
					layers: layers.length,
					definitions: definitions.length,
				},
				provenance: 'service',
			},
			coverage,
			warnings,
		}
	} finally {
		for (const object of owned.reverse()) release(object)
		release(doc)
	}
}

function indexedNormals(positions: Float32Array, indices: number[]) {
	const normals = new Float32Array(positions.length)
	for (let i = 0; i < indices.length; i += 3) {
		const triangle = indices.slice(i, i + 3)
		if (
			triangle.some(
				(index) => !Number.isInteger(index) || index < 0 || index * 3 >= positions.length
			)
		)
			throw new ConvertError('conversion_failed', '3DM has invalid mesh indices')
		const [a, b, c] = triangle.map((index) =>
			Array.from(positions.subarray(index * 3, index * 3 + 3))
		)
		const normal = cross(subtract(b, a), subtract(c, a))
		for (const index of triangle) for (let k = 0; k < 3; k++) normals[index * 3 + k] += normal[k]
	}
	for (let i = 0; i < normals.length; i += 3) {
		const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
		for (let k = 0; k < 3; k++) normals[i + k] /= length
	}
	return normals
}

function isoDate(value: Date) {
	return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined
}
