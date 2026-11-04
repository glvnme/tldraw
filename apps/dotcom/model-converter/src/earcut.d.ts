declare module 'earcut' {
	export default function earcut(
		vertices: number[],
		holes?: number[],
		dimensions?: number
	): number[]
	export function deviation(
		vertices: number[],
		holes: number[] | undefined,
		dimensions: number,
		triangles: number[]
	): number
}
