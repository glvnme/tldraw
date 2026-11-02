import { Editor, TLShapeId, WeakCache } from 'tldraw'
import { getModel3dRevision, getRevisionContentKey } from './state'

interface OverlayCache {
	exports: Map<TLShapeId, { key: string; url: Promise<string | null> }>
	/** The one object URL kept per revision; replacing it revokes the old one. */
	urls: Map<TLShapeId, string>
}

const overlayCaches = new WeakCache<Editor, OverlayCache>()

function getCache(editor: Editor) {
	return overlayCaches.get(editor, () => ({ exports: new Map(), urls: new Map() }))
}

/**
 * An object URL for the revision's strokes as a transparent PNG covering exactly the revision's
 * bounds at the snapshot's pixel ratio. Exporting a single frame-like shape renders only its
 * children (`getSvgJsx.tsx`), so the snapshot is not part of it. Cached by a key of the current
 * content, so a change from anywhere invalidates it. Resolves to null when the content changed
 * during the export; the caller asks again for the new content.
 */
export function getModel3dRevisionOverlayUrl(editor: Editor, revisionId: TLShapeId) {
	const revision = getModel3dRevision(editor, revisionId)
	if (!revision) return Promise.reject(new Error('Revision not found'))
	const { exports, urls } = getCache(editor)
	const key = getRevisionContentKey(editor, revisionId)
	const cached = exports.get(revisionId)
	if (cached?.key === key) return cached.url

	const entry = {
		key,
		url: editor
			.toImage([revisionId], {
				format: 'png',
				background: false,
				padding: 0,
				pixelRatio: revision.props.viewport.dpr,
				darkMode: false,
			})
			.then(({ blob }) => {
				// `toImage` renders the store as it is when it gets to it, not as it was keyed.
				if (exports.get(revisionId) !== entry) return null
				if (getRevisionContentKey(editor, revisionId) !== key) return null
				const url = URL.createObjectURL(blob)
				const replaced = urls.get(revisionId)
				if (replaced) URL.revokeObjectURL(replaced)
				urls.set(revisionId, url)
				return url
			}),
	}
	exports.set(revisionId, entry)
	const forget = () => {
		if (exports.get(revisionId) === entry) exports.delete(revisionId)
	}
	entry.url.then((url) => url ?? forget(), forget)
	return entry.url
}

export function releaseModel3dRevisionOverlay(editor: Editor, revisionId: TLShapeId) {
	const { exports, urls } = getCache(editor)
	const url = urls.get(revisionId)
	if (url) URL.revokeObjectURL(url)
	urls.delete(revisionId)
	exports.delete(revisionId)
}

export function releaseAllModel3dRevisionOverlays(editor: Editor) {
	const { exports, urls } = getCache(editor)
	urls.forEach((url) => URL.revokeObjectURL(url))
	urls.clear()
	exports.clear()
}
