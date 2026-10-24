/**
 * 知枢 KnowHub Web 前端（M1）。
 *
 * 形态依据 DSH 官方 slots 文档与生产插件 dsh-knowledge/lib/client.js：
 *   - bundle 由 window.__ModuleLoader__.load({ id, factory }) 包裹（构建脚本注入外壳）
 *   - 导出 inject: string[] 与 apply(ctx)，通过 slots.inject(key, () => slots.register(...)) 挂载
 *   - 槽位：sidebar.panellist（左侧入口）、main keyed 面板（整页知识中心）
 *   - 全部数据来自宿主 /knowhub/api/*，界面无任何硬编码业务数据
 */
import * as React from 'react'

const R: any = React
const h: any = (...args: any[]) => R.createElement(...args)


const KINDS: Array<{ value: string; label: string }> = [
  { value: 'wiki', label: '项目 Wiki' },
  { value: 'memory', label: '长期记忆' },
  { value: 'decision', label: '技术决策' },
  { value: 'convention', label: '开发规范' },
  { value: 'issue', label: '已知问题' },
  { value: 'todo', label: '待办事项' },
  { value: 'preference', label: '用户偏好' },
]
const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((item) => [item.value, item.label]))

const STRATEGIES: Array<{ value: string; label: string; desc: string }> = [
  { value: 'economy', label: '经济模式', desc: '优先增量扫描、复用缓存，只在必要时调用模型；适合预算敏感、更新频繁的仓库。' },
  { value: 'balanced', label: '均衡模式', desc: '关键模块做必要深入分析，普通文件增量处理；默认推荐。' },
  { value: 'quality', label: '高质量模式', desc: '复杂架构与关键变更做更充分分析，必要时进行结构一致性复核。' },
]

const STATUS_LABEL: Record<string, string> = {
  created: '已创建', indexing: '初始化中', ready: '可用', error: '出错', disabled: '已停用',
}
const DOC_STATUS_LABEL: Record<string, string> = {
  draft: '待审核', approved: '已批准', stale: '已过时', archived: '已归档',
}
const VERIFY_LABEL: Record<string, string> = {
  observed: '已观察', inferred: '模型推断', assumed: '假设', unverified: '未验证',
}
const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}
const TASK_KIND_LABEL: Record<string, string> = {
  initialize: '项目初始化', incremental: '增量更新',
}
const CHANGE_LABEL: Record<string, string> = {
  added: '新增', modified: '修改', deleted: '删除',
}

const styles: Record<string, any> = {
  // ---- DSH 页面骨架（对齐 dsh-client-ui-schedule 的 TaskManagerPage）----
  page: {
    width: '100%', minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
    color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
    fontSize: '14px', lineHeight: 1.6, overflow: 'hidden',
  },
  pageScroll: { flex: 1, minHeight: 0, overflow: 'auto' },
  pageContent: { maxWidth: '960px', margin: '0 auto', padding: '0 clamp(24px,4vw,48px) 48px' },
  pageHeading: {
    display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center',
    gap: '16px', paddingTop: '28px', marginBottom: '8px',
  },
  headingTitle: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
  headingSubtitle: { marginTop: '4px', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
  headingActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  filterTabs: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', margin: '8px 0 18px' },
  filterTab: {
    height: '28px', padding: '0 10px', borderRadius: '14px', border: 0, background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '14px', lineHeight: '22px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  filterTabActive: {
    height: '28px', padding: '0 10px', borderRadius: '14px', border: 0,
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)',
    fontSize: '14px', lineHeight: '22px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  // ---- 通用控件 ----
  button: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '28px', padding: '0 12px',
    borderRadius: '14px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px', cursor: 'pointer',
  },
  primary: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '28px', padding: '0 14px',
    borderRadius: '14px', border: '1px solid var(--dsw-alias-state-business-primary)',
    background: 'var(--dsw-alias-state-business-primary)', color: '#ffffff', fontSize: '13px',
    lineHeight: '20px', cursor: 'pointer',
  },
  danger: {
    display: 'inline-flex', alignItems: 'center', height: '26px', padding: '0 10px', borderRadius: '13px',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)',
    background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', cursor: 'pointer',
  },
  buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  toolbar: { display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center', marginBottom: '16px' },
  status: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
  error: {
    margin: '0 0 14px', padding: '10px 12px', borderRadius: '10px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '19px',
  },
  success: {
    margin: '0 0 14px', padding: '10px 12px', borderRadius: '10px',
    background: 'var(--dsw-specific-sidebar-fill)', border: '1px solid var(--dsw-alias-border-l3)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '19px',
  },
  body: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  card: {
    border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '12px', padding: '14px 16px',
    marginBottom: '12px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  cardTitle: { fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  meta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '6px', display: 'flex', gap: '14px', flexWrap: 'wrap' },
  badge: {
    fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)',
  },
  badgeBlue: {
    fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)',
    color: 'var(--dsw-alias-state-business-primary)',
  },
  badgeGreen: {
    fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  badgeAmber: {
    fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)',
    color: 'var(--dsw-alias-state-warn-label)',
  },
  field: { marginBottom: '14px' },
  label: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px', display: 'block' },
  labelRequired: { color: 'var(--dsw-alias-state-error-primary)', marginLeft: '3px' },
  input: {
    width: '100%', boxSizing: 'border-box', height: '32px', padding: '0 10px', borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px', outline: 'none',
  },
  textarea: {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', minHeight: '90px',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical', outline: 'none',
  },
  row: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  radioRow: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' },
  radio: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' },
  hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '6px', lineHeight: '18px' },
  counter: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)', textAlign: 'right', marginTop: '3px' },
  empty: { padding: '40px 20px', textAlign: 'center', fontSize: '14px', color: 'var(--dsw-alias-label-tertiary)' },
  pre: {
    margin: 0, padding: '12px', borderRadius: '10px', background: 'var(--dsw-alias-markdown-code-block)',
    border: '1px solid var(--dsw-alias-border-l1)', fontSize: '12px', lineHeight: '18px',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowX: 'auto',
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  },
  snippet: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '8px', lineHeight: '19px', whiteSpace: 'pre-wrap' },
  diffBox: {
    marginTop: '8px', padding: '10px', borderRadius: '8px', background: 'var(--dsw-alias-markdown-code-block)',
    border: '1px solid var(--dsw-alias-border-l1)', fontSize: '12px', lineHeight: '18px',
    maxHeight: '280px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  },
  diffAdd: { color: 'var(--dsw-alias-state-success-primary)' },
  diffDel: { color: 'var(--dsw-alias-state-error-primary)' },
  diffEqual: { color: 'var(--dsw-alias-label-tertiary)' },
  path: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)', marginTop: '6px', wordBreak: 'break-all' },
  sectionTitle: { fontSize: '14px', fontWeight: 600, margin: '20px 0 10px' },
  divider: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '16px 0' },
  progressTrack: { height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-border-l2)', overflow: 'hidden', marginTop: '8px' },
  progressBar: { height: '100%', background: 'var(--dsw-alias-state-business-primary)', transition: 'width 0.3s ease' },
  logs: {
    margin: '8px 0 0', padding: '10px', borderRadius: '8px', background: 'var(--dsw-alias-markdown-code-block)',
    border: '1px solid var(--dsw-alias-border-l1)', fontSize: '11px', lineHeight: '17px',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '150px', overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  },
}


Object.assign(styles, {
  shell: {
    display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, minWidth: 0,
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', overflow: 'hidden',
  },
  headerBar: {
    display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 24px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap',
  },
  headerTitle: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: '26px', whiteSpace: 'nowrap' },
  headerTabs: { display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '8px', flexWrap: 'wrap' },
  headerTab: {
    height: '28px', padding: '0 12px', borderRadius: '14px', border: '1px solid transparent',
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: '20px',
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  headerTabActive: {
    height: '28px', padding: '0 12px', borderRadius: '14px', border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px', lineHeight: '20px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  headerActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  linkButton: {
    height: '28px', padding: '0 10px', borderRadius: '14px', border: '1px solid transparent',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px',
    display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
  },
  countBadge: {
    minWidth: '18px', height: '18px', padding: '0 5px', borderRadius: '9px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent)',
    color: 'var(--dsw-alias-state-warn-label)', fontSize: '11px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  subBar: {
    display: 'flex', alignItems: 'center', gap: '14px', padding: '8px 24px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap',
    fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)',
  },
  split: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex' },
  listCol: {
    flex: '0 0 320px', width: '320px', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
    borderRight: '1px solid var(--dsw-alias-border-l1)',
  },
  listHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px 8px' },
  listScroll: { flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 16px' },
  treeGroup: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 8px 4px',
    fontSize: '11px', color: 'var(--dsw-alias-label-caption)',
  },
  treeRow: {
    display: 'flex', alignItems: 'center', gap: '8px', width: '100%', boxSizing: 'border-box',
    padding: '7px 8px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px', cursor: 'pointer', textAlign: 'left',
  },
  treeRowActive: {
    display: 'flex', alignItems: 'center', gap: '8px', width: '100%', boxSizing: 'border-box',
    padding: '7px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px', lineHeight: '20px', cursor: 'pointer', textAlign: 'left',
  },
  treeTitle: { flex: 1, minWidth: 0, overflow: 'hidden' },
  treeName: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  treeMeta: {
    display: 'block', fontSize: '11px', color: 'var(--dsw-alias-label-caption)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  readerCol: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
  readerHead: {
    display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 24px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  readerTitle: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: '26px', wordBreak: 'break-word' },
  readerMeta: {
    display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
    fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '5px',
  },
  readerScroll: { flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 24px 40px' },
  readerInner: { maxWidth: '860px' },
  docBody: {
    fontSize: '14px', lineHeight: '24px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    color: 'var(--dsw-alias-label-primary)',
  },
  chipRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: '0 12px 8px' },
  chip: {
    height: '24px', padding: '0 10px', borderRadius: '12px', border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px',
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  chipActive: {
    height: '24px', padding: '0 10px', borderRadius: '12px',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)',
    color: 'var(--dsw-alias-state-business-primary)', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  iconBtn: {
    width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: '8px', border: '1px solid transparent', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '14px',
  },
  listEmpty: { padding: '18px 14px', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '20px' },
  backBar: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 24px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  overlayScroll: { flex: 1, minHeight: 0, overflow: 'auto', padding: '18px clamp(16px,3vw,40px) 48px' },
  overlayInner: { maxWidth: '960px', margin: '0 auto' },
  modalBackdrop: {
    position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px', background: 'rgba(0,0,0,0.42)',
  },
  modalCard: {
    width: 'min(640px, calc(100vw - 48px))', maxHeight: '84vh', overflow: 'hidden',
    display: 'flex', flexDirection: 'column', minHeight: 0,
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '12px', boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
  },
})

Object.assign(styles, {
  mdBody: { fontSize: '14px', lineHeight: '24px', color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' },
  mdP: { margin: '0 0 12px' },
  mdH1: { margin: '20px 0 12px', fontSize: '21px', fontWeight: 600, lineHeight: '29px' },
  mdH2: { margin: '18px 0 10px', fontSize: '17px', fontWeight: 600, lineHeight: '25px' },
  mdH3: { margin: '16px 0 8px', fontSize: '15px', fontWeight: 600, lineHeight: '23px' },
  mdList: { margin: '0 0 12px', paddingLeft: '22px' },
  mdLi: { margin: '3px 0' },
  mdCodeBlock: {
    margin: '0 0 12px', padding: '12px', borderRadius: '8px', background: 'var(--dsw-alias-markdown-code-block)',
    border: '1px solid var(--dsw-alias-border-l1)', fontSize: '12px', lineHeight: '18px', overflowX: 'auto',
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  },
  mdInlineCode: {
    padding: '1px 5px', borderRadius: '4px', fontSize: '12px',
    background: 'var(--dsw-alias-markdown-code-block)', border: '1px solid var(--dsw-alias-border-l1)',
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  },
  mdQuote: { margin: '0 0 12px', padding: '2px 12px', borderLeft: '3px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)' },
  mdLink: { color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'none' },
  mdDel: { opacity: 0.7 },
  mdHr: { border: 0, borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '18px 0' },
  mdTableWrap: { margin: '0 0 12px', overflowX: 'auto' },
  mdTable: { borderCollapse: 'collapse', width: '100%', fontSize: '13px', lineHeight: '20px' },
  mdTh: { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-sidebar-fill)', fontWeight: 600, whiteSpace: 'nowrap' },
  mdTd: { padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' },
  dialog: { display: 'flex', flexDirection: 'column', maxHeight: '82vh', minHeight: 0 },
  dialogHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', padding: '18px 20px 12px' },
  dialogTitle: { fontSize: '16px', fontWeight: 600, lineHeight: '24px' },
  dialogSub: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  dialogClose: {
    width: '26px', height: '26px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: '8px', border: '1px solid transparent', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', cursor: 'pointer',
  },
  dialogBody: { padding: '0 20px 4px', overflow: 'auto', minHeight: 0 },
  dialogFoot: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
    padding: '12px 20px 16px', borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-specific-sidebar-fill)',
    borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px',
  },
  dialogFootHint: { flex: 1, minWidth: 0, fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
  dialogLabel: { display: 'block', marginBottom: '6px', fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
  dialogInput: {
    width: '100%', boxSizing: 'border-box', height: '34px', padding: '0 10px', borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px', outline: 'none',
  },
  dialogCounter: { marginTop: '4px', textAlign: 'right', fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
  choiceRow: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  choiceColumn: { display: 'flex', flexDirection: 'column', gap: '8px' },
  choice: {
    flex: '1 1 220px', display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0,
    padding: '10px 12px', borderRadius: '10px', cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
  },
  choiceActive: {
    flex: '1 1 220px', display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0,
    padding: '10px 12px', borderRadius: '10px', cursor: 'pointer',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent)',
  },
  choiceTitle: { fontSize: '13px', fontWeight: 600, lineHeight: '19px' },
  choiceDesc: { marginTop: '2px', fontSize: '11px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' },
  segGroup: { display: 'inline-flex', alignItems: 'center', padding: '2px', gap: '2px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)' },
  seg: { height: '24px', padding: '0 10px', borderRadius: '6px', border: '0', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', cursor: 'pointer' },
  segActive: { height: '24px', padding: '0 10px', borderRadius: '6px', border: '0', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', cursor: 'pointer' },
})
const STYLE_ELEMENT_ID = 'knowhub-theme-styles'
const THEME_STYLESHEET = [
  '.knowhub-page :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
  '.knowhub-page input:focus,.knowhub-page textarea:focus,.knowhub-page select:focus{border-color:var(--dsw-alias-state-business-primary)!important;outline:none}',
  '.knowhub-page .kh-hover:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)!important}',
  '.knowhub-page .kh-primary:hover:not(:disabled){filter:brightness(1.06)}',
  '.knowhub-page .kh-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)!important}',
  '.knowhub-page .kh-scroll{scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}',
  '.knowhub-page input[type=checkbox],.knowhub-page input[type=radio]{accent-color:var(--dsw-alias-state-business-primary)}',
  '@media (prefers-reduced-motion: reduce){.knowhub-page *{transition:none!important}}',
].join('\n')

/** 注入一次主题样式表；卸载时移除。 */
function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(STYLE_ELEMENT_ID)) return () => {}
  const tag = document.createElement('style')
  tag.id = STYLE_ELEMENT_ID
  tag.textContent = THEME_STYLESHEET
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

async function request(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const init: any = { method: options.method ?? 'GET', headers: { accept: 'application/json' } }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch('/knowhub/api' + path, init)
  let payload: any = null
  try {
    payload = await response.json()
  } catch {
    throw new Error('HTTP ' + response.status + '：响应不是合法 JSON')
  }
  if (!payload || payload.ok !== true) {
    throw new Error(payload?.error?.message ?? ('HTTP ' + response.status))
  }
  return payload.value
}

/** 触发一次文件下载（导出 Markdown 等），由宿主设置 content-disposition。 */
function downloadFile(path: string): void {
  const doc: any = (globalThis as any).document
  if (!doc) return
  const anchor = doc.createElement('a')
  anchor.href = '/knowhub/api' + path
  anchor.rel = 'noopener'
  doc.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function message(error: any): string {
  return String(error?.message ?? error ?? '未知错误')
}

function Badge(props: any): any {
  return h('span', { style: props.style ?? styles.badge }, props.text)
}

// ---------- 知识库 ----------

function CreateKbForm(props: any): any {
  const { models, workspaces, currentWorkspaceId, onCancel, onCreated } = props
  const [name, setName] = R.useState('')
  const [scope, setScope] = R.useState('workspace')
  const [workspaceId, setWorkspaceId] = R.useState(currentWorkspaceId ?? '')
  const [modelKey, setModelKey] = R.useState(models && models.length > 0 ? models[0].provider + '|' + models[0].id : '')
  const [strategy, setStrategy] = R.useState('balanced')
  const [errors, setErrors] = R.useState([] as string[])
  const [submitting, setSubmitting] = R.useState(false)
  const [serverError, setServerError] = R.useState(null)
  const [touched, setTouched] = R.useState(false)

  const nameLength = [...name].length
  const validate = (): string[] => {
    const list: string[] = []
    const trimmed = name.trim()
    if (trimmed === '') list.push('名称不能为空')
    else if (nameLength > 50) list.push('名称最多 50 个字符（当前 ' + nameLength + ' 个）')
    if (scope !== 'user' && scope !== 'workspace') list.push('请选择生效范围')
    if (scope === 'workspace' && workspaceId === '') list.push('工作区级知识库必须选择工作区')
    if (modelKey === '') list.push(models && models.length === 0 ? '当前 DSH 没有已配置模型，请先在 DSH 设置中配置模型' : '请选择知识处理模型')
    if (!['economy', 'balanced', 'quality'].includes(strategy)) list.push('请选择模型使用策略')
    return list
  }

  const submit = async () => {
    setTouched(true)
    const found = validate()
    setErrors(found)
    if (found.length > 0) return
    const [provider, modelId] = modelKey.split('|')
    setSubmitting(true)
    setServerError(null)
    try {
      const value = await request('/kb', {
        method: 'POST',
        body: { name: name.trim(), scope, workspaceId: scope === 'workspace' ? workspaceId : undefined, modelProvider: provider, modelId, modelStrategy: strategy },
      })
      onCreated(value.knowledgeBase)
    } catch (error: any) {
      setServerError(message(error))
    } finally {
      setSubmitting(false)
    }
  }

  R.useEffect(() => {
    const onKeyDown = (event: any) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  const workspaceOptions = (workspaces ?? []).map((workspace: any) => h('option', { key: workspace.id, value: workspace.id }, workspace.title + '（' + workspace.path + '）'))
  const scopeChoices = [
    { value: 'user', title: '用户', desc: '跨工作区共享的通用知识，例如个人偏好与全局开发规范' },
    { value: 'workspace', title: '工作区', desc: '只绑定一个工作区，仅在该项目内可见与生效' },
  ]
  const choices = scopeChoices.map((item) => h('label', {
    key: item.value,
    style: scope === item.value ? styles.choiceActive : styles.choice,
  },
    h('input', { type: 'radio', name: 'kb-scope', checked: scope === item.value, onChange: () => setScope(item.value) }),
    h('div', { style: { minWidth: 0 } },
      h('div', { style: styles.choiceTitle }, item.title),
      h('div', { style: styles.choiceDesc }, item.desc),
    ),
  ))
  const strategyChoices = STRATEGIES.map((item) => h('label', {
    key: item.value,
    style: { ...(strategy === item.value ? styles.choiceActive : styles.choice), flex: '1 1 100%' },
  },
    h('input', { type: 'radio', name: 'kb-strategy', checked: strategy === item.value, onChange: () => setStrategy(item.value) }),
    h('div', { style: { minWidth: 0 } },
      h('div', { style: styles.choiceTitle }, item.label),
      h('div', { style: styles.choiceDesc }, item.desc),
    ),
  ))

  return h('div', { style: styles.dialog },
    h('div', { style: styles.dialogHead },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: styles.dialogTitle }, '创建知识库'),
        h('div', { style: styles.dialogSub }, '创建只保存配置并建立空知识库；不会立即扫描仓库，也不会自动调用模型。'),
      ),
      h('button', { type: 'button', style: styles.dialogClose, className: 'kh-hover', title: '关闭', onClick: onCancel }, '✕'),
    ),
    h('div', { style: styles.dialogBody },
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '名称', h('span', { style: styles.labelRequired }, '＊')),
        h('input', {
          style: styles.dialogInput, value: name, maxLength: 80, placeholder: '例如：知枢 KnowHub 项目知识库',
          onChange: (event: any) => { setName(event.target.value); if (touched) setErrors(validate()) },
        }),
        h('div', { style: styles.dialogCounter }, nameLength + ' / 50'),
      ),
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '生效范围', h('span', { style: styles.labelRequired }, '＊')),
        h('div', { style: styles.choiceRow }, choices),
      ),
      scope === 'workspace' ? h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '选择工作区', h('span', { style: styles.labelRequired }, '＊')),
        (workspaces ?? []).length === 0
          ? h('div', { style: styles.hint }, '当前 DSH 没有已注册工作区，请先在 DSH 中打开一个项目目录。')
          : h('select', { style: styles.dialogInput, value: workspaceId, onChange: (event: any) => setWorkspaceId(event.target.value) },
            h('option', { value: '' }, '请选择工作区…'), workspaceOptions),
        h('div', { style: styles.hint }, '工作区列表来自 DSH 真实注册表（ctx.workspaceRegistry），不含示例数据。'),
      ) : null,
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '知识处理模型', h('span', { style: styles.labelRequired }, '＊')),
        (models ?? []).length === 0
          ? h('div', { style: styles.hint }, '当前 DSH 没有已配置模型。请先在 DSH 设置中配置模型，知枢不会要求重新填写 API Key。')
          : h('select', { style: styles.dialogInput, value: modelKey, onChange: (event: any) => setModelKey(event.target.value) },
            h('option', { value: '' }, '请选择模型…'),
            (models ?? []).map((model: any) => h('option', { key: model.provider + '|' + model.id, value: model.provider + '|' + model.id }, model.name + '（' + model.id + '）· ' + model.provider)),
          ),
        h('div', { style: styles.hint }, '模型列表来自 DSH 当前真实配置（ctx.llm.listProviders/listModels）；只保存 provider 与 model 标识，不存密钥。'),
      ),
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '模型使用策略', h('span', { style: styles.labelRequired }, '＊')),
        h('div', { style: styles.choiceColumn }, strategyChoices),
      ),
      errors.length > 0 ? h('div', { style: { ...styles.error, margin: '4px 0 12px' } }, errors.join('\n')) : null,
      serverError !== null ? h('div', { style: { ...styles.error, margin: '4px 0 12px' } }, serverError) : null,
    ),
    h('div', { style: styles.dialogFoot },
      h('div', { style: styles.dialogFootHint }, '创建后可在库详情里点「开始初始化」，用绑定的模型分析项目并生成 Wiki 候选。'),
      h('div', { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: onCancel }, '取消'),
        h('button', { type: 'button', style: submitting ? { ...styles.primary, ...styles.buttonDisabled } : styles.primary, className: 'kh-primary', disabled: submitting, onClick: () => void submit() }, submitting ? '创建中…' : '创建知识库'),
      ),
    ),
  )
}

/**
 * 编辑已建知识库的配置：名称、绑定模型、模型使用策略。
 * 作用范围（用户级 / 工作区级）与绑定的工作区在创建后不可改，避免知识归属漂移；
 * 保存走 PATCH /kb/:id，只更新配置，不动已有知识文件与版本历史。
 */
function EditKbForm(props: any): any {
  const { kb, models, onCancel, onSaved } = props
  const initialModelKey = kb.modelProvider && kb.modelId ? kb.modelProvider + '|' + kb.modelId : ''
  const [name, setName] = R.useState(String(kb.name ?? ''))
  const [modelKey, setModelKey] = R.useState(initialModelKey)
  const [strategy, setStrategy] = R.useState(kb.modelStrategy ?? 'balanced')
  const [busy, setBusy] = R.useState(false)
  const [error, setError] = R.useState(null)
  const nameLength = [...name].length

  const submit = async () => {
    const trimmed = name.trim()
    if (trimmed === '') { setError('名称不能为空'); return }
    if (nameLength > 50) { setError('名称最多 50 个字符（当前 ' + nameLength + ' 个）'); return }
    if (modelKey === '') { setError('请选择知识处理模型'); return }
    const [provider, modelId] = modelKey.split('|')
    const body: any = { name: trimmed, modelStrategy: strategy }
    if (provider !== kb.modelProvider || modelId !== kb.modelId) { body.modelProvider = provider; body.modelId = modelId }
    setBusy(true); setError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(kb.id), { method: 'PATCH', body })
      onSaved(value.knowledgeBase)
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  R.useEffect(() => {
    const onKeyDown = (event: any) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  const strategyChoices = STRATEGIES.map((item: any) => h('label', {
    key: item.value,
    style: { ...(strategy === item.value ? styles.choiceActive : styles.choice), flex: '1 1 100%' },
  },
    h('input', { type: 'radio', name: 'edit-kb-strategy', checked: strategy === item.value, onChange: () => setStrategy(item.value) }),
    h('div', { style: { minWidth: 0 } },
      h('div', { style: styles.choiceTitle }, item.label),
      h('div', { style: styles.choiceDesc }, item.desc),
    ),
  ))

  return h('div', { style: styles.dialog },
    h('div', { style: styles.dialogHead },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: styles.dialogTitle }, '编辑知识库配置'),
        h('div', { style: styles.dialogSub }, '只改配置，不会重新扫描仓库，也不会改动已有知识与版本历史。'),
      ),
      h('button', { type: 'button', style: styles.dialogClose, className: 'kh-hover', title: '关闭', onClick: onCancel }, '✕'),
    ),
    h('div', { style: styles.dialogBody },
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '名称', h('span', { style: styles.labelRequired }, '＊')),
        h('input', {
          style: styles.dialogInput, value: name, maxLength: 80, placeholder: '例如：知枢 KnowHub 项目知识库',
          onChange: (event: any) => setName(event.target.value),
        }),
        h('div', { style: styles.dialogCounter }, nameLength + ' / 50'),
      ),
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '生效范围（创建后不可修改）'),
        h('div', { style: styles.hint }, (kb.scope === 'user' ? '用户级：跨工作区共享' : '工作区级：仅当前项目可见') + (kb.workspacePath ? '；绑定工作区：' + kb.workspacePath : '')),
      ),
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '知识处理模型', h('span', { style: styles.labelRequired }, '＊')),
        (models ?? []).length === 0
          ? h('div', { style: styles.hint }, '当前 DSH 没有已配置模型。请先在 DSH 设置中配置模型，知枢不会要求重新填写 API Key。')
          : h('select', { style: styles.dialogInput, value: modelKey, onChange: (event: any) => setModelKey(event.target.value) },
            h('option', { value: '' }, '请选择模型…'),
            (models ?? []).map((model: any) => h('option', { key: model.provider + '|' + model.id, value: model.provider + '|' + model.id }, model.name + '（' + model.id + '）· ' + model.provider)),
          ),
        h('div', { style: styles.hint }, '模型列表来自 DSH 当前真实配置（ctx.llm.listProviders/listModels）；只保存 provider 与 model 标识，不存密钥。'),
      ),
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '模型使用策略', h('span', { style: styles.labelRequired }, '＊')),
        h('div', { style: styles.choiceColumn }, strategyChoices),
      ),
      error !== null ? h('div', { style: { ...styles.error, margin: '4px 0 12px' } }, error) : null,
    ),
    h('div', { style: styles.dialogFoot },
      h('div', { style: styles.dialogFootHint }, '下一次初始化或增量更新会使用新的模型与策略；已经生成的 Wiki 不受影响。'),
      h('div', { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: onCancel }, '取消'),
        h('button', { type: 'button', style: busy ? { ...styles.primary, ...styles.buttonDisabled } : styles.primary, className: 'kh-primary', disabled: busy, onClick: () => void submit() }, busy ? '保存中…' : '保存配置'),
      ),
    ),
  )
}

function AddDocForm(props: any): any {
  const { kbId, onDone } = props
  const [title, setTitle] = R.useState('')
  const [kind, setKind] = R.useState('memory')
  const [body, setBody] = R.useState('')
  const [tags, setTags] = R.useState('')
  const [verifyState, setVerifyState] = R.useState('observed')
  const [busy, setBusy] = R.useState(false)
  const [error, setError] = R.useState(null)
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await request('/kb/' + encodeURIComponent(kbId) + '/docs', {
        method: 'POST',
        body: { title, kind, body, tags: tags.split(/[，,\s]+/).filter(Boolean), verifyState, status: 'draft' },
      })
      setTitle(''); setBody(''); setTags('')
      onDone()
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  return h('div', { style: { ...styles.card, background: 'var(--dsw-alias-bg-layer-1)' } },
    h('div', { style: styles.cardTitle }, '新增知识（进入待审核草稿）'),
    h('div', { style: styles.field }, h('label', { style: styles.label }, '标题'), h('input', { style: styles.input, value: title, onChange: (e: any) => setTitle(e.target.value) })),
    h('div', { style: styles.row },
      h('div', { style: { ...styles.field, flex: 1 } }, h('label', { style: styles.label }, '类型'),
        h('select', { style: styles.input, value: kind, onChange: (e: any) => setKind(e.target.value) }, KINDS.map((item) => h('option', { key: item.value, value: item.value }, item.label)))),
      h('div', { style: { ...styles.field, flex: 1 } }, h('label', { style: styles.label }, '验证状态'),
        h('select', { style: styles.input, value: verifyState, onChange: (e: any) => setVerifyState(e.target.value) }, Object.keys(VERIFY_LABEL).map((key) => h('option', { key, value: key }, VERIFY_LABEL[key])))),
      h('div', { style: { ...styles.field, flex: 2 } }, h('label', { style: styles.label }, '标签（逗号分隔）'), h('input', { style: styles.input, value: tags, onChange: (e: any) => setTags(e.target.value) })),
    ),
    h('div', { style: styles.field }, h('label', { style: styles.label }, '正文（Markdown）'), h('textarea', { style: styles.textarea, value: body, onChange: (e: any) => setBody(e.target.value) })),
    error !== null ? h('div', { style: { ...styles.error, margin: '0 0 10px' } }, error) : null,
    h('div', { style: styles.row },
      h('button', { type: 'button', style: busy ? { ...styles.primary, ...styles.buttonDisabled } : styles.primary, disabled: busy, onClick: () => void submit() }, busy ? '保存中…' : '保存草稿'),
      h('div', { style: { ...styles.hint, alignSelf: 'center' } }, '正文写入 Markdown 文件，元数据与索引写入 SQLite（FTS5 trigram）。'),
    ),
  )
}

/**
 * 导入 Markdown（知枢导出的 .md 文件或手写 Markdown）：
 * 粘贴内容或选择本地文件，全部以「草稿」落库，必须经过审核才会成为正式知识。
 */
function ImportMarkdownForm(props: any): any {
  const { kbId, kbName, onCancel, onDone } = props
  const [content, setContent] = R.useState('')
  const [busy, setBusy] = R.useState(false)
  const [error, setError] = R.useState(null)
  const [result, setResult] = R.useState(null)

  R.useEffect(() => {
    const onKeyDown = (event: any) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  const pickFile = (event: any) => {
    const file = event?.target?.files?.[0]
    if (!file) return
    try {
      const reader = new (globalThis as any).FileReader()
      reader.onload = () => setContent(String(reader.result ?? ''))
      reader.onerror = () => setError('读取文件失败，请改用粘贴方式')
      reader.readAsText(file)
    } catch {
      setError('当前环境不支持选择文件，请直接粘贴 Markdown 内容')
    }
  }
  const submit = async () => {
    if (content.trim() === '') { setError('请先粘贴 Markdown 内容或选择一个 .md 文件'); return }
    setBusy(true); setError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(kbId) + '/import', { method: 'POST', body: { content, actor: 'web面板' } })
      setResult(value.result ?? null)
      setContent('')
      if (onDone) onDone()
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const resultBlock = result === null ? null : h('div', { style: { ...styles.card, background: 'var(--dsw-alias-bg-layer-1)' } },
    h('div', { style: styles.cardTitle }, '导入结果',
      h(Badge, { text: '新建 ' + (result.created ?? []).length, style: styles.badgeGreen }),
      h(Badge, { text: '跳过 ' + (result.skipped ?? []).length }),
      h(Badge, { text: '失败 ' + (result.failed ?? []).length, style: (result.failed ?? []).length > 0 ? styles.badgeAmber : undefined }),
    ),
    (result.created ?? []).length > 0 ? h('div', { style: styles.hint }, '新建草稿：' + (result.created ?? []).map((item: any) => item.title).join('、')) : null,
    (result.skipped ?? []).length > 0 ? h('div', { style: styles.hint }, '跳过：' + (result.skipped ?? []).map((item: any) => item.title + '（' + item.reason + '）').join('；')) : null,
    (result.failed ?? []).length > 0 ? h('div', { style: { ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' } }, '失败：' + (result.failed ?? []).map((item: any) => item.title + '（' + item.message + '）').join('；')) : null,
    (result.warnings ?? []).length > 0 ? h('div', { style: styles.hint }, '提示：' + (result.warnings ?? []).join('；')) : null,
    result.parentLinked ? h('div', { style: styles.hint }, '已恢复 ' + result.parentLinked + ' 条父级关系') : null,
  )

  return h('div', { style: styles.dialog },
    h('div', { style: styles.dialogHead },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: styles.dialogTitle }, '导入 Markdown'),
        h('div', { style: styles.dialogSub }, '导入到「' + String(kbName ?? '') + '」；所有条目先成为草稿，人工审核后才生效。'),
      ),
      h('button', { type: 'button', style: styles.dialogClose, className: 'kh-hover', title: '关闭', onClick: onCancel }, '✕'),
    ),
    h('div', { style: styles.dialogBody },
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, '选择 .md 文件（可选）'),
        h('input', { type: 'file', accept: '.md,.markdown,text/markdown', style: { fontSize: '12px' }, onChange: pickFile }),
      ),
      h('div', { style: styles.field },
        h('label', { style: styles.dialogLabel }, 'Markdown 内容', h('span', { style: styles.labelRequired }, '＊')),
        h('textarea', {
          style: { ...styles.textarea, minHeight: '200px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          placeholder: '粘贴知枢导出的 Markdown（含 <!-- knowhub:doc --> 块），或手写 Markdown；没有块时会作为一整篇知识导入。',
          value: content,
          onChange: (event: any) => setContent(event.target.value),
        }),
        h('div', { style: styles.hint }, '单次最多 200 篇、2 MB；同名知识已存在时跳过，不覆盖。'),
      ),
      error !== null ? h('div', { style: { ...styles.error, margin: '4px 0 12px' } }, error) : null,
      resultBlock,
    ),
    h('div', { style: styles.dialogFoot },
      h('div', { style: styles.hint }, '导入完成后可在「待审核」里逐条批准，或使用批量批准。'),
      h('div', { style: { flex: 1 } }),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: onCancel }, '关闭'),
      h('button', { type: 'button', style: busy ? { ...styles.primary, ...styles.buttonDisabled } : styles.primary, className: 'kh-primary', disabled: busy, onClick: () => void submit() }, busy ? '导入中…' : '开始导入'),
    ),
  )
}

function KbView(props: any): any {
  const { models, workspaces, currentWorkspace, notify } = props
  const [list, setList] = R.useState(null)
  const [loading, setLoading] = R.useState(false)
  const [error, setError] = R.useState(null)
  const [showForm, setShowForm] = R.useState(false)
  const [kbQuery, setKbQuery] = R.useState('')
  const [listWorkspace, setListWorkspace] = R.useState('all')
  const [detail, setDetail] = R.useState(null)
  const [detailLoading, setDetailLoading] = R.useState(false)
  const [pendingDelete, setPendingDelete] = R.useState(null)
  const [deleting, setDeleting] = R.useState(false)
  const [editOpen, setEditOpen] = R.useState(false)
  const [importOpen, setImportOpen] = R.useState(false)
  const [docs, setDocs] = R.useState([])
  const [docsTotal, setDocsTotal] = R.useState(0)
  const [docsLoading, setDocsLoading] = R.useState(false)
  const [showDocForm, setShowDocForm] = R.useState(false)
  const [tasks, setTasks] = R.useState([])
  const [indexInfo, setIndexInfo] = R.useState(null)
  const [calls, setCalls] = R.useState([])
  const [initWorkspaceId, setInitWorkspaceId] = R.useState('')
  const [initBusy, setInitBusy] = R.useState(false)
  const [taskError, setTaskError] = R.useState(null)
  const [gitState, setGitState] = R.useState(null)
  const [changes, setChanges] = R.useState([])
  const [recheck, setRecheck] = R.useState([])
  const [incPlan, setIncPlan] = R.useState(null)
  const [incBusy, setIncBusy] = R.useState(false)
  const [incError, setIncError] = R.useState(null)
  const lastDoneTask = R.useRef('')

  const loadTaskData = R.useCallback(async (id: string) => {
    const [taskValue, fileValue, callValue] = await Promise.all([
      request('/kb/' + encodeURIComponent(id) + '/tasks'),
      request('/kb/' + encodeURIComponent(id) + '/files'),
      request('/kb/' + encodeURIComponent(id) + '/llm-calls?limit=20'),
    ])
    setTasks(taskValue.tasks ?? [])
    setIndexInfo(fileValue.summary ?? null)
    setCalls(callValue.calls ?? [])
    try {
      const [gitValue, changeValue] = await Promise.all([
        request('/kb/' + encodeURIComponent(id) + '/git'),
        request('/kb/' + encodeURIComponent(id) + '/changes?limit=50'),
      ])
      setGitState(gitValue ?? null)
      setChanges(changeValue.changes ?? [])
      setRecheck(changeValue.recheck ?? [])
    } catch {
      // 增量状态读取失败不影响主流程
    }
  }, [])

  // 列表范围：'all' 看全部（用户级 + 所有工作区），或指定某个工作区。
  // 不能只按 cwd 反查出的「当前工作区」过滤：知识库允许建在任意工作区，
  // 建完看不见、同名又报已存在，就是这样产生的。
  const load = R.useCallback(async (workspaceOverride?: string) => {
    setLoading(true); setError(null)
    const target = typeof workspaceOverride === 'string' ? workspaceOverride : listWorkspace
    try {
      const query = target === 'all' ? '?all=1' : '?workspaceId=' + encodeURIComponent(target)
      const value = await request('/kb' + query)
      setList(value.knowledgeBases ?? [])
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }, [listWorkspace])

  R.useEffect(() => { void load() }, [load])
  R.useEffect(() => { void load() }, [props.refreshKey])

  // 打开详情后每 1.5s 轮询任务；succeeded 时刷新文档与索引摘要（真实数据，无本地伪造）。
  R.useEffect(() => {
    if (!detail) { setTasks([]); return }
    const id = detail.knowledgeBase.id
    let alive = true
    const tick = async () => {
      try {
        const value = await request('/kb/' + encodeURIComponent(id) + '/tasks')
        if (!alive) return
        const next: any[] = value.tasks ?? []
        setTasks(next)
        const latest = next[0]
        if (latest && latest.status === 'succeeded' && lastDoneTask.current !== latest.id) {
          lastDoneTask.current = latest.id
          const docsValue = await request('/kb/' + encodeURIComponent(id) + '/docs?limit=50')
          if (alive) setDocs(docsValue.documents ?? [])
          if (alive) setDocsTotal(Number(docsValue.total ?? (docsValue.documents ?? []).length))
          const fileValue = await request('/kb/' + encodeURIComponent(id) + '/files')
          if (alive) setIndexInfo(fileValue.summary ?? null)
          if (alive) notify((latest.kind === 'incremental' ? '增量更新已完成：' : '初始化已完成：') + 'Wiki 候选以草稿形式生成，待审核后转为正式知识')
          if (alive) await loadTaskData(id)
        }
      } catch {
        // 轮询失败不打断界面，等下一个周期重试
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 1500)
    return () => { alive = false; clearInterval(timer) }
  }, [detail])

  const openDetail = async (id: string) => {
    setDetail(null); setDetailLoading(true); setError(null); setDocs([]); setEditOpen(false)
    try {
      const value = await request('/kb/' + encodeURIComponent(id))
      setDetail(value)
      const docsValue = await request('/kb/' + encodeURIComponent(id) + '/docs?limit=50')
      setDocs(docsValue.documents ?? [])
      setDocsTotal(Number(docsValue.total ?? (docsValue.documents ?? []).length))
      const kb = value.knowledgeBase
      setInitWorkspaceId(kb.workspaceId ?? (currentWorkspace?.workspaceId ?? ''))
      setTaskError(null)
      await loadTaskData(id)
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setDetailLoading(false)
    }
  }

  const loadMoreDocs = async () => {
    if (!detail) return
    setDocsLoading(true); setError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(detail.knowledgeBase.id) + '/docs?limit=50&offset=' + docs.length)
      setDocs(docs.concat(value.documents ?? []))
      setDocsTotal(Number(value.total ?? docsTotal))
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setDocsLoading(false)
    }
  }

  const exportAll = () => {
    if (!detail) return
    downloadFile('/kb/' + encodeURIComponent(detail.knowledgeBase.id) + '/export')
  }

  const remove = async (id: string, mode: string) => {
    setDeleting(true); setError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(id) + '?mode=' + mode, { method: 'DELETE' })
      setPendingDelete(null)
      setDetail(null)
      notify((value.result.rowDeleted ? '已删除知识库记录；' : '') + (value.result.filesDeleted ? '知识文件已删除；' : '') + '操作完成')
      await load()
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setDeleting(false)
    }
  }

  const startInitialize = async () => {
    if (!detail) return
    const kb = detail.knowledgeBase
    setInitBusy(true); setTaskError(null)
    try {
      if (kb.scope === 'user' && initWorkspaceId === '') throw new Error('用户级知识库需要先选择要分析的工作区')
      const value = await request('/kb/' + encodeURIComponent(kb.id) + '/initialize', {
        method: 'POST', body: kb.scope === 'user' ? { workspaceId: initWorkspaceId } : {},
      })
      notify(value.duplicate ? '已有初始化任务在执行中，可在下方查看进度' : '初始化任务已启动：扫描项目 → 建立索引 → 用绑定模型生成 Wiki 候选')
      await loadTaskData(kb.id)
      await load()
    } catch (failure: any) {
      setTaskError(message(failure))
    } finally {
      setInitBusy(false)
    }
  }

  const incrementalRequest = async (dryRun: boolean) => {
    if (!detail) return
    const kb = detail.knowledgeBase
    setIncBusy(true); setIncError(null)
    try {
      if (kb.scope === 'user' && initWorkspaceId === '') throw new Error('用户级知识库需要先选择要分析的工作区')
      const body: any = dryRun ? { dryRun: true } : {}
      if (kb.scope === 'user') body.workspaceId = initWorkspaceId
      const value = await request('/kb/' + encodeURIComponent(kb.id) + '/incremental', { method: 'POST', body })
      if (dryRun) {
        setIncPlan(value)
        notify('变更检测完成（' + (value.mode === 'git' ? 'Git 模式' : '哈希模式') + '）：' + value.changeCount + ' 个变更，' + value.affectedCount + ' 篇文档受影响')
      } else {
        setIncPlan(null)
        notify(value.duplicate ? '该知识库已有增量任务在执行中，未重复启动' : '增量更新任务已启动：只处理受影响文档，已批准内容不会被自动覆盖')
        await loadTaskData(kb.id)
        await load()
      }
    } catch (failure: any) {
      setIncError(message(failure))
    } finally {
      setIncBusy(false)
    }
  }

  const cancelTask = async (taskId: string) => {
    setTaskError(null)
    try {
      await request('/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST', body: {} })
      notify('已请求取消任务，等待执行器响应')
    } catch (failure: any) {
      setTaskError(message(failure))
    }
  }

  const retryTask = async (taskId: string) => {
    setInitBusy(true); setTaskError(null)
    try {
      await request('/tasks/' + encodeURIComponent(taskId) + '/retry', { method: 'POST', body: {} })
      notify('已提交重试任务（会记录新的尝试序号）')
      if (detail) await loadTaskData(detail.knowledgeBase.id)
    } catch (failure: any) {
      setTaskError(message(failure))
    } finally {
      setInitBusy(false)
    }
  }

  const activeTask = tasks.find((task: any) => task.status === 'queued' || task.status === 'running') ?? null
  const latestTask = tasks.length > 0 ? tasks[0] : null

  const filteredList = (list ?? []).filter((kb: any) => kbQuery.trim() === '' || String(kb.name ?? '').toLowerCase().indexOf(kbQuery.trim().toLowerCase()) >= 0)

  const detailSections = (): any => {
    if (detail === null) {
      if (detailLoading) return h('div', { style: styles.listEmpty }, '正在加载知识库详情…')
      return h('div', { style: { ...styles.listEmpty, paddingTop: '40px' } },
        h('div', { style: { fontSize: '14px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' } }, '从左侧选择一个知识库查看详情'),
        h('div', null, '首次使用：点「+ 新建」创建知识库，再在详情里点「开始初始化」生成 Repo Wiki 候选。'))
    }
    return h('div', null,
      h('div', { style: styles.divider }),
      h('div', { style: styles.sectionTitle }, '项目初始化与 Repo Wiki'),
      h('div', { style: styles.hint }, '初始化会用该知识库绑定的模型（' + detail.knowledgeBase.modelProvider + ' / ' + detail.knowledgeBase.modelId + '，策略 ' + detail.knowledgeBase.modelStrategy + '）分析仓库，生成 Wiki 候选草稿；扫描不执行仓库内脚本，自动排除 node_modules、.git、构建产物与密钥文件。'),
      detail.knowledgeBase.scope === 'user' ? h('div', { style: styles.field, marginTop: '10px' },
        h('label', { style: styles.label }, '选择要分析的工作区', h('span', { style: styles.labelRequired }, '*')),
        h('select', { style: styles.input, value: initWorkspaceId, onChange: (event: any) => setInitWorkspaceId(event.target.value) },
          h('option', { value: '' }, '请选择工作区'),
          workspaces.map((workspace: any) => h('option', { key: workspace.id, value: workspace.id }, (workspace.title ?? workspace.path) + '（' + workspace.id + '）')),
        ),
      ) : null,
      h('div', { style: { ...styles.row, marginTop: '10px' } },
        h('button', { type: 'button', style: { ...styles.primary, ...(initBusy || activeTask !== null ? styles.buttonDisabled : {}) }, disabled: initBusy || activeTask !== null, onClick: () => void startInitialize() },
          activeTask !== null ? '初始化进行中…' : initBusy ? '提交中…' : '开始初始化'),
        activeTask !== null ? h('button', { type: 'button', style: styles.danger, className: 'kh-danger', onClick: () => void cancelTask(activeTask.id) }, '取消任务') : null,
        latestTask !== null && latestTask.status === 'failed' ? h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: initBusy, onClick: () => void retryTask(latestTask.id) }, '重试失败任务') : null,
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => { if (detail) void loadTaskData(detail.knowledgeBase.id) } }, '刷新任务状态'),
      ),
      taskError !== null ? h('div', { style: { ...styles.error, margin: '10px 0 0' } }, message(taskError)) : null,
      tasks.length === 0 ? h('div', { style: styles.hint }, '尚未运行初始化。点击「开始初始化」后，会先建立项目索引，再按选择的模型生成 Wiki 候选。')
        : tasks.slice(0, 3).map((task: any) => h('div', { key: task.id, style: { ...styles.card, marginTop: '10px', background: 'var(--dsw-alias-bg-layer-1)' } },
          h('div', { style: styles.cardTitle }, (TASK_KIND_LABEL[task.kind] ?? task.kind) + '任务 #' + task.id.slice(-8),
            h(Badge, { text: TASK_STATUS_LABEL[task.status] ?? task.status, style: task.status === 'failed' ? styles.badgeAmber : styles.badgeGreen }),
            h('span', { style: styles.hint }, '尝试 ' + (task.attempt ?? 1) + ' 次 · 创建于 ' + new Date(task.createdAt).toLocaleString('zh-CN')),
          ),
          h('div', { style: styles.progressTrack }, h('div', { style: { ...styles.progressBar, width: String(Math.max(0, Math.min(100, Number(task.progress ?? 0)))) + '%', background: task.status === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-business-primary)' } })),
          h('div', { style: { ...styles.meta } },
            h('span', null, '进度：' + Number(task.progress ?? 0) + '%'),
            h('span', null, '阶段：' + (task.stage ?? '—')),
            task.errorCode ? h('span', null, '错误码：' + task.errorCode) : null,
            task.errorDetail ? h('span', null, '错误：' + task.errorDetail) : null,
          ),
          task.logs && task.logs.length > 0 ? h('pre', { style: styles.logs },
            task.logs.slice(-12).map((item: any) => '[' + new Date(item.at).toLocaleTimeString('zh-CN') + '] ' + item.level + ' ' + item.message).join('\n'),
          ) : null,
        )),
      h('div', { style: styles.sectionTitle }, '项目索引状态'),
      indexInfo === null ? h('div', { style: styles.hint }, '还没有索引数据（初始化完成后自动建立）')
        : h('div', { style: styles.meta },
          h('span', null, '文件数：' + indexInfo.fileCount),
          h('span', null, '已哈希：' + (indexInfo.hashedCount ?? 0)),
          h('span', null, '最近索引：' + (indexInfo.lastIndexedAt ? new Date(indexInfo.lastIndexedAt).toLocaleString('zh-CN') : '—')),
          indexInfo.byLanguage && indexInfo.byLanguage.length > 0 ? h('span', null, '语言：' + indexInfo.byLanguage.slice(0, 6).map((item: any) => item.language + ' ' + item.count).join('、')) : null,
        ),
      h('div', { style: styles.sectionTitle }, '模型调用记录（证明实际使用的模型）'),
      calls.length === 0 ? h('div', { style: styles.hint }, '还没有模型调用记录')
        : h('div', null, calls.slice(0, 10).map((call: any) => h('div', { key: call.id, style: { ...styles.meta, borderTop: '1px dashed var(--dsw-alias-border-l1)', paddingTop: '6px', marginTop: '0' } },
          h('span', null, (call.provider ?? '') + ' / ' + (call.model ?? '')),
          h('span', null, '用途：' + (call.purpose ?? '—')),
          h('span', null, 'tokens：' + (call.promptTokens ?? 0) + ' → ' + (call.completionTokens ?? 0)),
          h('span', null, '耗时：' + (call.latencyMs ?? 0) + 'ms'),
          call.failureCode ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '失败码：' + call.failureCode) : null,
        ))),
      h('div', { style: styles.divider }),
      h('div', { style: styles.sectionTitle }, 'Git 变更与增量更新（M4）'),
      h('div', { style: styles.hint }, '变更检测优先使用只读 Git 命令，不是 Git 仓库或无法执行 git 时自动降级为文件内容哈希比对；只有受影响文档会重新分析，已批准的知识不会被自动覆盖，而是生成「修改候选」进入待审核。'),
      h('div', { style: styles.meta },
        gitState && gitState.checkpoint ? h('span', null, '检查点模式：' + (gitState.checkpoint.mode === 'git' ? 'Git' : '哈希')) : h('span', null, '检查点：尚未运行增量更新'),
        gitState && gitState.checkpoint && gitState.checkpoint.head ? h('span', null, 'HEAD：' + String(gitState.checkpoint.head).slice(0, 10)) : null,
        gitState && gitState.git ? h('span', null, 'Git 状态：' + (gitState.git.available ? (gitState.git.isRepo ? '可用（分支 ' + (gitState.git.branch ?? '—') + '，未提交变更 ' + (gitState.git.dirtyCount ?? 0) + ' 项）' : '目录不是 Git 仓库') : '宿主无法执行 git')) : null,
        gitState && gitState.checkpoint && gitState.checkpoint.lastScanAt ? h('span', null, '最近检测：' + new Date(gitState.checkpoint.lastScanAt).toLocaleString('zh-CN')) : null,
        changes.length > 0 ? h('span', null, '最近变更：' + changes.length + ' 条') : null,
      ),
      h('div', { style: { ...styles.row, marginTop: '10px' } },
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: incBusy || activeTask !== null, onClick: () => void incrementalRequest(true) }, incBusy ? '检测中…' : '检测变更（仅预览）'),
        h('button', { type: 'button', style: { ...styles.primary, ...(incBusy || activeTask !== null ? styles.buttonDisabled : {}) }, disabled: incBusy || activeTask !== null, onClick: () => void incrementalRequest(false) },
          activeTask !== null ? '任务进行中…' : incBusy ? '提交中…' : '开始增量更新'),
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => { if (detail) void loadTaskData(detail.knowledgeBase.id) } }, '刷新增量状态'),
      ),
      incError !== null ? h('div', { style: { ...styles.error, margin: '10px 0 0' } }, message(incError)) : null,
      incPlan !== null ? h('div', { style: { ...styles.card, marginTop: '10px', background: 'var(--dsw-alias-bg-layer-1)' } },
        h('div', { style: styles.cardTitle }, '变更预览（未写入任何数据）'),
        h('div', { style: styles.meta },
          h('span', null, '模式：' + (incPlan.mode === 'git' ? 'Git' : '哈希')),
          h('span', null, '基线：' + (incPlan.baseline ? '首次/重置（只建立检查点，不调用模型）' : '已有检查点')),
          h('span', null, '变更文件：' + incPlan.changeCount),
          h('span', null, '受影响文档：' + incPlan.affectedCount),
          h('span', null, '预计模型调用：' + incPlan.plannedModelCalls),
          incPlan.plan && incPlan.plan.length > 0 ? h('span', null, '计划：' + incPlan.plan.map((item: any) => item.title + '（' + (item.action === 'stale-proposal' ? '标记过时候选' : item.action === 'update-proposal' ? '修改候选' : '草稿直更') + '）').join('；')) : null,
        ),
        incPlan.structural && incPlan.structural.length > 0 ? h('div', { style: { ...styles.hint, color: 'var(--dsw-alias-state-warn-label)' } }, '结构性变更（需要人工重新检查）：' + incPlan.structural.join('、')) : null,
        incPlan.unmatchedPaths && incPlan.unmatchedPaths.length > 0 ? h('div', { style: styles.hint }, '未关联任何文档的变更：' + incPlan.unmatchedPaths.slice(0, 8).join('、')) : null,
        incPlan.changes && incPlan.changes.length > 0 ? h('pre', { style: styles.logs }, incPlan.changes.slice(0, 12).map((item: any) => (CHANGE_LABEL[item.change] ?? item.change) + '  ' + item.path).join('\n')) : null,
        incPlan.note ? h('div', { style: styles.hint }, incPlan.note) : null,
      ) : null,
      changes.length > 0 ? h('div', { style: { marginTop: '10px' } },
        h('div', { style: styles.hint }, '已记录的变更（来自 file_changes 表）'),
        h('pre', { style: styles.logs }, changes.slice(0, 10).map((item: any) => (CHANGE_LABEL[item.change] ?? item.change) + '  ' + item.path + '  [' + item.mode + ']').join('\n')),
      ) : null,
      recheck.length > 0 ? h('div', { style: { marginTop: '10px' } },
        h('div', { style: { ...styles.hint, color: 'var(--dsw-alias-state-warn-label)' } }, '需要重新检查的文档（' + recheck.length + '）'),
        h('pre', { style: styles.logs }, recheck.slice(0, 10).map((item: any) => (item.title ?? item.docTitle ?? item.docId) + ' ← ' + item.reason).join('\n')),
      ) : null,
      h('div', { style: styles.divider }),
      h('div', { style: styles.sectionTitle }, '知识条目（Markdown + SQLite 索引；草稿需审核后生效）'),
      h('div', { style: styles.hint }, '共 ' + docsTotal + ' 条，已显示 ' + docs.length + ' 条（每页 50 条）'),
      docs.length === 0 ? h('div', { style: styles.empty }, '该知识库还没有知识条目') : docs.map((doc: any) => h('div', { key: doc.id, style: { ...styles.card, marginBottom: '8px' } },
        h('div', { style: styles.cardTitle }, doc.title,
          h(Badge, { text: KIND_LABEL[doc.kind] ?? doc.kind }),
          h(Badge, { text: DOC_STATUS_LABEL[doc.status] ?? doc.status, style: styles.badgeAmber }),
          h(Badge, { text: VERIFY_LABEL[doc.verifyState] ?? doc.verifyState }),
        ),
        h('div', { style: styles.snippet }, String(doc.body ?? '').slice(0, 180)),
        h('div', { style: styles.path }, doc.path),
      )),
      docsTotal > docs.length
        ? h('div', { style: { ...styles.row, marginBottom: '8px' } },
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: docsLoading, onClick: () => void loadMoreDocs() },
            docsLoading ? '加载中…' : '加载更多知识（还剩 ' + (docsTotal - docs.length) + ' 条）'))
        : null,
      h('div', { style: styles.divider }),
      showDocForm ? h(AddDocForm, { kbId: detail.knowledgeBase.id, onDone: async () => { setShowDocForm(false); await openDetail(detail.knowledgeBase.id); notify('知识草稿已保存'); await load() } }) : null,
      h('div', { style: styles.row },
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setShowDocForm(!showDocForm) }, showDocForm ? '收起新增表单' : '+ 新增知识'),
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setDetail(null) }, '返回列表'),
        h('button', { type: 'button', style: styles.danger, className: 'kh-danger', onClick: () => setPendingDelete({ id: detail.knowledgeBase.id, name: detail.knowledgeBase.name }) }, '删除知识库…'),
      ),
      pendingDelete !== null && pendingDelete.id === detail.knowledgeBase.id ? h('div', { style: { ...styles.card, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)' } },
        h('div', { style: styles.cardTitle }, '确认删除「' + pendingDelete.name + '」'),
        h('div', { style: styles.hint }, '删除配置：只隐藏记录并保留知识文件；删除全部：记录与知识文件一起删除。此操作不可自动撤销（文件删除后不可恢复）。'),
        h('div', { style: styles.row, marginTop: '10px' },
          h('button', { type: 'button', style: styles.danger, className: 'kh-danger', disabled: deleting, onClick: () => void remove(pendingDelete.id, 'config') }, '删除配置（保留文件）'),
          h('button', { type: 'button', style: styles.danger, className: 'kh-danger', disabled: deleting, onClick: () => void remove(pendingDelete.id, 'all') }, '删除全部数据'),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setPendingDelete(null) }, '取消'),
        ),
      ) : null,
    )
  }

  return h('div', { style: styles.split },
    h('div', { style: styles.listCol },
      h('div', { style: styles.listHead },
        h('input', {
          style: { ...styles.input, flex: 1, height: '30px' },
          placeholder: '搜索知识库名称',
          value: kbQuery,
          onChange: (event: any) => setKbQuery(event.target.value),
        }),
        h('button', {
          type: 'button', style: styles.primary, className: 'kh-primary',
          onClick: () => { setShowForm(!showForm); setDetail(null) },
        }, showForm ? '收起' : '+ 新建'),
      ),
      h('div', { style: { padding: '0 12px 8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('select', {
          style: { ...styles.input, height: '30px' },
          value: listWorkspace,
          onChange: (event: any) => { setListWorkspace(event.target.value); setDetail(null) },
        },
          h('option', { value: 'all' }, '全部工作区（用户级 + 各工作区）'),
          (workspaces ?? []).map((workspace: any) => h('option', { key: workspace.id, value: workspace.id }, (workspace.title ?? workspace.path ?? workspace.id) + (workspace.pathState === 'missing' ? '（目录不可用）' : ''))),
        ),
        h('div', { style: styles.hint }, listWorkspace === 'all'
          ? '显示用户级知识库与所有工作区的知识库。'
          : '只显示该工作区的知识库，以及用户级知识库。'),
      ),
      error !== null ? h('div', { style: { ...styles.error, margin: '0 10px 10px' } }, error) : null,
      h('div', { style: styles.listScroll, className: 'kh-scroll' },
        list === null ? (loading ? h('div', { style: styles.listEmpty }, '正在加载知识库列表…') : null)
          : filteredList.length === 0 ? h('div', { style: styles.listEmpty }, list.length === 0 ? (listWorkspace === 'all' ? '还没有任何知识库。点击「+ 新建」创建。' : '该范围还没有知识库。') : '没有匹配的知识库名称。')
          : filteredList.map((kb: any) => h('button', {
            key: kb.id, type: 'button',
            style: detail !== null && detail.knowledgeBase.id === kb.id ? styles.treeRowActive : styles.treeRow,
            onClick: () => void openDetail(kb.id),
          },
            h('span', { style: styles.treeTitle },
              h('span', { style: styles.treeName }, kb.name),
              h('span', { style: styles.treeMeta },
                (kb.scope === 'user' ? '用户级' : '工作区级 · ' + (kb.workspaceTitle ?? kb.workspaceId ?? '未知工作区')) + ' · ' + (STATUS_LABEL[kb.status] ?? kb.status) + ' · ' + (kb.documentCount ?? 0) + ' 条'),
            ),
          )),
      ),
    ),
    h('div', { style: styles.readerCol },
      h('div', { style: styles.readerHead },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h2', { style: styles.readerTitle }, detail !== null ? detail.knowledgeBase.name : '知识库'),
          detail !== null
            ? h('div', { style: styles.readerMeta },
              h(Badge, { text: detail.knowledgeBase.scope === 'user' ? '用户级' : '工作区级', style: styles.badgeBlue }),
              h(Badge, { text: STATUS_LABEL[detail.knowledgeBase.status] ?? detail.knowledgeBase.status, style: styles.badgeGreen }),
              h('span', null, '模型：' + detail.knowledgeBase.modelId + '（' + detail.knowledgeBase.modelProvider + '）'),
              h('span', null, '策略：' + detail.knowledgeBase.modelStrategy),
              h('span', null, detail.documentCount + ' 条知识'),
              detail.knowledgeBase.workspacePath ? h('span', null, '工作区：' + detail.knowledgeBase.workspacePath) : null,
            )
            : h('div', { style: styles.readerMeta }, '知识库列表与详情'),
        ),
        h('div', { style: styles.headerActions },
          detail !== null ? h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: exportAll }, '导出全部') : null,
          detail !== null ? h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setImportOpen(true) }, '导入 Markdown') : null,
          detail !== null ? h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setEditOpen(true) }, '编辑配置') : null,
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: loading, onClick: () => void load() }, loading ? '刷新中…' : '刷新'),
        ),
      ),
      h('div', { style: styles.readerScroll, className: 'kh-scroll' },
        h('div', { style: styles.readerInner },
          detailSections(),
        ),
      ),
    ),
    showForm ? h('div', { style: styles.modalBackdrop, onClick: (event: any) => { if (event.target === event.currentTarget) setShowForm(false) } },
      h('div', { style: styles.modalCard },
        h(CreateKbForm, {
          models, workspaces, currentWorkspaceId: currentWorkspace?.workspaceId ?? '',
          onCancel: () => setShowForm(false),
          onCreated: async (kb: any) => {
            setShowForm(false)
            notify('知识库「' + kb.name + '」已创建。下一步：在详情里点「开始初始化」。')
            // 新建的库可能绑在别的工作区：直接把列表切过去并打开详情，避免「建完了却看不见」。
            const target = kb.scope === 'workspace' && kb.workspaceId ? String(kb.workspaceId) : undefined
            if (target !== undefined) setListWorkspace(target)
            await load(target)
            await openDetail(kb.id)
          },
        }),
      ),
    ) : null,
    importOpen && detail !== null ? h('div', { style: styles.modalBackdrop, onClick: (event: any) => { if (event.target === event.currentTarget) setImportOpen(false) } },
      h('div', { style: { ...styles.modalCard, maxWidth: '720px' } },
        h(ImportMarkdownForm, {
          kbId: detail.knowledgeBase.id, kbName: detail.knowledgeBase.name,
          onCancel: () => setImportOpen(false),
          onDone: async () => { await openDetail(detail.knowledgeBase.id); await load() },
        }),
      ),
    ) : null,
    editOpen && detail !== null ? h('div', { style: styles.modalBackdrop, onClick: (event: any) => { if (event.target === event.currentTarget) setEditOpen(false) } },
      h('div', { style: styles.modalCard },
        h(EditKbForm, {
          kb: detail.knowledgeBase, models,
          onCancel: () => setEditOpen(false),
          onSaved: async (kb: any) => { setEditOpen(false); notify('知识库「' + kb.name + '」配置已更新'); await openDetail(kb.id); await load() },
        }),
      ),
    ) : null,
  )
}

// ---------- 检索 ----------

function SearchView(props: any): any {
  const { knowledgeBases } = props
  const [query, setQuery] = R.useState('')
  const [kbId, setKbId] = R.useState('')
  const [kind, setKind] = R.useState('')
  const [status, setStatus] = R.useState('any')
  const [sort, setSort] = R.useState('relevance')
  const [tags, setTags] = R.useState('')
  const [result, setResult] = R.useState(null)
  const [loading, setLoading] = R.useState(false)
  const [loadingMore, setLoadingMore] = R.useState(false)
  const [error, setError] = R.useState(null)
  const PAGE_SIZE = 20

  const buildParams = (offset: number) => {
    const params = new URLSearchParams()
    if (query.trim() !== '') params.set('q', query.trim())
    if (kbId !== '') params.set('kbId', kbId)
    if (kind !== '') params.set('kind', kind)
    params.set('status', status)
    params.set('sort', sort)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    for (const tag of (tags as string).split(/[,，\s]+/).map((item: string) => item.trim()).filter((item: string) => item !== '').slice(0, 6)) params.append('tag', tag)
    return params
  }

  const search = async () => {
    setLoading(true); setError(null)
    try {
      setResult(await request('/search?' + buildParams(0).toString()))
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }

  // 分页：按已显示的条数作为 offset 续拉，追加到当前结果（total 为真实命中总数）
  const loadMore = async () => {
    if (result === null) return
    setLoadingMore(true); setError(null)
    try {
      const next = await request('/search?' + buildParams(result.hits.length).toString())
      setResult({ ...next, hits: [...result.hits, ...next.hits] })
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setLoadingMore(false)
    }
  }

  return h('div', null,
    h('div', { style: styles.field },
      h('label', { style: styles.label }, '关键词（3 个字符以上走 FTS5 trigram，1–2 字自动回退 LIKE）'),
      h('div', { style: styles.row },
        h('input', { style: { ...styles.input, flex: 1 }, value: query, placeholder: '例如：构建、知识库、模型调用', onChange: (e: any) => setQuery(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') void search() } }),
        h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: loading, onClick: () => void search() }, loading ? '检索中…' : '检索'),
      ),
    ),
    h('div', { style: styles.field },
      h('label', { style: styles.label }, '标签过滤（可选，逗号分隔，需同时命中全部标签）'),
      h('input', { style: styles.input, value: tags, placeholder: '例如：自动提炼, 架构', onChange: (e: any) => setTags(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') void search() } }),
    ),
    h('div', { style: styles.row },
      h('div', { style: { flex: 1 } }, h('label', { style: styles.label }, '知识库'),
        h('select', { style: styles.input, value: kbId, onChange: (e: any) => setKbId(e.target.value) },
          h('option', { value: '' }, '全部（当前作用域）'),
          (knowledgeBases ?? []).map((kb: any) => h('option', { key: kb.id, value: kb.id }, kb.name)),
        )),
      h('div', { style: { flex: 1 } }, h('label', { style: styles.label }, '知识类型'),
        h('select', { style: styles.input, value: kind, onChange: (e: any) => setKind(e.target.value) },
          h('option', { value: '' }, '全部类型'),
          KINDS.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
        )),
      h('div', { style: { flex: 1 } }, h('label', { style: styles.label }, '审核状态'),
        h('select', { style: styles.input, value: status, onChange: (e: any) => setStatus(e.target.value) },
          h('option', { value: 'any' }, '全部'),
          h('option', { value: 'approved' }, '仅已批准'),
          h('option', { value: 'draft' }, '仅待审核'),
        )),
      h('div', { style: { flex: 1 } }, h('label', { style: styles.label }, '排序'),
        h('select', { style: styles.input, value: sort, onChange: (e: any) => setSort(e.target.value) },
          h('option', { value: 'relevance' }, '相关性优先'),
          h('option', { value: 'updated' }, '更新时间优先'),
        )),
    ),
    error !== null ? h('div', { style: styles.error }, error) : null,
    result === null ? h('div', { style: styles.empty }, '输入关键词后点击「检索」。结果只包含当前工作区已批准知识与用户级共享知识。')
      : result.hits.length === 0 ? h('div', { style: styles.empty }, '没有匹配的知识（检索模式：' + result.mode + '）')
      : h('div', null,
        h('div', { style: styles.hint }, '命中 ' + result.total + ' 条，已显示 ' + result.hits.length + ' 条（每页 ' + PAGE_SIZE + ' 条，合并重复 ' + (result.duplicatesMerged ?? 0) + ' 条），检索模式：' + (result.mode === 'fts' ? 'FTS5 trigram' : result.mode === 'like' ? 'LIKE 回退' : '最近更新') + '；作用域：' + (result.scopeKeys ?? []).join(' / ')),
        result.hits.map((hit: any) => h('div', { key: hit.id, style: styles.card },
          h('div', { style: styles.cardTitle }, hit.title,
            h(Badge, { text: KIND_LABEL[hit.kind] ?? hit.kind }),
            h(Badge, { text: DOC_STATUS_LABEL[hit.status] ?? hit.status, style: hit.status === 'approved' ? styles.badgeGreen : styles.badgeAmber }),
            h(Badge, { text: VERIFY_LABEL[hit.verifyState] ?? hit.verifyState }),
            (hit.duplicates ?? 0) > 0 ? h(Badge, { text: '合并 ' + hit.duplicates + ' 条重复' }) : null,
          ),
          h('div', { style: styles.meta },
            h('span', null, '知识库：' + hit.kbName),
            h('span', null, '作用域：' + hit.scope),
            h('span', null, '匹配方式：' + hit.matchedBy),
            (hit.duplicateKbIds ?? []).length > 0 ? h('span', null, '同内容库：' + (hit.duplicateKbIds ?? []).join(' / ')) : null,
            h('span', null, '更新于 ' + new Date(hit.updatedAt).toLocaleString('zh-CN')),
          ),
          h('div', { style: styles.snippet }, hit.snippet),
          h('div', { style: styles.path }, hit.path),
        )),
        result.hits.length < result.total
          ? h('div', { style: { ...styles.row, marginTop: '6px' } },
            h('button', { type: 'button', style: loadingMore ? { ...styles.button, ...styles.buttonDisabled } : styles.button, className: 'kh-hover', disabled: loadingMore, onClick: () => void loadMore() }, loadingMore ? '加载中…' : '加载更多（还剩 ' + (result.total - result.hits.length) + ' 条）'),
          )
          : h('div', { style: styles.hint }, '已显示全部 ' + result.total + ' 条结果。'),
      ),
  )
}

// ---------- 诊断 ----------

function DiagnosticsView(): any {
  const [data, setData] = R.useState(null)
  const [error, setError] = R.useState(null)
  const [busy, setBusy] = R.useState(null)
  const run = async (label: string, path: string, options?: { method?: string; body?: unknown }) => {
    setBusy(label + '…'); setError(null)
    try {
      setData(await request(path, options ?? {}))
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setBusy(null)
    }
  }
  return h('div', null,
    h('div', { style: styles.row },
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void run('读取诊断', '/diagnose') }, '运行环境诊断'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void run('读取模型目录', '/models') }, '模型目录'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void run('SQLite 探针', '/sqlite') }, 'SQLite / FTS5'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void run('扫描当前工作区', '/scan', { method: 'POST', body: {} }) }, '扫描当前工作区'),
    ),
    busy !== null ? h('div', { style: styles.hint }, busy) : null,
    error !== null ? h('div', { style: styles.error }, error) : null,
    h('pre', { style: { ...styles.pre, marginTop: '10px' } }, data === null ? '（点击上方按钮读取真实数据）' : JSON.stringify(data, null, 2)),
    h('div', { style: styles.hint }, '数据来源：宿主 /knowhub/api/*，真实调用 DSH 的 workspaceRegistry / llm / node:sqlite。'),
  )
}

// ---------- 审核（M3） ----------

const PROPOSAL_KIND_LABEL: Record<string, string> = { create: '新增', update: '修改', restore: '恢复', stale: '标记过时' }
const CHANGE_KIND_LABEL: Record<string, string> = { create: '新建', update: '更新', restore: '恢复', stale: '标记过时', merge: '合并' }

function DiffView(props: any): any {
  const { diff } = props
  if (!diff || !Array.isArray(diff.lines) || diff.lines.length === 0) return h('div', { style: styles.hint }, '没有可显示的差异')
  const stats = diff.stats ?? { added: 0, removed: 0, unchanged: 0 }
  return h('div', null,
    h('div', { style: styles.hint }, '差异统计：新增 ' + stats.added + ' 行 / 删除 ' + stats.removed + ' 行 / 未变 ' + stats.unchanged + ' 行' + (diff.truncated ? '（内容过长已截断）' : '')),
    h('div', { style: styles.diffBox }, diff.lines.map((line: any, index: number) => h('div', {
      key: index,
      style: line.type === 'add' ? styles.diffAdd : line.type === 'del' ? styles.diffDel : styles.diffEqual,
    }, (line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ') + line.text))),
  )
}

const DIFF_MARK: Record<string, string> = { add: '+', del: '-', equal: ' ' }

Object.assign(styles, {
  diffPageHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  diffPageTitle: { fontSize: '15px', fontWeight: 600, lineHeight: '22px', marginRight: '2px' },
  diffStat: { display: 'inline-flex', alignItems: 'center', height: '22px', padding: '0 8px', borderRadius: '6px', fontSize: '12px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' },
  diffStatAdd: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)' },
  diffStatDel: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)' },
  diffPane: { marginTop: '10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', background: 'var(--dsw-alias-bg-l1)', overflow: 'auto', maxHeight: '58vh', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px', lineHeight: '20px' },
  diffRow: { display: 'flex', width: '100%' },
  diffRowAdd: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent)' },
  diffRowDel: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)' },
  diffRowEmpty: { background: 'color-mix(in srgb, var(--dsw-alias-bg-l2) 55%, transparent)' },
  diffGutter: { flex: '0 0 44px', textAlign: 'right', padding: '0 6px', color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none', whiteSpace: 'nowrap' },
  diffMarkerCell: { flex: '0 0 20px', textAlign: 'center', userSelect: 'none', color: 'var(--dsw-alias-label-secondary)' },
  diffText: { flex: '1 1 auto', minWidth: 0, padding: '0 10px 0 2px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)' },
  diffSplitCol: { flex: '1 1 50%', minWidth: 0 },
  diffSplitLeft: { flex: '1 1 50%', minWidth: 0, borderRight: '1px solid var(--dsw-alias-border-l2)' },
  diffHead: { display: 'flex', position: 'sticky', top: 0, zIndex: 2, background: 'var(--dsw-alias-bg-l2)', borderBottom: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '22px' },
  diffHeadCell: { flex: '1 1 auto', padding: '0 10px 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  diffTextNoWrap: { flex: '1 1 auto', padding: '0 10px 0 2px', whiteSpace: 'pre', wordBreak: 'normal', color: 'var(--dsw-alias-label-primary)' },
  diffWordAdd: { borderRadius: '3px', background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)' },
  diffWordDel: { borderRadius: '3px', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)' },
  diffFoldRow: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '2px 10px', border: '0', borderTop: '1px dashed var(--dsw-alias-border-l2)', borderBottom: '1px dashed var(--dsw-alias-border-l2)', background: 'color-mix(in srgb, var(--dsw-alias-bg-l2) 55%, transparent)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '20px', cursor: 'pointer', textAlign: 'left' },
  diffChangeBlockActive: { boxShadow: 'inset 2px 0 0 var(--dsw-alias-state-business-primary)' },
})

/** 折叠未变内容时上下各保留的上下文行数。 */
const DIFF_CONTEXT_LINES = 3
/** 单行词元数超过该值时退化为整行高亮，避免 O(n²) 计算卡住面板。 */
const DIFF_MAX_INLINE_TOKENS = 700
/** 改动块内两侧行数乘积超过该值时退化为按位置配对。 */
const DIFF_MAX_PAIR_CANDIDATES = 400
const DIFF_TOKEN_SOURCE = '(\\s+|[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f]|[A-Za-z0-9_$]+|[^\\sA-Za-z0-9_$\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f])'

/** 取出宿主返回的一行差异文本。 */
function diffLineText(line: any): string {
  return String(line && line.text !== undefined && line.text !== null ? line.text : '')
}

/** 把一行文本拆成词元：CJK 单字、ASCII 单词、空白与其他符号各自成 token。 */
function diffTokens(text: string): string[] {
  const matched = String(text ?? '').match(new RegExp(DIFF_TOKEN_SOURCE, 'g'))
  return matched === null ? [] : matched
}

/**
 * 行内差异：用词元级 LCS 找出同一处改动里真正变化的字/词，未变部分保留为普通文本。
 * 返回左右两侧的分段（changed=true 需要高亮）与相似度（0–1，供并排配对参考）。
 */
function diffInlineSegments(leftText: string, rightText: string): any {
  const whole = (): any => ({
    left: String(leftText) === '' ? [] : [{ text: String(leftText), changed: true }],
    right: String(rightText) === '' ? [] : [{ text: String(rightText), changed: true }],
    similarity: 0,
  })
  const left = diffTokens(leftText)
  const right = diffTokens(rightText)
  if (left.length === 0 || right.length === 0) return whole()
  if (left.length > DIFF_MAX_INLINE_TOKENS || right.length > DIFF_MAX_INLINE_TOKENS) return whole()
  if (left.length * right.length > 260000) return whole()
  const columns = right.length + 1
  const table = new Int32Array((left.length + 1) * columns)
  const at = (row: number, col: number): number => table[row * columns + col] ?? 0
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = left[i] === right[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const leftFlags: boolean[] = []
  const rightFlags: boolean[] = []
  let matched = 0
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      leftFlags.push(false)
      rightFlags.push(false)
      matched += 1
      i += 1
      j += 1
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      leftFlags.push(true)
      i += 1
    } else {
      rightFlags.push(true)
      j += 1
    }
  }
  while (i < left.length) { leftFlags.push(true); i += 1 }
  while (j < right.length) { rightFlags.push(true); j += 1 }
  const merge = (tokens: string[], flags: boolean[]): any[] => {
    const parts: any[] = []
    for (let k = 0; k < tokens.length; k += 1) {
      const changed = flags[k] === true
      const last = parts[parts.length - 1]
      if (last !== undefined && last.changed === changed) last.text += tokens[k]
      else parts.push({ text: tokens[k], changed })
    }
    return parts
  }
  const total = left.length + right.length
  return { left: merge(left, leftFlags), right: merge(right, rightFlags), similarity: total === 0 ? 0 : (2 * matched) / total }
}

/**
 * 在改动块内按「相似度 + 保序」对齐两侧行（类似 diff 工具的行对齐）：
 * 高相似的行配成一对（并排显示 replace），剩下的作为纯删除/纯新增行。
 */
function alignDiffLines(dels: any[], adds: any[]): any[] {
  const rowCount = dels.length
  const colCount = adds.length
  const pairs: any[] = []
  if (rowCount === 0 || colCount === 0 || rowCount * colCount > DIFF_MAX_PAIR_CANDIDATES) {
    const size = Math.max(rowCount, colCount)
    for (let k = 0; k < size; k += 1) {
      const left = k < rowCount ? dels[k] : null
      const right = k < colCount ? adds[k] : null
      pairs.push({ left, right, inline: left !== null && right !== null ? diffInlineSegments(left.text, right.text) : null })
    }
    return pairs
  }
  const sim = new Float64Array(rowCount * colCount)
  const simAt = (row: number, col: number): number => sim[row * colCount + col] ?? 0
  for (let i = 0; i < rowCount; i += 1) {
    for (let j = 0; j < colCount; j += 1) {
      sim[i * colCount + j] = diffInlineSegments(dels[i].text, adds[j].text).similarity
    }
  }
  const width = colCount + 1
  const best = new Float64Array((rowCount + 1) * width)
  const bestAt = (row: number, col: number): number => best[row * width + col] ?? 0
  for (let i = rowCount - 1; i >= 0; i -= 1) {
    for (let j = colCount - 1; j >= 0; j -= 1) {
      const diag = simAt(i, j) + bestAt(i + 1, j + 1)
      const skipLeft = bestAt(i + 1, j)
      const skipRight = bestAt(i, j + 1)
      best[i * width + j] = diag >= skipLeft && diag >= skipRight ? diag : (skipLeft >= skipRight ? skipLeft : skipRight)
    }
  }
  let i = 0
  let j = 0
  while (i < rowCount && j < colCount) {
    const diag = simAt(i, j) + bestAt(i + 1, j + 1)
    const skipLeft = bestAt(i + 1, j)
    const skipRight = bestAt(i, j + 1)
    if (diag >= skipLeft && diag >= skipRight) {
      pairs.push({ left: dels[i], right: adds[j], inline: diffInlineSegments(dels[i].text, adds[j].text) })
      i += 1
      j += 1
    } else if (skipLeft >= skipRight) {
      pairs.push({ left: dels[i], right: null, inline: null })
      i += 1
    } else {
      pairs.push({ left: null, right: adds[j], inline: null })
      j += 1
    }
  }
  while (i < rowCount) { pairs.push({ left: dels[i], right: null, inline: null }); i += 1 }
  while (j < colCount) { pairs.push({ left: null, right: adds[j], inline: null }); j += 1 }
  return pairs
}

/** 把行级差异转成并排视图行：左侧当前正式内容，右侧新提议内容。 */
function diffSplitRows(diff: any): any[] {
  const lines: any[] = Array.isArray(diff && diff.lines) ? diff.lines : []
  const rows: any[] = []
  let oldNum = 0
  let newNum = 0
  let index = 0
  while (index < lines.length) {
    const type = String(lines[index] && lines[index].type ? lines[index].type : 'equal')
    if (type === 'equal') {
      oldNum += 1
      newNum += 1
      const text = diffLineText(lines[index])
      rows.push({ type: 'equal', left: { num: oldNum, text }, right: { num: newNum, text }, inline: null })
      index += 1
      continue
    }
    const dels: any[] = []
    const adds: any[] = []
    while (index < lines.length && String(lines[index] && lines[index].type) === 'del') {
      oldNum += 1
      dels.push({ num: oldNum, text: diffLineText(lines[index]) })
      index += 1
    }
    while (index < lines.length && String(lines[index] && lines[index].type) === 'add') {
      newNum += 1
      adds.push({ num: newNum, text: diffLineText(lines[index]) })
      index += 1
    }
    if (dels.length === 0 && adds.length === 0) { index += 1; continue }
    for (const pair of alignDiffLines(dels, adds)) {
      rows.push({
        type: pair.left !== null && pair.right !== null ? 'replace' : pair.left !== null ? 'del' : 'add',
        left: pair.left,
        right: pair.right,
        inline: pair.inline,
      })
    }
  }
  return rows
}

/** 并排行 → 统一视图行：一次改动的删除行紧跟对应新增行，行号分别来自两侧。 */
function diffUnifiedRowsFromSplit(splitRows: any[]): any[] {
  const rows: any[] = []
  for (const row of splitRows) {
    if (row.type === 'equal') {
      rows.push({ type: 'equal', oldNum: row.left.num, newNum: row.right.num, text: row.left.text, parts: null })
      continue
    }
    if (row.left !== null) rows.push({ type: 'del', oldNum: row.left.num, newNum: null, text: row.left.text, parts: row.inline === null ? null : row.inline.left })
    if (row.right !== null) rows.push({ type: 'add', oldNum: null, newNum: row.right.num, text: row.right.text, parts: row.inline === null ? null : row.inline.right })
  }
  return rows
}

/** 统一视图行（旧/新行号并列），供对比页与冒烟测试使用。 */
function diffUnifiedRows(diff: any): any[] {
  return diffUnifiedRowsFromSplit(diffSplitRows(diff))
}

/** 把行序列切成「未变段」与「改动段」，未变段过长时由对比页折叠。 */
function diffSegments(rows: any[]): any[] {
  const segments: any[] = []
  let index = 0
  while (index < rows.length) {
    const isChange = String(rows[index] && rows[index].type) !== 'equal'
    const start = index
    while (index < rows.length && (String(rows[index] && rows[index].type) !== 'equal') === isChange) index += 1
    segments.push({ change: isChange, rows: rows.slice(start, index) })
  }
  return segments
}

const DIFF_MODEL_CACHE = new WeakMap<object, any>()

/** 组装一次对比视图所需的两种行序列与改动处数量；按 diff 对象缓存，避免每次渲染重算。 */
function diffModel(diff: any): any {
  const cacheable = diff !== null && typeof diff === 'object'
  if (cacheable && DIFF_MODEL_CACHE.has(diff)) return DIFF_MODEL_CACHE.get(diff)
  const split = diffSplitRows(diff)
  const unified = diffUnifiedRowsFromSplit(split)
  let changeCount = 0
  for (const segment of diffSegments(split)) if (segment.change) changeCount += 1
  const model = { unified, split, changeCount }
  if (cacheable) DIFF_MODEL_CACHE.set(diff, model)
  return model
}

/** 待审核「查看详情与差异」的全页对比视图：绿色新增 / 红色删除，支持统一与并排两种排版。 */
function DocumentDiffPage(props: any): any {
  const { state, busy, error, notice, note, onNote, onBack } = props
  const data = state && state.data ? state.data : null
  const [viewMode, setViewMode] = R.useState('unified')
  const [editOpen, setEditOpen] = R.useState(false)
  const [mergeOpen, setMergeOpen] = R.useState(false)
  const [editTitle, setEditTitle] = R.useState('')
  const [editBody, setEditBody] = R.useState('')
  const [wrap, setWrap] = R.useState(true)
  const [folded, setFolded] = R.useState({})
  const [expandAll, setExpandAll] = R.useState(false)
  const [activeChange, setActiveChange] = R.useState(0)
  R.useEffect(() => {
    if (!data) return
    const target = data.target ?? {}
    setEditTitle(String(target.title ?? ''))
    setEditBody(String(target.body ?? ''))
    setEditOpen(false)
    setMergeOpen(false)
  }, [data])

  if (state && state.loading) {
    return h('div', null,
      h('div', { style: styles.diffPageHead },
        h('button', { type: 'button', style: styles.linkButton, className: 'kh-hover', onClick: onBack }, '← 返回待审核列表'),
        h('div', { style: styles.diffPageTitle }, '正在读取差异…'),
      ),
      h('div', { style: styles.empty }, '正在读取当前正式内容与候选内容…'),
    )
  }
  if (!data) {
    return h('div', null,
      h('div', { style: styles.diffPageHead },
        h('button', { type: 'button', style: styles.linkButton, className: 'kh-hover', onClick: onBack }, '← 返回待审核列表'),
        h('div', { style: styles.diffPageTitle }, '差异读取失败'),
      ),
      h('div', { style: styles.error }, String((state && state.error) ?? error ?? '未知错误')),
      h('div', { style: { ...styles.row, marginTop: '10px' } },
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: onBack }, '返回列表'),
      ),
    )
  }

  const isProposal = data.kind === 'proposal'
  const isDocument = data.kind === 'document'
  const entity = isProposal ? (data.proposal ?? {}) : isDocument ? (data.document ?? {}) : (data.conflict ?? {})
  const docStatus = String((data.document && data.document.status) || entity.status || '')
  const staleDoc = isDocument && docStatus === 'stale'
  const target = data.target ?? { title: '', body: '' }
  const base = data.base ?? { title: null, body: '', version: null, status: null }
  const doc = data.document ?? null
  const diff = data.diff ?? { lines: [], truncated: false, stats: { added: 0, removed: 0, unchanged: 0 } }
  const stats = diff.stats ?? { added: 0, removed: 0, unchanged: 0 }
  const kbName = data.kb && data.kb.name ? String(data.kb.name) : ''
  const baseStatus = base.status ? (DOC_STATUS_LABEL[String(base.status)] ?? String(base.status)) : ''
  const model = diffModel(diff)
  const unified: any[] = model.unified
  const split: any[] = model.split
  const changeCount = Number(model.changeCount ?? 0)
  const rows: any[] = viewMode === 'unified' ? unified : split
  const segments = diffSegments(rows)
  // 并排视图两列必须逐行对齐，若允许不换行会因两侧内容宽度不同而错位，因此并排始终换行。
  const textStyle = viewMode === 'split' || wrap ? styles.diffText : styles.diffTextNoWrap
  // 自动换行打开时行宽必须允许收缩（默认的 min-width:auto 会让长行撑破容器），关闭时反过来要按内容撑开才能横向滚动。
  const rowBase = wrap ? styles.diffRow : { ...styles.diffRow, minWidth: 'max-content' }
  const rowStyle = (type: string) => type === 'add' ? { ...rowBase, ...styles.diffRowAdd } : type === 'del' ? { ...rowBase, ...styles.diffRowDel } : rowBase
  // 行内高亮：词元级 LCS 已把未变的字/词标成 changed=false，这里只把变化段包一层底色。
  const renderParts = (text: string, parts: any, tone: string) => {
    const fallback = String(text) === '' ? ' ' : String(text)
    if (!Array.isArray(parts) || parts.length === 0) return fallback
    return parts.map((part: any, index: number) => part && part.changed === true
      ? h('span', { key: index, style: tone === 'add' ? styles.diffWordAdd : styles.diffWordDel }, String(part.text ?? ''))
      : h('span', { key: index }, String(part && part.text !== undefined ? part.text : '')))
  }
  const splitCell = (cell: any, tone: string, isLeft: boolean, parts: any) => h('div', {
    style: { ...(isLeft ? styles.diffSplitLeft : styles.diffSplitCol), ...(tone === 'add' ? styles.diffRowAdd : tone === 'del' ? styles.diffRowDel : tone === 'empty' ? styles.diffRowEmpty : null) },
  },
    h('div', { style: rowBase },
      h('span', { style: styles.diffGutter }, cell ? String(cell.num) : ''),
      h('span', { style: styles.diffMarkerCell }, tone === 'add' ? '+' : tone === 'del' ? '-' : ' '),
      h('span', { style: textStyle }, renderParts(cell ? cell.text : '', parts, tone === 'add' ? 'add' : 'del')),
    ),
  )
  const unifiedRow = (row: any, key: any) => h('div', { key, style: rowStyle(row.type) },
    h('span', { style: styles.diffGutter }, row.oldNum === null ? '' : String(row.oldNum)),
    h('span', { style: styles.diffGutter }, row.newNum === null ? '' : String(row.newNum)),
    h('span', { style: styles.diffMarkerCell }, DIFF_MARK[row.type] ?? ' '),
    h('span', { style: textStyle }, renderParts(row.text, row.parts, row.type)),
  )
  const splitRow = (row: any, key: any) => h('div', { key, style: rowBase },
    splitCell(row.left, row.left === null ? 'empty' : row.type === 'equal' ? 'equal' : 'del', true, row.type === 'equal' || row.inline === null ? null : row.inline.left),
    splitCell(row.right, row.right === null ? 'empty' : row.type === 'equal' ? 'equal' : 'add', false, row.type === 'equal' || row.inline === null ? null : row.inline.right),
  )
  const toggleFold = (key: string) => {
    setExpandAll(false)
    setFolded({ ...folded, [key]: !(folded[key] === true) })
  }
  const jumpToChange = (next: number) => {
    if (changeCount === 0) return
    const targetIndex = Math.max(0, Math.min(changeCount - 1, next))
    setActiveChange(targetIndex)
    const doc: any = (globalThis as any).document
    if (!doc || typeof doc.getElementById !== 'function') return
    const focus = () => {
      const element = doc.getElementById('kh-diff-change-' + String(targetIndex))
      if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' })
    }
    if (typeof (globalThis as any).requestAnimationFrame === 'function') (globalThis as any).requestAnimationFrame(focus)
    else setTimeout(focus, 0)
  }
  const renderSegmentRows = (segmentRows: any[], prefix: string) => segmentRows.map((row: any, rowIndex: number) => viewMode === 'unified' ? unifiedRow(row, prefix + String(rowIndex)) : splitRow(row, prefix + String(rowIndex)))
  const renderPaneBody = () => {
    if (rows.length === 0) return h('div', { style: styles.empty }, '两侧内容一致，没有可见差异')
    const rendered: any[] = []
    let changeOrdinal = -1
    let segmentIndex = 0
    for (const segment of segments) {
      const key = viewMode + ':' + String(segmentIndex)
      segmentIndex += 1
      if (segment.change) {
        changeOrdinal += 1
        const active = changeOrdinal === activeChange
        rendered.push(h('div', {
          key: 'change-' + String(changeOrdinal),
          id: 'kh-diff-change-' + String(changeOrdinal),
          style: active ? styles.diffChangeBlockActive : null,
        }, renderSegmentRows(segment.rows, 'c' + String(changeOrdinal) + '-')))
        continue
      }
      const foldable = segment.rows.length > DIFF_CONTEXT_LINES * 2 + 2
      const expanded = expandAll || folded[key] === true
      if (!foldable || expanded) {
        rendered.push(h('div', { key: key + ':all' }, renderSegmentRows(segment.rows, key + '-all-')))
        if (foldable) {
          rendered.push(h('button', { key: key + ':fold', type: 'button', style: styles.diffFoldRow, className: 'kh-hover', onClick: () => toggleFold(key) }, '⋯ 收起 ' + String(segment.rows.length - DIFF_CONTEXT_LINES * 2) + ' 行未变内容'))
        }
        continue
      }
      const hidden = segment.rows.length - DIFF_CONTEXT_LINES * 2
      rendered.push(h('div', { key: key + ':head' }, renderSegmentRows(segment.rows.slice(0, DIFF_CONTEXT_LINES), key + '-head-')))
      rendered.push(h('button', { key: key + ':fold', type: 'button', style: styles.diffFoldRow, className: 'kh-hover', onClick: () => toggleFold(key) }, '⋯ 展开 ' + String(hidden) + ' 行未变内容'))
      rendered.push(h('div', { key: key + ':tail' }, renderSegmentRows(segment.rows.slice(segment.rows.length - DIFF_CONTEXT_LINES), key + '-tail-')))
    }
    return rendered
  }

  const diffPane = h('div', { style: styles.diffPane, className: 'kh-scroll' },
    viewMode === 'unified'
      ? h('div', { style: styles.diffHead },
          h('span', { style: styles.diffGutter }, '旧'),
          h('span', { style: styles.diffGutter }, '新'),
          h('span', { style: styles.diffMarkerCell }, ''),
          h('span', { style: styles.diffHeadCell }, '差异内容（绿色 + 新增 / 红色 - 删除，深色底为行内变化）'),
        )
      : h('div', { style: styles.diffHead },
          h('span', { style: { ...styles.diffSplitLeft, padding: '0 10px' } }, isDocument ? '上一版内容' : '当前正式内容'),
          h('span', { style: { ...styles.diffSplitCol, padding: '0 10px' } }, isDocument ? '当前内容（待审核）' : '新提议内容（候选）'),
        ),
    renderPaneBody(),
  )

  const editor = (kind: string) => h('div', { style: styles.field, marginTop: '10px' },
    h('label', { style: styles.label }, kind === 'merge' ? '合并后标题' : '标题'),
    h('input', { style: styles.input, value: editTitle, onChange: (e: any) => setEditTitle(e.target.value) }),
    h('label', { style: { ...styles.label, marginTop: '8px' } }, kind === 'merge' ? '合并后正文（预填新提议正文，可自由编辑）' : '正文（预填候选正文，保存时作为本次批准的内容）'),
    h('textarea', { style: { ...styles.textarea, minHeight: '200px' }, value: editBody, onChange: (e: any) => setEditBody(e.target.value) }),
    h('div', { style: styles.row, marginTop: '8px' },
      kind === 'merge'
        ? h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => props.onResolveConflict('merge', { title: editTitle, body: editBody }) }, '保存合并结果')
        : h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => props.onApproveProposal({ title: editTitle, body: editBody }) }, '保存并批准'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => { if (kind === 'merge') setMergeOpen(false); else setEditOpen(false) } }, '取消'),
    ),
  )

  // 三种审核对象共用同一套操作条：候选（proposal）/ 知识本身（草稿、过时）/ 版本冲突（conflict）。
  const actions = h('div', { style: { ...styles.card, marginTop: '12px' } },
    h('div', { style: styles.field },
      h('input', { style: styles.input, value: note, placeholder: '审核备注（可选，会写入审核日志）', onChange: (e: any) => onNote(e.target.value) }),
    ),
    h('div', { style: styles.row, marginTop: '8px' },
      isProposal
        ? h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => props.onApproveProposal(null) }, '批准此候选')
        : isDocument
          ? h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => props.onApproveProposal(null) }, staleDoc ? '确认仍有效（恢复已批准）' : '批准这条知识')
          : h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => props.onResolveConflict('keep_current', null) }, '保留当前知识'),
      isProposal || isDocument ? null : h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => props.onResolveConflict('use_proposed', null) }, '采用新提议（追加合并版本）'),
      isProposal || isDocument
        ? h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => { setMergeOpen(false); setEditOpen(!editOpen) } }, editOpen ? '收起编辑' : '编辑后批准…')
        : h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => { setEditOpen(false); setMergeOpen(!mergeOpen) } }, mergeOpen ? '收起合并编辑器' : '人工合并…'),
      isProposal || isDocument
        ? h('button', { type: 'button', style: styles.danger, className: 'kh-danger', disabled: busy !== null, onClick: () => props.onRejectProposal() }, isDocument ? '拒绝（归档）' : '拒绝此候选')
        : null,
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: onBack }, '返回待审核列表'),
    ),
    editOpen ? editor('edit') : null,
    mergeOpen ? editor('merge') : null,
  )

  return h('div', null,
    h('div', { style: styles.diffPageHead },
      h('button', { type: 'button', style: styles.linkButton, className: 'kh-hover', onClick: onBack }, '← 返回待审核列表'),
      h('div', { style: styles.diffPageTitle }, (isProposal ? '候选对比：' : isDocument ? '知识对比：' : '冲突对比：') + String(target.title ?? '')),
      isProposal
        ? h(Badge, { text: PROPOSAL_KIND_LABEL[String(entity.kind)] ?? String(entity.kind ?? ''), style: styles.badgeAmber })
        : isDocument
          ? h(Badge, { text: staleDoc ? '已过时' : '待审核草稿', style: styles.badgeAmber })
          : h(Badge, { text: '版本冲突', style: styles.badgeAmber }),
      (entity.docKind || (isDocument ? entity.kind : null)) ? h(Badge, { text: KIND_LABEL[String(entity.docKind || entity.kind)] ?? String(entity.docKind || entity.kind) }) : null,
      kbName !== '' ? h(Badge, { text: kbName }) : null,
      isProposal && entity.source ? h(Badge, { text: '来源 ' + String(entity.source) }) : null,
    ),
    h('div', { style: styles.meta },
      isDocument
        ? h('span', null, doc ? '这条知识：第 ' + String(doc.currentVersion) + ' 版' + (baseStatus !== '' ? '（' + baseStatus + '）' : '') : '知识信息缺失')
        : h('span', null, doc ? '当前正式内容：第 ' + String(doc.currentVersion) + ' 版' + (baseStatus !== '' ? '（' + baseStatus + '）' : '') : '当前没有对应的正式文档'),
      isDocument
        ? h('span', null, base.version === null || base.version === undefined
            ? '只有一版历史，下方内容全部视为新增'
            : '基线：第 ' + String(base.version) + ' 版 → 当前第 ' + String(base.version + 1) + ' 版')
        : isProposal
          ? h('span', null, entity.createdAt ? '候选提交于 ' + new Date(entity.createdAt).toLocaleString('zh-CN') : '候选')
          : h('span', null, '基础版本：第 ' + String(entity.baseVersion) + ' 版 → 当前第 ' + String(entity.currentVersion) + ' 版'),
      doc && doc.title ? h('span', null, '文档：' + String(doc.title)) : null,
      isDocument
        ? h('span', null, base.version === null || base.version === undefined ? '没有历史版本可对比，当前正文全部显示为新增' : '左为上一版内容，右为当前内容')
        : h('span', null, doc ? '左为当前正式内容，右为候选内容' : '该候选是新增知识，下方内容全部为新增'),
      diff.truncated ? h('span', null, '内容过长，差异已截断展示') : null,
    ),
    h('div', { style: { ...styles.row, alignItems: 'center', marginTop: '10px' } },
      h('span', { style: { ...styles.diffStat, ...styles.diffStatAdd } }, '新增 ' + String(stats.added) + ' 行'),
      h('span', { style: { ...styles.diffStat, ...styles.diffStatDel } }, '删除 ' + String(stats.removed) + ' 行'),
      h('span', { style: styles.diffStat }, '未变 ' + String(stats.unchanged) + ' 行'),
      h('div', { style: styles.segGroup },
        h('button', { type: 'button', style: viewMode === 'unified' ? styles.segActive : styles.seg, onClick: () => { setViewMode('unified'); setActiveChange(0) } }, '统一视图'),
        h('button', { type: 'button', style: viewMode === 'split' ? styles.segActive : styles.seg, onClick: () => { setViewMode('split'); setActiveChange(0) } }, '并排视图'),
      ),
      h('div', { style: styles.segGroup },
        viewMode === 'split' ? null : h('button', { type: 'button', style: wrap ? styles.segActive : styles.seg, onClick: () => setWrap(!wrap) }, '自动换行'),
        h('button', { type: 'button', style: expandAll ? styles.segActive : styles.seg, onClick: () => { setExpandAll(!expandAll); setFolded({}) } }, '展开全部上下文'),
      ),
    ),
    h('div', { style: { ...styles.row, alignItems: 'center', marginTop: '6px' } },
      changeCount > 0
        ? h('span', { style: styles.diffStat }, '第 ' + String(Math.min(activeChange, changeCount - 1) + 1) + ' / ' + String(changeCount) + ' 处改动')
        : h('span', { style: styles.hint }, '两侧内容一致，没有改动可跳转'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: changeCount === 0 || activeChange <= 0, onClick: () => jumpToChange(activeChange - 1) }, '↑ 上一处改动'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: changeCount === 0 || activeChange >= changeCount - 1, onClick: () => jumpToChange(activeChange + 1) }, '↓ 下一处改动'),
      h('span', { style: styles.hint }, '改动块左侧有蓝色标线；未变内容超过 7 行会自动折叠。'),
    ),
    diffPane,
    busy !== null ? h('div', { style: styles.hint }, busy + '…') : null,
    error !== null ? h('div', { style: styles.error }, error) : null,
    notice !== '' ? h('div', { style: styles.success }, notice) : null,
    actions,
  )
}

function ReviewView(props: any): any {
  const { knowledgeBases } = props
  const LIMIT = 50
  const [queue, setQueue] = R.useState(null)
  const [loading, setLoading] = R.useState(false)
  const [error, setError] = R.useState(null)
  const [notice, setNotice] = R.useState('')
  const [busy, setBusy] = R.useState(null)
  const [diffPage, setDiffPage] = R.useState(null as any)
  const [proposalEdit, setProposalEdit] = R.useState(null)
  const [docPanel, setDocPanel] = R.useState(null)
  const [docVersion, setDocVersion] = R.useState(null)
  const [reviewLog, setReviewLog] = R.useState(null)
  const [draftEdit, setDraftEdit] = R.useState(null)
  const [conflictEdit, setConflictEdit] = R.useState(null)
  const [notes, setNotes] = R.useState({})
  const [kbFilter, setKbFilter] = R.useState('')
  const [kindFilter, setKindFilter] = R.useState('')
  const [qInput, setQInput] = R.useState('')
  const [q, setQ] = R.useState('')
  const [sourceInput, setSourceInput] = R.useState('')
  const [source, setSource] = R.useState('')
  const [page, setPage] = R.useState(1)
  const [sort, setSort] = R.useState('newest')
  const [selected, setSelected] = R.useState([] as string[])

  const queryString = () => {
    const params = ['limit=' + LIMIT, 'page=' + page, 'order=' + sort]
    if (kbFilter !== '') params.push('kbId=' + encodeURIComponent(kbFilter))
    if (kindFilter !== '') params.push('kind=' + encodeURIComponent(kindFilter))
    if (q !== '') params.push('q=' + encodeURIComponent(q))
    if (source !== '') params.push('source=' + encodeURIComponent(source))
    return params.join('&')
  }
  const load = async () => {
    setLoading(true); setError(null)
    try {
      setQueue(await request('/review?' + queryString()))
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }
  R.useEffect(() => { void load() }, [kbFilter, kindFilter, q, source, page, sort])

  const noteOf = (id: string): string => (notes as any)[id] ?? ''
  const setNote = (id: string, value: string) => setNotes({ ...(notes as any), [id]: value })
  const run = async (label: string, action: () => Promise<any>, after?: () => void) => {
    setBusy(label); setError(null); setNotice('')
    try {
      const result = await action()
      if (result && result.message) setNotice(result.message)
      if (after) after()
      await load()
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setBusy(null)
    }
  }
  const applyFilters = () => { setQ(qInput.trim()); setSource(sourceInput.trim()); setPage(1) }
  const resetFilters = () => { setQInput(''); setQ(''); setSourceInput(''); setSource(''); setKindFilter(''); setKbFilter(''); setPage(1) }

  const toggleSelected = (key: string) => {
    if (selected.indexOf(key) >= 0) { setSelected(selected.filter((item: string) => item !== key)); return }
    if (selected.length >= LIMIT) { setError('单次批量最多勾选 ' + LIMIT + ' 条，请先处理已选内容'); return }
    setSelected([...selected, key])
  }
  const selectedOfType = (type: string): string[] => selected.filter((key: string) => key.indexOf(type + ':') === 0)
  const selectAll = (type: string, items: any[]) => {
    const keys = items.map((item: any) => type + ':' + item.id)
    const merged: string[] = selected.slice()
    for (const key of keys) { if (merged.indexOf(key) < 0) merged.push(key) }
    if (merged.length > LIMIT) { setError('单次批量最多勾选 ' + LIMIT + ' 条，请分批处理'); return }
    setSelected(merged)
  }
  const clearSelection = () => setSelected([])
  /** 跨页选择：按当前筛选逐页拉取，直到选满单次批量上限（LIMIT 条）。 */
  const selectAllAcrossPages = async (type: string, total: number) => {
    const wanted = Math.min(total, LIMIT)
    if (wanted <= 0) return
    setBusy('读取筛选结果'); setError(null); setNotice('')
    try {
      const collected: string[] = selected.filter((key: string) => key.indexOf(type + ':') === 0)
      let pageNo = 1
      while (collected.length < wanted) {
        const params = ['limit=100', 'page=' + pageNo, 'order=' + sort]
        if (kbFilter !== '') params.push('kbId=' + encodeURIComponent(kbFilter))
        if (kindFilter !== '') params.push('kind=' + encodeURIComponent(kindFilter))
        if (q !== '') params.push('q=' + encodeURIComponent(q))
        if (source !== '') params.push('source=' + encodeURIComponent(source))
        const value: any = await request('/review?' + params.join('&'))
        let items: any[] = []
        if (type === 'proposal') items = value.proposals ?? []
        else if (type === 'conflict') items = value.conflicts ?? []
        else if (type === 'stale') items = value.staleDocuments ?? []
        else items = value.drafts ?? []
        if (items.length === 0) break
        for (const item of items) {
          const key = type + ':' + item.id
          if (collected.indexOf(key) < 0) collected.push(key)
          if (collected.length >= wanted) break
        }
        pageNo += 1
        if (pageNo > 50) break
      }
      const others = selected.filter((key: string) => key.indexOf(type + ':') !== 0)
      setSelected(others.concat(collected).slice(0, LIMIT))
      setNotice('已选择 ' + Math.min(collected.length, LIMIT) + ' 条' + (total > LIMIT ? '（该筛选共 ' + total + ' 条，单次批量最多 ' + LIMIT + ' 条，已截断）' : ''))
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setBusy(null)
    }
  }
  const bulkRun = async (action: 'approve' | 'reject') => {
    if (selected.length === 0) { setError('请先勾选要批量处理的项目'); return }
    const label = action === 'approve' ? '批准' : '拒绝'
    const confirmText = '确认批量' + label + '选中的 ' + selected.length + ' 条？\n该操作会立即写入数据库、版本历史与审核日志，且不可撤销。'
    if (typeof window !== 'undefined' && typeof (window as any).confirm === 'function' && !(window as any).confirm(confirmText)) return
    const items = selected.map((key: string) => ({ type: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1) }))
    await run('批量' + label, async () => {
      const result = await request('/review/bulk', { method: 'POST', body: { action, items } })
      setSelected([])
      return result
    })
  }

  const openDiff = async (kind: string, id: string) => {
    setError(null); setNotice('')
    setDiffPage({ kind, id, loading: true, data: null, error: null })
    try {
      const path = kind === 'conflict' ? '/review/conflicts/' : kind === 'document' ? '/review/documents/' : '/review/proposals/'
      const data = await request(path + encodeURIComponent(id) + '/diff')
      setDiffPage({ kind, id, loading: false, data, error: null })
    } catch (failure: any) {
      setDiffPage({ kind, id, loading: false, data: null, error: message(failure) })
    }
  }
  const openVersions = async (kbId: string, docId: string) => {
    setError(null); setDocVersion(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(kbId) + '/docs/' + encodeURIComponent(docId) + '/versions')
      setDocPanel({ kbId, docId, versions: value.versions ?? [], currentVersion: value.currentVersion })
    } catch (failure: any) {
      setError(message(failure))
    }
  }
  const openDraftEdit = async (kbId: string, docId: string) => {
    setError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(kbId) + '/docs/' + encodeURIComponent(docId))
      const doc = value.document ?? {}
      setDraftEdit({ kbId, docId, title: String(doc.title ?? ''), body: String(doc.body ?? ''), version: doc.currentVersion })
    } catch (failure: any) {
      setError(message(failure))
    }
  }
  const openLog = async () => {
    setError(null)
    try {
      const value = await request('/review/log?limit=80')
      setReviewLog(value.entries ?? [])
    } catch (failure: any) {
      setError(message(failure))
    }
  }

  const counts = queue ? queue.counts : { proposals: 0, conflicts: 0, drafts: 0, stale: 0, total: 0 }
  const pendingTotal = queue && typeof queue.pendingTotal === 'number' ? queue.pendingTotal : counts.total
  const maxPages = Math.max(1, Math.ceil(Math.max(counts.proposals, counts.conflicts, counts.drafts, counts.stale) / LIMIT))
  const filterHint = queue === null ? '' : '当前筛选 ' + counts.total + ' 项（候选 ' + counts.proposals + ' / 冲突 ' + counts.conflicts + ' / 草稿 ' + counts.drafts + ' / 过时 ' + counts.stale + '）'

  if (diffPage !== null) {
    const entityPath = diffPage.kind === 'conflict' ? '/review/conflicts/' : diffPage.kind === 'document' ? '/review/documents/' : '/review/proposals/'
    const diffData = diffPage.data ?? null
    const docEntity = diffData && diffData.document ? diffData.document : null
    const docKbId = docEntity && docEntity.kbId ? String(docEntity.kbId) : diffData && diffData.kb ? String(diffData.kb.id) : ''
    const docReviewPath = '/kb/' + encodeURIComponent(docKbId) + '/docs/' + encodeURIComponent(diffPage.id) + '/review'
    const isDocTarget = diffPage.kind === 'document'
    return h(DocumentDiffPage, {
      state: diffPage,
      busy, error, notice,
      note: noteOf('diff-page'),
      onNote: (value: string) => setNote('diff-page', value),
      onBack: () => { setDiffPage(null); setNotice(''); setError(null) },
      onApproveProposal: (edits: any) => void run(isDocTarget ? (edits === null ? '批准知识' : '编辑后批准') : (edits === null ? '批准候选' : '编辑后批准'), () => isDocTarget
        ? request(docReviewPath, {
            method: 'POST',
            body: edits === null
              ? { action: 'approve', note: noteOf('diff-page') || null }
              : { action: 'approve', note: noteOf('diff-page') || '审核时编辑后批准', title: edits.title, body: edits.body },
          })
        : request(entityPath + encodeURIComponent(diffPage.id) + '/approve', {
            method: 'POST',
            body: edits === null ? { note: noteOf('diff-page') || null } : { note: noteOf('diff-page') || '编辑后批准', title: edits.title, body: edits.body },
          }), () => setDiffPage(null)),
      onRejectProposal: () => void run(isDocTarget ? '拒绝（归档）' : '拒绝候选', () => isDocTarget
        ? request(docReviewPath, { method: 'POST', body: { action: 'reject', note: noteOf('diff-page') || null } })
        : request(entityPath + encodeURIComponent(diffPage.id) + '/reject', { method: 'POST', body: { note: noteOf('diff-page') || null } }), () => setDiffPage(null)),
      onResolveConflict: (mode: string, payload: any) => void run('处理冲突', () => request('/review/conflicts/' + encodeURIComponent(diffPage.id) + '/resolve', {
        method: 'POST',
        body: Object.assign({ mode }, payload ?? {}),
      }), () => setDiffPage(null)),
    })
  }

  const checkBox = (key: string) => h('input', {
    type: 'checkbox', checked: selected.indexOf(key) >= 0, disabled: busy !== null,
    style: { marginRight: '8px', verticalAlign: 'middle' },
    onChange: () => toggleSelected(key),
  })
  const noteInput = (id: string) => h('input', { style: styles.input, value: noteOf(id), placeholder: '审核备注（可选，会写入审核日志）', onChange: (e: any) => setNote(id, e.target.value) })
  const sectionHead = (title: string, total: number, type?: string, items?: any[]) => {
    const shown = items ? items.length : 0
    return h('div', { style: { ...styles.row, alignItems: 'center', marginTop: '14px' } },
      h('div', { style: { ...styles.sectionTitle, margin: 0 } }, title + '（' + total + '）'),
      type && shown > 0 ? h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => selectAll(type, items ?? []) }, '全选本页') : null,
      type && total > shown ? h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null || total === 0, onClick: () => void selectAllAcrossPages(type, total) }, '全选筛选结果（最多 ' + LIMIT + ' 条）') : null,
    )
  }

  const proposalCard = (item: any) => h('div', { key: item.id, style: styles.card },
    h('div', { style: styles.cardTitle }, checkBox('proposal:' + item.id), item.title,
      h(Badge, { text: PROPOSAL_KIND_LABEL[item.kind] ?? item.kind, style: styles.badgeAmber }),
      item.docKind ? h(Badge, { text: KIND_LABEL[item.docKind] ?? item.docKind }) : null,
      h(Badge, { text: '候选 ' + String(item.id).slice(-6) }),
    ),
    h('div', { style: styles.meta },
      h('span', null, '知识库：' + (item.kbName ?? item.kbId)),
      h('span', null, '来源：' + (item.source ?? '—')),
      h('span', null, '提交人：' + (item.createdBy ?? '—')),
      h('span', null, '创建于 ' + new Date(item.createdAt).toLocaleString('zh-CN')),
    ),
    item.reason ? h('div', { style: styles.snippet }, '说明：' + item.reason) : null,
    h('div', { style: styles.snippet }, String(item.body ?? '').slice(0, 260) + (String(item.body ?? '').length > 260 ? '…' : '')),
    h('div', { style: styles.field, marginTop: '8px' }, noteInput(item.id)),
    h('div', { style: styles.row },
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void openDiff('proposal', item.id) }, '查看详情与差异'),
      h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void run('批准候选', () => request('/review/proposals/' + item.id + '/approve', { method: 'POST', body: { note: noteOf(item.id) || null } })) }, '批准'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => setProposalEdit({ id: item.id, body: String(item.body ?? ''), title: item.title }) }, '编辑后批准'),
      h('button', { type: 'button', style: styles.danger, className: 'kh-danger', disabled: busy !== null, onClick: () => void run('拒绝候选', () => request('/review/proposals/' + item.id + '/reject', { method: 'POST', body: { note: noteOf(item.id) || null } })) }, '拒绝'),
    ),
    proposalEdit !== null && proposalEdit.id === item.id ? h('div', { style: styles.field, marginTop: '10px' },
      h('label', { style: styles.label }, '修改标题'),
      h('input', { style: styles.input, value: proposalEdit.title, onChange: (e: any) => setProposalEdit({ ...proposalEdit, title: e.target.value }) }),
      h('label', { style: { ...styles.label, marginTop: '8px' } }, '修改正文'),
      h('textarea', { style: { ...styles.textarea, minHeight: '140px' }, value: proposalEdit.body, onChange: (e: any) => setProposalEdit({ ...proposalEdit, body: e.target.value }) }),
      h('div', { style: styles.row },
        h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void run('编辑后批准', () => request('/review/proposals/' + item.id + '/approve', { method: 'POST', body: { note: noteOf(item.id) || '编辑后批准', title: proposalEdit.title, body: proposalEdit.body } }), () => setProposalEdit(null)) }, '保存并批准'),
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setProposalEdit(null) }, '取消编辑'),
      ),
    ) : null,
  )

  return h('div', null,
    h('div', { style: { ...styles.card, display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('select', { style: { ...styles.input, width: '200px' }, value: kbFilter, onChange: (e: any) => { setKbFilter(e.target.value); setPage(1) } },
        h('option', { value: '' }, '全部知识库'),
        (knowledgeBases ?? []).map((kb: any) => h('option', { key: kb.id, value: kb.id }, kb.name)),
      ),
      h('select', { style: { ...styles.input, width: '150px' }, value: kindFilter, onChange: (e: any) => { setKindFilter(e.target.value); setPage(1) } },
        h('option', { value: '' }, '全部候选类型'),
        h('option', { value: 'create' }, '新增知识'),
        h('option', { value: 'update' }, '更新知识'),
        h('option', { value: 'restore' }, '恢复知识'),
        h('option', { value: 'stale' }, '标记过时'),
      ),
      h('input', { style: { ...styles.input, width: '200px' }, value: qInput, placeholder: '关键词（标题/正文）', onChange: (e: any) => setQInput(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') applyFilters() } }),
      h('input', { style: { ...styles.input, width: '160px' }, value: sourceInput, placeholder: '来源，如 pipeline', onChange: (e: any) => setSourceInput(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') applyFilters() } }),
      h('select', { style: { ...styles.input, width: '150px' }, value: sort, onChange: (e: any) => { setSort(e.target.value); setPage(1) } },
        h('option', { value: 'newest' }, '最新提交优先'),
        h('option', { value: 'oldest' }, '最早提交优先'),
        h('option', { value: 'updated' }, '最近更新优先'),
      ),
      h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: loading, onClick: applyFilters }, '筛选'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: resetFilters }, '清空'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: loading, onClick: () => void load() }, loading ? '刷新中…' : '刷新'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void openLog() }, '审核日志'),
    ),
    h('div', { style: { ...styles.row, alignItems: 'center', marginTop: '8px' } },
      h('span', { style: styles.badgeAmber }, '待审核合计 ' + pendingTotal + ' 项'),
      h('span', { style: styles.hint }, filterHint + ' · 第 ' + page + ' / ' + maxPages + ' 页（每页最多 ' + LIMIT + ' 条）'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: loading || page <= 1, onClick: () => setPage(page - 1) }, '上一页'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: loading || page >= maxPages, onClick: () => setPage(page + 1) }, '下一页'),
    ),
    selected.length > 0 ? h('div', { style: { ...styles.card, marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('span', null, '已选 ' + selected.length + ' 条'),
      h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void bulkRun('approve') }, '批量批准'),
      h('button', { type: 'button', style: styles.danger, className: 'kh-danger', disabled: busy !== null, onClick: () => void bulkRun('reject') }, '批量拒绝'),
      h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: clearSelection }, '清空选择'),
      h('span', { style: styles.hint }, '单次最多 ' + LIMIT + ' 条，执行前会二次确认'),
    ) : null,
    busy !== null ? h('div', { style: styles.hint }, busy + '…') : null,
    error !== null ? h('div', { style: styles.error }, error) : null,
    notice !== '' ? h('div', { style: styles.success }, notice) : null,
    queue === null ? h('div', { style: styles.empty }, loading ? '正在读取待审核数据…' : '暂无数据') : h('div', null,
      sectionHead('候选知识', counts.proposals, 'proposal', queue.proposals ?? []),
      (queue.proposals ?? []).length === 0 ? h('div', { style: styles.empty }, '没有符合条件的候选。Agent 或面板提交的知识会先进入这里。') : (queue.proposals ?? []).map(proposalCard),
      sectionHead('版本冲突', counts.conflicts),
      (queue.conflicts ?? []).length === 0 ? h('div', { style: styles.empty }, '没有待处理冲突。') : (queue.conflicts ?? []).map((item: any) => h('div', { key: item.id, style: styles.card },
        h('div', { style: styles.cardTitle }, '冲突：' + (item.proposedTitle ?? item.docId), h(Badge, { text: '待处理', style: styles.badgeAmber })),
        h('div', { style: styles.meta },
          h('span', null, '知识库：' + (item.kbName ?? item.kbId)),
          h('span', null, '来源：' + (item.source ?? '—')),
          h('span', null, '基础版本：第 ' + item.baseVersion + ' 版 / 当前：第 ' + item.currentVersion + ' 版'),
          h('span', null, '检测于 ' + new Date(item.detectedAt).toLocaleString('zh-CN')),
        ),
        h('div', { style: styles.snippet }, '提议内容：'),
        h('pre', { style: styles.pre }, String(item.proposedBody ?? '').slice(0, 1600)),
        h('div', { style: styles.row, marginTop: '8px' },
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => void openDiff('conflict', item.id) }, '查看差异'),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void run('保留当前', () => request('/review/conflicts/' + item.id + '/resolve', { method: 'POST', body: { mode: 'keep_current' } })) }, '保留当前知识'),
          h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void run('采用新提议', () => request('/review/conflicts/' + item.id + '/resolve', { method: 'POST', body: { mode: 'use_proposed' } })) }, '采用新提议（追加合并版本）'),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => setConflictEdit({ id: item.id, title: String(item.proposedTitle ?? ''), body: String(item.proposedBody ?? '') }) }, '人工合并…'),
        ),
        conflictEdit !== null && conflictEdit.id === item.id ? h('div', { style: styles.field, marginTop: '10px' },
          h('label', { style: styles.label }, '合并后标题'),
          h('input', { style: styles.input, value: conflictEdit.title, onChange: (e: any) => setConflictEdit({ ...conflictEdit, title: e.target.value }) }),
          h('label', { style: { ...styles.label, marginTop: '8px' } }, '合并后正文（预填新提议，可自由编辑）'),
          h('textarea', { style: { ...styles.textarea, minHeight: '180px' }, value: conflictEdit.body, onChange: (e: any) => setConflictEdit({ ...conflictEdit, body: e.target.value }) }),
          h('div', { style: styles.row },
            h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void run('保存人工合并', () => request('/review/conflicts/' + item.id + '/resolve', { method: 'POST', body: { mode: 'merge', title: conflictEdit.title, body: conflictEdit.body } }), () => setConflictEdit(null)) }, '保存合并结果'),
            h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setConflictEdit(null) }, '取消合并'),
          ),
        ) : null,
      )),
      sectionHead('待审核草稿', counts.drafts, 'doc', queue.drafts ?? []),
      (queue.drafts ?? []).length === 0 ? h('div', { style: styles.empty }, '没有符合条件的待审核草稿。') : (queue.drafts ?? []).map((item: any) => h('div', { key: item.id, style: styles.card },
        h('div', { style: styles.cardTitle }, checkBox('doc:' + item.id), item.title,
          h(Badge, { text: KIND_LABEL[item.kind] ?? item.kind }),
          h(Badge, { text: VERIFY_LABEL[item.verifyState] ?? item.verifyState }),
          h(Badge, { text: '第 ' + item.currentVersion + ' 版' }),
        ),
        h('div', { style: styles.meta },
          h('span', null, '知识库：' + (item.kbName ?? item.kbId)),
          h('span', null, '更新于 ' + new Date(item.updatedAt).toLocaleString('zh-CN')),
          h('span', null, item.path),
        ),
        h('div', { style: { ...styles.row, marginTop: '8px' } }, h('div', { style: styles.field, flex: '1 1 260px' }, noteInput(item.id))),
        h('div', { style: styles.row },
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void openDiff('document', item.id) }, '查看详情与差异'),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => void openVersions(item.kbId, item.id) }, '版本历史'),
          h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void run('批准草稿', () => request('/kb/' + item.kbId + '/docs/' + item.id + '/review', { method: 'POST', body: { action: 'approve', note: noteOf(item.id) || null } })) }, '批准'),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void openDraftEdit(item.kbId, item.id) }, '编辑后批准'),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void run('标记过时', () => request('/kb/' + item.kbId + '/docs/' + item.id + '/review', { method: 'POST', body: { action: 'mark_stale', note: noteOf(item.id) || null } })) }, '标记过时'),
          h('button', { type: 'button', style: styles.danger, className: 'kh-danger', disabled: busy !== null, onClick: () => void run('拒绝草稿', () => request('/kb/' + item.kbId + '/docs/' + item.id + '/review', { method: 'POST', body: { action: 'reject', note: noteOf(item.id) || null } })) }, '拒绝（归档）'),
        ),
      )),
      sectionHead('过时知识', counts.stale),
      (queue.staleDocuments ?? []).length === 0 ? h('div', { style: styles.empty }, '没有符合条件的过时知识。') : (queue.staleDocuments ?? []).map((item: any) => h('div', { key: item.id, style: styles.card },
        h('div', { style: styles.cardTitle }, item.title, h(Badge, { text: '过时', style: styles.badgeAmber })),
        h('div', { style: styles.meta }, h('span', null, '知识库：' + (item.kbName ?? item.kbId)), h('span', null, '更新于 ' + new Date(item.updatedAt).toLocaleString('zh-CN'))),
        h('div', { style: styles.row, marginTop: '8px' },
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void openDiff('document', item.id) }, '查看详情与差异'),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => void openVersions(item.kbId, item.id) }, '版本历史'),
          h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void run('恢复为已批准', () => request('/kb/' + item.kbId + '/docs/' + item.id + '/review', { method: 'POST', body: { action: 'approve', note: '确认内容仍有效' } })) }, '确认仍有效（恢复已批准）'),
        ),
      )),
      maxPages > 1 ? h('div', { style: { ...styles.row, marginTop: '10px' } },
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: loading || page <= 1, onClick: () => setPage(page - 1) }, '上一页'),
        h('span', { style: styles.hint }, '第 ' + page + ' / ' + maxPages + ' 页'),
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: loading || page >= maxPages, onClick: () => setPage(page + 1) }, '下一页'),
      ) : null,
    ),
    draftEdit !== null ? h('div', { style: styles.divider },
      h('div', { style: styles.sectionTitle }, '编辑后批准草稿（将在第 ' + Number(draftEdit.version ?? 0) + ' 版基础上生成审核版本）'),
      h('label', { style: styles.label }, '标题'),
      h('input', { style: styles.input, value: draftEdit.title, onChange: (e: any) => setDraftEdit({ ...draftEdit, title: e.target.value }) }),
      h('label', { style: { ...styles.label, marginTop: '8px' } }, '正文（Markdown）'),
      h('textarea', { style: { ...styles.textarea, minHeight: '220px' }, value: draftEdit.body, onChange: (e: any) => setDraftEdit({ ...draftEdit, body: e.target.value }) }),
      h('div', { style: styles.row, marginTop: '8px' },
        h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== null, onClick: () => void run('编辑并批准草稿', () => request('/kb/' + draftEdit.kbId + '/docs/' + draftEdit.docId + '/review', { method: 'POST', body: { action: 'approve', title: draftEdit.title, body: draftEdit.body, note: '审核时编辑后批准' } }), () => setDraftEdit(null)) }, '保存并批准'),
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setDraftEdit(null) }, '取消'),
      ),
    ) : null,
    docPanel !== null ? h('div', { style: styles.divider }, h('div', { style: styles.sectionTitle }, '版本历史（共 ' + docPanel.versions.length + ' 版，当前第 ' + docPanel.currentVersion + ' 版）'),
      docPanel.versions.map((item: any) => h('div', { key: item.version, style: styles.card },
        h('div', { style: styles.cardTitle }, '第 ' + item.version + ' 版', h(Badge, { text: CHANGE_KIND_LABEL[item.changeKind] ?? item.changeKind }), item.version === docPanel.currentVersion ? h(Badge, { text: '当前', style: styles.badgeGreen }) : null),
        h('div', { style: styles.meta },
          h('span', null, '来源：' + (item.source ?? '—')),
          h('span', null, '操作人：' + (item.actor ?? '—')),
          h('span', null, '时间：' + new Date(item.createdAt).toLocaleString('zh-CN')),
        ),
        item.reason ? h('div', { style: styles.snippet }, '说明：' + item.reason) : null,
        h('div', { style: styles.row, marginTop: '8px' },
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: async () => {
            setError(null)
            try {
              const value = await request('/kb/' + encodeURIComponent(docPanel.kbId) + '/docs/' + encodeURIComponent(docPanel.docId) + '/versions/' + item.version)
              setDocVersion(value.version)
            } catch (failure: any) { setError(message(failure)) }
          } }, '查看内容'),
          item.version === docPanel.currentVersion ? null : h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== null, onClick: () => void run('恢复版本', () => request('/kb/' + docPanel.kbId + '/docs/' + docPanel.docId + '/restore', { method: 'POST', body: { version: item.version, note: '从版本历史恢复' } })) }, '恢复此版本'),
        ),
        docVersion !== null && docVersion.version === item.version ? h('pre', { style: { ...styles.pre, marginTop: '8px' } }, docVersion.content) : null,
      )),
      h('div', { style: styles.row, marginTop: '8px' }, h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => { setDocPanel(null); setDocVersion(null) } }, '收起版本历史')),
    ) : null,
    reviewLog !== null ? h('div', { style: styles.divider }, h('div', { style: styles.sectionTitle }, '审核日志（最近 ' + reviewLog.length + ' 条）'),
      reviewLog.length === 0 ? h('div', { style: styles.empty }, '暂无审核记录') : h('div', { style: styles.logs }, reviewLog.map((entry: any) => h('div', { key: entry.id },
        '[' + new Date(entry.at).toLocaleString('zh-CN') + '] ' + entry.action + ' · ' + entry.itemKind + ' ' + String(entry.itemId).slice(-8) + (entry.actor ? ' · ' + entry.actor : '') + (entry.note ? ' · ' + entry.note : ''),
      ))),
      h('div', { style: styles.row, marginTop: '8px' }, h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setReviewLog(null) }, '收起日志')),
    ) : null,
    h('div', { style: styles.hint }, '规则：Agent 自动提炼与面板提交的知识一律先进入待审核；未批准内容不会作为权威结论注入上下文。批准、拒绝、编辑、恢复都会写入审核日志与版本历史。审核人默认取设置中的「审核人名称」，自动批准只对满足规则的低风险 Wiki 更新生效且会写入日志。'),
  )
}

// ---------- 面板 ----------


function formatTime(value: number | string | null): string {
  if (value === null || value === undefined || value === '') return '—'
  const time = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(time)) return String(value)
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  return (value / 1024 / 1024).toFixed(1) + ' MB'
}

function Loading(props: any): any {
  return h('div', { style: styles.empty }, props.text ?? '加载中…')
}

function EmptyState(props: any): any {
  return h('div', { style: styles.empty }, props.text ?? '暂无数据')
}

function ErrorBox(props: any): any {
  return h('div', { style: styles.error }, props.text)
}

/** M5 总览：知识库/知识/审核/任务/最近活动一屏可见，点击可直接跳到对应页签。 */
function OverviewView(props: any): any {
  const [value, setValue] = R.useState(null)
  const [error, setError] = R.useState(null)
  const [loading, setLoading] = R.useState(false)
  const load = () => {
    setLoading(true); setError(null)
    request('/overview').then((data: any) => { setValue(data) }).catch((failure: any) => { setError(message(failure)) }).then(() => setLoading(false))
  }
  R.useEffect(() => { load() }, [])
  if (error !== null) return h('div', null, ErrorBox({ text: error }), h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: load }, '重试'))
  if (value === null) return Loading({ text: loading ? '正在统计当前工作区的知识情况…' : '加载中…' })
  const counts = value.counts ?? {}
  const docs = value.documents ?? {}
  const review = value.review ?? {}
  const statCard = (label: string, value2: any, hint: string, onClick?: any) => h('div', { key: label, style: { ...styles.card, flex: '1 1 150px', minWidth: '150px', cursor: onClick ? 'pointer' : 'default' }, onClick },
    h('div', { style: { fontSize: '22px', fontWeight: 600 } }, String(value2)),
    h('div', { style: { fontSize: '12px', opacity: 0.75, marginTop: '4px' } }, label),
    hint ? h('div', { style: { fontSize: '11px', opacity: 0.5, marginTop: '4px' } }, hint) : null,
  )
  return h('div', null,
    h('div', { style: styles.row, marginBottom: '10px' },
      statCard('知识库', counts.knowledgeBases, '用户级 ' + (counts.userKbs ?? 0) + ' / 工作区级 ' + (counts.workspaceKbs ?? 0), () => props.onNavigate && props.onNavigate('kb')),
      statCard('已批准知识', docs.approved, '草稿 ' + (docs.draft ?? 0) + ' / 过时 ' + (docs.stale ?? 0), () => props.onNavigate && props.onNavigate('memory')),
      statCard('待审核', value.pendingTotal, '候选 ' + (review.proposals ?? 0) + ' / 冲突 ' + (review.conflicts ?? 0) + ' / 草稿 ' + (review.drafts ?? 0), () => props.onNavigate && props.onNavigate('review')),
      statCard('正在执行任务', (value.runningTasks ?? []).length, '初始化与增量更新'),
    ),
    h('div', { style: styles.hint }, '当前工作区：' + (value.workspacePath ?? '未识别') + '（' + (value.workspaceId ?? '无') + '） · 存储：' + value.storageRoot + ' · schema v' + value.schemaVersion),
    h('div', { style: styles.sectionTitle }, '知识类型分布'),
    (docs.byKind ?? []).length === 0 ? EmptyState({ text: '还没有知识条目' }) : h('div', { style: styles.row }, (docs.byKind ?? []).map((item: any) => h('span', { key: item.kind, style: styles.badgeBlue }, (KIND_LABEL[item.kind] ?? item.kind) + ' ' + item.count))),
    h('div', { style: styles.sectionTitle }, '最近更新的知识'),
    (value.recentDocs ?? []).length === 0 ? EmptyState({ text: '暂无知识' }) : (value.recentDocs ?? []).map((doc: any) => h('div', { key: doc.id, style: styles.card },
      h('div', { style: styles.cardTitle }, doc.title, h('span', { style: doc.status === 'approved' ? styles.badgeGreen : styles.badgeAmber }, DOC_STATUS_LABEL[doc.status] ?? doc.status), h('span', { style: styles.badge }, KIND_LABEL[doc.kind] ?? doc.kind)),
      h('div', { style: styles.meta }, h('span', null, doc.kbName), h('span', null, '更新于 ' + formatTime(doc.updatedAt))),
    )),
    h('div', { style: styles.sectionTitle }, '正在执行的任务'),
    (value.runningTasks ?? []).length === 0 ? EmptyState({ text: '当前没有正在执行的任务' }) : (value.runningTasks ?? []).map((task: any) => h('div', { key: task.id, style: styles.card },
      h('div', { style: styles.cardTitle }, (TASK_KIND_LABEL[task.kind] ?? task.kind) + ' · ' + (TASK_STATUS_LABEL[task.status] ?? task.status), h('span', { style: styles.badge }, String(task.progress ?? 0) + '%')),
      h('div', { style: styles.progressTrack }, h('div', { style: { ...styles.progressBar, width: String(task.progress ?? 0) + '%' } })),
      h('div', { style: styles.meta }, h('span', null, '阶段：' + (task.stage ?? '—')), h('span', null, '开始于 ' + formatTime(task.createdAt))),
    )),
    h('div', { style: styles.sectionTitle }, '最近操作日志'),
    (value.recentActivity ?? []).length === 0 ? EmptyState({ text: '暂无操作记录' }) : h('pre', { style: styles.pre }, (value.recentActivity ?? []).map((entry: any) => formatTime(entry.at) + '  ' + entry.action + '  ' + (entry.actor ?? '系统') + (entry.note ? '  ' + entry.note : '')).join('\n')),
    h('div', { style: styles.hint }, value.note ?? ''),
  )
}

// ---------- Markdown 渲染（零第三方依赖，供知识正文与候选正文使用） ----------

/** 内联语法：`code`、**粗体**、*斜体*、~~删除线~~、[文字](链接)。 */
const MD_INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~]+~~|\[[^\]\n]+\]\([^)\s]+\))/g

function mdInline(text: string, keyPrefix: string): any[] {
  const nodes: any[] = []
  let cursor = 0
  let index = 0
  const pushText = (value: string) => { if (value !== '') nodes.push(value) }
  const pattern = new RegExp(MD_INLINE_PATTERN.source, 'g')
  let match: RegExpExecArray | null = pattern.exec(text)
  while (match !== null) {
    pushText(text.slice(cursor, match.index))
    const token = match[0]
    const key = keyPrefix + '-i' + index
    index += 1
    if (token.startsWith('`')) {
      nodes.push(h('code', { key, style: styles.mdInlineCode }, token.slice(1, -1)))
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(h('strong', { key }, mdInline(token.slice(2, -2), key)))
    } else if (token.startsWith('~~')) {
      nodes.push(h('del', { key, style: styles.mdDel }, mdInline(token.slice(2, -2), key)))
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (link === null) pushText(token)
      else nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener', style: styles.mdLink }, link[1]))
    } else {
      nodes.push(h('em', { key }, mdInline(token.slice(1, -1), key)))
    }
    cursor = match.index + token.length
    match = pattern.exec(text)
  }
  pushText(text.slice(cursor))
  return nodes
}

const MD_LIST_ITEM = /^([-*+]|\d{1,3}[.)])\s+(.+)$/
const MD_TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/
const MD_FENCE = /^```([A-Za-z0-9_+-]*)\s*$/
const MD_FENCE_END = /^```\s*$/
const MD_HEADING = /^(#{1,6})\s+(.+)$/
const MD_HR = /^(-{3,}|\*{3,}|_{3,})$/
const MD_QUOTE = /^>\s?/

function mdCells(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return value.split('|').map((cell) => cell.trim())
}

/** 把 Markdown 文本渲染成 React 节点数组：标题、段落、列表、代码块、引用、表格、分隔线、内联样式。 */
function renderMarkdown(source: string, keyPrefix: string): any[] {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: any[] = []
  let paragraph: string[] = []
  const nextKey = (): string => keyPrefix + '-b' + blocks.length
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const key = nextKey()
    blocks.push(h('p', { key, style: styles.mdP }, mdInline(paragraph.join(' '), key)))
    paragraph = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (trimmed === '') { flushParagraph(); i += 1; continue }

    if (MD_FENCE.test(trimmed)) {
      flushParagraph()
      const code: string[] = []
      i += 1
      while (i < lines.length && !MD_FENCE_END.test((lines[i] ?? '').trim())) { code.push(lines[i] ?? ''); i += 1 }
      i += 1
      blocks.push(h('pre', { key: nextKey(), style: styles.mdCodeBlock }, h('code', null, code.join('\n'))))
      continue
    }

    const heading = MD_HEADING.exec(trimmed)
    if (heading !== null) {
      flushParagraph()
      const level = (heading[1] ?? '').length
      const headingText = heading[2] ?? ''
      const key = nextKey()
      if (level === 1) blocks.push(h('h2', { key, style: styles.mdH1 }, mdInline(headingText, key)))
      else if (level === 2) blocks.push(h('h3', { key, style: styles.mdH2 }, mdInline(headingText, key)))
      else blocks.push(h('h4', { key, style: styles.mdH3 }, mdInline(headingText, key)))
      i += 1
      continue
    }

    if (MD_HR.test(trimmed)) {
      flushParagraph()
      blocks.push(h('hr', { key: nextKey(), style: styles.mdHr }))
      i += 1
      continue
    }

    if (MD_QUOTE.test(trimmed)) {
      flushParagraph()
      const quote: string[] = []
      while (i < lines.length && MD_QUOTE.test((lines[i] ?? '').trim())) {
        quote.push((lines[i] ?? '').trim().replace(MD_QUOTE, ''))
        i += 1
      }
      const key = nextKey()
      blocks.push(h('blockquote', { key, style: styles.mdQuote }, ...renderMarkdown(quote.join('\n'), key)))
      continue
    }

    if (trimmed.includes('|') && i + 1 < lines.length && MD_TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      flushParagraph()
      const header = mdCells(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(mdCells(lines[i] ?? ''))
        i += 1
      }
      const key = nextKey()
      blocks.push(h('div', { key, style: styles.mdTableWrap },
        h('table', { style: styles.mdTable },
          h('thead', null, h('tr', null, header.map((cell, ci) => h('th', { key: 'h' + ci, style: styles.mdTh }, mdInline(cell, key + '-h' + ci))))),
          h('tbody', null, rows.map((row, ri) => h('tr', { key: 'r' + ri },
            header.map((_: string, ci: number) => h('td', { key: 'c' + ci, style: styles.mdTd }, mdInline(row[ci] ?? '', key + '-r' + ri + 'c' + ci))),
          ))),
        ),
      ))
      continue
    }

    const listItem = MD_LIST_ITEM.exec(trimmed)
    if (listItem !== null) {
      flushParagraph()
      const ordered = /\d/.test(listItem[1] ?? '')
      const items: string[] = []
      while (i < lines.length) {
        const hit = MD_LIST_ITEM.exec((lines[i] ?? '').trim())
        if (hit === null || /\d/.test(hit[1] ?? '') !== ordered) break
        items.push(hit[2] ?? '')
        i += 1
      }
      const key = nextKey()
      const children = items.map((text, index) => h('li', { key: key + '-li' + index, style: styles.mdLi }, mdInline(text, key + '-li' + index)))
      blocks.push(ordered ? h('ol', { key, style: styles.mdList }, children) : h('ul', { key, style: styles.mdList }, children))
      continue
    }

    paragraph.push(trimmed)
    i += 1
  }
  flushParagraph()
  return blocks
}
/** M5 知识浏览（Repo Wiki / 长期记忆共用）：筛选、分页、查看正文与来源、编辑、标记过时、版本历史。 */
const MODE_CONFIG: Record<string, any> = {
  wiki: { label: 'Repo Wiki', kinds: ['wiki'], showKinds: false, placeholder: '搜索 Repo Wiki 标题与正文' },
  cards: { label: '知识卡片', kinds: ['decision', 'convention', 'issue', 'todo'], showKinds: true, placeholder: '搜索知识卡片' },
  memory: { label: '长期记忆', kinds: ['memory', 'preference'], showKinds: true, placeholder: '搜索记忆' },
}

/** Qoder 式两栏知识浏览：左窄栏列表 + 右阅读器（正文 / 来源 / 版本）。 */
function DocsExplorer(props: any): any {
  const mode = String(props.mode ?? 'wiki')
  const conf = MODE_CONFIG[mode] ?? MODE_CONFIG.wiki
  const [query, setQuery] = R.useState('')
  const [status, setStatus] = R.useState('')
  const [kind, setKind] = R.useState('')
  const [data, setData] = R.useState(null)
  const [loading, setLoading] = R.useState(false)
  const [error, setError] = R.useState(null)
  const [notice, setNotice] = R.useState('')
  const [selectedId, setSelectedId] = R.useState('')
  const [detail, setDetail] = R.useState(null)
  const [detailError, setDetailError] = R.useState(null)
  const [editing, setEditing] = R.useState(false)
  const [draftTitle, setDraftTitle] = R.useState('')
  const [draftBody, setDraftBody] = R.useState('')
  const [busy, setBusy] = R.useState(false)
  const [versionPane, setVersionPane] = R.useState(null)
  const [versionBusy, setVersionBusy] = R.useState(null)
  const [mdView, setMdView] = R.useState(true)
  const [loadingMore, setLoadingMore] = R.useState(false)
  const [feedbackBusy, setFeedbackBusy] = R.useState(false)
  const [feedbackReason, setFeedbackReason] = R.useState('')
  const [parentPick, setParentPick] = R.useState('')
  const PAGE_SIZE = 50

  // 类型与状态都在宿主侧筛选（支持逗号多值），这样总数统计与分页都是真实的。
  const buildQuery = (searchText: string, pageNumber: number): string => {
    const parts: string[] = ['limit=' + PAGE_SIZE, 'page=' + pageNumber]
    const q = searchText.trim()
    if (q !== '') parts.push('q=' + encodeURIComponent(q))
    const kinds = kind === '' ? conf.kinds : [kind]
    parts.push('kind=' + encodeURIComponent(kinds.join(',')))
    parts.push('status=' + encodeURIComponent(status === '' ? 'draft,approved,stale' : status))
    return parts.join('&')
  }
  const fetchList = async (searchText?: string) => {
    setLoading(true); setError(null)
    try {
      const q = String(searchText ?? query)
      setData(await request('/documents?' + buildQuery(q, 1)))
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }
  const loadMore = async () => {
    if (data === null) return
    setLoadingMore(true); setError(null)
    try {
      const shown = (data.documents ?? []).length
      const next = await request('/documents?' + buildQuery(String(query), Math.floor(shown / PAGE_SIZE) + 1))
      setData({ ...next, documents: (data.documents ?? []).concat(next.documents ?? []) })
    } catch (failure: any) {
      setError(message(failure))
    } finally {
      setLoadingMore(false)
    }
  }
  R.useEffect(() => { void fetchList('') }, [mode, status, kind])

  const openDetail = async (doc: any) => {
    setSelectedId(doc.id); setDetail(null); setDetailError(null); setEditing(false); setVersionPane(null)
    setDraftTitle(doc.title ?? ''); setDraftBody('')
    try {
      const value = await request('/kb/' + encodeURIComponent(doc.kbId) + '/docs/' + encodeURIComponent(doc.id))
      setDetail(value)
      setDraftTitle(value.document?.title ?? '')
      setDraftBody(value.document?.body ?? '')
    } catch (failure: any) {
      setDetailError(message(failure))
    }
  }
  const saveEdit = async () => {
    if (detail === null) return
    setBusy(true); setDetailError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(detail.document.kbId) + '/docs/' + encodeURIComponent(detail.document.id), {
        method: 'PATCH', body: { title: draftTitle, body: draftBody, note: '面板人工编辑' },
      })
      setNotice('已保存修改并记录新版本')
      setEditing(false)
      if (value.document) await openDetail(value.document)
      await fetchList()
    } catch (failure: any) {
      setDetailError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  const markStale = async () => {
    if (detail === null) return
    if (!window.confirm('确认把这条知识标记为过时？标记后仍保留正文与历史版本，可在审核里恢复。')) return
    setBusy(true); setDetailError(null)
    try {
      await request('/kb/' + encodeURIComponent(detail.document.kbId) + '/docs/' + encodeURIComponent(detail.document.id) + '/review', {
        method: 'POST', body: { action: 'mark_stale', note: '面板标记过时' },
      })
      setNotice('已标记为过时')
      setDetail(null); setSelectedId('')
      await fetchList()
    } catch (failure: any) {
      setDetailError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const docBasePath = (): string => (detail !== null && detail.document
    ? '/kb/' + encodeURIComponent(detail.document.kbId) + '/docs/' + encodeURIComponent(detail.document.id)
    : '')
  const viewVersion = async (version: number) => {
    if (docBasePath() === '') return
    setDetailError(null); setVersionBusy('查看第 ' + version + ' 版…')
    try {
      const value = await request(docBasePath() + '/versions/' + version)
      setVersionPane({ version, content: String(value.version?.content ?? ''), changeKind: value.version?.changeKind, source: value.version?.source })
    } catch (failure: any) { setDetailError(message(failure)) } finally { setVersionBusy(null) }
  }
  const diffVersion = async (version: number) => {
    if (docBasePath() === '') return
    const current = Number(detail.document.currentVersion ?? version)
    const from = version >= current ? Math.max(1, current - 1) : version
    setDetailError(null); setVersionBusy('对比第 ' + version + ' 版与当前版本…')
    try {
      const value = await request(docBasePath() + '/diff?from=' + from + '&to=' + current)
      setVersionPane({ version, diff: value, from, to: current })
    } catch (failure: any) { setDetailError(message(failure)) } finally { setVersionBusy(null) }
  }
  const restoreVersion = async (version: number) => {
    if (docBasePath() === '') return
    if (!window.confirm('确认恢复为第 ' + version + ' 版内容？恢复会以新版本方式记录，不会静默覆盖当前内容。')) return
    setDetailError(null); setVersionBusy('恢复第 ' + version + ' 版…')
    try {
      const value = await request(docBasePath() + '/restore', { method: 'POST', body: { version, actor: 'web面板', note: '从版本历史恢复' } })
      setNotice(value.message ?? '已恢复该版本（以新版本方式记录）')
      setVersionPane(null)
      if (value.document) await openDetail(value.document)
      await fetchList()
    } catch (failure: any) { setDetailError(message(failure)) } finally { setVersionBusy(null) }
  }

  const rows: any[] = data?.documents ?? []
  const groups: Array<{ name: string; items: any[] }> = []
  for (const doc of rows) {
    const name = String(doc.kbName ?? '未命名知识库')
    const group = groups.find((item) => item.name === name)
    if (group) group.items.push(doc)
    else groups.push({ name, items: [doc] })
  }
  // 父级知识：同一知识库内按 parentId 排成层级，父级不在当前筛选结果里时按顶层显示。
  const buildTree = (items: any[]): Array<{ doc: any; depth: number }> => {
    const byId = new Map<string, any>()
    for (const doc of items) byId.set(String(doc.id), doc)
    const childrenOf = new Map<string, any[]>()
    const roots: any[] = []
    for (const doc of items) {
      const parentId = doc.parentId ? String(doc.parentId) : ''
      if (parentId !== '' && byId.has(parentId) && parentId !== String(doc.id)) {
        const list = childrenOf.get(parentId) ?? []
        list.push(doc); childrenOf.set(parentId, list)
      } else roots.push(doc)
    }
    const out: Array<{ doc: any; depth: number }> = []
    const seen = new Set<string>()
    const walk = (doc: any, depth: number) => {
      const id = String(doc.id)
      if (seen.has(id)) return
      seen.add(id)
      out.push({ doc, depth })
      for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1)
    }
    for (const root of roots) walk(root, 0)
    return out
  }
  const totalCount = Number(data?.total ?? rows.length)
  const openById = (id: string) => {
    const hit = rows.find((doc: any) => String(doc.id) === id)
    if (hit) void openDetail(hit)
  }
  const sendFeedback = async (helpful: boolean) => {
    if (detail === null || detail.document === undefined) return
    setFeedbackBusy(true); setDetailError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(detail.document.kbId) + '/docs/' + encodeURIComponent(detail.document.id) + '/feedback', {
        method: 'POST', body: { helpful, reason: feedbackReason.trim() === '' ? null : feedbackReason.trim(), actor: 'web面板' },
      })
      setNotice(value.message ?? '已记录反馈')
      setFeedbackReason('')
      await openDetail(detail.document)
    } catch (failure: any) {
      setDetailError(message(failure))
    } finally {
      setFeedbackBusy(false)
    }
  }
  const setParent = async (parentId: string) => {
    if (detail === null || detail.document === undefined) return
    setBusy(true); setDetailError(null)
    try {
      const value = await request('/kb/' + encodeURIComponent(detail.document.kbId) + '/docs/' + encodeURIComponent(detail.document.id) + '/parent', {
        method: 'POST', body: { parentId: parentId === '' ? null : parentId },
      })
      setNotice(value.message ?? '已更新上级知识')
      setParentPick('')
      await openDetail(value.document ?? detail.document)
      await fetchList()
    } catch (failure: any) {
      setDetailError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  const statusChips: Array<[string, string]> = [['', '全部'], ['approved', '已批准'], ['draft', '待审核'], ['stale', '已过时']]
  const kindChips: Array<[string, string]> = conf.showKinds
    ? [['', '全部类型'] as [string, string]].concat(conf.kinds.map((value: string) => [value, KIND_LABEL[value] ?? value] as [string, string]))
    : []

  return h('div', { style: styles.split },
    h('div', { style: styles.listCol },
      h('div', { style: styles.listHead },
        h('input', {
          style: { ...styles.input, flex: 1, height: '30px' },
          placeholder: conf.placeholder,
          value: query,
          onChange: (event: any) => setQuery(event.target.value),
          onKeyDown: (event: any) => { if (event.key === 'Enter') void fetchList() },
        }),
        h('button', { type: 'button', style: styles.iconBtn, className: 'kh-hover', title: '刷新', onClick: () => void fetchList() }, '⟳'),
      ),
      h('div', { style: styles.chipRow }, statusChips.map(([value, label]) => h('button', {
        key: 'status-' + value, type: 'button', style: status === value ? styles.chipActive : styles.chip,
        onClick: () => setStatus(value),
      }, label))),
      conf.showKinds ? h('div', { style: styles.chipRow }, kindChips.map(([value, label]) => h('button', {
        key: 'kind-' + value, type: 'button', style: kind === value ? styles.chipActive : styles.chip,
        onClick: () => setKind(value),
      }, label))) : null,
      error !== null ? h('div', { style: { ...styles.error, margin: '4px 8px 8px' } }, error) : null,
      h('div', { style: { ...styles.hint, padding: '0 12px 8px' } },
        '共 ' + totalCount + ' 条，已显示 ' + rows.length + ' 条' + (totalCount > rows.length ? '（每页 ' + PAGE_SIZE + ' 条）' : '')),
      h('div', { style: styles.listScroll, className: 'kh-scroll' },
        loading && data === null ? h('div', { style: styles.listEmpty }, '正在读取知识…') : null,
        data !== null && rows.length === 0
          ? h('div', { style: styles.listEmpty }, mode === 'memory'
            ? '还没有沉淀的长期记忆。任务结束后可通过知识工具或审核队列沉淀，批准后出现在这里。'
            : '还没有知识条目。先在「知识库」里创建一个库并点「开始初始化」。')
          : null,
        groups.map((group) => h('div', { key: group.name },
          h('div', { style: styles.treeGroup }, group.name),
          buildTree(group.items).map((entry: any) => h('button', {
            key: entry.doc.id, type: 'button',
            style: {
              ...(selectedId === entry.doc.id ? styles.treeRowActive : styles.treeRow),
              paddingLeft: (8 + entry.depth * 16) + 'px',
            },
            onClick: () => void openDetail(entry.doc),
          },
            h('span', { style: styles.treeTitle },
              h('span', { style: styles.treeName }, (entry.depth > 0 ? '└ ' : '') + entry.doc.title),
              h('span', { style: styles.treeMeta },
                (KIND_LABEL[entry.doc.kind] ?? entry.doc.kind) + ' · ' + (DOC_STATUS_LABEL[entry.doc.status] ?? entry.doc.status) + ' · ' + formatTime(entry.doc.updatedAt)),
            ),
          )),
        )),
        totalCount > rows.length
          ? h('div', { style: { padding: '10px 8px' } },
            h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: loadingMore, onClick: () => void loadMore() },
              loadingMore ? '加载中…' : '加载更多（还剩 ' + (totalCount - rows.length) + ' 条）'))
          : null,
      ),
    ),
    h('div', { style: styles.readerCol },
      h('div', { style: styles.readerHead },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h2', { style: styles.readerTitle }, detail !== null && detail.document ? detail.document.title : '选择左侧一条知识'),
          detail !== null && detail.document
            ? h('div', { style: styles.readerMeta },
              h(Badge, { text: KIND_LABEL[detail.document.kind] ?? detail.document.kind }),
              h(Badge, {
                text: DOC_STATUS_LABEL[detail.document.status] ?? detail.document.status,
                style: detail.document.status === 'approved' ? styles.badgeGreen : styles.badgeAmber,
              }),
              h(Badge, { text: '验证：' + (VERIFY_LABEL[detail.document.verifyState] ?? detail.document.verifyState) }),
              h('span', null, 'v' + detail.document.currentVersion),
              h('span', null, '更新于 ' + formatTime(detail.document.updatedAt)),
            )
            : h('div', { style: styles.readerMeta }, '从左侧列表选择一条知识，右侧显示正文、来源与版本历史。'),
        ),
        detail !== null
          ? h('div', { style: styles.headerActions },
            detail !== null && detail.document ? h('div', { style: styles.segGroup },
              h('button', { type: 'button', style: mdView ? styles.segActive : styles.seg, onClick: () => setMdView(true) }, '渲染'),
              h('button', { type: 'button', style: mdView ? styles.seg : styles.segActive, onClick: () => setMdView(false) }, '源码'),
            ) : null,
            h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setEditing(!editing) }, editing ? '取消编辑' : '编辑'),
            h('button', { type: 'button', style: { ...styles.primary, ...(busy || !editing ? styles.buttonDisabled : {}) }, className: 'kh-primary', disabled: busy || !editing, onClick: () => void saveEdit() }, busy ? '保存中…' : '保存修改'),
            h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => { if (detail !== null && detail.document) downloadFile('/kb/' + encodeURIComponent(detail.document.kbId) + '/docs/' + encodeURIComponent(detail.document.id) + '/export') } }, '导出 Markdown'),
            h('button', { type: 'button', style: { ...styles.danger, ...(busy ? styles.buttonDisabled : {}) }, className: 'kh-danger', disabled: busy, onClick: () => void markStale() }, '标记过时'),
          )
          : null,
      ),
      h('div', { style: styles.readerScroll, className: 'kh-scroll' },
        h('div', { style: styles.readerInner },
          notice !== '' ? h('div', { style: styles.success }, notice) : null,
          detailError !== null ? ErrorBox({ text: detailError }) : null,
          detail === null
            ? (selectedId === '' ? EmptyState({ text: '从左侧选择一条知识查看正文。' }) : null)
            : h('div', null,
              editing
                ? h('div', null,
                  h('div', { style: styles.field }, h('label', { style: styles.label }, '标题'), h('input', { style: styles.input, value: draftTitle, onChange: (event: any) => setDraftTitle(event.target.value) })),
                  h('div', { style: styles.field }, h('label', { style: styles.label }, '正文（Markdown）'), h('textarea', { style: { ...styles.textarea, minHeight: '260px' }, value: draftBody, onChange: (event: any) => setDraftBody(event.target.value) })),
                )
                : mdView
                  ? h('div', { style: styles.mdBody }, renderMarkdown(String(detail.document.body ?? ''), 'md-' + detail.document.id))
                  : h('div', { style: styles.docBody }, String(detail.document.body ?? '')),
              h('div', { style: styles.divider }),
              h('div', { style: styles.sectionTitle }, '上级知识'),
              detail.document.parent
                ? h('div', { style: styles.meta },
                  h(Badge, { text: KIND_LABEL[detail.document.parent.kind] ?? detail.document.parent.kind }),
                  h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => openById(String(detail.document.parent.id)) }, '↑ ' + detail.document.parent.title))
                : h('div', { style: styles.hint }, '这条知识目前是顶层知识；可以指定同知识库里的另一条知识作为它的上级（最多 5 层）。'),
              (detail.children ?? []).length > 0
                ? h('div', { style: { ...styles.meta, flexWrap: 'wrap' } },
                  h('span', null, '下级知识（' + (detail.children ?? []).length + '）：'),
                  (detail.children ?? []).map((child: any) => h('button', {
                    key: child.id, type: 'button', style: styles.button, className: 'kh-hover',
                    onClick: () => openById(String(child.id)),
                  }, child.title + '（' + (DOC_STATUS_LABEL[child.status] ?? child.status) + '）')))
                : null,
              h('div', { style: { ...styles.row, marginTop: '8px' } },
                h('select', {
                  style: { ...styles.input, flex: 1, minWidth: '200px', height: '30px' },
                  value: parentPick,
                  onChange: (event: any) => setParentPick(event.target.value),
                },
                  h('option', { value: '' }, '— 选择上级知识（可为空）—'),
                  rows.filter((doc: any) => String(doc.kbId) === String(detail.document.kbId) && String(doc.id) !== String(detail.document.id))
                    .map((doc: any) => h('option', { key: doc.id, value: doc.id }, doc.title))),
                h('button', { type: 'button', style: { ...styles.button, ...(busy ? styles.buttonDisabled : {}) }, className: 'kh-hover', disabled: busy, onClick: () => void setParent(parentPick) }, '设为上级'),
                detail.document.parent
                  ? h('button', { type: 'button', style: { ...styles.danger, ...(busy ? styles.buttonDisabled : {}) }, className: 'kh-danger', disabled: busy, onClick: () => void setParent('') }, '取消上级')
                  : null,
              ),
              h('div', { style: styles.divider }),
              h('div', { style: styles.sectionTitle }, '是否有帮助'),
              h('div', { style: styles.meta },
                h('span', null, '有帮助 ' + Number(detail.feedback?.helpful ?? 0) + ' · 没帮上忙 ' + Number(detail.feedback?.notHelpful ?? 0) + ' · 共 ' + Number(detail.feedback?.total ?? 0) + ' 条反馈'),
                detail.feedback?.lastAt ? h('span', null, '最近反馈 ' + formatTime(detail.feedback.lastAt)) : null,
                detail.feedback?.lastReason ? h('span', { style: { wordBreak: 'break-all' } }, '最近理由：' + detail.feedback.lastReason) : null,
              ),
              h('div', { style: { ...styles.row, marginTop: '8px' } },
                h('input', {
                  style: { ...styles.input, flex: 1, minWidth: '220px', height: '30px' },
                  placeholder: '可选：填写原因（最多 500 字），帮助我们改进这条知识',
                  value: feedbackReason,
                  onChange: (event: any) => setFeedbackReason(event.target.value),
                }),
                h('button', { type: 'button', style: { ...styles.primary, ...(feedbackBusy ? styles.buttonDisabled : {}) }, className: 'kh-primary', disabled: feedbackBusy, onClick: () => void sendFeedback(true) }, '有帮助'),
                h('button', { type: 'button', style: { ...styles.button, ...(feedbackBusy ? styles.buttonDisabled : {}) }, className: 'kh-hover', disabled: feedbackBusy, onClick: () => void sendFeedback(false) }, '没帮上忙'),
              ),
              h('div', { style: styles.divider }),
              h('div', { style: styles.sectionTitle }, '来源（' + (detail.sources ?? []).length + '）'),
              (detail.sources ?? []).length === 0
                ? h('div', { style: styles.hint }, '该知识没有登记来源')
                : (detail.sources ?? []).map((source: any) => h('div', { key: source.id, style: { ...styles.meta, alignItems: 'center' } },
                  h(Badge, { text: source.kind }),
                  h('span', { style: { wordBreak: 'break-all' } }, source.ref),
                  source.locator ? h('span', null, source.locator) : null,
                  source.verified ? h(Badge, { text: '已验证', style: styles.badgeGreen }) : h(Badge, { text: '未验证', style: styles.badgeAmber }),
                )),
              h('div', { style: styles.sectionTitle }, '版本历史（' + (detail.versions ?? []).length + '）'),
              (detail.versions ?? []).map((version: any) => h('div', { key: version.version, style: { ...styles.card, padding: '8px 10px', marginBottom: '8px' } },
                h('div', { style: styles.meta },
                  h('span', null, 'v' + version.version),
                  h(Badge, { text: CHANGE_KIND_LABEL[version.changeKind] ?? version.changeKind }),
                  version.version === detail.document.currentVersion ? h(Badge, { text: '当前', style: styles.badgeGreen }) : null,
                  h('span', null, '来源 ' + version.source),
                  h('span', null, formatTime(version.createdAt)),
                ),
                h('div', { style: { ...styles.row, marginTop: '6px' } },
                  h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: versionBusy !== null, onClick: () => void viewVersion(version.version) }, '查看内容'),
                  h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: versionBusy !== null || (detail.versions ?? []).length < 2, onClick: () => void diffVersion(version.version) }, '与当前对比'),
                  version.version === detail.document.currentVersion ? null : h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: versionBusy !== null, onClick: () => void restoreVersion(version.version) }, '恢复此版本'),
                ),
              )),
              versionBusy !== null ? h('div', { style: styles.hint }, versionBusy) : null,
              versionPane !== null ? h('div', null,
                h('div', { style: styles.sectionTitle }, '第 ' + versionPane.version + ' 版' + (versionPane.diff ? ' 与当前版本差异' : ' 内容') + (versionPane.changeKind ? ' · ' + (CHANGE_KIND_LABEL[versionPane.changeKind] ?? versionPane.changeKind) : '')),
                versionPane.diff ? h(DiffView, { diff: versionPane.diff }) : h('pre', { style: styles.pre }, versionPane.content),
                h('div', { style: { ...styles.row, marginTop: '8px' } },
                  h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setVersionPane(null) }, '收起版本内容')),
              ) : null,
            ),
        ),
      ),
    ),
  )
}


/** 设置页通用勾选项：一个复选框 + 说明文字。 */
function settingsCheckbox(form: any, patch: (partial: any) => void, key: string, label: string, hintText: string): any {
  return h('label', { style: { ...styles.radio, marginBottom: '10px', display: 'flex', alignItems: 'flex-start', gap: '8px' } },
    h('input', { type: 'checkbox', checked: form[key] === true, onChange: (event: any) => patch({ [key]: event.target.checked }) }),
    h('span', null, label, h('div', { style: { fontSize: '11px', opacity: 0.55 } }, hintText)),
  )
}

/**
 * 知识注入设置卡：总开关、全局/项目记忆分开关、摘要字符数与标题数上限。
 * 数据本身来自 GET /settings 的 settings 字段，保存由父组件的 PATCH /settings 完成。
 */
function SettingsInjectionCard(props: any): any {
  const form = props.form ?? {}
  const patch = typeof props.patch === 'function' ? props.patch : () => {}
  const box = (key: string, label: string, hintText: string) => settingsCheckbox(form, patch, key, label, hintText)
  return h('div', { style: styles.card },
    h('div', { style: styles.cardTitle }, '知识注入', h('span', { style: form.injectEnabled === true ? styles.badgeGreen : styles.badgeAmber }, form.injectEnabled === true ? '已开启' : '已关闭')),
    h('div', { style: styles.hint, marginBottom: '10px' }, '每轮对话开始前，把「已批准知识」的标题级摘要注入系统提示，让模型知道有哪些长期知识可用；完整正文由检索工具按需读取。关闭后不再注入，检索工具仍然可用。'),
    box('injectEnabled', '开启知识注入', '关闭后系统提示里不再出现知识摘要，仅保留检索工具。'),
    box('injectIncludeUser', '注入全局记忆（用户级知识库）', '跨工作区共享的通用知识。'),
    box('injectIncludeWorkspace', '注入项目记忆（当前工作区知识库）', '只与当前工作区绑定的项目知识。'),
    h('div', { style: styles.row },
      h('div', { style: { ...styles.field, flex: '1 1 160px' } }, h('label', { style: styles.label }, '摘要最大字符数（300–4000）'), h('input', { type: 'number', style: styles.input, value: form.injectMaxChars ?? 900, onChange: (event: any) => patch({ injectMaxChars: event.target.value }) })),
      h('div', { style: { ...styles.field, flex: '1 1 160px' } }, h('label', { style: styles.label }, '最多列出标题数（1–20）'), h('input', { type: 'number', style: styles.input, value: form.injectMaxTitles ?? 6, onChange: (event: any) => patch({ injectMaxTitles: event.target.value }) })),
    ),
  )
}

/** M5 设置与诊断：默认策略、自动提炼、排除目录、存储位置、备份恢复、提炼记录、环境诊断。 */
function SettingsView(): any {
  const [snapshot, setSnapshot] = R.useState(null)
  const [form, setForm] = R.useState(null)
  const [backups, setBackups] = R.useState(null)
  const [stats, setStats] = R.useState(null)
  const [runs, setRuns] = R.useState([])
  const [error, setError] = R.useState(null)
  const [notice, setNotice] = R.useState('')
  const [busy, setBusy] = R.useState('')
  const [target, setTarget] = R.useState('')
  const [backupNote, setBackupNote] = R.useState('')
  const [preview, setPreview] = R.useState(null)

  const loadSettings = () => {
    request('/settings').then((value: any) => { setSnapshot(value); setForm({ ...value.settings, excludeDirsText: (value.settings?.excludeDirs ?? []).join('\n') }) }).catch((failure: any) => setError(message(failure)))
  }
  const loadBackups = () => {
    request('/backups').then((value: any) => { setBackups(value.backups ?? []); setStats(value.stats ?? null) }).catch((failure: any) => setError(message(failure)))
  }
  const loadRuns = () => {
    request('/distill/runs?limit=20').then((value: any) => setRuns(value.runs ?? [])).catch(() => setRuns([]))
  }
  R.useEffect(() => { loadSettings(); loadBackups(); loadRuns() }, [])

  const patch = (partial: any) => setForm({ ...(form ?? {}), ...partial })
  const save = () => {
    if (form === null) return
    const body = {
      defaultStrategy: form.defaultStrategy,
      autoDistill: form.autoDistill === true,
      autoBackup: form.autoBackup === true,
      autoApprove: form.autoApprove === true,
      autoApproveMaxDiffLines: Number(form.autoApproveMaxDiffLines),
      injectEnabled: form.injectEnabled === true,
      injectIncludeUser: form.injectIncludeUser === true,
      injectIncludeWorkspace: form.injectIncludeWorkspace === true,
      injectMaxChars: Number(form.injectMaxChars),
      injectMaxTitles: Number(form.injectMaxTitles),
      reviewerName: String(form.reviewerName ?? '').trim(),
      distillMinChars: Number(form.distillMinChars),
      backupKeep: Number(form.backupKeep),
      excludeDirs: String(form.excludeDirsText ?? '').split(/[\n,]/).map((item: string) => item.trim()).filter((item: string) => item !== ''),
    }
    setBusy('save'); setError(null); setNotice('')
    request('/settings', { method: 'PATCH', body }).then((value: any) => {
      setSnapshot(value); setForm({ ...value.settings, excludeDirsText: (value.settings?.excludeDirs ?? []).join('\n') })
      setNotice('设置已保存')
    }).catch((failure: any) => setError(message(failure))).then(() => setBusy(''))
  }
  const migrate = (dryRun: boolean) => {
    if (target.trim() === '') { setError('请先填写目标目录绝对路径'); return }
    if (!dryRun && !window.confirm('确认把知识中心数据迁移到：' + target + '？\n迁移前会自动创建备份，校验失败时不会切换位置。')) return
    setBusy(dryRun ? 'dry' : 'migrate'); setError(null); setNotice('')
    request('/settings/storage/migrate', { method: 'POST', body: { target: target.trim(), dryRun } }).then((value: any) => {
      setNotice(dryRun ? ('预检通过：将复制 ' + (value.willCopy?.files ?? 0) + ' 个文件，共 ' + formatBytes(value.willCopy?.bytes ?? 0)) : ('已迁移到 ' + value.to + '；请重启 DSH 后生效（原数据仍在 ' + value.from + '）'))
    }).catch((failure: any) => setError(message(failure))).then(() => setBusy(''))
  }
  const createBackup = () => {
    setBusy('backup'); setError(null); setNotice('')
    request('/backups', { method: 'POST', body: { note: backupNote.trim() } }).then((value: any) => {
      setNotice('备份完成：' + value.kbCount + ' 个知识库 / ' + value.docCount + ' 条知识 / ' + formatBytes(value.bytes))
      setBackupNote(''); loadBackups()
    }).catch((failure: any) => setError(message(failure))).then(() => setBusy(''))
  }
  const openPreview = (item: any) => {
    if (busy !== '') return
    setBusy('preview:' + item.id); setError(null); setNotice('')
    request('/backups/' + encodeURIComponent(item.id) + '/preview').then((value: any) => setPreview(value))
      .catch((failure: any) => setError(message(failure))).then(() => setBusy(''))
  }
  const restore = (item: any) => {
    if (!window.confirm('确认从备份 ' + item.file + ' 恢复？\n恢复采用合并语义：缺失的库与知识会重建，正文不同的知识只生成待审核候选，不会覆盖现有内容。')) return
    setBusy(item.id); setError(null); setNotice('')
    request('/backups/' + encodeURIComponent(item.id) + '/restore', { method: 'POST', body: {} }).then((value: any) => {
      setNotice('恢复完成：重建知识库 ' + value.createdKbs + ' 个 / 知识 ' + value.createdDocs + ' 条 / 新候选 ' + value.proposals + ' 条 / 跳过 ' + value.skipped + ' 条')
      loadBackups()
    }).catch((failure: any) => setError(message(failure))).then(() => setBusy(''))
  }

  if (snapshot === null || form === null) {
    return error !== null ? h('div', null, ErrorBox({ text: error }), h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: loadSettings }, '重试')) : Loading({ text: '正在读取设置…' })
  }
  const storage = snapshot.storage ?? {}
  const checkbox = (key: string, label: string, hintText: string) => settingsCheckbox(form, patch, key, label, hintText)
  return h('div', null,
    error !== null ? ErrorBox({ text: error }) : null,
    notice !== '' ? h('div', { style: styles.success }, notice) : null,
    h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, '知识库默认设置'),
      h('div', { style: styles.field },
        h('label', { style: styles.label }, '默认模型使用策略（新建知识库时的默认值）'),
        h('select', { style: styles.input, value: form.defaultStrategy ?? 'balanced', onChange: (event: any) => patch({ defaultStrategy: event.target.value }) },
          STRATEGIES.map((item: any) => h('option', { key: item.value, value: item.value }, item.label + '（' + item.desc + '）')),
        ),
      ),
      h('div', { style: styles.row },
        h('div', { style: { ...styles.field, flex: '1 1 160px' } }, h('label', { style: styles.label }, '自动提炼最短字符数（80–4000）'), h('input', { type: 'number', style: styles.input, value: form.distillMinChars ?? 200, onChange: (event: any) => patch({ distillMinChars: event.target.value }) })),
        h('div', { style: { ...styles.field, flex: '1 1 160px' } }, h('label', { style: styles.label }, '备份保留份数（1–50）'), h('input', { type: 'number', style: styles.input, value: form.backupKeep ?? 10, onChange: (event: any) => patch({ backupKeep: event.target.value }) })),
      ),
      checkbox('autoDistill', '开启自动提炼（默认关闭）', '会话 turn 结束时自动提炼长期知识，结果进入待审核队列，不会直接生效。'),
      checkbox('autoBackup', '恢复/迁移前自动备份（推荐开启）', '执行备份恢复或存储迁移前自动创建一份安全备份。'),
      h('div', { style: styles.row },
        h('div', { style: { ...styles.field, flex: '1 1 160px' } }, h('label', { style: styles.label }, '审核人名称（1–40 字，默认系统用户名）'), h('input', { style: styles.input, value: form.reviewerName ?? '', maxLength: 40, onChange: (event: any) => patch({ reviewerName: event.target.value }) })),
        h('div', { style: { ...styles.field, flex: '1 1 160px' } }, h('label', { style: styles.label }, '自动批准最大差异行数（1–200）'), h('input', { type: 'number', style: styles.input, value: form.autoApproveMaxDiffLines ?? 10, onChange: (event: any) => patch({ autoApproveMaxDiffLines: event.target.value }) })),
      ),
      checkbox('autoApprove', '开启自动批准（默认关闭，仅低风险 Wiki 更新）', '只对「已批准 Wiki 的更新候选」生效：基线版本未变、差异行数不超过阈值时自动落库，并写入审核日志标记 auto_approve；其他类型仍必须人工审核。'),
      h('div', { style: styles.field },
        h('label', { style: styles.label }, '额外排除目录（每行一个或逗号分隔，仅目录名）'),
        h('textarea', { style: styles.textarea, value: form.excludeDirsText ?? '', onChange: (event: any) => patch({ excludeDirsText: event.target.value }), placeholder: '例如：vendor\nthird_party' }),
        h('div', { style: styles.hint }, '默认已排除 .git / node_modules / dist / build / 缓存 / 密钥文件等；这里用于补充项目自定义目录。'),
      ),
      h('button', { type: 'button', style: busy === 'save' ? { ...styles.primary, ...styles.buttonDisabled } : styles.primary, disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : '保存设置'),
    ),
    h(SettingsInjectionCard, { form, patch }),
    h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, '存储位置'),
      h('pre', { style: styles.pre }, '当前数据目录：' + storage.storageRoot + '\n来源：' + (storage.source === 'config' ? '插件配置项' : storage.source === 'pointer' ? '本地位置指针文件' : '默认位置（DSH_HOME）') + (storage.pointerFile ? '\n指针文件：' + storage.pointerFile + (storage.pointerStorageRoot ? '（指向 ' + storage.pointerStorageRoot + '）' : '') : '')),
      h('div', { style: styles.field },
        h('label', { style: styles.label }, '迁移到新目录（绝对路径）'),
        h('div', { style: styles.row },
          h('input', { style: { ...styles.input, flex: '1 1 320px' }, value: target, placeholder: '例如 D:\\KnowHubData', onChange: (event: any) => setTarget(event.target.value) }),
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== '', onClick: () => migrate(true) }, busy === 'dry' ? '预检中…' : '预检'),
          h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== '', onClick: () => migrate(false) }, busy === 'migrate' ? '迁移中…' : '执行迁移'),
        ),
        h('div', { style: styles.hint }, '迁移会先自动备份、拷贝数据库与知识文件并校验计数，成功后写入位置指针；DSH 重启后生效，失败不会切换位置。'),
      ),
    ),
    h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, '备份与恢复', stats !== null ? h('span', { style: styles.badge }, '共 ' + stats.count + ' 份 / ' + formatBytes(stats.totalBytes)) : null),
      h('div', { style: styles.row, marginBottom: '8px' },
        h('input', { style: { ...styles.input, flex: '1 1 260px' }, value: backupNote, placeholder: '备份备注（可选）', onChange: (event: any) => setBackupNote(event.target.value) }),
        h('button', { type: 'button', style: styles.primary, className: 'kh-primary', disabled: busy !== '', onClick: createBackup }, busy === 'backup' ? '备份中…' : '立即备份'),
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: loadBackups }, '刷新列表'),
      ),
      (backups ?? []).length === 0 ? EmptyState({ text: '还没有备份。建议在升级或大改前手动创建一份。' }) : (backups ?? []).map((item: any) => h('div', { key: item.id, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '8px 0' } },
        h('div', { style: styles.cardTitle }, item.file, item.exists === false ? h('span', { style: styles.badgeAmber }, '文件缺失') : h('span', { style: styles.badgeGreen }, '可恢复')),
        h('div', { style: styles.meta }, h('span', null, item.kbCount + ' 个库 / ' + item.docCount + ' 条知识'), h('span', null, formatBytes(item.bytes)), h('span', null, formatTime(item.createdAt)), item.note ? h('span', null, item.note) : null),
        h('div', { style: styles.row, marginTop: '6px' },
          h('button', { type: 'button', style: styles.button, className: 'kh-hover', disabled: busy !== '' || item.exists === false, onClick: () => openPreview(item) }, busy === 'preview:' + item.id ? '读取中…' : '预览内容'),
          h('button', { type: 'button', style: styles.button, disabled: busy !== '' || item.exists === false, onClick: () => restore(item) }, '从该备份恢复（合并）'),
        ),
      )),
    ),
    h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, '自动提炼记录'),
      h('div', { style: styles.meta, marginBottom: '6px' }, h('span', null, '自动提炼：' + (form.autoDistill ? '已开启' : '未开启')), h('span', null, '最短字符数：' + form.distillMinChars)),
      runs.length === 0 ? EmptyState({ text: '还没有提炼记录。开启自动提炼后，会话结束时会自动生成待审核候选。' }) : h('pre', { style: styles.pre }, runs.map((run: any) => formatTime(run.createdAt) + '  ' + run.status + '  新建 ' + run.createdCount + ' / 跳过 ' + run.skippedCount + '  ' + (run.modelProvider ?? '') + '/' + (run.modelId ?? '') + (run.note ? '  ' + run.note : '')).join('\n')),
    ),
    preview !== null ? h('div', { style: styles.modalBackdrop, onClick: (event: any) => { if (event.target === event.currentTarget) setPreview(null) } },
      h('div', { style: { ...styles.modalCard, maxWidth: '760px' } },
        h('div', { style: styles.dialog },
          h('div', { style: styles.dialogHead },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: styles.dialogTitle }, '备份预览：' + preview.file),
              h('div', { style: styles.dialogSub }, '创建于 ' + formatTime(preview.createdAt) + ' · 格式 ' + preview.format + ' v' + preview.formatVersion + ' · schema v' + preview.schemaVersion + (preview.note ? ' · ' + preview.note : '')),
            ),
            h('button', { type: 'button', style: styles.dialogClose, className: 'kh-hover', title: '关闭', onClick: () => setPreview(null) }, '✕'),
          ),
          h('div', { style: styles.dialogBody },
            h('div', { style: styles.meta, marginBottom: '8px' },
              h('span', null, '知识库 ' + preview.kbCount + ' 个'),
              h('span', null, '知识 ' + preview.docCount + ' 条'),
              h('span', null, '版本 ' + preview.versionCount + ' 条'),
              h('span', null, formatBytes(preview.bytes)),
            ),
            (preview.kbs ?? []).length === 0 ? EmptyState({ text: '这个备份里没有知识库数据。' }) : (preview.kbs ?? []).map((kb: any) => h('div', { key: kb.id, style: { ...styles.card, background: 'var(--dsw-alias-bg-layer-1)', marginBottom: '8px' } },
              h('div', { style: styles.cardTitle }, kb.name,
                h(Badge, { text: kb.scope === 'user' ? '用户级' : '工作区级' }),
                kb.exists ? h(Badge, { text: '当前已存在', style: styles.badgeGreen }) : h(Badge, { text: '当前不存在', style: styles.badgeAmber }),
              ),
              h('div', { style: styles.meta },
                h('span', null, '知识 ' + kb.documentCount + ' 条'),
                h('span', null, '版本 ' + kb.versionCount + ' 条'),
                h('span', null, '当前库同名知识 ' + kb.overlapCount + ' 条'),
                (kb.statusBreakdown ?? []).map((item: any) => h('span', { key: 's-' + item.status }, (DOC_STATUS_LABEL[item.status] ?? item.status) + ' ' + item.count)),
                (kb.kindBreakdown ?? []).map((item: any) => h('span', { key: 'k-' + item.kind }, (KIND_LABEL[item.kind] ?? item.kind) + ' ' + item.count)),
              ),
              (kb.sampleTitles ?? []).length > 0 ? h('div', { style: styles.hint }, '包含：' + (kb.sampleTitles ?? []).join('、')) : null,
              (kb.overlapTitles ?? []).length > 0 ? h('div', { style: styles.hint }, '恢复时只生成待审核候选（不覆盖现有正文）：' + (kb.overlapTitles ?? []).slice(0, 10).join('、')) : null,
            )),
            h('div', { style: styles.hint }, preview.note2 ?? ''),
          ),
          h('div', { style: styles.dialogFoot },
            h('div', { style: styles.hint }, '预览只读，不会写入任何数据。'),
            h('div', { style: { flex: 1 } }),
            h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => setPreview(null) }, '关闭'),
            preview.kbs && preview.kbs.length > 0 ? h('button', {
              type: 'button', style: styles.button, className: 'kh-hover',
              onClick: () => { const item = (backups ?? []).find((entry: any) => entry.id === preview.backupId); setPreview(null); if (item) restore(item) },
            }, '按合并语义恢复…') : null,
          ),
        ),
      ),
    ) : null,
    h('div', { style: styles.sectionTitle }, '环境与接口诊断'),
    h(DiagnosticsView, null),
  )
}

/**
 * 知枢知识中心主面板。
 *
 * 形态依据 DSH 官方 slots 文档与生产插件 dsh-client-ui-schedule /
 * dsh-client-ui-plugin-manager：sidebar.panellist 注册侧栏图标行（order 决定
 * 与「自动化任务」的先后），同 id 的 main keyed 槽注册整页内容；点击侧栏行
 * 由布局替换会话那一栏。配色、按钮、圆角全部读取 --dsw-* 主题 token。
 */
const MAIN_TABS: Array<{ key: string; label: string }> = [
  { key: 'wiki', label: 'Repo Wiki' },
  { key: 'cards', label: '知识卡片' },
  { key: 'memory', label: '记忆' },
  { key: 'kb', label: '知识库' },
]
const OVERLAY_TITLES: Record<string, string> = { review: '待审核', search: '知识检索', settings: '设置与诊断' }

/** 知识中心主面板：Qoder 式页头（标题 + 四页签 + 右上入口）+ 两栏内容。*/
function Page(): any {
  const [tab, setTab] = R.useState('wiki')
  const [view, setView] = R.useState('')
  const [currentWorkspace, setCurrentWorkspace] = R.useState(null)
  const [workspaces, setWorkspaces] = R.useState(null)
  const [models, setModels] = R.useState(null)
  const [kbList, setKbList] = R.useState(null)
  const [bootError, setBootError] = R.useState(null)
  const [booting, setBooting] = R.useState(false)
  const [notice, setNotice] = R.useState('')
  const [reloadKey, setReloadKey] = R.useState(0)
  const [reviewCount, setReviewCount] = R.useState(0)

  R.useEffect(() => {
    let alive = true
    setBooting(true); setBootError(null)
    ;(async () => {
      try {
        const [ws, listed, catalog] = await Promise.all([request('/current-workspace'), request('/workspaces'), request('/models')])
        if (!alive) return
        const kbQuery = ws && ws.workspaceId ? '?workspaceId=' + encodeURIComponent(ws.workspaceId) : ''
        const kbValue = await request('/kb' + kbQuery).catch(() => ({ knowledgeBases: [] }))
        if (!alive) return
        setCurrentWorkspace(ws)
        setWorkspaces(listed.workspaces ?? [])
        setModels(catalog.models ?? [])
        setKbList(kbValue.knowledgeBases ?? [])
        if (catalog.available === false) setBootError(catalog.error ?? '模型服务不可用')
        const reviewValue = await request('/review?limit=1').catch(() => null)
        if (alive && reviewValue) {
          const counts = reviewValue.counts ?? {}
          setReviewCount(Number(counts.pendingTotal ?? counts.total ?? 0))
        }
      } catch (failure: any) {
        if (alive) setBootError(message(failure))
      } finally {
        if (alive) setBooting(false)
      }
    })()
    return () => { alive = false }
  }, [reloadKey])

  const notify = (text: string) => setNotice(text)
  const refreshReviewCount = async () => {
    try {
      const value = await request('/review?limit=1')
      const counts = value?.counts ?? {}
      setReviewCount(Number(counts.pendingTotal ?? counts.total ?? 0))
    } catch { /* 徽标失败不打断界面 */ }
  }
  const goto = (next: string) => { setView(next); void refreshReviewCount() }

  const renderOverlay = (): any => h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: styles.backBar },
      h('button', { type: 'button', style: styles.linkButton, className: 'kh-hover', onClick: () => { setView(''); setNotice('') } }, '← 返回知识中心'),
      h('h2', { style: styles.headerTitle }, OVERLAY_TITLES[view] ?? view),
    ),
    h('div', { style: styles.overlayScroll, className: 'kh-scroll' },
      h('div', { style: styles.overlayInner },
        notice !== '' ? h('div', { style: styles.success }, notice) : null,
        view === 'review' ? h(ReviewView, { knowledgeBases: kbList ?? [] }) : null,
        view === 'search' ? h('div', null,
          h(SearchView, { knowledgeBases: kbList ?? [] }),
          h('div', { style: styles.hint }, '说明：检索作用域由宿主根据当前工作目录推导，前端无法越过作用域读取其他项目私有知识。'),
        ) : null,
        view === 'settings' ? h(SettingsView, null) : null,
      ),
    ),
  )

  const renderTab = (): any => {
    if (tab === 'kb') {
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h('div', { style: styles.subBar },
          booting ? h('span', null, '正在读取 DSH 环境…') : null,
          currentWorkspace && currentWorkspace.workspaceId
            ? h('span', null, '当前工作区：' + (currentWorkspace.title ?? '') + ' · ' + currentWorkspace.workspaceId)
            : h('span', null, '未识别当前工作区（只显示用户级知识库）'),
          models !== null ? h('span', null, '可用模型：' + models.length + ' 个') : null,
        ),
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } },
          h(KbView, {
            models: models ?? [], workspaces: workspaces ?? [], currentWorkspace, notify,
            refreshKey: reloadKey,
          }),
        ),
      )
    }
    return h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, h(DocsExplorer, { mode: tab }))
  }

  return h('div', { style: styles.shell, className: 'knowhub-page' },
    h('div', { style: styles.headerBar },
      h('h1', { style: styles.headerTitle }, '知识中心'),
      h('div', { style: styles.headerTabs }, MAIN_TABS.map((item) => h('button', {
        key: item.key, type: 'button',
        style: view === '' && tab === item.key ? styles.headerTabActive : styles.headerTab,
        onClick: () => { setTab(item.key); setView(''); setNotice('') },
      }, item.label))),
      h('div', { style: styles.headerActions },
        booting ? h('span', { style: styles.status }, '读取环境中…') : null,
        h('button', { type: 'button', style: styles.linkButton, className: 'kh-hover', onClick: () => goto('review') },
          '待审核', reviewCount > 0 ? h('span', { style: styles.countBadge }, String(reviewCount)) : null),
        h('button', { type: 'button', style: styles.linkButton, className: 'kh-hover', onClick: () => goto('search') }, '检索'),
        h('button', { type: 'button', style: styles.linkButton, className: 'kh-hover', onClick: () => goto('settings') }, '设置'),
        h('button', { type: 'button', style: styles.button, className: 'kh-hover', onClick: () => { setReloadKey(reloadKey + 1); void refreshReviewCount() } }, '刷新'),
      ),
    ),
    bootError !== null ? h('div', { style: { ...styles.error, margin: '10px 24px 0' } }, bootError) : null,
    notice !== '' && view === '' ? h('div', { style: { ...styles.success, margin: '10px 24px 0' } }, notice) : null,
    view !== '' ? renderOverlay() : renderTab(),
  )
}


/** sidebar.panellist 行图标：自绘 SVG（不依赖 @deepseek-ai/dsh-client-ui-primitives）。 */
function KnowHubIcon(props: any): any {
  const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 20
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  },
    h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z' }),
    h('path', { d: 'M4 18.5A2.5 2.5 0 0 1 6.5 16H19' }),
    h('path', { d: 'M8.5 7.5h7' }),
    h('path', { d: 'M8.5 11h4.5' }),
  )
}

/** 仅供构建期渲染冒烟测试使用（宿主不使用）。 */
export const __smoke = { Page, DocsExplorer, KbView, CreateKbForm, EditKbForm, ImportMarkdownForm, ReviewView, SearchView, SettingsView, SettingsInjectionCard, DocumentDiffPage, diffUnifiedRows, diffSplitRows, renderMarkdown }

export const inject = ['slots']

export function apply(ctx: any): void {
  const slots = (() => { try { return ctx.get('slots') } catch { return undefined } })()
  if (!slots) return
  ctx.effect(() => injectStyles(), 'knowhub: 主题样式')
  const panelId = 'knowhub'
  ctx.effect(() => slots.inject('main', () => slots.register({
    name: 'main',
    key: panelId,
    inject: () => ({}),
  }, Page)) as any, 'knowhub: 知识中心主面板')
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: panelId,
    order: 20,
    label: () => '知枢',
  }, KnowHubIcon)) as any, 'knowhub: 侧栏入口（自动化任务下方）')
}
