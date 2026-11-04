import type { ViewerHandle } from '@tldraw/dotcom-shared'
import { CSSProperties, useEffect, useState } from 'react'
import { TldrawUiButton, TldrawUiButtonLabel, useEditor, useTranslation, useValue } from 'tldraw'
import { Model3dRevisionEditBadge } from '../Model3dRevisionShapeUtil'
import { isCameraAtPose } from './cameraMatch'
import { Model3dRect, letterbox } from './layout'
import { revisionMessages as messages } from './messages'
import { getModel3dRevisionOverlayKey, getModel3dRevisionOverlayUrl } from './overlayImage'
import {
	getModel3dRevision,
	getModel3dRevisionView,
	getModel3dRevisions,
	showModel3dRevision,
} from './state'
import styles from './revisions.module.css'

function useShownRevision(modelId: string) {
	const editor = useEditor()
	return useValue(
		'model3d shown revision',
		() => {
			const view = getModel3dRevisionView(editor).get()
			const revision = view && getModel3dRevision(editor, view.revisionId)
			return revision?.props.modelId === modelId ? revision : null
		},
		[editor, modelId]
	)
}

/** The rect, in viewer pixels, that the 3D view is letterboxed to while a revision is shown. */
export function useModel3dRevisionLetterbox(modelId: string) {
	const editor = useEditor()
	const revision = useShownRevision(modelId)
	const aspect = revision ? revision.props.viewport.w / revision.props.viewport.h : null
	return useValue(
		'model3d letterbox',
		() => {
			if (!aspect) return null
			const screen = editor.getViewportScreenBounds()
			return letterbox({ w: screen.w, h: screen.h }, aspect)
		},
		[editor, aspect]
	)
}

export function letterboxStyle(rect: Model3dRect): CSSProperties {
	return { left: rect.x, top: rect.y, width: rect.w, height: rect.h, right: 'auto', bottom: 'auto' }
}

/** The shown revision's overlay, and the list of the model's revisions while `isListOpen`. */
export function Model3dRevisionsPanel({
	modelId,
	handle,
	isListOpen,
}: {
	modelId: string
	handle: ViewerHandle
	isListOpen: boolean
}) {
	const editor = useEditor()
	const msg = useTranslation()
	const revisions = useValue('model3d revisions', () => getModel3dRevisions(editor, modelId), [
		editor,
		modelId,
	])
	const revision = useShownRevision(modelId)
	const pendingCamera = useValue(
		'model3d pending camera',
		() => getModel3dRevisionView(editor).get()?.pendingCamera ?? false,
		[editor]
	)
	const rect = useModel3dRevisionLetterbox(modelId)
	const [camera, setCamera] = useState(() => handle.getCamera())
	const [overlay, setOverlay] = useState<{ revisionId: string; url: string } | null>(null)
	// Re-exports when the content changes, from this tab or any other, or the theme changes.
	const content = useValue(
		'model3d revision content',
		() => (revision ? getModel3dRevisionOverlayKey(editor, revision.id) : null),
		[editor, revision?.id]
	)

	useEffect(() => handle.onCameraChange(setCamera), [handle])

	useEffect(() => {
		if (!revision || !pendingCamera) return
		handle.setCamera(revision.props.pose, { animate: true })
		getModel3dRevisionView(editor).update(
			(v) => v && (v.revisionId === revision.id ? { ...v, pendingCamera: false } : v)
		)
	}, [editor, handle, revision, pendingCamera])

	useEffect(() => {
		if (!revision) return
		let cancelled = false
		getModel3dRevisionOverlayUrl(editor, revision.id)
			.then((url) => url && !cancelled && setOverlay({ revisionId: revision.id, url }))
			.catch((e) => console.error('Could not render the revision overlay', e))
		return () => {
			cancelled = true
		}
	}, [editor, revision, content])

	// The view a revision belongs to is not the user's any more once they close the viewer.
	useEffect(
		() => () => {
			getModel3dRevisionView(editor).set(null)
		},
		[editor]
	)

	const isAtPose = !!revision && isCameraAtPose(camera, revision.props.pose)
	const overlayUrl = overlay && overlay.revisionId === revision?.id ? overlay.url : null

	return (
		<>
			{rect && (
				<div className={styles.letterbox} style={letterboxStyle(rect)}>
					{isAtPose && overlayUrl && <img className={styles.overlay} src={overlayUrl} alt="" />}
				</div>
			)}
			{revision && !isAtPose && !pendingCamera && (
				<div className={styles.returnToView}>
					<TldrawUiButton type="normal" onClick={() => showModel3dRevision(editor, revision.id)}>
						<TldrawUiButtonLabel>{msg(messages.returnToView)}</TldrawUiButtonLabel>
					</TldrawUiButton>
				</div>
			)}
			{isListOpen && (
				<div className={styles.list} role="group" aria-label={msg(messages.views)}>
					{revisions.map((r) => {
						const isShown = r.id === revision?.id
						return (
							<TldrawUiButton
								key={r.id}
								type="menu"
								isActive={isShown}
								aria-pressed={isShown}
								onClick={() =>
									isShown
										? getModel3dRevisionView(editor).set(null)
										: showModel3dRevision(editor, r.id)
								}
							>
								<TldrawUiButtonLabel>{r.props.name}</TldrawUiButtonLabel>
								<Model3dRevisionEditBadge shape={r} />
							</TldrawUiButton>
						)
					})}
				</div>
			)}
		</>
	)
}
