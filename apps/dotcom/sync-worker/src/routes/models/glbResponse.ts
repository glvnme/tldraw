// The GLB of a model never changes once it is ready (a re-conversion is a new model), so the browser
// may keep it for good; `private` because it is only served to members of the workspace.
const GLB_CACHE_CONTROL = 'private, max-age=31536000, immutable'

/**
 * The response for `bucket.get(key, { range: request.headers, onlyIf: request.headers })`. R2 has
 * already resolved the range and the conditional; this turns its answer into status and headers.
 */
export function buildGlbResponse(object: R2Object | R2ObjectBody, request: Request): Response {
	const headers = new Headers({
		'content-type': 'model/gltf-binary',
		'cache-control': GLB_CACHE_CONTROL,
		'accept-ranges': 'bytes',
		etag: object.httpEtag,
		vary: 'authorization',
	})
	// R2 answers a failed precondition with the object's metadata and no body.
	if (!('body' in object) || !object.body) {
		return new Response(null, {
			status: failedPreconditionStatus(object, request.headers),
			headers,
		})
	}

	const range = request.headers.has('range') ? resolveRange(object.range, object.size) : null
	if (!range) {
		headers.set('content-length', String(object.size))
		return new Response(object.body, { status: 200, headers })
	}
	headers.set('content-length', String(range.length))
	headers.set(
		'content-range',
		`bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`
	)
	return new Response(object.body, { status: 206, headers })
}

/**
 * R2 does not say which precondition failed. RFC 9110 section 13.2.2 evaluates If-Match (or else
 * If-Unmodified-Since) first and answers 412; only once those pass does a failed If-None-Match or
 * If-Modified-Since mean the cached copy is current, which is a 304.
 */
export function failedPreconditionStatus(object: R2Object, headers: Headers): 304 | 412 {
	const ifMatch = headers.get('if-match')
	if (ifMatch !== null) {
		const tags = ifMatch.split(',').map((tag) => tag.trim())
		if (!tags.includes('*') && !tags.includes(object.httpEtag)) return 412
	} else {
		const since = Date.parse(headers.get('if-unmodified-since') ?? '')
		// HTTP dates have whole-second precision.
		if (Number.isFinite(since) && Math.floor(object.uploaded.getTime() / 1000) * 1000 > since) {
			return 412
		}
	}
	return 304
}

export function resolveRange(
	range: R2Range | undefined,
	size: number
): { offset: number; length: number } | null {
	if (!range) return null
	if ('suffix' in range && range.suffix !== undefined) {
		const length = Math.min(range.suffix, size)
		return { offset: size - length, length }
	}
	const offset = 'offset' in range && range.offset !== undefined ? range.offset : 0
	const length =
		'length' in range && range.length !== undefined
			? Math.min(range.length, size - offset)
			: size - offset
	return { offset, length }
}

export function rangeNotSatisfiable(size: number | null): Response {
	return new Response(null, {
		status: 416,
		headers: size === null ? {} : { 'content-range': `bytes */${size}` },
	})
}
