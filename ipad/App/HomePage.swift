import SwiftUI

struct HomePage: View {
    let select, resume: (Subject) -> Void
    let browse: (Destination) -> Void
    @EnvironmentObject private var library: Library
    @Environment(\.sizeCategory) private var textSize
    @State private var shelves: [String: [Subject]] = [:]
    @State private var loading = true
    @State private var attempt = 0
    @State private var featuredID: String?
    private let collections = ["tv_hot", "movie_latest", "tv_animation"]
    private var features: [Subject] {
        if shelves["tv_hot"] == nil && loading { return [] }
        let tv = shelves["tv_hot"] ?? [], films = shelves["movie_latest"] ?? []
        let pictures = Catalog.unique(Array(tv.prefix(3)) + Array(films.prefix(2))).filter { $0.backdrop != nil }
        return Array((pictures.isEmpty ? tv + films : pictures).prefix(4))
    }
    private var featuredSelection: Binding<String> {
        Binding(get: {
            if let id = featuredID, features.contains(where: { $0.id == id }) { return id }
            return features.first?.id ?? ""
        }, set: { featuredID = $0 })
    }

    var body: some View {
        GeometryReader { box in
            let margin: CGFloat = box.size.width < 500 ? 16 : 28
            let width = max(1, box.size.width - 2 * margin)
            let height = min(textSize.isAccessibilityCategory ? 480 : 348, max(textSize.isAccessibilityCategory ? 365 : 232, width * 0.46))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 25) {
                    if !features.isEmpty {
                        TabView(selection: featuredSelection) {
                            ForEach(Array(features.enumerated()), id: \.element.id) { index, subject in
                                FeatureCard(subject: subject, index: index, multiple: features.count > 1, select: select, play: resume)
                                    .tag(subject.id)
                            }
                        }
                        .environment(\.colorScheme, .dark)
                        .tabViewStyle(.page(indexDisplayMode: features.count > 1 ? .always : .never))
                        .frame(height: height)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .padding(.horizontal, margin)
                    } else if loading {
                        RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color(UIColor.secondarySystemBackground))
                            .frame(height: height).overlay(ProgressView().accessibilityLabel("正在载入推荐").accessibilityIdentifier("home-loading"))
                            .padding(.horizontal, margin)
                    } else {
                        NoticeView(symbol: "wifi.exclamationmark", message: "暂时无法载入推荐") { attempt += 1 }
                    }
                    let history = Array(library.history.filter(\.canContinue).prefix(8))
                    if !history.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            MediaHeading(title: "继续观看") { browse(.history) }.padding(.horizontal, margin)
                            if history.count == 1, let entry = history.first {
                                ContinueCard(entry: entry) { resume(entry.subject) }
                                    .padding(.horizontal, margin)
                            } else {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    LazyHStack(spacing: 12) {
                                        ForEach(history) { entry in
                                            ContinueCard(entry: entry) { resume(entry.subject) }.frame(width: min(width - 8, 390))
                                        }
                                    }.padding(.horizontal, margin)
                                }
                            }
                        }
                    }
                    shelf("热播剧集", "tv_hot", .tv, width, margin)
                    shelf("近期电影", "movie_latest", .movie, width, margin)
                    shelf("热门动漫", "tv_animation", .anime, width, margin)
                }.padding(.top, 6).padding(.bottom, 28)
            }
        }
        .task(id: attempt) {
            loading = true
            await withTaskGroup(of: (String, [Subject]).self) { group in
                for name in collections { group.addTask { (name, (try? await Catalog.collection(name)) ?? []) } }
                for await (name, titles) in group where !Task.isCancelled {
                    shelves[name] = titles
                }
            }
            if !Task.isCancelled { loading = false }
        }
    }

    @ViewBuilder private func shelf(_ title: String, _ key: String, _ channel: Channel, _ width: CGFloat, _ margin: CGFloat) -> some View {
        if let items = shelves[key], !items.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                MediaHeading(title: title) { browse(.channel(channel)) }.padding(.horizontal, margin)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 14) {
                        ForEach(items) { item in
                            Poster(subject: item, select: select).frame(width: min(150, max(116, (width - 55) / 5.3)))
                        }
                    }.padding(.horizontal, margin).padding(.bottom, 2)
                }
            }
        }
    }
}

private struct FeatureCard: View {
    let subject: Subject
    let index: Int
    let multiple: Bool
    let select, play: (Subject) -> Void
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 36
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Button { select(subject) } label: {
                CinematicArt(still: subject.backdrop, poster: subject.poster).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("查看\(subject.title)详情").accessibilityValue(subject.subtitle)
                .accessibilityIdentifier(index == 0 ? "featured" : "featured-\(index)")
            HStack(alignment: .bottom, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(subject.channel.rawValue).font(.subheadline.weight(.semibold)).foregroundColor(.white.opacity(0.87))
                    Text(subject.title).font(.system(size: titleSize, weight: .bold)).foregroundColor(.white)
                        .lineLimit(2).minimumScaleFactor(0.8)
                    if !subject.subtitle.isEmpty {
                        Text(subject.subtitle).font(.subheadline).foregroundColor(.white.opacity(0.92)).lineLimit(2)
                    }
                }.allowsHitTesting(false).accessibilityHidden(true)
                Spacer(minLength: 0)
                Button { play(subject) } label: {
                    Image(systemName: "play.fill").font(.headline.weight(.bold)).padding(.leading, 2)
                        .frame(width: 48, height: 48).foregroundColor(.black).background(.white, in: Circle())
                }.buttonStyle(MediaPress()).accessibilityLabel("播放\(subject.title)").accessibilityIdentifier("featured-play-\(index)")
            }
            .padding(.horizontal, 22).padding(.bottom, multiple ? 36 : 22)
        }
    }
}
