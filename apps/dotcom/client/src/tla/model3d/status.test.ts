import { GetModelStatusResponse } from '@tldraw/dotcom-shared'
import { Model3dApiError } from './api'
import { MODEL3D_POLL_INTERVAL_MS, Model3dStatusPoller } from './status'

function status(s: GetModelStatusResponse['status']): GetModelStatusResponse {
	return {
		modelId: 'm1',
		name: 'tower.ifc',
		sourceFormat: 'ifc',
		status: s,
		stage: null,
		progress: 0,
		errorCode: null,
		manifest: null,
	}
}

const getToken = async () => 'token'

describe('Model3dStatusPoller', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('shares one poll loop between subscribers and stops at a terminal status', async () => {
		const responses = [status('queued'), status('converting'), status('ready')]
		const fetchStatus = vi.fn(async () => responses.shift()!)
		const poller = new Model3dStatusPoller(fetchStatus)
		const a = vi.fn()
		const b = vi.fn()

		poller.subscribe('m1', getToken, a)
		poller.subscribe('m1', getToken, b)
		expect(poller.getSubscriberCount('m1')).toBe(2)
		await vi.advanceTimersByTimeAsync(0)
		expect(fetchStatus).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(MODEL3D_POLL_INTERVAL_MS * 5)
		expect(fetchStatus).toHaveBeenCalledTimes(3)
		expect(a).toHaveBeenLastCalledWith({ kind: 'ok', status: status('ready') })
		expect(b).toHaveBeenLastCalledWith({ kind: 'ok', status: status('ready') })
	})

	it('stops polling when the last subscriber leaves and restarts on a new subscriber', async () => {
		const fetchStatus = vi.fn(async () => status('converting'))
		const poller = new Model3dStatusPoller(fetchStatus)

		const unsubA = poller.subscribe('m1', getToken, vi.fn())
		const unsubB = poller.subscribe('m1', getToken, vi.fn())
		await vi.advanceTimersByTimeAsync(0)
		unsubA()
		await vi.advanceTimersByTimeAsync(MODEL3D_POLL_INTERVAL_MS)
		expect(fetchStatus).toHaveBeenCalledTimes(2)

		unsubB()
		expect(poller.getSubscriberCount('m1')).toBe(0)
		await vi.advanceTimersByTimeAsync(MODEL3D_POLL_INTERVAL_MS * 5)
		expect(fetchStatus).toHaveBeenCalledTimes(2)

		poller.subscribe('m1', getToken, vi.fn())
		await vi.advanceTimersByTimeAsync(0)
		expect(fetchStatus).toHaveBeenCalledTimes(3)
	})

	it('gives a late subscriber the latest snapshot at once', async () => {
		const poller = new Model3dStatusPoller(async () => status('ready'))
		poller.subscribe('m1', getToken, vi.fn())
		await vi.advanceTimersByTimeAsync(0)
		const late = vi.fn()
		poller.subscribe('m1', getToken, late)
		expect(late).toHaveBeenCalledWith({ kind: 'ok', status: status('ready') })
	})

	it('stops on 403 with a forbidden snapshot', async () => {
		const fetchStatus = vi.fn(async () => {
			throw new Model3dApiError(403, 'forbidden', 'forbidden')
		})
		const poller = new Model3dStatusPoller(fetchStatus)
		const listener = vi.fn()
		poller.subscribe('m1', getToken, listener)
		await vi.advanceTimersByTimeAsync(MODEL3D_POLL_INTERVAL_MS * 3)
		expect(fetchStatus).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenLastCalledWith({ kind: 'forbidden' })
	})

	it('refresh restarts a stopped loop', async () => {
		const responses = [status('failed'), status('queued'), status('ready')]
		const fetchStatus = vi.fn(async () => responses.shift()!)
		const poller = new Model3dStatusPoller(fetchStatus)
		poller.subscribe('m1', getToken, vi.fn())
		await vi.advanceTimersByTimeAsync(MODEL3D_POLL_INTERVAL_MS * 3)
		expect(fetchStatus).toHaveBeenCalledTimes(1)

		poller.refresh('m1')
		await vi.advanceTimersByTimeAsync(MODEL3D_POLL_INTERVAL_MS * 3)
		expect(fetchStatus).toHaveBeenCalledTimes(3)
	})
})
