export interface Model3dRect {
	x: number
	y: number
	w: number
	h: number
}

export const REVISION_GAP = 40

/**
 * Right of the anchor, top-aligned with it, stepping further right past every obstacle it would
 * overlap (with `gap` clearance). x only grows, so each obstacle is passed at most once.
 */
export function placeRevision(
	anchor: Model3dRect,
	size: { w: number; h: number },
	obstacles: readonly Model3dRect[],
	gap = REVISION_GAP
) {
	let x = anchor.x + anchor.w + gap
	const y = anchor.y
	for (let i = 0; i <= obstacles.length; i++) {
		const hits = obstacles.filter(
			(o) =>
				x < o.x + o.w + gap &&
				x + size.w + gap > o.x &&
				y < o.y + o.h + gap &&
				y + size.h + gap > o.y
		)
		if (!hits.length) break
		x = Math.max(...hits.map((o) => o.x + o.w)) + gap
	}
	return { x, y }
}

export function nextRevisionName(existing: Iterable<string>) {
	const names = new Set(existing)
	let n = names.size + 1
	for (let i = 1; i <= names.size; i++) {
		if (!names.has(`View ${i}`)) {
			n = i
			break
		}
	}
	return `View ${n}`
}

/** The largest rect of `aspect` (w / h) centered in the container. */
export function fitRect(container: { w: number; h: number }, aspect: number): Model3dRect {
	let w = container.w
	let h = w / aspect
	if (h > container.h) {
		h = container.h
		w = h * aspect
	}
	return { x: (container.w - w) / 2, y: (container.h - h) / 2, w, h }
}

/** `fitRect` on whole pixels, so the WebGL canvas and the overlay image get the same size. */
export function letterbox(container: { w: number; h: number }, aspect: number): Model3dRect {
	const r = fitRect(container, aspect)
	const w = Math.round(r.w)
	const h = Math.round(r.h)
	return { x: Math.round((container.w - w) / 2), y: Math.round((container.h - h) / 2), w, h }
}

/** The 2D camera that shows `bounds` (page space) letterboxed in a viewport of `screen` size. */
export function fitCameraToBounds(screen: { w: number; h: number }, bounds: Model3dRect) {
	const r = fitRect(screen, bounds.w / bounds.h)
	const z = r.w / bounds.w
	return { x: r.x / z - bounds.x, y: r.y / z - bounds.y, z }
}
