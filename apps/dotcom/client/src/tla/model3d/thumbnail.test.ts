import { MODEL3D_SHAPE_TYPE, Model3dCamera, TLModel3dShape } from '@tldraw/dotcom-shared'
import { AssetRecordType, Editor, createShapeId, createTLStore, defaultShapeUtils } from 'tldraw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Model3dShapeUtil } from './Model3dShapeUtil'
import {
	captureModel3dThumbnail,
	fitModel3dShapeToPreview,
	getOpaqueBounds,
	padPreviewCrop,
} from './thumbnail'

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
const model = { x: 200, y: 100, w: 400, h: 200 }

function frame(width: number, height: number, rect: typeof model, alpha = 255) {
	const data = new Uint8ClampedArray(width * height * 4)
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) data[(y * width + x) * 4 + 3] = alpha
	}
	return data
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
	// The 800x400 frame shows the model in the 400x200 rect at (200, 100).
	vi.stubGlobal(
		'OffscreenCanvas',
		class {
			constructor(
				readonly width: number,
				readonly height: number
			) {}
			getContext() {
				return { drawImage() {}, getImageData: () => ({ data: frame(800, 400, model) }) }
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

it('finds the pixels the model covers and ignores the antialiasing fringe', () => {
	expect(getOpaqueBounds(frame(800, 400, model), 800, 400)).toEqual(model)
	expect(getOpaqueBounds(frame(800, 400, model, 8), 800, 400)).toBeNull()
})

it('pads the crop inside the frame and widens a line-thin model', () => {
	expect(padPreviewCrop(model, 800, 400)).toEqual({ x: 188, y: 88, w: 424, h: 224 })
	expect(padPreviewCrop({ x: 0, y: 199, w: 800, h: 2 }, 800, 400)).toEqual({
		x: 0,
		y: 133,
		w: 800,
		h: 133,
	})
})

it('fits the shape to the preview, keeping its longest side and center', () => {
	const shape = { x: 100, y: 100, rotation: 0, props: { w: 320, h: 240 } }
	expect(fitModel3dShapeToPreview(shape, 2)).toEqual({ x: 100, y: 140, w: 320, h: 160 })
	expect(fitModel3dShapeToPreview(shape, 0.5)).toEqual({ x: 180, y: 60, w: 160, h: 320 })
	const turned = fitModel3dShapeToPreview({ ...shape, rotation: Math.PI / 2 }, 2)
	expect(turned.x).toBeCloseTo(60)
	expect(turned.y).toBeCloseTo(100)
})

it('replaces an existing preview and saves the matching camera together', async () => {
	await captureModel3dThumbnail(editor, id, handle, abort.signal, 'default')
	const shape = editor.getShape<TLModel3dShape>(id)!
	expect(shape.props.assetId).not.toBe(oldAsset)
	expect(shape.props.defaultView).toEqual(pose)
	expect(editor.getAsset(shape.props.assetId!)?.props).toMatchObject({
		src: 'https://example.com/preview.webp',
		w: 424,
		h: 224,
	})
	// The shape hugs the trimmed render, around the same center.
	expect(shape.props.w).toBe(320)
	expect(shape.props.h).toBeCloseTo((320 * 224) / 424)
	expect(shape.y + shape.props.h / 2).toBeCloseTo(120)
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
