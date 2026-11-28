import Foundation
import CryptoKit

struct PlaySource: Decodable {
    let key, name: String
    let api: URL
    let enabled: Bool
    let priority: Int
    let excludedRecordIds: [String]?
}

struct Stream: Identifiable, Hashable {
    let url: URL
    let source: String
    let priority: Int
    let weak: Bool
    var id: URL { url }
}

struct PlayEpisode: Identifiable, Equatable {
    let number: Int
    let title: String
    var streams: [Stream]
    // Only unnamed positional entries need a media fingerprint. History never stores a signed URL.
    var mediaKey: String?
    var id: String { mediaKey ?? title }

    func corresponding(in episodes: [PlayEpisode]) -> PlayEpisode? {
        let named = episodes.filter { $0.id == id }
        if named.count == 1 { return named.first }
        let addresses = Set(streams.map(\.url))
        let matches = episodes.filter { $0.streams.contains { addresses.contains($0.url) } }
        return matches.count == 1 ? matches.first : nil
    }
}

private extension String {
    func replacing(_ pattern: String, with replacement: String = "") -> String {
        replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }
    func groups(_ pattern: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = re.firstMatch(in: self, range: NSRange(startIndex..., in: self)) else { return nil }
        return (0..<match.numberOfRanges).map { Range(match.range(at: $0), in: self).map { String(self[$0]) } ?? "" }
    }
}

enum Sources {
    struct Line {
        let entries: [PlayEpisode]
        let numbered: Bool
    }
    struct Match {
        var weak = false
        var run: ClosedRange<Int>?
    }
    private struct Manifest: Decodable { let sources: [PlaySource] }

    static func configured() throws -> [PlaySource] {
        guard let file = Bundle.main.url(forResource: "play-sources", withExtension: "json") else { throw CatalogError.response }
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: file))
        return manifest.sources.filter(\.enabled).sorted { $0.priority > $1.priority }
    }

    private static func folded(_ title: String) -> String {
        title.precomposedStringWithCompatibilityMapping.lowercased()
            .replacing(#"[\s\u200b-\u200f\p{P}·△]"#)
            .replacing(#"(?:国语版?|普通话版?|粤语版?|英语版?|日语版?|韩语版?|中字|双语|高清|完整版|未删减版)$"#)
    }

    private static func nameKey(_ text: String) -> String {
        let plain = folded(text)
        guard let parts = plain.groups(#"^(.+?)(?:第([一二两三四五六七八九十0-9]{1,3})季|season([0-9]{1,2})|(?<=\D)([0-9]{1,2}))$"#),
              let token = parts.dropFirst(2).first(where: { !$0.isEmpty }) else { return plain }
        let numbers: [Character: Int] = ["一":1, "二":2, "两":2, "三":3, "四":4, "五":5, "六":6, "七":7, "八":8, "九":9]
        let tens = token.components(separatedBy: "十")
        let value = Int(token) ?? (tens.count == 2
            ? (tens[0].first.flatMap { numbers[$0] } ?? 1) * 10 + (tens[1].first.flatMap { numbers[$0] } ?? 0)
            : (token.first.flatMap { numbers[$0] } ?? 0))
        return value == 0 ? plain : parts[1] + (value == 1 ? "" : "#\(value)")
    }

    private static func countries(_ value: String) -> Set<String> {
        let aliases = ["大陆":"中国大陆", "内地":"中国大陆", "中国":"中国大陆", "台湾":"中国台湾", "香港":"中国香港"]
        return Set(value.components(separatedBy: CharacterSet(charactersIn: " /,，、;；|"))
            .filter { !$0.isEmpty && !["未知", "其他", "欧美", "华语"].contains($0) }.map { aliases[$0] ?? $0 })
    }

    private static func category(_ name: String) -> Channel? {
        if name.range(of: "动漫|动画", options: .regularExpression) != nil { return .anime }
        if name.range(of: "纪录|记录", options: .regularExpression) != nil { return .doc }
        if name.range(of: "综艺|晚会|脱口秀|真人秀", options: .regularExpression) != nil { return .variety }
        if name.hasSuffix("片") || name.contains("电影") { return .movie }
        if name.range(of: "剧|电视", options: .regularExpression) != nil { return .tv }
        return nil
    }

    private static func rangeAlias(_ alias: String) -> (String, ClosedRange<Int>)? {
        guard let fields = alias.groups(#"^(.+?)\s*第?\s*([0-9]{1,4})\s*[-—~至]\s*([0-9]{1,4})\s*[集话]$"#),
              let first = Int(fields[2]), let last = Int(fields[3]), first > 0, last >= first else { return nil }
        return (fields[1], first...last)
    }

    static func match(_ subject: Subject, record: JSONRow) -> Match? {
        let shelf = record["type_name"] as? String ?? ""
        guard let name = record["vod_name"] as? String, !name.isEmpty,
              (name + shelf).range(of: "预告|解说|花絮|幕后|速看|精彩片段", options: .regularExpression) == nil,
              shelf.range(of: #"伦理|倫理|三级|三級|情色|色情|成人|福利|写真|寫真|里番|肉番|无码|無碼|有码|有碼|擦边|(?<![a-z])av(?![a-z])"#, options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
        let area = countries(record["vod_area"] as? String ?? ""), wanted = countries(subject.region)
        if !area.isEmpty && !wanted.isEmpty && area.isDisjoint(with: wanted) { return nil }
        let fileYear = Int(String(String(describing: record["vod_year"] ?? "").prefix(4)))
        let year = Int(subject.year), type = category(shelf)
        var keys: Set<String> = [nameKey(name)]
        if let fileYear = fileYear, folded(name).hasSuffix(String(fileYear)) {
            keys.insert(nameKey(String(folded(name).dropLast(4))))
        }
        for alias in subject.aliases {
            if let (series, run) = rangeAlias(alias), keys.contains(nameKey(series)), type == subject.channel {
                if let y = year, let f = fileYear, run.lowerBound == 1 ? f != y : f > y { continue }
                let last = max(run.upperBound, run.lowerBound + min(subject.expectedEpisodes ?? 0, 10000) - 1)
                return Match(run: run.lowerBound...last)
            }
        }
        let exactYear = year != nil && fileYear == year
        guard keys.contains(nameKey(subject.title)) else {
            let alias = subject.aliases.contains { keys.contains(nameKey($0.replacing(#"\s*[（(][^（）()]{1,8}[)）]$"#))) }
            return alias && exactYear && type == subject.channel ? Match(weak: true) : nil
        }
        if let y = year, let f = fileYear, y != f {
            return abs(y - f) == 1 && type == subject.channel ? Match(weak: true) : nil
        }
        if let type = type, type != subject.channel {
            let documentary = subject.channel == .doc && [.variety, .tv, .movie].contains(type)
            if !exactYear || !(documentary || (subject.channel == .variety && type == .doc)) { return nil }
        }
        return type != nil || fileYear != nil ? Match() : nil
    }

    private static func mediaURL(_ value: String) -> URL? {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "&amp;", with: "&")
        guard let url = URL(string: raw.hasPrefix("//") ? "https:" + raw : raw),
              url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              let host = url.host?.lowercased(), host.contains("."), !host.hasSuffix(".local"),
              host.range(of: #"^[0-9.]+$"#, options: .regularExpression) == nil,
              ["m3u8", "mp4"].contains(url.pathExtension.lowercased()) else { return nil }
        return url
    }

    static func lines(_ record: JSONRow, subject: Subject, source: PlaySource) -> [Line] {
        guard let match = match(subject, record: record), let playlist = record["vod_play_url"] as? String else { return [] }
        let names = (record["vod_play_from"] as? String ?? "").components(separatedBy: "$$$")
        return playlist.components(separatedBy: "$$$").enumerated().compactMap { index, list in
            if names.indices.contains(index), names[index].lowercased().contains("yun") { return nil }
            var items: [(Int?, String, Stream)] = []
            for item in list.components(separatedBy: "#") {
                let parts = item.split(separator: "$", maxSplits: 1, omittingEmptySubsequences: false)
                let label = parts.count == 2 ? String(parts[0]).trimmingCharacters(in: .whitespacesAndNewlines) : ""
                guard let address = parts.last, let url = mediaURL(String(address)),
                      label.range(of: "预告|花絮|特辑|解说|彩蛋|幕后|速看|精彩片段", options: .regularExpression) == nil else { continue }
                let counter = label.groups(#"^(?:第|ep|e)?0*([0-9]{1,4})(?:集|期|话|回)?(?:已?完结|大结局|完)?$"#)
                items.append((counter.flatMap { Int($0[1]) }, label, Stream(url: url, source: source.name, priority: source.priority, weak: match.weak)))
            }
            guard !items.isEmpty else { return nil }
            let film = subject.kind == "movie"
            let numbers = items.compactMap { $0.0 }.filter { $0 > 0 }
            let plausible = !numbers.isEmpty && numbers.max()! <= items.count * 3 + 10
            let numbered = !film && plausible && numbers.count == items.count
            var occurrences: [Int: Int] = [:]
            if match.run != nil {
                guard plausible, numbers.count * 10 >= items.count * 9 else { return nil }
                for number in numbers { occurrences[number, default: 0] += 1 }
            }
            var episodes: [Int: PlayEpisode] = [:]
            for (offset, item) in items.enumerated() {
                let number: Int
                if let run = match.run {
                    guard let original = item.0, run.contains(original), occurrences[original] == 1 else { continue }
                    number = original - run.lowerBound + 1
                } else { number = film ? 1 : numbered ? item.0! : offset + 1 }
                let title = film ? "正片" : numbered || match.run != nil || item.1.isEmpty ? "第 \(number) 集" : item.1
                let unnamed = !film && !numbered && match.run == nil && item.1.isEmpty
                let key = unnamed ? "media:" + Data(SHA256.hash(data: Data(item.2.url.absoluteString.utf8))).base64EncodedString() : nil
                episodes[number, default: PlayEpisode(number: number, title: title, streams: [], mediaKey: key)].streams.append(item.2)
            }
            return episodes.isEmpty ? nil : Line(entries: episodes.values.sorted { $0.number < $1.number }, numbered: numbered || film || match.run != nil)
        }
    }

    static func episodes(_ lines: [Line]) -> [PlayEpisode] {
        guard let reference = lines.max(by: { $0.entries.count < $1.entries.count }) else { return [] }
        var items: [Int: PlayEpisode] = [:]
        let titles = Dictionary(grouping: reference.entries, by: \.id)
        for line in lines {
            for entry in line.entries {
                let number: Int
                if reference.numbered && line.numbered { number = entry.number }
                else if let matched = titles[entry.id], matched.count == 1 { number = matched[0].number }
                else { continue }
                items[number, default: PlayEpisode(number: number, title: entry.title, streams: [], mediaKey: entry.mediaKey)].streams += entry.streams
            }
        }
        return items.values.sorted { $0.number < $1.number }.map { episode in
            var seen = Set<URL>(), value = episode
            value.streams = episode.streams.sorted {
                if $0.weak != $1.weak { return !$0.weak }
                return $0.priority > $1.priority
            }.filter { seen.insert($0.url).inserted }
            return value
        }
    }

    static func find(_ subject: Subject, source: PlaySource) async throws -> [Line] {
        let title = subject.title.replacing(#"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]"#)
        let trimmed = title.replacing(#"(?i)\s*(?:第[一二两三四五六七八九十0-9]{1,3}季|season\s*\d{1,2})$"#)
        let primary = [title, trimmed] + subject.aliases.compactMap { rangeAlias($0)?.0 }
        let aliases = subject.aliases.filter { rangeAlias($0) == nil }.map { $0.replacing(#"\s*[（(][^（）()]{1,8}[)）]$"#) }
        var seen = Set<String>()
        func distinct(_ names: [String], limit: Int) -> [String] {
            var terms: [String] = []
            for name in names {
                let term = name.trimmingCharacters(in: .whitespacesAndNewlines)
                if !term.isEmpty && seen.insert(term.lowercased()).inserted { terms.append(term) }
                if terms.count == limit { break }
            }
            return terms
        }
        let terms = distinct(primary, limit: 3) + distinct(aliases, limit: 3)
        for term in terms {
            for page in 1...2 {
                try Task.checkCancellation()
                let result = try await Network.json(source.api, ["ac":"videolist", "wd":term, "pg":String(page)], timeout: 7) as? JSONRow
                guard let records = result?["list"] as? [JSONRow] else { throw CatalogError.response }
                var found: [Line] = []
                for var record in records.filter({ match(subject, record: $0) != nil }).prefix(4) {
                    guard let id = catalogID(record["vod_id"]), source.excludedRecordIds?.contains(id) != true else { continue }
                    if (record["vod_play_url"] as? String ?? "").isEmpty {
                        let detail = try await Network.json(source.api, ["ac":"videolist", "ids":id], timeout: 7) as? JSONRow
                        guard let exact = (detail?["list"] as? [JSONRow])?.first(where: { catalogID($0["vod_id"]) == id }) else { continue }
                        record = exact
                    }
                    found += lines(record, subject: subject, source: source)
                }
                if !found.isEmpty { return found }
                let pageCount = Int(String(describing: result?["pagecount"] ?? 1)) ?? 1
                if page >= pageCount { break }
            }
        }
        return []
    }
}
