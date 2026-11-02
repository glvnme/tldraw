// Token format: `<expiresAt>.<base64url HMAC-SHA256 over [modelId, expiresAt]>`. The model id is
// bound into the signature but not carried, so a token for one model never verifies for another.

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

function message(modelId: string, expiresAt: number) {
	return encoder.encode(JSON.stringify([modelId, expiresAt]))
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
	expiresAt: number
): Promise<string> {
	const key = await importKey(secret, 'sign')
	const signature = await crypto.subtle.sign('HMAC', key, message(modelId, expiresAt))
	return `${expiresAt}.${toBase64Url(new Uint8Array(signature))}`
}

export async function verifyModel3dJobToken(
	secret: string,
	token: string,
	modelId: string,
	now = Date.now()
): Promise<boolean> {
	const match = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(token)
	if (!match) return false
	const expiresAt = Number(match[1])
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false
	const signature = fromBase64Url(match[2])
	if (!signature) return false
	const key = await importKey(secret, 'verify')
	return crypto.subtle.verify('HMAC', key, signature, message(modelId, expiresAt))
}
