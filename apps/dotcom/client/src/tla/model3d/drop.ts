import { MODEL3D_SHAPE_TYPE, TLModel3dShape } from '@tldraw/dotcom-shared'
import { createShapeId, Editor, TLUiToastsContextType, useTranslation, VecLike } from 'tldraw'
import { GetModel3dToken } from './api'
import { model3dMessages as messages } from './messages'
import { getModel3dFormat, MODEL3D_MAX_SOURCE_BYTES, startModel3dUpload } from './upload'

const SHAPE_W = 320
const SHAPE_H = 240
const GAP = 20

export function isModel3dFile(file: File) {
	return getModel3dFormat(file.name) !== null
}

/** Creates a `model3d` shape per file at the drop point right away and uploads in the background. */
export function addModel3dFiles(
	editor: Editor,
	files: File[],
	opts: {
		point: VecLike | undefined
		/** Null when the board has no workspace to own the model. */
		fileId: string | null
		getToken: GetModel3dToken
		toasts: TLUiToastsContextType
		msg: ReturnType<typeof useTranslation>
	}
) {
	const { fileId, toasts, msg } = opts
	if (!fileId) {
		toasts.addToast({
			severity: 'warning',
			title: msg(messages.needsWorkspace),
			description: msg(messages.needsWorkspaceDescription),
		})
		return
	}

	const accepted = files.filter((file) => {
		if (file.size > 0 && file.size <= MODEL3D_MAX_SOURCE_BYTES) return true
		toasts.addToast({
			severity: 'warning',
			title: msg(messages.cantAdd, { name: file.name }),
			description: msg(file.size ? messages.tooLarge : messages.empty),
		})
		return false
	})
	if (accepted.length === 0) return

	const center = opts.point ?? editor.getViewportPageBounds().center
	const totalW = accepted.length * SHAPE_W + (accepted.length - 1) * GAP
	editor.markHistoryStoppingPoint('add 3d models')
	accepted.forEach((file, i) => {
		const id = createShapeId()
		editor.createShape<TLModel3dShape>({
			id,
			type: MODEL3D_SHAPE_TYPE,
			x: center.x - totalW / 2 + i * (SHAPE_W + GAP),
			y: center.y - SHAPE_H / 2,
			props: { w: SHAPE_W, h: SHAPE_H, altText: file.name },
		})
		startModel3dUpload(id, {
			file,
			format: getModel3dFormat(file.name)!,
			fileId,
			getToken: opts.getToken,
			onCreated: (modelId) => {
				if (!editor.getShape(id)) return
				editor.run(
					() =>
						editor.updateShape<TLModel3dShape>({
							id,
							type: MODEL3D_SHAPE_TYPE,
							props: { modelId },
						}),
					{ history: 'ignore', ignoreShapeLock: true }
				)
			},
		})
	})
}
