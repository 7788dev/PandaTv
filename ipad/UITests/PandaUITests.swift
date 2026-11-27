import XCTest

final class PandaUITests: XCTestCase {
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func captureControls(_ name: String, _ app: XCUIApplication) {
        capture(name)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-accessibility"
        tree.lifetime = .keepAlways
        add(tree)
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
        app.launchEnvironment["PANDA_TEST_LIBRARY"] = UUID().uuidString
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
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.31, dy: 0.5)).tap()
        captureControls("iPad-system-player", app)
        app.buttons["volume-button"].tap()
        let gain = app.sliders["volume-slider"]
        XCTAssertTrue(gain.waitForExistence(timeout: 5))
        gain.adjust(toNormalizedSliderPosition: 0.35)
        let mute = app.buttons["mute"]
        mute.tap()
        XCTAssertTrue(mute.label.contains("取消静音"))
        mute.tap()
        XCTAssertEqual(mute.label, "静音")
        captureControls("iPad-player-volume", app)
        app.buttons["close-volume"].tap()
        app.buttons["player-options"].tap()
        captureControls("iPad-player-options", app)
        app.buttons["播放线路"].tap()
        let mirror = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "线路 2")).firstMatch
        XCTAssertTrue(mirror.waitForExistence(timeout: 5))
        mirror.tap()
        let alternative = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (try? String(contentsOf: URL(string: "http://127.0.0.1:18765/test/alternative")!)) == "yes"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [alternative], timeout: 15), .completed)
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
        capture("iPad-search-results")
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
