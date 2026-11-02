import { MODEL3D_SHAPE_TYPE } from '@tldraw/dotcom-shared'
import { createShapeId, TldrawUiMenuItem, useEditor, useValue } from 'tldraw'

export function Model3dDebugMenuItems() {
	const editor = useEditor()
	const isReadonly = useValue('isReadonly', () => editor.getIsReadonly(), [editor])
	if (isReadonly) return null
	return (
		<TldrawUiMenuItem
			id="model3d-placeholder"
			label="Insert placeholder 3D model"
			onSelect={() => {
				const { x, y } = editor.getViewportPageBounds().center
				const id = createShapeId()
				editor.createShape({
					id,
					type: MODEL3D_SHAPE_TYPE,
					x: x - 160,
					y: y - 120,
					props: { modelId: `placeholder-${id.slice(6, 12)}`, altText: 'Placeholder model' },
				})
				editor.select(id)
			}}
		/>
	)
}
