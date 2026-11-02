import type { Model3dCamera, Model3dVec3 } from '@tldraw/dotcom-shared'

// Relative to the pose's orbit distance: 0.2% is about two pixels on a 1000 px tall view at 50°.
export const CAMERA_MATCH_TOLERANCE = 0.002

/** Whether the camera still shows the pose closely enough for the overlay to line up. */
export function isCameraAtPose(
	camera: Model3dCamera,
	pose: Model3dCamera,
	tolerance = CAMERA_MATCH_TOLERANCE
) {
	if (camera.projection !== pose.projection) return false
	const reach = distance(pose.position, pose.target) || 1
	if (distance(camera.position, pose.position) > reach * tolerance) return false
	if (distance(camera.target, pose.target) > reach * tolerance) return false
	if (distance(normalize(camera.up), normalize(pose.up)) > tolerance) return false
	if (camera.projection === 'perspective' && pose.projection === 'perspective') {
		return Math.abs(camera.fov - pose.fov) <= pose.fov * tolerance
	}
	if (camera.projection === 'orthographic' && pose.projection === 'orthographic') {
		return Math.abs(camera.viewHeight - pose.viewHeight) <= pose.viewHeight * tolerance
	}
	return false
}

function distance(a: Model3dVec3, b: Model3dVec3) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function normalize(v: Model3dVec3): Model3dVec3 {
	const length = Math.hypot(v[0], v[1], v[2]) || 1
	return [v[0] / length, v[1] / length, v[2] / length]
}
