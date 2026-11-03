import {
	MODEL3D_REVISION_SHAPE_TYPE,
	MODEL3D_SHAPE_TYPE,
	TLModel3dRevisionShape,
} from '@tldraw/dotcom-shared'
import { atom, Atom, Editor, TLRecord, TLShapeId, WeakCache } from 'tldraw'
import { openModel3dViewer } from '../viewerState'
import { computeContentKey } from './strokeHash'

export interface Model3dRevisionView {
	revisionId: TLShapeId
	/** Set until the viewer has moved its camera to the revision's pose. */
	pendingCamera: boolean
}

const revisionViews = new WeakCache<Editor, Atom<Model3dRevisionView | null>>()

/** The revision the open viewer shows over the model. */
export function getModel3dRevisionView(editor: Editor) {
	return revisionViews.get(editor, () => atom<Model3dRevisionView | null>('model3d revision', null))
}

export function showModel3dRevision(editor: Editor, revisionId: TLShapeId) {
	getModel3dRevisionView(editor).set({ revisionId, pendingCamera: true })
}

export function getModel3dRevision(editor: Editor, id: TLShapeId) {
	const shape = editor.getShape(id)
	return shape?.type === MODEL3D_REVISION_SHAPE_TYPE ? (shape as TLModel3dRevisionShape) : null
}

// Current page only: `toImage` renders from the current page's shapes.
export function getModel3dRevisions(editor: Editor, modelId: string) {
	return editor
		.getCurrentPageShapesSorted()
		.filter(
			(s): s is TLModel3dRevisionShape =>
				s.type === MODEL3D_REVISION_SHAPE_TYPE &&
				(s as TLModel3dRevisionShape).props.modelId === modelId
		)
}

/** Opens the viewer on the revision's model and moves it to the revision's pose. */
export function openModel3dRevision(editor: Editor, revisionId: TLShapeId) {
	const revision = getModel3dRevision(editor, revisionId)
	if (!revision) return false
	const model = editor
		.getCurrentPageShapes()
		.find((s) => s.type === MODEL3D_SHAPE_TYPE && s.props.modelId === revision.props.modelId)
	if (!model) return false
	showModel3dRevision(editor, revisionId)
	openModel3dViewer(editor, model.id)
	return true
}

/** The records an overlay is drawn from: every descendant and the bindings that start on one. */
export function getRevisionContentRecords(editor: Editor, revisionId: TLShapeId): TLRecord[] {
	const ids = editor.getShapeAndDescendantIds([revisionId])
	ids.delete(revisionId)
	const shapes = [...ids].map((id) => editor.getShape(id)!).filter(Boolean)
	const bindings = shapes.flatMap((s) =>
		editor.getBindingsInvolvingShape(s.id).filter((b) => b.fromId === s.id)
	)
	return [...shapes, ...bindings]
}

/** Changes whenever the revision's content does, whichever tab or undo changed it. */
export function getRevisionContentKey(editor: Editor, revisionId: TLShapeId) {
	return computeContentKey(getRevisionContentRecords(editor, revisionId))
}
