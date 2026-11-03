import {
	MODEL3D_SHAPE_TYPE,
	Model3dErrorCode,
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
	useEditor,
	useImageOrVideoAsset,
	useTranslation,
	useValue,
} from 'tldraw'
import { model3dErrorMessages, model3dMessages as messages } from './messages'
import { useModel3dStatus, model3dStatusPoller } from './status'
import { prepareModel3dThumbnail } from './thumbnail'
import { model3dLocalUploads, requeueModel3d, retryModel3dUpload } from './upload'
import { useModel3dGetToken } from './useModel3dGetToken'
import { openModel3dViewer } from './viewerState'
import styles from './model3d.module.css'

const STAGE_MESSAGES = {
	fetching: messages.fetching,
	parsing: messages.parsing,
	optimizing: messages.optimizing,
	uploading: messages.saving,
} as const

// The rest are about the file itself, so the same source fails the same way again.
const RETRYABLE_ERRORS: ReadonlySet<Model3dErrorCode | null> = new Set([
	null,
	'invalid_state',
	'invalid_token',
	'converter_unavailable',
	'conversion_failed',
	'conversion_timeout',
	'internal_error',
])

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

	const ready = snapshot.kind === 'ok' && snapshot.status.status === 'ready'
	useEffect(() => {
		if (!ready || shape.props.assetId || isReadonly) return
		const abort = new AbortController()
		void prepareModel3dThumbnail(editor, shape.id, getToken, abort.signal).catch((error) => {
			if (!abort.signal.aborted) console.error('Could not prepare the model preview', error)
		})
		return () => abort.abort()
	}, [editor, shape.id, shape.props.modelId, shape.props.assetId, ready, isReadonly, getToken])

	const [retryError, setRetryError] = useState<string | null>(null)
	const retryConversion = useCallback(async () => {
		setRetryError(null)
		try {
			await requeueModel3d(getToken, modelId)
		} catch (e) {
			setRetryError(e instanceof Error ? e.message : String(e))
		}
		model3dStatusPoller.refresh(modelId)
	}, [getToken, modelId])

	const status = snapshot.kind === 'ok' ? snapshot.status : null
	const name = status?.name || altText || msg(messages.model)

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

	// Only the tab that holds the file can finish an upload, so one this tab does not hold, after a
	// reload or an undo of the shape's deletion, would otherwise read "Uploading" for good.
	if (!isUploadingHere && (!modelId || status?.status === 'uploading')) {
		return (
			<Status
				name={name}
				tone="error"
				label={msg(messages.uploadInterrupted)}
				action={
					isReadonly
						? undefined
						: { label: msg(messages.remove), onClick: () => editor.deleteShapes([shape.id]) }
				}
			/>
		)
	}

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
				detail={retryError ? msg(messages.retryFailed, { error: retryError }) : errorMessage}
				action={
					!isReadonly && RETRYABLE_ERRORS.has(errorCode)
						? { label: msg(messages.retry), onClick: retryConversion }
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
		return snapshot.kind === 'error' ? (
			<Status name={name} tone="error" label={snapshot.message} />
		) : (
			<Status name={name} label={msg(ready ? messages.preparingPreview : messages.loadingStatus)} />
		)
	}

	return (
		<div className={styles.model}>
			<img className={styles.image} src={thumbnailUrl} alt={altText} draggable={false} />
			{ready && isActive && (
				<PlayButton
					label={msg(messages.openIn3d)}
					onPlay={() => openModel3dViewer(editor, shape.id)}
				/>
			)}
		</div>
	)
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
