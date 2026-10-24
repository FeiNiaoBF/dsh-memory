import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, normalizeWorkspace } from '../store.js'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-search-'))
  try {
    const a = join(root, 'a'), b = join(root, 'b')
    await mkdir(a); await mkdir(b)
    return await run({ a: normalizeWorkspace(a), b: normalizeWorkspace(b), path: join(root, 'data', 'memories.json') })
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function add(store, { scope = 'workspace', workspace, content, reviewed = true }) {
  const { revision } = await store.list(workspace)
  const source = reviewed
    ? { kind: 'user', quote: content, sessionId: 'source', seq: 0, workspace,
        ...(scope === 'global' ? { globalScopeQuote: 'This applies across workspaces' } : {}) }
    : { kind: 'user', quote: content }
  return (await store.add({ content, scope, workspace, source, expectedRevision: revision })).value
}

test('search ranks related older facts ahead of unrelated recent ones without leaking workspaces', () => fixture(async ({ a, b, path }) => {
  const store = new MemoryStore(path)
  const older = await add(store, { workspace: a, content: 'Project Aurora deployment uses Linux containers' })
  await add(store, { workspace: a, content: 'Meeting notes about lunch menu' })
  const shared = await add(store, { scope: 'global', workspace: a, content: 'Across projects deployment uses staging checks' })
  await add(store, { workspace: a, content: 'Project Aurora deployment legacy draft', reviewed: false })
  const privateB = await add(store, { workspace: b, content: 'Project Aurora deployment only in private B' })
  const before = await readFile(path, 'utf8')
  const result = await store.search(a, 'Aurora deployment', 1)
  assert.equal(result.totalMatches, 2)
  assert.deepEqual(result.entries.map(entry => entry.id), [older.id])
  assert.deepEqual(result.entries[0].matchedTerms, ['aurora', 'deployment'])
  assert.equal(result.entries[0].scope, 'workspace')
  assert.deepEqual((await store.search(a, 'deployment')).entries.map(entry => entry.id), [shared.id, older.id])
  assert.deepEqual((await store.search(b, 'deployment')).entries.map(entry => entry.id), [privateB.id, shared.id])
  assert.deepEqual(await store.search(a, 'astronomy nebula'), { totalMatches: 0, entries: [] })
  assert.equal(await readFile(path, 'utf8'), before)
}))

test('Chinese adjacent terms rank related old facts and previews stay bounded', () => fixture(async ({ a, path }) => {
  const store = new MemoryStore(path)
  const related = await add(store, { workspace: a, content: '发布任务使用灰度检查' })
  await add(store, { workspace: a, content: '新的采购记录' })
  const long = await add(store, { workspace: a, content: 'Linux ' + 'x'.repeat(500) })
  assert.deepEqual((await store.search(a, '灰度发布')).entries.map(entry => entry.id), [related.id])
  const [preview] = (await store.search(a, 'Linux')).entries
  assert.equal(preview.id, long.id)
  assert.equal(preview.truncated, true)
  assert.ok(Array.from(preview.preview).length <= 240)
}))

test('search rejects empty, overlong or uninformative queries and oversized limits', () => fixture(async ({ a, path }) => {
  const store = new MemoryStore(path)
  await assert.rejects(store.search(a, '  '), /INVALID_QUERY/)
  await assert.rejects(store.search(a, 'a'), /INVALID_QUERY/)
  await assert.rejects(store.search(a, 'x'.repeat(201)), /INVALID_QUERY/)
  await assert.rejects(store.search(a, 'release', 0), /INVALID_LIMIT/)
  await assert.rejects(store.search(a, 'release', 11), /INVALID_LIMIT/)
}))
