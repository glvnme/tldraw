import { atom, Atom, Editor, TLShape, TLShapeId, WeakCache } from 'tldraw'

const hiddenShapeIdsCache = new WeakCache<Editor, Atom<ReadonlySet<TLShapeId>>>()

export function getModel3dHiddenShapeIds(editor: Editor) {
	return hiddenShapeIdsCache.get(editor, () =>
		atom<ReadonlySet<TLShapeId>>('model3d hidden shapes', new Set())
	)
}

/** For `getShapeVisibility`, which the editor captures once, so it must read an atom. */
export function getModel3dShapeVisibility(shape: TLShape, editor: Editor) {
	return getModel3dHiddenShapeIds(editor).get().has(shape.id) ? 'hidden' : undefined
}
