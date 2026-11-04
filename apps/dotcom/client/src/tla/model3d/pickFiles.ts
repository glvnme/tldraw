import { MODEL3D_SOURCE_FORMATS } from '@tldraw/dotcom-shared'

/**
 * Opens the system file picker for model files. The input lives on `document.body` with a native
 * listener, like tldraw's media picker, so a re-render of the button that opened it cannot drop
 * the selection.
 */
export function pickModel3dFiles(doc: Document = document) {
	return new Promise<File[]>((resolve) => {
		const input = doc.createElement('input')
		input.type = 'file'
		input.accept = MODEL3D_SOURCE_FORMATS.map((format) => `.${format}`).join(',')
		input.multiple = true
		input.style.display = 'none'
		const done = (files: File[]) => {
			input.remove()
			resolve(files)
		}
		input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true })
		input.addEventListener('cancel', () => done([]), { once: true })
		doc.body.appendChild(input)
		input.click()
	})
}
