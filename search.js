import { MemoryError } from './store.js'

const stopwords = new Set(['a', 'an', 'and', 'are', 'about', 'can', 'do', 'does', 'for', 'how', 'i', 'in', 'is', 'me', 'my', 'of', 'or', 'our', 'please', 'that', 'the', 'this', 'to', 'we', 'what', 'where', 'which', 'with', 'you'])
const segments = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu
const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const normalized = value => value.normalize('NFKC').toLowerCase()

function terms(text) {
  const found = new Set()
  for (const segment of normalized(text).match(segments) ?? []) {
    if (eastAsian.test(segment)) {
      const characters = Array.from(segment)
      for (let i = 0; i + 1 < characters.length; i++) found.add(characters[i] + characters[i + 1])
    } else if (segment.length > 1 && !stopwords.has(segment)) found.add(segment)
  }
  return found
}

export function rankMemories(entries, workspace, query, limit = 5) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new MemoryError('INVALID_QUERY', 'Search query must contain 1–200 characters')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new MemoryError('INVALID_LIMIT', 'Search limit must be 1–10')
  const wanted = terms(query)
  if (!wanted.size || wanted.size > 24) throw new MemoryError('INVALID_QUERY', 'Use 1–24 meaningful words or adjacent Chinese characters')
  const phrase = normalized(query.trim()).replace(/\s+/gu, ' ')
  const ranked = []
  for (const entry of entries) {
    if (entry.source.workspace === undefined || (entry.scope !== 'global' && entry.workspace !== workspace)) continue
    const text = normalized(entry.content)
    const available = terms(entry.content)
    const matchedTerms = [...wanted].filter(term => available.has(term))
    if (!matchedTerms.length) continue
    ranked.push({ entry, matchedTerms, score: matchedTerms.length * 4 + (text.replace(/\s+/gu, ' ').includes(phrase) ? 3 : 0) })
  }
  ranked.sort((a, b) => b.score - a.score || b.entry.verifiedAt.localeCompare(a.entry.verifiedAt) || a.entry.id.localeCompare(b.entry.id))
  return {
    totalMatches: ranked.length,
    entries: ranked.slice(0, limit).map(({ entry, matchedTerms }) => {
      const compact = entry.content.replace(/\s+/gu, ' ').trim()
      const characters = Array.from(compact)
      return {
        id: entry.id, scope: entry.scope, verifiedAt: entry.verifiedAt,
        preview: characters.slice(0, 240).join(''), truncated: characters.length > 240,
        matchedTerms
      }
    })
  }
}
