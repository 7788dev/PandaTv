import XCTest

final class SurfaceAuditTests: PandaScreenTest {
    func testSearchShowsRetryAfterEverySuggestedDetailFailsAndKeepsPartialRecovery() throws {
        _ = try String(contentsOf: URL(string: "http://127.0.0.1:18765/test/reset")!)
        let app = fixture("search-fallback")
        app.cells["nav-搜索"].tap()
        let field = app.searchFields.firstMatch
        field.tap(); field.typeText("lookup")
        let retry = app.buttons["retry"].firstMatch
        XCTAssertTrue(retry.waitForExistence(timeout: 14))
        XCTAssertTrue(app.staticTexts["搜索暂时不可用"].exists)
        _ = try String(contentsOf: URL(string: "http://127.0.0.1:18765/test/recover")!)
        retry.tap()
        XCTAssertTrue(app.buttons["title-26647087"].waitForExistence(timeout: 14))
    }

    func testFinishedEpisodeOnAliasOnlySourceContinuesAtNextAvailableEpisode() throws {
        _ = try String(contentsOf: URL(string: "http://127.0.0.1:18765/test/reset")!)
        let app = fixture("alias-series")
        let quickPlay = app.buttons["featured-play-0"].firstMatch
        XCTAssertTrue(quickPlay.waitForExistence(timeout: 12))
        quickPlay.tap()
        XCTAssertTrue(app.navigationBars["三体 · 第 1 集"].waitForExistence(timeout: 16))
        let segment = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (try? String(contentsOf: URL(string: "http://127.0.0.1:18765/test/played")!)) == "yes"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [segment], timeout: 12), .completed)
        // Allow the two-second generated VOD to run through AVPlayerItemDidPlayToEndTime.
        RunLoop.current.run(until: Date().addingTimeInterval(4))
        app.buttons["close-player"].tap()
        app.terminate(); app.launch()
        let resume = app.buttons["resume-26647087"]
        XCTAssertTrue(resume.waitForExistence(timeout: 12))
        XCTAssertTrue(resume.label.contains("播放下一集"))
        resume.tap()
        XCTAssertTrue(app.navigationBars["三体 · 第 3 集"].waitForExistence(timeout: 16))
    }

    func testSwipeFeaturedAndOpenTheSelectedWork() {
        let app = fixture()
        let first = app.buttons["featured"].firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 12))
        let second = app.buttons["featured-1"].firstMatch
        first.swipeLeft()
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in second.exists && second.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 10), .completed)
        capture("首页-分页推荐")
        rotateToPortrait(app)
        XCTAssertTrue(second.isHittable)
        second.tap()
        XCTAssertTrue(app.staticTexts["流浪地球"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["play"].waitForExistence(timeout: 10))
    }
    func testLoadingStatesResolveIntoContent() throws {
        let hold = URL(string: "http://127.0.0.1:18765/test/hold")!
        let release = URL(string: "http://127.0.0.1:18765/test/release")!
        _ = try String(contentsOf: hold)
        defer { _ = try? String(contentsOf: release) }
        let app = fixture("delayed")
        let loading = app.descendants(matching: .any)["home-loading"].firstMatch
        XCTAssertTrue(loading.waitForExistence(timeout: 8))
        capture("载入-首页")
        _ = try String(contentsOf: release)
        XCTAssertTrue(app.buttons["featured"].firstMatch.waitForExistence(timeout: 12))
        _ = try String(contentsOf: hold)
        app.cells["nav-电影"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["channel-loading"].firstMatch.waitForExistence(timeout: 8))
        capture("载入-频道")
        _ = try String(contentsOf: release)
        XCTAssertTrue(app.buttons["title-26266893"].waitForExistence(timeout: 12))
    }
    func testChannelsFiltersPagingAndMovieDetail() {
        let app = fixture()
        let channels = [("剧集","26647087"), ("综艺","123401"), ("动漫","123402"), ("纪录片","123403"), ("电影","26266893")]
        for (name, id) in channels {
            app.cells["nav-\(name)"].tap()
            let card = app.buttons["title-\(id)"]
            XCTAssertTrue(card.waitForExistence(timeout: 12), name)
            target(app.buttons["channel-filters"], name + "筛选")
            app.segmentedControls.buttons["评分"].tap()
            XCTAssertTrue(card.waitForExistence(timeout: 12))
            capture("频道-" + name)
        }
        app.buttons["more-titles"].tap()
        XCTAssertTrue(app.buttons["title-8826266893"].waitForExistence(timeout: 10))
        app.buttons["channel-filters"].tap()
        captureControls("频道-筛选表单", app)
        app.buttons["filter-类型"].tap()
        app.buttons["科幻"].tap()
        app.buttons["filter-年份"].tap()
        app.buttons[String(Calendar.current.component(.year, from: Date()))].firstMatch.tap()
        app.buttons["filter-地区"].tap()
        app.buttons["美国"].tap()
        app.buttons["apply-filters"].tap()
        XCTAssertTrue(app.staticTexts["这个筛选条件下没有作品"].waitForExistence(timeout: 10))
        capture("频道-空结果")
        app.buttons["channel-filters"].tap()
        app.buttons["reset-filters"].tap()
        app.buttons["apply-filters"].tap()
        app.buttons["title-26266893"].tap()
        target(app.buttons["favorite"], "收藏")
        XCTAssertTrue(app.buttons["play"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["episode-2"].exists)
        capture("详情-电影")
        let expand = app.buttons["展开简介"]
        moveTo(expand, in: app)
        XCTAssertTrue(expand.isHittable)
        expand.tap()
        XCTAssertTrue(app.buttons["收起简介"].exists)
        capture("详情-完整简介")
        app.buttons["收起简介"].tap()
    }

    func testSystemScrollingPerformance() {
        let app = fixture("scroll")
        app.cells["nav-电影"].tap()
        let poster = app.buttons["title-30000000"]
        XCTAssertTrue(poster.waitForExistence(timeout: 12))
        let scroll = app.scrollViews.containing(.button, identifier: "title-30000000").firstMatch
        XCTAssertTrue(scroll.exists)
        let options = XCTMeasureOptions()
        options.iterationCount = 2
        measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
            scroll.swipeUp(velocity: .fast)
            scroll.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(poster.isHittable)
    }

    func testLibrarySearchAndEpisodeGroups() {
        let app = fixture()
        for section in ["收藏", "观看历史"] {
            app.cells["nav-\(section)"].tap()
            XCTAssertTrue(app.buttons["浏览片库"].waitForExistence(timeout: 10))
            capture("资料库-空" + section)
        }
        app.buttons["浏览片库"].tap()
        app.buttons["featured"].firstMatch.tap()
        let favorite = app.buttons["favorite"]
        XCTAssertTrue(favorite.waitForExistence(timeout: 12))
        favorite.tap()
        let range = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "1–20 集")).firstMatch
        XCTAssertTrue(range.waitForExistence(timeout: 12))
        range.tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "21–24 集")).firstMatch.tap()
        XCTAssertTrue(app.buttons["episode-24"].waitForExistence(timeout: 10))
        capture("详情-剧集分组")
        app.cells["nav-收藏"].tap()
        let card = app.buttons["title-26647087"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        capture("资料库-收藏")
        card.press(forDuration: 1)
        XCTAssertTrue(app.buttons["取消收藏"].waitForExistence(timeout: 5))
        capture("资料库-长按菜单")
        app.buttons["取消收藏"].tap()
        XCTAssertTrue(app.buttons["浏览片库"].waitForExistence(timeout: 10))
        app.cells["nav-搜索"].tap()
        XCTAssertTrue(app.buttons["title-26266893"].waitForExistence(timeout: 10))
        capture("搜索-热门")
        let field = app.searchFields.firstMatch
        field.tap(); field.typeText("ST")
        let hint = app.buttons["三体"].firstMatch
        XCTAssertTrue(hint.waitForExistence(timeout: 12))
        capture("搜索-首字母建议")
        hint.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.tap()
        app.cells["nav-搜索"].tap()
        XCTAssertTrue(app.staticTexts["最近搜索"].waitForExistence(timeout: 10))
        capture("搜索-最近搜索")
        app.buttons["清除"].tap()
        field.tap(); field.typeText("zzzzz")
        XCTAssertTrue(app.staticTexts["没有找到相关作品"].waitForExistence(timeout: 12))
        capture("搜索-空结果")
    }

    func testNetworkFailuresAndRecovery() throws {
        let reset = URL(string: "http://127.0.0.1:18765/test/reset")!
        _ = try String(contentsOf: reset)
        let app = fixture("offline")
        let retry = app.buttons["retry"].firstMatch
        XCTAssertTrue(retry.waitForExistence(timeout: 14))
        capture("异常-首页离线")
        _ = try String(contentsOf: URL(string: "http://127.0.0.1:18765/test/recover")!)
        retry.tap()
        XCTAssertTrue(app.buttons["featured"].firstMatch.waitForExistence(timeout: 15))
        app.terminate()
        let unavailable = fixture("no-source")
        unavailable.buttons["featured"].firstMatch.tap()
        XCTAssertTrue(unavailable.staticTexts["暂时没有可播放的线路"].waitForExistence(timeout: 14))
        capture("异常-无片源")
        unavailable.buttons["retry"].tap()
        XCTAssertTrue(unavailable.staticTexts["暂时没有可播放的线路"].waitForExistence(timeout: 14))
        unavailable.terminate()
        let broken = fixture("bad-media")
        broken.buttons["featured"].firstMatch.tap()
        XCTAssertTrue(broken.buttons["play"].waitForExistence(timeout: 14))
        broken.buttons["play"].tap()
        XCTAssertTrue(broken.buttons["retry"].waitForExistence(timeout: 30))
        captureControls("异常-播放器重试", broken)
        broken.buttons["retry"].tap()
        XCTAssertTrue(broken.buttons["retry"].waitForExistence(timeout: 30))
        broken.buttons["close-player"].tap()
        XCTAssertTrue(broken.buttons["favorite"].waitForExistence(timeout: 8))
    }
}

final class AdaptiveAppearanceTests: PandaScreenTest {
    func testDarkSidebarChannelAndFilterSheet() {
        let app = fixture()
        XCTAssertTrue(app.buttons["featured"].firstMatch.waitForExistence(timeout: 12))
        capture("适配-深色大字横屏")
        let movies = app.cells["nav-电影"]
        if !movies.isHittable { app.collectionViews.firstMatch.swipeUp() }
        movies.tap()
        target(app.buttons["channel-filters"], "大字号筛选")
        app.buttons["channel-filters"].tap()
        XCTAssertTrue(app.buttons["apply-filters"].waitForExistence(timeout: 8))
        capture("适配-深色筛选表单")
        app.buttons["cancel-filters"].tap()
        XCTAssertTrue(app.buttons["title-26266893"].waitForExistence(timeout: 10))
    }
    // The workflow runs these screens after switching the actual simulator to dark appearance
    // and an accessibility Dynamic Type category. A 375-point host exercises the compact layout.
    func testCompactLargeTextAndPlayer() {
        let app = fixture(compact: true)
        let feature = app.buttons["featured"].firstMatch
        XCTAssertTrue(feature.waitForExistence(timeout: 15))
        XCTAssertLessThanOrEqual(feature.frame.width, 375)
        captureControls("适配-深色大字窄窗首页", app)
        feature.tap()
        let favorite = app.buttons["favorite"]
        moveTo(favorite, in: app)
        target(favorite, "窄窗收藏")
        capture("适配-深色大字详情")
        let play = app.buttons["play"]
        moveTo(play, in: app)
        play.tap()
        let volume = app.buttons["volume-button"]
        target(volume, "窄窗音量")
        volume.tap()
        target(app.buttons["mute"], "静音")
        XCTAssertTrue(app.sliders["volume-slider"].exists)
        captureControls("适配-深色大字音量", app)
        app.buttons["close-volume"].tap()
        app.buttons["close-player"].tap()
    }
}
