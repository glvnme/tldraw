import { createShapeId, createTLSchema, TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { Model3dCamera } from './camera'
import { createFileSyncSchema } from './shapes'

const camera: Model3dCamera = {
	projection: 'perspective',
	position: [10, 10, 10],
	target: [0, 0, 0],
	up: [0, 1, 0],
	fov: 50,
	aspect: 1.5,
}

function shape(type: string, props: object) {
	return {
		id: createShapeId('a'),
		typeName: 'shape',
		type,
		x: 0,
		y: 0,
		rotation: 0,
		index: 'a1',
		parentId: 'page:page',
		isLocked: false,
		opacity: 1,
		props,
		meta: {},
	} as unknown as TLRecord
}

const model3d = shape('model3d', {
	w: 320,
	h: 240,
	modelId: 'model-1',
	modelVersion: 1,
	assetId: null,
	defaultView: camera,
	altText: 'Tower',
})

const revision = shape('model3d-revision', {
	w: 1280,
	h: 720,
	modelId: 'model-1',
	modelVersion: 1,
	assetId: 'asset:snapshot',
	pose: {
		projection: 'orthographic',
		position: [0, 50, 0],
		target: [0, 0, 0],
		up: [0, 0, -1],
		viewHeight: 20,
		aspect: 16 / 9,
	},
	viewport: { w: 1280, h: 720, dpr: 2 },
	name: 'Revision 1',
	publishedAt: null,
	strokeHash: null,
})

describe('createFileSyncSchema', () => {
	const schema = createFileSyncSchema()

	it('validates both shapes', () => {
		for (const record of [model3d, revision]) {
			expect(schema.validateRecord(null as any, record, 'createRecord', null)).toEqual(record)
		}
	})

	it('rejects bad props', () => {
		const bad = shape('model3d', {
			...(model3d as any).props,
			defaultView: { ...camera, up: [0, 1] },
		})
		expect(() => schema.validateRecord(null as any, bad, 'createRecord', null)).toThrow()
	})

	it('serializes the shape sequences and the comment records', () => {
		const { sequences } = schema.serialize()
		expect(sequences['com.tldraw.shape.model3d']).toBe(1)
		expect(sequences['com.tldraw.shape.model3d-revision']).toBe(1)
		expect(sequences['com.tldraw.comment']).toBe(1)
	})

	it('migrates records up from a schema that predates the shapes', () => {
		const old = createTLSchema().serialize()
		for (const record of [model3d, revision]) {
			expect(schema.migratePersistedRecord(record, old, 'up')).toEqual({
				type: 'success',
				value: record,
			})
		}
	})

	it('refuses to migrate down to a schema that predates the shapes', () => {
		const old = createTLSchema().serialize()
		expect(schema.migratePersistedRecord(model3d, old, 'down')).toMatchObject({ type: 'error' })
	})
})
