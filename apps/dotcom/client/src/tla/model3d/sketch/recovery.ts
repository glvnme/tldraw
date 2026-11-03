import {
	CameraRecordType,
	Editor,
	TLCameraOptions,
	TLPageId,
	VecModel,
	deleteFromSessionStorage,
	getFromSessionStorage,
	setInSessionStorage,
} from 'tldraw'

/** What sketch mode changes on the board, so exiting or a reload can put it back. */
export interface Model3dSketchRestore {
	pageId: TLPageId
	camera: VecModel
	cameraOptions: TLCameraOptions
	toolId: string
}

const fileIds = new WeakMap<Editor, string>()
const recovered = new WeakSet<Editor>()

/** Without a file id, sketch mode still works but a reload cannot recover the board camera. */
export function setModel3dSketchFileId(editor: Editor, fileId: string) {
	fileIds.set(editor, fileId)
}

function getKey(editor: Editor) {
	const fileId = fileIds.get(editor)
	return fileId ? `tldraw-model3d-sketch:${fileId}` : null
}

export function saveModel3dSketchRecovery(editor: Editor, restore: Model3dSketchRestore) {
	const key = getKey(editor)
	if (key) setInSessionStorage(key, JSON.stringify(restore))
}

export function clearModel3dSketchRecovery(editor: Editor) {
	const key = getKey(editor)
	if (key) deleteFromSessionStorage(key)
}

/**
 * The file state persists the camera, so a reload during sketch mode would open the board at the
 * sketch camera. Call once the session state has loaded.
 */
export function recoverModel3dSketch(editor: Editor) {
	// Once per editor: a later remount of the overlay may happen mid-sketch.
	if (recovered.has(editor)) return
	recovered.add(editor)
	const key = getKey(editor)
	const value = key && getFromSessionStorage(key)
	if (!key || !value) return
	deleteFromSessionStorage(key)
	if (openedWithDeepLink()) return
	try {
		const restore = JSON.parse(value) as Model3dSketchRestore
		if (!editor.getPage(restore.pageId)) return
		restoreModel3dBoard(editor, restore)
	} catch (e) {
		console.error('Could not restore the board camera after sketching', e)
	}
}

/**
 * Whether this page was opened from a link to a place on the board, which then decides the camera.
 * Read from the navigation entry because the editor rewrites `?d=` as the camera moves, so after a
 * reload the URL holds the sketch camera, and the comment link handler strips `?comment=`.
 */
function openedWithDeepLink() {
	const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
	if (entry?.type !== 'navigate') return false
	const url = new URL(entry.name)
	if (url.pathname !== window.location.pathname) return false
	return url.searchParams.has('d') || url.searchParams.has('comment')
}

/** Sets the camera on the page sketching started from, which may not be the current page. */
export function restoreModel3dBoard(editor: Editor, restore: Model3dSketchRestore) {
	editor.setCameraOptions(restore.cameraOptions)
	const { x, y, z } = restore.camera
	if (editor.getCurrentPageId() === restore.pageId) {
		editor.setCamera({ x, y, z }, { immediate: true, force: true })
	} else {
		const camera = editor.store.get(CameraRecordType.createId(restore.pageId))
		if (camera) editor.store.put([{ ...camera, x, y, z: z ?? camera.z }])
	}
	if (editor.root.children?.[restore.toolId]) editor.setCurrentTool(restore.toolId)
	else editor.setCurrentTool('select')
}
