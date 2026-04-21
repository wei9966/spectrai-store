// T2 产出：MCP 工具层协议契约（面向 AI 的 schema，独立于 IPC 协议）
import { z } from 'zod'

type JsonSchema = Record<string, unknown>

type ToolSchemaEntry = {
  input: z.ZodTypeAny
  output: z.ZodTypeAny
  description: string
}

const boundsSchema = z
  .object({
    x: z.number().describe('左上角 x 坐标，单位为 AppKit 逻辑 point'),
    y: z.number().describe('左上角 y 坐标，单位为 AppKit 逻辑 point'),
    width: z.number().positive().describe('宽度，单位为 AppKit 逻辑 point'),
    height: z.number().positive().describe('高度，单位为 AppKit 逻辑 point'),
  })
  .describe('矩形区域（AppKit 逻辑 point）')

const pointSchema = z
  .object({
    x: z.number().describe('x 坐标，单位为 AppKit 逻辑 point'),
    y: z.number().describe('y 坐标，单位为 AppKit 逻辑 point'),
  })
  .describe('屏幕点位（AppKit 逻辑 point）')

const describeScreenTargetSchema = z
  .object({
    window_id: z.number().int().positive().optional().describe('目标窗口 ID'),
    app_bundle_id: z.string().trim().min(1).optional().describe('目标应用 bundle_id'),
    app_name: z.string().trim().min(1).optional().describe('目标应用名称'),
  })
  .superRefine((value, ctx) => {
    const selected = [value.window_id != null, value.app_bundle_id != null, value.app_name != null].filter(Boolean).length

    if (selected === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'target 提供时必须至少指定 window_id / app_bundle_id / app_name 之一',
      })
      return
    }

    if (selected > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'target 仅允许指定一种定位方式，避免歧义',
      })
    }
  })
  .describe('目标窗口或应用定位信息（仅可三选一）')

const describeScreenCaptureAreaSchema = z
  .object({
    x: z.number().describe('区域左上角 x，单位为 AppKit 逻辑 point'),
    y: z.number().describe('区域左上角 y，单位为 AppKit 逻辑 point'),
    width: z.number().positive().describe('区域宽度，单位为 AppKit 逻辑 point'),
    height: z.number().positive().describe('区域高度，单位为 AppKit 逻辑 point'),
  })
  .describe('屏幕裁剪区域（AppKit 逻辑 point）')

/**
 * describe_screen：截图 + AX 扫描 + 生成 SoM 标注图。
 * 返回 snapshot_id（后续操作引用）、raw/annotated 图路径和可交互元素列表。
 * 这是 AI 进行桌面自动化的第一步，建议优先调用。
 */
const describeScreenInputSchema = z
  .object({
    target: describeScreenTargetSchema.optional().describe('可选目标（窗口或应用）'),
    display_index: z.number().int().min(0).optional().describe('多屏序号（默认 0）'),
    capture_area: describeScreenCaptureAreaSchema.optional().describe('可选截图区域'),
    annotated: z.boolean().optional().describe('是否生成带编号标注图（默认 true）'),
    allow_web_focus: z.boolean().optional().describe('是否尝试唤醒 AXWebArea（默认 true）'),
  })
  .superRefine((value, ctx) => {
    if (value.target?.window_id != null && value.display_index != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '指定 window_id 时不应再指定 display_index',
        path: ['display_index'],
      })
    }

    if (value.capture_area && value.capture_area.width * value.capture_area.height <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'capture_area 的宽高必须大于 0',
        path: ['capture_area'],
      })
    }
  })
  .describe('截图并输出结构化屏幕语义，供后续 click/type_text 等工具引用')

const describeScreenOutputSchema = z
  .object({
    snapshot_id: z.string().min(1).describe('快照 ID，后续工具可复用'),
    screenshot_raw_path: z.string().min(1).describe('原始截图路径'),
    screenshot_annotated_path: z.string().min(1).optional().describe('标注截图路径'),
    screen_dimensions: z
      .object({
        width: z.number().positive().describe('屏幕宽度（逻辑 point）'),
        height: z.number().positive().describe('屏幕高度（逻辑 point）'),
      })
      .describe('屏幕尺寸（AppKit 逻辑 point）'),
    application: z
      .object({
        name: z.string().min(1).describe('应用名称'),
        bundle_id: z.string().min(1).describe('应用 bundle_id'),
        pid: z.number().int().positive().describe('应用进程 ID'),
      })
      .optional()
      .describe('识别出的应用信息'),
    window: z
      .object({
        title: z.string().describe('窗口标题'),
        window_id: z.number().int().positive().describe('窗口 ID'),
        bounds: boundsSchema.describe('窗口边界（AppKit 逻辑 point）'),
      })
      .optional()
      .describe('识别出的窗口信息'),
    is_dialog: z.boolean().describe('当前窗口是否是对话框'),
    element_count: z.number().int().min(0).describe('元素总数'),
    interactable_count: z.number().int().min(0).describe('可交互元素数'),
    ui_elements: z
      .array(
        z
          .object({
            id: z.string().min(1).describe('元素 ID（在 snapshot_id 内唯一）'),
            role: z.string().min(1).describe('AX 角色'),
            subrole: z.string().optional().describe('AX 子角色'),
            label: z.string().describe('元素可读标签'),
            title: z.string().optional().describe('元素标题'),
            value: z.string().optional().describe('元素当前值'),
            description: z.string().optional().describe('元素描述'),
            identifier: z.string().optional().describe('AX identifier'),
            keyboard_shortcut: z.string().optional().describe('快捷键提示'),
            is_actionable: z.boolean().describe('是否可执行点击/激活动作'),
            bounds: boundsSchema.describe('元素边界（AppKit 逻辑 point）'),
          })
          .describe('单个 UI 元素信息'),
      )
      .describe('编号 UI 元素列表'),
    menu_bar: z
      .object({
        items: z
          .array(
            z
              .object({
                id: z.string().min(1).describe('菜单项 ID'),
                title: z.string().describe('菜单标题'),
                shortcut: z.string().optional().describe('菜单快捷键'),
                enabled: z.boolean().describe('菜单项是否可用'),
              })
              .describe('单个菜单项'),
          )
          .describe('菜单项列表'),
      })
      .optional()
      .describe('菜单栏信息（可选）'),
    warnings: z.array(z.string()).describe('采集过程中的告警信息'),
  })
  .describe('describe_screen 的返回结构')

const clickQuerySchema = z
  .object({
    role: z.string().trim().min(1).optional().describe('按角色模糊匹配'),
    label: z.string().trim().min(1).optional().describe('按标签模糊匹配'),
    identifier: z.string().trim().min(1).optional().describe('按 identifier 模糊匹配'),
  })
  .superRefine((value, ctx) => {
    if (!value.role && !value.label && !value.identifier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'query 至少需要 role / label / identifier 之一',
      })
    }
  })
  .describe('在快照中定位元素的模糊查询条件')

/**
 * click：点击一个 UI 元素。
 * 优先使用 snapshot_id + element_id（来自 describe_screen），仅在必要时使用坐标兜底。
 */
const clickInputSchema = z
  .object({
    snapshot_id: z.string().trim().min(1).optional().describe('快照 ID，来自 describe_screen'),
    element_id: z.string().trim().min(1).optional().describe('目标元素 ID，来自 describe_screen.ui_elements[].id'),
    query: clickQuerySchema.optional().describe('在快照内按字段模糊搜索元素'),
    x: z.number().optional().describe('坐标点击 x（仅坐标模式）'),
    y: z.number().optional().describe('坐标点击 y（仅坐标模式）'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('鼠标按键类型（默认 left）'),
    click_type: z.enum(['single', 'double']).optional().describe('点击类型（默认 single）'),
    modifiers: z
      .array(z.enum(['cmd', 'shift', 'option', 'control']))
      .optional()
      .describe('组合修饰键（默认空）'),
  })
  .superRefine((value, ctx) => {
    const hasElementId = value.element_id != null
    const hasQuery = value.query != null
    const hasCoordPair = value.x != null && value.y != null

    if ((value.x == null) !== (value.y == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '坐标模式需要同时提供 x 和 y',
        path: value.x == null ? ['x'] : ['y'],
      })
    }

    if (!hasElementId && !hasQuery && !hasCoordPair) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '必须提供 element_id、query 或 (x,y) 其中一组',
      })
    }

    if (hasCoordPair && value.snapshot_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '坐标模式下不应提供 snapshot_id',
        path: ['snapshot_id'],
      })
    }

    if ((hasElementId || hasQuery) && !value.snapshot_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'element_id 或 query 模式必须提供 snapshot_id',
        path: ['snapshot_id'],
      })
    }
  })
  .describe('点击工具输入：优先元素模式，其次快照查询，最后坐标兜底')

const clickOutputSchema = z
  .object({
    clicked_at: pointSchema.describe('实际点击坐标（AppKit 逻辑 point）'),
    target_element: z
      .object({
        id: z.string().min(1).describe('目标元素 ID'),
        role: z.string().min(1).describe('目标元素角色'),
        label: z.string().describe('目标元素标签'),
      })
      .optional()
      .describe('已命中的元素摘要'),
    verification_screenshot_path: z.string().optional().describe('点击后中心 300x300 验证截图路径'),
  })
  .describe('click 的返回结构')

/**
 * type_text：输入文本，支持 Unicode/中文（绕开 IME）。
 * 可先基于 snapshot_id + element_id 聚焦目标输入框。
 */
const typeTextInputSchema = z
  .object({
    text: z.string().describe('要输入的文本内容（支持 Unicode）'),
    snapshot_id: z.string().trim().min(1).optional().describe('快照 ID（用于预聚焦）'),
    element_id: z.string().trim().min(1).optional().describe('目标元素 ID（用于预聚焦）'),
    clear_existing: z.boolean().optional().describe('输入前是否清空现有内容（默认 false）'),
    delay_ms_per_char: z.number().int().min(0).optional().describe('逐字符延迟毫秒（默认 0）'),
  })
  .superRefine((value, ctx) => {
    const hasSnapshot = value.snapshot_id != null
    const hasElement = value.element_id != null

    if (hasSnapshot !== hasElement) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'snapshot_id 和 element_id 必须同时提供或同时省略',
      })
    }

    if (value.text.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text 不能为空字符串',
        path: ['text'],
      })
    }
  })
  .describe('文本输入工具输入')

const typeTextOutputSchema = z
  .object({
    typed_chars: z.number().int().min(0).describe('实际输入字符数'),
    focused_element: z
      .object({
        id: z.string().min(1).describe('聚焦元素 ID'),
        role: z.string().min(1).describe('聚焦元素角色'),
        label: z.string().describe('聚焦元素标签'),
      })
      .optional()
      .describe('被聚焦的目标元素'),
  })
  .describe('type_text 的返回结构')

/**
 * hotkey：按下组合键（如 ['cmd','c']、['cmd','shift','s']、['cmd','tab']）。
 */
const hotkeyInputSchema = z
  .object({
    keys: z.array(z.string().trim().min(1)).min(1).describe('按键序列，至少 1 个键'),
    hold_ms: z.number().int().min(0).optional().describe('按住时长毫秒（默认 50）'),
  })
  .superRefine((value, ctx) => {
    const normalized = value.keys.map(key => key.toLowerCase())
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'keys 不应包含重复键',
        path: ['keys'],
      })
    }
  })
  .describe('组合键工具输入')

const hotkeyOutputSchema = z
  .object({
    ok: z.literal(true).describe('执行成功标记'),
  })
  .describe('hotkey 的返回结构')

/**
 * scroll：滚轮滚动。可选先移动到指定坐标后滚动。
 */
const scrollInputSchema = z
  .object({
    direction: z.enum(['up', 'down', 'left', 'right']).describe('滚动方向'),
    amount: z.number().positive().describe('滚动刻度（正数）'),
    x: z.number().optional().describe('可选预移动 x 坐标'),
    y: z.number().optional().describe('可选预移动 y 坐标'),
  })
  .superRefine((value, ctx) => {
    if ((value.x == null) !== (value.y == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '提供滚动坐标时必须同时包含 x 和 y',
      })
    }
  })
  .describe('滚动工具输入')

const scrollOutputSchema = z
  .object({
    ok: z.literal(true).describe('执行成功标记'),
  })
  .describe('scroll 的返回结构')

/**
 * list_apps：列出当前运行中的应用（名称 / bundle_id / pid / 是否前台）。
 */
const listAppsInputSchema = z
  .object({})
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'list_apps 不接收任何参数',
      })
    }
  })
  .describe('列出运行中应用，无入参')

const listAppsOutputSchema = z
  .object({
    applications: z
      .array(
        z
          .object({
            pid: z.number().int().positive().describe('进程 ID'),
            bundle_id: z.string().min(1).describe('应用 bundle_id'),
            name: z.string().min(1).describe('应用名称'),
            is_active: z.boolean().describe('是否为当前前台应用'),
          })
          .describe('运行中的应用'),
      )
      .describe('应用列表'),
  })
  .describe('list_apps 的返回结构')

/**
 * activate_app：激活并置前一个应用。支持 bundle_id 或 name 二选一。
 */
const activateAppInputSchema = z
  .object({
    bundle_id: z.string().trim().min(1).optional().describe('要激活的应用 bundle_id'),
    name: z.string().trim().min(1).optional().describe('要激活的应用名称'),
  })
  .superRefine((value, ctx) => {
    if (!value.bundle_id && !value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '必须至少提供 bundle_id 或 name 其中之一',
      })
    }
  })
  .describe('应用激活输入')

const activateAppOutputSchema = z
  .object({
    ok: z.literal(true).describe('执行成功标记'),
    pid: z.number().int().positive().optional().describe('被激活应用的进程 ID'),
  })
  .describe('activate_app 的返回结构')

export const TOOL_NAMES = ['describe_screen', 'click', 'type_text', 'hotkey', 'scroll', 'list_apps', 'activate_app'] as const

export type ToolName = typeof TOOL_NAMES[number]

export const toolSchemas = {
  describe_screen: {
    input: describeScreenInputSchema,
    output: describeScreenOutputSchema,
    description:
      '截图 + AX 扫描 + SoM 标注，返回 snapshot_id、截图路径和元素列表。是桌面自动化第一步，建议优先调用。',
  },
  click: {
    input: clickInputSchema,
    output: clickOutputSchema,
    description:
      '点击 UI 元素。优先 snapshot_id + element_id，其次 query，最后坐标兜底。',
  },
  type_text: {
    input: typeTextInputSchema,
    output: typeTextOutputSchema,
    description: '输入文本，支持 Unicode/中文；可选先聚焦目标元素再输入。',
  },
  hotkey: {
    input: hotkeyInputSchema,
    output: hotkeyOutputSchema,
    description: '按下组合键，适用于系统或应用快捷操作。',
  },
  scroll: {
    input: scrollInputSchema,
    output: scrollOutputSchema,
    description: '执行滚动操作，可选先移动到指定坐标。',
  },
  list_apps: {
    input: listAppsInputSchema,
    output: listAppsOutputSchema,
    description: '列出当前运行中的应用列表及前台状态。',
  },
  activate_app: {
    input: activateAppInputSchema,
    output: activateAppOutputSchema,
    description: '将指定应用激活并置前（bundle_id 或 name 至少一个）。',
  },
} satisfies Record<ToolName, ToolSchemaEntry>

export type ToolInput<T extends ToolName> = z.infer<(typeof toolSchemas)[T]['input']>

export type ToolOutput<T extends ToolName> = z.infer<(typeof toolSchemas)[T]['output']>

type ZodDefLike = {
  type: string
  [key: string]: unknown
}

function getDef(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def
}

function isOptionalLike(schema: z.ZodTypeAny): boolean {
  const typeName = getDef(schema).type
  return typeName === 'optional' || typeName === 'default'
}

function withDescription(schema: z.ZodTypeAny, jsonSchema: JsonSchema): JsonSchema {
  if (schema.description) {
    jsonSchema.description = schema.description
  }

  return jsonSchema
}

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = getDef(schema)

  switch (def.type) {
    case 'default': {
      const inner = zodToJsonSchema(def.innerType as z.ZodTypeAny)
      return withDescription(schema, {
        ...inner,
        default: def.defaultValue,
      })
    }

    case 'optional':
      return zodToJsonSchema(def.innerType as z.ZodTypeAny)

    case 'nullable':
      return withDescription(schema, {
        anyOf: [zodToJsonSchema(def.innerType as z.ZodTypeAny), { type: 'null' }],
      })

    case 'object': {
      const shape = (def.shape ?? {}) as Record<string, z.ZodTypeAny>
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []

      for (const [key, childSchema] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(childSchema)
        if (!isOptionalLike(childSchema)) {
          required.push(key)
        }
      }

      const objectSchema: JsonSchema = {
        type: 'object',
        properties,
        additionalProperties: false,
      }

      if (required.length > 0) {
        objectSchema.required = required
      }

      return withDescription(schema, objectSchema)
    }

    case 'string':
      return withDescription(schema, { type: 'string' })

    case 'number':
      return withDescription(schema, { type: 'number' })

    case 'boolean':
      return withDescription(schema, { type: 'boolean' })

    case 'array':
      return withDescription(schema, {
        type: 'array',
        items: zodToJsonSchema(def.element as z.ZodTypeAny),
      })

    case 'union':
      return withDescription(schema, {
        anyOf: ((def.options as z.ZodTypeAny[] | undefined) ?? []).map(option => zodToJsonSchema(option)),
      })

    case 'enum': {
      const entries = (def.entries ?? {}) as Record<string, string | number>
      const enumValues = Array.from(new Set(Object.values(entries)))
      const enumSchema: JsonSchema = { enum: enumValues }

      if (enumValues.every(value => typeof value === 'string')) {
        enumSchema.type = 'string'
      } else if (enumValues.every(value => typeof value === 'number')) {
        enumSchema.type = 'number'
      }

      return withDescription(schema, enumSchema)
    }

    case 'literal': {
      const values = ((def.values as unknown[] | undefined) ?? [])
      const literalValue = values[0]
      const literalSchema: JsonSchema = {
        const: literalValue,
      }

      if (
        typeof literalValue === 'string' ||
        typeof literalValue === 'number' ||
        typeof literalValue === 'boolean'
      ) {
        literalSchema.type = typeof literalValue
      }

      return withDescription(schema, literalSchema)
    }

    default:
      return withDescription(schema, {})
  }
}

export function jsonSchemaOf(tool: ToolName): object {
  return zodToJsonSchema(toolSchemas[tool].input)
}
