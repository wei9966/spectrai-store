import Testing
@testable import SpectRAIClawCore

@Suite struct CoreSmokeTests {
    @Test func canImportCore() {
        #expect(Bool(true))
    }
}
