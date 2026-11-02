import { MODEL3D_SHAPE_TYPE, TLModel3dShape, ViewerHandle } from '@tldraw/dotcom-shared'
import { AssetRecordType, Editor, TLImageAsset, TLShapeId } from 'tldraw'

const THUMBNAIL_WIDTH = 512

/**
 * Captures the open viewer, crops it to the shape's aspect ratio and stores it as the shape's image asset.
 * `signal` aborts on context loss, which can blank the frame; a frame captured after that is dropped.
 */
export async function captureModel3dThumbnail(
	editor: Editor,
	shapeId: TLShapeId,
	handle: ViewerHandle,
	signal: AbortSignal
) {
	const shape = editor.getShape<TLModel3dShape>(shapeId)
	if (!shape || shape.type !== MODEL3D_SHAPE_TYPE || shape.props.assetId) return
	if (editor.getIsReadonly()) return

	const frame = await handle.captureFrame()
	signal.throwIfAborted()
	const w = THUMBNAIL_WIDTH
	const h = Math.round((w * shape.props.h) / shape.props.w)
	const bitmap = await createImageBitmap(frame.blob)
	const scale = Math.max(w / bitmap.width, h / bitmap.height)
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
	const { src, meta } = await editor.uploadAsset(asset, file)

	editor.run(
		() => {
			// Another client or a second open may have won while this one uploaded.
			const current = editor.getShape<TLModel3dShape>(shapeId)
			if (!current || current.props.assetId) return
			editor.createAssets([
				{ ...asset, props: { ...asset.props, src }, meta: { ...asset.meta, ...meta } },
			])
			editor.updateShape<TLModel3dShape>({
				id: shapeId,
				type: MODEL3D_SHAPE_TYPE,
				props: { assetId: asset.id },
			})
		},
		{ history: 'ignore', ignoreShapeLock: true }
	)
}
