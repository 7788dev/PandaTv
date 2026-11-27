import XCTest

final class TransportAuditTests: PandaScreenTest {
    private func openPlayer() throws -> XCUIApplication {
        _ = try String(contentsOf: URL(string: "http://127.0.0.1:18765/test/reset")!)
        let app = fixture()
        let quickPlay = app.buttons["featured-play-0"].firstMatch
        XCTAssertTrue(quickPlay.waitForExistence(timeout: 15))
        quickPlay.tap()
        XCTAssertTrue(app.buttons["close-player"].waitForExistence(timeout: 16))
        let decoding = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (try? String(contentsOf: URL(string: "http://127.0.0.1:18765/test/played")!)) == "yes"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [decoding], timeout: 18), .completed)
        return app
    }

    private func reveal(_ app: XCUIApplication) {
        let play = app.buttons["Play/Pause"].firstMatch
        if play.exists && play.isHittable { return }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.55)).tap()
        XCTAssertTrue(play.waitForExistence(timeout: 4))
    }

    func testPauseSeekSkipSpeedAndEpisodeSelection() throws {
        let app = try openPlayer()
        reveal(app)
        let toggle = app.buttons["Play/Pause"].firstMatch
        let playingLabel = toggle.label
        toggle.tap()
        XCTAssertNotEqual(toggle.label, playingLabel)
        let bar = app.sliders["Current position"].firstMatch
        let initial = bar.value as? String
        app.buttons["Skip Forward"].firstMatch.tap()
        let advanced = bar.value as? String
        XCTAssertNotEqual(initial, advanced)
        app.buttons["Skip Backward"].firstMatch.tap()
        XCTAssertNotEqual(bar.value as? String, advanced)
        let before = bar.value as? String
        bar.coordinate(withNormalizedOffset: CGVector(dx: 0.055, dy: 0.5)).press(forDuration: 0.18,
            thenDragTo: bar.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.5)))
        let scrubbed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let value = bar.value as? String else { return false }
            return value != before
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [scrubbed], timeout: 5), .completed)
        captureControls("播放-暂停与拖动进度", app)
        let speed = app.buttons["AVPlaybackSpeedControl"].firstMatch
        if speed.exists && speed.isHittable {
            speed.tap()
            captureControls("播放-系统倍速", app)
            let faster = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "1.5")).firstMatch
            XCTAssertTrue(faster.waitForExistence(timeout: 6))
            faster.tap()
        }
        reveal(app)
        if toggle.label != playingLabel { toggle.tap() }
        app.buttons["player-options"].tap()
        app.buttons["下一集"].tap()
        XCTAssertTrue(app.navigationBars["三体 · 第 2 集"].waitForExistence(timeout: 8))
        app.buttons["player-options"].tap()
        app.buttons["选集"].tap()
        app.buttons["21–24 集"].tap()
        capture("播放-播放器内选集")
        app.buttons["第 24 集"].tap()
        XCTAssertTrue(app.navigationBars["三体 · 第 24 集"].waitForExistence(timeout: 8))
        app.buttons["close-player"].tap()
    }

    func testNativeFullscreenRoutePickerAndPictureInPicture() throws {
        let app = try openPlayer()
        reveal(app)
        app.buttons["Fullscreen Button"].firstMatch.tap()
        captureControls("播放-系统全屏", app)
        let close = app.buttons["close-player"]
        if !close.isHittable {
            reveal(app)
            let exit = app.buttons.matching(NSPredicate(format: "identifier IN %@ OR label IN %@",
                ["Done", "Dismiss", "Fullscreen Button"], ["退出全屏幕", "退出全屏", "关闭", "完成", "Done", "Exit Full Screen"]))
                .allElementsBoundByIndex.first { $0.identifier != "close-player" && $0.isHittable }
            if let exit = exit { exit.tap() } else { app.swipeDown() }
        }
        XCTAssertTrue(close.waitForExistence(timeout: 6))
        reveal(app)
        app.buttons["AirPlay"].firstMatch.tap()
        captureControls("播放-隔空播放设备面板", app)
        // A hosted simulator has no external receiver. Reopen the title for the independent PiP control.
        app.terminate()
        let pipApp = try openPlayer()
        reveal(pipApp)
        let pip = pipApp.buttons["PIP Button"].firstMatch
        if pip.exists && pip.isEnabled {
            pip.tap()
            captureControls("播放-画中画状态", pipApp)
        }
        pipApp.terminate()
    }
}
