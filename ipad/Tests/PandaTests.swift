import XCTest
@testable import Panda

final class PandaTests: XCTestCase {
    private let row: JSONRow = ["id":"26647087", "type":"tv", "title":"三体", "year":"2023",
        "card_subtitle":"2023 / 中国大陆 / 剧情 科幻 / 杨磊"]

    func testCatalogAndPlaybackAgreeOnWorkAndEpisodes() throws {
        let subject = try XCTUnwrap(Subject(row))
        XCTAssertEqual(subject.region, "中国大陆")
        XCTAssertEqual(subject.channel, .tv)
        XCTAssertNil(Subject(row.merging(["genres":["情色"]]) { _, new in new }))
        let source = try XCTUnwrap(Sources.configured().first)
        let record: JSONRow = ["vod_name":"三体第一季", "vod_year":2023, "type_name":"国产剧", "vod_area":"大陆",
            "vod_play_from":"hls", "vod_play_url":"第02集$https://stream.example.org/2.m3u8#花絮$https://stream.example.org/b.mp4#第01集$https://stream.example.org/1.mp4#第01集$https://stream.example.org/mirror.mp4"]
        XCTAssertNil(Sources.match(subject, record: record.merging(["vod_area":"美国"]) { _, new in new }))
        XCTAssertNil(Sources.match(subject, record: record.merging(["type_name":"伦理片"]) { _, new in new }))
        let episodes = Sources.episodes(Sources.lines(record, subject: subject, source: source))
        XCTAssertEqual(episodes.map(\.number), [1, 2])
        XCTAssertEqual(episodes.map { $0.streams.count }, [2, 1])
    }

    @MainActor func testLibrarySurvivesRelaunch() throws {
        let domain = "panda.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let subject = try XCTUnwrap(Subject(row))
        let library = Library(defaults: defaults)
        library.toggle(subject)
        library.record(WatchEntry(subject: subject, episode: 3, label: "第 3 集", seconds: 63, duration: 200, finished: false))
        let restored = Library(defaults: defaults)
        XCTAssertTrue(restored.isFavorite(subject))
        XCTAssertEqual(restored.history.first?.detail, "第 3 集 · 1:03")
    }
}
