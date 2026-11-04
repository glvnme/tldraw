import {
	MODEL3D_REVISION_SHAPE_TYPE,
	TLModel3dRevisionShape,
	model3dRevisionShapeMigrations,
	model3dRevisionShapeProps,
} from '@tldraw/dotcom-shared'
import { PointerEvent, ReactNode, useEffect, useRef, useState } from 'react'
import {
	BaseFrameLikeShapeUtil,
	FileHelpers,
	Group2d,
	HTMLContainer,
	Rectangle2d,
	SvgExportContext,
	TLShape,
	TLShapePartial,
	fetch,
	useEditor,
	useImageOrVideoAsset,
	useTranslation,
	useToasts,
	useValue,
} from 'tldraw'
import { revisionMessages as messages } from './revisions/messages'
import { getRevisionContentRecords, openModel3dRevision } from './revisions/state'
import { computeStrokeHash } from './revisions/strokeHash'
import { getModel3dSketchSession, publishModel3dRevision } from './sketch/session'
import styles from './revisions/revisions.module.css'

const HEADING_HEIGHT = 22
const HEADING_WIDTH = 180

export class Model3dRevisionShapeUtil extends BaseFrameLikeShapeUtil<TLModel3dRevisionShape> {
	static override type = MODEL3D_REVISION_SHAPE_TYPE
	static override props = model3dRevisionShapeProps
	static override migrations = model3dRevisionShapeMigrations

	override getDefaultProps(): TLModel3dRevisionShape['props'] {
		return {
			w: 1280,
			h: 720,
			modelId: '',
			modelVersion: 1,
			assetId: null,
			pose: {
				projection: 'perspective',
				position: [10, 10, 10],
				target: [0, 0, 0],
				up: [0, 1, 0],
				fov: 50,
				aspect: 16 / 9,
			},
			viewport: { w: 1280, h: 720, dpr: 1 },
			name: '',
			publishedAt: null,
			strokeHash: null,
		}
	}

	// The body is hollow so clicks inside reach the strokes; the heading is how the shape is grabbed.
	override getGeometry(shape: TLModel3dRevisionShape) {
		const z = this.editor.getEfficientZoomLevel()
		const height = HEADING_HEIGHT / z
		return new Group2d({
			children: [
				new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false }),
				new Rectangle2d({
					y: -height,
					width: Math.min(shape.props.w, HEADING_WIDTH / z),
					height,
					isFilled: true,
					isLabel: true,
					excludeFromShapeBounds: true,
				}),
			],
		})
	}

	// The overlay is drawn axis-aligned over the 3D view, so the snapshot keeps its size and angle.
	override canResize() {
		return false
	}

	override hideRotateHandle() {
		return true
	}

	// Published strokes are frozen; `strokeHash` records exactly which ones.
	override canReceiveNewChildrenOfType(shape: TLModel3dRevisionShape) {
		return shape.props.publishedAt === null
	}

	override onBeforeCreate(shape: TLModel3dRevisionShape) {
		return keepUnlockedAndUpright(shape)
	}

	override onBeforeUpdate(_prev: TLModel3dRevisionShape, next: TLModel3dRevisionShape) {
		return keepUnlockedAndUpright(next)
	}

	// The base class lets arrows escape the clip; strokes over a snapshot must all stay inside.
	override shouldClipChild(_child: TLShape) {
		return true
	}

	// An arrow drawn inside would otherwise bind both ends to the revision and collapse to its center.
	override canBind() {
		return false
	}

	override isExportBoundsContainer() {
		return true
	}

	override onDoubleClick(shape: TLModel3dRevisionShape): TLShapePartial<TLModel3dRevisionShape> {
		if (!getModel3dSketchSession(this.editor).get()) openModel3dRevision(this.editor, shape.id)
		// A partial stops Idle from falling through to creating a text shape.
		return { id: shape.id, type: shape.type }
	}

	override component(shape: TLModel3dRevisionShape) {
		return <Model3dRevisionBody shape={shape} />
	}

	override async toSvg(shape: TLModel3dRevisionShape, ctx: SvgExportContext) {
		const { w, h, assetId } = shape.props
		const url = assetId ? await ctx.resolveAssetUrl(assetId, w) : null
		const src =
			url && !url.startsWith('data:')
				? await fetch(url)
						.then((res) => res.blob())
						.then(FileHelpers.blobToDataUrl)
						.catch(() => null)
				: url
		return (
			<>
				{src && <image href={src} width={w} height={h} preserveAspectRatio="none" />}
				<rect width={w} height={h} fill="none" stroke="#d0d3d9" strokeWidth={1} opacity={0.6} />
			</>
		)
	}

	override getIndicatorPath(shape: TLModel3dRevisionShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

// A locked frame-like shape refuses new children and locks every stroke inside it. Rotating a
// selection that includes the revision would otherwise turn it.
function keepUnlockedAndUpright(shape: TLModel3dRevisionShape) {
	return shape.isLocked || shape.rotation !== 0
		? { ...shape, isLocked: false, rotation: 0 }
		: undefined
}

/** True when a published revision's strokes no longer match its `strokeHash`. */
function useIsRevisionEdited(shape: TLModel3dRevisionShape) {
	const editor = useEditor()
	const { strokeHash } = shape.props
	const content = useValue(
		'model3d revision content',
		() => (strokeHash ? getRevisionContentRecords(editor, shape.id) : null),
		[editor, shape.id, strokeHash]
	)
	const [edited, setEdited] = useState(false)
	useEffect(() => {
		if (!content || !strokeHash) return setEdited(false)
		let cancelled = false
		void computeStrokeHash(content).then((hash) => !cancelled && setEdited(hash !== strokeHash))
		return () => {
			cancelled = true
		}
	}, [content, strokeHash])
	return edited && shape.props.publishedAt !== null
}

/** The draft, published or edited badge, on the revision's heading and in the viewer's list. */
export function Model3dRevisionBadge({
	shape,
	isEdited,
}: {
	shape: TLModel3dRevisionShape
	isEdited: boolean
}) {
	const msg = useTranslation()
	const status = isEdited ? 'edited' : shape.props.publishedAt !== null ? 'published' : 'draft'
	return (
		<span className={styles.badge} data-status={status}>
			{msg(messages[status])}
		</span>
	)
}

export function Model3dRevisionEditBadge({ shape }: { shape: TLModel3dRevisionShape }) {
	return <Model3dRevisionBadge shape={shape} isEdited={useIsRevisionEdited(shape)} />
}

function Model3dRevisionBody({ shape }: { shape: TLModel3dRevisionShape }) {
	const editor = useEditor()
	const msg = useTranslation()
	const isReadonly = useValue('isReadonly', () => editor.getIsReadonly(), [editor])
	const isEdited = useIsRevisionEdited(shape)
	const { addToast } = useToasts()
	const [isPublishing, setIsPublishing] = useState(false)
	const publishing = useRef(false)
	const republish = async () => {
		if (publishing.current) return
		publishing.current = true
		setIsPublishing(true)
		try {
			await publishModel3dRevision(editor, shape.id)
		} catch (error) {
			console.error('Could not publish the revision', error)
			addToast({ severity: 'error', title: msg(messages.publishFailed) })
		} finally {
			publishing.current = false
			setIsPublishing(false)
		}
	}
	const { url } = useImageOrVideoAsset({
		shapeId: shape.id,
		assetId: shape.props.assetId,
		width: shape.props.w,
	})
	return (
		<>
			<HTMLContainer>
				<div className={styles.revision}>
					{url && <img className={styles.revisionImage} src={url} alt="" draggable={false} />}
				</div>
			</HTMLContainer>
			<div
				className={styles.heading}
				style={{
					maxWidth: `calc(${shape.props.w}px * var(--tl-zoom))`,
					transform: 'scale(var(--tl-scale))',
				}}
			>
				<span className={styles.headingName}>{shape.props.name}</span>
				<Model3dRevisionBadge shape={shape} isEdited={isEdited} />
				{isEdited && !isReadonly && (
					<HeadingButton onClick={republish} disabled={isPublishing}>
						{msg(messages.republish)}
					</HeadingButton>
				)}
			</div>
		</>
	)
}

// Marked handled so a press doesn't start a select or drag, like tldraw's HyperlinkButton.
function HeadingButton({
	onClick,
	children,
	disabled,
}: {
	onClick(): void
	children: ReactNode
	disabled?: boolean
}) {
	const editor = useEditor()
	const markAsHandled = (e: PointerEvent<HTMLButtonElement>) => editor.markEventAsHandled(e)
	return (
		<button
			className={styles.headingButton}
			disabled={disabled}
			onPointerDown={markAsHandled}
			onPointerUp={markAsHandled}
			onClick={onClick}
		>
			{children}
		</button>
	)
}
