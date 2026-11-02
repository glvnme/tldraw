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
		saveLastModel3dCamera('model-a', perspective)
		expect(getFromLocalStorage(getModel3dCameraStorageKey('model-a'))).not.toBeNull()
		expect(loadLastModel3dCamera('model-a')).toEqual(perspective)
		expect(loadLastModel3dCamera('model-b')).toBeNull()
	})
})
