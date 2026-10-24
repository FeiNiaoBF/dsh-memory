import { MemoryStore } from '../store.js'
import { writeFile } from 'node:fs/promises'

const [path, workspace, expectedRevision, resultFile, content] = process.argv.slice(2)
try {
  await new MemoryStore(path).add({ content, scope: 'global', workspace, source: { kind: 'user', quote: content }, expectedRevision })
  await writeFile(resultFile, 'ok')
} catch (error) {
  await writeFile(resultFile, error.code ?? String(error))
}
