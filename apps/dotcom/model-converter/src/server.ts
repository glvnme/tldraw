import { createConverterServer } from './app'
import { log } from './errors'
import { JobQueue } from './queue'
import { runJobInChild } from './runner'

const PORT = Number(process.env.PORT ?? 25502)

createConverterServer(new JobQueue(runJobInChild)).listen(PORT, '127.0.0.1', () => {
	log(`model converter listening on http://127.0.0.1:${PORT}`)
})
