import type { AnnotatedSource } from './click-accuracy.js';
export interface AnnotatedElement {
    number: number;
    name: string;
    controlType: string;
    screenX: number;
    screenY: number;
    automationId?: string;
    className?: string;
    processId?: number;
    rectX?: number;
    rectY?: number;
    rectW?: number;
    rectH?: number;
    source?: AnnotatedSource;
    isEnabled?: boolean;
    isOffscreen?: boolean;
    patterns?: string[];
}
export interface ScreenshotMeta {
    captureX: number;
    captureY: number;
    captureW: number;
    captureH: number;
    imageW: number;
    imageH: number;
    elements?: AnnotatedElement[];
}
export type ScreenshotMetaFs = {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string, encoding: 'utf8') => string;
};
/** Resolve + unify separators; Windows also lowercases for case-insensitive hits. */
export declare function normalizeScreenshotMetaKey(p: string): string;
/** Sibling persistence path used by screenshot(): foo.png → foo.meta.json */
export declare function siblingMetaJsonPath(screenshotPath: string): string;
/** Parse disk .meta.json into ScreenshotMeta; require elements for hydrate. */
export declare function parseScreenshotMetaJson(raw: string): ScreenshotMeta | null;
export declare function setScreenshotMeta(map: Map<string, ScreenshotMeta>, screenshotPath: string, meta: ScreenshotMeta): void;
/**
 * Lookup by normalized key; on miss, hydrate from sibling .meta.json when it has elements.
 */
export declare function getScreenshotMeta(map: Map<string, ScreenshotMeta>, screenshotPath: string, fsImpl?: ScreenshotMetaFs): ScreenshotMeta | null;
