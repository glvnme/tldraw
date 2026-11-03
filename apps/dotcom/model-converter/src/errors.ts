import type { Model3dErrorCode } from '@tldraw/dotcom-shared'

/** A failure with the code the converter reports for it; anything else is `conversion_failed`. */
export class ConvertError extends Error {
	constructor(
		readonly code: Model3dErrorCode,
		message: string
	) {
		super(message)
	}
}

export function errorCodeOf(error: unknown): Model3dErrorCode {
	return error instanceof ConvertError ? error.code : 'conversion_failed'
}

export function log(message: string) {
	process.stdout.write(message + '\n')
}
