import SwiftUI

struct PlaybackRequest: Identifiable {
    let id = UUID()
    let subject: Subject
    let episode: PlayEpisode
    let resume: Double
}

struct SubjectPage: View {
    let initial: Subject
    @EnvironmentObject private var library: Library
    @Environment(\.sizeCategory) private var textSize
    @State private var fetched: Subject?
    @State private var episodes: [PlayEpisode] = []
    @State private var reading = true
    @State private var complete = false
    @State private var retry = 0
    @State private var active: PlaybackRequest?
    private var subject: Subject { fetched ?? initial }
    private var last: WatchEntry? { library.history.first { $0.id == initial.id } }
    private var next: PlayEpisode? {
        if let last = last, let previous = episodes.first(where: { $0.number == last.episode }) {
            if last.finished { return episodes.first { $0.number > previous.number } ?? previous }
            return previous
        }
        return episodes.first
    }
    private var isResuming: Bool { last?.finished == false && last?.episode == next?.number }

    var body: some View {
        GeometryReader { bounds in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if bounds.size.width > 450 && !textSize.isAccessibilityCategory {
                        HStack(alignment: .top, spacing: 20) {
                            Artwork(url: subject.poster).frame(width: min(180, bounds.size.width * 0.25))
                            information
                        }
                    } else { information }
                    if !subject.synopsis.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            heading("简介")
                            Text(subject.synopsis).font(.body).textSelection(.enabled)
                        }
                    }
                    if episodes.count > 1 {
                        VStack(alignment: .leading, spacing: 10) {
                            heading("选集")
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 10)], spacing: 10) {
                                ForEach(episodes) { episode in
                                    Button { play(episode) } label: {
                                        Text(episode.title).lineLimit(2).frame(maxWidth: .infinity, minHeight: 34)
                                    }.buttonStyle(.bordered).accessibilityIdentifier("episode-\(episode.number)")
                                }
                            }
                        }
                    }
                    if !reading && episodes.isEmpty {
                        NoticeView(symbol: "play.slash", message: "暂时没有可播放的线路") { complete = false; retry += 1 }
                    }
                    if !subject.creators.isEmpty || !subject.cast.isEmpty {
                        Divider()
                        VStack(alignment: .leading, spacing: 10) {
                            heading("演职人员")
                            if !subject.creators.isEmpty { Text("导演　" + subject.creators.joined(separator: "、")) }
                            if !subject.cast.isEmpty { Text("主演　" + subject.cast.prefix(8).joined(separator: "、")) }
                        }.font(.subheadline)
                    }
                }.frame(maxWidth: 820, alignment: .leading).padding(20).frame(maxWidth: .infinity)
            }
        }
        .task(id: retry) { if !complete { await load() } }
        .fullScreenCover(item: $active) { request in
            PlayerPage(request: request, library: library)
        }
    }

    private func heading(_ label: String) -> some View {
        Text(label).font(.title2.bold()).accessibilityAddTraits(.isHeader)
    }

    private var information: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(subject.title).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
            if !subject.subtitle.isEmpty { Text(subject.subtitle).foregroundColor(.secondary) }
            if let rating = subject.rating {
                Label(String(format: "%.1f · 豆瓣", rating), systemImage: "star.fill").font(.subheadline)
            }
            if let episode = next {
                Button { play(episode) } label: {
                    Label(isResuming ? "继续播放" : "播放", systemImage: "play.fill")
                }.buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("play")
            } else if reading {
                ProgressView("正在查找片源").font(.subheadline)
            }
            Button { library.toggle(subject) } label: {
                Label(library.isFavorite(subject) ? "已收藏" : "收藏", systemImage: library.isFavorite(subject) ? "bookmark.fill" : "bookmark")
            }.buttonStyle(.bordered).controlSize(.large).accessibilityIdentifier("favorite")
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func play(_ episode: PlayEpisode) {
        let resume = last.flatMap { !$0.finished && $0.episode == episode.number ? $0.seconds : nil } ?? 0
        active = PlaybackRequest(subject: subject, episode: episode, resume: resume)
    }

    @MainActor private func load() async {
        reading = true
        let work = (try? await Catalog.detail(id: initial.id, kind: initial.kind)) ?? initial
        guard !Task.isCancelled else { return }
        fetched = work
        var lines: [Sources.Line] = []
        await withTaskGroup(of: [Sources.Line].self) { group in
            for source in (try? Sources.configured()) ?? [] {
                group.addTask { (try? await Sources.find(work, source: source)) ?? [] }
            }
            for await result in group {
                guard !Task.isCancelled else { group.cancelAll(); return }
                if !result.isEmpty {
                    lines += result
                    episodes = Sources.episodes(lines)
                }
            }
        }
        if !Task.isCancelled { reading = false; complete = true }
    }
}
