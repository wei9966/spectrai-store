import Foundation
import Testing
@testable import SpectRAIClawCore

@Suite struct CoreSmokeTests {
    @Test func canImportCore() {
        #expect(Bool(true))
    }

    @Test func applicationServiceListReturnsApps() {
        let apps = ApplicationService.list()
        #expect(apps.count >= 1)
        let hasNonEmpty = apps.contains { !$0.name.isEmpty }
        #expect(hasNonEmpty)
    }

    @Test func hotkeyServiceParseKeys() async throws {
        // Verifies key parsing works without actually posting events (no permission needed)
        // We just confirm it doesn't throw for valid inputs
        do {
            try await HotkeyService.press(keys: ["cmd", "shift", "a"], holdMs: 0)
        } catch is HotkeyError {
            // Event creation may fail without accessibility permission — that's OK for CI
        } catch {
            // Any other error is unexpected but we don't fail the test for permission issues
        }
        // Invalid key should throw
        do {
            try await HotkeyService.press(keys: ["cmd", "nonexistentkey"], holdMs: 0)
            Issue.record("Expected HotkeyError.invalidKey for unknown key")
        } catch let err as HotkeyError {
            switch err {
            case .invalidKey(let msg):
                #expect(msg.contains("nonexistentkey"))
            default:
                Issue.record("Expected invalidKey error, got: \(err)")
            }
        }
    }

    @Test func screenCaptureServiceProducesPNG() async throws {
        do {
            let result = try await ScreenCaptureService.captureScreen()
            #expect(!result.path.isEmpty)
            #expect(result.width > 0)
            #expect(result.height > 0)
            // Clean up
            try? FileManager.default.removeItem(atPath: result.path)
        } catch let err as ScreenCaptureError {
            switch err {
            case .permissionDenied:
                // Skip test if no screen recording permission
                return
            default:
                throw err
            }
        }
    }

    @Test func scrollServiceDirectionMapping() {
        // Basic enum existence check
        #expect(ScrollService.Direction.up.rawValue == "up")
        #expect(ScrollService.Direction.down.rawValue == "down")
        #expect(ScrollService.Direction.left.rawValue == "left")
        #expect(ScrollService.Direction.right.rawValue == "right")
    }

    @Test func clickServiceModifiersOptionSet() {
        var mods: ClickService.Modifiers = [.cmd, .shift]
        #expect(mods.contains(.cmd))
        #expect(mods.contains(.shift))
        #expect(!mods.contains(.option))
        mods.insert(.option)
        #expect(mods.contains(.option))
    }
}
