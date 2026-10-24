import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, normalizeWorkspace } from '../store.js'
import { registerMemoryTools, renderPrompt, promptEntriesForWorkspace } from '../index.js'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-candidate-'))
  try {
    const a = join(root, 'a'), b = join(root, 'b')
    await mkdir(a); await mkdir(b)
    const path = join(root, 'store', 'memories.json')
    const store = new MemoryStore(path), tools = new Map(), events = []
    const agent = { session: { id: 'session-a', header: { id: 'session-a', cwd: normalizeWorkspace(a) }, snapshotEvents: () => events } }
    let cwd = normalizeWorkspace(a)
    const ctx = { workingDirectory: { get: () => cwd }, tools: { register: definition => tools.set(definition.name, definition) } }
    registerMemoryTools(ctx, store)
    const call = (name, args) => tools.get(name).execute(args, { agent })
    const say = text => { const seq = events.length; events.push({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }); return seq }
    return await run({ a: normalizeWorkspace(a), b: normalizeWorkspace(b), path, store, agent, call, say, setCwd: value => { cwd = value; events.push({ type: 'working-directory/change', seq: events.length, data: { cwd: value } }) } })
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function propose({ call, say }, content, scope = 'workspace', replace_id, language) {
  say(`Please review a proposed memory: ${content}`)
  const { revision } = await call('memory_list', {})
  return call('memory_propose', { content, scope, replace_id, language, expected_revision: revision })
}

test('candidate needs a later direct user confirmation; it stays outside list, search and prompt entries', () => fixture(async f => {
  const pending = await propose(f, 'Aurora releases on Tuesdays')
  const id = pending.value.candidate.id
  assert.equal((await f.call('memory_list', {})).total, 0)
  assert.deepEqual(await f.store.search(f.a, 'Aurora'), { totalMatches: 0, entries: [] })
  assert.equal(renderPrompt(promptEntriesForWorkspace(f.store.snapshot().entries, f.a), { promptEntries: 5, promptCharacters: 1200 }), '')
  assert.equal((await f.call('memory_pending', {})).candidates[0].id, id)
  assert.equal((await new MemoryStore(f.path).pending(f.a, 'session-a')).candidates[0].id, id)
  const originalSession = f.agent.session
  f.agent.session = { ...originalSession, id: 'session-b', header: { ...originalSession.header, id: 'session-b' } }
  assert.equal((await f.call('memory_pending', {})).total, 0)
  await assert.rejects(f.call('memory_decide', { id, action: 'confirm', expected_revision: pending.revision }), /CANDIDATE_NOT_FOUND/)
  f.agent.session = originalSession
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).version, 3)
  await assert.rejects(f.call('memory_decide', { id, action: 'confirm', expected_revision: pending.revision }), /DECISION_SOURCE_REQUIRED/)
  assert.equal((await f.call('memory_list', {})).total, 0)
  f.say(pending.commands.confirm)
  const result = await f.call('memory_decide', { id, action: 'confirm', expected_revision: pending.revision })
  assert.equal(result.value.action, 'added')
  assert.equal(result.value.entry.content, 'Aurora releases on Tuesdays')
  assert.equal(result.value.entry.source.seq, 1)
  assert.equal((await f.store.search(f.a, 'Aurora')).totalMatches, 1)
  assert.equal((await f.call('memory_pending', {})).total, 0)
  await assert.rejects(f.call('memory_decide', { id, action: 'confirm', expected_revision: result.revision }), /CANDIDATE_NOT_FOUND/)
}))

test('reject discards a candidate; revision needs a new explicit confirmation', () => fixture(async f => {
  const first = await propose(f, 'Wrong configuration')
  f.say(first.commands.reject)
  const rejected = await f.call('memory_decide', { id: first.value.candidate.id, action: 'reject', expected_revision: first.revision })
  assert.equal(rejected.value.action, 'rejected')
  assert.equal((await f.call('memory_list', {})).total, 0)
  const second = await propose(f, 'Original configuration')
  f.say(second.commands.revisePrefix + 'Corrected configuration')
  const revised = await f.call('memory_decide', { id: second.value.candidate.id, action: 'revise', new_content: 'Corrected configuration', expected_revision: second.revision })
  assert.equal(revised.value.candidate.content, 'Corrected configuration')
  await assert.rejects(f.call('memory_decide', { id: second.value.candidate.id, action: 'confirm', expected_revision: revised.revision }), /DECISION_SOURCE_REQUIRED/)
  f.say(revised.commands.confirm)
  const confirmed = await f.call('memory_decide', { id: second.value.candidate.id, action: 'confirm', expected_revision: revised.revision })
  assert.equal(confirmed.value.entry.content, 'Corrected configuration')
  assert.equal((await f.call('memory_list', {})).total, 1)
}))

test('replacement preserves old id and refuses target edits or another workspace', () => fixture(async f => {
  const original = (await f.store.add({ content: 'Old Aurora preference', scope: 'workspace', workspace: f.a, source: { kind: 'user', quote: 'Old Aurora preference' }, expectedRevision: (await f.store.list(f.a)).revision })).value
  const first = await propose(f, 'New Aurora preference', 'workspace', original.id)
  f.setCwd(f.b)
  assert.equal((await f.call('memory_pending', {})).total, 0)
  f.say(first.commands.confirm)
  await assert.rejects(f.call('memory_decide', { id: first.value.candidate.id, action: 'confirm', expected_revision: first.revision }), /CANDIDATE_NOT_FOUND/)
  f.setCwd(f.a)
  const source_seq = f.say(first.commands.confirm)
  await f.store.update({ id: original.id, workspace: f.a, content: 'Someone else revised Aurora', source: { kind: 'user', quote: 'Someone else revised Aurora' }, expectedRevision: first.revision })
  await assert.rejects(f.call('memory_decide', { id: first.value.candidate.id, action: 'confirm', source_seq, expected_revision: (await f.store.list(f.a)).revision }), /TARGET_CHANGED/)
  assert.equal((await f.call('memory_pending', {})).total, 1)
  f.say(first.commands.reject)
  await f.call('memory_decide', { id: first.value.candidate.id, action: 'reject', expected_revision: (await f.store.list(f.a)).revision })
  const second = await propose(f, 'Final Aurora preference', 'workspace', original.id)
  assert.equal(second.value.replaces.id, original.id)
  f.say(second.commands.confirm)
  const replaced = await f.call('memory_decide', { id: second.value.candidate.id, action: 'confirm', expected_revision: second.revision })
  assert.equal(replaced.value.action, 'replaced')
  assert.equal(replaced.value.entry.id, original.id)
  assert.equal(replaced.value.entry.createdAt, original.createdAt)
  assert.equal((await f.store.list(f.a)).total, 1)
}))

test('Global confirmation requires the same user message to state cross-workspace scope', () => fixture(async f => {
  const result = await propose(f, 'Use UTF-8 for shared output', 'global')
  const candidate = result.value.candidate
  assert.match(result.commands.confirm, /适用于所有工作区/)
  f.say(`确认记忆候选 ${candidate.id}：${candidate.content}`)
  await assert.rejects(f.call('memory_decide', { id: candidate.id, action: 'confirm', expected_revision: result.revision }), /DECISION_SOURCE_REQUIRED/)
  f.say(result.commands.confirm)
  const confirmed = await f.call('memory_decide', { id: candidate.id, action: 'confirm', expected_revision: result.revision })
  assert.equal(confirmed.value.entry.source.globalScopeQuote, '适用于所有工作区')
  assert.equal((await f.store.search(f.b, 'UTF-8')).totalMatches, 1)
}))

test('English commands remain English after candidate revision and Global approval', () => fixture(async f => {
  const proposal = await propose(f, 'Use UTF-8 everywhere', 'global', undefined, 'en')
  const id = proposal.value.candidate.id
  assert.match(proposal.commands.confirm, /Applies across all workspaces/)
  f.say(proposal.commands.revisePrefix + 'Use UTF-8 for all project outputs')
  const revised = await f.call('memory_decide', { id, action: 'revise', new_content: 'Use UTF-8 for all project outputs', expected_revision: proposal.revision })
  assert.match(revised.commands.confirm, /^Confirm memory candidate/)
  assert.equal((await f.call('memory_pending', {})).candidates[0].commands.confirm, revised.commands.confirm)
  f.say(revised.commands.confirm)
  const saved = await f.call('memory_decide', { id, action: 'confirm', expected_revision: revised.revision })
  assert.equal(saved.value.entry.source.globalScopeQuote, 'Applies across all workspaces')
  assert.equal((await f.store.search(f.b, 'UTF-8')).totalMatches, 1)
}))

test('two store instances cannot confirm one candidate twice', () => fixture(async f => {
  const proposed = await propose(f, 'Aurora build uses local cache')
  const candidate = proposed.value.candidate
  const seq = f.say(proposed.commands.confirm)
  const other = new MemoryStore(f.path)
  const source = { kind: 'user', quote: candidate.content, sessionId: 'session-a', seq, workspace: f.a }
  const attempts = await Promise.allSettled([
    f.call('memory_decide', { id: candidate.id, action: 'confirm', expected_revision: proposed.revision }),
    other.decide({ id: candidate.id, sessionId: 'session-a', workspace: f.a, action: 'confirm', source, expectedRevision: proposed.revision })
  ])
  assert.deepEqual(attempts.map(item => item.status).sort(), ['fulfilled', 'rejected'])
  assert.match(attempts.find(item => item.status === 'rejected').reason.message, /STALE_REVISION/)
  assert.equal((await f.store.list(f.a)).total, 1)
  assert.equal((await f.store.pending(f.a, 'session-a')).total, 0)
}))

test('v2 data stays readable; invalid v3 candidates fail closed without edits', () => fixture(async f => {
  const old = { version: 2, entries: [] }
  await mkdir(join(f.path, '..'), { recursive: true })
  await writeFile(f.path, JSON.stringify(old))
  assert.equal((await f.store.pending(f.a, 'session-a')).total, 0)
  const corrupt = JSON.stringify({ ...old, version: 3, candidates: [{ id: 'bad' }] })
  await writeFile(f.path, corrupt)
  await assert.rejects(f.store.list(f.a), /DATA_CORRUPT/)
  await assert.rejects(f.store.propose({ content: 'Fact', scope: 'workspace', workspace: f.a, sessionId: 'session-a', proposedAfterSeq: 0, expectedRevision: '0'.repeat(64) }), /DATA_CORRUPT|STALE_REVISION/)
  assert.equal(await readFile(f.path, 'utf8'), corrupt)
}))
