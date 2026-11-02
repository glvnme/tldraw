import { IfcAPI, LogLevel } from 'web-ifc'
import { ConvertError } from './errors'
import { GlbMesh, GlbNode, GlbScene, Rgba } from './glb'

export interface IfcScene {
	scene: GlbScene
	triangleCount: number
	/** Column-major; web-ifc's translation of the model to the origin, in output (Y-up) axes. */
	coordinationMatrix: number[]
	webIfcVersion: string
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * One mesh per (product, geometry, colour) and one node per placement. The product is part of the
 * key because `_BATCHID` carries the product's express id, so geometry shared between products
 * cannot share a mesh. gltfpack bakes the node matrices and merges by material afterwards.
 *
 * web-ifc's placement matrices already turn IFC's Z-up into glTF's Y-up, so no root rotation.
 */
export async function ifcToScene(
	bytes: Uint8Array,
	options: { maxTriangles: number; onProgress?(fraction: number): void }
): Promise<IfcScene> {
	const api = new IfcAPI()
	await api.Init(undefined, true)
	api.SetLogLevel(LogLevel.LOG_LEVEL_ERROR)
	try {
		const modelId = api.OpenModel(bytes, {
			COORDINATE_TO_ORIGIN: true,
			CIRCLE_SEGMENTS: 12,
			MEMORY_LIMIT: 3 * 1024 ** 3,
			TAPE_SIZE: 64 * 1024 ** 2,
		})
		if (modelId < 0) throw new ConvertError('conversion_failed', 'web-ifc could not open the file')

		const meshes: GlbMesh[] = []
		const nodes: GlbNode[] = []
		const materials: Rgba[] = []
		const materialIndex = new Map<string, number>()
		const meshIndex = new Map<string, number>()
		let triangleCount = 0

		api.StreamAllMeshes(modelId, (mesh, index, total) => {
			const productId = mesh.expressID
			const placements = mesh.geometries
			for (let i = 0; i < placements.size(); i++) {
				const placed = placements.get(i)
				const { x, y, z, w } = placed.color
				const colorKey = `${x},${y},${z},${w}`
				let material = materialIndex.get(colorKey)
				if (material === undefined) {
					material = materials.push([x, y, z, w]) - 1
					materialIndex.set(colorKey, material)
				}

				const key = `${productId}:${placed.geometryExpressID}:${material}`
				let meshId = meshIndex.get(key)
				if (meshId === undefined) {
					const geometry = readGeometry(api, modelId, placed.geometryExpressID, productId, material)
					if (!geometry) continue
					meshId = meshes.push(geometry) - 1
					meshIndex.set(key, meshId)
				}

				triangleCount += meshes[meshId].indices.length / 3
				if (triangleCount > options.maxTriangles) {
					throw new ConvertError('too_large', `IFC has more than ${options.maxTriangles} triangles`)
				}
				const matrix = Array.from(placed.flatTransformation)
				nodes.push({
					mesh: meshId,
					...(matrix.every((v, k) => v === IDENTITY[k]) ? null : { matrix }),
				})
			}
			options.onProgress?.((index + 1) / total)
		})

		const coordinationMatrix = Array.from(api.GetCoordinationMatrix(modelId))
		api.CloseModel(modelId)
		return {
			scene: { meshes, materials, nodes },
			triangleCount,
			coordinationMatrix,
			webIfcVersion: api.GetVersion(),
		}
	} finally {
		api.Dispose()
	}
}

function readGeometry(
	api: IfcAPI,
	modelId: number,
	geometryId: number,
	productId: number,
	material: number
): GlbMesh | null {
	const geometry = api.GetGeometry(modelId, geometryId)
	try {
		// Views into WASM memory: copied out before the geometry is freed.
		const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize())
		const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize())
		if (vertices.length === 0 || indices.length === 0) return null
		// Interleaved position xyz, normal xyz.
		const count = vertices.length / 6
		const positions = new Float32Array(count * 3)
		const normals = new Float32Array(count * 3)
		for (let v = 0; v < count; v++) {
			for (let k = 0; k < 3; k++) {
				positions[v * 3 + k] = vertices[v * 6 + k]
				normals[v * 3 + k] = vertices[v * 6 + 3 + k]
			}
		}
		return {
			positions,
			normals,
			batchIds: new Float32Array(count).fill(productId),
			indices: new Uint32Array(indices),
			material,
		}
	} finally {
		geometry.delete()
	}
}
