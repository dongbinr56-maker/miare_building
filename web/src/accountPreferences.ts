export type AccountPreferenceKind = 'favorites' | 'hidden'

export interface AccountPreferenceResult {
  accountId: string
  exists: boolean
  data: unknown
}

function endpoint(kind: AccountPreferenceKind): string {
  const base = import.meta.env.BASE_URL
  return `${base}api/preferences?kind=${encodeURIComponent(kind)}`
}

function isResult(value: unknown): value is AccountPreferenceResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return (
    typeof result.accountId === 'string' &&
    /^[a-f0-9]{64}$/.test(result.accountId) &&
    typeof result.exists === 'boolean' &&
    'data' in result
  )
}

export async function loadAccountPreference(
  kind: AccountPreferenceKind,
): Promise<AccountPreferenceResult> {
  const response = await fetch(endpoint(kind), {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`계정 설정 조회 실패: HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!isResult(value)) throw new Error('계정 설정 응답 형식 오류')
  return value
}

export async function saveAccountPreference(
  kind: AccountPreferenceKind,
  data: unknown,
): Promise<AccountPreferenceResult> {
  const response = await fetch(endpoint(kind), {
    method: 'PUT',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'miare-dashboard',
    },
    body: JSON.stringify({ data }),
  })
  if (!response.ok) throw new Error(`계정 설정 저장 실패: HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!isResult(value)) throw new Error('계정 설정 응답 형식 오류')
  return value
}
