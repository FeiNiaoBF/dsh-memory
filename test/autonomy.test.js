import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, normalizeWorkspace } from '../store.js'
import { registerMemoryTools } from '../index.js'

async function fixture(run, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-autonomy-'))
  try {
    const a = join(root, 'a'), b = join(root, 'b')
    await mkdir(a); await mkdir(b)
    const path = join(root, 'data', 'memories.json')
    const store = new MemoryStore(path)
    const tools = new Map(), events = []
    const agent = { session: { id: 'live', header: { id: 'live', cwd: normalizeWorkspace(a) }, snapshotEvents: () => events } }
    let cwd = normalizeWorkspace(a)
    const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, workingDirectory: { get: () => cwd } }
    registerMemoryTools(ctx, store, config)
    const say = text => { const seq = events.length; events.push({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }); return seq }
    return await run({ a: normalizeWorkspace(a), b: normalizeWorkspace(b), store, path,
      call: (name, args) => tools.get(name).execute(args, { agent }), say,
      switchTo: value => { cwd = value; events.push({ seq: events.length, type: 'working-directory/change', data: { cwd: value } }) } })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('direct add and correction use user events without a second confirmation message', () => fixture(async f => {
  const quote = 'Aurora builds should use Linux'
  const seq = f.say(quote)
  const first = await f.call('memory_add', { content: 'Aurora builds use Linux', scope: 'workspace', expected_revision: (await f.call('memory_list', {})).revision, source_kind: 'user', source_quote: quote, source_seq: seq })
  assert.equal(first.value.source.seq, seq)
  assert.equal(first.value.workspace, f.a)
  const correction = 'Correction: Aurora builds now use Windows'
  await assert.rejects(f.call('memory_update', { id: first.value.id, content: 'Aurora builds use BSD', expected_revision: first.revision, source_kind: 'user', source_quote: quote, source_seq: seq }), /CURRENT_CORRECTION_REQUIRED/)
  const correctedSeq = f.say(correction)
  const updated = await f.call('memory_update', { id: first.value.id, content: 'Aurora builds use Windows', expected_revision: first.revision, source_kind: 'user', source_quote: correction, source_seq: correctedSeq })
  assert.equal(updated.value.id, first.value.id)
  assert.equal(updated.value.source.seq, correctedSeq)
  assert.equal(updated.value.content, 'Aurora builds use Windows')
  assert.equal((await f.call('memory_search', { query: 'Windows' })).entries[0].id, first.value.id)
}))

test('archived memory disappears from search, can be restored, and explicit forgetting erases it', () => fixture(async f => {
  const text = 'Aurora deployment uses staging'
  f.say(text)
  const saved = await f.call('memory_add', { content: text, scope: 'workspace', source_kind: 'user', source_quote: text, expected_revision: (await f.call('memory_list', {})).revision })
  const removed = await f.call('memory_delete', { id: saved.value.id, expected_revision: saved.revision })
  assert.equal((await f.call('memory_search', { query: 'Aurora' })).totalMatches, 0)
  assert.equal((await f.call('memory_list', {})).total, 0)
  const trash = await f.call('memory_trash', {})
  assert.equal(trash.entries[0].id, saved.value.id)
  assert.equal(trash.entries[0].expiresAt, removed.value.expiresAt)
  const restoreCommand = `恢复记忆 ${saved.value.id}`
  f.say(restoreCommand)
  const restored = await f.call('memory_restore', { id: saved.value.id, source_quote: restoreCommand, expected_revision: trash.revision })
  assert.equal(restored.value.entry.id, saved.value.id)
  assert.equal((await f.call('memory_search', { query: 'Aurora' })).totalMatches, 1)
  const forgetCommand = `永久遗忘记忆 ${saved.value.id}`
  f.say(forgetCommand)
  const forgotten = await f.call('memory_forget', { id: saved.value.id, source_quote: forgetCommand, expected_revision: restored.revision })
  assert.equal(forgotten.value.permanent, true)
  assert.equal((await f.call('memory_trash', {})).entries.length, 0)
  await assert.rejects(f.call('memory_restore', { id: saved.value.id, source_quote: forgetCommand, expected_revision: forgotten.revision }), /USER_ACTION_REQUIRED/)
  f.say(restoreCommand)
  await assert.rejects(f.call('memory_restore', { id: saved.value.id, source_quote: restoreCommand, expected_revision: forgotten.revision }), /NOT_FOUND/)
}))

test('approval mode blocks autonomous writes but accepts confirmed add, replace, and deletion', () => fixture(async f => {
  f.say('Keep the Aurora deployment preference')
  const revision = (await f.call('memory_list', {})).revision
  await assert.rejects(f.call('memory_add', { content: 'Use staging', scope: 'workspace', expected_revision: revision, source_kind: 'user', source_quote: 'Keep the Aurora deployment preference' }), /APPROVAL_REQUIRED/)
  const proposal = await f.call('memory_propose', { content: 'Use staging for Aurora', scope: 'workspace', expected_revision: revision })
  f.say(proposal.commands.confirm)
  const added = await f.call('memory_decide', { id: proposal.value.candidate.id, action: 'confirm', expected_revision: proposal.revision })
  assert.equal(added.value.action, 'added')
  f.say('Correction: use production checks for Aurora')
  await assert.rejects(f.call('memory_update', { id: added.value.entry.id, content: 'Use production checks for Aurora', source_kind: 'user', source_quote: 'Correction: use production checks for Aurora', expected_revision: added.revision }), /APPROVAL_REQUIRED/)
  const replacement = await f.call('memory_propose', { content: 'Use production checks for Aurora', scope: 'workspace', replace_id: added.value.entry.id, expected_revision: added.revision })
  f.say(replacement.commands.confirm)
  const updated = await f.call('memory_decide', { id: replacement.value.candidate.id, action: 'confirm', expected_revision: replacement.revision })
  assert.equal(updated.value.action, 'replaced')
  await assert.rejects(f.call('memory_delete', { id: added.value.entry.id, expected_revision: updated.revision }), /APPROVAL_REQUIRED/)
  const deletion = await f.call('memory_propose', { scope: 'workspace', delete_id: added.value.entry.id, expected_revision: updated.revision })
  assert.equal(deletion.value.candidate.action, 'delete')
  f.say(deletion.commands.confirm)
  const deleted = await f.call('memory_decide', { id: deletion.value.candidate.id, action: 'confirm', expected_revision: deletion.revision })
  assert.equal(deleted.value.action, 'deleted')
  assert.equal((await f.call('memory_list', {})).total, 0)
  assert.equal((await f.call('memory_trash', {})).entries[0].id, added.value.entry.id)
}, { writeApproval: true }))

test('archives remain scope limited and stale deletes cannot discard revised facts', () => fixture(async f => {
  const quote = 'Aurora uses a local cache'
  f.say(quote)
  const saved = await f.call('memory_add', { content: quote, scope: 'workspace', source_kind: 'user', source_quote: quote, expected_revision: (await f.call('memory_list', {})).revision })
  const deletion = await f.call('memory_propose', { scope: 'workspace', delete_id: saved.value.id, expected_revision: saved.revision })
  f.say('Correction: Aurora uses a remote cache')
  await f.call('memory_update', { id: saved.value.id, content: 'Aurora uses a remote cache', source_kind: 'user', source_quote: 'Correction: Aurora uses a remote cache', expected_revision: deletion.revision })
  f.say(deletion.commands.confirm)
  await assert.rejects(f.call('memory_decide', { id: deletion.value.candidate.id, action: 'confirm', expected_revision: (await f.call('memory_list', {})).revision }), /TARGET_CHANGED/)
  const revision = (await f.call('memory_list', {})).revision
  const removed = await f.call('memory_delete', { id: saved.value.id, expected_revision: revision })
  f.switchTo(f.b)
  assert.equal((await f.call('memory_trash', {})).entries.length, 0)
  const restoreCommand = `恢复记忆 ${saved.value.id}`
  f.say(restoreCommand)
  await assert.rejects(f.call('memory_restore', { id: saved.value.id, source_quote: restoreCommand, expected_revision: removed.revision }), /NOT_FOUND/)
}))

test('direct writes reject cross-workspace and unapproved Global scope', () => fixture(async f => {
  const quote = 'Aurora uses a local cache'
  const seq = f.say(quote)
  f.switchTo(f.b)
  const revision = (await f.call('memory_list', {})).revision
  const args = { content: quote, scope: 'workspace', source_kind: 'user', source_quote: quote, source_seq: seq, expected_revision: revision }
  await assert.rejects(f.call('memory_add', args), /SOURCE_WORKSPACE_MISMATCH/)
  await assert.rejects(f.call('memory_add', { ...args, scope: 'global' }), /GLOBAL_SCOPE_REQUIRED/)
  f.switchTo(f.a)
  const globalText = 'This preference applies across all workspaces: use UTF-8'
  const globalSeq = f.say(globalText)
  const shared = await f.call('memory_add', { content: 'Use UTF-8', scope: 'global', source_kind: 'user', source_quote: globalText, global_scope_quote: 'applies across all workspaces', source_seq: globalSeq, expected_revision: revision })
  f.switchTo(f.b)
  assert.equal((await f.call('memory_search', { query: 'UTF-8' })).entries[0].id, shared.value.id)
  f.say('Only in Aurora use UTF-16')
  await assert.rejects(f.call('memory_update', { id: shared.value.id, content: 'Use UTF-16', source_kind: 'user', source_quote: 'Only in Aurora use UTF-16', expected_revision: shared.revision }), /GLOBAL_SCOPE_REQUIRED/)
}))

test('long entries can be staged for deletion; expired archives never restore and are removed on the next write', () => fixture(async f => {
  const quote = 'Keep an Aurora build note'
  f.say(quote)
  const saved = await f.call('memory_add', { content: 'Aurora ' + 'x'.repeat(2500), scope: 'workspace', source_kind: 'user', source_quote: quote, expected_revision: (await f.call('memory_list', {})).revision })
  const proposal = await f.call('memory_propose', { scope: 'workspace', delete_id: saved.value.id, expected_revision: saved.revision })
  assert.ok(proposal.value.candidate.content.length <= 200)
  assert.equal(proposal.value.replaces.content.length, saved.value.content.length)
  f.say(proposal.commands.confirm)
  const removed = await f.call('memory_decide', { id: proposal.value.candidate.id, action: 'confirm', expected_revision: proposal.revision })
  const data = JSON.parse(await readFile(f.path, 'utf8'))
  data.trash[0].deletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
  data.trash[0].expiresAt = new Date(Date.now() - 1000).toISOString()
  await writeFile(f.path, JSON.stringify(data) + '\n')
  assert.equal((await f.call('memory_trash', {})).entries.length, 0)
  const restoreCommand = `恢复记忆 ${saved.value.id}`
  f.say(restoreCommand)
  await assert.rejects(f.call('memory_restore', { id: saved.value.id, source_quote: restoreCommand, expected_revision: (await f.call('memory_list', {})).revision }), /NOT_FOUND/)
  const stamp = 'Other durable note'
  f.say(stamp)
  await f.call('memory_add', { content: stamp, scope: 'workspace', source_kind: 'user', source_quote: stamp, expected_revision: (await f.call('memory_list', {})).revision })
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).trash.length, 0)
  assert.equal(removed.value.deletion.id, saved.value.id)
}))
