import type { ViewerHandle } from '@tldraw/dotcom-shared'
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

const viewerHandles = new WeakCache<Editor, Atom<ViewerHandle | null>>()

/** Set once the open viewer has loaded its model; null while loading, after context loss, and when closed. */
export function getModel3dViewerHandle(editor: Editor) {
	return viewerHandles.get(editor, () => atom<ViewerHandle | null>('model3d viewer handle', null))
}

export function openModel3dViewer(editor: Editor, shapeId: TLShapeId) {
	getModel3dViewerState(editor).set({ shapeId, mode: 'orbit' })
}

export function closeModel3dViewer(editor: Editor) {
	getModel3dViewerState(editor).set(null)
}
