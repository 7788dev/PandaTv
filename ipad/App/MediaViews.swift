import SwiftUI
import ImageIO

private actor Thumbnails {
    static let shared = Thumbnails()
    private let cache = NSCache<NSString, UIImage>()
    init() { cache.totalCostLimit = 36 * 1024 * 1024 }

    func image(_ url: URL, maxPixels: Int) async throws -> UIImage? {
        let key = "\(maxPixels):\(url.absoluteString)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        var variants = [url]
        if maxPixels > 640, url.path.hasPrefix("/view/photo/m/public/"),
           var large = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            large.path = large.path.replacingOccurrences(of: "/photo/m/", with: "/photo/l/")
            if let candidate = large.url { variants.insert(candidate, at: 0) }
        }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: true]
        for candidate in variants {
            try Task.checkCancellation()
            guard let data = try? await Network.read(candidate, referer: "https://movie.douban.com/"),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { continue }
            let result = UIImage(cgImage: thumbnail)
            cache.setObject(result, forKey: key, cost: thumbnail.bytesPerRow * thumbnail.height)
            return result
        }
        return nil
    }
}

struct PhotoFill: View {
    let url: URL?
    var fallback: URL?
    var pixels = 440
    var symbol = "film"
    @State private var image: UIImage?
    @State private var displayed: URL?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { box in
            ZStack {
                Color(UIColor.tertiarySystemFill)
                if let image = image {
                    Image(uiImage: image).resizable().scaledToFill().transition(.opacity)
                } else if !symbol.isEmpty {
                    Image(systemName: symbol).font(.title2).foregroundColor(Color(UIColor.tertiaryLabel))
                }
            }.frame(width: box.size.width, height: box.size.height).clipped()
        }.accessibilityHidden(true)
        .task(id: url) {
            if image != nil && displayed == url { return }
            image = nil; displayed = nil
            for candidate in [url, fallback].compactMap({ $0 }) {
                guard !Task.isCancelled else { return }
                if let decoded = try? await Thumbnails.shared.image(candidate, maxPixels: pixels), !Task.isCancelled {
                    displayed = url
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { image = decoded }
                    return
                }
            }
        }
    }
}

struct Artwork: View {
    let url: URL?
    var body: some View {
        Color.clear.aspectRatio(2.0 / 3.0, contentMode: .fit).overlay(PhotoFill(url: url))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.primary.opacity(0.08), lineWidth: 0.6))
    }
}

struct MediaPress: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.982 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

struct MediaHeading: View {
    let title: String
    var action: (() -> Void)?
    private var label: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.title2.bold())
            if action != nil {
                Image(systemName: "chevron.right").font(.subheadline.weight(.bold)).foregroundColor(.secondary)
            }
        }
    }
    var body: some View {
        if let action = action {
            Button(action: action) { label.frame(minHeight: 44, alignment: .leading) }
                .buttonStyle(.plain).accessibilityHint("打开全部作品")
        } else { label.accessibilityAddTraits(.isHeader) }
    }
}

struct Poster: View {
    let subject: Subject
    let select: (Subject) -> Void
    @EnvironmentObject private var library: Library
    var body: some View {
        Button { select(subject) } label: {
            VStack(alignment: .leading, spacing: 7) {
                Artwork(url: subject.poster)
                Text(subject.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                HStack(spacing: 5) {
                    if !subject.year.isEmpty { Text(subject.year).monospacedDigit() }
                    if let rating = subject.rating {
                        Image(systemName: "star.fill").imageScale(.small)
                        Text(String(format: "%.1f", rating)).monospacedDigit()
                    }
                }.foregroundColor(.secondary).font(.caption)
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(MediaPress())
        .contextMenu {
            Button { library.toggle(subject) } label: {
                Label(library.isFavorite(subject) ? "取消收藏" : "收藏", systemImage: library.isFavorite(subject) ? "bookmark.slash" : "bookmark")
            }
        }.accessibilityIdentifier("title-\(subject.id)")
    }
}

struct PosterGrid: View {
    let items: [Subject]
    let select: (Subject) -> Void
    @Environment(\.sizeCategory) private var textSize
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: textSize.isAccessibilityCategory ? 170 : 122, maximum: 232),
                                    spacing: 16, alignment: .top)], alignment: .leading, spacing: 22) {
            ForEach(items) { Poster(subject: $0, select: select) }
        }
    }
}

struct NoticeView: View {
    let symbol, message: String
    var retry: (() -> Void)?
    var body: some View {
        VStack(spacing: 13) {
            Image(systemName: symbol).font(.largeTitle).foregroundColor(.secondary).accessibilityHidden(true)
            Text(message).font(.body).foregroundColor(.secondary).multilineTextAlignment(.center)
            if let retry = retry {
                Button("重试", action: retry).buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.large).accessibilityIdentifier("retry")
            }
        }.frame(maxWidth: .infinity).padding(.vertical, 32)
    }
}

/// A landscape still fills the frame. A portrait-only title keeps its poster composition.
struct CinematicArt: View {
    let still, poster: URL?
    var body: some View {
        GeometryReader { box in
            ZStack(alignment: .trailing) {
                Color(white: 0.12)
                if let still = still {
                    PhotoFill(url: still, fallback: poster, pixels: 1480, symbol: "")
                } else if let poster = poster {
                    PhotoFill(url: poster, pixels: 640, symbol: "").blur(radius: 35).opacity(0.52)
                    PhotoFill(url: poster, pixels: 640, symbol: "")
                        .frame(width: box.size.height * 0.67).mask(
                            LinearGradient(colors: [.clear, .black, .black, .black], startPoint: .leading, endPoint: .trailing)
                        )
                }
                LinearGradient(stops: [.init(color: .black.opacity(0.04), location: 0),
                                       .init(color: .black.opacity(0.13), location: 0.35),
                                       .init(color: .black.opacity(0.83), location: 1)],
                               startPoint: .top, endPoint: .bottom)
            }.clipped()
        }.accessibilityHidden(true)
    }
}

struct ContinueCard: View {
    let entry: WatchEntry
    let resume: () -> Void
    @Environment(\.sizeCategory) private var textSize
    var body: some View {
        Button(action: resume) {
            HStack(spacing: 14) {
                if !textSize.isAccessibilityCategory {
                    PhotoFill(url: entry.subject.backdrop ?? entry.subject.poster, pixels: 360)
                        .frame(width: 102, height: 72).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(entry.subject.title).font(.headline).lineLimit(textSize.isAccessibilityCategory ? nil : 1)
                    Text(entry.continueDetail).font(.caption).monospacedDigit().foregroundColor(.secondary).lineLimit(textSize.isAccessibilityCategory ? nil : 1)
                    if !entry.finished && entry.fraction > 0 {
                        ProgressView(value: entry.fraction).progressViewStyle(.linear).frame(maxWidth: 200).padding(.top, 2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "play.circle.fill").font(.title).symbolRenderingMode(.hierarchical)
                    .foregroundColor(.accentColor).accessibilityHidden(true)
            }
            .padding(10).padding(.trailing, 5)
            .background(Color(UIColor.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .contentShape(Rectangle())
        }.buttonStyle(MediaPress()).accessibilityLabel("继续播放\(entry.subject.title)，\(entry.continueDetail)")
        .accessibilityIdentifier("resume-\(entry.id)")
    }
}
