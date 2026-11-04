import { MODEL3D_SHAPE_TYPE, TLModel3dShape } from '@tldraw/dotcom-shared'
import { useCallback } from 'react'
import {
	Box,
	createShapeId,
	Editor,
	TLShapeId,
	TLUiToastsContextType,
	useEditor,
	useToasts,
	useTranslation,
	VecLike,
} from 'tldraw'
import { useMaybeApp } from '../hooks/useAppState'
import { useCurrentFileId } from '../hooks/useCurrentFileId'
import { GetModel3dToken } from './api'
import { model3dMessages as messages } from './messages'
import { getModel3dFormat, MODEL3D_MAX_SOURCE_BYTES, startModel3dUpload } from './upload'
import { useModel3dGetToken } from './useModel3dGetToken'

const SHAPE_W = 320
const SHAPE_H = 240
const GAP = 20

export function isModel3dFile(file: File) {
	return getModel3dFormat(file.name) !== null
}

/**
 * Creates a `model3d` shape per file at the drop point right away, selects them and uploads in the
 * background. Returns the created ids.
 */
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
	const ids: TLShapeId[] = []
	if (editor.getIsReadonly()) return ids
	if (!fileId) {
		toasts.addToast({
			severity: 'warning',
			title: msg(messages.needsWorkspace),
			description: msg(messages.needsWorkspaceDescription),
		})
		return ids
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
	if (accepted.length === 0) return ids

	const totalW = accepted.length * SHAPE_W + (accepted.length - 1) * GAP
	const origin = opts.point
		? { x: opts.point.x - totalW / 2, y: opts.point.y - SHAPE_H / 2 }
		: findFreeRow(editor, totalW)
	editor.markHistoryStoppingPoint('add 3d models')
	accepted.forEach((file, i) => {
		const id = createShapeId()
		ids.push(id)
		editor.createShape<TLModel3dShape>({
			id,
			type: MODEL3D_SHAPE_TYPE,
			x: origin.x + i * (SHAPE_W + GAP),
			y: origin.y,
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
	editor.select(...ids)
	if (!opts.point) editor.zoomToSelectionIfOffscreen(GAP * 4)
	return ids
}

/**
 * Without a drop point the models go at the viewport center, stepped right past anything already
 * there, so a second upload does not land on the first.
 */
function findFreeRow(editor: Editor, width: number) {
	const center = editor.getViewportPageBounds().center
	const taken = [...editor.getCurrentPageShapeIds()].flatMap(
		(id) => editor.getShapePageBounds(id) ?? []
	)
	const row = new Box(center.x - width / 2, center.y - SHAPE_H / 2, width, SHAPE_H)
	for (let i = 0; i < 50 && taken.some((bounds) => Box.Collides(bounds, row)); i++) {
		row.x += width + GAP
	}
	return row.point
}

/** Binds `addModel3dFiles` to the open board, for the file drop handler and the upload button. */
export function useAddModel3dFiles() {
	const editor = useEditor()
	const app = useMaybeApp()
	const fileId = useCurrentFileId()
	const getToken = useModel3dGetToken()
	const toasts = useToasts()
	const msg = useTranslation()
	return useCallback(
		(files: File[], point?: VecLike) =>
			addModel3dFiles(editor, files, {
				point,
				fileId: fileId && app?.getFile(fileId)?.owningGroupId ? fileId : null,
				getToken,
				toasts,
				msg,
			}),
		[editor, app, fileId, getToken, toasts, msg]
	)
}
