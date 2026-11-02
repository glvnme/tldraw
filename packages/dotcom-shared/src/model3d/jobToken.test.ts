import { describe, expect, it } from 'vitest'
import { signModel3dJobToken, verifyModel3dJobToken } from './jobToken'

const secret = 'test-secret'
const now = 1_700_000_000_000
const expiresAt = now + 60_000

describe('model3d job token', () => {
	it('verifies a token for the model it was signed for', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', expiresAt)
		expect(await verifyModel3dJobToken(secret, token, 'model-1', now)).toBe(true)
	})

	it('rejects a token for another model or secret', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', expiresAt)
		expect(await verifyModel3dJobToken(secret, token, 'model-2', now)).toBe(false)
		expect(await verifyModel3dJobToken('other-secret', token, 'model-1', now)).toBe(false)
	})

	it('rejects a tampered signature or expiry', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', expiresAt)
		const [expiry, signature] = token.split('.')
		const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
		expect(await verifyModel3dJobToken(secret, `${expiry}.${flipped}`, 'model-1', now)).toBe(false)
		expect(
			await verifyModel3dJobToken(secret, `${expiresAt + 1}.${signature}`, 'model-1', now)
		).toBe(false)
	})

	it('rejects an expired token', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', expiresAt)
		expect(await verifyModel3dJobToken(secret, token, 'model-1', expiresAt)).toBe(false)
	})

	it('rejects malformed tokens', async () => {
		for (const token of ['', 'abc', '123.', '.abc', '123.a', '123.abc.def', '-1.abc']) {
			expect(await verifyModel3dJobToken(secret, token, 'model-1', now)).toBe(false)
		}
	})
})
