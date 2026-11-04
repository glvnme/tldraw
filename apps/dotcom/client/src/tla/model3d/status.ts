import {
	GetModelStatusResponse,
	MODEL3D_TERMINAL_STATUSES,
	model3dPaths,
} from '@tldraw/dotcom-shared'
import { useEffect, useState } from 'react'
import { GetModel3dToken, Model3dApiError, model3dFetch } from './api'

export type Model3dStatusSnapshot =
	| { kind: 'loading' }
	| { kind: 'ok'; status: GetModelStatusResponse }
	| { kind: 'forbidden' }
	| { kind: 'not_found' }
	| { kind: 'error'; message: string }

export const MODEL3D_POLL_INTERVAL_MS = 1500

type FetchStatus = (modelId: string, getToken: GetModel3dToken) => Promise<GetModelStatusResponse>
type Listener = (snapshot: Model3dStatusSnapshot) => void

interface Entry {
	snapshot: Model3dStatusSnapshot
	listeners: Set<Listener>
	getToken: GetModel3dToken
	timer: ReturnType<typeof setTimeout> | null
	inFlight: boolean
}

/** One poll loop per model, shared by every shape and viewer that shows it. */
export class Model3dStatusPoller {
	private entries = new Map<string, Entry>()

	constructor(private fetchStatus: FetchStatus) {}

	subscribe(modelId: string, getToken: GetModel3dToken, listener: Listener) {
		let entry = this.entries.get(modelId)
		if (!entry) {
			entry = {
				snapshot: { kind: 'loading' },
				listeners: new Set(),
				getToken,
				timer: null,
				inFlight: false,
			}
			this.entries.set(modelId, entry)
			void this.poll(modelId)
		}
		entry.getToken = getToken
		entry.listeners.add(listener)
		listener(entry.snapshot)
		return () => {
			const current = this.entries.get(modelId)
			if (!current) return
			current.listeners.delete(listener)
			if (current.listeners.size > 0) return
			if (current.timer) clearTimeout(current.timer)
			this.entries.delete(modelId)
		}
	}

	/** Restarts polling, for example after a retry moved a failed model back to queued. */
	refresh(modelId: string) {
		const entry = this.entries.get(modelId)
		if (!entry || entry.inFlight) return
		if (entry.timer) clearTimeout(entry.timer)
		entry.timer = null
		void this.poll(modelId)
	}

	getSubscriberCount(modelId: string) {
		return this.entries.get(modelId)?.listeners.size ?? 0
	}

	private async poll(modelId: string) {
		const entry = this.entries.get(modelId)
		if (!entry) return
		entry.inFlight = true
		let snapshot: Model3dStatusSnapshot
		let status = 0
		try {
			snapshot = { kind: 'ok', status: await this.fetchStatus(modelId, entry.getToken) }
		} catch (e) {
			status = e instanceof Model3dApiError ? e.status : 0
			snapshot =
				status === 403
					? { kind: 'forbidden' }
					: status === 404
						? { kind: 'not_found' }
						: { kind: 'error', message: e instanceof Error ? e.message : String(e) }
		}
		entry.inFlight = false
		// Unsubscribed while the request was in flight.
		if (this.entries.get(modelId) !== entry) return
		entry.snapshot = snapshot
		for (const listener of entry.listeners) listener(snapshot)
		if (snapshot.kind === 'ok' && MODEL3D_TERMINAL_STATUSES.includes(snapshot.status.status)) return
		// Signed out: polling cannot succeed with this token. A new token resubscribes.
		if (snapshot.kind === 'forbidden' || snapshot.kind === 'not_found' || status === 401) return
		entry.timer = setTimeout(() => {
			entry.timer = null
			void this.poll(modelId)
		}, MODEL3D_POLL_INTERVAL_MS)
	}
}

export const model3dStatusPoller = new Model3dStatusPoller((modelId, getToken) =>
	model3dFetch<GetModelStatusResponse>(getToken, model3dPaths.status(modelId))
)

/** `modelId` is empty until the create call returns. */
export function useModel3dStatus(modelId: string, getToken: GetModel3dToken) {
	const [snapshot, setSnapshot] = useState<Model3dStatusSnapshot>({ kind: 'loading' })
	useEffect(() => {
		if (!modelId) return
		return model3dStatusPoller.subscribe(modelId, getToken, setSnapshot)
	}, [modelId, getToken])
	return modelId ? snapshot : ({ kind: 'loading' } as const)
}
