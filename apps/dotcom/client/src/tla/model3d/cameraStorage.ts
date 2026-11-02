import { Model3dCamera, model3dCameraValidator } from '@tldraw/dotcom-shared'
import { getFromLocalStorage, setInLocalStorage } from 'tldraw'

export function getModel3dCameraStorageKey(modelId: string) {
	return `tldraw-model3d-camera:${modelId}`
}

export function serializeModel3dCamera(camera: Model3dCamera) {
	return JSON.stringify(camera)
}

export function parseModel3dCamera(value: string | null): Model3dCamera | null {
	if (!value) return null
	try {
		return model3dCameraValidator.validate(JSON.parse(value))
	} catch {
		return null
	}
}

export function loadLastModel3dCamera(modelId: string) {
	return parseModel3dCamera(getFromLocalStorage(getModel3dCameraStorageKey(modelId)))
}

export function saveLastModel3dCamera(modelId: string, camera: Model3dCamera) {
	setInLocalStorage(getModel3dCameraStorageKey(modelId), serializeModel3dCamera(camera))
}
