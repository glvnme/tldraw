import { MODEL3D_SHAPE_TYPE, TLModel3dShape, model3dPaths } from '@tldraw/dotcom-shared'
import { AssetRecordType, Editor, TLImageAsset, TLShapeId } from 'tldraw'
import { GetModel3dToken, model3dUrl } from './api'
import type { Model3dViewerEngine } from './viewerEngine'

const THUMBNAIL_WIDTH = 512

export async function captureModel3dThumbnail(
	editor: Editor,
	shapeId: TLShapeId,
	handle: Pick<Model3dViewerEngine, 'captureFrame' | 'getCamera'>,
	signal: AbortSignal,
	mode: 'initial' | 'default' = 'initial'
) {
	const shape = editor.getShape<TLModel3dShape>(shapeId)
	if (!shape || shape.type !== MODEL3D_SHAPE_TYPE || (mode === 'initial' && shape.props.assetId))
		return
	if (editor.getIsReadonly()) return

	signal.throwIfAborted()
	const defaultView = handle.getCamera()
	const frame = await handle.captureFrame()
	signal.throwIfAborted()
	const w = THUMBNAIL_WIDTH
	const h = Math.round((w * shape.props.h) / shape.props.w)
	const bitmap = await createImageBitmap(frame.blob)
	const scale = Math.min(w / bitmap.width, h / bitmap.height)
	const canvas = new OffscreenCanvas(w, h)
	canvas
		.getContext('2d')!
		.drawImage(
			bitmap,
			(w - bitmap.width * scale) / 2,
			(h - bitmap.height * scale) / 2,
			bitmap.width * scale,
			bitmap.height * scale
		)
	bitmap.close()
	const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
	const name = `${shape.props.altText || 'model'}-thumbnail.webp`
	const file = new File([blob], name, { type: 'image/webp' })

	const asset: TLImageAsset = AssetRecordType.create({
		id: AssetRecordType.createId(),
		type: 'image',
		props: {
			name,
			src: null,
			w,
			h,
			mimeType: 'image/webp',
			isAnimated: false,
			fileSize: blob.size,
		},
		meta: {},
	}) as TLImageAsset
	const { src, meta } = await editor.uploadAsset(asset, file, signal)
	signal.throwIfAborted()

	editor.run(
		() => {
			// Do not replace a newer save or publish a preview for a replaced model.
			const current = editor.getShape<TLModel3dShape>(shapeId)
			if (
				!current ||
				editor.getIsReadonly() ||
				current.props.modelId !== shape.props.modelId ||
				current.props.modelVersion !== shape.props.modelVersion ||
				current.props.assetId !== shape.props.assetId ||
				JSON.stringify(current.props.defaultView) !== JSON.stringify(shape.props.defaultView)
			)
				throw new Error('The model changed while saving the view. Try again.')
			editor.createAssets([
				{ ...asset, props: { ...asset.props, src }, meta: { ...asset.meta, ...meta } },
			])
			editor.updateShape<TLModel3dShape>({
				id: shapeId,
				type: MODEL3D_SHAPE_TYPE,
				props: { assetId: asset.id, defaultView },
			})
		},
		{ history: 'ignore', ignoreShapeLock: true }
	)
}

// A batch import must not allocate a WebGL context for every model at once.
let previewQueue: Promise<void> = Promise.resolve()

export function prepareModel3dThumbnail(
	editor: Editor,
	shapeId: TLShapeId,
	getToken: GetModel3dToken,
	signal: AbortSignal
) {
	const task = previewQueue.then(async () => {
		if (signal.aborted) return
		const shape = editor.getShape<TLModel3dShape>(shapeId)
		if (!shape || shape.props.assetId || editor.getIsReadonly()) return
		const [{ createModel3dViewerEngine }, token] = await Promise.all([
			import('./viewerEngine'),
			getToken(),
		])
		signal.throwIfAborted()
		const container = document.createElement('div')
		Object.assign(container.style, {
			position: 'fixed',
			left: '-10000px',
			top: '0',
			width: `${THUMBNAIL_WIDTH}px`,
			height: `${Math.round(THUMBNAIL_WIDTH / (shape.props.defaultView?.aspect ?? shape.props.w / shape.props.h))}px`,
			visibility: 'hidden',
			pointerEvents: 'none',
		})
		document.body.appendChild(container)
		let engine: Model3dViewerEngine | undefined
		try {
			engine = await createModel3dViewerEngine({
				container,
				glbUrl: model3dUrl(model3dPaths.glb(shape.props.modelId)),
				token,
				initialCamera: shape.props.defaultView,
				signal,
				onProgress() {},
				onContextLost() {},
			})
			await captureModel3dThumbnail(editor, shapeId, engine, signal)
		} finally {
			engine?.dispose()
			container.remove()
		}
	})
	previewQueue = task.catch(() => {})
	return task
}
