import { Model3dVec3 } from './camera'

export type Model3dSourceFormat = '3dm' | 'ifc' | 'glb' | 'obj' | 'stl'

export const MODEL3D_SOURCE_FORMATS: readonly Model3dSourceFormat[] = [
	'3dm',
	'ifc',
	'glb',
	'obj',
	'stl',
]

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

export interface Model3dFeature {
	id: number
	sourceId: string
	sourceIdKind: 'rhino-guid'
	name: string
	type: string
	layerId: string
	instancePath: string[]
	userStrings: Record<string, string>
	meshedBy: 'rhino' | 'weave' | 'mixed'
}

export interface Model3dCoverage {
	sourceObjects: number
	renderedObjects: number
	skippedObjects: number
	hiddenObjects: number
	missingFaces: number
	fallbackFaces: number
}

export interface Model3dSourceReference {
	filename: string
	bytes: number
	sha256: string
	format: Model3dSourceFormat
	formatVersion: string
	authoring: { application: string; details: string }
	document: {
		revision: number
		createdBy: string
		lastEditedBy: string
		createdAt?: string
		modifiedAt?: string
	}
	basePoint: number[]
	georeference?: { latitude: number; longitude: number; elevation: number }
	units: { name: string; metresPerUnit: number; basis: 'file' | 'assumed' }
	counts: {
		objects: number
		rendered: number
		skipped: number
		layers: number
		definitions: number
	}
	provenance: 'service'
}

export interface Model3dManifestV2 extends Omit<Model3dManifestV1, 'version' | 'transform'> {
	version: 2
	transform: Model3dManifestV1['transform'] & {
		/** Column-major matrix from original file coordinates to Y-up metres. */
		sourceToModel: number[]
	}
	source: Model3dSourceReference
	coverage: Model3dCoverage
	warnings: {
		code:
			| 'units_assumed'
			| 'missing_render_mesh'
			| 'approximate_mesh'
			| 'unsupported_entity'
			| 'instance_depth_limit'
			| 'near_empty'
		count: number
	}[]
	features: { count: number; attribute: '_BATCHID'; storage: 'glb-asset-extras' }
	glbSha256: string
}

export type Model3dManifest = Model3dManifestV1 | Model3dManifestV2
