import { getLicenseKey, TLModel3dShape } from '@tldraw/dotcom-shared'
import { useEffect, useRef, useState } from 'react'
import {
	AssetRecordType,
	b64Vecs,
	createShapeId,
	Editor,
	FileHelpers,
	fetch,
	HTMLContainer,
	TLImageShape,
	TLShape,
	TLShapePartial,
	Tldraw,
	useEditor,
	useValue,
} from 'tldraw'
import { z } from 'zod'
import { Model3dShapeUtil } from '../tla/model3d/Model3dShapeUtil'
import type { Model3dViewerEngine } from '../tla/model3d/viewerEngine'
import { assetUrls } from '../utils/assetUrls'
import 'tldraw/tldraw.css'
import './dev-image-to-3d.css'

const ROOT = '/__image-to-3d'
const CAPTURE_LONG_EDGE = 1536
const MAX_MASSING_IMAGES = 6

const agentPickSchema = z.object({ model: z.string(), effort: z.string() })
type AgentPick = z.infer<typeof agentPickSchema>
const EFFORT_LABELS: Record<string, string> = {
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
}

const modelsSchema = z.object({
	models: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			kind: z.enum(['object', 'scene', 'massing']),
			costUsd: z.number().nullable(),
			ready: z.boolean(),
			missing: z.string().nullable(),
			choices: z
				.object({
					models: z.array(z.object({ id: z.string(), label: z.string() })),
					efforts: z.array(z.string()),
					default: agentPickSchema,
				})
				.nullable(),
		})
	),
})
const resultSchema = z.object({
	url: z.string().startsWith(`${ROOT}/models/`),
	metadata: z.object({
		seconds: z.number(),
		vertices: z.number().optional(),
		faces: z.number().optional(),
		costUsd: z.number().optional(),
		worldUrl: z.url().optional(),
		parts: z.number().optional(),
		skipped: z.number().optional(),
		notes: z.string().optional(),
	}),
})
type TestModel = z.infer<typeof modelsSchema>['models'][number]

/** One untouched image keeps its original file; anything else is rendered from the canvas. */
async function captureInput(editor: Editor, shapes: TLShape[]) {
	const [only] = shapes
	if (shapes.length === 1 && only.type === 'image') {
		const image = only as TLImageShape
		const asset = image.props.assetId ? editor.getAsset(image.props.assetId) : undefined
		const untouched =
			!image.props.crop && !image.props.flipX && !image.props.flipY && only.rotation === 0
		if (asset?.type === 'image' && asset.props.src && untouched) {
			const blob = await (await fetch(asset.props.src)).blob()
			if (['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) return blob
		}
	}
	const bounds = editor.getShapesPageBounds(shapes.map((shape) => shape.id))!
	const { blob } = await editor.toImage(shapes, {
		format: 'png',
		background: true,
		darkMode: false,
		padding: 32,
		pixelRatio: 1,
		scale: Math.min(4, CAPTURE_LONG_EDGE / Math.max(bounds.w, bounds.h)),
	})
	return blob
}

/** Massing agents read several views, so each image goes separately and any drawing goes as one picture. */
async function captureEach(editor: Editor, shapes: TLShape[]) {
	const others = shapes.filter((shape) => shape.type !== 'image')
	if (shapes.length - others.length + (others.length ? 1 : 0) > MAX_MASSING_IMAGES)
		throw new Error(`Select up to ${MAX_MASSING_IMAGES} images for a massing model.`)
	const inputs = await Promise.all(
		shapes.filter((shape) => shape.type === 'image').map((shape) => captureInput(editor, [shape]))
	)
	if (others.length) inputs.push(await captureInput(editor, others))
	return Promise.all(inputs.map(fitForAgent))
}

// Claude rejects images over 5 MB or 8000 px, which full-size phone photos often are.
const AGENT_LONG_EDGE = 1568
const AGENT_MAX_BYTES = 4 * 1024 * 1024

async function fitForAgent(blob: Blob) {
	const bitmap = await createImageBitmap(blob)
	const scale = Math.min(1, AGENT_LONG_EDGE / Math.max(bitmap.width, bitmap.height))
	if (scale === 1 && blob.size <= AGENT_MAX_BYTES) {
		bitmap.close()
		return blob
	}
	const canvas = new OffscreenCanvas(
		Math.round(bitmap.width * scale),
		Math.round(bitmap.height * scale)
	)
	const context = canvas.getContext('2d')!
	context.fillStyle = '#fff'
	context.fillRect(0, 0, canvas.width, canvas.height)
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
	bitmap.close()
	return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
}

class TestModel3dShapeUtil extends Model3dShapeUtil {
	override canEdit() {
		return true
	}

	override onDoubleClick(shape: TLModel3dShape): TLShapePartial<TLModel3dShape> {
		this.editor.setEditingShape(shape.id)
		return { id: shape.id, type: shape.type }
	}

	override component(shape: TLModel3dShape) {
		return <TestModelSurface shape={shape} />
	}
}

const shapeUtils = [TestModel3dShapeUtil]
const components = { TopPanel: TestControls }

export function Component() {
	return (
		<div className="tldraw__editor">
			<Tldraw
				licenseKey={getLicenseKey()}
				assetUrls={assetUrls}
				shapeUtils={shapeUtils}
				components={components}
			/>
		</div>
	)
}

function TestControls() {
	const editor = useEditor()
	const [models, setModels] = useState<TestModel[]>([])
	const [model, setModel] = useState('fal-trellis-2')
	const [picks, setPicks] = useState<Record<string, AgentPick>>({})
	const [running, setRunning] = useState(0)
	const [message, setMessage] = useState('Load an image or draw a sketch, then select it.')
	const [error, setError] = useState(false)
	const upload = useRef<HTMLInputElement>(null)
	const selected = useValue('local generation selection', () => editor.getSelectedShapes(), [
		editor,
	])
	const canGenerate =
		selected.length > 0 &&
		selected.every((shape) => shape.type !== 'model3d' && shape.type !== 'model3d-revision')
	const ready = models.some((item) => item.id === model && item.ready)
	const available = models.filter((item) => item.ready && item.kind === 'object')
	const compareCost = available.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)
	const agents = models.filter((item) => item.kind === 'massing')
	const pickFor = (item: TestModel) => picks[item.id] ?? item.choices?.default ?? null
	const describe = (item: TestModel) => {
		const pick = pickFor(item)
		if (!pick) return item.label
		const modelLabel = item.choices?.models.find((choice) => choice.id === pick.model)?.label
		return `${item.label} · ${modelLabel ?? pick.model} ${(EFFORT_LABELS[pick.effort] ?? pick.effort).toLowerCase()}`
	}

	useEffect(() => {
		const controller = new AbortController()
		const refresh = async () => {
			try {
				const response = await fetch(`${ROOT}/health`, { signal: controller.signal })
				if (!response.ok) throw new Error('The image to 3D bridge is unavailable.')
				setModels(modelsSchema.parse(await response.json(), { jitless: true }).models)
			} catch (error) {
				if (controller.signal.aborted) return
				setMessage(error instanceof Error ? error.message : String(error))
				setError(true)
			}
		}
		void refresh()
		const interval = window.setInterval(() => void refresh(), 5000)
		return () => {
			controller.abort()
			window.clearInterval(interval)
		}
	}, [])

	const addFile = async (file: File) => {
		await editor.putExternalContent({
			type: 'files',
			files: [file],
			point: editor.getViewportPageBounds().center,
		})
		editor.zoomToSelection()
	}

	const addSample = async (name: string) => {
		try {
			const response = await fetch(`${ROOT}/samples/${name}`)
			if (!response.ok) throw new Error('Could not load the sample image.')
			const blob = await response.blob()
			await addFile(
				new File([blob], `${name}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, {
					type: blob.type,
				})
			)
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error))
			setError(true)
		}
	}

	const addSketch = () => {
		const id = createShapeId()
		const center = editor.getViewportPageBounds().center
		const strokes = [
			[
				[0, 100],
				[100, 0],
				[200, 100],
				[200, 230],
				[0, 230],
				[0, 100],
				[200, 100],
			],
			[
				[80, 230],
				[80, 160],
				[120, 160],
				[120, 230],
			],
			[
				[25, 125],
				[60, 125],
				[60, 160],
				[25, 160],
				[25, 125],
			],
		]
		editor.createShape({
			id,
			type: 'draw',
			x: center.x - 100,
			y: center.y - 115,
			props: {
				isComplete: true,
				segments: strokes.map((points) => ({
					type: 'free',
					path: b64Vecs.encodePoints(points.map(([x, y]) => ({ x, y, z: 0.5 }))),
				})),
			},
		})
		editor.select(id).zoomToSelection()
	}

	const generate = async (chosen: TestModel[]) => {
		const bounds = editor.getSelectionPageBounds()
		if (!bounds || !canGenerate || !chosen.length) return
		const sources = selected
		const sourceIds = sources.map((shape) => shape.id)
		const key = JSON.stringify(sourceIds)
		const previous = editor
			.getCurrentPageShapes()
			.filter(
				(shape) =>
					shape.type === 'model3d' &&
					JSON.stringify(
						(shape.meta.generatedFrom as { sourceShapeIds?: string[] } | undefined)?.sourceShapeIds
					) === key
			).length
		setError(false)
		let input: Blob | null = null
		let views: { contentType: string; base64: string }[] = []
		try {
			if (chosen.some((item) => item.kind !== 'massing'))
				input = await captureInput(editor, sources)
			if (chosen.some((item) => item.kind === 'massing')) {
				const blobs = await captureEach(editor, sources)
				views = await Promise.all(
					blobs.map(async (blob) => ({
						contentType: blob.type,
						base64: (await FileHelpers.blobToDataUrl(blob)).split(',')[1],
					}))
				)
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error))
			setError(true)
			return
		}
		editor.markHistoryStoppingPoint('make 3d')
		const jobs = chosen.map((item, index) => {
			const id = createShapeId()
			const pick = pickFor(item)
			const label = describe(item)
			editor.createShape<TLModel3dShape>({
				id,
				type: 'model3d',
				x: bounds.maxX + 40 + (previous + index) * 520,
				y: bounds.y,
				props: { w: 480, h: 320, altText: label },
				meta: {
					generatedFrom: {
						sourceShapeIds: sourceIds,
						model: item.id,
						agentModel: pick?.model ?? null,
						effort: pick?.effort ?? null,
						createdAt: Date.now(),
					},
				},
			})
			return { item, id, pick, label }
		})
		const last = editor.getShapePageBounds(jobs[jobs.length - 1].id)
		if (last) editor.zoomToBounds(last.union(bounds), { inset: 80 })
		setRunning((count) => count + jobs.length)
		setMessage(`Running ${jobs.map((job) => job.label).join(', ')}…`)
		await Promise.all(
			jobs.map(async ({ item, id, pick, label }) => {
				try {
					const response = await fetch(
						`${ROOT}/generate?model=${encodeURIComponent(item.id)}`,
						item.kind === 'massing'
							? {
									method: 'POST',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ images: views, ...pick }),
								}
							: { method: 'POST', headers: { 'content-type': input!.type }, body: input }
					)
					if (!response.ok) {
						const failure = z
							.object({ error: z.string() })
							.safeParse(await response.json(), { jitless: true })
						throw new Error(
							failure.success ? failure.data.error : `Generation failed (${response.status}).`
						)
					}
					const result = resultSchema.parse(await response.json(), { jitless: true })
					const shape = editor.getShape<TLModel3dShape>(id)
					if (!shape) return
					editor.updateShape<TLModel3dShape>({
						id,
						type: 'model3d',
						props: { modelId: result.url },
						meta: {
							...shape.meta,
							localModelUrl: result.url,
							generationSeconds: result.metadata.seconds,
							worldUrl: result.metadata.worldUrl ?? null,
							massingNotes: result.metadata.notes ?? null,
						},
					})
					const { costUsd: cost, parts, skipped, notes } = result.metadata
					setMessage(
						`${label}: ${result.metadata.seconds.toFixed(1)} s${cost ? `, about $${cost.toFixed(2)}` : ''}${parts ? `, ${parts} parts` : ''}${skipped ? ` (${skipped} malformed parts left out)` : ''}. ${notes ?? 'Click Orbit 3D on the result.'}`
					)
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					const shape = editor.getShape<TLModel3dShape>(id)
					if (shape)
						editor.updateShape<TLModel3dShape>({
							id,
							type: 'model3d',
							meta: { ...shape.meta, localError: message },
						})
					setMessage(`${label}: ${message}`)
					setError(true)
				} finally {
					setRunning((count) => count - 1)
				}
			})
		)
	}

	return (
		<div className="local-3d-panel" onPointerDown={(event) => event.stopPropagation()}>
			<div className="local-3d-controls">
				<strong>Image to 3D</strong>
				<button onClick={() => upload.current?.click()}>Upload image</button>
				{['interior', 'office', 'house'].map((name) => (
					<button key={name} onClick={() => void addSample(name)}>
						{name === 'interior'
							? 'Interior sample'
							: name === 'office'
								? 'Office sample'
								: 'House sample'}
					</button>
				))}
				<button onClick={addSketch}>Sketch sample</button>
				<select
					aria-label="3D model"
					value={model}
					onChange={(event) => setModel(event.target.value)}
				>
					{models
						.filter((item) => item.kind !== 'massing')
						.map((item) => (
							<option key={item.id} value={item.id} disabled={!item.ready}>
								{item.label}
								{item.costUsd === null ? '' : ` · ~$${item.costUsd.toFixed(2)}`}
								{item.missing ? ` (${item.missing})` : ''}
							</option>
						))}
				</select>
				<button
					disabled={!canGenerate || !ready}
					onClick={() => void generate(models.filter((item) => item.id === model))}
				>
					Make 3D
				</button>
				<button
					disabled={!canGenerate || available.length === 0}
					onClick={() => void generate(available)}
				>
					Compare objects (~${compareCost.toFixed(2)})
				</button>
				{agents.map((item) => {
					const pick = pickFor(item)
					const name = item.id === 'claude-massing' ? 'Claude' : 'Codex'
					const choose = (change: Partial<AgentPick>) =>
						pick && setPicks((current) => ({ ...current, [item.id]: { ...pick, ...change } }))
					return (
						<span key={item.id} className="local-3d-agent">
							{item.choices && pick && (
								<>
									<select
										aria-label={`${name} model`}
										value={pick.model}
										onChange={(event) => choose({ model: event.target.value })}
									>
										{item.choices.models.map((choice) => (
											<option key={choice.id} value={choice.id}>
												{choice.label}
											</option>
										))}
									</select>
									<select
										aria-label={`${name} reasoning`}
										value={pick.effort}
										onChange={(event) => choose({ effort: event.target.value })}
									>
										{item.choices.efforts.map((effort) => (
											<option key={effort} value={effort}>
												{EFFORT_LABELS[effort] ?? effort}
											</option>
										))}
									</select>
								</>
							)}
							<button
								disabled={!canGenerate || !item.ready}
								title={item.missing ?? 'Builds a massing model from every selected image'}
								onClick={() => void generate([item])}
							>
								Build with {name}
							</button>
						</span>
					)
				})}

				{running > 0 && <span>{running} running…</span>}
				<input
					ref={upload}
					type="file"
					accept="image/png,image/jpeg,image/webp"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0]
						if (file) void addFile(file)
						event.target.value = ''
					}}
				/>
			</div>
			<p role={error ? 'alert' : 'status'}>{message}</p>
			<p className="local-3d-note">
				fal and Marble runs are paid; Claude and Codex use your CLI plans and read every selected
				image · Results are saved under ~/models/weave-3d/results · This test canvas clears on
				reload.
			</p>
		</div>
	)
}

function TestModelSurface({ shape }: { shape: TLModel3dShape }) {
	const editor = useEditor()
	const container = useRef<HTMLDivElement>(null)
	const engine = useRef<Model3dViewerEngine | null>(null)
	const [loaded, setLoaded] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const editing = useValue('local 3d interaction', () => editor.getEditingShapeId() === shape.id, [
		editor,
		shape.id,
	])
	const url = typeof shape.meta.localModelUrl === 'string' ? shape.meta.localModelUrl : null
	const generationError = typeof shape.meta.localError === 'string' ? shape.meta.localError : null
	const worldUrl = typeof shape.meta.worldUrl === 'string' ? shape.meta.worldUrl : null

	useEffect(() => {
		if (!url || !container.current) return
		const controller = new AbortController()
		const target = container.current
		setLoaded(false)
		setError(null)
		void import('../tla/model3d/viewerEngine')
			.then(async ({ createModel3dViewerEngine }) => {
				const viewer = await createModel3dViewerEngine({
					container: target,
					glbUrl: url,
					token: undefined,
					initialCamera: null,
					signal: controller.signal,
					onProgress() {},
					onContextLost: () => setError('The 3D display was interrupted. Reload this test.'),
				})
				if (controller.signal.aborted) {
					viewer.dispose()
					return
				}
				engine.current = viewer
				target.dataset.camera = JSON.stringify(viewer.getCamera())
				viewer.onCameraChange((camera) => {
					target.dataset.camera = JSON.stringify(camera)
				})
				if (editor.getEditingShapeId() !== shape.id) viewer.pause()
				setLoaded(true)
				const frame = await viewer.captureFrame()
				const src = await FileHelpers.blobToDataUrl(frame.blob)
				if (controller.signal.aborted || !editor.getShape(shape.id)) return
				const assetId = AssetRecordType.createId()
				editor.createAssets([
					{
						id: assetId,
						typeName: 'asset',
						type: 'image',
						meta: {},
						props: {
							name: 'Model preview',
							src,
							w: frame.width,
							h: frame.height,
							mimeType: 'image/png',
							isAnimated: false,
						},
					},
				])
				editor.updateShape<TLModel3dShape>({ id: shape.id, type: 'model3d', props: { assetId } })
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted)
					setError(error instanceof Error ? error.message : String(error))
			})
		return () => {
			controller.abort()
			engine.current?.dispose()
			engine.current = null
		}
	}, [editor, shape.id, url])

	useEffect(() => {
		if (editing) engine.current?.resume()
		else engine.current?.pause()
		if (!editing) return
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') editor.setEditingShape(null)
		}
		window.addEventListener('keydown', escape)
		return () => window.removeEventListener('keydown', escape)
	}, [editor, editing, loaded])

	const zoom = useValue('local 3d zoom', () => editor.getZoomLevel(), [editor])
	useEffect(() => {
		if (!loaded) return
		// Reallocating the drawing buffer on every pinch frame stutters, so wait for the zoom to settle.
		const timer = window.setTimeout(() => engine.current?.setResolutionScale(zoom), 150)
		return () => window.clearTimeout(timer)
	}, [zoom, loaded])

	return (
		<HTMLContainer className="local-3d-shape">
			<div
				ref={container}
				className="local-3d-surface"
				data-testid="local-model-surface"
				data-state={error || generationError ? 'error' : loaded ? 'ready' : 'loading'}
				style={{ pointerEvents: editing ? 'auto' : 'none' }}
				onPointerDown={(event) => event.stopPropagation()}
				onWheel={(event) => event.stopPropagation()}
			/>
			{!loaded && (
				<div className="local-3d-placeholder">
					{generationError ?? error ?? (url ? 'Loading 3D…' : 'Generating…')}
				</div>
			)}
			{loaded && (
				<button
					className="local-3d-interact"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={() => editor.setEditingShape(editing ? null : shape.id)}
				>
					{editing ? 'Done' : 'Orbit 3D'}
				</button>
			)}
			{worldUrl && (
				<a
					className="local-3d-world"
					href={worldUrl}
					target="_blank"
					rel="noreferrer"
					onPointerDown={(event) => event.stopPropagation()}
				>
					Walk through in Marble
				</a>
			)}
		</HTMLContainer>
	)
}
