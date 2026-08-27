import { registerTool } from '../../../tools/registry.js';
import { ensureDebugBrowser } from './ensure-debug-browser.js';
import { BrowserDomCdpProvider } from './provider.js';
import { normalizeBrowserSelector } from './selector-normalize.js';
const connectionSchema = {
    type: 'object',
    properties: {
        host: { type: 'string', description: 'CDP host, defaults to 127.0.0.1 or SPECTRAI_BROWSER_CDP_HOST.' },
        port: { type: 'number', description: 'CDP port, defaults to 9222 or SPECTRAI_BROWSER_CDP_PORT.' },
        browserURL: { type: 'string', description: 'Full CDP browser URL, for example http://127.0.0.1:9222.' },
        defaultTimeoutMs: { type: 'number', description: 'Default CDP command timeout in milliseconds.' },
    },
    additionalProperties: false,
};
const targetSchema = {
    type: 'object',
    properties: {
        targetId: { type: 'string' },
        webSocketDebuggerUrl: { type: 'string' },
        urlIncludes: { type: 'string' },
        titleIncludes: { type: 'string' },
    },
    additionalProperties: false,
};
const boundsSchema = {
    type: 'object',
    properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
    },
    additionalProperties: false,
};
const selectorSchema = {
    type: 'object',
    properties: {
        kind: { type: 'string', enum: ['css', 'xpath', 'text', 'role', 'aria-label', 'testId', 'bounds', 'elementId'] },
        type: { type: 'string', description: 'Agent alias for kind; normalized to kind + flat locator fields.' },
        value: {
            description: 'Agent alias for the locator payload paired with type/kind.',
            anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, boundsSchema],
        },
        css: { type: 'string' },
        xpath: { type: 'string' },
        text: { type: 'string' },
        role: { type: 'string' },
        ariaLabel: { type: 'string' },
        'aria-label': { type: 'string' },
        testId: { type: 'string' },
        testIdAttribute: { type: 'string' },
        framePath: { type: 'array', items: { type: 'string' } },
        urlIncludes: { type: 'string' },
        titleIncludes: { type: 'string' },
        url: { type: 'string', description: 'Agent sometimes puts the page URL here; navigate will read it.' },
        bounds: boundsSchema,
        index: { type: 'number' },
        visible: { type: 'boolean' },
        elementId: { type: 'string' },
        spectraiId: { type: 'string' },
    },
    additionalProperties: false,
};
const verificationSchema = {
    type: 'object',
    properties: {
        value: { type: 'string' },
        textIncludes: { type: 'string' },
        checked: { type: 'boolean' },
        selected: { type: 'boolean' },
        focused: { type: 'boolean' },
        urlIncludes: { type: 'string' },
        mutation: { type: 'boolean' },
        networkIdleMs: { type: 'number' },
        timeoutMs: { type: 'number' },
    },
    additionalProperties: false,
};
const actionSchema = {
    type: 'object',
    properties: {
        type: {
            type: 'string',
            enum: ['click', 'type', 'setValue', 'pressKey', 'hotkey', 'select', 'scroll', 'hover', 'menu', 'contextMenu', 'upload', 'navigate', 'goto', 'open', 'load'],
            description: 'Use navigate (aliases: goto/open/load) with action.url to open a page. Do not click the address bar.',
        },
        selector: selectorSchema,
        url: { type: 'string', description: 'Absolute or host/path URL for navigate. example.com is normalized to https://example.com.' },
        text: { type: 'string' },
        value: { type: 'string' },
        key: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
        optionValue: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        scroll: {
            type: 'object',
            properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                deltaX: { type: 'number' },
                deltaY: { type: 'number' },
                block: { type: 'string' },
                inline: { type: 'string' },
            },
            additionalProperties: false,
        },
        verify: verificationSchema,
        timeoutMs: { type: 'number' },
    },
    // ponytail: url-only payloads default to navigate in the handler; do not require type.
    required: [],
    // ponytail: Agent often sends extra fields (url/href); reject-all was causing "导航参数不对".
    additionalProperties: true,
};
export function registerBrowserComputerUseTools() {
    registerTool('browser_list_targets', 'Browser Computer Use: list Chrome/Edge/Brave CDP page targets from a remote debugging endpoint. This is DOM/CDP-based and does not use screenshots.', {
        type: 'object',
        properties: {
            connection: connectionSchema,
        },
        additionalProperties: false,
    }, async (args) => {
        const provider = await createProvider(args);
        const targets = await provider.listTargets();
        return json({ targets });
    }, { title: 'Browser list targets', readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    registerTool('browser_list_windows', 'Browser Computer Use: list browser page targets as canonical Computer Use windows.', {
        type: 'object',
        properties: {
            connection: connectionSchema,
        },
        additionalProperties: false,
    }, async (args) => {
        const provider = await createProvider(args);
        const windows = await provider.listWindows();
        return json({ windows });
    }, { title: 'Browser list windows', readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    registerTool('browser_get_app_state', 'Browser Computer Use: read a DOM snapshot/tree from a CDP page target using selector-capable DOM semantics. Use this instead of screenshot/OCR for browser content when CDP is available.', {
        type: 'object',
        properties: {
            connection: connectionSchema,
            target: targetSchema,
            selector: selectorSchema,
            maxElements: { type: 'number', description: 'Maximum DOM elements to return; defaults to 200.' },
        },
        additionalProperties: false,
    }, async (args) => {
        const provider = await createProvider(args);
        const snapshot = await provider.readDomSnapshot(normalizeBrowserSelector(readObject(args.selector)), Number(args.maxElements ?? 200), readObject(args.target));
        return json(snapshot);
    }, { title: 'Browser DOM state', readOnlyHint: true, destructiveHint: false, idempotentHint: false });
    registerTool('browser_find_element', 'Browser Computer Use: find one DOM element by css/xpath/text/role/aria-label/testId/framePath/url/title/bounds selector and return a canonical element with DOM metadata.', {
        type: 'object',
        properties: {
            connection: connectionSchema,
            target: targetSchema,
            selector: selectorSchema,
        },
        required: ['selector'],
        additionalProperties: false,
    }, async (args) => {
        const provider = await createProvider(args);
        const element = await provider.findElement(normalizeBrowserSelector(readObject(args.selector)) ?? {}, readObject(args.target));
        return json({ element });
    }, { title: 'Browser find element', readOnlyHint: true, destructiveHint: false, idempotentHint: false });
    registerTool('browser_execute_action', 'Browser Computer Use: execute DOM/CDP semantic browser actions such as click, setValue/type, select, scroll, hover, contextMenu and navigate. To open a page, use action.type=navigate (aliases: goto/open/load) with action.url — do not click the address bar or type into omnibox. Click verification prefers page URL/title changes before element mutation. Visual/HID is only a fallback when there is no navigation evidence.', {
        type: 'object',
        properties: {
            connection: connectionSchema,
            target: targetSchema,
            action: actionSchema,
            url: { type: 'string', description: 'Optional page URL; used when action.url is missing (navigate).' },
        },
        required: ['action'],
        additionalProperties: false,
    }, async (args) => {
        const provider = await createProvider(args);
        const action = normalizeBrowserAction(readObject(args.action) ?? {}, typeof args.url === 'string' ? args.url : undefined);
        const result = await provider.executeAction(action, readObject(args.target));
        return json(result);
    }, { title: 'Browser execute action', readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    registerTool('browser_navigate', 'Browser Computer Use: open a page with CDP Page.navigate (or /json/new). Pass url. Do not click the address bar.', {
        type: 'object',
        properties: {
            connection: connectionSchema,
            target: targetSchema,
            url: { type: 'string', description: 'http(s) URL or host/path (https:// is added).' },
        },
        required: ['url'],
        additionalProperties: false,
    }, async (args) => {
        const provider = await createProvider(args);
        const action = normalizeBrowserAction({ type: 'navigate' }, typeof args.url === 'string' ? args.url : undefined);
        const result = await provider.executeAction(action, readObject(args.target));
        return json(result);
    }, { title: 'Browser navigate', readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    registerTool('browser_get_capabilities', 'Browser Computer Use: report DOM/CDP background read/invoke/type capability, limitations, frame/permission/userGesture constraints and fallback order.', {
        type: 'object',
        properties: {
            connection: connectionSchema,
        },
        additionalProperties: false,
    }, async (args) => {
        const provider = await createProvider(args);
        const report = await provider.getCapabilityReport();
        return json(report);
    }, { title: 'Browser capability report', readOnlyHint: true, destructiveHint: false, idempotentHint: false });
}
async function createProvider(args) {
    const options = readObject(args.connection) ?? {};
    await ensureDebugBrowser(options);
    return new BrowserDomCdpProvider(options);
}
function readObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return undefined;
}
const NAVIGATE_ALIASES = new Set(['navigate', 'goto', 'open', 'load', 'page.navigate', 'cdp_navigate']);
function looksLikeUrl(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return false;
    if (/^https?:\/\//i.test(trimmed))
        return true;
    if (/^about:blank$/i.test(trimmed))
        return true;
    // host or host/path, no spaces — Agent often omits the scheme.
    return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed);
}
function pickUrl(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate !== 'string')
            continue;
        const trimmed = candidate.trim();
        if (looksLikeUrl(trimmed))
            return trimmed;
    }
    return undefined;
}
function normalizeActionType(raw, hasUrl) {
    const type = typeof raw === 'string' ? raw.trim() : '';
    if (type && NAVIGATE_ALIASES.has(type.toLowerCase()))
        return 'navigate';
    if (!type && hasUrl)
        return 'navigate';
    if (type)
        return type;
    return 'click';
}
function normalizeBrowserAction(action, topLevelUrl) {
    const raw = (action ?? {});
    const selector = raw.selector
        ? normalizeBrowserSelector(raw.selector)
        : undefined;
    const url = pickUrl(raw.url, topLevelUrl, raw.value, raw.text, selector?.url);
    const type = normalizeActionType(raw.type, Boolean(url));
    return {
        ...raw,
        type,
        selector,
        ...(url ? { url } : {}),
    };
}
function json(value) {
    const text = JSON.stringify(value, null, 2);
    return {
        content: [{ type: 'text', text }],
        structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? value : { value },
    };
}
