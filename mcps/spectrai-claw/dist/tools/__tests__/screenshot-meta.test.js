import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getScreenshotMeta, normalizeScreenshotMetaKey, parseScreenshotMetaJson, setScreenshotMeta, siblingMetaJsonPath, } from '../screenshot-meta.js';
const sampleMeta = {
    captureX: 0,
    captureY: 0,
    captureW: 100,
    captureH: 80,
    imageW: 100,
    imageH: 80,
    elements: [
        {
            number: 1,
            name: 'OK',
            controlType: 'ControlType.Button',
            screenX: 10,
            screenY: 20,
            source: 'UIA',
        },
    ],
};
describe('normalizeScreenshotMetaKey', () => {
    it('maps slash variants of the same path to one key', () => {
        const a = normalizeScreenshotMetaKey('C:/Temp/shot.png');
        const b = normalizeScreenshotMetaKey('C:\\Temp\\shot.png');
        const c = normalizeScreenshotMetaKey('C:/Temp/../Temp/shot.png');
        assert.equal(a, b);
        assert.equal(a, c);
        if (process.platform === 'win32') {
            assert.equal(a, normalizeScreenshotMetaKey('c:/temp/SHOT.png'));
        }
    });
});
describe('setScreenshotMeta / getScreenshotMeta (memory)', () => {
    it('gets meta after set even when path slash form differs', () => {
        const map = new Map();
        setScreenshotMeta(map, 'C:\\Temp\\annot.png', sampleMeta);
        const hit = getScreenshotMeta(map, 'C:/Temp/annot.png', {
            existsSync: () => false,
            readFileSync: () => {
                throw new Error('should not read disk');
            },
        });
        assert.ok(hit);
        assert.equal(hit.elements?.[0]?.number, 1);
    });
});
describe('getScreenshotMeta hydrate', () => {
    it('hydrates from sibling .meta.json when map is empty', () => {
        const map = new Map();
        const shot = 'C:\\Temp\\hydrate-shot.png';
        const metaPath = siblingMetaJsonPath(shot);
        const payload = JSON.stringify({
            captureX: 1,
            captureY: 2,
            captureW: 3,
            captureH: 4,
            imageW: 5,
            imageH: 6,
            elements: [
                {
                    number: 7,
                    name: 'Send',
                    controlType: 'ControlType.Button',
                    screenX: 11,
                    screenY: 22,
                    source: 'UIA',
                },
            ],
        });
        const hit = getScreenshotMeta(map, shot, {
            existsSync: (p) => p === metaPath,
            readFileSync: (p) => {
                assert.equal(p, metaPath);
                return payload;
            },
        });
        assert.ok(hit);
        assert.equal(hit.captureX, 1);
        assert.equal(hit.elements?.[0]?.number, 7);
        // second call should hit memory without fs
        const again = getScreenshotMeta(map, 'C:/Temp/hydrate-shot.png', {
            existsSync: () => {
                throw new Error('should use memory');
            },
            readFileSync: () => {
                throw new Error('should use memory');
            },
        });
        assert.equal(again?.elements?.[0]?.name, 'Send');
    });
    it('returns null when meta file is missing', () => {
        const map = new Map();
        const hit = getScreenshotMeta(map, 'C:/Temp/missing.png', {
            existsSync: () => false,
            readFileSync: () => {
                throw new Error('should not read');
            },
        });
        assert.equal(hit, null);
    });
    it('returns null when meta has no elements', () => {
        const map = new Map();
        const hit = getScreenshotMeta(map, 'C:/Temp/empty-elements.png', {
            existsSync: () => true,
            readFileSync: () => JSON.stringify({
                captureX: 0,
                captureY: 0,
                captureW: 1,
                captureH: 1,
                imageW: 1,
                imageH: 1,
                elements: [],
            }),
        });
        assert.equal(hit, null);
    });
});
describe('parseScreenshotMetaJson', () => {
    it('rejects invalid json', () => {
        assert.equal(parseScreenshotMetaJson('{'), null);
    });
});
