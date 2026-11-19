import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { AppLogger } from '../shared/types.ts';

const execFileAsync = promisify(execFile);

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelCatalogEntry {
  id: string;
  label: string;
  family?: 'carbon' | 'neon' | 'argon' | 'hydrogen' | 'flash38' | 'orchestrator' | 'claude' | 'gpt';
  tier?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface PeerModelPreferences {
  peerKey: string;
  model?: string;
  effort?: ThinkingEffort;
  subagentModel?: string;
  updatedAt: number;
}

/**
 * 经实测核验的本机 `agy models` 标准模型目录（当动态拉取不可用时作为即时零延迟基线）。
 */
export const DEFAULT_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)', family: 'carbon', tier: 'low' },
  { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', family: 'carbon', tier: 'medium' },
  { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)', family: 'carbon', tier: 'high' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)', family: 'argon', tier: 'low' },
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)', family: 'argon', tier: 'medium' },
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', family: 'argon', tier: 'high' },
  { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)', family: 'hydrogen', tier: 'low' },
  { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)', family: 'hydrogen', tier: 'medium' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)', family: 'hydrogen', tier: 'high' },
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)', family: 'hydrogen', tier: 'xhigh' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', family: 'flash38', tier: 'low' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', family: 'flash38', tier: 'medium' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', family: 'flash38', tier: 'high' },
  { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)', family: 'orchestrator' },
  { id: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)', family: 'orchestrator' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', family: 'claude' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', family: 'claude' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', family: 'gpt', tier: 'medium' },
];

const EFFORT_ALIASES: Record<string, ThinkingEffort> = {
  l: 'low',
  lo: 'low',
  low: 'low',
  min: 'low',
  minimal: 'low',
  m: 'medium',
  med: 'medium',
  mid: 'medium',
  medium: 'medium',
  h: 'high',
  hi: 'high',
  high: 'high',
  xh: 'xhigh',
  xhigh: 'xhigh',
  'extra-high': 'xhigh',
  extra_high: 'xhigh',
  max: 'max',
};

type TieredFamily = 'carbon' | 'neon' | 'argon' | 'hydrogen' | 'flash38';

const FAMILY_ALIASES: Record<string, TieredFamily> = {
  '4c': 'carbon',
  c4: 'carbon',
  carbon: 'carbon',
  'gemini-4-carbon': 'carbon',
  gemini4carbon: 'carbon',
  '4n': 'neon',
  n4: 'neon',
  neon: 'neon',
  'gemini-4-neon': 'neon',
  gemini4neon: 'neon',
  '4a': 'argon',
  a4: 'argon',
  argon: 'argon',
  'gemini-4-argon': 'argon',
  gemini4argon: 'argon',
  '4h': 'hydrogen',
  h4: 'hydrogen',
  hydrogen: 'hydrogen',
  'gemini-4-hydrogen': 'hydrogen',
  gemini4hydrogen: 'hydrogen',
  '3.8f': 'flash38',
  '38f': 'flash38',
  '3f': 'flash38',
  flash: 'flash38',
  'gemini-3.8-flash': 'flash38',
  gemini38flash: 'flash38',
};

const DIRECT_MODEL_ALIASES: Record<string, string> = {
  orch: 'gemini-pro-orchestrator',
  orchestrator: 'gemini-pro-orchestrator',
  '4c-orch': 'gemini-pro-orchestrator',
  'orch-c': 'gemini-pro-orchestrator',
  'orch-a': 'gemini-pro-orchestrator-argon',
  '4a-orch': 'gemini-pro-orchestrator-argon',
  'orchestrator-argon': 'gemini-pro-orchestrator-argon',
  sonnet: 'claude-sonnet-4-6',
  cs: 'claude-sonnet-4-6',
  'claude-sonnet': 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6-thinking',
  co: 'claude-opus-4-6-thinking',
  'claude-opus': 'claude-opus-4-6-thinking',
  gpt: 'gpt-oss-120b-medium',
  oss: 'gpt-oss-120b-medium',
  '120b': 'gpt-oss-120b-medium',
};

const FAMILY_PREFIX: Record<TieredFamily, string> = {
  carbon: 'gemini-4-carbon',
  neon: 'gemini-4-neon',
  argon: 'gemini-4-argon',
  hydrogen: 'gemini-4-hydrogen',
  flash38: 'gemini-3.8-flash',
};

export function parseThinkingEffort(raw: string | undefined): ThinkingEffort | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return EFFORT_ALIASES[key] ?? null;
}

function resolveTierForFamily(
  family: TieredFamily,
  desiredEffort: ThinkingEffort | undefined,
  catalog: readonly ModelCatalogEntry[],
): string {
  const availableIds = new Set(catalog.map((c) => c.id));
  let effectiveFamily = family;
  const hasFamilyEntries = (fam: TieredFamily): boolean =>
    catalog.some((c) => c.id.startsWith(`${FAMILY_PREFIX[fam]}-`));
  if (effectiveFamily === 'carbon' && !hasFamilyEntries('carbon') && hasFamilyEntries('neon')) {
    effectiveFamily = 'neon';
  } else if (effectiveFamily === 'neon' && !hasFamilyEntries('neon') && hasFamilyEntries('carbon')) {
    effectiveFamily = 'carbon';
  }

  const prefix = FAMILY_PREFIX[effectiveFamily];
  const desired = desiredEffort ?? 'medium';

  const tierFallbackOrder: Record<ThinkingEffort, readonly string[]> = {
    low: ['low', 'medium', 'high'],
    medium: ['medium', 'low', 'high'],
    high: ['high', 'medium', 'low'],
    xhigh: ['xhigh', 'high', 'medium'],
    max: ['xhigh', 'high', 'medium'],
  };

  for (const tier of tierFallbackOrder[desired]) {
    const candidate = `${prefix}-${tier}`;
    if (availableIds.has(candidate)) {
      return candidate;
    }
  }
  return `${prefix}-medium`;
}

export function detectModelFamilyAndTier(modelId: string | undefined): {
  family?: TieredFamily;
  tier?: ThinkingEffort;
} {
  if (!modelId) return {};
  const lower = modelId.trim().toLowerCase();
  const families: Array<[TieredFamily, string]> = [
    ['carbon', 'gemini-4-carbon-'],
    ['neon', 'gemini-4-neon-'],
    ['argon', 'gemini-4-argon-'],
    ['hydrogen', 'gemini-4-hydrogen-'],
    ['flash38', 'gemini-3.8-flash-'],
  ];
  for (const [fam, prefix] of families) {
    if (lower.startsWith(prefix)) {
      const suffix = lower.slice(prefix.length);
      const tier = parseThinkingEffort(suffix) ?? undefined;
      return { family: fam, ...(tier ? { tier } : {}) };
    }
  }
  return {};
}

/**
 * 当用户通过 `/think` 修改思考强度时，若当前模型属于分档家族（如 4c/4n/4a/4h/3.8f），
 * 自动把模型 ID 同步对齐到该家族对应的强度变体。
 */
export function syncModelWithEffort(
  currentModelId: string | undefined,
  newEffort: ThinkingEffort,
  catalog: readonly ModelCatalogEntry[] = DEFAULT_MODEL_CATALOG,
): string | undefined {
  if (!currentModelId) {
    const hasCarbon = catalog.some((c) => c.id.startsWith('gemini-4-carbon-'));
    const hasNeon = catalog.some((c) => c.id.startsWith('gemini-4-neon-'));
    const defaultFam: TieredFamily = !hasCarbon && hasNeon ? 'neon' : 'carbon';
    return resolveTierForFamily(defaultFam, newEffort, catalog);
  }
  const { family } = detectModelFamilyAndTier(currentModelId);
  if (!family) {
    return currentModelId;
  }
  return resolveTierForFamily(family, newEffort, catalog);
}

export interface AdaptiveModelMatch {
  entry: ModelCatalogEntry;
  inferredEffort?: ThinkingEffort;
}

/**
 * 自适应模型补全解析器：
 * 支持编号（`1`..`18`）、超短代号（`4c`, `4a`, `4h`, `3.8f`, `sonnet`, `opus`）、
 * 家族名（`gemini-4-hydrogen`）、组合简写（`4h xhigh`, `4c-low`, `4a l`）以及模糊子串。
 */
export function resolveAdaptiveModel(
  rawInput: string,
  currentEffort?: ThinkingEffort,
  catalog: readonly ModelCatalogEntry[] = DEFAULT_MODEL_CATALOG,
): { match?: AdaptiveModelMatch; candidates?: ModelCatalogEntry[] } {
  const cleaned = rawInput.trim().toLowerCase();
  if (!cleaned) {
    return {};
  }

  // 1. 纯数字序号（1-based）
  if (/^\d+$/.test(cleaned)) {
    const idx = Number.parseInt(cleaned, 10);
    if (idx >= 1 && idx <= catalog.length) {
      const entry = catalog[idx - 1]!;
      const { tier } = detectModelFamilyAndTier(entry.id);
      return {
        match: {
          entry,
          ...(tier ? { inferredEffort: tier } : {}),
        },
      };
    }
  }

  // 2. 精确模型 ID 命中
  const exact = catalog.find((c) => c.id.toLowerCase() === cleaned);
  if (exact) {
    const { tier } = detectModelFamilyAndTier(exact.id);
    return {
      match: {
        entry: exact,
        ...(tier ? { inferredEffort: tier } : {}),
      },
    };
  }

  // 3. 直接固定别名（sonnet / opus / orch 等，若旧固定 ID 不在实时目录中则自动对齐当前版本变体）
  const directId = DIRECT_MODEL_ALIASES[cleaned];
  if (directId) {
    let entry = catalog.find((c) => c.id === directId);
    if (!entry) {
      if (cleaned.includes('sonnet') || cleaned === 'cs') {
        entry =
          catalog.find((c) => c.id.includes('claude-sonnet') && c.id.endsWith('-medium')) ??
          catalog.find((c) => c.id.includes('claude-sonnet'));
      } else if (cleaned.includes('opus') || cleaned === 'co') {
        entry =
          catalog.find((c) => c.id.includes('claude-opus') && c.id.endsWith('-high')) ??
          catalog.find((c) => c.id.includes('claude-opus'));
      } else if (cleaned.includes('orch')) {
        entry = cleaned.includes('argon') || cleaned === 'orch-a' || cleaned === '4a-orch'
          ? catalog.find((c) => c.id.includes('orchestrator') && (c.id.includes('argon') || c.label.toLowerCase().includes('argon')))
          : catalog.find((c) => c.id.includes('orchestrator'));
      }
    }
    entry ??= { id: directId, label: directId };
    return { match: { entry } };
  }

  // 4. 纯家族简写（如 4c / 4a / 4h / gemini-4-hydrogen / flash）
  const directFamily = FAMILY_ALIASES[cleaned];
  if (directFamily) {
    const resolvedId = resolveTierForFamily(directFamily, currentEffort, catalog);
    const entry = catalog.find((c) => c.id === resolvedId) ?? { id: resolvedId, label: resolvedId };
    return { match: { entry } };
  }

  // 5. 复合简写：`<family>[-_\s:/]+<effort>` 或粘连形式 `4clow` / `4hxh`
  const parts = cleaned.split(/[\s:_/]+/).filter(Boolean);
  if (parts.length === 2) {
    const fam = FAMILY_ALIASES[parts[0]!];
    const eff = parseThinkingEffort(parts[1]!);
    if (fam && eff) {
      const resolvedId = resolveTierForFamily(fam, eff, catalog);
      const entry =
        catalog.find((c) => c.id === resolvedId) ?? { id: resolvedId, label: resolvedId };
      return { match: { entry, inferredEffort: eff } };
    }
    const directWithEffort = DIRECT_MODEL_ALIASES[parts[0]!];
    if (directWithEffort && eff) {
      const entry =
        catalog.find((c) => c.id === directWithEffort) ?? {
          id: directWithEffort,
          label: directWithEffort,
        };
      return { match: { entry, inferredEffort: eff } };
    }
  }

  // 连字符切分末尾强度（例如 `4c-low`, `gemini-4-hydrogen-xh`, `4a-h`）
  const lastDash = cleaned.lastIndexOf('-');
  if (lastDash > 0) {
    const left = cleaned.slice(0, lastDash);
    const right = cleaned.slice(lastDash + 1);
    const fam = FAMILY_ALIASES[left];
    const eff = parseThinkingEffort(right);
    if (fam && eff) {
      const resolvedId = resolveTierForFamily(fam, eff, catalog);
      const entry =
        catalog.find((c) => c.id === resolvedId) ?? { id: resolvedId, label: resolvedId };
      return { match: { entry, inferredEffort: eff } };
    }
  }

  // 紧凑粘连简写（例如 `4cl`, `4cm`, `4nl`, `4ch`, `4hxh`）
  const compactMatch = /^(4c|4n|4a|4h|3\.8f|38f|3f)(xh|xhigh|low|med|medium|high|l|m|h)$/.exec(cleaned);
  if (compactMatch?.[1] && compactMatch[2]) {
    const fam = FAMILY_ALIASES[compactMatch[1]];
    const eff = parseThinkingEffort(compactMatch[2]);
    if (fam && eff) {
      const resolvedId = resolveTierForFamily(fam, eff, catalog);
      const entry =
        catalog.find((c) => c.id === resolvedId) ?? { id: resolvedId, label: resolvedId };
      return { match: { entry, inferredEffort: eff } };
    }
  }

  // 6. 模糊包含匹配：若命中同一家族的多个变体，优先按当前思考强度自动挑中；否则若有唯一匹配直接采用
  const matched = catalog.filter(
    (c) => c.id.toLowerCase().includes(cleaned) || c.label.toLowerCase().includes(cleaned),
  );
  if (matched.length === 1) {
    const only = matched[0]!;
    const { tier } = detectModelFamilyAndTier(only.id);
    return {
      match: {
        entry: only,
        ...(tier ? { inferredEffort: tier } : {}),
      },
    };
  }
  if (matched.length > 1) {
    const families = new Set(matched.map((m) => m.family).filter(Boolean));
    if (families.size === 1) {
      const singleFam = [...families][0] as TieredFamily | undefined;
      if (singleFam && singleFam in FAMILY_PREFIX) {
        const resolvedId = resolveTierForFamily(singleFam, currentEffort, catalog);
        const picked = matched.find((m) => m.id === resolvedId) ?? matched[0]!;
        return { match: { entry: picked } };
      }
    }
    return { candidates: matched };
  }

  return {};
}

export function formatModelDisplay(
  modelId: string | undefined,
  catalog: readonly ModelCatalogEntry[] = DEFAULT_MODEL_CATALOG,
): string {
  if (!modelId) {
    return '默认（跟随本机 CLI 当前配置）';
  }
  const found = catalog.find((c) => c.id === modelId);
  return found ? `${found.label} [${found.id}]` : modelId;
}

/**
 * 解析 `agy models` 命令输出为 `ModelCatalogEntry[]`，并与内置元数据合并。
 */
export function parseAgyModelsOutput(rawOutput: string): ModelCatalogEntry[] {
  const byKnownId = new Map(DEFAULT_MODEL_CATALOG.map((item) => [item.id, item]));
  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Fetching ')) continue;
    const tabIdx = line.indexOf('\t');
    if (tabIdx <= 0) continue;
    const id = line.slice(0, tabIdx).trim();
    const label = line.slice(tabIdx + 1).trim() || id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = byKnownId.get(id);
    const detected = detectModelFamilyAndTier(id);
    entries.push({
      id,
      label,
      ...(known?.family ? { family: known.family } : detected.family ? { family: detected.family } : {}),
      ...(known?.tier
        ? { tier: known.tier }
        : detected.tier && detected.tier !== 'max'
          ? { tier: detected.tier }
          : {}),
    });
  }

  return entries.length > 0 ? entries : [...DEFAULT_MODEL_CATALOG];
}

/**
 * 持久化每个 QQ 用户的模型、思考强度与子智能体模型偏好（存储于 `<dataDir>/preferences.json`）。
 * 与 `sessions.json` 分离存储，使 `/new` 重置会话时不会丢失已选定的模型和思考强度。
 */
export class PeerPreferencesStore {
  readonly filePath: string;
  private readonly prefs = new Map<string, PeerModelPreferences>();
  private readonly logger?: AppLogger;

  constructor(options: { dataDir: string; logger?: AppLogger }) {
    this.filePath = join(options.dataDir, 'preferences.json');
    this.logger = options.logger;
    this.reload();
  }

  get(peerKey: string): PeerModelPreferences | undefined {
    const found = this.prefs.get(peerKey);
    return found ? { ...found } : undefined;
  }

  update(
    peerKey: string,
    patch: {
      model?: string | null;
      effort?: ThinkingEffort | null;
      subagentModel?: string | null;
    },
    now: number = Date.now(),
  ): PeerModelPreferences {
    const current = this.prefs.get(peerKey) ?? { peerKey, updatedAt: now };
    const next: PeerModelPreferences = {
      peerKey,
      ...(patch.model === null
        ? {}
        : patch.model !== undefined
          ? { model: patch.model }
          : current.model
            ? { model: current.model }
            : {}),
      ...(patch.effort === null
        ? {}
        : patch.effort !== undefined
          ? { effort: patch.effort }
          : current.effort
            ? { effort: current.effort }
            : {}),
      ...(patch.subagentModel === null
        ? {}
        : patch.subagentModel !== undefined
          ? { subagentModel: patch.subagentModel }
          : current.subagentModel
            ? { subagentModel: current.subagentModel }
            : {}),
      updatedAt: now,
    };
    this.prefs.set(peerKey, next);
    this.saveToDisk();
    return { ...next };
  }

  reload(): void {
    this.prefs.clear();
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8').trim();
      if (!raw) return;
      const parsed = JSON.parse(raw) as { preferences?: Record<string, PeerModelPreferences> };
      if (parsed && parsed.preferences && typeof parsed.preferences === 'object') {
        for (const [k, v] of Object.entries(parsed.preferences)) {
          if (v && typeof v === 'object') {
            this.prefs.set(k, { ...v, peerKey: k });
          }
        }
      }
    } catch (err) {
      this.logger?.warn?.(
        `[bridge:prefs] Failed to load ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private saveToDisk(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const serialized = `${JSON.stringify(
      {
        version: 1,
        preferences: Object.fromEntries(this.prefs.entries()),
      },
      null,
      2,
    )}\n`;
    const tmpFile = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmpFile, serialized, 'utf8');
    renameSync(tmpFile, this.filePath);
  }
}

export interface ParsedSlashCommand {
  name:
    | 'help'
    | 'status'
    | 'new'
    | 'compact'
    | 'model'
    | 'think'
    | 'submodel'
    | 'tasks'
    | 'cancel'
    | 'update';
  args: string;
}

export interface SelfUpdateResult {
  updated: boolean;
  previousCommit?: string;
  currentCommit: string;
  subject?: string;
}

const SLASH_COMMAND_MAP: Record<string, ParsedSlashCommand['name']> = {
  '/help': 'help',
  '/cmd': 'help',
  '/commands': 'help',
  '/?': 'help',
  '/status': 'status',
  '/info': 'status',
  '/new': 'new',
  '/reset': 'new',
  '/clear': 'new',
  '/compact': 'compact',
  '/model': 'model',
  '/models': 'model',
  '/m': 'model',
  '/think': 'think',
  '/effort': 'think',
  '/t': 'think',
  '/submodel': 'submodel',
  '/sm': 'submodel',
  '/tasks': 'tasks',
  '/cancel': 'cancel',
  '/stop': 'cancel',
  '/update': 'update',
  '/upgrade': 'update',
};

/**
 * 识别入站文本是否为内置桥接斜杠指令（仅匹配纯文本斜杠命令，带图片附件时视为常规多模态对话）。
 */
export function parseBridgeSlashCommand(
  rawText: string,
  hasAttachments: boolean = false,
): ParsedSlashCommand | null {
  if (hasAttachments) {
    return null;
  }
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const spaceIdx = trimmed.search(/\s/);
  const head = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
  const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

  const mapped = SLASH_COMMAND_MAP[head];
  if (!mapped) {
    return null;
  }
  return { name: mapped, args: rest };
}

export function formatModelCatalogText(
  catalog: readonly ModelCatalogEntry[],
  currentModelId?: string,
  currentEffort?: ThinkingEffort,
): string {
  const lines: string[] = [
    '🎛️ 可用模型与自适应简写',
    `当前主模型：${formatModelDisplay(currentModelId, catalog)}`,
    `当前思考强度：${currentEffort ?? '默认（跟随模型档位）'}`,
    '',
  ];

  catalog.forEach((entry, idx) => {
    const marker = entry.id === currentModelId ? '👉 ' : '   ';
    lines.push(`${marker}[${idx + 1}] ${entry.label} (${entry.id})`);
  });

  lines.push(
    '',
    '💡 快捷切换示例：',
    '• 家族简写：/model 4n (或 4c) · /model 4a · /model 4h · /model 3.8f · /model sonnet · /model opus',
    '• 连写强度：/model 4h xhigh · /model 4n-low · /model 4al · /model gemini-4-hydrogen',
    '• 编号或重置：/model 8 · /model auto',
  );

  return lines.join('\n');
}

export function formatSlashHelpText(): string {
  return [
    '⚙️ QQ 桥接快捷指令清单',
    '',
    '• /model [代号|编号|auto] — 查看或切换主聊天模型（别名 /m）',
    '  自适应简写：4n/4c · 4a (Argon) · 4h (Hydrogen) · 3.8f (Flash) · sonnet · opus · orch',
    '  支持连写强度：如 /model 4h xhigh、/model 4n-low、/model 1',
    '• /think [low|medium|high|xhigh|max] — 切换思考强度并自动对齐模型档位（别名 /t, 支持 l/m/h/xh）',
    '• /submodel [代号|auto] — 单独指定后台子智能体模型（如主聊 4n-low 秒回，子任务 4h-high）',
    '• /compact [保留重点] — 压缩当前会话上下文（agy-stream 原地检查点 / agentapi 自动摘要并无缝迁移新桌面会话）',
    '• /new — 开启全新对话上下文（保留已选模型与思考强度，别名 /reset）',
    '• /status — 查看当前会话 ID、模型档位与运行中的后台子任务',
    '• /tasks & /cancel [taskId|all] — 查看或终止运行中的任务（别名 /stop）',
    '• /update — 从 GitHub 拉取最新代码并自动热重启网关生效（保留个人配置与聊天记录）',
  ].join('\n');
}

/**
 * 解析本机 `git` 可执行文件真实路径，解决 Antigravity Desktop Sidecar
 * 子进程 PATH 精简导致 `spawn git ENOENT` 的问题。
 */
export function resolveGitExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.QQBOT_GIT_EXE?.trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const exeNames = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
  const pathRaw = env.PATH ?? env.Path ?? '';
  for (const dir of pathRaw.split(delimiter).map((d) => d.trim()).filter(Boolean)) {
    for (const name of exeNames) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const programFiles = env.ProgramFiles?.trim() || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    const userHome = env.USERPROFILE?.trim() || homedir();
    const programData = env.ProgramData?.trim() || 'C:\\ProgramData';
    candidates.push(
      join(programFiles, 'Git', 'cmd', 'git.exe'),
      join(programFiles, 'Git', 'bin', 'git.exe'),
      join(programFilesX86, 'Git', 'cmd', 'git.exe'),
      join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
      join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
      join(userHome, 'tools', 'git', 'cmd', 'git.exe'),
      join(userHome, 'scoop', 'shims', 'git.exe'),
      join(userHome, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
      join(programData, 'chocolatey', 'bin', 'git.exe'),
    );
  } else {
    candidates.push(
      '/usr/bin/git',
      '/usr/local/bin/git',
      '/opt/homebrew/bin/git',
      join(homedir(), '.local', 'bin', 'git'),
    );
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return null;
}

function resolveNpmCommandArgs(nodeExe: string = process.execPath): {
  file: string;
  prefixArgs: string[];
} {
  const npmCli = join(dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmCli)) {
    return { file: nodeExe, prefixArgs: [npmCli] };
  }
  const npmUnix = resolve(dirname(nodeExe), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmUnix)) {
    return { file: nodeExe, prefixArgs: [npmUnix] };
  }
  return {
    file: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefixArgs: [],
  };
}

function parseGitHubRepoSlug(repoRoot: string): { owner: string; repo: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      repository?: string | { url?: string };
    };
    const rawUrl =
      typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    const match = /github\.com[:/]([^/\s]+)\/([^/\s#?.]+?)(?:\.git)?(?:[#?].*)?$/i.exec(rawUrl);
    if (match?.[1] && match?.[2]) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {
    // ignore invalid package.json
  }
  return null;
}

async function runArchiveSelfUpdateFallback(
  repoRoot: string,
  runCmd: (
    file: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>,
): Promise<SelfUpdateResult> {
  const slug = parseGitHubRepoSlug(repoRoot) ?? { owner: 'Shiratsuk1', repo: 'agy-qqbot' };
  const apiUrl = `https://api.github.com/repos/${slug.owner}/${slug.repo}/commits/main`;
  const commitRes = await fetch(apiUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agy-qqbot-updater' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!commitRes.ok) {
    throw new Error(`未找到本机 git 且查询 GitHub 最新版本失败 (HTTP ${commitRes.status})`);
  }
  const commitJson = (await commitRes.json()) as {
    sha?: string;
    commit?: { message?: string };
  };
  const remoteSha = (commitJson.sha ?? '').slice(0, 7) || 'latest';
  const subject = (commitJson.commit?.message ?? '').split(/\r?\n/)[0]?.trim();

  const tarUrl = `https://codeload.github.com/${slug.owner}/${slug.repo}/tar.gz/refs/heads/main`;
  const tarRes = await fetch(tarUrl, {
    headers: { 'User-Agent': 'agy-qqbot-updater' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!tarRes.ok) {
    throw new Error(`下载 GitHub 更新包失败 (HTTP ${tarRes.status})`);
  }
  const tarBytes = Buffer.from(await tarRes.arrayBuffer());
  const stageDir = mkdtempSync(join(tmpdir(), 'agy-qqbot-upd-'));
  try {
    const tgzPath = join(stageDir, 'update.tgz');
    writeFileSync(tgzPath, tarBytes);
    const tarExe =
      process.platform === 'win32' && existsSync('C:\\Windows\\System32\\tar.exe')
        ? 'C:\\Windows\\System32\\tar.exe'
        : 'tar';
    await runCmd(tarExe, ['-xzf', tgzPath, '-C', stageDir], stageDir);

    const extractedRootName = readdirSync(stageDir).find(
      (name) => name !== 'update.tgz' && existsSync(join(stageDir, name, 'package.json')),
    );
    if (!extractedRootName) {
      throw new Error('解压 GitHub 更新包失败：未找到有效仓库根目录');
    }
    const extractedRoot = join(stageDir, extractedRootName);
    const preserveNames = new Set([
      '.env',
      '.env.local',
      '.qqbot-data',
      '.git',
      'node_modules',
    ]);
    for (const entryName of readdirSync(extractedRoot)) {
      if (preserveNames.has(entryName)) continue;
      cpSync(join(extractedRoot, entryName), join(repoRoot, entryName), {
        recursive: true,
        force: true,
      });
    }

    const npmCmd = resolveNpmCommandArgs();
    await runCmd(npmCmd.file, [...npmCmd.prefixArgs, 'install', '--no-audit', '--no-fund'], repoRoot);
    await runCmd(process.execPath, ['scripts/install-plugin.ts'], repoRoot);

    return {
      updated: true,
      previousCommit: 'archive',
      currentCommit: remoteSha,
      ...(subject ? { subject } : {}),
    };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/**
 * 在源码仓库目录执行 `git pull --ff-only` 自更新，若依赖变更自动重装并同步插件清单；
 * 若 Sidecar 找不到 `git` 或未保留 `.git`，自动降级为从 GitHub 拉取归档安全更新。
 */
export async function runRepoSelfUpdate(options?: {
  repoRoot?: string;
  gitExe?: string;
  execCmd?: (
    file: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
}): Promise<SelfUpdateResult> {
  const repoRoot = options?.repoRoot ?? resolve(import.meta.dirname, '../..');
  const runCmd =
    options?.execCmd ??
    (async (file: string, args: readonly string[], cwd: string) => {
      const res = await execFileAsync(file, [...args], {
        cwd,
        windowsHide: true,
        timeout: 120_000,
      });
      return { stdout: String(res.stdout), stderr: String(res.stderr) };
    });

  const gitBin =
    options?.gitExe ?? (options?.execCmd ? 'git' : resolveGitExecutable());
  if (!gitBin || (!options?.execCmd && !existsSync(join(repoRoot, '.git')))) {
    return runArchiveSelfUpdateFallback(repoRoot, runCmd);
  }

  const beforeSha = (await runCmd(gitBin, ['rev-parse', '--short', 'HEAD'], repoRoot)).stdout.trim();
  await runCmd(gitBin, ['pull', '--ff-only'], repoRoot);
  const afterSha = (await runCmd(gitBin, ['rev-parse', '--short', 'HEAD'], repoRoot)).stdout.trim();

  if (beforeSha === afterSha) {
    return {
      updated: false,
      currentCommit: afterSha,
    };
  }

  const subject = (
    await runCmd(gitBin, ['log', '-1', '--pretty=format:%s'], repoRoot)
  ).stdout.trim();
  const changedFiles = (
    await runCmd(gitBin, ['diff', '--name-only', beforeSha, afterSha], repoRoot)
  ).stdout
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);

  if (changedFiles.some((f) => f === 'package.json' || f === 'package-lock.json')) {
    const npmCmd = options?.execCmd
      ? { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [] as string[] }
      : resolveNpmCommandArgs();
    await runCmd(npmCmd.file, [...npmCmd.prefixArgs, 'install', '--no-audit', '--no-fund'], repoRoot);
  }

  await runCmd(process.execPath, ['scripts/install-plugin.ts'], repoRoot);

  return {
    updated: true,
    previousCommit: beforeSha,
    currentCommit: afterSha,
    ...(subject ? { subject } : {}),
  };
}
