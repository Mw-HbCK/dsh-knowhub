/**
 * 知枢 KnowHub —— 客户端 bundle 的 Node 半边。
 *
 * Web 客户端模块系统会加载本包（package.json 的 `dsh.client` + exports["./client"]），
 * 而 Node 侧的 bundle 行只需要一个可 apply 的插件入口，真正的逻辑在
 * `src/host/*`（宿主服务、工具与 /knowhub HTTP 路由）和 `src/client/*`（Web 面板）。
 */
export const name = 'dsh-knowhub'

export function apply(): void {
  // M0 阶段有意为空壳：Node 侧不注册任何服务，避免与 host 行重复初始化。
}
