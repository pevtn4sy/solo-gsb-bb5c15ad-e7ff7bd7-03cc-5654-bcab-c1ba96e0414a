import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import TextView from './components/TextView'
import CodingForm from './components/CodingForm'
import ConflictDialog from './components/ConflictDialog'
import Sidebar from './components/Sidebar'
import CooccurrenceView from './components/CooccurrenceView'
import SpeakerView from './components/SpeakerView'
import DistributionView from './components/DistributionView'
import GapView from './components/GapView'
import TransitionView from './components/TransitionView'
import ReviewView from './components/ReviewView'
import SearchBatchPanel from './components/SearchBatchPanel'
import ImportDialog from './components/ImportDialog'
import MigrationDialog from './components/MigrationDialog'
import MemoView from './components/MemoView'
import { codePointLength, codePointSlice } from './textIndex'

/**
 * 请求次序守卫：每个加载器持有一个单调序号，发起请求时取号，响应落地前
 * 校验是否仍是最新一次。跨文档切换或连续刷新时，迟到的旧响应一律丢弃，
 * 只展示当前文档最新一次请求的结果。
 */
function useRequestOrder() {
  const seqRef = useRef(0)
  return useMemo(
    () => ({
      next: () => ++seqRef.current,
      isLatest: (seq) => seq === seqRef.current,
    }),
    []
  )
}

export default function App() {
  const [docs, setDocs] = useState([])
  const [docId, setDocId] = useState(null)
  const [docData, setDocData] = useState(null) // {document, codes, codings}
  const [codebook, setCodebook] = useState([]) // 带 usage_count
  const [filters, setFilters] = useState(null) // null=全部；否则 Set(codeId)
  const [selection, setSelection] = useState(null)
  const [editing, setEditing] = useState(null)
  const [conflict, setConflict] = useState(null) // {preview, payload}
  const [flashRange, setFlashRange] = useState(null)
  const [error, setError] = useState(null)
  const [showNewDoc, setShowNewDoc] = useState(false)
  const [newDoc, setNewDoc] = useState({ title: '', content: '' })
  const [view, setView] = useState('text') // text | cooccurrence | speakers | distribution | gaps | transitions
  const [coocStats, setCoocStats] = useState(null)
  const [coocLoading, setCoocLoading] = useState(false)
  const [coocError, setCoocError] = useState(null)
  const [speakerStats, setSpeakerStats] = useState(null)
  const [speakerLoading, setSpeakerLoading] = useState(false)
  const [speakerError, setSpeakerError] = useState(null)
  const [distStats, setDistStats] = useState(null)
  const [distLoading, setDistLoading] = useState(false)
  const [distError, setDistError] = useState(null)
  const [gapStats, setGapStats] = useState(null)
  const [gapLoading, setGapLoading] = useState(false)
  const [gapError, setGapError] = useState(null)
  const [transStats, setTransStats] = useState(null)
  const [transLoading, setTransLoading] = useState(false)
  const [transError, setTransError] = useState(null)
  // 标注抽样复核批次（null = 尚未加载；{batch: null} = 当前文档无批次）
  const [reviewData, setReviewData] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState(null)
  const [gapMinLen, setGapMinLen] = useState(1) // 最小缺口长度筛选
  const [gapCursor, setGapCursor] = useState(-1) // 上一处/下一处导航位置
  const [pendingLocate, setPendingLocate] = useState(null)
  const [showImport, setShowImport] = useState(false)
  const [showMigration, setShowMigration] = useState(false)
  // 分析备忘录：active / archived 两个分区（null = 尚未加载）
  const [memoData, setMemoData] = useState(null)
  const [memoLoading, setMemoLoading] = useState(false)
  const [memoError, setMemoError] = useState(null)

  // 文档异步次序：currentDocRef 始终指向当前文档；docReqSeq / codesReqSeq
  // 分别为文档读取与编码本读取的单调序号，只允许最新一次请求落地结果
  const currentDocRef = useRef(null)
  const docReqSeq = useRef(0)
  const codesReqSeq = useRef(0)

  // 各文档作用域统计 / 复核 / 备忘录加载器的请求次序守卫：
  // 切换文档或连续刷新时，迟到的旧响应一律丢弃
  const coocOrder = useRequestOrder()
  const speakerOrder = useRequestOrder()
  const distOrder = useRequestOrder()
  const gapOrder = useRequestOrder()
  const transOrder = useRequestOrder()
  const reviewOrder = useRequestOrder()
  const memoOrder = useRequestOrder()

  const showError = useCallback((e) => {
    setError(e.message || String(e))
    setTimeout(() => setError(null), 5000)
  }, [])

  const loadCodes = useCallback(async () => {
    const seq = ++codesReqSeq.current
    try {
      const data = await api.listCodes()
      if (seq === codesReqSeq.current) setCodebook(data)
    } catch (e) {
      if (seq === codesReqSeq.current) showError(e)
    }
  }, [showError])

  // 文档读取始终针对「当前文档」：响应落地前同时校验请求次序与当前文档，
  // 切到 B 后迟到的 A 响应、被更新请求取代的旧响应一律丢弃，正文与标注
  // 只展示当前文档的最新结果
  const loadDocument = useCallback(async () => {
    const id = currentDocRef.current
    if (id == null) return
    const seq = ++docReqSeq.current
    try {
      const data = await api.getDocument(id)
      if (seq === docReqSeq.current && id === currentDocRef.current) {
        setDocData(data)
      }
    } catch (e) {
      if (seq === docReqSeq.current && id === currentDocRef.current) showError(e)
    }
  }, [showError])

  useEffect(() => {
    ;(async () => {
      try {
        const list = await api.listDocuments()
        setDocs(list)
        if (list.length > 0) setDocId((cur) => cur ?? list[0].id)
      } catch (e) {
        showError(e)
      }
    })()
    loadCodes()
  }, [loadCodes, showError])

  useEffect(() => {
    if (docId == null) return
    currentDocRef.current = docId
    // 切换加载期间清空旧文档数据：正文 / 侧栏 / 表单整体卸载，
    // 不会用旧正文、旧标注或旧表单状态操作新文档
    setDocData(null)
    setEditing(null)
    setSelection(null)
    // 冲突确认若跨过文档切换：随冲突预览一并失效
    setConflict(null)
    // 跨文档定位的待定位片段指向新文档本身，需保留；其余情况清除
    setPendingLocate((cur) => (cur && cur.docId === docId ? cur : null))
    // 各文档作用域的统计 / 复核数据随切换清空，新结果到达前不展示旧文档结果
    setCoocStats(null)
    setCoocError(null)
    setSpeakerStats(null)
    setSpeakerError(null)
    setDistStats(null)
    setDistError(null)
    setGapStats(null)
    setGapError(null)
    setTransStats(null)
    setTransError(null)
    setReviewData(null)
    setReviewError(null)
    // 备忘录数据按文档隔离：切文档后回到备忘录标签时重新加载
    setMemoData(null)
    setMemoError(null)
    loadDocument()
  }, [docId, loadDocument])

  const refresh = useCallback(async () => {
    // 无参：始终重读「当前文档」；loadDocument 内部还会再做一次次序校验
    await Promise.all([loadDocument(), loadCodes()])
  }, [loadDocument, loadCodes])

  // 迁移会改动正文长度与文档标注数：同时刷新文档列表（顶栏计数）
  const refreshAfterMigration = useCallback(async () => {
    await Promise.all([refresh(), api.listDocuments().then(setDocs).catch(showError)])
  }, [refresh, showError])

  // ---------- 编码共现统计（随当前文档与编码筛选同步） ----------

  const filteredCodeIds = useMemo(() => {
    if (filters === null) return null
    return codebook.map((c) => c.id).filter((id) => filters.has(id))
  }, [filters, codebook])

  const loadCooccurrence = useCallback(async () => {
    if (docId == null) return
    const seq = coocOrder.next()
    // 全部编码被取消勾选：直接给空结果，不请求后端
    if (filteredCodeIds && filteredCodeIds.length === 0) {
      setCoocStats({ document_id: docId, codes: [], pairs: [] })
      setCoocError(null)
      setCoocLoading(false)
      return
    }
    setCoocLoading(true)
    setCoocError(null)
    try {
      const data = await api.getCooccurrence(docId, filteredCodeIds)
      if (coocOrder.isLatest(seq)) setCoocStats(data)
    } catch (e) {
      if (coocOrder.isLatest(seq)) {
        setCoocStats(null)
        setCoocError(e.message || String(e))
      }
    } finally {
      if (coocOrder.isLatest(seq)) setCoocLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, coocOrder])

  useEffect(() => {
    loadCooccurrence()
  }, [loadCooccurrence])

  // ---------- 说话人分析（随当前文档与编码筛选同步） ----------

  const loadSpeakers = useCallback(async () => {
    if (docId == null) return
    const seq = speakerOrder.next()
    // 编码全部取消勾选时传空数组：后端仅返回文本长度统计，不带编码列
    setSpeakerLoading(true)
    setSpeakerError(null)
    try {
      const data = await api.getSpeakerStats(docId, filteredCodeIds)
      if (speakerOrder.isLatest(seq)) setSpeakerStats(data)
    } catch (e) {
      if (speakerOrder.isLatest(seq)) {
        setSpeakerStats(null)
        setSpeakerError(e.message || String(e))
      }
    } finally {
      if (speakerOrder.isLatest(seq)) setSpeakerLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, speakerOrder])

  useEffect(() => {
    loadSpeakers()
  }, [loadSpeakers])

  // ---------- 跨文档编码分布对比（随编码筛选与标注变化同步） ----------

  const loadDistribution = useCallback(async () => {
    const seq = distOrder.next()
    // 与说话人分析一致：编码全部取消勾选时传空数组，后端仅返回文档列表
    setDistLoading(true)
    setDistError(null)
    try {
      const data = await api.getCodeDistribution(filteredCodeIds)
      if (distOrder.isLatest(seq)) setDistStats(data)
    } catch (e) {
      if (distOrder.isLatest(seq)) {
        setDistStats(null)
        setDistError(e.message || String(e))
      }
    } finally {
      if (distOrder.isLatest(seq)) setDistLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [filteredCodeIds, docData, distOrder])

  useEffect(() => {
    loadDistribution()
  }, [loadDistribution])

  // ---------- 覆盖缺口（随当前文档与编码筛选同步） ----------

  const loadGaps = useCallback(async () => {
    if (docId == null) return
    const seq = gapOrder.next()
    // 与说话人分析一致：编码全部取消勾选时传空数组，全文即一个缺口
    setGapLoading(true)
    setGapError(null)
    try {
      const data = await api.getGaps(docId, filteredCodeIds)
      if (gapOrder.isLatest(seq)) setGapStats(data)
    } catch (e) {
      if (gapOrder.isLatest(seq)) {
        setGapStats(null)
        setGapError(e.message || String(e))
      }
    } finally {
      if (gapOrder.isLatest(seq)) setGapLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, gapOrder])

  useEffect(() => {
    loadGaps()
  }, [loadGaps])

  // ---------- 编码流转（随当前文档与编码筛选同步） ----------

  const loadTransitions = useCallback(async () => {
    if (docId == null) return
    const seq = transOrder.next()
    // 与说话人分析一致：编码全部取消勾选时传空数组，无状态区间与转移
    setTransLoading(true)
    setTransError(null)
    try {
      const data = await api.getTransitions(docId, filteredCodeIds)
      if (transOrder.isLatest(seq)) setTransStats(data)
    } catch (e) {
      if (transOrder.isLatest(seq)) {
        setTransStats(null)
        setTransError(e.message || String(e))
      }
    } finally {
      if (transOrder.isLatest(seq)) setTransLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, transOrder])

  useEffect(() => {
    loadTransitions()
  }, [loadTransitions])

  // ---------- 标注抽样复核（批次内容随文档 / 标注变化刷新新鲜度） ----------

  const loadReview = useCallback(async () => {
    if (docId == null) return
    const seq = reviewOrder.next()
    setReviewLoading(true)
    setReviewError(null)
    try {
      const data = await api.getReview(docId)
      if (reviewOrder.isLatest(seq)) setReviewData(data)
    } catch (e) {
      if (reviewOrder.isLatest(seq)) {
        setReviewData(null)
        setReviewError(e.message || String(e))
      }
    } finally {
      if (reviewOrder.isLatest(seq)) setReviewLoading(false)
    }
    // docData 变化（标注增删改 / 迁移）后重新读取批次的 stale 标记
  }, [docId, docData, reviewOrder])

  useEffect(() => {
    loadReview()
  }, [loadReview])

  // ---------- 分析备忘录（在办 / 已归档两个分区，进入标签时加载） ----------

  // 与 loadDocument 同口径：始终读取「当前文档」，旧闭包迟到的调用也只会
  // 重读当前文档，不会把上一篇文档的备忘录写回界面
  const loadMemos = useCallback(async () => {
    const id = currentDocRef.current
    if (id == null) return
    const seq = memoOrder.next()
    setMemoLoading(true)
    setMemoError(null)
    try {
      const [active, archived] = await Promise.all([
        api.listMemos(id, 'active'),
        api.listMemos(id, 'archived'),
      ])
      if (memoOrder.isLatest(seq) && id === currentDocRef.current) {
        setMemoData({ active: active.memos, archived: archived.memos })
      }
    } catch (e) {
      if (memoOrder.isLatest(seq) && id === currentDocRef.current) {
        setMemoError(e.message || String(e))
      }
    } finally {
      if (memoOrder.isLatest(seq) && id === currentDocRef.current) {
        setMemoLoading(false)
      }
    }
  }, [memoOrder])

  // 首次进入备忘录标签时加载；在标签页内发生任何备忘录操作后再进来也刷新
  useEffect(() => {
    if (view === 'memo' && memoData === null) loadMemos()
  }, [view, memoData, loadMemos])

  // 最小缺口长度筛选在前端进行，避免每次调整都重新请求
  const visibleGaps = useMemo(
    () => (gapStats?.gaps ?? []).filter((g) => g.length >= gapMinLen),
    [gapStats, gapMinLen]
  )

  // 缺口数据或筛选变化后，导航游标回到未定位状态
  useEffect(() => {
    setGapCursor(-1)
  }, [visibleGaps])

  // ---------- 编码创建 / 编辑（含冲突检测） ----------

  // payload 携带提交时捕获的目标文档：提交目标始终与预览正文所属文档一致
  async function doSubmit(payload, resolution) {
    const { docId: targetDocId, codeId, start, end, editing: editTarget } = payload
    if (editTarget) {
      await api.updateCoding(editTarget.id, {
        code_id: codeId,
        start,
        end,
        resolution,
      })
    } else {
      await api.createCoding({
        document_id: targetDocId,
        code_id: codeId,
        start,
        end,
        resolution,
      })
    }
    setEditing(null)
    setSelection(null)
    setConflict(null)
    await refresh()
  }

  async function handleSubmit({ codeId, newCodeName, start, end, editing: editTarget }) {
    // 捕获提交时的目标文档与正文快照：预览 / 冲突确认 / 提交全程以它为准
    const targetDocId = docId
    if (targetDocId == null) return
    // 编辑目标必须属于当前文档的标注集合，防止跨文档错位提交
    if (editTarget && !(docData?.codings ?? []).some((c) => c.id === editTarget.id)) {
      setEditing(null)
      showError(new Error('编辑目标已不属于当前文档，请重新选择'))
      return
    }
    const contentSnapshot = docData?.document?.content ?? null
    try {
      let finalCodeId = codeId
      if (newCodeName) {
        const created = await api.createCode(newCodeName)
        finalCodeId = created.id
      }
      const payload = { docId: targetDocId, codeId: finalCodeId, start, end, editing: editTarget }
      const preview = await api.previewCoding({
        document_id: targetDocId,
        code_id: finalCodeId,
        start,
        end,
        exclude_id: editTarget ? editTarget.id : null,
      })
      // 预览在途期间发生文档切换：预览失效，不弹冲突框也不静默提交
      if (currentDocRef.current !== targetDocId) return
      if (preview.has_conflicts) {
        setConflict({ docId: targetDocId, preview, payload, content: contentSnapshot })
      } else {
        await doSubmit(payload, 'keep')
      }
    } catch (e) {
      showError(e)
    }
  }

  async function handleResolve(resolution) {
    // 冲突确认若已跨过文档切换（切换时 conflict 已清空）不会触发；
    // 这里再校验一次，确认目标仍是预览时的文档
    if (!conflict || conflict.docId !== currentDocRef.current) {
      setConflict(null)
      return
    }
    try {
      await doSubmit(conflict.payload, resolution)
    } catch (e) {
      showError(e)
      setConflict(null)
    }
  }

  // ---------- 侧栏操作 ----------

  async function handleDeleteCoding(cg) {
    if (!window.confirm(`删除编码标注 #${cg.id}（${cg.code_name}）？`)) return
    try {
      await api.deleteCoding(cg.id)
      await refresh()
    } catch (e) {
      showError(e)
    }
  }

  async function handleRenameCode(code) {
    const name = window.prompt('新的编码名：', code.name)
    if (!name || name.trim() === code.name) return
    try {
      await api.updateCode(code.id, { name: name.trim() })
      await refresh()
    } catch (e) {
      showError(e)
    }
  }

  async function handleDeleteCode(code) {
    if (!window.confirm(`删除编码「${code.name}」及其全部标注？`)) return
    try {
      await api.deleteCode(code.id)
      await refresh()
    } catch (e) {
      showError(e)
    }
  }

  function scrollToRange(range) {
    const spans = document.querySelectorAll('.text-view [data-s]')
    for (const span of spans) {
      const s = Number(span.dataset.s)
      const e = Number(span.dataset.e)
      if (s < range.end && e > range.start) {
        span.scrollIntoView({ behavior: 'smooth', block: 'center' })
        break
      }
    }
  }

  function handleLocate(cg) {
    const range = { start: cg.start, end: cg.end }
    setFlashRange(range)
    scrollToRange(range)
    setTimeout(() => setFlashRange(null), 1800)
  }

  // 共现矩阵 / 说话人分析片段 → 切回正文并定位高亮
  function handleLocateSegment(seg) {
    setView('text')
    setPendingLocate({ docId, start: seg.start, end: seg.end })
  }

  // ---------- 标注抽样复核 ----------

  // 复核写操作的目标文档在点击时确定；响应到达时若已切走，只完成写入，
  // 不把旧文档的批次数据展示到新文档上
  async function handleCreateReview(codeSettings) {
    const targetDocId = docId
    try {
      const data = await api.createReview(targetDocId, codeSettings)
      if (currentDocRef.current === targetDocId) {
        setReviewData(data)
        setReviewError(null)
      }
    } catch (e) {
      showError(e)
      throw e
    }
  }

  async function handleRegenerateReview() {
    const batch = reviewData?.batch
    if (!batch) return
    if (batch.counts.total > 0) {
      const ok = window.confirm(
        '重新生成抽样将按当前文档与标注抽取新的复核队列，并清空已有的通过 / 需修订结论，是否继续？'
      )
      if (!ok) return
    }
    const targetDocId = docId
    try {
      const data = await api.createReview(targetDocId, batch.codes.map((s) => ({
        code_id: s.code_id,
        sample_size: s.sample_size,
      })))
      if (currentDocRef.current === targetDocId) {
        setReviewData(data)
        setReviewError(null)
      }
    } catch (e) {
      showError(e)
    }
  }

  async function handleDeleteReview() {
    const targetDocId = docId
    try {
      await api.deleteReview(targetDocId)
      if (currentDocRef.current === targetDocId) setReviewData({ batch: null })
    } catch (e) {
      showError(e)
    }
  }

  async function handlePatchReview(itemId, status, note) {
    const targetDocId = docId
    try {
      const data = await api.updateReviewItem(targetDocId, itemId, status, note)
      if (currentDocRef.current === targetDocId) {
        setReviewData(data)
        setReviewError(null)
      }
    } catch (e) {
      showError(e)
      throw e
    }
  }

  // 复核队列「定位正文」：切回正文并闪烁定位
  function handleLocateReviewItem(item) {
    setView('text')
    setPendingLocate({ docId, start: item.start, end: item.end })
  }

  // ---------- 分析备忘录 ----------

  async function handleCreateMemo(payload) {
    const created = await api.createMemo(docId, payload)
    await loadMemos()
    return created
  }

  async function handleUpdateMemo(memoId, patch) {
    await api.updateMemo(docId, memoId, patch)
    await loadMemos()
  }

  async function handleDeleteMemo(memoId) {
    await api.deleteMemo(docId, memoId)
    await loadMemos()
  }

  async function handleAddMemoEvidence(memoId, codingIds) {
    await api.addMemoEvidence(docId, memoId, codingIds)
    await loadMemos()
  }

  async function handleRemoveMemoEvidence(memoId, evidenceId) {
    await api.removeMemoEvidence(docId, memoId, evidenceId)
    await loadMemos()
  }

  // 证据「定位正文」：切回正文，闪烁关联时快照区间（已变化证据按当前区间定位）
  function handleLocateMemoEvidence(ev) {
    const range =
      ev.state === 'changed' && ev.current
        ? { start: ev.current.start, end: ev.current.end }
        : { start: ev.start, end: ev.end }
    setView('text')
    setPendingLocate({ docId, ...range })
  }

  // 分布对比单元格 → 切到目标文档正文并定位首个对应片段
  function handleLocateCell(documentId, seg) {
    setDocId(documentId)
    setView('text')
    setPendingLocate({ docId: documentId, start: seg.start, end: seg.end })
  }

  // 覆盖缺口：上一处/下一处导航，循环移动并切回正文闪烁定位
  function handleGapNavigate(dir) {
    if (visibleGaps.length === 0) return
    const next =
      gapCursor < 0
        ? dir > 0
          ? 0
          : visibleGaps.length - 1
        : (gapCursor + dir + visibleGaps.length) % visibleGaps.length
    setGapCursor(next)
    handleLocateSegment(visibleGaps[next])
  }

  // 覆盖缺口：点击某条缺口 → 记住位置并切回正文定位
  function handleGapLocate(gap, index) {
    setGapCursor(index)
    handleLocateSegment(gap)
  }

  // 覆盖缺口：把整段缺口区间带入编码表单（复用拖选填表，提交仍走冲突预览）
  function handleGapToForm(gap) {
    setEditing(null)
    setSelection({ start: gap.start, end: gap.end })
    setView('text')
    setPendingLocate({ docId, start: gap.start, end: gap.end })
  }

  // 正文渲染完成后处理来自统计视图的待定位片段
  useEffect(() => {
    if (view !== 'text' || !pendingLocate) return
    // 跨文档定位需等目标文档加载完成，避免滚动到旧文档的同名区间
    if (!docData || docData.document.id !== pendingLocate.docId) return
    const range = pendingLocate
    setFlashRange(range)
    // 等视图切换后的 DOM 渲染完成再滚动
    const t = setTimeout(() => scrollToRange(range), 60)
    const clear = setTimeout(() => {
      setFlashRange(null)
      setPendingLocate(null)
    }, 2200)
    return () => {
      clearTimeout(t)
      clearTimeout(clear)
    }
  }, [view, pendingLocate, docData])

  function toggleFilter(id) {
    setFilters((cur) => {
      const next = new Set(cur === null ? codebook.map((c) => c.id) : cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next.size === codebook.length ? null : next
    })
  }

  // ---------- 文档 ----------

  async function handleCreateDocument(ev) {
    ev.preventDefault()
    if (!newDoc.title.trim() || !newDoc.content.trim()) return
    try {
      const created = await api.createDocument(newDoc.title.trim(), newDoc.content)
      const list = await api.listDocuments()
      setDocs(list)
      setDocId(created.id)
      setShowNewDoc(false)
      setNewDoc({ title: '', content: '' })
    } catch (e) {
      showError(e)
    }
  }

  // ---------- 派生数据 ----------

  const visibleCodings = useMemo(() => {
    if (!docData) return []
    if (filters === null) return docData.codings
    return docData.codings.filter((c) => filters.has(c.code_id))
  }, [docData, filters])

  // 每种编码在当前文档的标注数（抽样设置表单使用，不受编码筛选影响）
  const codingCounts = useMemo(() => {
    const map = {}
    for (const c of docData?.codings ?? []) {
      map[c.code_id] = (map[c.code_id] ?? 0) + 1
    }
    return map
  }, [docData])

  const sidebarCodings = useMemo(() => {
    if (!docData) return []
    const content = docData.document.content
    // 区间为码位下标：按码位切片，保证含 emoji 时侧栏摘录与后端一致
    return visibleCodings.map((c) => ({
      ...c,
      text: codePointSlice(content, c.start, c.end),
    }))
  }, [docData, visibleCodings])

  if (!docData) {
    // 初始加载与文档切换加载期间：不渲染任何旧文档的正文 / 侧栏 / 表单
    return (
      <div className="loading">
        <p>{error ?? '加载中…'}</p>
        {error && (
          <button className="primary-btn" onClick={loadDocument}>
            重试
          </button>
        )}
      </div>
    )
  }

  const { document: doc, codings } = docData

  return (
    <div className="app">
      <header className="topbar">
        <h1>访谈转录质性分析工作台</h1>
        <div className="doc-switcher">
          <select value={docId ?? ''} onChange={(e) => setDocId(Number(e.target.value))}>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}（{d.coding_count} 条标注）
              </option>
            ))}
          </select>
          <button onClick={() => setShowNewDoc((v) => !v)}>
            {showNewDoc ? '收起' : '＋ 新建文档'}
          </button>
          <a className="btn" href={api.exportUrl(docId)} download>
            导出 JSON
          </a>
          <button onClick={() => setShowImport(true)}>导入标注包</button>
          <button onClick={() => setShowMigration(true)}>文档版本迁移</button>
        </div>
      </header>

      {showNewDoc && (
        <form className="new-doc" onSubmit={handleCreateDocument}>
          <input
            placeholder="文档标题，如：访谈记录 A-02"
            value={newDoc.title}
            onChange={(e) => setNewDoc({ ...newDoc, title: e.target.value })}
          />
          <textarea
            placeholder="粘贴访谈转录全文…"
            rows={5}
            value={newDoc.content}
            onChange={(e) => setNewDoc({ ...newDoc, content: e.target.value })}
          />
          <button type="submit" className="primary-btn">
            创建文档
          </button>
        </form>
      )}

      {error && <div className="error-banner">{error}</div>}

      <main className="layout">
        <section className="text-panel">
          <div className="doc-meta">
            <strong>{doc.title}</strong>
            <span>
              全文 {codePointLength(doc.content)} 字 · {codings.length} 条编码标注
              {filters !== null && `（筛选后 ${visibleCodings.length} 条）`}
            </span>
          </div>
          <div className="view-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={view === 'text'}
              className={view === 'text' ? 'active' : ''}
              onClick={() => setView('text')}
            >
              正文标注
            </button>
            <button
              role="tab"
              aria-selected={view === 'cooccurrence'}
              className={view === 'cooccurrence' ? 'active' : ''}
              onClick={() => setView('cooccurrence')}
            >
              编码共现
            </button>
            <button
              role="tab"
              aria-selected={view === 'speakers'}
              className={view === 'speakers' ? 'active' : ''}
              onClick={() => setView('speakers')}
            >
              说话人分析
            </button>
            <button
              role="tab"
              aria-selected={view === 'distribution'}
              className={view === 'distribution' ? 'active' : ''}
              onClick={() => setView('distribution')}
            >
              分布对比
            </button>
            <button
              role="tab"
              aria-selected={view === 'gaps'}
              className={view === 'gaps' ? 'active' : ''}
              onClick={() => setView('gaps')}
            >
              覆盖缺口
            </button>
            <button
              role="tab"
              aria-selected={view === 'transitions'}
              className={view === 'transitions' ? 'active' : ''}
              onClick={() => setView('transitions')}
            >
              编码流转
            </button>
            <button
              role="tab"
              aria-selected={view === 'review'}
              className={view === 'review' ? 'active' : ''}
              onClick={() => setView('review')}
            >
              标注复核
            </button>
            <button
              role="tab"
              aria-selected={view === 'memo'}
              className={view === 'memo' ? 'active' : ''}
              onClick={() => setView('memo')}
            >
              分析备忘录
            </button>
          </div>
          {view === 'text' ? (
            <TextView
              content={doc.content}
              codings={visibleCodings}
              selection={selection}
              flashRange={flashRange}
              onSelect={(range) => {
                setSelection(range)
                if (editing) setEditing(null)
              }}
            />
          ) : view === 'cooccurrence' ? (
            <CooccurrenceView
              stats={coocStats}
              loading={coocLoading}
              error={coocError}
              onLocateSegment={handleLocateSegment}
            />
          ) : view === 'speakers' ? (
            <SpeakerView
              stats={speakerStats}
              loading={speakerLoading}
              error={speakerError}
              onLocateSegment={handleLocateSegment}
            />
          ) : view === 'gaps' ? (
            <GapView
              stats={gapStats}
              loading={gapLoading}
              error={gapError}
              gaps={visibleGaps}
              minLen={gapMinLen}
              onMinLenChange={setGapMinLen}
              cursor={gapCursor}
              onNavigate={handleGapNavigate}
              onLocate={handleGapLocate}
              onBringToForm={handleGapToForm}
            />
          ) : view === 'transitions' ? (
            <TransitionView
              stats={transStats}
              loading={transLoading}
              error={transError}
              onLocateInstance={handleLocateSegment}
            />
          ) : view === 'review' ? (
            <ReviewView
              key={`review-${docId}`}
              batch={reviewData?.batch ?? null}
              loading={reviewLoading}
              error={reviewError}
              codes={codebook}
              codingCounts={codingCounts}
              onCreate={handleCreateReview}
              onRegenerate={handleRegenerateReview}
              onDelete={handleDeleteReview}
              onPatch={handlePatchReview}
              onLocate={handleLocateReviewItem}
            />
          ) : view === 'memo' ? (
            <MemoView
              key={`memo-${docId}`}
              docId={docId}
              memos={memoData}
              loading={memoLoading}
              error={memoError}
              codings={codings}
              onCreate={handleCreateMemo}
              onUpdate={handleUpdateMemo}
              onDelete={handleDeleteMemo}
              onAddEvidence={handleAddMemoEvidence}
              onRemoveEvidence={handleRemoveMemoEvidence}
              onLocate={handleLocateMemoEvidence}
            />
          ) : (
            <DistributionView
              stats={distStats}
              loading={distLoading}
              error={distError}
              onLocateCell={handleLocateCell}
            />
          )}
        </section>

        <div className="right-panel">
          <CodingForm
            codes={codebook}
            content={doc.content}
            selection={selection}
            editing={editing}
            onSubmit={handleSubmit}
            onCancelEdit={() => setEditing(null)}
          />
          <SearchBatchPanel
            docId={docId}
            codes={codebook}
            onApplied={refresh}
            onError={showError}
          />
          <Sidebar
            codes={codebook}
            codings={sidebarCodings}
            filters={filters}
            onToggleFilter={toggleFilter}
            onClearFilters={() => setFilters(null)}
            onRenameCode={handleRenameCode}
            onDeleteCode={handleDeleteCode}
            onLocateCoding={handleLocate}
            onEditCoding={(cg) => {
              setEditing(cg)
              setSelection(null)
            }}
            onDeleteCoding={handleDeleteCoding}
          />
        </div>
      </main>

      {conflict && (
        <ConflictDialog
          preview={conflict.preview}
          content={conflict.content ?? doc.content}
          onResolve={handleResolve}
          onCancel={() => setConflict(null)}
        />
      )}

      {showImport && (
        <ImportDialog
          key={docId}
          docId={docId}
          onClose={() => setShowImport(false)}
          onImported={refresh}
          onLocate={handleLocateSegment}
        />
      )}

      {showMigration && (
        <MigrationDialog
          key={`mig-${docId}`}
          docId={docId}
          oldContent={doc.content}
          onClose={() => setShowMigration(false)}
          onMigrated={refreshAfterMigration}
        />
      )}
    </div>
  )
}
