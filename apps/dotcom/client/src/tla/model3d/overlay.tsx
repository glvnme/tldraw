import { useEditor, useValue } from 'tldraw'
import { Model3dViewer } from './Model3dViewer'
import { getModel3dViewerState } from './viewerState'

export function Model3dOverlayMount() {
	const editor = useEditor()
	const viewer = useValue('model3d viewer', () => getModel3dViewerState(editor).get(), [editor])
	if (!viewer) return null
	return <Model3dViewer key={viewer.shapeId} state={viewer} />
}
