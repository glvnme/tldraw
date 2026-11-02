import { useEffect } from 'react'
import { useEditor, useValue } from 'tldraw'
import { registerModel3dEditorRules } from './editorRules'
import { Model3dViewer } from './Model3dViewer'
import { recoverModel3dSketch, setModel3dSketchFileId } from './sketch/recovery'
import { Model3dSketchMount } from './sketch/SketchBar'
import { getModel3dViewerState } from './viewerState'

/** `fileId` keys the sketch recovery record; mount after the session state has loaded. */
export function Model3dOverlayMount({ fileId }: { fileId?: string }) {
	const editor = useEditor()
	useEffect(() => registerModel3dEditorRules(editor), [editor])
	useEffect(() => {
		if (!fileId) return
		setModel3dSketchFileId(editor, fileId)
		recoverModel3dSketch(editor)
	}, [editor, fileId])
	const viewer = useValue('model3d viewer', () => getModel3dViewerState(editor).get(), [editor])
	return (
		<>
			{viewer && <Model3dViewer key={viewer.shapeId} state={viewer} />}
			<Model3dSketchMount />
		</>
	)
}
