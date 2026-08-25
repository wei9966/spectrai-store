/**
 * Screenshot annotated-meta cache helpers.
 * Normalize path keys + hydrate from sibling .meta.json on miss.
 */
import { existsSync, readFileSync } from 'fs';
import { normalize, resolve } from 'path';
const defaultFs = { existsSync, readFileSync };
/** Resolve + unify separators; Windows also lowercases for case-insensitive hits. */
export function normalizeScreenshotMetaKey(p) {
    const raw = typeof p === 'string' ? p.trim() : '';
    if (!raw)
        return '';
    const unified = normalize(resolve(raw)).replace(/\\/g, '/');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
}
/** Sibling persistence path used by screenshot(): foo.png → foo.meta.json */
export function siblingMetaJsonPath(screenshotPath) {
    const abs = resolve(screenshotPath.trim());
    return abs.replace(/\.[^.]+$/, '.meta.json');
}
function asFiniteNumber(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n))
            return n;
    }
    return null;
}
function coerceElement(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const o = raw;
    const number = asFiniteNumber(o.number);
    const screenX = asFiniteNumber(o.screenX);
    const screenY = asFiniteNumber(o.screenY);
    if (number == null || screenX == null || screenY == null)
        return null;
    const el = {
        number,
        name: typeof o.name === 'string' ? o.name : '',
        controlType: typeof o.controlType === 'string' ? o.controlType : '',
        screenX,
        screenY,
    };
    if (typeof o.automationId === 'string')
        el.automationId = o.automationId;
    if (typeof o.className === 'string')
        el.className = o.className;
    const processId = asFiniteNumber(o.processId);
    if (processId != null)
        el.processId = processId;
    const rectX = asFiniteNumber(o.rectX);
    const rectY = asFiniteNumber(o.rectY);
    const rectW = asFiniteNumber(o.rectW);
    const rectH = asFiniteNumber(o.rectH);
    if (rectX != null)
        el.rectX = rectX;
    if (rectY != null)
        el.rectY = rectY;
    if (rectW != null)
        el.rectW = rectW;
    if (rectH != null)
        el.rectH = rectH;
    if (typeof o.source === 'string')
        el.source = o.source;
    if (typeof o.isEnabled === 'boolean')
        el.isEnabled = o.isEnabled;
    if (typeof o.isOffscreen === 'boolean')
        el.isOffscreen = o.isOffscreen;
    if (Array.isArray(o.patterns)) {
        el.patterns = o.patterns.filter((x) => typeof x === 'string');
    }
    return el;
}
/** Parse disk .meta.json into ScreenshotMeta; require elements for hydrate. */
export function parseScreenshotMetaJson(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object')
        return null;
    const o = parsed;
    const captureX = asFiniteNumber(o.captureX);
    const captureY = asFiniteNumber(o.captureY);
    const captureW = asFiniteNumber(o.captureW);
    const captureH = asFiniteNumber(o.captureH);
    const imageW = asFiniteNumber(o.imageW);
    const imageH = asFiniteNumber(o.imageH);
    if (captureX == null || captureY == null || captureW == null ||
        captureH == null || imageW == null || imageH == null) {
        return null;
    }
    if (!Array.isArray(o.elements) || o.elements.length === 0)
        return null;
    const elements = [];
    for (const item of o.elements) {
        const el = coerceElement(item);
        if (el)
            elements.push(el);
    }
    if (elements.length === 0)
        return null;
    return { captureX, captureY, captureW, captureH, imageW, imageH, elements };
}
export function setScreenshotMeta(map, screenshotPath, meta) {
    const key = normalizeScreenshotMetaKey(screenshotPath);
    if (!key)
        return;
    map.set(key, meta);
}
/**
 * Lookup by normalized key; on miss, hydrate from sibling .meta.json when it has elements.
 */
export function getScreenshotMeta(map, screenshotPath, fsImpl = defaultFs) {
    const key = normalizeScreenshotMetaKey(screenshotPath);
    if (!key)
        return null;
    const hit = map.get(key);
    if (hit)
        return hit;
    try {
        const metaPath = siblingMetaJsonPath(screenshotPath);
        if (!fsImpl.existsSync(metaPath))
            return null;
        const raw = fsImpl.readFileSync(metaPath, 'utf8');
        const meta = parseScreenshotMetaJson(raw);
        if (!meta)
            return null;
        map.set(key, meta);
        return meta;
    }
    catch {
        return null;
    }
}
