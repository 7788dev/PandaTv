import SwiftUI

struct PlaybackRequest: Identifiable {
    let id = UUID()
    let subject: Subject
    let episode: PlayEpisode
    let episodes: [PlayEpisode]
    let resume: Double
}

private struct DetailHeaderGone: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}

struct SubjectPage: View {
    let initial: Subject
    let autoplay: Bool
    let navigationTitleVisible: (Bool) -> Void
    @EnvironmentObject private var library: Library
    @Environment(\.sizeCategory) private var textSize
    @State private var fetched: Subject?
    @State private var still: URL?
    @State private var credits: [Catalog.Credit] = []
    @State private var episodes: [PlayEpisode] = []
    @State private var reading = true
    @State private var complete = false
    @State private var autoOpened = false
    @State private var retry = 0
    @State private var expanded = false
    @State private var group = 0
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
    private var resuming: Bool { last?.finished == false && last?.episode == next?.number }
    private var groups: [Int] { Array(Set(episodes.map { ($0.number - 1) / 20 })).sorted() }
    private var selectedGroup: Int { groups.contains(group) ? group : groups.first ?? 0 }
    private var artwork: URL? { initial.backdrop ?? still ?? subject.backdrop }

    var body: some View {
        GeometryReader { bounds in
            let margin: CGFloat = bounds.size.width < 500 ? 16 : 28
            let stacked = bounds.size.width < 470 || textSize.isAccessibilityCategory
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 16) {
                        ZStack(alignment: .bottomLeading) {
                            CinematicArt(still: artwork, poster: subject.poster ?? initial.poster)
                            if !stacked {
                                VStack(alignment: .leading, spacing: 15) {
                                    information
                                    actions(onArt: true)
                                }.foregroundColor(.white).padding(24)
                            }
                        }.frame(height: stacked ? 186 : min(340, max(265, (bounds.size.width - margin * 2) * 0.43)))
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        if stacked { information; actions(onArt: false) }
                    }.background(GeometryReader { geo in
                        Color.clear.preference(key: DetailHeaderGone.self, value: geo.frame(in: .named("subject")).maxY < 34)
                    })
                    if episodes.count > 1 { episodePicker }
                    if !reading && episodes.isEmpty {
                        NoticeView(symbol: "video.slash", message: "暂时没有可播放的线路") { complete = false; retry += 1 }
                    }
                    if !subject.synopsis.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            MediaHeading(title: "简介")
                            Text(subject.synopsis).font(.body).lineSpacing(4).lineLimit(expanded ? nil : 3).textSelection(.enabled)
                            if subject.synopsis.count > 76 {
                                Button(expanded ? "收起简介" : "展开简介") { expanded.toggle() }
                                    .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                            }
                        }
                    }
                    if !credits.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            MediaHeading(title: "演职人员")
                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(alignment: .top, spacing: 16) {
                                    ForEach(credits) { credit in
                                        VStack(spacing: 5) {
                                            PhotoFill(url: credit.photo, pixels: 180, symbol: "person.fill")
                                                .frame(width: 62, height: 62).clipShape(Circle()).padding(.bottom, 3)
                                            Text(credit.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                                            if !credit.role.isEmpty { Text(credit.role).font(.caption).foregroundColor(.secondary).lineLimit(2) }
                                        }.frame(width: 82).accessibilityElement(children: .combine)
                                    }
                                }
                            }
                        }
                    } else if !subject.creators.isEmpty || !subject.cast.isEmpty {
                        VStack(alignment: .leading, spacing: 9) {
                            MediaHeading(title: "演职人员")
                            if !subject.creators.isEmpty { Text("导演　" + subject.creators.joined(separator: "、")) }
                            if !subject.cast.isEmpty { Text("主演　" + subject.cast.prefix(9).joined(separator: "、")) }
                        }.font(.subheadline)
                    }
                }.padding(.horizontal, margin).padding(.top, 4).padding(.bottom, 32)
                 .frame(maxWidth: 1050, alignment: .leading).frame(maxWidth: .infinity)
            }.coordinateSpace(name: "subject")
        }
        .onPreferenceChange(DetailHeaderGone.self, perform: navigationTitleVisible)
        .task(id: retry) { if !complete { await load() } }
        .task { if initial.backdrop == nil { still = try? await Catalog.still(initial) } }
        .task { if credits.isEmpty { credits = (try? await Catalog.credits(initial)) ?? [] } }
        .fullScreenCover(item: $active) { request in PlayerPage(request: request, library: library) }
    }

    private var information: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(subject.title).font(.largeTitle.bold()).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            let score = subject.rating.map { String(format: "豆瓣 %.1f", $0) }
            Text(([subject.subtitle, score].compactMap { $0 }.filter { !$0.isEmpty }).joined(separator: "  ·  "))
                .font(.subheadline.weight(.medium)).opacity(0.89)
        }
    }

    private func actions(onArt: Bool) -> some View {
        HStack(spacing: 10) {
            if let episode = next {
                Button { play(episode) } label: {
                    Label(resuming ? "继续播放" : "播放", systemImage: "play.fill").font(.headline)
                        .padding(.horizontal, 6).frame(minHeight: 31)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                .tint(onArt ? .white : .accentColor).foregroundColor(onArt ? .black : .white)
                .accessibilityValue(resuming ? last?.detail ?? "" : episode.title).accessibilityIdentifier("play")
            } else if reading {
                HStack(spacing: 8) {
                    ProgressView().tint(onArt ? .white : .accentColor)
                    Text("正在查找片源").font(.subheadline.weight(.semibold))
                }.padding(.horizontal, 13).frame(minHeight: 44)
            }
            Button { library.toggle(savedSubject) } label: {
                Image(systemName: library.isFavorite(subject) ? "bookmark.fill" : "bookmark")
                    .font(.headline).frame(width: 44, height: 44)
                    .foregroundColor(onArt ? .white : .primary)
                    .background(onArt ? Color.white.opacity(0.22) : Color(UIColor.secondarySystemFill), in: Circle())
            }.buttonStyle(MediaPress()).accessibilityLabel(library.isFavorite(subject) ? "已收藏" : "收藏").accessibilityIdentifier("favorite")
        }
    }

    private func rangeTitle(_ index: Int) -> String {
        let rows = episodes.filter { ($0.number - 1) / 20 == index }
        return "\(rows.first?.number ?? 1)–\(rows.last?.number ?? 1) 集"
    }

    private var episodePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                MediaHeading(title: "选集")
                Spacer()
                if groups.count > 1 {
                    Menu {
                        Picker("集数范围", selection: $group) { ForEach(groups, id: \.self) { Text(rangeTitle($0)).tag($0) } }
                    } label: { Label(rangeTitle(selectedGroup), systemImage: "list.bullet").frame(minHeight: 44) }
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 94), spacing: 9)], spacing: 9) {
                ForEach(episodes.filter { ($0.number - 1) / 20 == selectedGroup }) { ep in
                    let watched = ep.number == last?.episode
                    Button { play(ep) } label: {
                        HStack(spacing: 5) {
                            if watched { Image(systemName: last?.finished == true ? "checkmark" : "play.fill").font(.caption2) }
                            Text(ep.title).font(.subheadline.weight(watched ? .semibold : .medium)).monospacedDigit().lineLimit(2)
                        }.padding(.horizontal, 5).frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundColor(watched ? .accentColor : .primary)
                        .background(watched ? Color.accentColor.opacity(0.12) : Color(UIColor.secondarySystemBackground),
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }.buttonStyle(MediaPress()).accessibilityIdentifier("episode-\(ep.number)")
                }
            }
        }
    }

    private var savedSubject: Subject {
        var value = subject
        value.backdrop = artwork
        return value
    }
    private func play(_ episode: PlayEpisode) {
        autoOpened = true
        let resume = last.flatMap { !$0.finished && $0.episode == episode.number ? $0.seconds : nil } ?? 0
        active = PlaybackRequest(subject: savedSubject, episode: episode, episodes: episodes, resume: resume)
    }

    @MainActor private func load() async {
        reading = true
        let work = (try? await Catalog.detail(id: initial.id, kind: initial.kind)) ?? initial
        guard !Task.isCancelled else { return }
        fetched = work
        if let entry = last { group = max(0, (entry.episode - 1) / 20) }
        var lines: [Sources.Line] = []
        await withTaskGroup(of: [Sources.Line].self) { tasks in
            for source in (try? Sources.configured()) ?? [] {
                tasks.addTask { (try? await Sources.find(work, source: source)) ?? [] }
            }
            for await result in tasks {
                guard !Task.isCancelled else { tasks.cancelAll(); return }
                if !result.isEmpty {
                    lines += result
                    episodes = Sources.episodes(lines)
                }
                if autoplay && !autoOpened, let ep = next, last == nil || (last?.finished == false && last?.episode == ep.number) { play(ep) }
            }
        }
        guard !Task.isCancelled else { return }
        reading = false; complete = true
        if autoplay && !autoOpened, last?.finished == true, let ep = next { play(ep) }
    }
}
