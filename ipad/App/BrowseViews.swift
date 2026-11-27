import SwiftUI

private struct Filters: Hashable {
    var sort = "热度", genre = "全部类型", region = "全部地区", year = "全部年份"
    var tags: [String] {
        [genre, region, year].filter { !["全部类型", "全部地区", "全部年份"].contains($0) }
    }
}

private struct FilterSheet: View {
    let channel: Channel
    @State var draft: Filters
    let apply: (Filters) -> Void
    @Environment(\.dismiss) private var dismiss

    private var genres: [String] {
        switch channel {
        case .tv, .movie: return ["剧情","喜剧","悬疑","爱情","动作","科幻","历史","冒险","家庭"]
        case .anime: return ["冒险","奇幻","科幻","战斗","校园","运动","治愈"]
        case .variety: return ["真人秀","脱口秀","音乐","喜剧","旅行","竞技","文化","美食"]
        case .doc: return ["自然","人文","历史","科学","美食","艺术","社会","传记"]
        }
    }
    var body: some View {
        NavigationView {
            Form {
                Section {
                    picker("类型", ["全部类型"] + genres, $draft.genre)
                    picker("地区", ["全部地区","中国大陆","中国香港","中国台湾","美国","日本","韩国","英国","法国"], $draft.region)
                    picker("年份", ["全部年份"] + (2010...max(2010, Calendar.current.component(.year, from: Date()))).reversed().map(String.init), $draft.year)
                }
                if !draft.tags.isEmpty {
                    Button("重置筛选") { draft = Filters(sort: draft.sort) }
                }
            }
            .navigationTitle("筛选\(channel.rawValue)").navigationBarTitleDisplayMode(.inline)
            .navigationBarItems(leading: Button("取消") { dismiss() }, trailing: Button("完成") { apply(draft); dismiss() }.font(.headline))
        }.navigationViewStyle(.stack)
    }
    private func picker(_ title: String, _ options: [String], _ value: Binding<String>) -> some View {
        Picker(title, selection: value) { ForEach(options, id: \.self) { Text($0).tag($0) } }
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
    @State private var sheet = false
    private struct Request: Hashable { let filters: Filters; let page: Int }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Picker("排序", selection: $filters.sort) {
                        ForEach(["热度", "最新", "评分"], id: \.self) { Text($0).tag($0) }
                    }.pickerStyle(.segmented).frame(maxWidth: 308)
                    Spacer(minLength: 0)
                    Button { sheet = true } label: {
                        Label(filters.tags.isEmpty ? "筛选" : "筛选 · \(filters.tags.count)", systemImage: "line.3.horizontal.decrease.circle")
                            .frame(minHeight: 44)
                    }.accessibilityIdentifier("channel-filters")
                }
                if !filters.tags.isEmpty { Text(filters.tags.joined(separator: " · ")).font(.subheadline).foregroundColor(.secondary) }
                PosterGrid(items: items, select: select)
                if busy { ProgressView().frame(maxWidth: .infinity).padding() }
                else if failed {
                    NoticeView(symbol: "wifi.exclamationmark", message: "暂时无法载入片单") { more += 1 }
                } else if !offsets.isEmpty {
                    Button("载入更多") { more += 1 }.buttonStyle(.bordered).frame(maxWidth: .infinity)
                } else if items.isEmpty {
                    NoticeView(symbol: "film", message: "这个筛选条件下没有作品")
                }
            }.padding(.horizontal).padding(.horizontal, 6).padding(.bottom, 24)
        }
        .sheet(isPresented: $sheet) { FilterSheet(channel: channel, draft: filters) { filters = $0 } }
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
    @State private var popular: [Subject] = []
    @EnvironmentObject private var library: Library

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
                if input.text.isEmpty {
                    if !library.queries.isEmpty {
                        HStack {
                            MediaHeading(title: "最近搜索")
                            Spacer()
                            Button("清除") { library.clearQueries() }.font(.subheadline).frame(minHeight: 44)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) { ForEach(library.queries, id: \.self) { query in
                                Button { input.choose(query) } label: { Label(query, systemImage: "clock.arrow.circlepath") }
                                    .buttonStyle(.bordered).buttonBorderShape(.capsule).frame(minHeight: 44)
                            } }
                        }
                    }
                    if !popular.isEmpty {
                        MediaHeading(title: "热门作品").padding(.top, 6)
                        PosterGrid(items: popular, select: select)
                    } else { NoticeView(symbol: "magnifyingglass", message: "搜索片名或拼音首字母") }
                } else if busy { ProgressView().frame(maxWidth: .infinity).padding() }
                else if failed { NoticeView(symbol: "wifi.exclamationmark", message: "搜索暂时不可用") { retry += 1 } }
                else if !results.isEmpty {
                    MediaHeading(title: "搜索结果")
                    PosterGrid(items: results) { subject in library.rememberQuery(input.text); select(subject) }
                }
                else {
                    NoticeView(symbol: "magnifyingglass", message: "没有找到相关作品")
                }
            }.padding([.horizontal, .bottom], 22)
        }
        .task { if popular.isEmpty { popular = (try? await Catalog.collection("movie_real_time_hotest")) ?? [] } }
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
    let browse: (Destination) -> Void
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
                                if entry.fraction > 0 && !entry.finished { ProgressView(value: entry.fraction).frame(maxWidth: 150) }
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
            VStack(spacing: 16) {
                Image(systemName: history ? "clock" : "bookmark").font(.system(size: 32, weight: .medium))
                    .foregroundColor(.secondary).frame(width: 76, height: 76).background(Color(UIColor.secondarySystemBackground), in: Circle())
                Text(history ? "还没有观看记录" : "还没有收藏的作品").font(.title3.bold())
                Button("浏览片库") { browse(.home) }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.large)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
