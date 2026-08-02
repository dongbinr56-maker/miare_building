import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearCompareEntries,
  compareEntryForListingIds,
  emptyListingWorkspace,
  parseListingWorkspace,
  reconcileCompareEntries,
  setStatusForListingIds,
  statusForListingIds,
  toggleCompareForListingIds,
} from '../src/listingWorkspaceStore.ts'

const t1 = '2026-08-03T01:00:00Z'
const t2 = '2026-08-03T02:00:00Z'

test('병합된 모든 플랫폼 ID에 같은 진행 상태를 복제한다', () => {
  const workspace = setStatusForListingIds(
    emptyListingWorkspace(),
    ['naver:1', 'daangn:2'],
    'review',
    'workflow-1',
    t1,
  )
  assert.equal(statusForListingIds(workspace, ['naver:1']), 'review')
  assert.equal(statusForListingIds(workspace, ['daangn:2']), 'review')
  assert.equal(workspace.workflow['naver:1'], workspace.workflow['daangn:2'])
})

test('병합 ID 구성이 바뀌어도 상태 정체성을 이어서 갱신하고 전체 삭제한다', () => {
  const first = setStatusForListingIds(
    emptyListingWorkspace(),
    ['naver:1', 'daangn:2'],
    'call',
    'workflow-1',
    t1,
  )
  const updated = setStatusForListingIds(
    first,
    ['daangn:2', 'naver:3'],
    'visit',
    'unused-id',
    t2,
  )
  for (const id of ['naver:1', 'daangn:2', 'naver:3']) {
    assert.equal(updated.workflow[id]?.workflowId, 'workflow-1')
    assert.equal(updated.workflow[id]?.status, 'visit')
  }
  const deleted = setStatusForListingIds(updated, ['naver:3'], null, 'unused-id', t2)
  assert.deepEqual(deleted.workflow, {})
})

test('비교 선택은 최대 3개이며 겹치는 ID로 동일 매물을 식별한다', () => {
  let workspace = emptyListingWorkspace()
  workspace = toggleCompareForListingIds(workspace, ['naver:1', 'daangn:2'], 'entry-1', t1)
  workspace = toggleCompareForListingIds(workspace, ['naver:3'], 'entry-2', t1)
  workspace = toggleCompareForListingIds(workspace, ['daangn:4'], 'entry-3', t1)
  workspace = toggleCompareForListingIds(workspace, ['naver:5'], 'entry-4', t1)
  assert.equal(workspace.compareEntries.length, 3)
  assert.equal(compareEntryForListingIds(workspace, ['daangn:2', 'naver:99'])?.entryId, 'entry-1')

  workspace = toggleCompareForListingIds(workspace, ['daangn:2'], 'unused', t2)
  assert.equal(workspace.compareEntries.length, 2)
  assert.equal(compareEntryForListingIds(workspace, ['naver:1']), null)

  assert.deepEqual(clearCompareEntries(workspace).compareEntries, [])
})

test('손상된 상태 복제본과 중복 비교 항목을 파싱에서 제거한다', () => {
  const parsed = parseListingWorkspace({
    version: 1,
    workflow: {
      'naver:1': { workflowId: 'same', status: 'review', updatedAt: t1 },
      'daangn:2': { workflowId: 'same', status: 'visit', updatedAt: t2 },
      'naver:3': { workflowId: 'valid', status: 'hold', updatedAt: t1 },
    },
    compareEntries: [
      { entryId: 'one', listingIds: ['naver:1'], addedAt: t1 },
      { entryId: 'two', listingIds: ['naver:1', 'daangn:2'], addedAt: t2 },
    ],
  })
  assert.deepEqual(Object.keys(parsed.workflow), ['naver:3'])
  assert.deepEqual(parsed.compareEntries.map((entry) => entry.entryId), ['one'])
})

test('과거 별도 비교 항목이 현재 하나로 병합되면 한 번에 모두 해제한다', () => {
  let workspace = emptyListingWorkspace()
  workspace = toggleCompareForListingIds(workspace, ['naver:1'], 'naver-entry', t1)
  workspace = toggleCompareForListingIds(workspace, ['daangn:2'], 'daangn-entry', t1)
  assert.equal(workspace.compareEntries.length, 2)

  workspace = toggleCompareForListingIds(
    workspace,
    ['naver:1', 'daangn:2'],
    'unused-entry',
    t2,
  )
  assert.equal(workspace.compareEntries.length, 0)
  assert.equal(compareEntryForListingIds(workspace, ['naver:1', 'daangn:2']), null)
})

test('과거 별도 비교 항목을 현재 병합 카드 하나로 정규화해 슬롯도 하나만 쓴다', () => {
  let workspace = emptyListingWorkspace()
  workspace = toggleCompareForListingIds(workspace, ['naver:1'], 'naver-entry', t1)
  workspace = toggleCompareForListingIds(workspace, ['daangn:2'], 'daangn-entry', t2)

  const reconciled = reconcileCompareEntries(workspace, [
    ['naver:1', 'daangn:2'],
    ['naver:3'],
  ])

  assert.equal(reconciled.compareEntries.length, 1)
  assert.deepEqual(reconciled.compareEntries[0], {
    entryId: 'naver-entry',
    listingIds: ['naver:1', 'daangn:2'],
    addedAt: t1,
  })
})
