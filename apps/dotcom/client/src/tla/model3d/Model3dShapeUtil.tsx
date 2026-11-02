import {
	MODEL3D_SHAPE_TYPE,
	TLModel3dShape,
	model3dShapeMigrations,
	model3dShapeProps,
} from '@tldraw/dotcom-shared'
import { BaseBoxShapeUtil, HTMLContainer } from 'tldraw'

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

	override component(shape: TLModel3dShape) {
		return (
			<HTMLContainer
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					border: '1px solid var(--tl-color-muted-1)',
					background: 'var(--tl-color-muted-2)',
					color: 'var(--tl-color-text-3)',
					fontSize: 14,
					overflow: 'hidden',
				}}
			>
				{shape.props.altText || shape.props.modelId || '3D model'}
			</HTMLContainer>
		)
	}

	override getIndicatorPath(shape: TLModel3dShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}
