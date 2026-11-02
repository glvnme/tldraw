import { createFileSyncSchema } from '@tldraw/dotcom-shared'
import { Model3dRevisionShapeUtil } from '../tla/model3d/Model3dRevisionShapeUtil'
import { Model3dShapeUtil } from '../tla/model3d/Model3dShapeUtil'
import { embedShapeUtils } from './embedShapeUtil'

// Module-scoped so the array keeps a stable identity across renders.
export const dotcomShapeUtils = [...embedShapeUtils, Model3dShapeUtil, Model3dRevisionShapeUtil]

// Built from the same helper as the sync worker's room schema; a mismatch fails the connect.
export const fileSyncSchema = createFileSyncSchema()
