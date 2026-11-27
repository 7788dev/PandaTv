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
        episode = request.episode
        let saved = UserDefaults.standard.object(forKey: "panda.ipad.playback.volume") as? Double ?? 1
        volume = min(1, max(0, saved))
        previousVolume = volume > 0 ? volume : 1
        player.volume = Float(volume)
    }

    func setVolume(_ level: Double) {
        guard level.isFinite else { return }
        volume = min(1, max(0, level))
        player.volume = Float(volume)
        if volume > 0 { previousVolume = volume }
        UserDefaults.standard.set(volume, forKey: "panda.ipad.playback.volume")
    }
    func toggleMute() { setVolume(volume > 0 ? 0 : previousVolume) }
    func changeEpisode(_ next: PlayEpisode) {
        guard next.number != episode.number, !next.streams.isEmpty else { return }
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

    func choose(_ index: Int) {
        guard episode.streams.indices.contains(index) else { return }
        save()
        detachItem()
        selected = index
        tried.insert(index)
        recordable = false
        finished = false
        failed = false
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
        if let index = episode.streams.indices.first(where: { !tried.contains($0) }) { choose(index) }
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
    @State private var volumePanel = false

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
                    SystemPlayer(player: session.player)
                }
            }
            .navigationTitle(request.subject.kind == "movie" ? request.subject.title : "\(request.subject.title) · \(session.episode.title)")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarItems(leading: Button("完成") { dismiss() }.frame(minHeight: 44).accessibilityIdentifier("close-player"), trailing: playerTools)
        }
        .navigationViewStyle(.stack).preferredColorScheme(.dark)
        .onAppear { session.start() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in session.save() }
        .onDisappear { session.stop() }
    }

    private var speaker: String {
        if session.volume == 0 { return "speaker.slash.fill" }
        return session.volume < 0.45 ? "speaker.wave.1.fill" : "speaker.wave.2.fill"
    }
    private var playerTools: some View {
        HStack(spacing: 4) {
            Button { volumePanel = true } label: { Image(systemName: speaker).frame(width: 44, height: 44) }
                .accessibilityLabel("播放音量").accessibilityIdentifier("volume-button")
                .popover(isPresented: $volumePanel) {
                    VStack(spacing: 14) {
                        HStack {
                            Text("播放音量").font(.headline)
                            Spacer()
                            Text("\(Int((session.volume * 100).rounded()))%").font(.subheadline).monospacedDigit().foregroundColor(.secondary)
                        }
                        HStack(spacing: 10) {
                            Button { session.toggleMute() } label: { Image(systemName: speaker).frame(width: 44, height: 44) }
                                .accessibilityLabel(session.volume > 0 ? "静音" : "取消静音").accessibilityIdentifier("mute")
                            Slider(value: Binding(get: { session.volume }, set: session.setVolume), in: 0...1)
                                .frame(minHeight: 44).accessibilityLabel("播放音量").accessibilityIdentifier("volume-slider")
                        }
                        Button("完成") { volumePanel = false }.frame(minHeight: 44).accessibilityIdentifier("close-volume")
                    }.padding(20).frame(idealWidth: 290, maxWidth: 330)
                }
            if request.episodes.count > 1 || session.episode.streams.count > 1 {
                Menu {
                    if let next = request.episodes.first(where: { $0.number > session.episode.number }) {
                        Button { session.changeEpisode(next) } label: { Label("下一集", systemImage: "forward.end.fill") }
                    }
                    if request.episodes.count > 1 {
                        Menu("选集") {
                            ForEach(episodeGroups, id: \.self) { group in
                                if episodeGroups.count > 1 {
                                    Menu("\(group * 20 + 1)–\(min((group + 1) * 20, request.episodes.last?.number ?? 1)) 集") { episodeChoices(group) }
                                } else { episodeChoices(group) }
                            }
                        }
                    }
                    if session.episode.streams.count > 1 {
                        Menu("播放线路") {
                            ForEach(Array(session.episode.streams.enumerated()), id: \.offset) { index, stream in
                                Button { session.choose(index) } label: {
                                    let name = sourceLabel(index, stream)
                                    if index == session.selected { Label(name, systemImage: "checkmark") } else { Text(name) }
                                }
                            }
                        }
                    }
                } label: { Image(systemName: "ellipsis.circle").frame(width: 44, height: 44) }
                .accessibilityLabel("播放选项").accessibilityIdentifier("player-options")
            }
        }
    }
    private var episodeGroups: [Int] { Array(Set(request.episodes.map { ($0.number - 1) / 20 })).sorted() }
    private func episodeChoices(_ group: Int) -> some View {
        ForEach(request.episodes.filter { ($0.number - 1) / 20 == group }) { ep in
            Button { session.changeEpisode(ep) } label: {
                if ep.number == session.episode.number { Label(ep.title, systemImage: "checkmark") } else { Text(ep.title) }
            }
        }
    }
    private func sourceLabel(_ index: Int, _ stream: Stream) -> String {
        let streams = session.episode.streams
        guard streams.filter({ $0.source == stream.source }).count > 1 else { return stream.source }
        let position = streams.prefix(index + 1).filter { $0.source == stream.source }.count
        return "\(stream.source) · 线路 \(position)"
    }
}
