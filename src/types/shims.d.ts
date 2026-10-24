// 最小 React 类型垫片：插件运行时由 DSH 宿主提供 React，本插件不额外安装 @types/react。
declare module 'react' {
  export const useState: any
  export const useEffect: any
  export const useRef: any
  export const useMemo: any
  export const useCallback: any
  export const useSyncExternalStore: any
  export const createElement: any
  export const Fragment: any
  export type ReactNode = any
  const React: any
  export default React
}

interface Window {
  __ModuleLoader__?: {
    load(entry: { id: string; factory: (require: (id: string) => any) => any }): void
  }
}
