import {
	MODEL3D_RETRYABLE_ERRORS,
	MODEL3D_SHAPE_TYPE,
	TLModel3dShape,
	model3dShapeMigrations,
	model3dShapeProps,
} from '@tldraw/dotcom-shared'
import { PointerEventHandler, useCallback, useEffect, useState } from 'react'
import {
	BaseBoxShapeUtil,
	FileHelpers,
	HTMLContainer,
	fetch,
	SvgExportContext,
	TLShapePartial,
	translateMessage,
	useEditor,
	useImageOrVideoAsset,
	useTranslation,
	useValue,
} from 'tldraw'
import { useCurrentFileId } from '../hooks/useCurrentFileId'
import { Model3dApiError } from './api'
import { model3dErrorMessages, model3dMessages as messages } from './messages'
import { pickModel3dFiles } from './pickFiles'
import { useModel3dStatus, model3dStatusPoller } from './status'
import { prepareModel3dThumbnail } from './thumbnail'
import {
	cancelModel3dUpload,
	getModel3dFormat,
	MODEL3D_MAX_SOURCE_BYTES,
	startModel3dUpload,
	model3dLocalUploads,
	requeueModel3d,
	retryModel3dUpload,
} from './upload'
import { useModel3dGetToken } from './useModel3dGetToken'
import { openModel3dViewer } from './viewerState'
import styles from './model3d.module.css'

// A tab that is uploading, or a server row that is still receiving parts, changes within this.
const INTERRUPTED_AFTER_MS = 20_000

const STAGE_MESSAGES = {
	fetching: messages.fetching,
	parsing: messages.parsing,
	optimizing: messages.optimizing,
	uploading: messages.saving,
} as const

export class Model3dShapeUtil extends BaseBoxShapeUtil<TLModel3dShape> {
	static override type = MODEL3D_SHAPE_TYPE
	static override props = model3dShapeProps
	static override migrations = model3dShapeMigrations

	override getDefaultProps(): TLModel3dShape['props'] {
		return {
			w: 320,
			h: 240,
			modelId: '',
			modelVersion: 1,
			assetId: null,
			defaultView: null,
			altText: '',
		}
	}

	override getShapeName() {
		return translateMessage(this.editor.i18n(), messages.model)
	}

	override isAspectRatioLocked() {
		return true
	}

	// View-only visitors can still open the viewer.
	override canEditInReadonly() {
		return true
	}

	override onDoubleClick(shape: TLModel3dShape): TLShapePartial<TLModel3dShape> {
		openModel3dViewer(this.editor, shape.id)
		// A partial stops Idle from falling through to creating a text shape.
		return { id: shape.id, type: shape.type }
	}

	override component(shape: TLModel3dShape) {
		return (
			<HTMLContainer>
				<Model3dShapeBody shape={shape} />
			</HTMLContainer>
		)
	}

	override async toSvg(shape: TLModel3dShape, ctx: SvgExportContext) {
		if (!shape.props.assetId) return null
		const url = await ctx.resolveAssetUrl(shape.props.assetId, shape.props.w)
		if (!url) return null
		const src = url.startsWith('data:')
			? url
			: await fetch(url)
					.then((res) => res.blob())
					.then(FileHelpers.blobToDataUrl)
					.catch(() => null)
		if (!src) return null
		return (
			<image
				href={src}
				width={shape.props.w}
				height={shape.props.h}
				preserveAspectRatio="xMidYMid meet"
			/>
		)
	}

	override getIndicatorPath(shape: TLModel3dShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function Model3dShapeBody({ shape }: { shape: TLModel3dShape }) {
	const editor = useEditor()
	const fileId = useCurrentFileId()
	const msg = useTranslation()
	const getToken = useModel3dGetToken()
	const isReadonly = useValue('isReadonly', () => editor.getIsReadonly(), [editor])
	const isActive = useValue(
		'model controls',
		() =>
			editor.getHoveredShapeId() === shape.id || editor.getSelectedShapeIds().includes(shape.id),
		[editor, shape.id]
	)
	const { modelId, altText } = shape.props
	const localUpload = useValue('model3d upload', () => model3dLocalUploads.get().get(shape.id), [
		shape.id,
	])
	// A copy of the shape shares the model, and the upload runs under the original's id.
	const isUploadingHere = useValue(
		'model3d upload here',
		() => [...model3dLocalUploads.get().values()].some((upload) => upload.modelId === modelId),
		[modelId]
	)
	const snapshot = useModel3dStatus(modelId, getToken)
	const { url: thumbnailUrl } = useImageOrVideoAsset({
		shapeId: shape.id,
		assetId: shape.props.assetId,
		width: shape.props.w,
	})

	const [previewAttempt, setPreviewAttempt] = useState(0)
	const [previewError, setPreviewError] = useState(false)
	const ready = snapshot.kind === 'ok' && snapshot.status.status === 'ready'
	useEffect(() => {
		if (!ready || shape.props.assetId || isReadonly) return
		const abort = new AbortController()
		setPreviewError(false)
		void prepareModel3dThumbnail(editor, shape.id, getToken, abort.signal).catch((error) => {
			if (!abort.signal.aborted) {
				console.error('Could not prepare the model preview', error)
				setPreviewError(true)
			}
		})
		return () => abort.abort()
	}, [
		editor,
		shape.id,
		shape.props.modelId,
		shape.props.assetId,
		ready,
		isReadonly,
		getToken,
		previewAttempt,
	])

	const [retryError, setRetryError] = useState<string | null>(null)
	const [sourceError, setSourceError] = useState<string | null>(null)
	// The server deleted the source, so only selecting the file again can convert it.
	const [needsSource, setNeedsSource] = useState(false)
	useEffect(() => {
		setNeedsSource(false)
		setRetryError(null)
	}, [modelId])
	const retryConversion = useCallback(async () => {
		setRetryError(null)
		setSourceError(null)
		try {
			await requeueModel3d(getToken, modelId)
		} catch (e) {
			if (e instanceof Model3dApiError && e.code === 'source_required') setNeedsSource(true)
			else setRetryError(e instanceof Error ? e.message : String(e))
		}
		model3dStatusPoller.refresh(modelId)
	}, [getToken, modelId])

	const selectSource = useCallback(async () => {
		if (editor.getIsReadonly()) return
		setRetryError(null)
		setSourceError(null)
		const [file] = await pickModel3dFiles(editor.getContainerDocument())
		if (
			!file ||
			!fileId ||
			editor.getIsReadonly() ||
			editor.getShape<TLModel3dShape>(shape.id)?.props.modelId !== modelId
		)
			return
		const format = getModel3dFormat(file.name)
		if (!format || !file.size || file.size > MODEL3D_MAX_SOURCE_BYTES) {
			setSourceError(
				msg(!format ? messages.unsupportedFile : file.size ? messages.tooLarge : messages.empty)
			)
			return
		}
		startModel3dUpload(shape.id, {
			file,
			format,
			fileId,
			getToken,
			onCreated: (newModelId) => {
				if (
					editor.getIsReadonly() ||
					editor.getShape<TLModel3dShape>(shape.id)?.props.modelId !== modelId
				) {
					cancelModel3dUpload(shape.id)
					return
				}
				editor.run(
					() =>
						editor.updateShape<TLModel3dShape>({
							id: shape.id,
							type: MODEL3D_SHAPE_TYPE,
							// The default view is a camera, which still frames the same site after a re-upload.
							props: { modelId: newModelId, assetId: null, altText: file.name },
						}),
					{ history: 'ignore', ignoreShapeLock: true }
				)
			},
		})
	}, [editor, shape.id, modelId, fileId, getToken, msg])

	const status = snapshot.kind === 'ok' ? snapshot.status : null
	const name = status?.name || altText || msg(messages.model)
	// Only the tab that holds the file can finish an upload, so one this tab does not hold, after a
	// reload or an undo of the shape's deletion, would otherwise read "Uploading" for good. Another
	// tab's live upload bumps `updatedAt` with every part, and a finished one leaves `uploading` at
	// the next poll, so neither reads as interrupted.
	const maybeInterrupted =
		!localUpload && !isUploadingHere && (!modelId || status?.status === 'uploading')
	const isInterrupted = useUnchangedFor(
		maybeInterrupted ? `${modelId}:${status?.updatedAt ?? ''}` : null,
		INTERRUPTED_AFTER_MS
	)

	if (localUpload) {
		return localUpload.status === 'failed' ? (
			<Status
				name={name}
				tone="error"
				label={msg(messages.uploadFailed)}
				detail={localUpload.error}
				action={{ label: msg(messages.retry), onClick: () => retryModel3dUpload(shape.id) }}
			/>
		) : (
			<Status name={name} label={msg(messages.uploading)} progress={localUpload.progress} />
		)
	}

	if (isInterrupted) {
		return <Status name={name} tone="error" label={msg(messages.uploadInterrupted)} />
	}
	if (!modelId) return <Status name={name} label={msg(messages.uploading)} />

	if (snapshot.kind === 'forbidden') {
		return <Status name={altText || msg(messages.model)} label={msg(messages.noAccessShort)} />
	}

	if (snapshot.kind === 'not_found') {
		return <Status name={name} tone="error" label={msg(messages.notFound)} />
	}

	if (status?.status === 'failed') {
		const { errorCode } = status
		const errorMessage =
			errorCode && Object.hasOwn(model3dErrorMessages, errorCode)
				? msg(model3dErrorMessages[errorCode])
				: errorCode
		return (
			<Status
				name={name}
				tone="error"
				label={msg(messages.conversionFailed)}
				detail={
					sourceError ??
					(needsSource
						? msg(model3dErrorMessages.source_required)
						: retryError
							? msg(messages.retryFailed, { error: retryError })
							: errorMessage)
				}
				action={
					isReadonly
						? undefined
						: MODEL3D_RETRYABLE_ERRORS.includes(errorCode) && !needsSource
							? { label: msg(messages.retry), onClick: retryConversion }
							: status.sourceFormat === '3dm'
								? { label: msg(messages.chooseSource), onClick: selectSource }
								: undefined
				}
			/>
		)
	}

	if (status && status.status !== 'ready') {
		const label = msg(
			status.status === 'converting' && status.stage
				? STAGE_MESSAGES[status.stage]
				: status.status === 'uploading'
					? messages.uploading
					: messages.waiting
		)
		return (
			<Status
				name={name}
				label={label}
				progress={status.status === 'converting' ? status.progress : undefined}
			/>
		)
	}

	if (!thumbnailUrl) {
		if (ready && previewError) {
			return (
				<Status
					name={name}
					tone="error"
					label={msg(messages.previewFailed)}
					action={
						isReadonly
							? undefined
							: { label: msg(messages.retry), onClick: () => setPreviewAttempt((n) => n + 1) }
					}
				/>
			)
		}
		// Only an editor can render and save the preview.
		if (ready && isReadonly && !shape.props.assetId) {
			return (
				<Status
					name={name}
					label={msg(messages.noPreview)}
					action={{
						label: msg(messages.openIn3d),
						onClick: () => openModel3dViewer(editor, shape.id),
					}}
				/>
			)
		}
		return snapshot.kind === 'error' ? (
			<Status name={name} tone="error" label={snapshot.message} />
		) : (
			<Status name={name} label={msg(ready ? messages.preparingPreview : messages.loadingStatus)} />
		)
	}

	const warnings = status?.manifest?.version === 2 ? status.manifest.warnings : []
	const has = (...codes: string[]) => warnings.some((w) => codes.includes(w.code))
	const warning = [
		has('missing_render_mesh', 'unsupported_entity', 'instance_depth_limit') &&
			msg(messages.partialModel),
		has('approximate_mesh') && msg(messages.approximateModel),
		has('units_assumed') && msg(messages.assumedUnits),
		has('near_empty') && msg(messages.nearEmptyModel),
	]
		.filter(Boolean)
		.join(' ')

	return (
		<div className={styles.model}>
			<img className={styles.image} src={thumbnailUrl} alt={altText} draggable={false} />
			{isActive && warning && (
				<span className={styles.modelWarning} title={warning} role="img" aria-label={warning}>
					<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M8 1.5 15 14H1z" fill="currentColor" />
						<path d="M8 6v4M8 11.6v.4" stroke="var(--tl-color-panel)" strokeWidth="1.6" />
					</svg>
				</span>
			)}
			{ready && isActive && (
				<PlayButton
					label={msg(messages.openIn3d)}
					onPlay={() => openModel3dViewer(editor, shape.id)}
				/>
			)}
		</div>
	)
}

/** True once `key` has been non-null and unchanged for `ms`. */
function useUnchangedFor(key: string | null, ms: number) {
	const [settled, setSettled] = useState<string | null>(null)
	useEffect(() => {
		if (key === null) return
		const timer = setTimeout(() => setSettled(key), ms)
		return () => clearTimeout(timer)
	}, [key, ms])
	return key !== null && settled === key
}

/** A quiet inline line of status in place of the model image; the shape has no chrome of its own. */
function Status({
	name,
	label,
	tone = 'normal',
	detail,
	progress,
	action,
}: {
	name: string
	label: string
	tone?: 'normal' | 'error'
	detail?: string | null
	progress?: number
	action?: { label: string; onClick(): void }
}) {
	const markAsHandled = useMarkAsHandled()
	return (
		<div className={styles.status} data-tone={tone} title={name}>
			<span className={styles.statusLabel}>{label}</span>
			{progress !== undefined && (
				<span className={styles.progress}>
					<span style={{ width: `${Math.round(progress * 100)}%` }} />
				</span>
			)}
			{detail && <span className={styles.statusDetail}>{detail}</span>}
			{action && (
				<button
					className={styles.statusAction}
					onPointerDown={markAsHandled}
					onPointerUp={markAsHandled}
					onClick={action.onClick}
				>
					{action.label}
				</button>
			)}
		</div>
	)
}

// Pointer events are marked handled so pressing a control doesn't start a select or drag,
// following tldraw's HyperlinkButton.
function useMarkAsHandled() {
	const editor = useEditor()
	return useCallback<PointerEventHandler>(
		(e) => {
			if (!editor.inputs.getShiftKey()) editor.markEventAsHandled(e)
		},
		[editor]
	)
}

function PlayButton({ label, onPlay }: { label: string; onPlay(): void }) {
	const markAsHandled = useMarkAsHandled()
	return (
		<button
			className={styles.play}
			title={label}
			aria-label={label}
			onPointerDown={markAsHandled}
			onPointerUp={markAsHandled}
			onClick={onPlay}
		>
			<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M4 2.5v11l9-5.5z" fill="currentColor" />
			</svg>
		</button>
	)
}
