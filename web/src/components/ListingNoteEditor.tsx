import { useEffect, useId, useState } from 'react'
import {
  MAX_LISTING_NOTE_LENGTH,
  type ListingNoteRecord,
} from '../listingNotesStore'
import type { ListingNoteSyncStatus } from '../useListingNotes'

const STATUS_LABEL: Record<ListingNoteSyncStatus, string> = {
  loading: '메모 불러오는 중',
  saving: '저장 중',
  saved: '기기 동기화됨',
  error: '메모 동기화 오류',
}

export function ListingNoteEditor({
  note,
  ready,
  syncStatus,
  onSave,
  onDelete,
}: {
  note: ListingNoteRecord | null
  ready: boolean
  syncStatus: ListingNoteSyncStatus
  onSave: (text: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note?.text ?? '')
  const editorId = useId()
  // 초기 계정 확인만 끝났다면 일시적 동기화 오류 중에도 로컬 편집과 재시도가 가능하다.
  const usable = ready

  useEffect(() => {
    if (!editing) setDraft(note?.text ?? '')
  }, [editing, note])

  const startEditing = () => {
    if (!usable) return
    setDraft(note?.text ?? '')
    setEditing(true)
  }

  const save = () => {
    const text = draft.trim()
    if (!text || text.length > MAX_LISTING_NOTE_LENGTH) return
    onSave(text)
    setEditing(false)
  }

  if (!editing && !note) {
    return (
      <div className="flex items-center gap-2 self-start">
        <button
          type="button"
          onClick={startEditing}
          disabled={!usable}
          className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11.5px] font-semibold text-dim transition-colors hover:text-blue disabled:cursor-not-allowed disabled:opacity-55"
          title={usable ? '이 매물에 나만의 메모 작성' : STATUS_LABEL[syncStatus]}
        >
          {usable ? '✎ 메모 추가' : STATUS_LABEL[syncStatus]}
        </button>
        {usable && syncStatus === 'error' && (
          <span className="text-[10.5px] font-medium text-rose">동기화 재시도 필요</span>
        )}
      </div>
    )
  }

  if (!editing && note) {
    return (
      <section className="rounded-xl border border-blue/15 bg-blue-bg/55 px-3 py-2.5" aria-label="개인 메모">
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-bold text-blue">내 메모</span>
          <span className={`ml-auto text-[10.5px] font-medium ${syncStatus === 'error' ? 'text-rose' : 'text-faint'}`}>
            {STATUS_LABEL[syncStatus]}
          </span>
        </div>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink">
          {note.text}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={startEditing}
            disabled={!usable}
            className="text-[11px] font-semibold text-blue disabled:opacity-50"
          >
            수정
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={!usable}
            className="text-[11px] font-semibold text-faint transition-colors hover:text-rose disabled:opacity-50"
          >
            삭제
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-blue/20 bg-surface-2 p-3" aria-label="개인 메모 편집">
      <label className="text-[11.5px] font-bold text-dim" htmlFor={editorId}>
        내 메모
      </label>
      <textarea
        id={editorId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={MAX_LISTING_NOTE_LENGTH}
        rows={3}
        autoFocus
        placeholder="중개사 확인사항, 방문 메모 등을 기록하세요."
        className="mt-2 w-full resize-y rounded-lg border border-line bg-white px-3 py-2 text-[12.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-blue"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="tnum text-[10.5px] text-faint">
          {draft.length.toLocaleString()} / {MAX_LISTING_NOTE_LENGTH.toLocaleString()}
        </span>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="ml-auto h-7 rounded-lg px-2.5 text-[11px] font-semibold text-dim"
        >
          취소
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!draft.trim() || draft.length > MAX_LISTING_NOTE_LENGTH}
          className="h-7 rounded-lg bg-blue px-3 text-[11px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          저장
        </button>
      </div>
    </section>
  )
}
