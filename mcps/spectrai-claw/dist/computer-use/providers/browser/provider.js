import { CdpError, CdpHttpClient, CdpSession } from './cdp-client.js';
import { buildActionExpression, buildDomSnapshotExpression, buildElementStateExpression, buildFindElementExpression } from './dom-scripts.js';
import { ensureDebugBrowser } from './ensure-debug-browser.js';
export class BrowserDomCdpProvider {
    http;
    defaultTimeoutMs;
    ensurePromise = null;
    constructor(options = {}) {
        this.http = new CdpHttpClient(options);
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    }
    async listTargets() {
        await this.ensureReady();
        return await this.http.listTargets();
    }
    async listWindows() {
        const targets = await this.listTargets();
        return targets.map((target) => ({
            id: target.targetId,
            provider: 'browser',
            targetId: target.targetId,
            title: target.title,
            url: target.url,
            webSocketDebuggerUrl: target.webSocketDebuggerUrl,
        }));
    }
    async readDomSnapshot(selector, maxElements = 200, target) {
        const resolvedTarget = await this.resolveTarget(target ?? selector);
        const payload = await this.evaluate(resolvedTarget, buildDomSnapshotExpression(selector, maxElements));
        const elements = (payload.elements ?? []).map((element) => this.withTargetMetadata(element, resolvedTarget, selector));
        return {
            provider: 'browser',
            target: resolvedTarget,
            url: payload.url ?? resolvedTarget.url,
            title: payload.title ?? resolvedTarget.title,
            timestamp: payload.timestamp ?? new Date().toISOString(),
            elements,
            frames: payload.frames ?? [],
            warnings: payload.warnings ?? [],
            capabilityHints: {
                backgroundRead: true,
                backgroundInvoke: true,
                backgroundType: true,
                requiresForeground: false,
                visionFallbackNeeded: false,
            },
        };
    }
    async findElement(selector, target) {
        const resolvedTarget = await this.resolveTarget(target ?? selector);
        const payload = await this.evaluate(resolvedTarget, buildFindElementExpression(selector));
        return payload.element ? this.withTargetMetadata(payload.element, resolvedTarget, selector) : null;
    }
    async executeAction(action, target) {
        const resolvedTarget = await this.resolveTarget(target ?? action.selector);
        const actionWithSelector = await this.normalizeAction(action, resolvedTarget);
        const before = actionWithSelector.selector ? await this.safeElementState(resolvedTarget, actionWithSelector.selector) : undefined;
        const raw = await this.evaluate(resolvedTarget, buildActionExpression(actionWithSelector));
        const targetElement = raw.element ? this.withTargetMetadata(raw.element, resolvedTarget, actionWithSelector.selector) : actionWithSelector.element;
        const verification = await this.verifyAction(resolvedTarget, actionWithSelector, before, raw.after);
        const ok = raw.ok === true && verification.ok;
        const failure = ok ? undefined : this.toFailure(raw.failure, verification);
        return {
            ok,
            provider: 'browser',
            action: actionWithSelector.type,
            method: raw.method ?? 'dom',
            target: targetElement ?? undefined,
            before: raw.before ?? before,
            after: raw.after,
            verification,
            failure,
            fallback: ok ? undefined : this.fallbackForFailure(failure, actionWithSelector),
            warnings: raw.warnings ?? [],
            raw,
        };
    }
    async getCapabilityReport() {
        let targets = [];
        let status = 'available';
        const notes = [];
        try {
            await this.ensureReady();
            targets = await this.http.listTargets();
            if (targets.length === 0) {
                status = 'no_page_targets';
            }
        }
        catch (error) {
            status = 'debug_port_unreachable';
            notes.push(error instanceof Error ? error.message : String(error));
        }
        return {
            provider: 'browser-dom-cdp',
            status,
            endpoint: {
                host: this.http.host,
                port: this.http.port,
                browserURL: this.http.browserURL,
            },
            targetCount: targets.length,
            backgroundRead: status === 'available' || status === 'no_page_targets',
            backgroundInvoke: status === 'available',
            backgroundType: status === 'available',
            requiresForeground: false,
            visionFallbackNeeded: status !== 'available',
            selectorSupport: ['css', 'xpath', 'text', 'role', 'aria-label', 'testId', 'framePath', 'url/title', 'bounds'],
            actions: {
                click: 'native',
                type: 'native',
                setValue: 'native',
                pressKey: 'thin',
                hotkey: 'thin',
                select: 'native',
                scroll: 'native',
                hover: 'thin',
                menu: 'thin',
                contextMenu: 'thin',
                upload: 'fallback',
            },
            limitations: {
                frames: [
                    'Same-origin iframe DOM is readable through framePath; cross-origin iframe DOM requires attaching to the frame target or falling back to browser automation/vision.',
                    'framePath entries accept iframe index strings or iframe CSS selectors.',
                ],
                permissions: [
                    'Chrome/Edge/Brave must expose a remote debugging endpoint such as --remote-debugging-port=9222.',
                    'File upload requires explicit local file permission and DOM.setFileInputFiles; the current provider returns a fallback suggestion.',
                ],
                userGesture: [
                    'DOM click/input runs with Runtime.evaluate userGesture=true, but browser-gated flows such as clipboard, popups, downloads or passkeys may still require foreground or a Playwright/CDP Input fallback.',
                ],
                upload: [
                    'Thin interface is modeled as action=upload with files[], but the safe implementation is intentionally deferred to a permission-aware path.',
                ],
            },
            fallbackOrder: ['browser-dom-cdp', 'playwright-with-existing-cdp-session', 'desktop-vision-hid'],
            notes,
        };
    }
    async getAppState(target) {
        return await this.readDomSnapshot(undefined, 200, target);
    }
    async getAppTree(target) {
        return await this.readDomSnapshot(undefined, 500, target);
    }
    async invokeElement(selectorOrElement, action = {}, target) {
        const browserAction = {
            type: action.type ?? 'click',
            ...action,
            selector: isBrowserElement(selectorOrElement) ? selectorOrElement.metadata.selector : selectorOrElement,
            element: isBrowserElement(selectorOrElement) ? selectorOrElement : action.element,
        };
        return await this.executeAction(browserAction, target);
    }
    async setValue(selectorOrElement, value, target) {
        const browserAction = {
            type: 'setValue',
            value,
            verify: { value },
            selector: isBrowserElement(selectorOrElement) ? selectorOrElement.metadata.selector : selectorOrElement,
            element: isBrowserElement(selectorOrElement) ? selectorOrElement : undefined,
        };
        return await this.executeAction(browserAction, target);
    }
    async getCapabilities() {
        return await this.getCapabilityReport();
    }
    async ensureReady() {
        if (!this.ensurePromise) {
            this.ensurePromise = ensureDebugBrowser({
                host: this.http.host,
                port: this.http.port,
                browserURL: this.http.browserURL,
            })
                .then(() => undefined)
                .catch((error) => {
                this.ensurePromise = null;
                throw error;
            });
        }
        await this.ensurePromise;
    }
    async normalizeAction(action, target) {
        if (action.selector || action.element) {
            return action;
        }
        if (action.type === 'pressKey' || action.type === 'hotkey' || action.type === 'scroll') {
            return action;
        }
        const element = await this.findElement({ visible: true, urlIncludes: target.url }, { targetId: target.targetId });
        return { ...action, element: element ?? undefined, selector: element?.metadata.selector };
    }
    async resolveTarget(query) {
        const targets = await this.listTargets();
        if (targets.length === 0) {
            throw new CdpError('no_page_targets', 'No CDP page targets were found. Start Chrome/Edge with --remote-debugging-port=9222.');
        }
        const queryTargetId = query && 'targetId' in query ? query.targetId : undefined;
        const queryWebSocketDebuggerUrl = query && 'webSocketDebuggerUrl' in query ? query.webSocketDebuggerUrl : undefined;
        const queryUrlIncludes = query?.urlIncludes;
        const queryTitleIncludes = query?.titleIncludes;
        const matches = (target) => {
            if (!target.webSocketDebuggerUrl)
                return false;
            if (queryTargetId && target.targetId !== queryTargetId)
                return false;
            if (queryWebSocketDebuggerUrl && target.webSocketDebuggerUrl !== queryWebSocketDebuggerUrl)
                return false;
            if (queryUrlIncludes && !target.url.includes(queryUrlIncludes))
                return false;
            if (queryTitleIncludes && !target.title.includes(queryTitleIncludes))
                return false;
            return true;
        };
        const selected = targets.find(matches) ?? targets.find((target) => Boolean(target.webSocketDebuggerUrl));
        if (!selected?.webSocketDebuggerUrl) {
            throw new CdpError('target_not_found', 'No attachable CDP page target matched the browser query.', { query });
        }
        return selected;
    }
    async evaluate(target, expression) {
        if (!target.webSocketDebuggerUrl) {
            throw new CdpError('target_not_found', 'Target has no webSocketDebuggerUrl', { target });
        }
        const session = new CdpSession(target.webSocketDebuggerUrl, this.defaultTimeoutMs);
        try {
            const result = await session.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
                userGesture: true,
            }, this.defaultTimeoutMs);
            return extractRuntimeValue(result);
        }
        finally {
            session.close();
        }
    }
    withTargetMetadata(element, target, selector) {
        return {
            ...element,
            metadata: {
                ...element.metadata,
                targetId: target.targetId,
                selector: selector ?? element.metadata.selector,
            },
        };
    }
    async safeElementState(target, selector) {
        try {
            return await this.evaluate(target, buildElementStateExpression(selector));
        }
        catch {
            return undefined;
        }
    }
    async verifyAction(target, action, before, afterFromAction) {
        const verify = this.defaultVerification(action);
        if (!verify) {
            return { ok: true, status: 'not_requested', checks: [] };
        }
        const selector = action.selector ?? action.element?.metadata.selector;
        let after = afterFromAction;
        if (!after || verify.networkIdleMs != null) {
            if (verify.networkIdleMs && verify.networkIdleMs > 0) {
                await sleep(Math.min(verify.networkIdleMs, 5_000));
            }
            after = selector ? await this.safeElementState(target, selector) : await this.evaluate(target, buildElementStateExpression());
        }
        if (!after) {
            return {
                ok: false,
                status: 'failed',
                checks: [{ name: 'state_available', ok: false }],
                message: 'Could not read DOM state after action.',
            };
        }
        const checks = [];
        if (verify.value != null)
            checks.push({ name: 'value', ok: after.value === verify.value, expected: verify.value, actual: after.value });
        if (verify.textIncludes != null)
            checks.push({ name: 'textIncludes', ok: after.text.includes(verify.textIncludes), expected: verify.textIncludes, actual: after.text });
        if (verify.checked != null)
            checks.push({ name: 'checked', ok: after.checked === verify.checked, expected: verify.checked, actual: after.checked });
        if (verify.selected != null)
            checks.push({ name: 'selected', ok: after.selected === verify.selected, expected: verify.selected, actual: after.selected });
        if (verify.focused != null)
            checks.push({ name: 'focused', ok: after.focused === verify.focused, expected: verify.focused, actual: after.focused });
        if (verify.urlIncludes != null)
            checks.push({ name: 'urlIncludes', ok: after.url.includes(verify.urlIncludes), expected: verify.urlIncludes, actual: after.url });
        if (verify.mutation === true && before)
            checks.push({ name: 'mutation', ok: before.mutationHash !== after.mutationHash || before.url !== after.url, expected: 'changed', actual: { before: before.mutationHash, after: after.mutationHash } });
        const ok = checks.every((check) => check.ok);
        return {
            ok,
            status: ok ? 'passed' : 'failed',
            checks,
            message: ok ? undefined : 'Browser DOM post-action verification failed.',
        };
    }
    defaultVerification(action) {
        if (action.verify)
            return action.verify;
        if (action.type === 'type' || action.type === 'setValue') {
            return { value: action.value ?? action.text ?? '' };
        }
        if (action.type === 'select') {
            return { value: action.optionValue ?? action.value ?? '' };
        }
        if (action.type === 'click') {
            return { mutation: true, timeoutMs: action.timeoutMs };
        }
        return undefined;
    }
    toFailure(rawFailure, verification) {
        if (rawFailure)
            return rawFailure;
        if (!verification.ok) {
            return {
                code: 'verification_failed',
                message: verification.message ?? 'Browser action verification failed.',
                details: { checks: verification.checks },
            };
        }
        return undefined;
    }
    fallbackForFailure(failure, action) {
        if (!failure)
            return undefined;
        if (failure.code === 'cdp_unavailable' || failure.code === 'target_not_found') {
            return { provider: 'playwright', action: action.type, reason: 'Attach Playwright to the same CDP endpoint or start the browser with --remote-debugging-port.' };
        }
        if (failure.code === 'cross_origin_frame' || failure.code === 'permission_required') {
            return { provider: 'playwright', action: action.type, reason: 'Use Playwright/CDP frame or permission-aware file input APIs for this browser-gated operation.' };
        }
        return { provider: 'desktop-vision-hid', action: action.type, reason: 'DOM verification failed; fall back to the visual/HID provider only after rereading page state.' };
    }
}
function extractRuntimeValue(payload) {
    if (payload.exceptionDetails) {
        const message = payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text ?? 'Runtime.evaluate exception';
        throw new CdpError('runtime_exception', message, payload.exceptionDetails);
    }
    if (!payload.result) {
        throw new CdpError('runtime_missing_result', 'Runtime.evaluate returned no result');
    }
    return payload.result.value;
}
function isBrowserElement(value) {
    return value.provider === 'browser' && typeof value.id === 'string';
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
