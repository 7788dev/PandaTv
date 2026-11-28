import Foundation
import Combine

struct WatchEntry: Codable, Identifiable {
    let subject: Subject
    let episode: Int
    let label: String
    let seconds, duration: Double
    let finished: Bool
    var mediaKey: String?
    var hasNextEpisode: Bool?
    var id: String { subject.id }
    var fraction: Double { duration > 0 ? min(1, max(0, seconds / duration)) : 0 }
    var canContinue: Bool {
        !finished || (subject.kind != "movie" && (hasNextEpisode ?? (episode < (subject.expectedEpisodes ?? 0))))
    }
    var continueDetail: String { finished ? "\(label) · 播放下一集" : detail }

    func watched(in episodes: [PlayEpisode]) -> PlayEpisode? {
        episodes.first { $0.id == (mediaKey ?? label) }
    }

    var detail: String {
        let time = String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
        return label + " · " + (finished ? "已看完" : time)
    }
}

@MainActor
final class Library: ObservableObject {
    private struct Snapshot: Codable {
        var favorites: [Subject] = []
        var history: [WatchEntry] = []
        var queries: [String]?
    }
    private let defaults: UserDefaults
    private let key: String
    @Published private var state: Snapshot
    var favorites: [Subject] { state.favorites }
    var history: [WatchEntry] { state.history }
    var queries: [String] { state.queries ?? [] }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        #if DEBUG && targetEnvironment(simulator)
        key = "panda.ipad.library.v1" + (ProcessInfo.processInfo.environment["PANDA_TEST_LIBRARY"].map { "." + $0 } ?? "")
        #else
        key = "panda.ipad.library.v1"
        #endif
        state = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } ?? Snapshot()
    }

    func isFavorite(_ subject: Subject) -> Bool { favorites.contains { $0.id == subject.id } }
    func toggle(_ subject: Subject) {
        if isFavorite(subject) { state.favorites.removeAll { $0.id == subject.id } }
        else { state.favorites.insert(subject, at: 0) }
        save()
    }
    func removeHistory(_ id: String) {
        state.history.removeAll { $0.id == id }
        save()
    }
    func rememberQuery(_ input: String) {
        let query = String(input.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
        guard !query.isEmpty else { return }
        state.queries = [query] + queries.filter { $0.caseInsensitiveCompare(query) != .orderedSame }.prefix(9)
        save()
    }
    func clearQueries() { state.queries = []; save() }
    func record(_ entry: WatchEntry) {
        guard entry.finished || (entry.seconds.isFinite && entry.seconds >= 1),
              entry.duration.isFinite else { return }
        state.history = [entry] + state.history.filter { $0.id != entry.id }.prefix(199)
        save()
    }
    private func save() {
        if let data = try? JSONEncoder().encode(state) { defaults.set(data, forKey: key) }
    }
}
