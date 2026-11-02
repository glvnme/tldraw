import { atom, Atom, Editor, TLShapeId, WeakCache } from 'tldraw'

export interface Model3dViewerState {
	shapeId: TLShapeId
	mode: 'orbit' | 'sketch'
}

// Not in `instance.meta`: session state persists per user and would reopen the board in 3D.
const viewerStates = new WeakCache<Editor, Atom<Model3dViewerState | null>>()

export function getModel3dViewerState(editor: Editor) {
	return viewerStates.get(editor, () => atom<Model3dViewerState | null>('model3d viewer', null))
}
