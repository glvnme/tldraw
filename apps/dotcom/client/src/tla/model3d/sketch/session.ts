import {
	MODEL3D_REVISION_SHAPE_TYPE,
	TLModel3dRevisionShape,
	TLModel3dShape,
	ViewerHandle,
} from '@tldraw/dotcom-shared'
import {
	AssetRecordType,
	Atom,
	Editor,
	TLAssetId,
	TLImageAsset,
	TLRecord,
	TLShapeId,
	WeakCache,
	atom,
	createShapeId,
	isShape,
	transact,
	unsafe__withoutCapture,
} from 'tldraw'
import { fitCameraToBounds, nextRevisionName, placeRevision } from '../revisions/layout'
import {
	getModel3dRevision,
	getModel3dRevisionView,
	getModel3dRevisions,
	getRevisionContentRecords,
	showModel3dRevision,
} from '../revisions/state'
import { computeStrokeHash } from '../revisions/strokeHash'
import { getModel3dViewerHandle, getModel3dViewerState } from '../viewerState'
import {
	Model3dSketchRestore,
	clearModel3dSketchRecovery,
	restoreModel3dBoard,
	saveModel3dSketchRecovery,
} from './recovery'

export interface Model3dSketchSession {
	revisionId: TLShapeId
	/** The board as it was before sketching, on the page sketching started from. */
	restore: Model3dSketchRestore
}

const sessions = new WeakCache<Editor, Atom<Model3dSketchSession | null>>()

export function getModel3dSketchSession(editor: Editor) {
	return sessions.get(editor, () => atom<Model3dSketchSession | null>('model3d sketch', null))
}

const entering = new WeakSet<Editor>()

/**
 * Captures the viewer as a new draft revision next to the model, then turns the board into a
 * locked 2D view of just that revision so the normal tools draw onto the snapshot.
 */
export async function enterModel3dSketch(editor: Editor, modelShapeId: TLShapeId) {
	const handle = getModel3dViewerHandle(editor).get()
	const model = editor.getShape<TLModel3dShape>(modelShapeId)
	if (!handle || !model || entering.has(editor) || editor.getIsReadonly()) return
	if (getModel3dSketchSession(editor).get()) return

	entering.add(editor)
	// Read in the same task as the capture renders, so the pose matches the pixels.
	const pose = handle.getCamera()
	let frame: Awaited<ReturnType<ViewerHandle['captureFrame']>>
	try {
		frame = await handle.captureFrame()
	} finally {
		entering.delete(editor)
	}
	// The viewer may have closed or reloaded while the frame was encoding.
	if (getModel3dViewerHandle(editor).get() !== handle) return
	if (getModel3dViewerState(editor).get()?.shapeId !== modelShapeId) return

	const viewport = {
		w: Math.round(frame.width / frame.dpr),
		h: Math.round(frame.height / frame.dpr),
		dpr: frame.dpr,
	}
	const name = nextRevisionName(
		getModel3dRevisions(editor, model.props.modelId).map((r) => r.props.name)
	)
	const fileName = `${model.props.altText || 'model'} ${name}.png`
	const file = new File([frame.blob], fileName, { type: 'image/png' })
	const asset = AssetRecordType.create({
		id: AssetRecordType.createId(),
		type: 'image',
		props: {
			name: fileName,
			src: null,
			w: viewport.w,
			h: viewport.h,
			mimeType: 'image/png',
			isAnimated: false,
			fileSize: frame.blob.size,
			pixelRatio: viewport.dpr,
		},
		meta: {},
	}) as TLImageAsset
	editor.createTemporaryAssetPreview(asset.id, file)
	// Outside history, so undoing the revision and redoing it never brings back a src-less asset.
	editor.run(() => editor.createAssets([asset]), { history: 'ignore' })

	const pageId = editor.getCurrentPageId()
	const modelBounds = editor.getShapePageBounds(model)!
	const obstacles = editor
		.getSortedChildIdsForParent(pageId)
		.map((id) => editor.getShapePageBounds(id))
		.filter((b) => !!b)
		.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
	const position = placeRevision(
		{ x: modelBounds.x, y: modelBounds.y, w: modelBounds.w, h: modelBounds.h },
		viewport,
		obstacles
	)
	const revisionId = createShapeId()

	editor.markHistoryStoppingPoint('model3d sketch')
	editor.createShape<TLModel3dRevisionShape>({
		id: revisionId,
		type: MODEL3D_REVISION_SHAPE_TYPE,
		parentId: pageId,
		...position,
		props: {
			w: viewport.w,
			h: viewport.h,
			modelId: model.props.modelId,
			modelVersion: model.props.modelVersion,
			assetId: asset.id,
			pose,
			viewport,
			name,
			publishedAt: null,
			strokeHash: null,
		},
	})

	const { x, y, z } = editor.getCamera()
	const restore: Model3dSketchRestore = {
		pageId,
		camera: { x, y, z },
		cameraOptions: editor.getCameraOptions(),
		toolId: editor.getCurrentToolId(),
	}
	saveModel3dSketchRecovery(editor, restore)
	transact(() => {
		getModel3dSketchSession(editor).set({ revisionId, restore })
		fitSketchCamera(editor)
		editor.setCameraOptions({ isLocked: true })
		handle.pause()
		getModel3dViewerState(editor).update((s) => s && { ...s, mode: 'sketch' })
		getModel3dRevisionView(editor).set(null)
	})
	editor.selectNone()
	editor.setCurrentTool('draw')

	void uploadSnapshot(editor, asset, file)
}

interface SnapshotUpload {
	status: 'uploading' | 'failed'
	file: File
}

const snapshotUploads = new WeakCache<Editor, Atom<ReadonlyMap<TLAssetId, SnapshotUpload>>>()

/** Snapshot uploads started in this tab that have not saved yet, by asset. */
export function getModel3dSnapshotUploads(editor: Editor) {
	return snapshotUploads.get(editor, () =>
		atom<ReadonlyMap<TLAssetId, SnapshotUpload>>('model3d snapshot uploads', new Map())
	)
}

function setSnapshotUpload(editor: Editor, assetId: TLAssetId, upload: SnapshotUpload | null) {
	getModel3dSnapshotUploads(editor).update((prev) => {
		const next = new Map(prev)
		if (upload) next.set(assetId, upload)
		else next.delete(assetId)
		return next
	})
}

/** Publishing needs a saved snapshot: other clients cannot see a src-less asset. */
export function isModel3dSnapshotSaved(editor: Editor, assetId: TLAssetId | null) {
	return !!assetId && !!editor.getAsset(assetId)?.props.src
}

export function retryModel3dSnapshotUpload(editor: Editor, assetId: TLAssetId) {
	const upload = getModel3dSnapshotUploads(editor).get().get(assetId)
	const asset = editor.getAsset(assetId)
	if (upload?.status !== 'failed' || asset?.type !== 'image') return
	void uploadSnapshot(editor, asset, upload.file)
}

async function uploadSnapshot(editor: Editor, asset: TLImageAsset, file: File) {
	setSnapshotUpload(editor, asset.id, { status: 'uploading', file })
	try {
		const { src, meta } = await editor.uploadAsset(asset, file)
		const current = editor.getAsset(asset.id)
		setSnapshotUpload(editor, asset.id, null)
		if (!current) return
		editor.run(
			() =>
				editor.updateAssets([
					{ ...current, props: { ...current.props, src }, meta: { ...current.meta, ...meta } },
				]),
			{ history: 'ignore' }
		)
	} catch (e) {
		console.error('Could not upload the revision snapshot', e)
		setSnapshotUpload(editor, asset.id, { status: 'failed', file })
	}
}

/** Shows the revision at zoom 1 filling the viewport, or fitted if the viewport has changed size. */
export function fitSketchCamera(editor: Editor) {
	const session = getModel3dSketchSession(editor).get()
	const bounds = session && editor.getShapePageBounds(session.revisionId)
	if (!bounds) return
	const screen = editor.getViewportScreenBounds()
	const camera = fitCameraToBounds(
		{ w: screen.w, h: screen.h },
		{ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
	)
	// Called from a reaction; the camera it writes must not become one of its dependencies.
	unsafe__withoutCapture(() => editor.setCamera(camera, { immediate: true, force: true }))
}

/**
 * Restores the board and, if the viewer is still open, returns it to 3D at the revision's pose
 * with its overlay. Safe to call after the revision or the viewer has gone.
 */
export function exitModel3dSketch(editor: Editor) {
	const session = getModel3dSketchSession(editor).get()
	if (!session) return
	transact(() => {
		getModel3dSketchSession(editor).set(null)
		restoreModel3dBoard(editor, session.restore)
	})
	clearModel3dSketchRecovery(editor)
	editor.selectNone()

	const viewer = getModel3dViewerState(editor).get()
	if (viewer?.mode !== 'sketch') return
	transact(() => {
		getModel3dViewerState(editor).update((s) => s && { ...s, mode: 'orbit' })
		getModel3dViewerHandle(editor).get()?.resume()
		if (getModel3dRevision(editor, session.revisionId)) {
			showModel3dRevision(editor, session.revisionId)
		}
	})
}

export function discardModel3dSketch(editor: Editor) {
	const session = getModel3dSketchSession(editor).get()
	if (!session) return
	editor.markHistoryStoppingPoint('model3d discard')
	editor.deleteShapes([session.revisionId])
	exitModel3dSketch(editor)
}

/** Publishes the sketch, then returns to 3D. */
export async function publishModel3dSketch(editor: Editor) {
	const session = getModel3dSketchSession(editor).get()
	if (!session) return
	const published = await publishModel3dRevision(editor, session.revisionId)
	if (published && getModel3dSketchSession(editor).get() === session) exitModel3dSketch(editor)
}

/**
 * Freezes the revision: records which strokes it shows and locks them. Also republishes a
 * revision whose strokes changed after publishing.
 */
export async function publishModel3dRevision(editor: Editor, revisionId: TLShapeId) {
	let records: TLRecord[]
	let strokeHash: string
	// The hash is async; retry if the strokes changed underneath it.
	do {
		records = getRevisionContentRecords(editor, revisionId)
		strokeHash = await computeStrokeHash(records)
	} while (!isSameRecords(records, getRevisionContentRecords(editor, revisionId)))

	const revision = getModel3dRevision(editor, revisionId)
	if (!revision || !isModel3dSnapshotSaved(editor, revision.props.assetId)) return false
	editor.markHistoryStoppingPoint('model3d publish')
	editor.run(() => {
		editor.updateShape<TLModel3dRevisionShape>({
			id: revision.id,
			type: MODEL3D_REVISION_SHAPE_TYPE,
			props: { publishedAt: Date.now(), strokeHash },
		})
		editor.updateShapes(
			records.filter(isShape).map((s) => ({ id: s.id, type: s.type, isLocked: true }))
		)
	})
	return true
}

function isSameRecords(a: readonly TLRecord[], b: readonly TLRecord[]) {
	return a.length === b.length && a.every((record, i) => record === b[i])
}
