// @vitest-environment node
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { childEnv, sceneToGlb, type MassingScene } from './image-to-3d-agents'
import { isImageFile } from './vite-image-to-3d-plugin'

describe('isImageFile', () => {
	it('accepts real image headers and rejects anything else', () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
		const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')
		expect([
			isImageFile(png, 'image/png'),
			isImageFile(jpeg, 'image/jpeg'),
			isImageFile(webp, 'image/webp'),
			isImageFile(Buffer.from('not an image'), 'image/png'),
			isImageFile(jpeg, 'image/png'),
		]).toEqual([true, true, true, false, false])
	})
})

describe('childEnv', () => {
	it('keeps provider keys and the parent Claude session away from the agents', () => {
		expect(
			childEnv({
				PATH: '/usr/bin',
				HOME: '/home/victor',
				FAL_KEY: 'secret',
				FAL_KEY_FILE: '/secrets/fal',
				WORLDLABS_API_KEY_FILE: '/secrets/worldlabs',
				CLAUDECODE: '1',
			})
		).toEqual({ PATH: '/usr/bin', HOME: '/home/victor' })
	})
})

type Part = MassingScene['parts'][number]

const part = (overrides: Partial<Part>): Part => ({
	label: 'part',
	kind: 'box',
	position: [0, 0, 0],
	rotation: [0, 0, 0],
	size: [1, 1, 1],
	footprint: [],
	color: '#cccccc',
	...overrides,
})

async function load(glb: Buffer) {
	const gltf = await new GLTFLoader().parseAsync(
		glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
		''
	)
	const names: string[] = []
	gltf.scene.traverse((object) => {
		if ('isMesh' in object) names.push(object.name)
	})
	const box = new Box3().setFromObject(gltf.scene)
	const round = (values: number[]) => values.map((value) => Math.round(value * 1000) / 1000 + 0)
	return {
		names,
		min: round(box.min.toArray()),
		size: round(box.getSize(new Vector3()).toArray()),
	}
}

describe('sceneToGlb', () => {
	it('builds every part at its real size, resting on its base', async () => {
		const { glb, skipped } = await sceneToGlb({
			name: 'house',
			notes: '',
			parts: [
				part({ label: 'walls', size: [10, 6, 8], color: '#e8dcc8' }),
				part({ label: 'roof', kind: 'gable', position: [0, 6, 0], size: [10, 3, 8] }),
				part({
					label: 'terrace',
					kind: 'extrusion',
					position: [5, 0, 0],
					size: [0, 0.5, 0],
					footprint: [
						[0, -4],
						[4, -4],
						[4, 4],
						[0, 4],
					],
				}),
			],
		})
		expect(skipped).toEqual([])
		const loaded = await load(glb)
		expect(loaded.names).toEqual(['walls', 'roof', 'terrace'])
		expect(loaded.min).toEqual([-5, 0, -4])
		expect(loaded.size).toEqual([14, 9, 8])
	})

	it('leaves out malformed parts instead of failing the whole run', async () => {
		const { glb, skipped } = await sceneToGlb({
			name: 'site',
			notes: '',
			parts: [
				part({ label: 'slab', size: [20, 0.2, 20] }),
				part({
					label: 'two points',
					kind: 'extrusion',
					footprint: [
						[0, 0],
						[1, 1],
					],
				}),
				part({
					label: 'on a line',
					kind: 'extrusion',
					footprint: [
						[0, 0],
						[1, 0],
						[2, 0],
					],
				}),
			],
		})
		expect(skipped).toEqual(['two points', 'on a line'])
		expect((await load(glb)).names).toEqual(['slab'])
	})

	it('fails when no part can be built', async () => {
		await expect(
			sceneToGlb({
				name: 'empty',
				notes: '',
				parts: [
					part({
						label: 'line',
						kind: 'extrusion',
						footprint: [
							[0, 0],
							[1, 1],
						],
					}),
				],
			})
		).rejects.toThrow('None of the parts could be built.')
	})
})
