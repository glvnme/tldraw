import { MODEL3D_SHAPE_TYPE, TLModel3dShape } from '@tldraw/dotcom-shared'
import { Editor } from 'tldraw'

export function getSelectedModel3dShape(editor: Editor) {
	const shape = editor.getOnlySelectedShape()
	return shape?.type === MODEL3D_SHAPE_TYPE ? (shape as TLModel3dShape) : null
}
