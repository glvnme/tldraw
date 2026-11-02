import { Model3dCamera } from './camera'

/** What the 3D overlay exposes to the revision flow. */
export interface ViewerHandle {
	/** Reads the WebGL canvas at viewport size times device pixel ratio. */
	captureFrame(): Promise<{ blob: Blob; width: number; height: number; dpr: number }>
	getCamera(): Model3dCamera
	setCamera(camera: Model3dCamera, opts?: { animate?: boolean }): void
	/** Returns an unsubscribe function. */
	onCameraChange(cb: (camera: Model3dCamera) => void): () => void
	pause(): void
	resume(): void
}
