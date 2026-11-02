// Locking on publish and `meta` writes must not change the hash of an otherwise identical stroke set.
const VOLATILE_KEYS = new Set(['meta', 'isLocked'])

/** SHA-256 hex over the records, independent of their order and of object key order. */
export async function computeStrokeHash(records: readonly { id: string }[]) {
	const json = computeContentKey(records)
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The canonical form `computeStrokeHash` digests, used as is for cache keys. */
export function computeContentKey(records: readonly { id: string }[]) {
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
