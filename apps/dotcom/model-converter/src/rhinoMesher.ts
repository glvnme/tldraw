import earcut from 'earcut'
import type { Brep, BrepFace, Surface } from 'rhino3dm'

export interface RhinoMeshData {
	positions: number[]
	indices: number[]
}

export function subtract(a: number[], b: number[]) {
	return a.map((v, i) => v - b[i])
}
export function dot(a: number[], b: number[]) {
	return a.reduce((sum, v, i) => sum + v * b[i], 0)
}
export function cross(a: number[], b: number[]) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
const distance = (a: number[], b: number[]) => Math.hypot(...subtract(a, b))

// The package declarations omit Embind cleanup. Only pass wrappers, never file tables whose
// `delete(id)` method removes a document entry instead of freeing a wrapper.
export function release(value: unknown) {
	;(value as { delete?(): void } | null)?.delete?.()
}

function segmentDistance(p: number[], a: number[], b: number[]) {
	const d = subtract(b, a)
	const t = Math.max(0, Math.min(1, dot(subtract(p, a), d) / (dot(d, d) || 1)))
	return distance(
		p,
		a.map((v, i) => v + t * d[i])
	)
}

function sampleCurve(
	pointAt: (t: number) => number[],
	start: number,
	end: number,
	tolerance: number,
	maxDepth: number
) {
	const points = [pointAt(start)]
	const split = (a: number, b: number, pa: number[], pb: number[], depth: number) => {
		const mid = (a + b) / 2,
			pm = pointAt(mid)
		const error = Math.max(
			...[0.25, 0.5, 0.75].map((t) => segmentDistance(pointAt(a + (b - a) * t), pa, pb))
		)
		if (depth < maxDepth && error > tolerance) {
			split(a, mid, pa, pm, depth + 1)
			split(mid, b, pm, pb, depth + 1)
		} else points.push(pb)
	}
	split(start, end, points[0], pointAt(end), 0)
	return points
}

/** One cache per Brep: adjacent planar faces use exactly the same edge samples. */
export function createEdgeSampler(brep: Brep, tolerance: number) {
	const cache = new Map<number, number[][]>()
	return (index: number) => {
		const existing = cache.get(index)
		if (existing) return existing
		const edge = brep.edges().get(index)
		try {
			const [start, end] = edge.domain
			const points = sampleCurve((t) => edge.pointAt(t), start, end, tolerance, 8)
			cache.set(index, points)
			return points
		} finally {
			release(edge)
		}
	}
}

type EdgeSampler = ReturnType<typeof createEdgeSampler>

function faceLoops(face: BrepFace, sample: EdgeSampler) {
	const loops: { outer: boolean; points: number[][] }[] = []
	for (let li = 0; li < face.loops.count; li++) {
		const loop = face.loops.get(li)
		const points: number[][] = []
		try {
			for (let ti = 0; ti < loop.trims.count; ti++) {
				const trim = loop.trims.get(ti)
				try {
					if (trim.edgeIndex < 0) continue
					const segment = [...sample(trim.edgeIndex)]
					if (trim.isReversed) segment.reverse()
					if (
						points.length &&
						distance(points[points.length - 1], segment[segment.length - 1]) <
							distance(points[points.length - 1], segment[0])
					)
						segment.reverse()
					points.push(...(points.length ? segment.slice(1) : segment))
				} finally {
					release(trim)
				}
			}
			if (points.length > 1 && distance(points[0], points[points.length - 1]) < 1e-9) points.pop()
			loops.push({ outer: (loop.loopType as unknown as { value: number }).value === 1, points })
		} finally {
			release(loop)
		}
	}
	return loops.sort((a, b) => Number(b.outer) - Number(a.outer))
}

export function meshRhinoFace(
	face: BrepFace,
	sample: EdgeSampler,
	tolerance: number
): RhinoMeshData | null {
	const surface = face.underlyingSurface()
	try {
		const [u0, u1] = surface.domain(0),
			[v0, v1] = surface.domain(1)
		const origin = surface.pointAt((u0 + u1) / 2, (v0 + v1) / 2)
		const normal = surface.normalAt((u0 + u1) / 2, (v0 + v1) / 2)
		const length = Math.hypot(...normal)
		if (!length || !Number.isFinite(length)) return null
		const n = normal.map((v) => v / length)
		let extent = 0,
			deviation = 0
		// isPlanar() incorrectly accepts curved surfaces in rhino3dm 8.35.0.
		for (let u = 0; u <= 8; u++)
			for (let v = 0; v <= 8; v++) {
				const d = subtract(
					surface.pointAt(u0 + ((u1 - u0) * u) / 8, v0 + ((v1 - v0) * v) / 8),
					origin
				)
				deviation = Math.max(deviation, Math.abs(dot(d, n)))
				extent = Math.max(extent, Math.hypot(...d))
			}
		const loops = faceLoops(face, sample)
		if (!loops.length || !loops[0].outer) return null
		if (deviation <= Math.max(extent * 1e-8, tolerance / 10)) {
			if (loops.some((loop) => loop.points.length < 3)) return null
			const ex = cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])
			const ey = cross(n, ex)
			const vertices: number[] = [],
				flat: number[] = [],
				holes: number[] = []
			for (const loop of loops) {
				if (vertices.length) holes.push(vertices.length / 3)
				for (const p of loop.points) {
					const d = subtract(p, origin)
					flat.push(dot(d, ex), dot(d, ey))
					vertices.push(...p)
				}
			}
			const indices = earcut(flat, holes)
			orient(vertices, indices, face.orientationIsReversed ? n.map((v) => -v) : n)
			return { positions: vertices, indices }
		}
		// Require both directions of boundary agreement. Checking only trim vertices can accept
		// a curved face cut to a small part of its underlying surface and fill the cut-away area.
		if (loops.length !== 1) return null
		const boundaryTolerance = Math.max(tolerance * 2, extent * 1e-4)
		const sides = [
			(t: number) => surface.pointAt(u0 + (u1 - u0) * t, v0),
			(t: number) => surface.pointAt(u1, v0 + (v1 - v0) * t),
			(t: number) => surface.pointAt(u0 + (u1 - u0) * t, v1),
			(t: number) => surface.pointAt(u0, v0 + (v1 - v0) * t),
		].map((pointAt) => sampleCurve(pointAt, 0, 1, boundaryTolerance / 4, 10))
		const near = (p: number[], lines: number[][][]) =>
			lines.some((line) =>
				line.some((a, i) => i > 0 && segmentDistance(p, line[i - 1], a) <= boundaryTolerance)
			)
		const ring = [...loops[0].points, loops[0].points[0]]
		if (
			ring.length < 3 ||
			!ring.every((p) => near(p, sides)) ||
			!sides.every((line) => line.every((p) => near(p, [ring])))
		)
			return null
		return meshRhinoSurface(surface, face.orientationIsReversed)
	} finally {
		release(surface)
	}
}

export function meshRhinoSurface(surface: Surface, reversed = false): RhinoMeshData {
	const [u0, u1] = surface.domain(0),
		[v0, v1] = surface.domain(1)
	const steps = 48
	const positions: number[] = [],
		indices: number[] = []
	for (let u = 0; u <= steps; u++)
		for (let v = 0; v <= steps; v++) {
			positions.push(...surface.pointAt(u0 + ((u1 - u0) * u) / steps, v0 + ((v1 - v0) * v) / steps))
		}
	for (let u = 0; u < steps; u++)
		for (let v = 0; v < steps; v++) {
			const a = u * (steps + 1) + v,
				b = a + steps + 1
			indices.push(a, b, a + 1, a + 1, b, b + 1)
		}
	if (reversed)
		for (let i = 0; i < indices.length; i += 3)
			[indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]]
	return { positions, indices }
}

function orient(positions: number[], indices: number[], normal: number[]) {
	for (let i = 0; i < indices.length; i += 3) {
		const [a, b, c] = indices
			.slice(i, i + 3)
			.map((index) => positions.slice(index * 3, index * 3 + 3))
		if (dot(cross(subtract(b, a), subtract(c, a)), normal) < 0)
			[indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]]
	}
}
