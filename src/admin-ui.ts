import type { NextFunction, Request, Response } from 'express';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseDocument } from 'yaml';
import { CONFIG_FILE_PATH, CONFIG_TEMPLATE_PATH, getConfig, initConfigWatcher, reloadConfigFromDisk, stopConfigWatcher } from './config.js';
import { getProxyPoolStatusSnapshot } from './proxy-agent.js';
import { validateHttpProxyUrl } from './proxy-pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, '..', 'public');

type StringList = string[];

interface EditableYamlConfig {
    port: number;
    timeout: number;
    proxy: string;
    proxy_pool: {
        enabled: boolean;
        urls: StringList;
        cooldown_seconds: number;
        health_check: {
            enabled: boolean;
            interval_seconds: number;
            url: string;
        };
    };
    cursor_model: string;
    auth_tokens: StringList;
    max_auto_continue: number;
    max_history_messages: number;
    thinking: {
        enabled: boolean;
    };
    compression: {
        enabled: boolean;
        level: 1 | 2 | 3;
        keep_recent: number;
        early_msg_max_chars: number;
    };
    tools: {
        schema_mode: 'compact' | 'full' | 'names_only';
        description_max_length: number;
        passthrough: boolean;
        disabled: boolean;
        include_only: StringList;
        exclude: StringList;
    };
    sanitize_response: boolean;
    fixed_fallback_responses: boolean;
    refusal_patterns: StringList;
    fingerprint: {
        user_agent: string;
    };
    vision: {
        enabled: boolean;
        mode: 'ocr' | 'api';
        base_url: string;
        api_key: string;
        model: string;
        proxy: string;
    };
    logging: {
        file_enabled: boolean;
        dir: string;
        max_days: number;
        persist_mode: 'compact' | 'full' | 'summary';
    };
}

type ValidationErrors = Record<string, string>;

const RESTART_REQUIRED_FIELDS = ['port'];
const LIVE_RELOAD_FIELDS = [
    'timeout',
    'proxy',
    'proxy_pool.enabled',
    'proxy_pool.urls',
    'proxy_pool.cooldown_seconds',
    'proxy_pool.health_check.enabled',
    'proxy_pool.health_check.interval_seconds',
    'proxy_pool.health_check.url',
    'cursor_model',
    'auth_tokens',
    'max_auto_continue',
    'max_history_messages',
    'thinking.enabled',
    'compression.enabled',
    'compression.level',
    'compression.keep_recent',
    'compression.early_msg_max_chars',
    'tools.schema_mode',
    'tools.description_max_length',
    'tools.passthrough',
    'tools.disabled',
    'tools.include_only',
    'tools.exclude',
    'sanitize_response',
    'fixed_fallback_responses',
    'refusal_patterns',
    'fingerprint.user_agent',
    'vision.enabled',
    'vision.mode',
    'vision.base_url',
    'vision.api_key',
    'vision.model',
    'vision.proxy',
    'logging.file_enabled',
    'logging.dir',
    'logging.max_days',
    'logging.persist_mode',
];

const ENV_OVERRIDE_MAP: Record<string, string> = {
    port: 'PORT',
    timeout: 'TIMEOUT',
    proxy: 'PROXY',
    cursor_model: 'CURSOR_MODEL',
    auth_tokens: 'AUTH_TOKEN',
    max_auto_continue: 'MAX_AUTO_CONTINUE',
    max_history_messages: 'MAX_HISTORY_MESSAGES',
    'thinking.enabled': 'THINKING_ENABLED',
    'compression.enabled': 'COMPRESSION_ENABLED',
    'compression.level': 'COMPRESSION_LEVEL',
    'tools.passthrough': 'TOOLS_PASSTHROUGH',
    'tools.disabled': 'TOOLS_DISABLED',
    'logging.file_enabled': 'LOG_FILE_ENABLED',
    'logging.dir': 'LOG_DIR',
    'logging.persist_mode': 'LOG_PERSIST_MODE',
    sanitize_response: 'SANITIZE_RESPONSE',
    fixed_fallback_responses: 'FIXED_FALLBACK_RESPONSES',
    'fingerprint.user_agent': 'FP',
};

function readPublicFile(filename: string): string {
    return readFileSync(join(publicDir, filename), 'utf-8');
}

function getRequestToken(req: Request): string | undefined {
    const tokenFromQuery = req.query.token as string | undefined;
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    const tokenFromHeader = authHeader ? String(authHeader).replace(/^Bearer\s+/i, '').trim() : undefined;
    return tokenFromQuery || tokenFromHeader;
}

function isPageRequest(req: Request): boolean {
    return req.method === 'GET' && !req.path.startsWith('/api/');
}

function normalizePath(value: string): string {
    return value.startsWith('/') ? value : '/' + value;
}

function buildAdminPath(tab: 'overview' | 'logs' | 'config', token?: string): string {
    const params = new URLSearchParams({ tab });
    if (token) params.set('token', token);
    return '/admin?' + params.toString();
}

export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
    const tokens = getConfig().authTokens;
    if (!tokens || tokens.length === 0) {
        next();
        return;
    }

    const token = getRequestToken(req);
    if (!token) {
        if (isPageRequest(req)) {
            serveDashboardLogin(req, res);
            return;
        }
        res.status(401).json({ error: { message: 'Missing authentication token. Use ?token=xxx or Authorization: Bearer <token>', type: 'auth_error' } });
        return;
    }

    if (!tokens.includes(token)) {
        if (isPageRequest(req)) {
            serveDashboardLogin(req, res);
            return;
        }
        res.status(403).json({ error: { message: 'Invalid authentication token', type: 'auth_error' } });
        return;
    }

    next();
}

export function serveDashboardLogin(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(readPublicFile('login.html'));
}

export function serveAdminUi(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(readPublicFile('admin.html'));
}

export function redirectLogsToAdmin(req: Request, res: Response): void {
    res.redirect(302, buildAdminPath('logs', getRequestToken(req)));
}

function asObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringList(value: unknown): StringList {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item).trim()).filter(Boolean);
}

function getDefaultEditableConfig(): EditableYamlConfig {
    return {
        port: 3010,
        timeout: 120,
        proxy: '',
        proxy_pool: {
            enabled: false,
            urls: [],
            cooldown_seconds: 30,
            health_check: {
                enabled: false,
                interval_seconds: 60,
                url: 'http://cp.cloudflare.com/generate_204',
            },
        },
        cursor_model: 'anthropic/claude-sonnet-4.6',
        auth_tokens: [],
        max_auto_continue: 0,
        max_history_messages: -1,
        thinking: { enabled: false },
        compression: {
            enabled: false,
            level: 1,
            keep_recent: 10,
            early_msg_max_chars: 4000,
        },
        tools: {
            schema_mode: 'full',
            description_max_length: 0,
            passthrough: false,
            disabled: false,
            include_only: [],
            exclude: [],
        },
        sanitize_response: false,
        fixed_fallback_responses: true,
        refusal_patterns: [],
        fingerprint: {
            user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
        vision: {
            enabled: true,
            mode: 'ocr',
            base_url: 'https://api.openai.com/v1/chat/completions',
            api_key: '',
            model: 'gpt-4o-mini',
            proxy: '',
        },
        logging: {
            file_enabled: false,
            dir: './logs',
            max_days: 7,
            persist_mode: 'summary',
        },
    };
}

function getConfigSourcePath(): string | null {
    if (existsSync(CONFIG_FILE_PATH)) return CONFIG_FILE_PATH;
    if (existsSync(CONFIG_TEMPLATE_PATH)) return CONFIG_TEMPLATE_PATH;
    return null;
}

function createConfigDocument() {
    const sourcePath = getConfigSourcePath();
    if (!sourcePath) return parseDocument('');
    return parseDocument(readFileSync(sourcePath, 'utf-8'));
}

function readEditableConfigFile(): { config: EditableYamlConfig; fileExists: boolean } {
    const fallback = getDefaultEditableConfig();
    const raw = asObject(createConfigDocument().toJSON());

    const thinking = asObject(raw.thinking);
    const compression = asObject(raw.compression);
    const tools = asObject(raw.tools);
    const fingerprint = asObject(raw.fingerprint);
    const vision = asObject(raw.vision);
    const logging = asObject(raw.logging);
    const proxyPool = asObject(raw.proxy_pool);
    const proxyPoolHealthCheck = asObject(proxyPool.health_check);

    return {
        fileExists: existsSync(CONFIG_FILE_PATH),
        config: {
            port: asInt(raw.port, fallback.port),
            timeout: asInt(raw.timeout, fallback.timeout),
            proxy: asString(raw.proxy, fallback.proxy),
            proxy_pool: {
                enabled: asBoolean(proxyPool.enabled, fallback.proxy_pool.enabled),
                urls: asStringList(proxyPool.urls),
                cooldown_seconds: asInt(proxyPool.cooldown_seconds, fallback.proxy_pool.cooldown_seconds),
                health_check: {
                    enabled: asBoolean(proxyPoolHealthCheck.enabled, fallback.proxy_pool.health_check.enabled),
                    interval_seconds: asInt(proxyPoolHealthCheck.interval_seconds, fallback.proxy_pool.health_check.interval_seconds),
                    url: asString(proxyPoolHealthCheck.url, fallback.proxy_pool.health_check.url),
                },
            },
            cursor_model: asString(raw.cursor_model, fallback.cursor_model),
            auth_tokens: asStringList(raw.auth_tokens),
            max_auto_continue: asInt(raw.max_auto_continue, fallback.max_auto_continue),
            max_history_messages: asInt(raw.max_history_messages, fallback.max_history_messages),
            thinking: {
                enabled: asBoolean(thinking.enabled, fallback.thinking.enabled),
            },
            compression: {
                enabled: asBoolean(compression.enabled, fallback.compression.enabled),
                level: [1, 2, 3].includes(asInt(compression.level, fallback.compression.level))
                    ? asInt(compression.level, fallback.compression.level) as 1 | 2 | 3
                    : fallback.compression.level,
                keep_recent: asInt(compression.keep_recent, fallback.compression.keep_recent),
                early_msg_max_chars: asInt(compression.early_msg_max_chars, fallback.compression.early_msg_max_chars),
            },
            tools: {
                schema_mode: ['compact', 'full', 'names_only'].includes(asString(tools.schema_mode, fallback.tools.schema_mode))
                    ? asString(tools.schema_mode, fallback.tools.schema_mode) as EditableYamlConfig['tools']['schema_mode']
                    : fallback.tools.schema_mode,
                description_max_length: asInt(tools.description_max_length, fallback.tools.description_max_length),
                passthrough: asBoolean(tools.passthrough, fallback.tools.passthrough),
                disabled: asBoolean(tools.disabled, fallback.tools.disabled),
                include_only: asStringList(tools.include_only),
                exclude: asStringList(tools.exclude),
            },
            sanitize_response: asBoolean(raw.sanitize_response, fallback.sanitize_response),
            fixed_fallback_responses: asBoolean(raw.fixed_fallback_responses, fallback.fixed_fallback_responses),
            refusal_patterns: asStringList(raw.refusal_patterns),
            fingerprint: {
                user_agent: asString(fingerprint.user_agent, fallback.fingerprint.user_agent),
            },
            vision: {
                enabled: asBoolean(vision.enabled, fallback.vision.enabled),
                mode: ['ocr', 'api'].includes(asString(vision.mode, fallback.vision.mode))
                    ? asString(vision.mode, fallback.vision.mode) as EditableYamlConfig['vision']['mode']
                    : fallback.vision.mode,
                base_url: asString(vision.base_url, fallback.vision.base_url),
                api_key: asString(vision.api_key, fallback.vision.api_key),
                model: asString(vision.model, fallback.vision.model),
                proxy: asString(vision.proxy, fallback.vision.proxy),
            },
            logging: {
                file_enabled: asBoolean(logging.file_enabled, fallback.logging.file_enabled),
                dir: asString(logging.dir, fallback.logging.dir),
                max_days: asInt(logging.max_days, fallback.logging.max_days),
                persist_mode: ['compact', 'full', 'summary'].includes(asString(logging.persist_mode, fallback.logging.persist_mode))
                    ? asString(logging.persist_mode, fallback.logging.persist_mode) as EditableYamlConfig['logging']['persist_mode']
                    : fallback.logging.persist_mode,
            },
        },
    };
}

function buildEnvOverrides(): Record<string, { envVar: string; value: string }> {
    const overrides: Record<string, { envVar: string; value: string }> = {};

    for (const [path, envVar] of Object.entries(ENV_OVERRIDE_MAP)) {
        const value = process.env[envVar];
        if (value === undefined) continue;
        overrides[path] = {
            envVar,
            value: envVar === 'FP' ? '[base64 JSON]' : value,
        };
    }

    return overrides;
}

function buildWarnings(fileExists: boolean): string[] {
    const warnings: string[] = [];
    if (!fileExists) {
        warnings.push('config.yaml 当前不存在，首次保存将基于 config.yaml.example 生成。');
    }
    if (!existsSync(CONFIG_TEMPLATE_PATH)) {
        warnings.push('config.yaml.example 当前不存在，后台将使用内置默认配置生成新文件。');
    }
    if (!getConfig().authTokens?.length) {
        warnings.push('当前未配置 auth_tokens。后台和 API 在公网暴露时存在明显风险。');
    }
    return warnings;
}

function buildConfigMeta(fileExists: boolean) {
    const overrides = buildEnvOverrides();
    return {
        fileExists,
        warnings: buildWarnings(fileExists),
        envOverrides: overrides,
        overriddenFields: Object.keys(overrides),
        restartRequiredFields: RESTART_REQUIRED_FIELDS,
        liveReloadFields: LIVE_RELOAD_FIELDS,
        authConfigured: Boolean(getConfig().authTokens?.length),
    };
}

function setOptionalString(doc: ReturnType<typeof parseDocument>, path: string[], value: string): void {
    if (value.trim()) {
        doc.setIn(path, value.trim());
        return;
    }
    doc.deleteIn(path);
}

function setOptionalStringList(doc: ReturnType<typeof parseDocument>, path: string[], value: StringList): void {
    if (value.length > 0) {
        doc.setIn(path, value);
        return;
    }
    doc.deleteIn(path);
}

function setNumberOrDelete(doc: ReturnType<typeof parseDocument>, path: string[], value: number, defaultValue: number): void {
    if (value === defaultValue) {
        doc.deleteIn(path);
        return;
    }
    doc.setIn(path, value);
}

function validateConfig(input: unknown): { config?: EditableYamlConfig; errors: ValidationErrors } {
    const raw = asObject(input);
    const normalized = getDefaultEditableConfig();
    const errors: ValidationErrors = {};

    normalized.port = asInt(raw.port, normalized.port);
    if (!Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535) {
        errors.port = 'port 必须是 1 到 65535 之间的整数。';
    }

    normalized.timeout = asInt(raw.timeout, normalized.timeout);
    if (!Number.isInteger(normalized.timeout) || normalized.timeout <= 0) {
        errors.timeout = 'timeout 必须是正整数。';
    }

    normalized.proxy = asString(raw.proxy, '').trim();
    if (normalized.proxy) {
        const proxyError = validateHttpProxyUrl(normalized.proxy);
        if (proxyError) errors.proxy = proxyError;
    }

    const proxyPool = asObject(raw.proxy_pool);
    const proxyPoolHealthCheck = asObject(proxyPool.health_check);
    normalized.proxy_pool.enabled = asBoolean(proxyPool.enabled, normalized.proxy_pool.enabled);
    normalized.proxy_pool.urls = asStringList(proxyPool.urls);
    normalized.proxy_pool.cooldown_seconds = asInt(proxyPool.cooldown_seconds, normalized.proxy_pool.cooldown_seconds);
    normalized.proxy_pool.health_check.enabled = asBoolean(proxyPoolHealthCheck.enabled, normalized.proxy_pool.health_check.enabled);
    normalized.proxy_pool.health_check.interval_seconds = asInt(proxyPoolHealthCheck.interval_seconds, normalized.proxy_pool.health_check.interval_seconds);
    normalized.proxy_pool.health_check.url = asString(proxyPoolHealthCheck.url, normalized.proxy_pool.health_check.url).trim();

    if (!Number.isInteger(normalized.proxy_pool.cooldown_seconds) || normalized.proxy_pool.cooldown_seconds <= 0) {
        errors['proxy_pool.cooldown_seconds'] = 'proxy_pool.cooldown_seconds 必须是正整数。';
    }
    if (!Number.isInteger(normalized.proxy_pool.health_check.interval_seconds) || normalized.proxy_pool.health_check.interval_seconds <= 0) {
        errors['proxy_pool.health_check.interval_seconds'] = 'proxy_pool.health_check.interval_seconds 必须是正整数。';
    }
    if (!normalized.proxy_pool.health_check.url) {
        errors['proxy_pool.health_check.url'] = 'proxy_pool.health_check.url 不能为空。';
    } else if (!/^https?:\/\//i.test(normalized.proxy_pool.health_check.url)) {
        errors['proxy_pool.health_check.url'] = 'proxy_pool.health_check.url 必须是 http:// 或 https:// 地址。';
    }
    for (const [index, url] of normalized.proxy_pool.urls.entries()) {
        const proxyError = validateHttpProxyUrl(url);
        if (proxyError) {
            errors['proxy_pool.urls'] = `第 ${index + 1} 个代理地址无效：${proxyError}`;
            break;
        }
    }
    if (normalized.proxy_pool.enabled && normalized.proxy_pool.urls.length === 0) {
        errors['proxy_pool.urls'] = '启用代理池时，至少需要配置一个 http:// 或 https:// 代理地址。';
    }

    normalized.cursor_model = asString(raw.cursor_model, '').trim();
    if (!normalized.cursor_model) {
        errors.cursor_model = 'cursor_model 不能为空。';
    }

    normalized.auth_tokens = asStringList(raw.auth_tokens);

    normalized.max_auto_continue = asInt(raw.max_auto_continue, normalized.max_auto_continue);
    if (!Number.isInteger(normalized.max_auto_continue) || normalized.max_auto_continue < 0) {
        errors.max_auto_continue = 'max_auto_continue 必须是大于等于 0 的整数。';
    }

    normalized.max_history_messages = asInt(raw.max_history_messages, normalized.max_history_messages);
    if (!Number.isInteger(normalized.max_history_messages) || normalized.max_history_messages < -1) {
        errors.max_history_messages = 'max_history_messages 必须是 -1 或非负整数。';
    }

    const thinking = asObject(raw.thinking);
    normalized.thinking.enabled = asBoolean(thinking.enabled, normalized.thinking.enabled);

    const compression = asObject(raw.compression);
    normalized.compression.enabled = asBoolean(compression.enabled, normalized.compression.enabled);
    normalized.compression.level = asInt(compression.level, normalized.compression.level) as 1 | 2 | 3;
    if (![1, 2, 3].includes(normalized.compression.level)) {
        errors['compression.level'] = 'compression.level 只能是 1、2 或 3。';
    }
    normalized.compression.keep_recent = asInt(compression.keep_recent, normalized.compression.keep_recent);
    if (!Number.isInteger(normalized.compression.keep_recent) || normalized.compression.keep_recent < 0) {
        errors['compression.keep_recent'] = 'compression.keep_recent 必须是非负整数。';
    }
    normalized.compression.early_msg_max_chars = asInt(compression.early_msg_max_chars, normalized.compression.early_msg_max_chars);
    if (!Number.isInteger(normalized.compression.early_msg_max_chars) || normalized.compression.early_msg_max_chars <= 0) {
        errors['compression.early_msg_max_chars'] = 'compression.early_msg_max_chars 必须是正整数。';
    }

    const tools = asObject(raw.tools);
    normalized.tools.schema_mode = asString(tools.schema_mode, normalized.tools.schema_mode) as EditableYamlConfig['tools']['schema_mode'];
    if (!['compact', 'full', 'names_only'].includes(normalized.tools.schema_mode)) {
        errors['tools.schema_mode'] = 'tools.schema_mode 只能是 compact、full 或 names_only。';
    }
    normalized.tools.description_max_length = asInt(tools.description_max_length, normalized.tools.description_max_length);
    if (!Number.isInteger(normalized.tools.description_max_length) || normalized.tools.description_max_length < 0) {
        errors['tools.description_max_length'] = 'tools.description_max_length 必须是非负整数。';
    }
    normalized.tools.passthrough = asBoolean(tools.passthrough, normalized.tools.passthrough);
    normalized.tools.disabled = asBoolean(tools.disabled, normalized.tools.disabled);
    normalized.tools.include_only = asStringList(tools.include_only);
    normalized.tools.exclude = asStringList(tools.exclude);

    normalized.sanitize_response = asBoolean(raw.sanitize_response, normalized.sanitize_response);
    normalized.fixed_fallback_responses = asBoolean(raw.fixed_fallback_responses, normalized.fixed_fallback_responses);
    normalized.refusal_patterns = asStringList(raw.refusal_patterns);

    const fingerprint = asObject(raw.fingerprint);
    normalized.fingerprint.user_agent = asString(fingerprint.user_agent, '').trim();
    if (!normalized.fingerprint.user_agent) {
        errors['fingerprint.user_agent'] = 'fingerprint.user_agent 不能为空。';
    }

    const vision = asObject(raw.vision);
    normalized.vision.enabled = asBoolean(vision.enabled, normalized.vision.enabled);
    normalized.vision.mode = asString(vision.mode, normalized.vision.mode) as EditableYamlConfig['vision']['mode'];
    if (!['ocr', 'api'].includes(normalized.vision.mode)) {
        errors['vision.mode'] = 'vision.mode 只能是 ocr 或 api。';
    }
    normalized.vision.base_url = asString(vision.base_url, normalized.vision.base_url).trim();
    normalized.vision.api_key = asString(vision.api_key, normalized.vision.api_key).trim();
    normalized.vision.model = asString(vision.model, normalized.vision.model).trim();
    normalized.vision.proxy = asString(vision.proxy, normalized.vision.proxy).trim();

    if (normalized.vision.mode === 'api') {
        if (!normalized.vision.base_url) errors['vision.base_url'] = 'vision.mode=api 时必须提供 base_url。';
        if (!normalized.vision.api_key) errors['vision.api_key'] = 'vision.mode=api 时必须提供 api_key。';
        if (!normalized.vision.model) errors['vision.model'] = 'vision.mode=api 时必须提供 model。';
    }

    const logging = asObject(raw.logging);
    normalized.logging.file_enabled = asBoolean(logging.file_enabled, normalized.logging.file_enabled);
    normalized.logging.dir = asString(logging.dir, '').trim() || normalized.logging.dir;
    if (!normalized.logging.dir) {
        errors['logging.dir'] = 'logging.dir 不能为空。';
    }
    normalized.logging.max_days = asInt(logging.max_days, normalized.logging.max_days);
    if (!Number.isInteger(normalized.logging.max_days) || normalized.logging.max_days <= 0) {
        errors['logging.max_days'] = 'logging.max_days 必须是正整数。';
    }
    normalized.logging.persist_mode = asString(logging.persist_mode, normalized.logging.persist_mode) as EditableYamlConfig['logging']['persist_mode'];
    if (!['compact', 'full', 'summary'].includes(normalized.logging.persist_mode)) {
        errors['logging.persist_mode'] = 'logging.persist_mode 只能是 compact、full 或 summary。';
    }

    if (Object.keys(errors).length > 0) {
        return { errors };
    }

    return { config: normalized, errors };
}

function writeEditableConfig(config: EditableYamlConfig): void {
    const doc = createConfigDocument();
    mkdirSync(dirname(CONFIG_FILE_PATH), { recursive: true });

    doc.setIn(['port'], config.port);
    doc.setIn(['timeout'], config.timeout);
    setOptionalString(doc, ['proxy'], config.proxy);
    doc.setIn(['proxy_pool', 'enabled'], config.proxy_pool.enabled);
    setOptionalStringList(doc, ['proxy_pool', 'urls'], config.proxy_pool.urls);
    doc.setIn(['proxy_pool', 'cooldown_seconds'], config.proxy_pool.cooldown_seconds);
    doc.setIn(['proxy_pool', 'health_check', 'enabled'], config.proxy_pool.health_check.enabled);
    doc.setIn(['proxy_pool', 'health_check', 'interval_seconds'], config.proxy_pool.health_check.interval_seconds);
    doc.setIn(['proxy_pool', 'health_check', 'url'], config.proxy_pool.health_check.url);
    doc.setIn(['cursor_model'], config.cursor_model);
    setOptionalStringList(doc, ['auth_tokens'], config.auth_tokens);
    doc.setIn(['max_auto_continue'], config.max_auto_continue);
    doc.setIn(['max_history_messages'], config.max_history_messages);
    doc.setIn(['thinking', 'enabled'], config.thinking.enabled);
    doc.setIn(['compression', 'enabled'], config.compression.enabled);
    doc.setIn(['compression', 'level'], config.compression.level);
    setNumberOrDelete(doc, ['compression', 'keep_recent'], config.compression.keep_recent, 10);
    setNumberOrDelete(doc, ['compression', 'early_msg_max_chars'], config.compression.early_msg_max_chars, 4000);
    doc.setIn(['tools', 'schema_mode'], config.tools.schema_mode);
    doc.setIn(['tools', 'description_max_length'], config.tools.description_max_length);
    doc.setIn(['tools', 'passthrough'], config.tools.passthrough);
    doc.setIn(['tools', 'disabled'], config.tools.disabled);
    setOptionalStringList(doc, ['tools', 'include_only'], config.tools.include_only);
    setOptionalStringList(doc, ['tools', 'exclude'], config.tools.exclude);

    if (config.sanitize_response) {
        doc.setIn(['sanitize_response'], true);
    } else {
        doc.deleteIn(['sanitize_response']);
    }
    doc.setIn(['fixed_fallback_responses'], config.fixed_fallback_responses);

    setOptionalStringList(doc, ['refusal_patterns'], config.refusal_patterns);
    doc.setIn(['fingerprint', 'user_agent'], config.fingerprint.user_agent);
    doc.setIn(['vision', 'enabled'], config.vision.enabled);
    doc.setIn(['vision', 'mode'], config.vision.mode);
    setOptionalString(doc, ['vision', 'base_url'], config.vision.base_url);
    setOptionalString(doc, ['vision', 'api_key'], config.vision.api_key);
    setOptionalString(doc, ['vision', 'model'], config.vision.model);
    setOptionalString(doc, ['vision', 'proxy'], config.vision.proxy);
    doc.setIn(['logging', 'file_enabled'], config.logging.file_enabled);
    doc.setIn(['logging', 'dir'], config.logging.dir);
    doc.setIn(['logging', 'max_days'], config.logging.max_days);
    doc.setIn(['logging', 'persist_mode'], config.logging.persist_mode);

    const tmpPath = CONFIG_FILE_PATH + '.tmp';
    writeFileSync(tmpPath, String(doc), 'utf-8');
    try {
        rmSync(CONFIG_FILE_PATH, { force: true });
    } catch {
        // ignore
    }
    copyFileSync(tmpPath, CONFIG_FILE_PATH);
    rmSync(tmpPath, { force: true });
}

export function apiGetAdminConfig(_req: Request, res: Response): void {
    try {
        const { config, fileExists } = readEditableConfigFile();
        res.json({
            config,
            meta: buildConfigMeta(fileExists),
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: '读取配置失败',
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export function apiGetProxyPoolStatus(_req: Request, res: Response): void {
    try {
        res.json({
            enabled: getConfig().proxyPool.enabled,
            entries: getProxyPoolStatusSnapshot(),
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: '读取代理池状态失败',
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export function apiPutAdminConfig(req: Request, res: Response): void {
    const { config, errors } = validateConfig(req.body?.config);
    if (!config) {
        res.status(400).json({
            success: false,
            message: '配置校验失败',
            errors,
        });
        return;
    }

    try {
        writeEditableConfig(config);
        stopConfigWatcher();
        const reloadResult = reloadConfigFromDisk();
        initConfigWatcher();

        const { config: freshConfig, fileExists } = readEditableConfigFile();
        const meta = buildConfigMeta(fileExists);

        res.json({
            success: true,
            config: freshConfig,
            meta,
            changes: reloadResult.changes,
            warnings: meta.warnings,
            requiresRestart: reloadResult.requiresRestart,
            overriddenFields: meta.overriddenFields,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: '写入 config.yaml 失败',
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
