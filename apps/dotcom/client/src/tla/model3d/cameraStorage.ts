import { Model3dCamera, model3dCameraValidator } from '@tldraw/dotcom-shared'
import { getFromLocalStorage, setInLocalStorage } from 'tldraw'

/** Per user when signed in, so two accounts in one browser keep their own views. */
export function getModel3dCameraStorageKey(modelId: string, userId: string | null) {
	return userId ? `tldraw-model3d-camera:${userId}:${modelId}` : `tldraw-model3d-camera:${modelId}`
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

export function loadLastModel3dCamera(modelId: string, userId: string | null) {
	return parseModel3dCamera(getFromLocalStorage(getModel3dCameraStorageKey(modelId, userId)))
}

export function saveLastModel3dCamera(
	modelId: string,
	userId: string | null,
	camera: Model3dCamera
) {
	setInLocalStorage(getModel3dCameraStorageKey(modelId, userId), serializeModel3dCamera(camera))
}
