import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deleteNotesForListingIds,
  listingNotesData,
  noteForListingIds,
  parseListingNotes,
  upsertNoteForListingIds,
} from '../src/listingNotesStore.ts'

test('병합 카드의 모든 플랫폼 ID가 같은 개인 메모를 찾는다', () => {
  const saved = upsertNoteForListingIds(
    {},
    ['naver:123', 'daangn:456'],
    '전기 용량 확인',
    'note-1',
    '2026-08-03T01:00:00Z',
  )

  assert.equal(noteForListingIds(saved, ['naver:123'])?.text, '전기 용량 확인')
  assert.equal(noteForListingIds(saved, ['daangn:456'])?.noteId, 'note-1')
  assert.equal(saved['naver:123'], saved['daangn:456'])
})

test('대표 ID나 병합 구성이 바뀌어도 기존 ID와 새 ID에 메모가 유지된다', () => {
  const first = upsertNoteForListingIds(
    {},
    ['naver:123', 'daangn:456'],
    '첫 메모',
    'note-1',
    '2026-08-03T01:00:00Z',
  )
  const updated = upsertNoteForListingIds(
    first,
    ['daangn:456', 'naver:789'],
    '수정된 메모',
    'unused-new-id',
    '2026-08-03T02:00:00Z',
  )

  for (const id of ['naver:123', 'daangn:456', 'naver:789']) {
    assert.equal(updated[id]?.noteId, 'note-1')
    assert.equal(updated[id]?.text, '수정된 메모')
  }
})

test('병합 ID 하나에서 삭제해도 같은 noteId의 모든 복제본을 삭제한다', () => {
  const saved = upsertNoteForListingIds(
    {},
    ['naver:123', 'daangn:456'],
    '삭제 대상',
    'note-1',
    '2026-08-03T01:00:00Z',
  )
  const deleted = deleteNotesForListingIds(saved, ['daangn:456'])

  assert.deepEqual(deleted, {})
})

test('서로 다른 메모가 새 병합 카드에서 만나면 최신 메모를 보존한다', () => {
  const oldNote = upsertNoteForListingIds(
    {},
    ['naver:123'],
    '이전 메모',
    'note-old',
    '2026-08-03T01:00:00Z',
  )
  const splitNotes = upsertNoteForListingIds(
    oldNote,
    ['daangn:456'],
    '최신 메모',
    'note-new',
    '2026-08-03T02:00:00Z',
  )

  assert.equal(
    noteForListingIds(splitNotes, ['naver:123', 'daangn:456'])?.text,
    '최신 메모',
  )
})

test('손상 레코드는 버리고 HTML 모양 문자열은 실행하지 않는 일반 텍스트로 보존한다', () => {
  const xssLikeText = '<img src=x onerror=alert(1)>'
  const parsed = parseListingNotes({
    version: 1,
    entries: {
      'naver:123': {
        noteId: 'note-safe',
        text: xssLikeText,
        updatedAt: '2026-08-03T01:00:00Z',
      },
      'bad:1': {
        noteId: 'note-bad',
        text: '버려짐',
        updatedAt: '2026-08-03T01:00:00Z',
      },
    },
  })

  assert.deepEqual(Object.keys(parsed), ['naver:123'])
  assert.equal(listingNotesData(parsed).entries['naver:123']?.text, xssLikeText)

  const conflicting = parseListingNotes({
    version: 1,
    entries: {
      'naver:1': {
        noteId: 'same-note',
        text: '첫 내용',
        updatedAt: '2026-08-03T01:00:00Z',
      },
      'daangn:2': {
        noteId: 'same-note',
        text: '상충 내용',
        updatedAt: '2026-08-03T01:00:00Z',
      },
    },
  })
  assert.deepEqual(conflicting, {})
})
