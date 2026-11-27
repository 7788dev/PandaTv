import Foundation
import Combine

struct WatchEntry: Codable, Identifiable {
    let subject: Subject
    let episode: Int
    let label: String
    let seconds, duration: Double
    let finished: Bool
    var id: String { subject.id }

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
    }
    private let defaults: UserDefaults
    private let key = "panda.ipad.library.v1"
    @Published private var state: Snapshot
    var favorites: [Subject] { state.favorites }
    var history: [WatchEntry] { state.history }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
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
