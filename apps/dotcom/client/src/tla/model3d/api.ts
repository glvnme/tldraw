import { Model3dErrorCode, Model3dErrorResponse } from '@tldraw/dotcom-shared'
import { fetch } from 'tldraw'

export type GetModel3dToken = () => Promise<string | undefined>

export class Model3dApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: Model3dErrorCode | null,
		message: string
	) {
		super(message)
	}
}

/** `path` is a `model3dPaths` route; the Vite proxy and production both serve them under `/api`. */
export function model3dUrl(path: string) {
	return `/api${path}`
}

export async function model3dFetch<T>(
	getToken: GetModel3dToken,
	path: string,
	init: RequestInit = {}
): Promise<T> {
	const token = await getToken()
	const headers = new Headers(init.headers)
	if (token) headers.set('Authorization', `Bearer ${token}`)
	if (typeof init.body === 'string') headers.set('Content-Type', 'application/json')
	const res = await fetch(model3dUrl(path), { ...init, headers })
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as Model3dErrorResponse | null
		throw new Model3dApiError(
			res.status,
			body?.error ?? null,
			body?.message ?? body?.error ?? `HTTP ${res.status}`
		)
	}
	return (await res.json()) as T
}
