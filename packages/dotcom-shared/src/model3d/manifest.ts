import { Model3dVec3 } from './camera'

export type Model3dSourceFormat = 'ifc' | 'glb' | 'obj' | 'stl'

export const MODEL3D_SOURCE_FORMATS: readonly Model3dSourceFormat[] = ['ifc', 'glb', 'obj', 'stl']

export interface Model3dManifestMesh {
	name: string
	triangleCount: number
}

/** Written by the converter next to `model.glb`. Bounds are in the converted (recentred) space. */
export interface Model3dManifestV1 {
	version: 1
	bounds: { min: Model3dVec3; max: Model3dVec3 }
	units: 'm' | 'mm' | 'cm' | 'in' | 'ft' | 'unknown'
	transform: {
		/** Subtracted from source coordinates to bring the model near the origin. */
		recentreOffset: Model3dVec3
		scale: number
		/** The source up axis; the GLB is always Y-up. */
		upAxis: 'y' | 'z'
	}
	triangleCount: number
	nodeCount: number
	meshes: Model3dManifestMesh[]
	textureBytesEstimate: number
	glbBytes: number
	converter: { name: string; version: string; args: string[] }
	sourceFormat: Model3dSourceFormat
}

export type Model3dManifest = Model3dManifestV1
