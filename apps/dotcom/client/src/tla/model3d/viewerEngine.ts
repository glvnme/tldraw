import type { Model3dCamera, ViewerHandle } from '@tldraw/dotcom-shared'
import {
	Box3,
	Color,
	DirectionalLight,
	HemisphereLight,
	MathUtils,
	Mesh,
	Object3D,
	PerspectiveCamera,
	Scene,
	Sphere,
	Texture,
	Vector3,
	WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

// Loaded only through dynamic `import()` from Model3dViewer.tsx so three.js stays out of the main bundle.

export interface Model3dViewerEngine extends ViewerHandle {
	dispose(): void
}

export interface Model3dViewerEngineOptions {
	container: HTMLElement
	glbUrl: string
	token: string | undefined
	initialCamera: Model3dCamera | null
	signal: AbortSignal
	onProgress(loaded: number, total: number): void
	onContextLost(): void
}

const SET_CAMERA_ANIMATION_MS = 450

export async function createModel3dViewerEngine(
	opts: Model3dViewerEngineOptions
): Promise<Model3dViewerEngine> {
	const { container } = opts
	const renderer = new WebGLRenderer({
		powerPreference: 'high-performance',
		antialias: true,
		reversedDepthBuffer: true,
	})
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
	const canvas = renderer.domElement
	canvas.style.display = 'block'
	canvas.style.width = '100%'
	canvas.style.height = '100%'
	container.appendChild(canvas)

	const scene = new Scene()
	scene.background = new Color(0xeceef1)
	const camera = new PerspectiveCamera(50, 1, 0.01, 1000)
	scene.add(camera)
	scene.add(new HemisphereLight(0xffffff, 0x8d8d8d, 1.4))
	// Parented to the camera so the model stays lit from the viewer's side while orbiting.
	const sun = new DirectionalLight(0xffffff, 1.6)
	sun.position.set(1, 2, 0)
	sun.target.position.set(0, 0, -1)
	camera.add(sun, sun.target)

	const controls = new OrbitControls(camera, canvas)
	controls.enableDamping = false

	let disposed = false
	let paused = false
	let frame = 0
	let animation = 0
	const listeners = new Set<(camera: Model3dCamera) => void>()

	const renderNow = () => {
		if (disposed) return
		cancelAnimationFrame(frame)
		frame = 0
		renderer.render(scene, camera)
	}
	const requestRender = () => {
		if (disposed || paused || frame) return
		frame = requestAnimationFrame(renderNow)
	}

	const getCamera = (): Model3dCamera => ({
		projection: 'perspective',
		position: camera.position.toArray(),
		target: controls.target.toArray(),
		up: camera.up.toArray(),
		fov: camera.fov,
		aspect: camera.aspect,
	})
	const emitCameraChange = () => {
		if (listeners.size === 0) return
		const value = getCamera()
		for (const listener of listeners) listener(value)
	}

	controls.addEventListener('start', () => cancelAnimationFrame(animation))
	controls.addEventListener('change', () => {
		requestRender()
		emitCameraChange()
	})

	const resize = () => {
		const { clientWidth: w, clientHeight: h } = container
		// Zero while sketch mode hides the overlay.
		if (!w || !h) return
		renderer.setSize(w, h, false)
		camera.aspect = w / h
		camera.updateProjectionMatrix()
		if (!paused) renderNow()
	}
	const resizeObserver = new ResizeObserver(resize)
	resizeObserver.observe(container)

	const onContextLost = (e: Event) => {
		e.preventDefault()
		if (!disposed) opts.onContextLost()
	}
	canvas.addEventListener('webglcontextlost', onContextLost)

	const dispose = () => {
		if (disposed) return
		disposed = true
		cancelAnimationFrame(frame)
		cancelAnimationFrame(animation)
		listeners.clear()
		resizeObserver.disconnect()
		canvas.removeEventListener('webglcontextlost', onContextLost)
		disposeObject(scene)
		controls.dispose()
		renderer.dispose()
		renderer.forceContextLoss()
		canvas.remove()
	}

	let model: Object3D
	try {
		const loader = new GLTFLoader()
		loader.setMeshoptDecoder(MeshoptDecoder)
		if (opts.token) loader.setRequestHeader({ Authorization: `Bearer ${opts.token}` })
		const gltf = await loader.loadAsync(opts.glbUrl, (e) => opts.onProgress(e.loaded, e.total))
		model = gltf.scene
	} catch (e) {
		dispose()
		throw e
	}
	scene.add(model)
	if (opts.signal.aborted) {
		dispose()
		throw opts.signal.reason
	}

	const sphere = new Box3().setFromObject(model).getBoundingSphere(new Sphere())
	const radius = sphere.radius > 0 ? sphere.radius : 1
	camera.near = radius / 1000
	camera.far = radius * 1000
	controls.maxDistance = radius * 100

	const applyCamera = (value: Model3dCamera) => {
		camera.up.fromArray(value.up)
		controls.target.fromArray(value.target)
		camera.position.fromArray(value.position)
		if (value.projection === 'perspective') {
			camera.fov = value.fov
		} else {
			// Frame the same view height with the perspective camera.
			const distance = value.viewHeight / 2 / Math.tan(MathUtils.degToRad(camera.fov / 2))
			const dir = camera.position.clone().sub(controls.target).normalize()
			camera.position.copy(controls.target).addScaledVector(dir, distance)
		}
		camera.updateProjectionMatrix()
		controls.update()
	}

	resize()
	if (opts.initialCamera) {
		applyCamera(opts.initialCamera)
	} else {
		fitCamera(camera, controls.target, sphere.center, radius)
		controls.update()
	}
	renderNow()

	return {
		captureFrame() {
			return new Promise((resolve, reject) => {
				// Without preserveDrawingBuffer the frame is only readable in the task that drew it.
				renderNow()
				canvas.toBlob((blob) => {
					if (!blob) return reject(new Error('Could not capture the 3D view'))
					resolve({
						blob,
						width: canvas.width,
						height: canvas.height,
						dpr: renderer.getPixelRatio(),
					})
				}, 'image/png')
			})
		},
		getCamera,
		setCamera(value, { animate = false } = {}) {
			cancelAnimationFrame(animation)
			if (!animate) {
				applyCamera(value)
				requestRender()
				emitCameraChange()
				return
			}
			const from = getCamera()
			const start = performance.now()
			const step = (now: number) => {
				const t = Math.min(1, (now - start) / SET_CAMERA_ANIMATION_MS)
				applyCamera(t < 1 ? lerpCamera(from, value, t * t * (3 - 2 * t)) : value)
				renderNow()
				emitCameraChange()
				if (t < 1) animation = requestAnimationFrame(step)
			}
			animation = requestAnimationFrame(step)
		},
		onCameraChange(cb) {
			listeners.add(cb)
			return () => listeners.delete(cb)
		},
		pause() {
			paused = true
			controls.enabled = false
			cancelAnimationFrame(frame)
			frame = 0
		},
		resume() {
			paused = false
			controls.enabled = true
			resize()
		},
		dispose,
	}
}

function fitCamera(camera: PerspectiveCamera, target: Vector3, center: Vector3, radius: number) {
	const vertical = MathUtils.degToRad(camera.fov)
	const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect)
	const distance = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.05
	target.copy(center)
	camera.position.copy(center).addScaledVector(new Vector3(1, 0.7, 1).normalize(), distance)
	camera.lookAt(center)
	camera.updateProjectionMatrix()
}

function lerpCamera(a: Model3dCamera, b: Model3dCamera, t: number): Model3dCamera {
	const lerp3 = (x: number[], y: number[]) =>
		[0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as [number, number, number]
	const fov = (c: Model3dCamera) => (c.projection === 'perspective' ? c.fov : 50)
	return {
		projection: 'perspective',
		position: lerp3(a.position, b.position),
		target: lerp3(a.target, b.target),
		up: lerp3(a.up, b.up),
		fov: fov(a) + (fov(b) - fov(a)) * t,
		aspect: b.aspect,
	}
}

function disposeObject(root: Object3D) {
	root.traverse((obj) => {
		const mesh = obj as Mesh
		mesh.geometry?.dispose()
		const materials = mesh.material ? [mesh.material].flat() : []
		for (const material of materials) {
			for (const value of Object.values(material)) {
				if (value instanceof Texture) value.dispose()
			}
			material.dispose()
		}
	})
}
