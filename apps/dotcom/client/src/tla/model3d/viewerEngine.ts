import type { Model3dCamera, ViewerHandle } from '@tldraw/dotcom-shared'
import {
	Box3,
	DirectionalLight,
	HemisphereLight,
	LoadingManager,
	MathUtils,
	Mesh,
	MOUSE,
	TOUCH,
	Object3D,
	OrthographicCamera,
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
import { fetch } from 'tldraw'

// Loaded only through dynamic `import()` from Model3dViewer.tsx so three.js stays out of the main bundle.

export interface Model3dViewerEngine extends ViewerHandle {
	fit(): void
	setNavigation(mode: 'orbit' | 'pan'): void
	dispose(): void
}

export interface Model3dViewerEngineOptions {
	container: HTMLElement
	glbUrl: string
	token: string | undefined
	initialCamera: Model3dCamera | null
	/** Aborting disposes the engine at once, whether it is still loading or not. */
	signal: AbortSignal
	onProgress(loaded: number, total: number): void
	onContextLost(): void
}

const SET_CAMERA_ANIMATION_MS = 450

export async function createModel3dViewerEngine(
	opts: Model3dViewerEngineOptions
): Promise<Model3dViewerEngine> {
	const { container, signal } = opts
	signal.throwIfAborted()
	const renderer = new WebGLRenderer({
		powerPreference: 'high-performance',
		antialias: true,
		alpha: true,
		reversedDepthBuffer: true,
	})
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
	const canvas = renderer.domElement
	canvas.style.display = 'block'
	canvas.style.width = '100%'
	canvas.style.height = '100%'
	container.appendChild(canvas)

	const scene = new Scene()
	const initialCamera = new PerspectiveCamera(50, 1, 0.01, 1000)
	let camera: PerspectiveCamera | OrthographicCamera = initialCamera
	let aspect = 1
	scene.add(camera)
	scene.add(new HemisphereLight(0xffffff, 0x8d8d8d, 1.4))
	// Parented to the camera so the model stays lit from the viewer's side while orbiting.
	const sun = new DirectionalLight(0xffffff, 1.6)
	sun.position.set(1, 2, 0)
	sun.target.position.set(0, 0, -1)
	camera.add(sun, sun.target)

	let disposed = false
	let paused = false
	let frame = 0
	let animation = 0
	let navigation: 'orbit' | 'pan' = 'orbit'
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

	const getCamera = (): Model3dCamera => {
		const base = {
			position: camera.position.toArray(),
			target: controls.target.toArray(),
			up: camera.up.toArray(),
			aspect,
		}
		return camera instanceof PerspectiveCamera
			? { projection: 'perspective', ...base, fov: camera.fov }
			: {
					projection: 'orthographic',
					...base,
					viewHeight: (camera.top - camera.bottom) / camera.zoom,
				}
	}
	const emitCameraChange = () => {
		if (listeners.size === 0) return
		const value = getCamera()
		for (const listener of listeners) listener(value)
	}

	// OrbitControls reads `camera.up` once, in its constructor, so a new up or camera needs new controls.
	const createControls = () => {
		const next = new OrbitControls(camera, canvas)
		next.enableDamping = false
		next.mouseButtons.LEFT = navigation === 'pan' ? MOUSE.PAN : MOUSE.ROTATE
		next.touches.ONE = navigation === 'pan' ? TOUCH.PAN : TOUCH.ROTATE
		next.addEventListener('start', () => cancelAnimationFrame(animation))
		next.addEventListener('change', () => {
			requestRender()
			emitCameraChange()
		})
		return next
	}
	let controls = createControls()
	const rebuildControls = () => {
		const { maxDistance, enabled } = controls
		controls.dispose()
		controls = createControls()
		controls.maxDistance = maxDistance
		controls.enabled = enabled
	}

	const updateProjection = () => {
		if (camera instanceof PerspectiveCamera) {
			camera.aspect = aspect
		} else {
			camera.left = camera.bottom * aspect
			camera.right = camera.top * aspect
		}
		camera.updateProjectionMatrix()
	}

	const resize = () => {
		const { clientWidth: w, clientHeight: h } = container
		// Zero while sketch mode hides the overlay.
		if (!w || !h) return
		renderer.setSize(w, h, false)
		aspect = w / h
		updateProjection()
		if (!paused) renderNow()
	}
	const resizeObserver = new ResizeObserver(resize)
	resizeObserver.observe(container)

	const onContextLost = (e: Event) => {
		e.preventDefault()
		if (!disposed) opts.onContextLost()
	}
	canvas.addEventListener('webglcontextlost', onContextLost)

	const manager = new LoadingManager()
	const dispose = () => {
		if (disposed) return
		disposed = true
		signal.removeEventListener('abort', dispose)
		manager.abort()
		cancelAnimationFrame(frame)
		cancelAnimationFrame(animation)
		listeners.clear()
		resizeObserver.disconnect()
		canvas.removeEventListener('webglcontextlost', onContextLost)
		disposeObject(scene)
		controls.dispose()
		renderer.dispose()
		if (!renderer.getContext().isContextLost()) renderer.forceContextLoss()
		canvas.remove()
	}

	signal.addEventListener('abort', dispose)

	let model: Object3D
	try {
		const data = await fetchModel(opts.glbUrl, opts.token, signal, opts.onProgress)
		// A private manager, so aborting stops this load's texture requests and no other viewer's.
		const loader = new GLTFLoader(manager)
		loader.setMeshoptDecoder(MeshoptDecoder)
		model = (await loader.parseAsync(data, '')).scene
	} catch (e) {
		dispose()
		throw signal.aborted ? signal.reason : e
	}
	// Aborted while parsing: dispose already ran and could not see the model.
	if (disposed) {
		disposeObject(model)
		throw signal.reason
	}
	scene.add(model)

	const sphere = new Box3().setFromObject(model).getBoundingSphere(new Sphere())
	const radius = sphere.radius > 0 ? sphere.radius : 1
	camera.near = radius / 1000
	camera.far = radius * 1000
	controls.maxDistance = radius * 100

	const setProjection = (projection: Model3dCamera['projection']) => {
		const isPerspective = camera instanceof PerspectiveCamera
		if (isPerspective === (projection === 'perspective')) return false
		const next =
			projection === 'perspective'
				? new PerspectiveCamera(50, aspect, camera.near, camera.far)
				: new OrthographicCamera(-1, 1, 1, -1, camera.near, camera.far)
		camera.remove(sun, sun.target)
		scene.remove(camera)
		camera = next
		scene.add(camera)
		camera.add(sun, sun.target)
		return true
	}

	const applyCamera = (value: Model3dCamera) => {
		const swapped = setProjection(value.projection)
		const up = new Vector3().fromArray(value.up).normalize()
		const upChanged = !up.equals(camera.up)
		camera.up.copy(up)
		camera.position.fromArray(value.position)
		if (value.projection === 'perspective') {
			;(camera as PerspectiveCamera).fov = value.fov
		} else {
			const ortho = camera as OrthographicCamera
			ortho.top = value.viewHeight / 2
			ortho.bottom = -value.viewHeight / 2
			ortho.zoom = 1
		}
		updateProjection()
		if (swapped || upChanged) rebuildControls()
		controls.target.fromArray(value.target)
		controls.update()
	}

	resize()
	if (opts.initialCamera) {
		applyCamera(opts.initialCamera)
	} else {
		fitCamera(initialCamera, controls.target, sphere.center, radius)
		controls.update()
	}
	renderNow()

	const captureFrame = () =>
		new Promise<Awaited<ReturnType<ViewerHandle['captureFrame']>>>((resolve, reject) => {
			const isLost = () => disposed || renderer.getContext().isContextLost()
			if (isLost()) return reject(new Error('The 3D view is not available'))
			// Read pixels in the same task as rendering; the drawing buffer is not preserved.
			renderNow()
			const width = canvas.width
			const height = canvas.height
			canvas.toBlob((blob) => {
				if (!blob || isLost()) return reject(new Error('Could not capture the 3D view'))
				resolve({ blob, width, height, dpr: renderer.getPixelRatio() })
			}, 'image/png')
		})

	return {
		captureFrame,
		fit() {
			cancelAnimationFrame(animation)
			setProjection('perspective')
			camera.up.set(0, 1, 0)
			rebuildControls()
			updateProjection()
			fitCamera(camera as PerspectiveCamera, controls.target, sphere.center, radius)
			controls.update()
			requestRender()
			emitCameraChange()
		},
		setNavigation(mode) {
			navigation = mode
			controls.mouseButtons.LEFT = mode === 'pan' ? MOUSE.PAN : MOUSE.ROTATE
			controls.touches.ONE = mode === 'pan' ? TOUCH.PAN : TOUCH.ROTATE
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

/** Animates in `b`'s projection; a projection change snaps on the first frame. */
function lerpCamera(a: Model3dCamera, b: Model3dCamera, t: number): Model3dCamera {
	const lerp = (x: number, y: number) => x + (y - x) * t
	const lerp3 = (x: number[], y: number[]) =>
		[0, 1, 2].map((i) => lerp(x[i], y[i])) as [number, number, number]
	const base = {
		position: lerp3(a.position, b.position),
		target: lerp3(a.target, b.target),
		up: lerp3(a.up, b.up),
		aspect: b.aspect,
	}
	if (b.projection === 'orthographic') {
		const from = a.projection === 'orthographic' ? a.viewHeight : b.viewHeight
		return { projection: 'orthographic', ...base, viewHeight: lerp(from, b.viewHeight) }
	}
	const from = a.projection === 'perspective' ? a.fov : b.fov
	return { projection: 'perspective', ...base, fov: lerp(from, b.fov) }
}

async function fetchModel(
	url: string,
	token: string | undefined,
	signal: AbortSignal,
	onProgress: (loaded: number, total: number) => void
) {
	const res = await fetch(url, {
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		signal,
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	if (!res.body) return res.arrayBuffer()
	const total = Number(res.headers.get('Content-Length')) || 0
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let loaded = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		loaded += value.byteLength
		onProgress(loaded, total)
	}
	const data = new Uint8Array(loaded)
	let offset = 0
	for (const chunk of chunks) {
		data.set(chunk, offset)
		offset += chunk.byteLength
	}
	return data.buffer
}

function disposeObject(root: Object3D) {
	// Materials share textures and textures share images, so each is released once.
	const textures = new Set<Texture>()
	root.traverse((obj) => {
		const mesh = obj as Mesh
		mesh.geometry?.dispose()
		const materials = mesh.material ? [mesh.material].flat() : []
		for (const material of materials) {
			for (const value of Object.values(material)) {
				if (value instanceof Texture) textures.add(value)
			}
			material.dispose()
		}
	})
	const bitmaps = new Set<ImageBitmap>()
	for (const texture of textures) {
		texture.dispose()
		if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) {
			bitmaps.add(texture.image)
		}
	}
	for (const bitmap of bitmaps) bitmap.close()
}
