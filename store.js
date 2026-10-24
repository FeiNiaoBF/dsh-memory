import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { rankMemories } from './search.js'

export class MemoryError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'MemoryError'
    this.code = code
  }
}

const blank = () => ({ version: 1, entries: [] })
const revision = text => createHash('sha256').update(text ?? '').digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const timestamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

export function normalizeWorkspace(path) {
  if (typeof path !== 'string' || !path) throw new MemoryError('WORKSPACE_REQUIRED', 'A workspace directory is required')
  let canonical
  try { canonical = realpathSync.native(resolve(path)) }
  catch (error) { throw new MemoryError('WORKSPACE_UNAVAILABLE', `Cannot resolve workspace directory: ${error.message}`) }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function parse(text) {
  if (text === undefined) return blank()
  let data
  try { data = JSON.parse(text) }
  catch { throw new MemoryError('DATA_CORRUPT', 'Memory JSON is invalid; restore a backup before retrying') }
  if (!object(data) || ![1, 2].includes(data.version) || !Array.isArray(data.entries) || Object.keys(data).some(key => !['version', 'entries'].includes(key))) {
    throw new MemoryError('DATA_CORRUPT', 'Memory format is unknown; restore or migrate it before retrying')
  }
  const ids = new Set()
  for (const entry of data.entries) {
    if (!object(entry) || typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id) || ids.has(entry.id) ||
        typeof entry.content !== 'string' || !entry.content.trim() || entry.content.length > 4000 ||
        !['global', 'workspace'].includes(entry.scope) ||
        (entry.scope === 'workspace' ? typeof entry.workspace !== 'string' || !entry.workspace : entry.workspace !== null) ||
        !object(entry.source) || !['user', 'session'].includes(entry.source.kind) ||
        typeof entry.source.quote !== 'string' || !entry.source.quote.trim() || entry.source.quote.length > 2000 ||
        Object.keys(entry.source).some(key => !['kind','quote','sessionId','seq','workspace','globalScopeQuote'].includes(key)) ||
        (entry.source.workspace === undefined
          ? entry.source.globalScopeQuote !== undefined || (entry.source.kind === 'session' ? typeof entry.source.sessionId !== 'string' || !entry.source.sessionId || !Number.isSafeInteger(entry.source.seq) || entry.source.seq < 0 : entry.source.sessionId !== undefined || entry.source.seq !== undefined)
          : typeof entry.source.workspace !== 'string' || !entry.source.workspace || typeof entry.source.sessionId !== 'string' || !entry.source.sessionId || !Number.isSafeInteger(entry.source.seq) || entry.source.seq < 0 ||
            (entry.scope === 'workspace' && entry.source.workspace !== entry.workspace) ||
            (entry.scope === 'global' && (typeof entry.source.globalScopeQuote !== 'string' || !entry.source.globalScopeQuote.trim() || entry.source.globalScopeQuote.length > 2000)) ||
            (entry.scope === 'workspace' && entry.source.globalScopeQuote !== undefined)) ||
        (data.version === 1 && entry.source.workspace !== undefined) ||
        !timestamp(entry.createdAt) || !timestamp(entry.verifiedAt) || Object.keys(entry).some(key => !['id','content','scope','workspace','source','createdAt','verifiedAt'].includes(key))) {
      throw new MemoryError('DATA_CORRUPT', 'Memory entry is invalid; restore a backup before retrying')
    }
    ids.add(entry.id)
  }
  return data
}

async function read(path) {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new MemoryError('DATA_UNREADABLE', `Cannot read memory data: ${error.message}`)
  }
}
function readSync(path) {
  try { return readFileSync(path, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new MemoryError('DATA_UNREADABLE', `Cannot read memory data: ${error.message}`)
  }
}
function visible(entry, workspace) { return entry.scope === 'global' || entry.workspace === workspace }
function reviewed(entry) { return { ...entry, reviewStatus: entry.source.workspace === undefined ? 'needs-review' : 'verified' } }
function match(entries, prefix, workspace) {
  if (typeof prefix !== 'string' || !prefix.trim()) throw new MemoryError('ID_REQUIRED', 'Supply an id or a unique id prefix')
  const found = entries.filter(entry => visible(entry, workspace) && entry.id.startsWith(prefix))
  if (!found.length) throw new MemoryError('NOT_FOUND', 'No visible memory matches this id')
  if (found.length !== 1) throw new MemoryError('AMBIGUOUS', `Id prefix matches ${found.length} visible memories; use a longer id`)
  return found[0]
}

export class MemoryStore {
  constructor(path) {
    this.path = path
  }
  snapshot() {
    const text = readSync(this.path)
    return { ...parse(text), revision: revision(text) }
  }
  async snapshotAsync() {
    const text = await read(this.path)
    return { ...parse(text), revision: revision(text) }
  }
  async mutate(expectedRevision, operation) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new MemoryError('REVISION_REQUIRED', 'Call memory_list first and pass its exact revision')
    }
    // The lock needs its parent to exist. No data is created until validation succeeds.
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const previous = await read(this.path)
      const state = parse(previous)
      if (revision(previous) !== expectedRevision) {
        throw new MemoryError('STALE_REVISION', 'Memory changed since the last list; list again and retry')
      }
      const value = await operation(state)
      state.version = 2
      const next = JSON.stringify(state, null, 2) + '\n'
      parse(next)
      if (revision(await read(this.path)) !== revision(previous)) {
        throw new MemoryError('EXTERNAL_MODIFICATION', 'Memory changed outside the writer lock; inspect and list again')
      }
      await writeFileAtomic(this.path, next, { mode: 0o600, dirMode: 0o700 })
      return { value, revision: revision(next) }
    }, { waitMs: 5000 })
  }
  async add(input) {
    return this.mutate(input.expectedRevision, state => {
      if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 4000) throw new MemoryError('INVALID_CONTENT', 'Content must contain 1–4000 characters')
      if (!['global','workspace'].includes(input.scope) || (input.scope === 'workspace' && !input.workspace)) throw new MemoryError('INVALID_SCOPE', 'Choose global or a resolved workspace')
      if (input.source?.workspace !== undefined && input.scope === 'workspace' && input.source.workspace !== input.workspace) throw new MemoryError('SOURCE_WORKSPACE_MISMATCH', 'Source belongs to another workspace')
      const now = new Date().toISOString()
      const entry = { id: randomUUID(), content: input.content.trim(), scope: input.scope,
        workspace: input.scope === 'workspace' ? input.workspace : null, source: input.source,
        createdAt: now, verifiedAt: now }
      state.entries.push(entry)
      return entry
    })
  }
  async update(input) {
    return this.mutate(input.expectedRevision, state => {
      const entry = match(state.entries, input.id, input.workspace)
      if (input.source?.workspace !== undefined && entry.scope === 'workspace' && input.source.workspace !== entry.workspace) throw new MemoryError('SOURCE_WORKSPACE_MISMATCH', 'Source belongs to another workspace')
      if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 4000) throw new MemoryError('INVALID_CONTENT', 'Content must contain 1–4000 characters')
      entry.content = input.content.trim()
      entry.source = input.source
      entry.verifiedAt = new Date().toISOString()
      return entry
    })
  }
  async delete(input) {
    return this.mutate(input.expectedRevision, state => {
      const entry = match(state.entries, input.id, input.workspace)
      state.entries.splice(state.entries.indexOf(entry), 1)
      return { id: entry.id, deleted: true }
    })
  }
  async search(workspace, query, limit = 5) {
    const state = await this.snapshotAsync()
    return rankMemories(state.entries, workspace, query, limit)
  }
  async get(id, workspace) { return reviewed(match((await this.snapshotAsync()).entries, id, workspace)) }
  async list(workspace, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new MemoryError('INVALID_PAGE', 'offset must be nonnegative and limit must be 1–100')
    }
    const state = await this.snapshotAsync()
    const visibleEntries = state.entries.filter(entry => visible(entry, workspace))
    return { revision: state.revision, total: visibleEntries.length, entries: visibleEntries.slice(offset, offset + limit).map(reviewed),
      nextOffset: offset + limit < visibleEntries.length ? offset + limit : null }
  }
}
