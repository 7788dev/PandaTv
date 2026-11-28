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

    func testSerialRangeKeepsUniqueNumberedEpisodesAlongsideExtras() throws {
        let subject = try XCTUnwrap(Subject(row.merging(["title":"三体年番", "aka":["三体 第11-20集"]]) { _, new in new }))
        let source = try XCTUnwrap(Sources.configured().first)
        let labels = (1...24).map { "第\($0)集" } + ["第12集", "第24集上", "导演剪辑版"]
        func episodes(_ labels: [String]) -> [PlayEpisode] {
            let playlist = labels.enumerated().map { "\($0.element)$https://stream.example.org/\($0.offset).mp4" }.joined(separator: "#")
            let record: JSONRow = ["vod_name":"三体", "type_name":"国产剧", "vod_year":2023, "vod_play_url":playlist]
            return Sources.episodes(Sources.lines(record, subject: subject, source: source))
        }
        let valid = episodes(labels)
        XCTAssertEqual(valid.map(\.number), [1, 3, 4, 5, 6, 7, 8, 9, 10])
        XCTAssertEqual(valid.first?.streams.first?.url.lastPathComponent, "10.mp4")
        XCTAssertTrue(episodes(["第11集", "导演剪辑版"]).isEmpty)
    }

    @MainActor func testDatedIssueKeepsItsMirrorsAndHistoryAfterCatalogueReorder() throws {
        let subject = try XCTUnwrap(Subject(row))
        let source = try XCTUnwrap(Sources.configured().first)
        func lines(_ prefix: String, _ dates: [String]) -> [Sources.Line] {
            let playlist = dates.map { "\($0)$https://stream.example.org/\(prefix)-\($0).mp4" }.joined(separator: "#")
            return Sources.lines(["vod_name":"三体", "type_name":"国产剧", "vod_year":2023, "vod_play_url":playlist], subject: subject, source: source)
        }
        let first = lines("a", ["20261126", "20261125"])
        let before = Sources.episodes(first)
        let current = try XCTUnwrap(before.first)
        let session = PlaybackSession(request: PlaybackRequest(subject: subject, episode: current, episodes: before, resume: 0), library: Library())
        let after = Sources.episodes(first + lines("b", ["20261127", "20261126", "20261125"]))
        session.updateStreams(after)
        XCTAssertEqual(session.episode.number, 2)
        XCTAssertEqual(session.episode.title, "20261126")
        XCTAssertEqual(Set(session.episode.streams.map { $0.url.lastPathComponent }), ["a-20261126.mp4", "b-20261126.mp4"])
        XCTAssertEqual(session.episode.streams[session.selected].url, current.streams[0].url)
        let saved = WatchEntry(subject: subject, episode: 1, label: current.title, seconds: 45, duration: 180, finished: false)
        XCTAssertEqual(saved.watched(in: after)?.number, 2)
        session.updateStreams([after[0]])
        XCTAssertEqual(session.episode.title, current.title)
    }

    func testInitialsWithDigitsUseTheBundledVocabulary() async {
        let hints = await TitleIndex.shared.hints("ＬＬＤＱ２")
        XCTAssertTrue(hints.contains("流浪地球2"))
        let invalid = await TitleIndex.shared.hints("2Q")
        XCTAssertTrue(invalid.isEmpty)
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
        XCTAssertTrue(restored.queries.isEmpty)
        restored.rememberQuery("三体"); restored.rememberQuery("ST"); restored.rememberQuery("st")
        XCTAssertEqual(Library(defaults: defaults).queries, ["st", "三体"])
    }

    func testContinuationHonorsKnownAvailabilityAndReadsLegacyHistory() throws {
        let subject = try XCTUnwrap(Subject(row.merging(["episodes_count":3]) { _, new in new }))
        var entry = WatchEntry(subject: subject, episode: 1, label: "第 1 集", seconds: 90, duration: 90, finished: true)
        let legacy = try JSONDecoder().decode(WatchEntry.self, from: JSONEncoder().encode(entry))
        XCTAssertTrue(legacy.canContinue)
        entry.hasNextEpisode = false
        XCTAssertFalse(entry.canContinue)
        entry.hasNextEpisode = true
        XCTAssertTrue(entry.canContinue)
    }

    @MainActor func testPlayerGainAndLateArrivingMirrors() throws {
        let subject = try XCTUnwrap(Subject(row))
        let stream = Stream(url: URL(string: "https://a.example.org/v.m3u8")!, source: "A", priority: 1, weak: false)
        let mirror = Stream(url: URL(string: "https://b.example.org/v.m3u8")!, source: "B", priority: 2, weak: false)
        let episode = PlayEpisode(number: 1, title: "第 1 集", streams: [stream])
        let request = PlaybackRequest(subject: subject, episode: episode, episodes: [episode], resume: 0)
        let previous = UserDefaults.standard.object(forKey: "panda.ipad.playback.volume")
        defer { UserDefaults.standard.set(previous, forKey: "panda.ipad.playback.volume") }
        let session = PlaybackSession(request: request, library: Library())
        session.setVolume(0.35)
        XCTAssertEqual(session.player.volume, 0.35, accuracy: 0.001)
        session.toggleMute()
        XCTAssertEqual(session.player.volume, 0)
        session.toggleMute()
        XCTAssertEqual(session.player.volume, 0.35, accuracy: 0.001)
        session.updateStreams([PlayEpisode(number: 1, title: episode.title, streams: [mirror, stream])])
        XCTAssertEqual(session.episode.streams[session.selected].url, stream.url)
    }
}
