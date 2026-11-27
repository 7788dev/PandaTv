import SwiftUI
import ImageIO

private actor Thumbnails {
    static let shared = Thumbnails()
    private let cache = NSCache<NSString, UIImage>()
    init() { cache.totalCostLimit = 36 * 1024 * 1024 }

    func image(_ url: URL, maxPixels: Int) async throws -> UIImage? {
        let key = "\(maxPixels):\(url.absoluteString)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let data = try await Network.read(url, referer: "https://movie.douban.com/")
        try Task.checkCancellation()
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: true]
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let result = UIImage(cgImage: thumbnail)
        cache.setObject(result, forKey: key, cost: thumbnail.bytesPerRow * thumbnail.height)
        return result
    }
}

struct Artwork: View {
    let url: URL?
    var wide = false
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color(UIColor.secondarySystemFill)
            if let image = image {
                GeometryReader { box in
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: box.size.width, height: box.size.height).clipped()
                }
            } else {
                Image(systemName: "film").font(.title2).foregroundColor(Color(UIColor.tertiaryLabel))
            }
        }
        .aspectRatio(wide ? 1.95 : 2.0 / 3.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: wide ? 14 : 8, style: .continuous))
        .accessibilityHidden(true)
        .task(id: url) {
            image = nil
            if let url = url, let result = try? await Thumbnails.shared.image(url, maxPixels: wide ? 1200 : 440), !Task.isCancelled {
                image = result
            }
        }
    }
}

private struct Poster: View {
    let subject: Subject
    let select: (Subject) -> Void
    var body: some View {
        Button { select(subject) } label: {
            VStack(alignment: .leading, spacing: 6) {
                Artwork(url: subject.poster)
                Text(subject.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                if !subject.year.isEmpty { Text(subject.year).font(.caption).foregroundColor(.secondary) }
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("title-\(subject.id)")
    }
}

struct PosterGrid: View {
    let items: [Subject]
    let select: (Subject) -> Void
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 118, maximum: 200), spacing: 16, alignment: .top)], alignment: .leading, spacing: 20) {
            ForEach(items) { Poster(subject: $0, select: select) }
        }
    }
}

struct NoticeView: View {
    let symbol, message: String
    var retry: (() -> Void)?
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.largeTitle).foregroundColor(.secondary).accessibilityHidden(true)
            Text(message).font(.body).foregroundColor(.secondary).multilineTextAlignment(.center)
            if let retry = retry { Button("重试", action: retry).buttonStyle(.bordered) }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 32)
    }
}

struct HomePage: View {
    let select: (Subject) -> Void
    @EnvironmentObject private var library: Library

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                if let entry = library.history.first(where: { !$0.finished }) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("继续观看").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                        Button { select(entry.subject) } label: {
                            Label("\(entry.subject.title) · \(entry.detail)", systemImage: "play.circle.fill")
                                .font(.headline).frame(minHeight: 44, alignment: .leading)
                        }
                    }
                }
                HomeShelf(name: "热播剧集", collection: "tv_hot", featured: true, select: select)
                HomeShelf(name: "近期电影", collection: "movie_latest", select: select)
            }.padding([.horizontal, .bottom], 20)
        }
    }
}

private struct HomeShelf: View {
    let name, collection: String
    var featured = false
    let select: (Subject) -> Void
    @State private var items: [Subject] = []
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if featured, let first = items.first {
                Button { select(first) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Artwork(url: first.backdrop ?? first.poster, wide: true)
                        Text(first.title).font(.title.bold()).fixedSize(horizontal: false, vertical: true)
                        if !first.subtitle.isEmpty { Text(first.subtitle).font(.subheadline).foregroundColor(.secondary) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).accessibilityIdentifier("featured")
                Divider().padding(.vertical, 4)
            }
            Text(name).font(.title2.bold()).accessibilityAddTraits(.isHeader)
            if failed {
                NoticeView(symbol: "wifi.exclamationmark", message: "暂时无法载入\(name)") { attempt += 1 }
            } else if items.isEmpty {
                ProgressView().frame(maxWidth: .infinity).padding().accessibilityLabel("正在载入\(name)")
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 14) {
                        ForEach(featured && items.count > 1 ? Array(items.dropFirst()) : items) { subject in
                            Poster(subject: subject, select: select).frame(width: 126)
                        }
                    }.padding(.bottom, 2)
                }
            }
        }.task(id: attempt) {
            failed = false
            do {
                let result = try await Catalog.collection(collection)
                try Task.checkCancellation()
                items = result
                failed = result.isEmpty
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
}

private struct Filters: Hashable {
    var sort = "热度", genre = "全部类型", region = "全部地区", year = "全部年份"
    var tags: [String] {
        [genre, region, year].filter { !["全部类型", "全部地区", "全部年份"].contains($0) }
    }
}

private struct FilterMenu: View {
    let name: String
    let options: [String]
    @Binding var selection: String
    var body: some View {
        Menu {
            Picker(name, selection: $selection) { ForEach(options, id: \.self) { Text($0).tag($0) } }
        } label: {
            HStack(spacing: 4) { Text(selection); Image(systemName: "chevron.down").font(.caption2) }
                .frame(minHeight: 44)
        }.accessibilityLabel("\(name)，\(selection)")
    }
}

struct ChannelPage: View {
    let channel: Channel
    let select: (Subject) -> Void
    @State private var filters = Filters()
    @State private var items: [Subject] = []
    @State private var offsets: [String: Int] = [:]
    @State private var more = 0
    @State private var busy = true
    @State private var failed = false
    private struct Request: Hashable { let filters: Filters; let page: Int }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 20) {
                        FilterMenu(name: "排序", options: ["热度","最新","评分"], selection: $filters.sort)
                        FilterMenu(name: "类型", options: ["全部类型","剧情","喜剧","悬疑","爱情","动作","科幻","历史","冒险"], selection: $filters.genre)
                        FilterMenu(name: "地区", options: ["全部地区","中国大陆","中国香港","中国台湾","美国","日本","韩国","英国","法国"], selection: $filters.region)
                        FilterMenu(name: "年份", options: ["全部年份"] + (2010...max(2010, Calendar.current.component(.year, from: Date()))).reversed().map { String($0) }, selection: $filters.year)
                    }
                }
                PosterGrid(items: items, select: select)
                if busy { ProgressView().frame(maxWidth: .infinity).padding() }
                else if failed {
                    NoticeView(symbol: "wifi.exclamationmark", message: "暂时无法载入片单") { more += 1 }
                } else if !offsets.isEmpty {
                    Button("载入更多") { more += 1 }.buttonStyle(.bordered).frame(maxWidth: .infinity)
                } else if items.isEmpty {
                    NoticeView(symbol: "film", message: "这个筛选条件下没有作品")
                }
            }.padding([.horizontal, .bottom], 20)
        }
        .onChange(of: filters) { _ in more = 0; offsets = [:]; items = [] }
        .task(id: Request(filters: filters, page: more)) {
            let current = filters
            let starts = offsets.isEmpty ? Dictionary(uniqueKeysWithValues: channel.kinds.map { ($0, 0) }) : offsets
            busy = true; failed = false
            // Commit each combined page together so retrying cannot skip a failed lane.
            do {
                var next: [String: Int] = [:], batch: [Subject] = []
                for kind in channel.kinds {
                    guard let start = starts[kind] else { continue }
                    let page = try await Catalog.channel(channel, kind: kind, tags: current.tags,
                        sort: ["最新":"R","评分":"S"][current.sort] ?? "U", start: start)
                    next[kind] = page.next
                    batch += page.items
                }
                try Task.checkCancellation()
                guard filters == current else { return }
                items = Catalog.unique(items + batch)
                offsets = next
            } catch { if !Task.isCancelled { failed = true } }
            if !Task.isCancelled { busy = false }
        }
    }
}

struct SearchPage: View {
    @ObservedObject var input: SearchInput
    let select: (Subject) -> Void
    @State private var results: [Subject] = []
    @State private var hints: [String] = []
    @State private var busy = false
    @State private var failed = false
    @State private var retry = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !hints.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(hints, id: \.self) { hint in
                                Button(hint) { input.choose(hint) }.buttonStyle(.bordered).frame(minHeight: 44)
                            }
                        }
                    }
                }
                if busy { ProgressView().frame(maxWidth: .infinity).padding() }
                else if failed { NoticeView(symbol: "wifi.exclamationmark", message: "搜索暂时不可用") { retry += 1 } }
                else if !results.isEmpty { PosterGrid(items: results, select: select) }
                else {
                    NoticeView(symbol: "magnifyingglass", message: input.text.isEmpty ? "输入片名或拼音首字母" : "没有找到相关作品")
                }
            }.padding([.horizontal, .bottom], 20)
        }
        .task(id: "\(retry):\(input.text)") {
            let query = String(input.text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
            results = []; hints = []; failed = false; busy = !query.isEmpty
            guard !query.isEmpty else { return }
            do {
                try await Task.sleep(nanoseconds: 320_000_000)
                let terms = await TitleIndex.shared.hints(query)
                try Task.checkCancellation()
                hints = terms
                let titles = try await Catalog.search(query)
                try Task.checkCancellation()
                results = titles
            } catch { if !Task.isCancelled { failed = true } }
            if !Task.isCancelled { busy = false }
        }
    }
}

struct LibraryPage: View {
    let history: Bool
    let select: (Subject) -> Void
    @EnvironmentObject private var library: Library
    var body: some View {
        if history && !library.history.isEmpty {
            List {
                ForEach(library.history) { entry in
                    Button { select(entry.subject) } label: {
                        HStack(spacing: 12) {
                            Artwork(url: entry.subject.poster).frame(width: 44)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(entry.subject.title).font(.headline)
                                Text(entry.detail).font(.subheadline).foregroundColor(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundColor(Color(UIColor.tertiaryLabel))
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).swipeActions {
                        Button("删除", role: .destructive) { library.removeHistory(entry.id) }
                    }
                }
            }.listStyle(.insetGrouped)
        } else if !history && !library.favorites.isEmpty {
            ScrollView { PosterGrid(items: library.favorites, select: select).padding(.horizontal, 20) }
        } else {
            NoticeView(symbol: history ? "clock" : "bookmark", message: history ? "还没有观看记录" : "收藏的作品会出现在这里")
        }
    }
}
