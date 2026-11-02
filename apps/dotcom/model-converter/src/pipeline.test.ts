import { describe, expect, it } from 'vitest'
import { convertModel } from './pipeline'

const LIMITS = { maxSourceBytes: 1e6, maxGlbBytes: 1e6, maxTriangles: 1e6, timeoutMs: 1e4 }

function glbWithJson(json: object) {
	const text = new TextEncoder().encode(JSON.stringify(json).padEnd(64, ' '))
	const bytes = new Uint8Array(12 + 8 + text.length)
	const view = new DataView(bytes.buffer)
	view.setUint32(0, 0x46546c67, true)
	view.setUint32(4, 2, true)
	view.setUint32(8, bytes.length, true)
	view.setUint32(12, text.length, true)
	view.setUint32(16, 0x4e4f534a, true)
	bytes.set(text, 20)
	return bytes
}

describe('convertModel', () => {
	it('refuses a Draco-compressed GLB with its own code', async () => {
		const source = glbWithJson({
			asset: { version: '2.0' },
			extensionsUsed: ['KHR_draco_mesh_compression'],
		})
		await expect(convertModel(source, 'glb', LIMITS)).rejects.toMatchObject({
			code: 'draco_unsupported',
		})
	})
})
