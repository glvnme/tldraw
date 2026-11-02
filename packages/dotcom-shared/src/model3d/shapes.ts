import {
	RecordProps,
	SchemaPropsInfo,
	TLAssetId,
	TLShape,
	assetIdValidator,
	commentSchemaRecords,
	createShapePropsMigrationIds,
	createShapePropsMigrationSequence,
	createTLSchema,
	defaultShapeSchemas,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'
import { Model3dCamera, model3dCameraValidator } from './camera'

export const MODEL3D_SHAPE_TYPE = 'model3d'
export const MODEL3D_REVISION_SHAPE_TYPE = 'model3d-revision'

export interface Model3dShapeProps {
	w: number
	h: number
	modelId: string
	modelVersion: number
	/** The thumbnail image asset. Named `assetId` so copy, paste and `.tldr` pruning carry it. */
	assetId: TLAssetId | null
	defaultView: Model3dCamera | null
	altText: string
}

export interface Model3dViewport {
	w: number
	h: number
	dpr: number
}

export interface Model3dRevisionShapeProps {
	w: number
	h: number
	modelId: string
	modelVersion: number
	/** The snapshot image asset. */
	assetId: TLAssetId | null
	pose: Model3dCamera
	viewport: Model3dViewport
	name: string
	publishedAt: number | null
	strokeHash: string | null
}

declare module '@tldraw/tlschema' {
	export interface TLGlobalShapePropsMap {
		[MODEL3D_SHAPE_TYPE]: Model3dShapeProps
		[MODEL3D_REVISION_SHAPE_TYPE]: Model3dRevisionShapeProps
	}
}

export type TLModel3dShape = TLShape<typeof MODEL3D_SHAPE_TYPE>
export type TLModel3dRevisionShape = TLShape<typeof MODEL3D_REVISION_SHAPE_TYPE>

export const model3dShapeProps: RecordProps<TLModel3dShape> = {
	w: T.nonZeroNumber,
	h: T.nonZeroNumber,
	modelId: T.string,
	modelVersion: T.nonZeroInteger,
	assetId: assetIdValidator.nullable(),
	defaultView: model3dCameraValidator.nullable(),
	altText: T.string,
}

export const model3dRevisionShapeProps: RecordProps<TLModel3dRevisionShape> = {
	w: T.nonZeroNumber,
	h: T.nonZeroNumber,
	modelId: T.string,
	modelVersion: T.nonZeroInteger,
	assetId: assetIdValidator.nullable(),
	pose: model3dCameraValidator,
	viewport: T.object({ w: T.nonZeroNumber, h: T.nonZeroNumber, dpr: T.nonZeroNumber }),
	name: T.string,
	publishedAt: T.number.nullable(),
	strokeHash: T.string.nullable(),
}

const model3dVersions = createShapePropsMigrationIds(MODEL3D_SHAPE_TYPE, { Initial: 1 })
const model3dRevisionVersions = createShapePropsMigrationIds(MODEL3D_REVISION_SHAPE_TYPE, {
	Initial: 1,
})

// Each sequence opens with an identity migration that has no `down`, so a client whose schema
// predates the shape gets CLIENT_TOO_OLD instead of records it cannot validate (see TLComment.ts).
export const model3dShapeMigrations = createShapePropsMigrationSequence({
	sequence: [{ id: model3dVersions.Initial, up: (props) => props }],
})

export const model3dRevisionShapeMigrations = createShapePropsMigrationSequence({
	sequence: [{ id: model3dRevisionVersions.Initial, up: (props) => props }],
})

export const model3dShapeSchemas = {
	[MODEL3D_SHAPE_TYPE]: { props: model3dShapeProps, migrations: model3dShapeMigrations },
	[MODEL3D_REVISION_SHAPE_TYPE]: {
		props: model3dRevisionShapeProps,
		migrations: model3dRevisionShapeMigrations,
	},
} satisfies Record<string, SchemaPropsInfo>

/** The schema every board document uses. Client and server must both build it from here. */
export function createFileSyncSchema() {
	return createTLSchema({
		shapes: { ...defaultShapeSchemas, ...model3dShapeSchemas },
		records: commentSchemaRecords,
	})
}
