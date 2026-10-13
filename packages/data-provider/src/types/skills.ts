import type { FileSources } from './files';

/**
 * Shared skill validation constants — the single source of truth for name,
 * description, title, body, and file-path length limits. Mirrored by
 * `packages/data-schemas/src/methods/skill.ts`; whenever those constants
 * change, the DB-side validators MUST be updated to match.
 *
 * Exported from `librechat-data-provider` so both frontend form validators
 * and backend Mongoose pre-save hooks use the same literals.
 */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_DESCRIPTION_SHORT_THRESHOLD = 20;
export const SKILL_DISPLAY_TITLE_MAX_LENGTH = 128;
export const SKILL_BODY_MAX_LENGTH = 100_000;

/**
 * Kebab-case identifier pattern: must start with a lowercase letter or digit,
 * and contain only lowercase letters, digits, and hyphens. Mirrors the
 * backend `SKILL_NAME_PATTERN` in `packages/data-schemas/src/methods/skill.ts`.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Source of a skill — where its canonical definition came from.
 * `inline` means the skill was authored directly in LibreChat.
 * `github` / `notion` are reserved for future sync integrations.
 */
export type SkillSource = 'inline' | 'github' | 'notion';

/** Visibility scope for skills. Missing legacy values are treated as `private`. */
export type SkillVisibility = 'private' | 'global';

/**
 * Category inferred from a skill file's top-level directory prefix.
 * `script` for `scripts/...`, `reference` for `references/...`, `asset` for `assets/...`,
 * everything else (including root-level files) is `other`.
 */
export type SkillFileCategory = 'script' | 'reference' | 'asset' | 'other';

/**
 * Allowed value types inside a skill's YAML frontmatter.
 * Kept strict so callers cannot slip arbitrary `unknown` payloads through the API.
 */
export type SkillFrontmatterValue = string | number | boolean | string[] | null;

/**
 * Structured YAML frontmatter for a skill. All keys are optional on the wire
 * because not every skill document carries a complete frontmatter block —
 * `name` and `description` live as first-class columns on `TSkill` itself,
 * and frontmatter is an extension bag for additional fields like `when-to-use`,
 * `allowed-tools`, etc.
 */
export type SkillFrontmatter = {
  name?: string;
  description?: string;
} & Record<string, SkillFrontmatterValue | undefined>;

/**
 * Provenance metadata for skills that originated from an external source
 * (e.g. a GitHub commit SHA or a Notion page id).
 *
 * Reserved for phase 2+ external sync — no code path currently populates this
 * in phase 1, but the column exists so a future sync worker can use it
 * without a schema migration.
 */
export type SkillSourceMetadata = Record<string, string | number | boolean>;

/**
 * A non-blocking coaching hint surfaced alongside a successful create/update
 * response. Unlike validation errors (which return 400 and block the write),
 * warnings ride on the 2xx response so the UI can show inline feedback
 * without rejecting the user's input. Example: "description is too short,
 * Claude may undertrigger this skill".
 */
export type TSkillWarning = {
  field: string;
  code: string;
  message: string;
  severity: 'warning';
};

/**
 * API shape for a full skill (returned by GET `/api/skills/:id`).
 *
 * Field semantics:
 * - `name` is the machine-readable kebab-case identifier Claude sees in its
 *   skill manifest. It's what drives triggering and must be stable across
 *   edits. Unique per author+tenant.
 * - `displayTitle` is the human-readable UI label only. NOT sent to Claude,
 *   NOT part of the trigger path — purely cosmetic.
 * - `description` is the "when to use this skill" sentence. Highest-leverage
 *   field for trigger accuracy; a short/vague one causes undertriggering.
 * - `frontmatter` is the structured YAML bag minus `name`/`description`
 *   (those live as top-level columns). Validated strictly against a known
 *   key set server-side.
 * - `source`/`sourceMetadata` are reserved for phase 2+ external sync and
 *   always `'inline'` / absent in phase 1.
 */
/**
 * 固定业务类别清单（运营按部门/平台归类用）。仅用于展示与筛选，
 * 不参与 Skill 调用 / resolver / ACL。管理员不可自由输入，只能从此列表多选。
 */
export const SKILL_CATEGORIES = [
  '营销',
  '天猫淘宝',
  '京东',
  '拼多多',
  '小红书',
  '视频号',
  '抖音',
  '财务',
  '人力',
  '供应链',
  '客服',
  '设计',
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** 一个 Skill 最多可选的类别数。 */
export const SKILL_CATEGORIES_MAX = 5;

/**
 * 归一化业务类别：保证为 string[]、仅保留固定清单内的值、去重、最多 5 个。
 * 兼容历史单值 `category`：当 categories 为空时回退到 fallbackCategory。
 */
export function normalizeSkillCategories(
  value: unknown,
  fallbackCategory?: string | null,
): string[] {
  const allowed = new Set<string>(SKILL_CATEGORIES);
  const source = Array.isArray(value)
    ? value
    : fallbackCategory != null && fallbackCategory !== ''
      ? [fallbackCategory]
      : [];
  const result: string[] = [];
  for (const item of source) {
    if (typeof item === 'string' && allowed.has(item) && !result.includes(item)) {
      result.push(item);
    }
    if (result.length >= SKILL_CATEGORIES_MAX) {
      break;
    }
  }
  return result;
}

export type TSkill = {
  _id: string;
  name: string;
  displayTitle?: string;
  description: string;
  body: string;
  frontmatter?: SkillFrontmatter;
  category?: string;
  /** 业务类别（多选，固定清单）。仅展示/筛选用，不参与调用链。 */
  categories?: string[];
  /**
   * @deprecated Replaced by the persisted `userInvocable` /
   * `disableModelInvocation` pair derived from frontmatter. Retained
   * temporarily so older form code that hasn't migrated still type-checks;
   * the backend no longer reads or writes it.
   */
  invocationMode?: import('../types').InvocationMode;
  /**
   * Mirrors the `disable-model-invocation` frontmatter field. `true` means
   * the model can no longer invoke this skill via the `skill` tool and the
   * skill is excluded from the catalog injected into the system prompt.
   * Manual `$` invocation is unaffected.
   */
  disableModelInvocation?: boolean;
  /**
   * Mirrors the `user-invocable` frontmatter field. `false` hides the skill
   * from the `$` popover and rejects manual invocation. Defaults to `true`.
   */
  userInvocable?: boolean;
  /**
   * Skill-declared tool allowlist (mirrors the `allowed-tools` frontmatter
   * field). When the skill is invoked, these tools are unioned into the
   * agent's effective tool set for the turn. Tolerant of unknown names —
   * the runtime intersects against the loaded tool registry, so skills
   * referencing yet-to-be-implemented tools import without breaking.
   */
  allowedTools?: string[];
  visibility?: SkillVisibility;
  author: string;
  authorName: string;
  version: number;
  source: SkillSource;
  sourceMetadata?: SkillSourceMetadata;
  fileCount: number;
  /**
   * When `true`, the skill auto-primes into every turn — no user `$` picks
   * or model discretion required. Surfaced on the list view so the UI can
   * show a pin badge on rows that apply ambiently.
   */
  alwaysApply?: boolean;
  isPublic?: boolean;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Present on POST/PATCH responses when the server emitted non-blocking
   * coaching warnings (e.g. description too short). Never present on GET
   * responses.
   */
  warnings?: TSkillWarning[];
};

/**
 * Summary shape used in list endpoints — omits `body` and `frontmatter` to keep
 * list payloads small. Callers that need the full body/frontmatter must fetch
 * the detail via `GET /api/skills/:id`.
 */
export type TSkillSummary = Omit<TSkill, 'body' | 'frontmatter'>;

/**
 * Metadata for a single file bundled inside a skill.
 * File content itself is fetched separately via the file download endpoint.
 */
export type TSkillFile = {
  _id: string;
  skillId: string;
  relativePath: string;
  file_id: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  source: FileSources;
  mimeType: string;
  bytes: number;
  category: SkillFileCategory;
  isExecutable: boolean;
  author: string;
  tenantId?: string;
  /** Lazily cached text content (≤ 512 KB). Excluded from list responses. */
  content?: string;
  /** Set on first read. `true` prevents repeated storage reads for non-text files. */
  isBinary?: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Request body for POST `/api/skills`. */
export type TCreateSkill = {
  name: string;
  displayTitle?: string;
  description: string;
  body: string;
  frontmatter?: Partial<SkillFrontmatter>;
  category?: string;
  categories?: string[];
  visibility?: SkillVisibility;
  /** When `true`, the skill auto-primes into every turn (mirrors `always-apply` frontmatter). */
  alwaysApply?: boolean;
};

/** Partial payload for PATCH `/api/skills/:id` — all fields optional. */
export type TUpdateSkillPayload = {
  name?: string;
  displayTitle?: string;
  description?: string;
  body?: string;
  frontmatter?: Partial<SkillFrontmatter>;
  category?: string;
  categories?: string[];
  visibility?: SkillVisibility;
  alwaysApply?: boolean;
};

/** Variables passed into the update mutation: id + expectedVersion + partial payload. */
export type TUpdateSkillVariables = {
  id: string;
  expectedVersion: number;
  payload: TUpdateSkillPayload;
};

/** Response from a successful PATCH — includes the bumped version. */
export type TUpdateSkillResponse = TSkill;

/** Response from a 409 concurrency conflict — includes the current authoritative state. */
export type TSkillConflictResponse = {
  error: 'skill_version_conflict';
  current: TSkill;
};

/** Query params for GET `/api/skills` (list). */
export type TSkillListRequest = {
  category?: string;
  search?: string;
  limit?: number;
  cursor?: string;
};

/** Paginated list response. `after` is the cursor to pass for the next page. */
export type TSkillListResponse = {
  skills: TSkillSummary[];
  has_more: boolean;
  after: string | null;
};

/** Response from DELETE `/api/skills/:id`. */
export type TDeleteSkillResponse = {
  id: string;
  deleted: true;
};

/** Response from GET `/api/skills/:id/files`. */
export type TListSkillFilesResponse = {
  files: TSkillFile[];
};

/**
 * Upload body for POST `/api/skills/:id/files`.
 * In phase 1 the backend responds with 501; the client contract is still defined here
 * so hooks are stable when the upload pipeline is wired up in phase 2.
 */
export type TUploadSkillFilePayload = {
  relativePath: string;
};

/** Response from DELETE `/api/skills/:id/files/:relativePath`. */
export type TDeleteSkillFileResponse = {
  skillId: string;
  relativePath: string;
  deleted: true;
};

/** Response from GET `/api/skills/:id/files/:relativePath` (JSON mode). */
export type TSkillFileContentResponse = {
  content?: string;
  mimeType: string;
  isBinary: boolean;
  relativePath: string;
  filename: string;
  bytes: number;
};

/** Variables passed into the skill file upload mutation. */
export type TUploadSkillFileVariables = {
  skillId: string;
  formData: FormData;
};

/** Variables passed into the skill file delete mutation. */
export type TDeleteSkillFileVariables = {
  skillId: string;
  relativePath: string;
};

/**
 * Per-user skill active/inactive overrides (GET response and POST body payload).
 * Key = skill ObjectId string, value = explicit active state.
 * Skills absent from the map use the ownership-based default:
 * owned = active, shared = `defaultActiveOnShare` from config.
 */
export type TSkillStatesResponse = Record<string, boolean>;
