import { Editor, TLShape } from 'tldraw'
import { getModel3dSketchSession } from './sketch/session'

/**
 * For `getShapeVisibility`, which the editor captures once, so it must read an atom. While
 * sketching, only the revision and its descendants show, including shapes that another tab or an
 * undo adds after sketching started.
 */
export function getModel3dShapeVisibility(shape: TLShape, editor: Editor) {
	const session = getModel3dSketchSession(editor).get()
	if (!session) return undefined
	// `visible` wins over a hidden parent, such as a frame the revision was moved into.
	if (shape.id === session.revisionId) return 'visible'
	return editor.hasAncestor(shape, session.revisionId) ? undefined : 'hidden'
}
