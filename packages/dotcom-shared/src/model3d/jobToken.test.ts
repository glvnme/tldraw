import { describe, expect, it } from 'vitest'
import { signModel3dJobToken, verifyModel3dJobToken } from './jobToken'

const secret = 'test-secret'
const now = 1_700_000_000_000
const expiresAt = now + 60_000

describe('model3d job token', () => {
	it('verifies a token for the model it was signed for and yields its job id', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', 'job-1', expiresAt)
		expect(await verifyModel3dJobToken(secret, token, 'model-1', now)).toBe('job-1')
	})

	it('rejects a token for another model or secret', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', 'job-1', expiresAt)
		expect(await verifyModel3dJobToken(secret, token, 'model-2', now)).toBeNull()
		expect(await verifyModel3dJobToken('other-secret', token, 'model-1', now)).toBeNull()
	})

	it('rejects a tampered signature, job id or expiry', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', 'job-1', expiresAt)
		const [expiry, jobId, signature] = token.split('.')
		const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
		for (const tampered of [
			`${expiry}.${jobId}.${flipped}`,
			`${expiry}.job-2.${signature}`,
			`${expiresAt + 1}.${jobId}.${signature}`,
		]) {
			expect(await verifyModel3dJobToken(secret, tampered, 'model-1', now)).toBeNull()
		}
	})

	it('rejects an expired token', async () => {
		const token = await signModel3dJobToken(secret, 'model-1', 'job-1', expiresAt)
		expect(await verifyModel3dJobToken(secret, token, 'model-1', expiresAt)).toBeNull()
	})

	it('rejects malformed tokens', async () => {
		for (const token of ['', 'abc', '123.', '.abc', '123.a', '123.abc', '123..def', '-1.a.b']) {
			expect(await verifyModel3dJobToken(secret, token, 'model-1', now)).toBeNull()
		}
	})

	it('refuses to sign a job id that would break the token format', async () => {
		await expect(signModel3dJobToken(secret, 'model-1', 'a.b', expiresAt)).rejects.toThrow()
	})
})
