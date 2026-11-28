import AVKit
import SwiftUI

@MainActor
final class PlaybackSession: ObservableObject {
    let player = AVPlayer()
    @Published private(set) var selected = 0
    @Published private(set) var failed = false
    @Published private(set) var episode: PlayEpisode
    @Published private(set) var volume: Double
    private var previousVolume: Double
    private let request: PlaybackRequest
    private let library: Library
    private var catalogue: [PlayEpisode]
    private var position: Double
    private var recordable = false
    private var finished = false
    private var tried = Set<URL>()
    private var status: NSKeyValueObservation?
    private var clock: Any?
    private var notifications: [NSObjectProtocol] = []
    private var watchdog: Task<Void, Never>?
    private var started = false
    private var playWhenReady = true

    init(request: PlaybackRequest, library: Library) {
        self.request = request
        self.library = library
        position = request.resume
        episode = request.episode
        catalogue = request.episodes
        let saved = UserDefaults.standard.object(forKey: "panda.ipad.playback.volume") as? Double ?? 1
        let gain = min(1, max(0, saved))
        volume = gain
        previousVolume = gain > 0 ? gain : 1
        player.volume = Float(gain)
    }

    func setVolume(_ level: Double) {
        guard level.isFinite else { return }
        volume = min(1, max(0, level))
        player.volume = Float(volume)
        if volume > 0 { previousVolume = volume }
        UserDefaults.standard.set(volume, forKey: "panda.ipad.playback.volume")
    }
    func toggleMute() { setVolume(volume > 0 ? 0 : previousVolume) }
    func updateStreams(_ episodes: [PlayEpisode]) {
        guard !episodes.isEmpty else { return }
        catalogue = episodes
        guard var updated = episode.corresponding(in: episodes) else { return }
        let current = episode.streams[selected]
        if !updated.streams.contains(where: { $0.url == current.url }) { updated.streams.append(current) }
        if episode != updated {
            episode = updated
            selected = updated.streams.firstIndex { $0.url == current.url } ?? 0
        }
        if finished { save() }
        if failed, let index = updated.streams.firstIndex(where: { !tried.contains($0.url) }) { choose(index) }
    }
    func changeEpisode(_ next: PlayEpisode) {
        guard let next = next.corresponding(in: catalogue), next.id != episode.id, !next.streams.isEmpty else { return }
        save()
        recordable = false
        episode = next
        position = 0
        tried.removeAll()
        choose(0)
    }

    func start() {
        guard !started else { return }
        started = true
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        clock = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.save() }
        }
        choose(0)
    }

    func switchLine(_ url: URL) {
        guard let index = episode.streams.firstIndex(where: { $0.url == url }), index != selected || failed else { return }
        choose(index, play: !recordable || player.timeControlStatus != .paused)
    }

    private func choose(_ index: Int, play: Bool = true) {
        guard episode.streams.indices.contains(index) else { return }
        save()
        detachItem()
        selected = index
        tried.insert(episode.streams[index].url)
        recordable = false
        finished = false
        failed = false
        playWhenReady = play
        let item = AVPlayerItem(url: Network.transportURL(episode.streams[index].url))
        player.replaceCurrentItem(with: item)
        status = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async { self?.handleStatus(item) }
        }
        let center = NotificationCenter.default
        notifications = [
            center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self = self, self.player.currentItem === item else { return }
                    self.finished = true
                    self.save()
                }
            },
            center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.fallback(item) }
            },
            center.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.watch(item, duringStartup: false) }
            }
        ]
        watch(item, duringStartup: true)
    }

    private func handleStatus(_ item: AVPlayerItem) {
        guard player.currentItem === item else { return }
        switch item.status {
        case .failed: fallback(item)
        case .readyToPlay:
            guard !recordable else { return }
            let duration = item.duration.seconds
            let start = duration.isFinite && duration > 0 && position >= duration - 1 ? 0 : position
            let begin = { [weak self] in
                guard let self = self, self.player.currentItem === item else { return }
                self.recordable = true
                if self.playWhenReady { self.player.play() }
            }
            if start >= 1 {
                player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { ok in
                    DispatchQueue.main.async { if ok { begin() } }
                }
            } else { begin() }
        default: break
        }
    }

    private func watch(_ item: AVPlayerItem, duringStartup: Bool) {
        watchdog?.cancel()
        let from = player.currentTime().seconds
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 14_000_000_000)
            guard !Task.isCancelled, let self = self, self.player.currentItem === item,
                  UIApplication.shared.applicationState == .active else { return }
            let waiting = self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate
            if duringStartup && !self.recordable || waiting && !(self.player.currentTime().seconds > from + 0.5) { self.fallback(item) }
        }
    }

    private func fallback(_ item: AVPlayerItem) {
        guard player.currentItem === item else { return }
        if let index = episode.streams.firstIndex(where: { !tried.contains($0.url) }) { choose(index) }
        else {
            save()
            detachItem()
            player.replaceCurrentItem(with: nil)
            recordable = false
            failed = true
        }
    }

    func retry() { tried.removeAll(); choose(0) }
    func save() {
        guard recordable, let item = player.currentItem else { return }
        let time = player.currentTime().seconds
        guard time.isFinite, time >= 1 else { return }
        let duration = item.duration.seconds
        if finished && duration.isFinite && time < duration - 1 && player.rate > 0 { finished = false }
        position = time
        library.record(WatchEntry(subject: request.subject, episode: episode.number, label: episode.title,
            seconds: time, duration: duration.isFinite ? duration : 0, finished: finished, mediaKey: episode.mediaKey,
            hasNextEpisode: catalogue.contains { $0.number > episode.number && $0.id != episode.id }))
    }
    private func detachItem() {
        watchdog?.cancel(); watchdog = nil
        status?.invalidate(); status = nil
        notifications.forEach(NotificationCenter.default.removeObserver)
        notifications.removeAll()
    }
    func stop() {
        guard started else { return }
        save()
        detachItem()
        if let clock = clock { player.removeTimeObserver(clock); self.clock = nil }
        player.pause()
        player.replaceCurrentItem(with: nil)
        recordable = false
        started = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
