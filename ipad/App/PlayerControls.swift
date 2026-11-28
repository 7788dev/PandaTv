import AVKit
import SwiftUI

struct PlayerPage: View {
    let request: PlaybackRequest
    @ObservedObject var availability: TitleAvailability
    @ObservedObject var session: PlaybackSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PlayerNavigation(session: session, subject: request.subject,
                         episodes: availability.episodes.isEmpty ? request.episodes : availability.episodes,
                         revision: availability.revision, close: { dismiss() })
            .ignoresSafeArea().preferredColorScheme(.dark)
            .onAppear { session.start() }
            .onReceive(availability.$episodes) { session.updateStreams($0) }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in session.save() }
    }
}

private struct PlayerNavigation: UIViewControllerRepresentable {
    @ObservedObject var session: PlaybackSession
    let subject: Subject
    let episodes: [PlayEpisode]
    let revision: Int
    let close: () -> Void
    func makeUIViewController(context: Context) -> UINavigationController {
        let content = PlayerController(session: session, subject: subject, close: close)
        let navigation = UINavigationController(rootViewController: content)
        navigation.overrideUserInterfaceStyle = .dark
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = .black
        navigation.navigationBar.standardAppearance = appearance
        navigation.navigationBar.scrollEdgeAppearance = appearance
        navigation.navigationBar.tintColor = .white
        return navigation
    }
    func updateUIViewController(_ navigation: UINavigationController, context: Context) {
        (navigation.viewControllers.first as? PlayerController)?.update(episodes: episodes, revision: revision)
    }
}

private final class PlayerController: UIViewController, UIPopoverPresentationControllerDelegate, AVPlayerViewControllerDelegate {
    private let session: PlaybackSession
    private let subject: Subject
    private let close: () -> Void
    private let screen = AVPlayerViewController()
    private var errorPage: UIViewController?
    private var menuRevision = -1, menuEpisode = -1
    private var selectedURL: URL?
    private var speakerName: String?
    private lazy var volume = UIBarButtonItem(image: UIImage(systemName: "speaker.wave.2.fill"), style: .plain, target: self, action: #selector(showVolume))
    private lazy var options = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), style: .plain, target: nil, action: nil)

    init(session: PlaybackSession, subject: Subject, close: @escaping () -> Void) {
        self.session = session; self.subject = subject; self.close = close
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(session:subject:close:)") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let done = UIBarButtonItem(title: "完成", style: .done, target: self, action: #selector(finish))
        done.width = 48; volume.width = 48; options.width = 48
        done.accessibilityIdentifier = "close-player"
        volume.accessibilityIdentifier = "volume-button"; volume.accessibilityLabel = "播放音量"
        options.accessibilityIdentifier = "player-options"; options.accessibilityLabel = "播放选项"
        navigationItem.leftBarButtonItem = done
        screen.player = session.player
        screen.delegate = self
        screen.videoGravity = .resizeAspect
        embed(screen)
    }
    private func embed(_ child: UIViewController) {
        addChild(child)
        view.addSubview(child.view)
        child.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            child.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), child.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            child.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), child.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        child.didMove(toParent: self)
    }
    func update(episodes: [PlayEpisode], revision: Int) {
        loadViewIfNeeded()
        let episode = session.episode
        navigationItem.title = subject.kind == "movie" ? subject.title : "\(subject.title) · \(episode.title)"
        let symbol = volumeSymbol(session.volume)
        if speakerName != symbol { speakerName = symbol; volume.image = UIImage(systemName: symbol) }
        if session.failed, errorPage == nil {
            let error = UIHostingController(rootView: NoticeView(symbol: "exclamationmark.circle", message: "这一集的线路暂时无法播放",
                retry: { [weak session] in session?.retry() }).environment(\.colorScheme, .dark).tint(.white))
            error.view.backgroundColor = .black
            embed(error); errorPage = error
        } else if !session.failed, let error = errorPage {
            error.willMove(toParent: nil); error.view.removeFromSuperview(); error.removeFromParent(); errorPage = nil
        }
        guard episode.streams.indices.contains(session.selected) else { return }
        let url = episode.streams[session.selected].url
        guard menuRevision != revision || menuEpisode != episode.number || selectedURL != url else { return }
        menuRevision = revision; menuEpisode = episode.number; selectedURL = url
        options.menu = menu(episodes)
        navigationItem.rightBarButtonItems = options.menu == nil ? [volume] : [options, volume]
    }

    private func menu(_ episodes: [PlayEpisode]) -> UIMenu? {
        var sections: [UIMenuElement] = []
        let current = session.episode
        if let playing = current.corresponding(in: episodes), let next = episodes.first(where: { $0.number > playing.number }) {
            sections.append(UIAction(title: "下一集", image: UIImage(systemName: "forward.end.fill")) { [weak session] _ in session?.changeEpisode(next) })
        }
        if episodes.count > 1 {
            let groups = Dictionary(grouping: episodes) { ($0.number - 1) / 20 }
            var choices: [UIMenuElement] = []
            for key in groups.keys.sorted() {
                guard let items = groups[key], let first = items.first, let last = items.last else { continue }
                let actions = items.map { ep in
                    UIAction(title: ep.title, state: ep.id == current.id ? .on : .off) { [weak session] _ in session?.changeEpisode(ep) }
                }
                if groups.count == 1 { choices.append(contentsOf: actions) }
                else { choices.append(UIMenu(title: "\(first.number)–\(last.number) 集", children: actions)) }
            }
            sections.append(UIMenu(title: "选集", image: UIImage(systemName: "square.grid.2x2"), children: choices))
        }
        if current.streams.count > 1 {
            let counts = Dictionary(grouping: current.streams, by: \.source)
            var seen: [String: Int] = [:]
            let routes = current.streams.map { stream -> UIAction in
                seen[stream.source, default: 0] += 1
                let name = counts[stream.source]?.count == 1 ? stream.source : "\(stream.source) · 线路 \(seen[stream.source]!)"
                return UIAction(title: name, state: stream.url == selectedURL ? .on : .off) { [weak session] _ in session?.switchLine(stream.url) }
            }
            sections.append(UIMenu(title: "播放线路", image: UIImage(systemName: "list.bullet"), children: routes))
        }
        return sections.isEmpty ? nil : UIMenu(children: sections)
    }

    @objc private func finish() { close() }
    @objc private func showVolume() {
        guard presentedViewController == nil else { return }
        let panel = UIHostingController(rootView: VolumePanel(session: session) { [weak self] in self?.dismiss(animated: true) })
        panel.overrideUserInterfaceStyle = .dark
        panel.view.backgroundColor = .secondarySystemBackground
        let large = traitCollection.preferredContentSizeCategory.isAccessibilityCategory
        panel.preferredContentSize = CGSize(width: min(view.bounds.width - 24, large ? 344 : 294), height: large ? 164 : 116)
        panel.modalPresentationStyle = .popover
        panel.popoverPresentationController?.barButtonItem = volume
        panel.popoverPresentationController?.delegate = self
        present(panel, animated: true)
    }
    func adaptivePresentationStyle(for controller: UIPresentationController, traitCollection: UITraitCollection) -> UIModalPresentationStyle { .none }

    func playerViewController(_ playerViewController: AVPlayerViewController, willBeginFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator) {
        preservePlayback(during: coordinator)
    }
    func playerViewController(_ playerViewController: AVPlayerViewController, willEndFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator) {
        preservePlayback(during: coordinator)
    }
    private func preservePlayback(during coordinator: UIViewControllerTransitionCoordinator) {
        let player = session.player
        guard let item = player.currentItem, player.timeControlStatus != .paused else { return }
        let rate = player.rate
        coordinator.animate(alongsideTransition: nil) { transition in
            guard !transition.isCancelled, player.currentItem === item, player.timeControlStatus == .paused else { return }
            let end = item.duration.seconds
            if !end.isFinite || player.currentTime().seconds < end - 0.5 {
                if rate > 0 { player.rate = rate } else { player.play() }
            }
        }
    }
}

private func volumeSymbol(_ value: Double) -> String {
    if value == 0 { return "speaker.slash.fill" }
    return value < 0.45 ? "speaker.wave.1.fill" : "speaker.wave.2.fill"
}

private struct VolumePanel: View {
    @ObservedObject var session: PlaybackSession
    let close: () -> Void
    var body: some View {
        VStack(spacing: 2) {
            HStack {
                Text("播放音量").font(.headline)
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.hierarchical)
                        .foregroundColor(.secondary).frame(width: 44, height: 44)
                }.accessibilityLabel("完成").accessibilityIdentifier("close-volume")
            }
            HStack(spacing: 9) {
                Button { session.toggleMute() } label: {
                    Image(systemName: volumeSymbol(session.volume)).frame(width: 44, height: 44)
                }.accessibilityLabel(session.volume > 0 ? "静音" : "取消静音").accessibilityIdentifier("mute")
                Slider(value: Binding(get: { session.volume }, set: session.setVolume), in: 0...1)
                    .frame(minHeight: 44).accessibilityLabel("播放音量")
                    .accessibilityValue("\(Int((session.volume * 100).rounded()))%").accessibilityIdentifier("volume-slider")
                Text("\(Int((session.volume * 100).rounded()))%").font(.caption).monospacedDigit()
                    .foregroundColor(.secondary).accessibilityHidden(true)
            }
        }.padding(.horizontal, 16).padding(.vertical, 8)
        .foregroundColor(.white).tint(.white).environment(\.colorScheme, .dark)
    }
}
