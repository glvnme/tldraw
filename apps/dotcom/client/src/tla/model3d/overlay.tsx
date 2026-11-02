import { useEditor, useValue } from 'tldraw'
import { Model3dViewer } from './Model3dViewer'
import { Model3dSketchMount } from './sketch/SketchBar'
import { getModel3dViewerState } from './viewerState'

export function Model3dOverlayMount() {
	const editor = useEditor()
	const viewer = useValue('model3d viewer', () => getModel3dViewerState(editor).get(), [editor])
	return (
		<>
			{viewer && <Model3dViewer key={viewer.shapeId} state={viewer} />}
			<Model3dSketchMount />
		</>
	)
}
