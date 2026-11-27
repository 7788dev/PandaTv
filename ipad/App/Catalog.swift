import Foundation

typealias JSONRow = [String: Any]

enum CatalogError: LocalizedError {
    case response, unavailable
    var errorDescription: String? {
        switch self {
        case .response: return "片库暂时无法读取，请稍后重试。"
        case .unavailable: return "当前没有可用片源。"
        }
    }
}

private func string(_ value: Any?) -> String? {
    let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return text?.isEmpty == false ? text : nil
}

func catalogID(_ value: Any?) -> String? {
    let text = string(value) ?? (value as? NSNumber)?.stringValue ?? ""
    return text.range(of: #"^[0-9]{1,16}$"#, options: .regularExpression) == nil ? nil : text
}

enum Channel: String, CaseIterable, Codable {
    case tv = "剧集", movie = "电影", variety = "综艺", anime = "动漫", doc = "纪录片"
    var icon: String {
        switch self {
        case .tv: return "tv"
        case .movie: return "film"
        case .variety: return "mic"
        case .anime: return "sparkles"
        case .doc: return "globe"
        }
    }
    var kinds: [String] {
        switch self {
        case .tv, .variety: return ["tv"]
        case .movie: return ["movie"]
        case .anime, .doc: return ["tv", "movie"]
        }
    }
    var tag: String? {
        switch self {
        case .tv: return "电视剧"
        case .movie: return nil
        case .anime: return "动画"
        default: return rawValue
        }
    }
}

struct Subject: Identifiable, Codable, Hashable {
    let id, title, kind: String
    let channel: Channel
    let year, region, synopsis: String
    let genres, aliases, creators, cast: [String]
    let poster: URL?
    var backdrop: URL?
    let rating: Double?
    let expectedEpisodes: Int?

    var subtitle: String {
        ([year, region] + genres.prefix(2)).filter { !$0.isEmpty }.joined(separator: " · ")
    }

    init?(_ wrapper: JSONRow, kind fallback: String? = nil) {
        if let card = string(wrapper["card"]), card != "subject" { return nil }
        let row = wrapper["target"] as? JSONRow ?? wrapper
        guard let id = catalogID(row["id"]), let title = string(row["title"]), title.count <= 300,
              let kind = string(wrapper["target_type"]) ?? string(row["type"]) ?? fallback,
              ["movie", "tv"].contains(kind) else { return nil }
        var parts = (string(row["card_subtitle"]) ?? "").components(separatedBy: "/")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let subtitleYear = parts.first.flatMap { $0.range(of: #"^\d{4}$"#, options: .regularExpression) != nil ? $0 : nil }
        if subtitleYear != nil { parts.removeFirst() }
        if let first = parts.first, ["电视剧", "电影", "综艺", "动漫", "纪录片"].contains(first) { parts.removeFirst() }
        let tags = parts.dropFirst().first?.components(separatedBy: .whitespaces).filter { !$0.isEmpty } ?? []
        let genres = (row["genres"] as? [String] ?? []) + tags
        guard !genres.contains("情色") else { return nil }
        self.id = id
        self.title = title
        self.kind = kind
        self.genres = genres.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
        if genres.contains("动画") { channel = .anime }
        else if row["is_show"] as? Bool == true || !Set(genres).isDisjoint(with: ["综艺", "真人秀", "脱口秀"]) { channel = .variety }
        else if genres.contains("纪录片") { channel = .doc }
        else { channel = kind == "movie" ? .movie : .tv }
        year = string(row["year"]) ?? (row["year"] as? NSNumber)?.stringValue ?? subtitleYear ?? ""
        region = string((row["countries"] as? [String])?.joined(separator: " / ")) ?? parts.first ?? ""
        synopsis = string(row["intro"]) ?? string(row["comment"]) ?? ""
        aliases = Array((row["aka"] as? [String] ?? []).prefix(30))
        creators = (row["directors"] as? [JSONRow] ?? []).compactMap { string($0["name"]) }
        cast = (row["actors"] as? [JSONRow] ?? []).compactMap { string($0["name"]) }
        let pic = row["pic"] as? JSONRow
        poster = [pic?["large"], pic?["normal"], row["cover_url"], row["cover"], (row["cover"] as? JSONRow)?["url"]]
            .compactMap { Network.artworkURL($0 as? String) }.first
        backdrop = (row["photos"] as? [String])?.compactMap { Network.artworkURL($0) }.first
        let score = ((row["rating"] as? JSONRow)?["value"] as? NSNumber)?.doubleValue
        rating = score.flatMap { $0 > 0 && $0 <= 10 ? $0 : nil }
        expectedEpisodes = (row["episodes_count"] as? NSNumber)?.intValue ?? Int(string(row["episodes_count"]) ?? "")
    }
}

enum Network {
    static func artworkURL(_ text: String?) -> URL? {
        guard let text = text, var parts = URLComponents(string: text.hasPrefix("//") ? "https:" + text : text),
              let host = parts.host?.lowercased(), host == "doubanio.com" || host.hasSuffix(".doubanio.com"),
              ["https", "http"].contains(parts.scheme?.lowercased()), parts.user == nil, parts.password == nil else { return nil }
        parts.scheme = "https"
        return parts.url
    }

    // Only simulator UI tests substitute an HTTP boundary. Device builds contact the real hosts.
    static func transportURL(_ url: URL) -> URL {
        #if DEBUG && targetEnvironment(simulator)
        if let port = ProcessInfo.processInfo.environment["PANDA_TEST_PORT"].flatMap(Int.init),
           (1024...65535).contains(port), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            parts.scheme = "http"
            parts.host = "127.0.0.1"
            parts.port = port
            if let mode = ProcessInfo.processInfo.environment["PANDA_TEST_SCENARIO"] {
                parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "scenario", value: mode)]
            }
            return parts.url ?? url
        }
        #endif
        return url
    }

    static func read(_ url: URL, referer: String? = nil, timeout: Double = 12) async throws -> Data {
        var request = URLRequest(url: transportURL(url), timeoutInterval: timeout)
        if let referer = referer { request.setValue(referer, forHTTPHeaderField: "Referer") }
        request.setValue("Mozilla/5.0 (iPad; CPU OS 15_3 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              data.count <= 12 * 1024 * 1024 else { throw CatalogError.response }
        return data
    }

    static func json(_ base: URL, _ parameters: [String: String] = [:], timeout: Double = 12) async throws -> Any {
        guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw CatalogError.response }
        if !parameters.isEmpty {
            parts.queryItems = parameters.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = parts.url else { throw CatalogError.response }
        let data = try await read(url, referer: "https://\(base.host ?? "")/", timeout: timeout)
        return try JSONSerialization.jsonObject(with: data)
    }
}

enum Catalog {
    struct Credit: Identifiable {
        let id, name, role: String
        let photo: URL?
    }
    private static let base = URL(string: "https://m.douban.com/rexxar/api/v2/")!

    private static func rows(_ path: String, _ query: [String: String], key: String) async throws -> ([JSONRow], Int?) {
        let response = try await Network.json(base.appendingPathComponent(path), query) as? JSONRow
        guard let rows = response?[key] as? [JSONRow], string(response?["banned"]) == nil else { throw CatalogError.response }
        return (rows, (response?["total"] as? NSNumber)?.intValue)
    }

    static func collection(_ name: String) async throws -> [Subject] {
        let (values, _) = try await rows("subject_collection/\(name)/items", ["start": "0", "count": "16"], key: "subject_collection_items")
        return unique(values.compactMap { Subject($0) })
    }

    static func detail(id: String, kind: String) async throws -> Subject {
        guard catalogID(id) != nil, ["movie", "tv"].contains(kind),
              let row = try await Network.json(base.appendingPathComponent("\(kind)/\(id)")) as? JSONRow,
              let subject = Subject(row, kind: kind), subject.id == id else { throw CatalogError.response }
        return subject
    }

    static func still(_ subject: Subject) async throws -> URL? {
        let (photos, _) = try await rows("\(subject.kind)/\(subject.id)/photos", ["count":"8"], key: "photos")
        return photos.compactMap { row -> URL? in
            guard let image = row["image"] as? JSONRow, image["is_animated"] as? Bool != true,
                  let large = image["large"] as? JSONRow, let w = large["width"] as? Double,
                  let h = large["height"] as? Double, w >= 640, h > 0, (1.35...2.7).contains(w / h) else { return nil }
            return Network.artworkURL(large["url"] as? String)
        }.first
    }

    static func credits(_ subject: Subject) async throws -> [Credit] {
        let (people, _) = try await rows("\(subject.kind)/\(subject.id)/credits", [:], key: "items")
        var seen = Set<String>()
        return people.prefix(12).compactMap { row in
            guard let name = string(row["name"]) else { return nil }
            let id = catalogID(row["id"]) ?? name
            guard seen.insert(id).inserted else { return nil }
            let avatar = row["avatar"] as? JSONRow
            let photo = Network.artworkURL(avatar?["normal"] as? String ?? avatar?["large"] as? String)
            return Credit(id: id, name: name, role: string(row["simple_character"]) ?? string(row["category"]) ?? "",
                          photo: photo?.path.hasPrefix("/view/") == true ? photo : nil)
        }
    }

    static func channel(_ channel: Channel, kind: String, tags: [String], sort: String, start: Int) async throws -> (items: [Subject], next: Int?) {
        let count = 24
        let query = ["start": String(start), "count": String(count), "sort": sort, "tags": ([channel.tag].compactMap { $0 } + tags).joined(separator: ",")]
        let (values, total) = try await rows("\(kind)/recommend", query, key: "items")
        if values.isEmpty && (total ?? 0) > start { throw CatalogError.response }
        let offset = start + values.count
        let hasMore = total.map { offset < $0 } ?? (values.count == count)
        return (values.compactMap { Subject($0, kind: kind) }.filter { $0.channel == channel }, hasMore && !values.isEmpty ? offset : nil)
    }

    static func search(_ term: String) async throws -> [Subject] {
        do {
            let (values, _) = try await rows("search/movie", ["q": term, "start": "0", "count": "40"], key: "items")
            return unique(values.compactMap { Subject($0) })
        } catch {
            try Task.checkCancellation()
            let base = URL(string: "https://movie.douban.com/j/subject_suggest")!
            guard let suggestions = try await Network.json(base, ["q": term]) as? [JSONRow] else { throw CatalogError.response }
            let ids = suggestions.filter { ($0["type"] as? String) == "movie" }.compactMap { catalogID($0["id"]) }
            return try await withThrowingTaskGroup(of: (Int, Subject?).self) { group in
                for (rank, id) in ids.prefix(8).enumerated() {
                    group.addTask {
                        if let movie = try? await detail(id: id, kind: "movie") { return (rank, movie) }
                        try Task.checkCancellation()
                        return (rank, try? await detail(id: id, kind: "tv"))
                    }
                }
                var resolved: [(Int, Subject?)] = []
                for try await item in group { resolved.append(item) }
                return unique(resolved.sorted { $0.0 < $1.0 }.compactMap(\.1))
            }
        }
    }

    static func unique(_ subjects: [Subject]) -> [Subject] {
        var seen = Set<String>()
        return subjects.filter { seen.insert($0.id).inserted }
    }
}

actor TitleIndex {
    static let shared = TitleIndex()
    private var entries: [(String, String)]?

    func hints(_ query: String) -> [String] {
        let key = query.lowercased()
        guard key.range(of: #"^[a-z]{2,20}$"#, options: .regularExpression) != nil else { return [] }
        if entries == nil, let file = Bundle.main.url(forResource: "search-titles", withExtension: "tsv"),
           let data = try? String(contentsOf: file, encoding: .utf8) {
            entries = data.split(whereSeparator: \.isNewline).compactMap {
                let fields = $0.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
                return fields.count == 3 ? (String(fields[0]), String(fields[2])) : nil
            }
        }
        let matches = (entries ?? []).filter { $0.0.hasPrefix(key) }.sorted { $0.0.count < $1.0.count }
        var seen = Set<String>()
        return Array(matches.map(\.1).filter { seen.insert($0).inserted }.prefix(8))
    }
}
