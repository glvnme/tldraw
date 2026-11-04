import { MODEL3D_SHAPE_TYPE, TLModel3dShape, model3dPaths } from '@tldraw/dotcom-shared'
import { AssetRecordType, Editor, TLImageAsset, TLShapeId, Vec } from 'tldraw'
import { GetModel3dToken, model3dUrl } from './api'
import type { Model3dViewerEngine } from './viewerEngine'

const PREVIEW_MAX_SIDE = 1024
const OFFSCREEN_SIZE = 768
// Pixels this faint are antialiasing fringe, not the model.
const ALPHA_THRESHOLD = 8
const PADDING_RATIO = 0.03
// A line-thin model would otherwise become a shape too thin to grab.
const MIN_ASPECT = 1 / 6

export interface PixelRect {
	x: number
	y: number
	w: number
	h: number
}

/** The bounds of the pixels the model covers in an RGBA frame, or null when it covers none. */
export function getOpaqueBounds(
	data: Uint8ClampedArray,
	width: number,
	height: number
): PixelRect | null {
	let minX = width
	let minY = height
	let maxX = -1
	let maxY = -1
	for (let y = 0; y < height; y++) {
		const row = y * width * 4
		for (let x = 0; x < width; x++) {
			if (data[row + x * 4 + 3] <= ALPHA_THRESHOLD) continue
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}
	return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Pads `rect` and widens its short side to `MIN_ASPECT`, staying inside the frame. */
export function padPreviewCrop(rect: PixelRect, width: number, height: number): PixelRect {
	const pad = Math.round(Math.max(rect.w, rect.h) * PADDING_RATIO)
	const minSide = Math.max(rect.w, rect.h) * MIN_ASPECT
	const grow = (start: number, size: number, limit: number) => {
		const target = Math.min(limit, Math.max(size + pad * 2, minSide))
		const from = Math.max(0, Math.min(limit - target, start - (target - size) / 2))
		return [Math.round(from), Math.round(target)] as const
	}
	const [x, w] = grow(rect.x, rect.w, width)
	const [y, h] = grow(rect.y, rect.h, height)
	return { x, y, w, h }
}

/**
 * The page box for a preview of `aspect` that keeps the shape's longest side and center, so the
 * shape stays where it was and hugs the model like an image does.
 */
export function fitModel3dShapeToPreview(
	shape: Pick<TLModel3dShape, 'x' | 'y' | 'rotation'> & { props: { w: number; h: number } },
	aspect: number
) {
	const side = Math.max(shape.props.w, shape.props.h)
	const w = aspect >= 1 ? side : side * aspect
	const h = aspect >= 1 ? side / aspect : side
	const center = Vec.Add(
		shape,
		Vec.Rot({ x: shape.props.w / 2, y: shape.props.h / 2 }, shape.rotation)
	)
	const { x, y } = Vec.Sub(center, Vec.Rot({ x: w / 2, y: h / 2 }, shape.rotation))
	return { x, y, w, h }
}

async function renderPreview(frame: Blob) {
	const bitmap = await createImageBitmap(frame)
	try {
		const source = new OffscreenCanvas(bitmap.width, bitmap.height)
		const sourceCtx = source.getContext('2d', { willReadFrequently: true })!
		sourceCtx.drawImage(bitmap, 0, 0)
		const opaque = getOpaqueBounds(
			sourceCtx.getImageData(0, 0, bitmap.width, bitmap.height).data,
			bitmap.width,
			bitmap.height
		)
		const crop = opaque
			? padPreviewCrop(opaque, bitmap.width, bitmap.height)
			: { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
		const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(crop.w, crop.h))
		const w = Math.max(1, Math.round(crop.w * scale))
		const h = Math.max(1, Math.round(crop.h * scale))
		const canvas = new OffscreenCanvas(w, h)
		canvas.getContext('2d')!.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h)
		// WebP keeps the transparent background around the model.
		return { blob: await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 }), w, h }
	} finally {
		bitmap.close()
	}
}

/**
 * Renders the viewer's current camera into the shape's canvas image and saves that camera as the
 * default view. `initial` only fills a shape that has no image yet; `default` replaces it.
 */
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
	const preview = await renderPreview(frame.blob)
	signal.throwIfAborted()
	// Another tab or the offscreen preview filled it meanwhile.
	const hasNewerPreview = () =>
		mode === 'initial' && !!editor.getShape<TLModel3dShape>(shapeId)?.props.assetId
	if (hasNewerPreview()) return
	const name = `${shape.props.altText || 'model'}-preview.webp`
	const file = new File([preview.blob], name, { type: 'image/webp' })

	const asset: TLImageAsset = AssetRecordType.create({
		id: AssetRecordType.createId(),
		type: 'image',
		props: {
			name,
			src: null,
			w: preview.w,
			h: preview.h,
			mimeType: 'image/webp',
			isAnimated: false,
			fileSize: preview.blob.size,
		},
		meta: {},
	}) as TLImageAsset
	const { src, meta } = await editor.uploadAsset(asset, file, signal)
	signal.throwIfAborted()
	if (hasNewerPreview()) return

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
			const { x, y, w, h } = fitModel3dShapeToPreview(current, preview.w / preview.h)
			editor.updateShape<TLModel3dShape>({
				id: shapeId,
				type: MODEL3D_SHAPE_TYPE,
				x,
				y,
				props: { assetId: asset.id, defaultView, w, h },
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
		// Framed like the saved view, or square so the fitted model is cropped evenly.
		const aspect = shape.props.defaultView?.aspect ?? 1
		const container = document.createElement('div')
		Object.assign(container.style, {
			position: 'fixed',
			left: '-10000px',
			top: '0',
			width: `${aspect >= 1 ? OFFSCREEN_SIZE : Math.round(OFFSCREEN_SIZE * aspect)}px`,
			height: `${aspect >= 1 ? Math.round(OFFSCREEN_SIZE / aspect) : OFFSCREEN_SIZE}px`,
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
