import { T } from '@tldraw/validate'

/** World-space [x, y, z], float64. */
export type Model3dVec3 = [number, number, number]

/**
 * A viewpoint that maps 1:1 onto a BCF 3.0 `perspective_camera` or `orthographic_camera`.
 * BCF stores a direction rather than a target; derive it as `target - position`.
 */
export type Model3dCamera =
	| {
			projection: 'perspective'
			position: Model3dVec3
			target: Model3dVec3
			up: Model3dVec3
			/** Vertical field of view in degrees, BCF `field_of_view`. */
			fov: number
			aspect: number
	  }
	| {
			projection: 'orthographic'
			position: Model3dVec3
			target: Model3dVec3
			up: Model3dVec3
			/** World units visible vertically, BCF `view_to_world_scale`. */
			viewHeight: number
			aspect: number
	  }

export const model3dVec3Validator = T.arrayOf(T.number).refine((v) => {
	if (v.length !== 3) throw new T.ValidationError(`Expected 3 components, got ${v.length}`)
	return v as Model3dVec3
})

export const model3dCameraValidator: T.Validator<Model3dCamera> = T.union('projection', {
	perspective: T.object({
		projection: T.literal('perspective'),
		position: model3dVec3Validator,
		target: model3dVec3Validator,
		up: model3dVec3Validator,
		fov: T.nonZeroNumber,
		aspect: T.nonZeroNumber,
	}),
	orthographic: T.object({
		projection: T.literal('orthographic'),
		position: model3dVec3Validator,
		target: model3dVec3Validator,
		up: model3dVec3Validator,
		viewHeight: T.nonZeroNumber,
		aspect: T.nonZeroNumber,
	}),
})
