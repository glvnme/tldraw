// Locking on publish and `meta` writes must not change the hash of an otherwise identical stroke set.
const VOLATILE_KEYS = new Set(['meta', 'isLocked'])

/** SHA-256 hex over the records, independent of their order and of object key order. */
export async function computeStrokeHash(records: readonly { id: string }[]) {
	const json = serializeRecords(records)
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A synchronous FNV-1a key over the same serialization as `computeStrokeHash`. Cheap enough to
 * run on every change; for cache keys only, not for the published `strokeHash`.
 */
export function computeContentKey(records: readonly { id: string }[]) {
	const json = serializeRecords(records)
	let hash = 0x811c9dc5
	for (let i = 0; i < json.length; i++) {
		hash ^= json.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return `${records.length}:${json.length}:${(hash >>> 0).toString(16)}`
}

function serializeRecords(records: readonly { id: string }[]) {
	const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	return stableStringify(sorted.map(omitVolatile))
}

function omitVolatile(record: object) {
	return Object.fromEntries(Object.entries(record).filter(([key]) => !VOLATILE_KEYS.has(key)))
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}
