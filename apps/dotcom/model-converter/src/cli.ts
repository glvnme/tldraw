import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Model3dSourceFormat } from '@tldraw/dotcom-shared'
import { errorCodeOf, log } from './errors'
import { parseConvertJob } from './job'
import { convertModel } from './pipeline'
import { childExecArgv, JOB_EXEC_ARGV, runJobInChild } from './runner'

const USAGE = `Usage:
  convert <input.(3dm|ifc|stl|obj|glb)> <output.glb>   convert a file, write <output>.manifest.json
  once <job.json>                                  run one Model3dConvertJob against the worker`

const LIMITS = {
	maxSourceBytes: 1024 ** 3,
	maxGlbBytes: 512 * 1024 ** 2,
	maxTriangles: 50_000_000,
	timeoutMs: 30 * 60_000,
}

async function convert(input: string, output: string) {
	// Same flags as a job's child process: re-run under them if this process lacks them.
	if (!JOB_EXEC_ARGV.every((flag) => process.execArgv.includes(flag))) {
		const result = spawnSync(process.execPath, [...childExecArgv(), ...process.argv.slice(1)], {
			stdio: 'inherit',
		})
		process.exit(result.status ?? 1)
	}
	const format = extname(input).slice(1).toLowerCase() as Model3dSourceFormat
	const source = new Uint8Array(readFileSync(input))
	const started = performance.now()
	try {
		const { glb, manifest } = await convertModel(
			source,
			format,
			LIMITS,
			(stage, progress) => console.error(`${stage} ${Math.round(progress * 100)}%`),
			basename(input)
		)
		writeFileSync(output, glb)
		writeFileSync(
			output.replace(/\.glb$/, '') + '.manifest.json',
			JSON.stringify(manifest, null, '\t')
		)
		log(
			JSON.stringify({
				input,
				format,
				sourceBytes: source.byteLength,
				glbBytes: glb.byteLength,
				triangles: manifest.triangleCount,
				nodes: manifest.nodeCount,
				ms: Math.round(performance.now() - started),
				// resourceUsage reports KiB.
				peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
			})
		)
	} catch (error) {
		console.error(`${errorCodeOf(error)}: ${(error as Error).message}`)
		process.exit(1)
	}
}

const [command, ...args] = process.argv.slice(2)
if (command === 'convert' && args.length === 2) {
	await convert(args[0], args[1])
} else if (command === 'once' && args.length === 1) {
	const job = parseConvertJob(JSON.parse(readFileSync(args[0], 'utf8')))
	if (!job) throw new Error('Not a Model3dConvertJob')
	await runJobInChild(job)
} else {
	console.error(USAGE)
	process.exit(1)
}
