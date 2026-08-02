export const LISTING_WORKSPACE_VERSION = 1 as const
export const MAX_COMPARE_ENTRIES = 3
export const WORKFLOW_STATUSES = [
  'review',
  'call',
  'visit',
  'hold',
  'finalist',
  'rejected',
] as const

export type ListingWorkflowStatus = (typeof WORKFLOW_STATUSES)[number]

export interface ListingWorkflowRecord {
  workflowId: string
  status: ListingWorkflowStatus
  updatedAt: string
}

export interface CompareEntry {
  entryId: string
  listingIds: string[]
  addedAt: string
}

export interface ListingWorkspaceData {
  version: typeof LISTING_WORKSPACE_VERSION
  workflow: Record<string, ListingWorkflowRecord>
  compareEntries: CompareEntry[]
}

const LISTING_ID_PATTERN = /^(?:naver|daangn):\d+$/
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_WORKFLOW_IDS = 2_000
const MAX_IDS_PER_COMPARE_ENTRY = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isListingId(value: unknown): value is string {
  return typeof value === 'string' && LISTING_ID_PATTERN.test(value)
}

function uniqueListingIds(values: readonly unknown[]): string[] {
  return [...new Set(values.filter(isListingId))]
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function isWorkflowStatus(value: unknown): value is ListingWorkflowStatus {
  return typeof value === 'string' && (WORKFLOW_STATUSES as readonly string[]).includes(value)
}

function isWorkflowRecord(value: unknown): value is ListingWorkflowRecord {
  if (!isRecord(value)) return false
  return (
    Object.keys(value).length === 3 &&
    typeof value.workflowId === 'string' &&
    RECORD_ID_PATTERN.test(value.workflowId) &&
    isWorkflowStatus(value.status) &&
    isTimestamp(value.updatedAt)
  )
}

function normalizeWorkflow(value: unknown): Record<string, ListingWorkflowRecord> {
  if (!isRecord(value)) return {}
  const entries = Object.entries(value)
    .filter((entry): entry is [string, ListingWorkflowRecord] => (
      isListingId(entry[0]) && isWorkflowRecord(entry[1])
    ))
  if (entries.length > MAX_WORKFLOW_IDS) return {}

  // 같은 workflowId의 모든 플랫폼 복제본은 반드시 완전히 같은 상태여야 한다.
  const signatures = new Map<string, string>()
  const groupSizes = new Map<string, number>()
  const conflicts = new Set<string>()
  for (const [, record] of entries) {
    const signature = `${record.status}\u0000${record.updatedAt}`
    const previous = signatures.get(record.workflowId)
    if (previous !== undefined && previous !== signature) conflicts.add(record.workflowId)
    signatures.set(record.workflowId, signature)
    const groupSize = (groupSizes.get(record.workflowId) ?? 0) + 1
    groupSizes.set(record.workflowId, groupSize)
    if (groupSize > MAX_IDS_PER_COMPARE_ENTRY) conflicts.add(record.workflowId)
  }
  return Object.fromEntries(entries.filter(([, record]) => !conflicts.has(record.workflowId)))
}

function normalizeCompareEntries(value: unknown): CompareEntry[] {
  if (!Array.isArray(value) || value.length > MAX_COMPARE_ENTRIES) return []
  const entries: CompareEntry[] = []
  const usedListingIds = new Set<string>()
  const usedEntryIds = new Set<string>()

  for (const raw of value) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).length !== 3 ||
      typeof raw.entryId !== 'string' ||
      !RECORD_ID_PATTERN.test(raw.entryId) ||
      usedEntryIds.has(raw.entryId) ||
      !Array.isArray(raw.listingIds) ||
      raw.listingIds.length === 0 ||
      raw.listingIds.length > MAX_IDS_PER_COMPARE_ENTRY ||
      !isTimestamp(raw.addedAt)
    ) continue
    const listingIds = uniqueListingIds(raw.listingIds)
    if (
      listingIds.length !== raw.listingIds.length ||
      listingIds.some((id) => usedListingIds.has(id))
    ) continue
    usedEntryIds.add(raw.entryId)
    listingIds.forEach((id) => usedListingIds.add(id))
    entries.push({ entryId: raw.entryId, listingIds, addedAt: raw.addedAt })
  }
  return entries
}

export function emptyListingWorkspace(): ListingWorkspaceData {
  return { version: LISTING_WORKSPACE_VERSION, workflow: {}, compareEntries: [] }
}

export function parseListingWorkspace(value: unknown): ListingWorkspaceData {
  if (!isRecord(value) || value.version !== LISTING_WORKSPACE_VERSION) {
    return emptyListingWorkspace()
  }
  return {
    version: LISTING_WORKSPACE_VERSION,
    workflow: normalizeWorkflow(value.workflow),
    compareEntries: normalizeCompareEntries(value.compareEntries),
  }
}

export function statusForListingIds(
  workspace: ListingWorkspaceData,
  listingIds: readonly unknown[],
): ListingWorkflowStatus | null {
  const records = uniqueListingIds(listingIds)
    .map((id) => workspace.workflow[id])
    .filter((record): record is ListingWorkflowRecord => Boolean(record))
  if (records.length === 0) return null
  return records.reduce((latest, record) => (
    Date.parse(record.updatedAt) > Date.parse(latest.updatedAt) ? record : latest
  )).status
}

/** 병합 구성 변경 전의 모든 복제본까지 따라가며 상태를 갱신하거나 삭제한다. */
export function setStatusForListingIds(
  workspace: ListingWorkspaceData,
  listingIds: readonly unknown[],
  status: ListingWorkflowStatus | null,
  newWorkflowId: string,
  updatedAt: string,
): ListingWorkspaceData {
  const currentIds = uniqueListingIds(listingIds)
  if (currentIds.length === 0 || currentIds.length > MAX_IDS_PER_COMPARE_ENTRY) return workspace
  if (
    (status !== null && !isWorkflowStatus(status)) ||
    !RECORD_ID_PATTERN.test(newWorkflowId) ||
    !isTimestamp(updatedAt)
  ) return workspace

  const overlappingWorkflowIds = new Set(
    currentIds
      .map((id) => workspace.workflow[id]?.workflowId)
      .filter((id): id is string => Boolean(id)),
  )
  const inheritedIds = Object.entries(workspace.workflow)
    .filter(([, record]) => overlappingWorkflowIds.has(record.workflowId))
    .map(([id]) => id)
  const linkedIds = uniqueListingIds([...currentIds, ...inheritedIds])
  const nextWorkflow = Object.fromEntries(
    Object.entries(workspace.workflow)
      .filter(([, record]) => !overlappingWorkflowIds.has(record.workflowId)),
  )

  if (status !== null) {
    const record: ListingWorkflowRecord = {
      workflowId: [...overlappingWorkflowIds][0] ?? newWorkflowId,
      status,
      updatedAt,
    }
    for (const id of linkedIds) nextWorkflow[id] = record
  }
  return { ...workspace, workflow: nextWorkflow }
}

export function compareEntryForListingIds(
  workspace: ListingWorkspaceData,
  listingIds: readonly unknown[],
): CompareEntry | null {
  const ids = new Set(uniqueListingIds(listingIds))
  return workspace.compareEntries.find((entry) => entry.listingIds.some((id) => ids.has(id))) ?? null
}

export function toggleCompareForListingIds(
  workspace: ListingWorkspaceData,
  listingIds: readonly unknown[],
  newEntryId: string,
  addedAt: string,
): ListingWorkspaceData {
  const ids = uniqueListingIds(listingIds)
  if (ids.length === 0 || ids.length > MAX_IDS_PER_COMPARE_ENTRY) return workspace
  const currentIds = new Set(ids)
  const overlappingEntries = workspace.compareEntries.filter((entry) => (
    entry.listingIds.some((id) => currentIds.has(id))
  ))
  if (overlappingEntries.length > 0) {
    const overlappingEntryIds = new Set(overlappingEntries.map((entry) => entry.entryId))
    return {
      ...workspace,
      compareEntries: workspace.compareEntries.filter(
        (entry) => !overlappingEntryIds.has(entry.entryId),
      ),
    }
  }
  if (
    workspace.compareEntries.length >= MAX_COMPARE_ENTRIES ||
    !RECORD_ID_PATTERN.test(newEntryId) ||
    !isTimestamp(addedAt)
  ) return workspace
  return {
    ...workspace,
    compareEntries: [
      ...workspace.compareEntries,
      { entryId: newEntryId, listingIds: ids, addedAt },
    ],
  }
}

export function clearCompareEntries(workspace: ListingWorkspaceData): ListingWorkspaceData {
  if (workspace.compareEntries.length === 0) return workspace
  return { ...workspace, compareEntries: [] }
}

/**
 * 수집 사이에 네이버·당근 카드 병합 구성이 바뀌면 과거의 별도 비교 항목을
 * 현재 카드 하나로 합치고, 더 이상 존재하지 않는 선택은 정리한다.
 */
export function reconcileCompareEntries(
  workspace: ListingWorkspaceData,
  currentListingIdGroups: readonly (readonly unknown[])[],
): ListingWorkspaceData {
  const groups = currentListingIdGroups
    .map((values) => uniqueListingIds(values))
    .filter((values) => values.length > 0)
  const groupByListingId = new Map<string, number>()
  groups.forEach((group, index) => group.forEach((id) => groupByListingId.set(id, index)))

  const resolved = new Map<number, CompareEntry>()
  for (const entry of workspace.compareEntries) {
    const groupIndexes = [...new Set(
      entry.listingIds
        .map((id) => groupByListingId.get(id))
        .filter((index): index is number => index !== undefined),
    )]
    // 전역 merged ID 유일성이 수집기에서 보장되므로 정상 데이터는 하나의
    // 현재 카드에만 해석된다. 손상된 다중 해석 항목은 보수적으로 버린다.
    if (groupIndexes.length !== 1) continue
    const groupIndex = groupIndexes[0]
    const previous = resolved.get(groupIndex)
    if (!previous || Date.parse(entry.addedAt) < Date.parse(previous.addedAt)) {
      resolved.set(groupIndex, {
        entryId: entry.entryId,
        listingIds: groups[groupIndex],
        addedAt: entry.addedAt,
      })
    }
  }
  const compareEntries = [...resolved.values()]
    .sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt))
    .slice(0, MAX_COMPARE_ENTRIES)
  if (JSON.stringify(compareEntries) === JSON.stringify(workspace.compareEntries)) return workspace
  return { ...workspace, compareEntries }
}
