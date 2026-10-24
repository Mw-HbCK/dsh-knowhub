/**
 * 知枢 KnowHub 宿主插件入口（cordis.patch.yml 行 name: dsh-knowhub/host）。
 *
 * M0 目标：证明插件能在当前 DSH 真实加载，并暴露可验证的诊断能力：
 *   1. /knowhub/api/* HTTP 路由（webServer 可选注入；桌面版可能没有该服务 → 降级不阻塞）
 *   2. knowledge_diagnose 工具（tools 可选注入）
 *   3. 工作区、模型目录、SQLite FTS5、存储目录的真实探测
 *
 * 注意：cordis 的 ctx.get(name) 对未声明 inject 的服务会抛
 * "cannot get property <name> without inject"，因此可选依赖必须用
 * ctx.inject([name], cb) 的形式——服务就绪时回调，缺失时插件照常加载。
 */
import { createRouter } from './route.js'
import { registerKnowledgeTools } from './tool.js'
import { registerContextInjection } from './inject.js'
import { registerAutoDistill } from './distill.js'

export const name = 'dsh-knowhub/host'
/** 不把 webServer/tools 列为必需依赖：桌面版没有 HTTP 服务，工具服务也可能后到。 */
export const inject: string[] = []

export interface Config {
  /** 知识中心数据根目录；留空使用 <DSH_HOME>/knowledge-center。 */
  storageRoot?: string
  /** 保留字段：诊断时是否主动探测模型（M0 由用户显式点击触发，默认不自动调用）。 */
  probeModelOnDiagnose?: boolean
}

export function apply(ctx: any, config: Config = {}): void {
  const cfg = config ?? {}
  const router = createRouter(ctx, cfg)

  // HTTP 路由：webServer 就绪时才注册；没有该服务（桌面版）时静默跳过，工具能力不受影响。
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: '/knowhub',
        handler: (req: any, res: any) => { void router.handle(req, res) },
      }),
      'knowhub: /knowhub 路由',
    )
  })

  // tools 服务可能晚于本插件就绪：同样用可选注入，不阻塞宿主加载。
  ctx.inject(['tools'], (toolsCtx: any) => {
    registerKnowledgeTools(toolsCtx, ctx, cfg)
  })

  // M3：按会话注入知识摘要（agent/created → agent.ctx.systemPrompt.section）。
  registerContextInjection(ctx, cfg)

  // M5：自动提炼（默认关闭，设置页开启后监听 assistant-stream + turn-stopping）。
  registerAutoDistill(ctx, cfg)
}
