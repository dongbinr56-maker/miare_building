export const LISTING_NOTES_VERSION = 1 as const
export const MAX_LISTING_NOTE_LENGTH = 1_000
export const MAX_LISTING_NOTE_IDS = 2_000

const LISTING_ID_PATTERN = /^(?:naver|daangn):\d+$/
const NOTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface ListingNoteRecord {
  noteId: string
  text: string
  updatedAt: string
}

export type ListingNoteEntries = Record<string, ListingNoteRecord>

export interface PersistedListingNotes {
  version: typeof LISTING_NOTES_VERSION
  entries: ListingNoteEntries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isListingId(value: unknown): value is string {
  return typeof value === 'string' && LISTING_ID_PATTERN.test(value)
}

function normalizeIds(values: readonly unknown[]): string[] {
  return [...new Set(values.filter(isListingId))]
}

function isNote(value: unknown): value is ListingNoteRecord {
  if (!isRecord(value)) return false
  return (
    Object.keys(value).length === 3 &&
    typeof value.noteId === 'string' &&
    NOTE_ID_PATTERN.test(value.noteId) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_LISTING_NOTE_LENGTH &&
    value.text.trim().length > 0 &&
    typeof value.updatedAt === 'string' &&
    value.updatedAt.length <= 64 &&
    Number.isFinite(Date.parse(value.updatedAt))
  )
}

export function parseListingNotes(value: unknown): ListingNoteEntries {
  if (!isRecord(value) || value.version !== LISTING_NOTES_VERSION || !isRecord(value.entries)) {
    return {}
  }
  const rawEntries = Object.entries(value.entries)
  if (rawEntries.length > MAX_LISTING_NOTE_IDS) return {}
  const validEntries = rawEntries.filter((entry): entry is [string, ListingNoteRecord] => (
    isListingId(entry[0]) && isNote(entry[1])
  ))
  const signatures = new Map<string, string>()
  const conflictingNoteIds = new Set<string>()
  for (const [, note] of validEntries) {
    const signature = `${note.updatedAt}\u0000${note.text}`
    const previous = signatures.get(note.noteId)
    if (previous !== undefined && previous !== signature) conflictingNoteIds.add(note.noteId)
    signatures.set(note.noteId, signature)
  }
  return Object.fromEntries(
    validEntries.filter(([, note]) => !conflictingNoteIds.has(note.noteId)),
  )
}

export function listingNotesData(entries: ListingNoteEntries): PersistedListingNotes {
  return { version: LISTING_NOTES_VERSION, entries }
}

/** 병합 카드의 원본 ID 중 가장 최근 메모를 카드의 현재 메모로 사용한다. */
export function noteForListingIds(
  entries: ListingNoteEntries,
  listingIds: readonly unknown[],
): ListingNoteRecord | null {
  const candidates = normalizeIds(listingIds)
    .map((id) => entries[id])
    .filter((note): note is ListingNoteRecord => Boolean(note))
  if (candidates.length === 0) return null
  return candidates.reduce((latest, note) => (
    Date.parse(note.updatedAt) > Date.parse(latest.updatedAt) ? note : latest
  ))
}

/**
 * 병합 카드의 모든 플랫폼 ID에 같은 noteId를 기록한다. 이전에 분리돼 있던
 * 메모들이 새 병합 카드에서 만난 경우 가장 최근 noteId로 합치고 오래된 복제본을
 * 함께 제거한다.
 */
export function upsertNoteForListingIds(
  entries: ListingNoteEntries,
  listingIds: readonly unknown[],
  text: string,
  newNoteId: string,
  updatedAt: string,
): ListingNoteEntries {
  const ids = normalizeIds(listingIds)
  const normalizedText = text.trim()
  if (
    ids.length === 0 ||
    normalizedText.length === 0 ||
    normalizedText.length > MAX_LISTING_NOTE_LENGTH ||
    !NOTE_ID_PATTERN.test(newNoteId) ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    return entries
  }

  const existing = noteForListingIds(entries, ids)
  const overlappingNoteIds = new Set(
    ids.map((id) => entries[id]?.noteId).filter((id): id is string => Boolean(id)),
  )
  const inheritedIds = Object.entries(entries)
    .filter(([, value]) => overlappingNoteIds.has(value.noteId))
    .map(([id]) => id)
  const linkedIds = normalizeIds([...ids, ...inheritedIds])
  const note: ListingNoteRecord = {
    noteId: existing?.noteId ?? newNoteId,
    text: normalizedText,
    updatedAt,
  }
  const next: ListingNoteEntries = Object.fromEntries(
    Object.entries(entries).filter(([, value]) => !overlappingNoteIds.has(value.noteId)),
  )
  for (const id of linkedIds) next[id] = note
  return next
}

/** 어느 플랫폼 ID에서 삭제해도 같은 병합 메모의 모든 복제본을 제거한다. */
export function deleteNotesForListingIds(
  entries: ListingNoteEntries,
  listingIds: readonly unknown[],
): ListingNoteEntries {
  const noteIds = new Set(
    normalizeIds(listingIds)
      .map((id) => entries[id]?.noteId)
      .filter((id): id is string => Boolean(id)),
  )
  if (noteIds.size === 0) return entries
  return Object.fromEntries(
    Object.entries(entries).filter(([, note]) => !noteIds.has(note.noteId)),
  )
}
