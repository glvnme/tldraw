// gltfpack ships no types. https://github.com/zeux/meshoptimizer/blob/master/js/README.md
declare module 'gltfpack' {
	export interface PackInterface {
		read(path: string): Uint8Array
		write(path: string, data: Uint8Array): void
	}
	/** Resolves to gltfpack's log; rejects with the log on failure. */
	export function pack(args: string[], iface: PackInterface): Promise<string>
}
