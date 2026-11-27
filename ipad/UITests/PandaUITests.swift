import XCTest

class PandaScreenTest: XCTestCase {
    func capture(_ name: String) {
        // XCUIScreen captures the complete framebuffer, including an in-flight system sheet.
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func captureControls(_ name: String, _ app: XCUIApplication) {
        capture(name)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-accessibility"
        tree.lifetime = .keepAlways
        add(tree)
    }

    func rotateToPortrait(_ app: XCUIApplication) {
        XCUIDevice.shared.orientation = .portrait
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let frame = app.frame
            let sidebar = app.cells["nav-首页"]
            return frame.height > frame.width && (!sidebar.exists || !sidebar.isHittable)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 12), .completed)
    }

    func fixture(_ scenario: String? = nil, compact: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = compact ? .portrait : .landscapeLeft
        let app = XCUIApplication()
        app.launchEnvironment["PANDA_TEST_PORT"] = "18765"
        app.launchEnvironment["PANDA_TEST_LIBRARY"] = UUID().uuidString
        app.launchEnvironment["PANDA_TEST_SCENARIO"] = scenario
        if compact { app.launchEnvironment["PANDA_TEST_COMPACT"] = "1" }
        app.launch()
        return app
    }

    func target(_ element: XCUIElement, _ name: String) {
        XCTAssertTrue(element.waitForExistence(timeout: 10), name)
        let frame = element.frame
        XCTAssertGreaterThanOrEqual(frame.height, 43.5, "\(name) touch height \(frame)")
        XCTAssertGreaterThanOrEqual(frame.width, 43.5, "\(name) touch width \(frame)")
    }

    func moveTo(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
    }
}

final class PandaUITests: PandaScreenTest {
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
        let level = Int((gain.value as? String ?? "").filter(\.isNumber)) ?? -1
        XCTAssertTrue((25...45).contains(level), "volume after adjustment: \(String(describing: gain.value))")
        let mute = app.buttons["mute"]
        mute.tap()
        XCTAssertTrue(mute.label.contains("取消静音"))
        mute.tap()
        XCTAssertEqual(mute.label, "静音")
        captureControls("iPad-player-volume", app)
        app.buttons["close-volume"].tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !app.buttons["close-volume"].exists }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed)
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
        let resume = app.buttons["resume-26647087"]
        XCTAssertTrue(resume.waitForExistence(timeout: 12))
        captureControls("首页-继续观看卡片", app)
        resume.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 18))
        close.tap()
        let history = app.cells["nav-观看历史"]
        XCTAssertTrue(history.waitForExistence(timeout: 12))
        history.tap()
        let recorded = app.buttons.containing(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "三体", "第 2 集")).firstMatch
        XCTAssertTrue(recorded.waitForExistence(timeout: 12))
        captureControls("资料库-观看历史", app)
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
        app.cells["nav-观看历史"].tap()
        recorded.swipeLeft()
        let remove = app.buttons["删除"].firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 6))
        capture("资料库-划动删除")
        remove.tap()
        XCTAssertTrue(app.buttons["浏览片库"].waitForExistence(timeout: 6))
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
        app.buttons["featured"].firstMatch.tap()
        XCTAssertTrue(app.buttons["favorite"].waitForExistence(timeout: 12))
        let images = expectation(description: "load production detail artwork")
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { images.fulfill() }
        wait(for: [images], timeout: 8)
        capture("iPad-live-detail")
        app.swipeUp()
        capture("iPad-live-detail-credits")
        XCUIDevice.shared.orientation = .landscapeLeft
        let movies = app.cells["nav-电影"]
        XCTAssertTrue(movies.waitForExistence(timeout: 12))
        movies.tap()
        let poster = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "title-")).firstMatch
        if poster.waitForExistence(timeout: 22) { capture("iPad-live-channel") }
        app.cells["nav-搜索"].tap()
        if poster.waitForExistence(timeout: 16) { capture("iPad-live-search") }
    }

    func testLiveProviderPlayback() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launch()
        let featured = app.buttons["featured"].firstMatch
        guard featured.waitForExistence(timeout: 18) else { throw XCTSkip("Live catalogue unavailable") }
        featured.tap()
        let play = app.buttons["play"]
        guard play.waitForExistence(timeout: 28) else { throw XCTSkip("No available provider from this runner") }
        play.tap()
        XCTAssertTrue(app.buttons["close-player"].waitForExistence(timeout: 10))
        let deadline = Date().addingTimeInterval(40)
        var advanced = false
        while Date() < deadline && !app.buttons["retry"].exists {
            let position = app.sliders["Current position"].firstMatch
            if position.exists, let value = position.value as? String,
               let number = value.range(of: #"[0-9]+"#, options: .regularExpression),
               (Int(value[number]) ?? 0) >= 3 { advanced = true; break }
            if !app.buttons["Play/Pause"].exists {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.26, dy: 0.55)).tap()
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.9))
        }
        guard advanced else { throw XCTSkip("Live providers did not deliver advancing media on this runner") }
        captureControls("iPad-live-player", app)
        app.buttons["close-player"].tap()
    }
}
