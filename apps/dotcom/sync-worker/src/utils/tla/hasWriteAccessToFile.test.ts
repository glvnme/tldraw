import { DB } from '@tldraw/dotcom-shared'
import { Kysely } from 'kysely'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasWriteAccessToFile } from './hasWriteAccessToFile'

vi.mock('./getRole', () => ({ getRole: vi.fn(async () => null) }))

function dbWithFile(file: Record<string, unknown> | undefined) {
	return {
		selectFrom: () => ({
			where: () => ({ select: () => ({ executeTakeFirst: async () => file }) }),
		}),
	} as unknown as Kysely<DB>
}

const FILE = { owningGroupId: 'user-1', shared: false, sharedLinkType: 'view', isDeleted: false }

afterEach(() => vi.clearAllMocks())

describe('hasWriteAccessToFile', () => {
	// Thumbnail uploads for a model on a home-workspace board were refused.
	it('admits the owner of a home workspace, which has no group_user row', async () => {
		expect(await hasWriteAccessToFile(dbWithFile(FILE), 'file-1', 'user-1')).toBe(true)
	})

	it('refuses someone else on that home workspace', async () => {
		expect(await hasWriteAccessToFile(dbWithFile(FILE), 'file-1', 'user-2')).toBe(false)
	})

	it('refuses the owner once the file is deleted', async () => {
		const file = { ...FILE, isDeleted: true }
		expect(await hasWriteAccessToFile(dbWithFile(file), 'file-1', 'user-1')).toBe(false)
	})
})
