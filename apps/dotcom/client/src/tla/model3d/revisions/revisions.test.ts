import { Model3dCamera } from '@tldraw/dotcom-shared'
import { isCameraAtPose } from './cameraMatch'
import {
	Model3dRect,
	fitCameraToBounds,
	letterbox,
	nextRevisionName,
	placeRevision,
} from './layout'
import { computeContentKey, computeStrokeHash } from './strokeHash'

describe('computeStrokeHash', () => {
	const a = { id: 'shape:a', type: 'draw', x: 1, y: 2, props: { color: 'red', w: 1 }, meta: {} }
	const b = { id: 'shape:b', type: 'arrow', x: 3, y: 4, props: { color: 'blue' }, meta: {} }

	it('is a 64 character hex digest and is deterministic', async () => {
		const hash = await computeStrokeHash([a, b])
		expect(hash).toMatch(/^[0-9a-f]{64}$/)
		expect(await computeStrokeHash([a, b])).toBe(hash)
	})

	it('ignores record order and key order', async () => {
		const reordered = {
			meta: {},
			props: { w: 1, color: 'red' },
			y: 2,
			x: 1,
			type: 'draw',
			id: 'shape:a',
		}
		expect(await computeStrokeHash([b, reordered])).toBe(await computeStrokeHash([a, b]))
	})

	it('ignores meta and lock state', async () => {
		const changed = { ...a, meta: { note: 'x' }, isLocked: true }
		expect(await computeStrokeHash([changed, b])).toBe(await computeStrokeHash([a, b]))
	})

	it('changes when a stroke changes or goes away', async () => {
		const base = await computeStrokeHash([a, b])
		expect(await computeStrokeHash([{ ...a, x: 1.5 }, b])).not.toBe(base)
		expect(await computeStrokeHash([a])).not.toBe(base)
	})
})

describe('placeRevision', () => {
	const model: Model3dRect = { x: 0, y: 0, w: 320, h: 240 }
	const size = { w: 1000, h: 600 }

	it('goes right of the model when the space is free', () => {
		expect(placeRevision(model, size, [model])).toEqual({ x: 360, y: 0 })
	})

	it('steps past overlapping shapes, including ones it reaches after the first step', () => {
		const obstacles = [model, { x: 400, y: 100, w: 200, h: 200 }, { x: 1500, y: 500, w: 50, h: 50 }]
		const { x, y } = placeRevision(model, size, obstacles)
		expect({ x, y }).toEqual({ x: 1590, y: 0 })
		const placed = { x, y, ...size }
		for (const o of obstacles) expect(overlaps(placed, o)).toBe(false)
	})

	it('ignores shapes that are clear of the slot', () => {
		expect(placeRevision(model, size, [model, { x: 400, y: 2000, w: 100, h: 100 }])).toEqual({
			x: 360,
			y: 0,
		})
	})

	function overlaps(p: Model3dRect, o: Model3dRect) {
		return p.x < o.x + o.w && p.x + p.w > o.x && p.y < o.y + o.h && p.y + p.h > o.y
	}
})

describe('nextRevisionName', () => {
	it('numbers views and fills gaps', () => {
		expect(nextRevisionName([])).toBe('View 1')
		expect(nextRevisionName(['View 1', 'View 2'])).toBe('View 3')
		expect(nextRevisionName(['View 2', 'Kitchen'])).toBe('View 1')
	})
})

describe('letterbox', () => {
	it('fills the container when the aspect matches', () => {
		expect(letterbox({ w: 1280, h: 720 }, 1280 / 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 })
	})

	it('adds bars top and bottom for a wider aspect', () => {
		expect(letterbox({ w: 1000, h: 1000 }, 2)).toEqual({ x: 0, y: 250, w: 1000, h: 500 })
	})

	it('adds bars left and right for a taller aspect, on whole pixels', () => {
		expect(letterbox({ w: 1001, h: 500 }, 1)).toEqual({ x: 251, y: 0, w: 500, h: 500 })
	})
})

describe('fitCameraToBounds', () => {
	it('shows a viewport-sized shape at zoom 1 with its corner at the screen origin', () => {
		expect(fitCameraToBounds({ w: 1280, h: 720 }, { x: 400, y: -50, w: 1280, h: 720 })).toEqual({
			x: -400,
			y: 50,
			z: 1,
		})
	})

	it('scales and centers the shape in a resized viewport', () => {
		const bounds = { x: 100, y: 100, w: 1000, h: 500 }
		const camera = fitCameraToBounds({ w: 500, h: 500 }, bounds)
		expect(camera.z).toBe(0.5)
		// Page point (bounds.x, bounds.y) lands at screen (0, 125).
		expect((bounds.x + camera.x) * camera.z).toBeCloseTo(0)
		expect((bounds.y + camera.y) * camera.z).toBeCloseTo(125)
	})
})

describe('isCameraAtPose', () => {
	const pose: Model3dCamera = {
		projection: 'perspective',
		position: [10, 0, 0],
		target: [0, 0, 0],
		up: [0, 1, 0],
		fov: 50,
		aspect: 16 / 9,
	}

	it('matches the pose itself and tiny drift, regardless of aspect', () => {
		expect(isCameraAtPose(pose, pose)).toBe(true)
		expect(isCameraAtPose({ ...pose, position: [10.01, 0, 0], aspect: 1 }, pose)).toBe(true)
	})

	it('rejects moves beyond the threshold', () => {
		expect(isCameraAtPose({ ...pose, position: [10, 0.05, 0] }, pose)).toBe(false)
		expect(isCameraAtPose({ ...pose, target: [0, 0, 0.05] }, pose)).toBe(false)
		expect(isCameraAtPose({ ...pose, up: [0.1, 1, 0] }, pose)).toBe(false)
		expect(isCameraAtPose({ ...pose, fov: 52 }, pose)).toBe(false)
	})

	it('scales the threshold with the orbit distance', () => {
		const far = { ...pose, position: [1000, 0, 0] as [number, number, number] }
		expect(isCameraAtPose({ ...far, position: [1000, 1, 0] }, far)).toBe(true)
		expect(isCameraAtPose({ ...far, position: [1000, 3, 0] }, far)).toBe(false)
	})
})

describe('computeContentKey', () => {
	const a = { id: 'shape:a', type: 'draw', x: 1, y: 2, props: { color: 'red' }, meta: {} }
	const b = { id: 'shape:b', type: 'arrow', x: 3, y: 4, props: { color: 'blue' }, meta: {} }

	it('ignores record order, key order, locking and meta', () => {
		const key = computeContentKey([a, b])
		const lockedB = { ...b, isLocked: true, meta: { x: 1 } }
		const reorderedA = {
			meta: {},
			props: { color: 'red' },
			y: 2,
			x: 1,
			type: 'draw',
			id: 'shape:a',
		}
		expect(computeContentKey([b, a])).toBe(key)
		expect(computeContentKey([lockedB, a])).toBe(key)
		expect(computeContentKey([reorderedA, b])).toBe(key)
	})

	it('changes when any record changes, is added or is removed', () => {
		const key = computeContentKey([a, b])
		const movedA = { ...a, x: 1.5 }
		const c = { ...b, id: 'shape:c' }
		expect(computeContentKey([movedA, b])).not.toBe(key)
		expect(computeContentKey([a])).not.toBe(key)
		expect(computeContentKey([a, b, c])).not.toBe(key)
		expect(computeContentKey([])).not.toBe(key)
	})
})
