import { describe, expect, it } from 'vitest'
import { buildGlbResponse, rangeNotSatisfiable, resolveRange } from './glbResponse'

const SIZE = 1000

function object(range?: R2Range, withBody = true) {
	return {
		size: SIZE,
		httpEtag: '"etag-1"',
		range,
		...(withBody ? { body: new Blob([new Uint8Array(range ? 10 : SIZE)]).stream() } : null),
	} as unknown as R2ObjectBody
}

function request(headers: Record<string, string> = {}) {
	return new Request('https://worker.test/app/models/m1/glb', { headers })
}

describe('resolveRange', () => {
	it('resolves offset and length', () => {
		expect(resolveRange({ offset: 100, length: 50 }, SIZE)).toEqual({ offset: 100, length: 50 })
	})

	it('resolves an open-ended range to the end of the object', () => {
		expect(resolveRange({ offset: 900 }, SIZE)).toEqual({ offset: 900, length: 100 })
	})

	it('resolves a suffix range, clamped to the object', () => {
		expect(resolveRange({ suffix: 200 }, SIZE)).toEqual({ offset: 800, length: 200 })
		expect(resolveRange({ suffix: 5000 }, SIZE)).toEqual({ offset: 0, length: SIZE })
	})

	it('clamps a length past the end', () => {
		expect(resolveRange({ offset: 990, length: 100 }, SIZE)).toEqual({ offset: 990, length: 10 })
	})
})

describe('buildGlbResponse', () => {
	it('serves the whole object with cache and range headers', () => {
		const response = buildGlbResponse(object(), request())
		expect(response.status).toBe(200)
		expect(Object.fromEntries(response.headers)).toEqual({
			'accept-ranges': 'bytes',
			'cache-control': 'private, max-age=31536000, immutable',
			'content-length': String(SIZE),
			'content-type': 'model/gltf-binary',
			etag: '"etag-1"',
			vary: 'authorization',
		})
	})

	it('answers a range request with 206 and Content-Range', () => {
		const response = buildGlbResponse(
			object({ offset: 10, length: 10 }),
			request({ range: 'bytes=10-19' })
		)
		expect(response.status).toBe(206)
		expect(response.headers.get('content-range')).toBe('bytes 10-19/1000')
		expect(response.headers.get('content-length')).toBe('10')
	})

	it('answers a suffix range from the end of the object', () => {
		const response = buildGlbResponse(object({ suffix: 10 }), request({ range: 'bytes=-10' }))
		expect(response.status).toBe(206)
		expect(response.headers.get('content-range')).toBe('bytes 990-999/1000')
	})

	it('ignores a range R2 reports when the request had none', () => {
		expect(buildGlbResponse(object({ offset: 0, length: 10 }), request()).status).toBe(200)
	})

	it('answers 304 when R2 reports the If-None-Match precondition failed', () => {
		const response = buildGlbResponse(
			object(undefined, false),
			request({ 'if-none-match': '"etag-1"' })
		)
		expect(response.status).toBe(304)
		expect(response.headers.get('etag')).toBe('"etag-1"')
	})

	it('answers 412 for any other failed precondition', () => {
		expect(buildGlbResponse(object(undefined, false), request({ 'if-match': '"x"' })).status).toBe(
			412
		)
	})
})

describe('rangeNotSatisfiable', () => {
	it('reports the object size', () => {
		const response = rangeNotSatisfiable(SIZE)
		expect(response.status).toBe(416)
		expect(response.headers.get('content-range')).toBe('bytes */1000')
	})
})
