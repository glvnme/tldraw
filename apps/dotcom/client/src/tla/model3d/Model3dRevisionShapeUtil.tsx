import {
	MODEL3D_REVISION_SHAPE_TYPE,
	TLModel3dRevisionShape,
	model3dRevisionShapeMigrations,
	model3dRevisionShapeProps,
} from '@tldraw/dotcom-shared'
import { BaseFrameLikeShapeUtil, Rectangle2d, SVGContainer, TLShape } from 'tldraw'

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

	// Hollow so clicks inside reach the strokes.
	override getGeometry(shape: TLModel3dRevisionShape) {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false })
	}

	// The base class lets arrows escape the clip; strokes over a snapshot must all stay inside.
	override shouldClipChild(_child: TLShape) {
		return true
	}

	override isExportBoundsContainer() {
		return true
	}

	override component(shape: TLModel3dRevisionShape) {
		return (
			<SVGContainer>
				<rect
					width={shape.props.w}
					height={shape.props.h}
					fill="var(--tl-color-muted-2)"
					stroke="var(--tl-color-muted-1)"
				/>
			</SVGContainer>
		)
	}

	override getIndicatorPath(shape: TLModel3dRevisionShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}
