import { useEffect, useRef, useState } from 'react'
import {
	EditorPortal,
	TldrawUiButton,
	TldrawUiButtonIcon,
	TldrawUiButtonLabel,
	TldrawUiToolbar,
	TldrawUiToolbarButton,
	react,
	useEditor,
	useTranslation,
	useToasts,
	useValue,
} from 'tldraw'
import { revisionMessages as messages } from '../revisions/messages'
import { getModel3dRevision } from '../revisions/state'
import { closeModel3dViewer, getModel3dViewerState } from '../viewerState'
import {
	discardModel3dSketch,
	exitModel3dSketch,
	fitSketchCamera,
	getModel3dSketchSession,
	publishModel3dSketch,
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
	const { addToast } = useToasts()
	const [isPublishing, setIsPublishing] = useState(false)
	const publishing = useRef(false)
	const publish = async () => {
		if (publishing.current) return
		publishing.current = true
		setIsPublishing(true)
		try {
			await publishModel3dSketch(editor)
		} catch (error) {
			console.error('Could not publish the revision', error)
			addToast({ severity: 'error', title: msg(messages.publishFailed) })
		} finally {
			publishing.current = false
			setIsPublishing(false)
		}
	}
	const name = useValue(
		'model3d sketch name',
		() => {
			const session = getModel3dSketchSession(editor).get()
			return (session && getModel3dRevision(editor, session.revisionId)?.props.name) ?? ''
		},
		[editor]
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
				<TldrawUiToolbar label={name} tooltipSide="bottom">
					<TldrawUiToolbarButton
						type="icon"
						title={msg(messages.backTo3d)}
						disabled={isPublishing}
						onClick={() => exitModel3dSketch(editor)}
					>
						<TldrawUiButtonIcon icon="arrow-left" small />
					</TldrawUiToolbarButton>
					<span className={styles.sketchName}>{name}</span>
					<TldrawUiToolbarButton
						type="icon"
						title={msg(messages.discard)}
						disabled={isPublishing}
						onClick={() => discardModel3dSketch(editor)}
					>
						<TldrawUiButtonIcon icon="trash" small />
					</TldrawUiToolbarButton>
					<TldrawUiButton type="primary" disabled={isPublishing} onClick={publish}>
						<TldrawUiButtonLabel>{msg(messages.publish)}</TldrawUiButtonLabel>
					</TldrawUiButton>
				</TldrawUiToolbar>
			</div>
		</EditorPortal>
	)
}
