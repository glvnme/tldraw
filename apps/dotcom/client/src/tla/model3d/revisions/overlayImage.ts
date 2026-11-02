import { Editor, TLShapeId, WeakCache } from 'tldraw'
import { getModel3dRevision, hashRevisionContent } from './state'

const overlayCaches = new WeakCache<Editor, Map<string, Promise<string>>>()

/**
 * An object URL for the revision's strokes as a transparent PNG covering exactly the revision's
 * bounds at the snapshot's pixel ratio. Exporting a single frame-like shape renders only its
 * children (`getSvgJsx.tsx`), so the snapshot is not part of it. Cached by the published
 * `strokeHash`, or for a draft by a hash of its current content.
 */
export async function getModel3dRevisionOverlayUrl(editor: Editor, revisionId: TLShapeId) {
	const revision = getModel3dRevision(editor, revisionId)
	if (!revision) throw new Error('Revision not found')
	const hash =
		revision.props.publishedAt !== null && revision.props.strokeHash
			? revision.props.strokeHash
			: await hashRevisionContent(editor, revisionId)
	const cache = overlayCaches.get(editor, () => new Map())
	const key = `${revisionId}:${hash}`
	let url = cache.get(key)
	if (!url) {
		url = editor
			.toImage([revisionId], {
				format: 'png',
				background: false,
				padding: 0,
				pixelRatio: revision.props.viewport.dpr,
				darkMode: false,
			})
			.then(({ blob }) => URL.createObjectURL(blob))
		url.catch(() => cache.delete(key))
		cache.set(key, url)
	}
	return url
}
