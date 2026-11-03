import { Editor, TLShapeId, TLUiActionsContextType, TLUiOverrideHelpers } from 'tldraw'
import { getModel3dRevision } from './state'

/**
 * tldraw exports a lone frame-like shape as its children only (`getSvgJsx.tsx`), which drops a
 * revision's snapshot. Listing the revision twice keeps it in the export, children included. The
 * viewer's strokes-only overlay calls `toImage` directly and keeps the children-only path.
 */
export function overrideModel3dRevisionExports(
	editor: Editor,
	actions: TLUiActionsContextType,
	helpers: TLUiOverrideHelpers
) {
	const wrap = (actionId: string, run: (ids: TLShapeId[], name: string) => void) => {
		const action = actions[actionId]
		if (!action) return
		actions[actionId] = {
			...action,
			onSelect(source) {
				const ids = editor.getSelectedShapeIds()
				const revision = ids.length === 1 ? getModel3dRevision(editor, ids[0]) : null
				if (!revision) return action.onSelect(source)
				run([revision.id, revision.id], revision.props.name || 'view')
			},
		}
	}
	wrap('export-as-svg', (ids, name) => helpers.exportAs(ids, { format: 'svg', name }))
	wrap('export-as-png', (ids, name) => helpers.exportAs(ids, { format: 'png', name }))
	wrap('copy-as-svg', (ids) => helpers.copyAs(ids, 'svg'))
	wrap('copy-as-png', (ids) => helpers.copyAs(ids, 'png'))
}
