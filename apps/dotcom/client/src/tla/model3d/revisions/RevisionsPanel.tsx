import type { ViewerHandle } from '@tldraw/dotcom-shared'
import classNames from 'classnames'
import { CSSProperties, useEffect, useState } from 'react'
import { TldrawUiIcon, useEditor, useTranslation, useValue } from 'tldraw'
import { isCameraAtPose } from './cameraMatch'
import { Model3dRect, letterbox } from './layout'
import { revisionMessages as messages } from './messages'
import { getModel3dRevisionOverlayUrl } from './overlayImage'
import {
	getModel3dRevision,
	getModel3dRevisionView,
	getModel3dRevisions,
	getRevisionContentRecords,
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

export function Model3dRevisionsPanel({
	modelId,
	handle,
}: {
	modelId: string
	handle: ViewerHandle
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
	// Re-exports a draft when its strokes change; a published revision hits the cache.
	const content = useValue(
		'model3d revision content',
		() => (revision ? getRevisionContentRecords(editor, revision.id) : null),
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
			.then((url) => !cancelled && setOverlay({ revisionId: revision.id, url }))
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
				<button
					className={styles.returnToView}
					onClick={() => showModel3dRevision(editor, revision.id)}
				>
					{msg(messages.returnToView)}
				</button>
			)}
			{revisions.length > 0 && (
				<div className={styles.list}>
					<div className={styles.listHeading}>
						<span>{msg(messages.views)}</span>
						{revision && (
							<button
								className={styles.listClear}
								onClick={() => getModel3dRevisionView(editor).set(null)}
							>
								<TldrawUiIcon icon="cross-2" label={msg(messages.hideView)} small />
							</button>
						)}
					</div>
					{revisions.map((r) => (
						<button
							key={r.id}
							className={classNames(
								styles.listItem,
								r.id === revision?.id && styles.listItemActive
							)}
							onClick={() => showModel3dRevision(editor, r.id)}
						>
							<span className={styles.listName}>{r.props.name}</span>
							{r.props.publishedAt === null && (
								<span className={styles.draftTag}>{msg(messages.draft)}</span>
							)}
						</button>
					))}
				</div>
			)}
		</>
	)
}
