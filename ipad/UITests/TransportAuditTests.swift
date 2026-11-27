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

    private func node(_ id: String, in snapshot: XCUIElementSnapshot) -> XCUIElementSnapshot? {
        if snapshot.identifier == id && !snapshot.frame.isEmpty { return snapshot }
        for child in snapshot.children {
            if let match = node(id, in: child) { return match }
        }
        return nil
    }

    // AVKit hides its chrome roughly three seconds after the last touch. Capture the actual
    // control's frame once and dispatch a touch without a second AX lookup or scroll-to-visible.
    private func control(_ id: String, _ app: XCUIApplication) throws -> XCUIElementSnapshot {
        for _ in 0..<4 {
            if let match = node(id, in: try app.snapshot()) { return match }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.26, dy: 0.55)).tap()
        }
        return try XCTUnwrap(node(id, in: app.snapshot()), "AVKit control \(id)")
    }

    private func point(_ box: CGRect, fraction: CGFloat = 0.5, _ app: XCUIApplication) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: box.minX + box.width * fraction, dy: box.midY))
    }
    @discardableResult private func tapNative(_ id: String, _ app: XCUIApplication) throws -> XCUIElementSnapshot {
        let item = try control(id, app)
        point(item.frame, app).tap()
        return item
    }

    func testPauseSeekSkipSpeedAndEpisodeSelection() throws {
        let app = try openPlayer()
        let playingLabel = try tapNative("Play/Pause", app).label
        XCTAssertNotEqual(try control("Play/Pause", app).label, playingLabel)
        let initial = try control("Current position", app).value as? String
        try tapNative("Skip Forward", app)
        let advanced = try control("Current position", app).value as? String
        XCTAssertNotEqual(initial, advanced)
        try tapNative("Skip Backward", app)
        let bar = try control("Current position", app)
        let before = bar.value as? String
        XCTAssertNotEqual(before, advanced)
        point(bar.frame, fraction: 0.055, app).press(forDuration: 0.2, thenDragTo: point(bar.frame, fraction: 0.42, app))
        let scrubbed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let snapshot = try? app.snapshot(), let value = self.node("Current position", in: snapshot)?.value as? String else { return false }
            return value != before
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [scrubbed], timeout: 5), .completed)
        captureControls("播放-暂停与拖动进度", app)
        if node("AVPlaybackSpeedControl", in: try app.snapshot()) != nil {
            try tapNative("AVPlaybackSpeedControl", app)
            captureControls("播放-系统倍速", app)
            let faster = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "1.5")).firstMatch
            XCTAssertTrue(faster.waitForExistence(timeout: 6))
            faster.tap()
        }
        if try control("Play/Pause", app).label != playingLabel { try tapNative("Play/Pause", app) }
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
        try tapNative("Fullscreen Button", app)
        captureControls("播放-系统全屏", app)
        let close = app.buttons["close-player"]
        if !close.isHittable {
            try tapNative("Close Button", app)
        }
        XCTAssertTrue(close.waitForExistence(timeout: 6))
        try tapNative("AirPlay", app)
        captureControls("播放-隔空播放设备面板", app)
        // A hosted simulator has no external receiver. Reopen the title for the independent PiP control.
        app.terminate()
        let pipApp = try openPlayer()
        try tapNative("PIP Button", pipApp)
        captureControls("播放-画中画状态", pipApp)
        pipApp.terminate()
    }
}
