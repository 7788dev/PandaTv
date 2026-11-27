import AVKit
import SwiftUI

@MainActor
final class PlaybackSession: ObservableObject {
    let player = AVPlayer()
    @Published private(set) var selected = 0
    @Published private(set) var failed = false
    private let request: PlaybackRequest
    private let library: Library
    private var position: Double
    private var recordable = false
    private var finished = false
    private var tried = Set<Int>()
    private var status: NSKeyValueObservation?
    private var clock: Any?
    private var notifications: [NSObjectProtocol] = []
    private var watchdog: Task<Void, Never>?
    private var started = false

    init(request: PlaybackRequest, library: Library) {
        self.request = request
        self.library = library
        position = request.resume
    }

    func start() {
        guard !started else { return }
        started = true
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        clock = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            self?.save()
        }
        choose(0)
    }

    func choose(_ index: Int) {
        guard request.episode.streams.indices.contains(index) else { return }
        save()
        detachItem()
        selected = index
        tried.insert(index)
        recordable = false
        finished = false
        failed = false
        let item = AVPlayerItem(url: Network.transportURL(request.episode.streams[index].url))
        player.replaceCurrentItem(with: item)
        status = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async { self?.handleStatus(item) }
        }
        let center = NotificationCenter.default
        notifications = [
            center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                guard let self = self, self.player.currentItem === item else { return }
                self.finished = true
                self.save()
            },
            center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                self?.fallback(item)
            },
            center.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { [weak self] _ in
                self?.watch(item, duringStartup: false)
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
                self.player.play()
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
        if let index = request.episode.streams.indices.first(where: { !tried.contains($0) }) { choose(index) }
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
        library.record(WatchEntry(subject: request.subject, episode: request.episode.number, label: request.episode.title,
            seconds: time, duration: duration.isFinite ? duration : 0, finished: finished))
    }
    private func detachItem() {
        watchdog?.cancel(); watchdog = nil
        status?.invalidate(); status = nil
        notifications.forEach(NotificationCenter.default.removeObserver)
        notifications.removeAll()
    }
    func stop() {
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

private struct SystemPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.videoGravity = .resizeAspect
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
}

struct PlayerPage: View {
    let request: PlaybackRequest
    @StateObject private var session: PlaybackSession
    @Environment(\.dismiss) private var dismiss

    @MainActor init(request: PlaybackRequest, library: Library) {
        self.request = request
        _session = StateObject(wrappedValue: PlaybackSession(request: request, library: library))
    }
    var body: some View {
        NavigationView {
            ZStack {
                Color.black.ignoresSafeArea()
                if session.failed {
                    NoticeView(symbol: "exclamationmark.circle", message: "这一集的线路暂时无法播放") { session.retry() }
                } else {
                    SystemPlayer(player: session.player).accessibilityIdentifier("system-player")
                }
            }
            .navigationTitle(request.subject.kind == "movie" ? request.subject.title : "\(request.subject.title) · \(request.episode.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }.accessibilityIdentifier("close-player")
                }
                if request.episode.streams.count > 1 {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            ForEach(Array(request.episode.streams.enumerated()), id: \.offset) { index, stream in
                                Button { session.choose(index) } label: {
                                    if index == session.selected { Label(stream.source, systemImage: "checkmark") }
                                    else { Text(stream.source) }
                                }
                            }
                        } label: { Label("播放线路", systemImage: "list.bullet") }
                    }
                }
            }
        }
        .navigationViewStyle(.stack).preferredColorScheme(.dark)
        .onAppear { session.start() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in session.save() }
        .onDisappear { session.stop() }
    }
}
