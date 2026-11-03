import {
	MODEL3D_SHAPE_TYPE,
	Model3dCamera,
	TLModel3dShape,
	model3dPaths,
} from '@tldraw/dotcom-shared'
import classNames from 'classnames'
import { ReactNode, useEffect, useRef, useState } from 'react'
import {
	EditorPortal,
	TLShapeId,
	TLUiIconType,
	TldrawUiButtonIcon,
	TldrawUiToolbar,
	TldrawUiToolbarButton,
	useEditor,
	useToasts,
	useTranslation,
	useValue,
} from 'tldraw'
import { useTldrawCurrentUser } from '../hooks/useUser'
import { model3dUrl } from './api'
import { loadLastModel3dCamera, saveLastModel3dCamera } from './cameraStorage'
import { model3dMessages as messages } from './messages'
import { revisionMessages } from './revisions/messages'
import {
	Model3dRevisionsPanel,
	letterboxStyle,
	useModel3dRevisionLetterbox,
} from './revisions/RevisionsPanel'
import { getModel3dRevisions } from './revisions/state'
import { enterModel3dSketch } from './sketch/session'
import { useModel3dStatus } from './status'
import { captureModel3dThumbnail } from './thumbnail'
import { useModel3dGetToken } from './useModel3dGetToken'
import type { Model3dViewerEngine } from './viewerEngine'
import { Model3dViewerState, closeModel3dViewer, getModel3dViewerHandle } from './viewerState'
import styles from './model3d.module.css'

type LoadState =
	| { kind: 'loading'; progress: number }
	| { kind: 'ready' }
	| { kind: 'error'; message: string }
	| { kind: 'context-lost' }

const CAMERA_SAVE_DELAY_MS = 300

export function Model3dViewer({ state }: { state: Model3dViewerState }) {
	const editor = useEditor()
	const msg = useTranslation()
	const { shapeId, mode } = state
	const shape = useValue('model3d shape', () => editor.getShape<TLModel3dShape>(shapeId) ?? null, [
		editor,
		shapeId,
	])
	const isOrbit = mode === 'orbit'

	useEffect(() => {
		if (!shape || shape.type !== MODEL3D_SHAPE_TYPE) closeModel3dViewer(editor)
	}, [editor, shape])

	// Shortcuts, undo and the canvas wheel listener all gate on `isFocused`.
	useEffect(() => {
		if (!isOrbit) return
		editor.blur({ blurContainer: false })
		return () => {
			editor.focus()
		}
	}, [editor, isOrbit])

	useEffect(() => {
		if (!isOrbit) return
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			e.stopPropagation()
			closeModel3dViewer(editor)
		}
		window.addEventListener('keydown', onKeyDown, true)
		return () => window.removeEventListener('keydown', onKeyDown, true)
	}, [editor, isOrbit])

	if (!shape || shape.type !== MODEL3D_SHAPE_TYPE) return null

	return (
		<EditorPortal>
			<div className={classNames(styles.viewer, !isOrbit && styles.viewerHidden)}>
				{shape.props.modelId ? (
					<Model3dViewerScene shapeId={shapeId} modelId={shape.props.modelId} />
				) : (
					<>
						<div className={styles.viewerMessage}>{msg(messages.stillUploading)}</div>
						<ViewerIsland />
					</>
				)}
			</div>
		</EditorPortal>
	)
}

function Model3dViewerScene({ shapeId, modelId }: { shapeId: TLShapeId; modelId: string }) {
	const editor = useEditor()
	const msg = useTranslation()
	const getToken = useModel3dGetToken()
	const userId = useTldrawCurrentUser()?.id ?? null
	const snapshot = useModel3dStatus(modelId, getToken)
	const isReady = snapshot.kind === 'ok' && snapshot.status.status === 'ready'
	const isReadonly = useValue('isReadonly', () => editor.getIsReadonly(), [editor])
	const rContainer = useRef<HTMLDivElement>(null)
	const [attempt, setAttempt] = useState(0)
	const [load, setLoad] = useState<LoadState>({ kind: 'loading', progress: 0 })
	const [engine, setEngine] = useState<Model3dViewerEngine | null>(null)
	const letterbox = useModel3dRevisionLetterbox(modelId)
	const { addToast } = useToasts()
	const [isSavingView, setIsSavingView] = useState(false)
	const [isSavingDefault, setIsSavingDefault] = useState(false)
	const [showViews, setShowViews] = useState(false)
	const rAbort = useRef<AbortController | null>(null)
	const hasViews = useValue(
		'model3d has views',
		() => getModel3dRevisions(editor, modelId).length > 0,
		[editor, modelId]
	)

	useEffect(() => {
		const container = rContainer.current
		if (!container || !isReady) return
		// Aborted on close, on retry and on context loss; an aborted attempt never publishes anything.
		const abort = new AbortController()
		const { signal } = abort
		rAbort.current = abort
		let created: Model3dViewerEngine | null = null
		let stopCameraSaves: (() => void) | null = null
		setLoad({ kind: 'loading', progress: 0 })

		void (async () => {
			try {
				const [{ createModel3dViewerEngine }, token] = await Promise.all([
					import('./viewerEngine'),
					getToken(),
				])
				if (signal.aborted) return
				const defaultView = editor.getShape<TLModel3dShape>(shapeId)?.props.defaultView ?? null
				const engine = await createModel3dViewerEngine({
					container,
					glbUrl: model3dUrl(model3dPaths.glb(modelId)),
					token,
					initialCamera: editor.getShape<TLModel3dShape>(shapeId)?.props.assetId
						? (loadLastModel3dCamera(modelId, userId) ?? defaultView)
						: defaultView,
					signal,
					onProgress: (loaded, total) => {
						if (total && !signal.aborted) setLoad({ kind: 'loading', progress: loaded / total })
					},
					onContextLost: () => {
						abort.abort()
						if (created && getModel3dViewerHandle(editor).get() === created) {
							getModel3dViewerHandle(editor).set(null)
						}
						setEngine(null)
						setLoad({ kind: 'context-lost' })
					},
				})
				if (signal.aborted) return
				created = engine
				stopCameraSaves = saveCameraChanges(engine, modelId, userId)
				setEngine(engine)
				setLoad({ kind: 'ready' })
				getModel3dViewerHandle(editor).set(engine)
				await captureModel3dThumbnail(editor, shapeId, engine, signal).catch((e) => {
					if (!signal.aborted) console.error('Could not save the model thumbnail', e)
				})
			} catch (e) {
				if (signal.aborted) return
				setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
			}
		})()

		return () => {
			abort.abort()
			stopCameraSaves?.()
			if (!created) return
			if (getModel3dViewerHandle(editor).get() === created) getModel3dViewerHandle(editor).set(null)
			created.dispose()
			setEngine(null)
		}
	}, [editor, shapeId, modelId, isReady, attempt, getToken, userId])

	const setDefaultView = async () => {
		const signal = rAbort.current?.signal
		if (!engine || !signal || isSavingDefault) return
		setIsSavingDefault(true)
		try {
			await captureModel3dThumbnail(editor, shapeId, engine, signal, 'default')
			addToast({ title: msg(messages.defaultViewSaved) })
		} catch (e) {
			if (!signal.aborted) {
				console.error('Could not save the default view', e)
				addToast({ severity: 'error', title: msg(messages.defaultViewFailed) })
			}
		} finally {
			setIsSavingDefault(false)
		}
	}

	const lockAndSketch = async () => {
		setIsSavingView(true)
		try {
			await enterModel3dSketch(editor, shapeId)
		} catch (e) {
			console.error('Could not save the revision snapshot', e)
			addToast({ severity: 'error', title: msg(revisionMessages.saveViewFailed) })
		} finally {
			setIsSavingView(false)
		}
	}

	const resetView = () => {
		const defaultView = editor.getShape<TLModel3dShape>(shapeId)?.props.defaultView
		if (defaultView) engine?.setCamera(defaultView, { animate: true })
		else engine?.fit()
	}
	const isBusy = isSavingDefault || isSavingView

	return (
		<>
			<div
				ref={rContainer}
				className={styles.viewerCanvas}
				style={letterbox ? letterboxStyle(letterbox) : undefined}
			/>
			{engine && (
				<Model3dRevisionsPanel
					modelId={modelId}
					handle={engine}
					isListOpen={showViews && hasViews}
				/>
			)}
			{!isReady ? (
				<div className={styles.viewerMessage}>
					{msg(
						snapshot.kind === 'forbidden'
							? messages.noAccess
							: snapshot.kind === 'ok' && snapshot.status.status === 'failed'
								? messages.conversionFailedViewer
								: messages.preparing
					)}
				</div>
			) : load.kind === 'loading' ? (
				<div className={styles.viewerMessage}>
					{msg(messages.loading, { percent: load.progress })}
				</div>
			) : load.kind === 'error' ? (
				<div className={styles.viewerMessage}>
					<span>{msg(messages.loadFailed, { error: load.message })}</span>
					<button onClick={() => setAttempt((n) => n + 1)}>{msg(messages.retry)}</button>
				</div>
			) : load.kind === 'context-lost' ? (
				<div className={styles.viewerMessage}>
					<span>{msg(messages.contextLost)}</span>
					<button onClick={() => setAttempt((n) => n + 1)}>{msg(messages.retry)}</button>
				</div>
			) : null}
			<ViewerIsland>
				<IslandButton
					icon="corners"
					label={msg(messages.resetView)}
					disabled={!engine}
					onClick={resetView}
				/>
				{!isReadonly && (
					<>
						<IslandButton
							icon="bookmark"
							label={msg(messages.setDefaultView)}
							disabled={!engine || isBusy}
							onClick={setDefaultView}
						/>
						<IslandButton
							icon="tool-pencil"
							label={msg(revisionMessages.lockAndSketch)}
							disabled={!engine || isBusy}
							onClick={lockAndSketch}
						/>
					</>
				)}
				<div className={styles.islandDivider} />
				<IslandButton
					icon="list"
					label={msg(revisionMessages.views)}
					disabled={!engine || !hasViews}
					isActive={showViews && hasViews}
					onClick={() => setShowViews((v) => !v)}
				/>
			</ViewerIsland>
		</>
	)
}

/** The viewer's single floating toolbar, styled like tldraw's main toolbar. Close is always last. */
function ViewerIsland({ children }: { children?: ReactNode }) {
	const editor = useEditor()
	const msg = useTranslation()
	return (
		<div className={styles.island}>
			<TldrawUiToolbar label={msg(messages.viewerTools)} tooltipSide="top">
				{children}
				{children && <div className={styles.islandDivider} />}
				<IslandButton
					icon="cross-2"
					label={msg(messages.close)}
					onClick={() => closeModel3dViewer(editor)}
				/>
			</TldrawUiToolbar>
		</div>
	)
}

function IslandButton({
	icon,
	label,
	onClick,
	disabled,
	isActive,
}: {
	icon: TLUiIconType
	label: string
	onClick(): void
	disabled?: boolean
	isActive?: boolean
}) {
	return (
		<TldrawUiToolbarButton
			type="tool"
			title={label}
			disabled={disabled}
			isActive={isActive}
			aria-pressed={isActive}
			onClick={onClick}
		>
			<TldrawUiButtonIcon icon={icon} />
		</TldrawUiToolbarButton>
	)
}

/** Saves the last pose shortly after it settles, and right away when the page goes away. */
function saveCameraChanges(engine: Model3dViewerEngine, modelId: string, userId: string | null) {
	let pending: Model3dCamera | null = null
	let timer: ReturnType<typeof setTimeout> | undefined
	const flush = () => {
		clearTimeout(timer)
		if (pending) saveLastModel3dCamera(modelId, userId, pending)
		pending = null
	}
	const unsubscribe = engine.onCameraChange((camera) => {
		pending = camera
		clearTimeout(timer)
		timer = setTimeout(flush, CAMERA_SAVE_DELAY_MS)
	})
	window.addEventListener('pagehide', flush)
	return () => {
		flush()
		unsubscribe()
		window.removeEventListener('pagehide', flush)
	}
}
