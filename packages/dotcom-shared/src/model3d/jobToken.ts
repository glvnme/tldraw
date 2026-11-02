// Token format: `<expiresAt>.<jobId>.<base64url HMAC-SHA256 over [modelId, jobId, expiresAt]>`. The
// model id is bound into the signature but not carried, so a token for one model never verifies for
// another. The job id names the conversion attempt; the worker refuses writes from a stale one.

const encoder = new TextEncoder()

function importKey(secret: string, usage: 'sign' | 'verify') {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		[usage]
	)
}

const JOB_ID = /^[A-Za-z0-9_-]+$/

function message(modelId: string, jobId: string, expiresAt: number) {
	return encoder.encode(JSON.stringify([modelId, jobId, expiresAt]))
}

function toBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	let binary: string
	try {
		binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
	} catch {
		return null
	}
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

export async function signModel3dJobToken(
	secret: string,
	modelId: string,
	jobId: string,
	expiresAt: number
): Promise<string> {
	if (!JOB_ID.test(jobId)) throw new Error(`Invalid job id: ${jobId}`)
	const key = await importKey(secret, 'sign')
	const signature = await crypto.subtle.sign('HMAC', key, message(modelId, jobId, expiresAt))
	return `${expiresAt}.${jobId}.${toBase64Url(new Uint8Array(signature))}`
}

/** The job id the token was signed for, or null if it is invalid or expired. */
export async function verifyModel3dJobToken(
	secret: string,
	token: string,
	modelId: string,
	now = Date.now()
): Promise<string | null> {
	const match = /^(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token)
	if (!match) return null
	const expiresAt = Number(match[1])
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null
	const jobId = match[2]
	const signature = fromBase64Url(match[3])
	if (!signature) return null
	const key = await importKey(secret, 'verify')
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		signature,
		message(modelId, jobId, expiresAt)
	)
	return valid ? jobId : null
}
