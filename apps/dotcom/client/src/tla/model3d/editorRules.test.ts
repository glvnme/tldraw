import {
	MODEL3D_REVISION_SHAPE_TYPE,
	MODEL3D_SHAPE_TYPE,
	TLModel3dRevisionShape,
	TLModel3dShape,
} from '@tldraw/dotcom-shared'
import { AssetRecordType, Editor, createShapeId, createTLStore, defaultShapeUtils } from 'tldraw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerModel3dEditorRules } from './editorRules'
import { Model3dRevisionShapeUtil } from './Model3dRevisionShapeUtil'
import { Model3dShapeUtil } from './Model3dShapeUtil'

const shapeUtils = [...defaultShapeUtils, Model3dShapeUtil, Model3dRevisionShapeUtil]
const id = createShapeId('model')
const thumbnailId = AssetRecordType.createId('thumbnail')

let editor: Editor

beforeEach(() => {
	editor = new Editor({
		store: createTLStore({ shapeUtils }),
		shapeUtils,
		bindingUtils: [],
		tools: [],
		getContainer: () => document.createElement('div'),
	})
	registerModel3dEditorRules(editor)
})

afterEach(() => {
	editor.dispose()
})

// The same path drop.ts and thumbnail.ts take.
function assign(props: Partial<TLModel3dShape['props']>) {
	editor.run(() => editor.updateShape<TLModel3dShape>({ id, type: MODEL3D_SHAPE_TYPE, props }), {
		history: 'ignore',
		ignoreShapeLock: true,
	})
}

function getProps() {
	return editor.getShape<TLModel3dShape>(id)?.props
}

describe('model3d editor rules', () => {
	it('keeps the model and thumbnail through redo of the creation', () => {
		editor.markHistoryStoppingPoint('drop')
		editor.createShape<TLModel3dShape>({ id, type: MODEL3D_SHAPE_TYPE })
		assign({ modelId: 'model-1' })
		assign({ assetId: thumbnailId })

		editor.undo()
		expect(editor.getShape(id)).toBeUndefined()
		editor.redo()
		expect(getProps()).toMatchObject({ modelId: 'model-1', assetId: thumbnailId })
	})

	it('keeps the model and thumbnail through undo and redo of an older change', () => {
		editor.createShape<TLModel3dShape>({ id, type: MODEL3D_SHAPE_TYPE })
		editor.markHistoryStoppingPoint('move')
		editor.updateShape({ id, type: MODEL3D_SHAPE_TYPE, x: 100 })
		assign({ modelId: 'model-1', assetId: thumbnailId })

		editor.undo()
		expect(editor.getShape(id)!.x).toBe(0)
		expect(getProps()).toMatchObject({ modelId: 'model-1', assetId: thumbnailId })
		editor.redo()
		expect(editor.getShape(id)!.x).toBe(100)
		expect(getProps()).toMatchObject({ modelId: 'model-1', assetId: thumbnailId })
	})

	it('keeps a revision snapshot through undo and redo of an older change', () => {
		const revisionId = createShapeId('revision')
		editor.createShape<TLModel3dRevisionShape>({
			id: revisionId,
			type: MODEL3D_REVISION_SHAPE_TYPE,
		})
		editor.markHistoryStoppingPoint('rename')
		editor.updateShape<TLModel3dRevisionShape>({
			id: revisionId,
			type: MODEL3D_REVISION_SHAPE_TYPE,
			props: { name: 'View 1' },
		})
		editor.run(
			() =>
				editor.updateShape<TLModel3dRevisionShape>({
					id: revisionId,
					type: MODEL3D_REVISION_SHAPE_TYPE,
					props: { assetId: thumbnailId },
				}),
			{ history: 'ignore' }
		)

		editor.undo()
		expect(editor.getShape<TLModel3dRevisionShape>(revisionId)!.props).toMatchObject({
			name: '',
			assetId: thumbnailId,
		})
	})

	it('still lets other props change and undo normally', () => {
		editor.createShape<TLModel3dShape>({ id, type: MODEL3D_SHAPE_TYPE })
		assign({ modelId: 'model-1' })
		editor.markHistoryStoppingPoint('rename')
		editor.updateShape<TLModel3dShape>({ id, type: MODEL3D_SHAPE_TYPE, props: { altText: 'a' } })
		editor.undo()
		expect(getProps()).toMatchObject({ modelId: 'model-1', altText: '' })
	})
})
