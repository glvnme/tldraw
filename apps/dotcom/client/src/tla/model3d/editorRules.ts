import { MODEL3D_REVISION_SHAPE_TYPE, MODEL3D_SHAPE_TYPE } from '@tldraw/dotcom-shared'
import { Editor, TLShape, TLShapeId } from 'tldraw'
import {
	releaseAllModel3dRevisionOverlays,
	releaseModel3dRevisionOverlay,
} from './revisions/overlayImage'
import { cancelModel3dUpload } from './upload'

// These props are assigned outside history. Replaying an older record must not restore a
// previous model, preview, or camera after a source replacement.
const ASSIGNED_PROPS: Record<string, readonly string[]> = {
	[MODEL3D_SHAPE_TYPE]: ['modelId', 'assetId', 'defaultView'],
	[MODEL3D_REVISION_SHAPE_TYPE]: ['assetId'],
}

type AssignedProps = Record<string, unknown>

function keepAssignedProps(known: AssignedProps, next: TLShape): TLShape {
	const keys = ASSIGNED_PROPS[next.type]
	if (!keys) return next
	let props: AssignedProps | null = null
	for (const key of keys) {
		if ((next.props as AssignedProps)[key] === known[key]) continue
		props ??= { ...next.props }
		props[key] = known[key]
	}
	return props ? ({ ...next, props } as TLShape) : next
}

const registered = new WeakSet<Editor>()

/** Idempotent; the rules are removed when the editor disposes. */
export function registerModel3dEditorRules(editor: Editor) {
	if (registered.has(editor)) return
	registered.add(editor)

	// Redoing a creation re-adds the record as it was created, before the props were assigned.
	const deletedProps = new Map<TLShapeId, AssignedProps>()
	const { sideEffects } = editor

	const cleanups = [
		// Remote records are left alone: rewriting them would diverge from the server.
		sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
			const known = deletedProps.get(shape.id)
			return known && source === 'user' && editor.isReplayingHistory()
				? keepAssignedProps(known, shape)
				: shape
		}),
		sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) =>
			source === 'user' && editor.isReplayingHistory()
				? keepAssignedProps(prev.props as AssignedProps, next)
				: next
		),
		sideEffects.registerAfterDeleteHandler('shape', (shape) => {
			if (!ASSIGNED_PROPS[shape.type]) return
			deletedProps.set(shape.id, { ...shape.props })
			cancelModel3dUpload(shape.id)
			releaseModel3dRevisionOverlay(editor, shape.id)
		}),
		() => {
			releaseAllModel3dRevisionOverlays(editor)
			for (const record of editor.store.allRecords()) {
				if (record.typeName === 'shape' && record.type === MODEL3D_SHAPE_TYPE) {
					cancelModel3dUpload(record.id)
				}
			}
		},
	]
	editor.disposables.add(() => cleanups.forEach((fn) => fn()))
}
