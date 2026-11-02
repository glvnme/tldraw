import { Model3dCamera } from '@tldraw/dotcom-shared'
import { getFromLocalStorage } from 'tldraw'
import {
	getModel3dCameraStorageKey,
	loadLastModel3dCamera,
	parseModel3dCamera,
	saveLastModel3dCamera,
	serializeModel3dCamera,
} from './cameraStorage'

const perspective: Model3dCamera = {
	projection: 'perspective',
	position: [12.5, 3.25, -8.125],
	target: [0, 1, 0],
	up: [0, 1, 0],
	fov: 50,
	aspect: 1.6,
}

const orthographic: Model3dCamera = {
	projection: 'orthographic',
	position: [0, 10, 0],
	target: [0, 0, 0],
	up: [0, 0, -1],
	viewHeight: 24,
	aspect: 0.75,
}

describe('model3d camera storage', () => {
	it.each([perspective, orthographic])('round trips a $projection camera', (camera) => {
		expect(parseModel3dCamera(serializeModel3dCamera(camera))).toEqual(camera)
	})

	it('rejects missing, malformed and invalid values', () => {
		expect(parseModel3dCamera(null)).toBeNull()
		expect(parseModel3dCamera('{')).toBeNull()
		expect(parseModel3dCamera(JSON.stringify({ ...perspective, position: [1, 2] }))).toBeNull()
	})

	it('keys the last camera by model', () => {
		saveLastModel3dCamera('model-a', null, perspective)
		expect(getFromLocalStorage(getModel3dCameraStorageKey('model-a', null))).not.toBeNull()
		expect(loadLastModel3dCamera('model-a', null)).toEqual(perspective)
		expect(loadLastModel3dCamera('model-b', null)).toBeNull()
	})

	it('keys the last camera by user when there is one', () => {
		expect(getModel3dCameraStorageKey('model-a', 'user-1')).toBe(
			'tldraw-model3d-camera:user-1:model-a'
		)
		expect(getModel3dCameraStorageKey('model-a', null)).toBe('tldraw-model3d-camera:model-a')
		saveLastModel3dCamera('model-c', 'user-1', orthographic)
		expect(loadLastModel3dCamera('model-c', 'user-1')).toEqual(orthographic)
		expect(loadLastModel3dCamera('model-c', 'user-2')).toBeNull()
		expect(loadLastModel3dCamera('model-c', null)).toBeNull()
	})
})
