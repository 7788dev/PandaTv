import XCTest

final class PandaUITests: XCTestCase {
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func rotateToPortrait(_ app: XCUIApplication) {
        XCUIDevice.shared.orientation = .portrait
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let frame = app.frame
            return frame.height > frame.width && !app.cells["nav-首页"].isHittable
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 12), .completed)
    }

    func testBrowsePlayRotateAndRestore() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchEnvironment["PANDA_TEST_PORT"] = "18765"
        app.launch()
        let featured = app.buttons["featured"]
        XCTAssertTrue(featured.waitForExistence(timeout: 25))
        capture("iPad-landscape")
        featured.tap()
        let favorite = app.buttons["favorite"]
        XCTAssertTrue(favorite.waitForExistence(timeout: 10))
        if !favorite.label.contains("已收藏") { favorite.tap() }
        rotateToPortrait(app)
        let episode = app.buttons["episode-2"]
        XCTAssertTrue(episode.waitForExistence(timeout: 15))
        capture("iPad-portrait-detail")
        episode.tap()
        let close = app.buttons["close-player"]
        XCTAssertTrue(close.waitForExistence(timeout: 12))
        // Wait for the actual AVPlayer to request its HLS segments, then let its playhead advance.
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (try? String(contentsOf: URL(string: "http://127.0.0.1:18765/test/played")!)) == "yes"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 18), .completed)
        let elapsed = expectation(description: "decode several seconds of HLS")
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { elapsed.fulfill() }
        wait(for: [elapsed], timeout: 9)
        capture("iPad-system-player")
        close.tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.terminate()
        app.launch()
        let history = app.cells["nav-观看历史"]
        XCTAssertTrue(history.waitForExistence(timeout: 12))
        history.tap()
        let recorded = app.buttons.containing(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "三体", "第 2 集")).firstMatch
        XCTAssertTrue(recorded.waitForExistence(timeout: 12))
        recorded.tap()
        XCTAssertTrue(app.buttons["play"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["play"].label.contains("继续播放"))
        XCTAssertTrue(app.buttons["favorite"].label.contains("已收藏"))
        app.cells["nav-搜索"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("ST")
        let hint = app.buttons["三体"].firstMatch
        XCTAssertTrue(hint.waitForExistence(timeout: 12))
        hint.tap()
        XCTAssertTrue(app.buttons["title-26647087"].waitForExistence(timeout: 12))
    }

    func testLiveHomeAppearance() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launch()
        guard app.buttons["featured"].waitForExistence(timeout: 18) else {
            throw XCTSkip("Live catalogue is unavailable from this runner")
        }
        // Artwork arrives independently after the title. Capture the production screen once it settles.
        let settle = expectation(description: "load visible artwork")
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { settle.fulfill() }
        wait(for: [settle], timeout: 8)
        capture("iPad-live-home-landscape")
        rotateToPortrait(app)
        capture("iPad-live-home-portrait")
    }
}
