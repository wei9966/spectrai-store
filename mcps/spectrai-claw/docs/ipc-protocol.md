# SpectrAI Claw IPC Protocol v1.0

## Overview

The SpectrAI Claw daemon communicates with the Node.js MCP server via a **Unix domain socket** using a **length-prefix framing** protocol. All payloads are UTF-8 encoded JSON.

## Sequence Diagram

```
 Node.js Client                           Swift Daemon
      │                                        │
      │──── connect(claw.sock) ───────────────>│
      │<─── accept ────────────────────────────│
      │                                        │
      │──── [4B len][JSON request] ───────────>│
      │                                        │ process
      │<─── [4B len][JSON response] ───────────│
      │                                        │
      │──── [4B len][JSON request] ───────────>│  (keepalive,
      │<─── [4B len][JSON response] ───────────│   multiplex by id)
      │                                        │
      │──── close / EOF ──────────────────────>│
      │                                        │
```

## Transport

| Property         | Value |
|------------------|-------|
| Socket path      | `$HOME/Library/Application Support/spectrai-claw/claw.sock` |
| Socket permissions | `0600` (owner-only) |
| Max message size | 64 MiB (67,108,864 bytes) |
| Read timeout     | 10 seconds |
| Heartbeat        | `ping` op |
| Multiplexing     | Request `id` field pairs request ↔ response |

## Frame Format

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Payload Length (uint32 BE)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                    JSON Body (UTF-8)                           |
|                          ...                                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **Payload Length**: 4-byte big-endian unsigned integer. Indicates the byte length of the JSON body that follows.
- **JSON Body**: UTF-8 encoded JSON object (Request or Response).

## Message Formats

### Request

```json
{
  "id": "<uuid-v4>",
  "op": "<opName>",
  "params": { ... }
}
```

### Response (Success)

```json
{
  "id": "<uuid>",
  "ok": true,
  "result": { ... }
}
```

### Response (Error)

```json
{
  "id": "<uuid>",
  "ok": false,
  "error": {
    "code": "<errorCode>",
    "message": "<human-readable message>",
    "details": "<optional additional info>"
  }
}
```

## Operations

| Op Name | Purpose | Params | Result |
|---------|---------|--------|--------|
| `ping` | Heartbeat / connectivity check | `{}` | `{pong, timestamp, daemonVersion}` |
| `daemonStatus` | Query daemon health | `{}` | `{uptimeMs, pid, connectionsActive, protocolVersion}` |
| `daemonStop` | Gracefully stop daemon | `{}` | `{stopping}` |
| `permissionsStatus` | Check macOS permissions | `{}` | `{screenRecording, accessibility}` |
| `captureScreen` | Capture entire screen | `{displayIndex?, maxWidth?, annotated?}` | `{path, width, height, displayBounds}` |
| `captureWindow` | Capture specific window | `{windowId, maxWidth?}` | `{path, width, height, displayBounds}` |
| `captureArea` | Capture rectangular area | `{x, y, width, height, maxWidth?}` | `{path, width, height, displayBounds}` |
| `detectElements` | Detect UI elements via AX | `{windowId?, pid?, allowWebFocus?, maxDepth?, maxCount?}` | `{snapshotId, screenshotPath, annotatedPath, elements, ...}` |
| `getSnapshot` | Retrieve cached snapshot | `{snapshotId}` | Same as detectElements result |
| `listSnapshots` | List available snapshots | `{}` | `{snapshots: [{id, createdAt, windowTitle?}]}` |
| `cleanSnapshot` | Remove snapshot(s) | `{snapshotId?}` | `{removed}` |
| `click` | Click at element or coords | `{snapshotId?, elementId?, x?, y?, button, clickCount, modifiers}` | `{clickedAt, targetElement?}` |
| `type` | Type text | `{text, clearExisting?, delayMsPerChar?, snapshotId?, elementId?}` | `{typedChars}` |
| `hotkey` | Press key combination | `{keys, holdMs?}` | `{ok}` |
| `scroll` | Scroll in direction | `{direction, amount, x?, y?}` | `{ok}` |
| `moveMouse` | Move mouse pointer | `{x, y}` | `{ok}` |
| `waitForElement` | Wait for element to appear | `{snapshotId?, query, timeoutMs?}` | `{found, element?}` |
| `listApplications` | List running apps | `{}` | `{applications: [{pid, bundleId, name, isActive}]}` |
| `listWindows` | List windows | `{pid?}` | `{windows: [{windowId, pid, title, bounds, ...}]}` |
| `activateApplication` | Bring app to front | `{pid?, bundleId?}` | `{ok}` |
| `focusWindow` | Focus a window | `{windowId}` | `{ok}` |
| `closeWindow` | Close a window | `{windowId}` | `{ok}` |

## Error Codes

| Code | Description |
|------|-------------|
| `ePermission` | macOS permission denied (Accessibility or Screen Recording) |
| `eNotFound` | Target element, window, application, or snapshot not found |
| `eInvalidArgs` | Invalid or missing parameters |
| `eTimeout` | Operation timed out |
| `eAXFailure` | Accessibility API returned an error |
| `eInternal` | Unclassified internal error |
| `eOpUnsupported` | Unknown operation (protocol version mismatch) |
| `eSnapshotStale` | Snapshot expired or window closed |

## Version Strategy

The protocol version is reported in the `daemonStatus` response as `protocolVersion`. Current version: `"1.0"`.

Breaking changes increment the major version. Additive changes (new ops) increment the minor version.

## Examples

### Ping

Request:
```json
{"id": "550e8400-e29b-41d4-a716-446655440000", "op": "ping", "params": {}}
```

Response:
```json
{"id": "550e8400-e29b-41d4-a716-446655440000", "ok": true, "result": {"pong": true, "timestamp": 1714000000000, "daemonVersion": "1.0.0"}}
```

### detectElements

Request:
```json
{"id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "op": "detectElements", "params": {"pid": 1234, "maxDepth": 5, "maxCount": 200}}
```

Response:
```json
{
  "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "ok": true,
  "result": {
    "snapshotId": "snap_abc123",
    "screenshotPath": "/tmp/spectrai-claw/screenshots/snap_abc123.png",
    "annotatedPath": "/tmp/spectrai-claw/screenshots/snap_abc123_annotated.png",
    "elements": [
      {
        "id": "elem_0",
        "role": "button",
        "subrole": null,
        "label": "Submit",
        "title": "Submit",
        "value": null,
        "description": "Submit form button",
        "identifier": "submit-btn",
        "keyboardShortcut": "⌘S",
        "bounds": {"x": 100, "y": 200, "width": 80, "height": 32},
        "isEnabled": true,
        "isActionable": true,
        "parentId": null
      }
    ],
    "applicationName": "Safari",
    "windowTitle": "Example - Safari",
    "windowBounds": {"x": 0, "y": 0, "width": 1440, "height": 900},
    "warnings": []
  }
}
```

### click

Request:
```json
{"id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "op": "click", "params": {"snapshotId": "snap_abc123", "elementId": "elem_0", "button": "left", "clickCount": 1, "modifiers": []}}
```

Response:
```json
{"id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "ok": true, "result": {"clickedAt": {"x": 140, "y": 216}, "targetElement": {"id": "elem_0", "role": "button", "subrole": null, "label": "Submit", "title": "Submit", "value": null, "description": "Submit form button", "identifier": "submit-btn", "keyboardShortcut": "⌘S", "bounds": {"x": 100, "y": 200, "width": 80, "height": 32}, "isEnabled": true, "isActionable": true, "parentId": null}}}
```
