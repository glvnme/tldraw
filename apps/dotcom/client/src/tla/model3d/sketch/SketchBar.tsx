import { useEffect } from 'react'
import { EditorPortal, react, useEditor, useTranslation, useValue } from 'tldraw'
import { revisionMessages as messages } from '../revisions/messages'
import { getModel3dRevision } from '../revisions/state'
import { closeModel3dViewer, getModel3dViewerState } from '../viewerState'
import {
	discardModel3dSketch,
	exitModel3dSketch,
	fitSketchCamera,
	getModel3dSketchSession,
	getModel3dSnapshotUploads,
	isModel3dSnapshotSaved,
	publishModel3dSketch,
	retryModel3dSnapshotUpload,
} from './session'
import styles from '../revisions/revisions.module.css'

/** Mounted next to the viewer, outside it, so it can clean up when the viewer closes mid-sketch. */
export function Model3dSketchMount() {
	const editor = useEditor()
	const revisionId = useValue(
		'model3d sketch',
		() => getModel3dSketchSession(editor).get()?.revisionId ?? null,
		[editor]
	)
	if (!revisionId) return null
	return <Model3dSketchBar />
}

function Model3dSketchBar() {
	const editor = useEditor()
	const msg = useTranslation()
	const name = useValue(
		'model3d sketch name',
		() => {
			const session = getModel3dSketchSession(editor).get()
			return (session && getModel3dRevision(editor, session.revisionId)?.props.name) ?? ''
		},
		[editor]
	)
	const assetId = useValue(
		'model3d sketch snapshot',
		() => {
			const session = getModel3dSketchSession(editor).get()
			return (session && getModel3dRevision(editor, session.revisionId)?.props.assetId) ?? null
		},
		[editor]
	)
	const isSaved = useValue(
		'model3d snapshot saved',
		() => isModel3dSnapshotSaved(editor, assetId),
		[editor, assetId]
	)
	const uploadFailed = useValue(
		'model3d snapshot failed',
		() => !!assetId && getModel3dSnapshotUploads(editor).get().get(assetId)?.status === 'failed',
		[editor, assetId]
	)

	useEffect(
		() =>
			react('model3d sketch exit', () => {
				const session = getModel3dSketchSession(editor).get()
				if (!session) return
				// The viewer belongs to a model on the page sketching started from.
				if (editor.getCurrentPageId() !== session.restore.pageId) {
					exitModel3dSketch(editor)
					closeModel3dViewer(editor)
					return
				}
				const viewer = getModel3dViewerState(editor).get()
				if (viewer?.mode !== 'sketch' || !getModel3dRevision(editor, session.revisionId)) {
					exitModel3dSketch(editor)
				}
			}),
		[editor]
	)

	useEffect(
		() =>
			react('model3d sketch fit', () => {
				editor.getViewportScreenBounds()
				fitSketchCamera(editor)
			}),
		[editor]
	)

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || !isIdle()) return
			e.preventDefault()
			e.stopPropagation()
			exitModel3dSketch(editor)
		}
		const isIdle = () => {
			const state = editor.getCurrentTool().getCurrent()
			return (
				(!state || state.id === 'idle') &&
				!editor.getEditingShapeId() &&
				!editor.menus.hasAnyOpenMenus()
			)
		}
		window.addEventListener('keydown', onKeyDown, true)
		return () => window.removeEventListener('keydown', onKeyDown, true)
	}, [editor])

	return (
		<EditorPortal>
			<div className={styles.sketchBar}>
				<span className={styles.sketchName}>{msg(messages.sketching, { name })}</span>
				{uploadFailed && assetId ? (
					<>
						<span className={styles.sketchError}>{msg(messages.snapshotFailed)}</span>
						<button onClick={() => retryModel3dSnapshotUpload(editor, assetId)}>
							{msg(messages.retry)}
						</button>
					</>
				) : (
					!isSaved && <span className={styles.sketchStatus}>{msg(messages.snapshotSaving)}</span>
				)}
				<button
					className={styles.primary}
					disabled={!isSaved}
					onClick={() => publishModel3dSketch(editor)}
				>
					{msg(messages.publish)}
				</button>
				<button onClick={() => exitModel3dSketch(editor)}>{msg(messages.backTo3d)}</button>
				<button onClick={() => discardModel3dSketch(editor)}>{msg(messages.discard)}</button>
			</div>
		</EditorPortal>
	)
}
