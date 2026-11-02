import {
	MODEL3D_SHAPE_TYPE,
	TLModel3dShape,
	model3dShapeMigrations,
	model3dShapeProps,
} from '@tldraw/dotcom-shared'
import { PointerEventHandler, ReactNode, useCallback, useState } from 'react'
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
import { model3dMessages as messages } from './messages'
import { useModel3dStatus, model3dStatusPoller } from './status'
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
				preserveAspectRatio="xMidYMid slice"
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
	const { modelId, altText } = shape.props
	const localUpload = useValue('model3d upload', () => model3dLocalUploads.get().get(shape.id), [
		shape.id,
	])
	const snapshot = useModel3dStatus(modelId, getToken)
	const { url: thumbnailUrl } = useImageOrVideoAsset({
		shapeId: shape.id,
		assetId: shape.props.assetId,
		width: shape.props.w,
	})

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
			<Card name={name}>
				<span className={styles.error}>
					{msg(messages.uploadFailed, { error: localUpload.error ?? '' })}
				</span>
				<CardButton onClick={() => retryModel3dUpload(shape.id)}>{msg(messages.retry)}</CardButton>
			</Card>
		) : (
			<Card name={name}>
				<span>{msg(messages.uploading)}</span>
				<Progress value={localUpload.progress} />
			</Card>
		)
	}

	if (!modelId) {
		return (
			<Card name={name}>
				<span>{msg(messages.uploading)}</span>
			</Card>
		)
	}

	if (snapshot.kind === 'forbidden') {
		return (
			<Card name={altText || msg(messages.model)}>
				<span>{msg(messages.noAccess)}</span>
			</Card>
		)
	}

	if (snapshot.kind === 'not_found') {
		return (
			<Card name={name}>
				<span className={styles.error}>{msg(messages.notFound)}</span>
			</Card>
		)
	}

	if (status?.status === 'failed') {
		return (
			<Card name={name}>
				<span className={styles.error}>
					{msg(messages.conversionFailed, { error: status.errorCode ?? '' })}
				</span>
				{retryError && (
					<span className={styles.error}>{msg(messages.retryFailed, { error: retryError })}</span>
				)}
				{!isReadonly && <CardButton onClick={retryConversion}>{msg(messages.retry)}</CardButton>}
			</Card>
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
			<Card name={name}>
				<span>{label}</span>
				{status.status === 'converting' && <Progress value={status.progress} />}
			</Card>
		)
	}

	const isReady = status?.status === 'ready'
	return (
		<Card name={thumbnailUrl ? null : name}>
			{thumbnailUrl ? (
				<img className={styles.thumbnail} src={thumbnailUrl} alt={altText} draggable={false} />
			) : status?.manifest ? (
				<span>{msg(messages.triangles, { count: status.manifest.triangleCount })}</span>
			) : snapshot.kind === 'error' ? (
				<span className={styles.error}>{snapshot.message}</span>
			) : null}
			{isReady && (
				<PlayButton
					label={msg(messages.openIn3d)}
					onPlay={() => openModel3dViewer(editor, shape.id)}
				/>
			)}
		</Card>
	)
}

function Card({ name, children }: { name: string | null; children: ReactNode }) {
	return (
		<div className={styles.card} style={{ width: '100%', height: '100%' }}>
			{name && <div className={styles.name}>{name}</div>}
			{children}
		</div>
	)
}

function Progress({ value }: { value: number }) {
	return (
		<div className={styles.progress}>
			<div className={styles.progressFill} style={{ width: `${Math.round(value * 100)}%` }} />
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

function CardButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
	const markAsHandled = useMarkAsHandled()
	return (
		<button
			className={styles.cardButton}
			onPointerDown={markAsHandled}
			onPointerUp={markAsHandled}
			onClick={onClick}
		>
			{children}
		</button>
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
			<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M4 2.5v11l9-5.5z" fill="currentColor" />
			</svg>
		</button>
	)
}
