import { MODEL3D_SHAPE_TYPE, Model3dCamera, TLModel3dShape } from '@tldraw/dotcom-shared'
import { AssetRecordType, Editor, createShapeId, createTLStore, defaultShapeUtils } from 'tldraw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Model3dShapeUtil } from './Model3dShapeUtil'
import { captureModel3dThumbnail } from './thumbnail'

const shapeUtils = [...defaultShapeUtils, Model3dShapeUtil]
const id = createShapeId('model')
const oldAsset = AssetRecordType.createId('old')
const pose: Model3dCamera = {
	projection: 'perspective',
	position: [4, 3, 4],
	target: [0, 0, 0],
	up: [0, 1, 0],
	aspect: 2,
	fov: 50,
}
const captureFrame = vi.fn(async () => ({ blob: new Blob(), width: 800, height: 400, dpr: 1 }))
const handle = {
	captureFrame,
	getCamera: () => pose,
}
let editor: Editor
let abort: AbortController

beforeEach(() => {
	editor = new Editor({
		store: createTLStore({ shapeUtils }),
		shapeUtils,
		bindingUtils: [],
		tools: [],
		getContainer: () => document.createElement('div'),
	})
	editor.createShape<TLModel3dShape>({
		id,
		type: MODEL3D_SHAPE_TYPE,
		props: { modelId: 'model-1', assetId: oldAsset },
	})
	abort = new AbortController()
	vi.stubGlobal('createImageBitmap', async () => ({ width: 800, height: 400, close() {} }))
	vi.stubGlobal(
		'OffscreenCanvas',
		class {
			getContext() {
				return { drawImage() {} }
			}
			async convertToBlob() {
				return new Blob(['image'], { type: 'image/webp' })
			}
		}
	)
	vi.spyOn(editor, 'uploadAsset').mockResolvedValue({ src: 'https://example.com/preview.webp' })
})
afterEach(() => {
	editor.dispose()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

it('replaces an existing preview and saves the matching camera together', async () => {
	await captureModel3dThumbnail(editor, id, handle, abort.signal, 'default')
	const props = editor.getShape<TLModel3dShape>(id)!.props
	expect(props.assetId).not.toBe(oldAsset)
	expect(props.defaultView).toEqual(pose)
	expect(editor.getAsset(props.assetId!)?.props.src).toBe('https://example.com/preview.webp')
})

it('keeps the previous camera and preview when upload fails', async () => {
	vi.mocked(editor.uploadAsset).mockRejectedValue(new Error('upload failed'))
	await expect(
		captureModel3dThumbnail(editor, id, handle, abort.signal, 'default')
	).rejects.toThrow('upload failed')
	expect(editor.getShape<TLModel3dShape>(id)!.props).toMatchObject({
		assetId: oldAsset,
		defaultView: null,
	})
})

it('does not publish an upload after the viewer closes', async () => {
	vi.mocked(editor.uploadAsset).mockImplementation(async () => {
		abort.abort()
		return { src: 'https://example.com/preview.webp' }
	})
	await expect(
		captureModel3dThumbnail(editor, id, handle, abort.signal, 'default')
	).rejects.toThrow()
	expect(editor.getShape<TLModel3dShape>(id)!.props).toMatchObject({
		assetId: oldAsset,
		defaultView: null,
	})
})

it('does not overwrite a newer preview while uploading', async () => {
	const newerAsset = AssetRecordType.createId('newer')
	vi.mocked(editor.uploadAsset).mockImplementation(async () => {
		editor.updateShape<TLModel3dShape>({
			id,
			type: MODEL3D_SHAPE_TYPE,
			props: { assetId: newerAsset },
		})
		return { src: 'https://example.com/preview.webp' }
	})
	await expect(
		captureModel3dThumbnail(editor, id, handle, abort.signal, 'default')
	).rejects.toThrow()
	expect(editor.getShape<TLModel3dShape>(id)!.props.assetId).toBe(newerAsset)
})

it('leaves an existing saved view unchanged during automatic preview creation', async () => {
	await captureModel3dThumbnail(editor, id, handle, abort.signal)
	expect(editor.uploadAsset).not.toHaveBeenCalled()
	expect(editor.getShape<TLModel3dShape>(id)!.props).toMatchObject({
		assetId: oldAsset,
		defaultView: null,
	})
})

it('saves a first preview with its camera', async () => {
	editor.updateShape<TLModel3dShape>({ id, type: MODEL3D_SHAPE_TYPE, props: { assetId: null } })
	await captureModel3dThumbnail(editor, id, handle, abort.signal)
	const props = editor.getShape<TLModel3dShape>(id)!.props
	expect(props.defaultView).toEqual(pose)
	expect(editor.getAsset(props.assetId!)?.props.src).toBe('https://example.com/preview.webp')
})
