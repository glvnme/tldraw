import { useEditor, useValue } from 'tldraw'
import { getModel3dViewerState } from './viewerState'

export function Model3dOverlayMount() {
	const editor = useEditor()
	const viewer = useValue('model3d viewer', () => getModel3dViewerState(editor).get(), [editor])
	if (!viewer) return null
	return null
}
