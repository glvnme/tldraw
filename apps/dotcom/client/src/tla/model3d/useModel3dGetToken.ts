import { useCallback } from 'react'
import { useTldrawCurrentUser } from '../hooks/useUser'
import { GetModel3dToken } from './api'

export function useModel3dGetToken(): GetModel3dToken {
	const user = useTldrawCurrentUser()
	return useCallback(async () => (user ? await user.getToken() : undefined), [user])
}
