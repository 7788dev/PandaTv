import UIKit
import SwiftUI

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let client = PandaSplitView()
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["PANDA_TEST_COMPACT"] == "1" {
            // Exercise the actual split controller at a Slide Over width without SpringBoard gestures.
            let host = UIViewController()
            host.view.backgroundColor = .secondarySystemBackground
            host.addChild(client)
            host.view.addSubview(client.view)
            client.view.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                client.view.topAnchor.constraint(equalTo: host.view.safeAreaLayoutGuide.topAnchor),
                client.view.bottomAnchor.constraint(equalTo: host.view.safeAreaLayoutGuide.bottomAnchor),
                client.view.centerXAnchor.constraint(equalTo: host.view.centerXAnchor),
                client.view.widthAnchor.constraint(equalToConstant: 375)
            ])
            host.setOverrideTraitCollection(UITraitCollection(horizontalSizeClass: .compact), forChild: client)
            client.didMove(toParent: host)
            window.rootViewController = host
        } else { window.rootViewController = client }
        #else
        window.rootViewController = client
        #endif
        self.window = window
        window.makeKeyAndVisible()
    }
}

enum Destination: Hashable {
    case home, search, channel(Channel), favorites, history

    var title: String {
        switch self {
        case .home: return "首页"
        case .search: return "搜索"
        case .channel(let channel): return channel.rawValue
        case .favorites: return "收藏"
        case .history: return "观看历史"
        }
    }
    var symbol: String {
        switch self {
        case .home: return "house"
        case .search: return "magnifyingglass"
        case .channel(let channel): return channel.icon
        case .favorites: return "bookmark"
        case .history: return "clock"
        }
    }
}

final class Sidebar: UICollectionViewController {
    private let sections = ["浏览", "频道", "资料库"]
    private let rows: [[Destination]] = [[.home, .search], Channel.allCases.map(Destination.channel), [.favorites, .history]]
    private var data: UICollectionViewDiffableDataSource<String, Destination>!
    var select: ((Destination) -> Void)?

    init() {
        var config = UICollectionLayoutListConfiguration(appearance: .sidebar)
        config.headerMode = .supplementary
        super.init(collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
        title = "Panda"
    }
    required init?(coder: NSCoder) { fatalError("Use init()") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let cells = UICollectionView.CellRegistration<UICollectionViewListCell, Destination> { cell, _, item in
            var content = UIListContentConfiguration.sidebarCell()
            content.text = item.title
            content.image = UIImage(systemName: item.symbol)
            cell.contentConfiguration = content
            cell.accessibilityIdentifier = "nav-\(item.title)"
        }
        let headers = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionHeader
        ) { [sections] cell, _, index in
            var content = UIListContentConfiguration.sidebarHeader()
            content.text = sections[index.section]
            cell.contentConfiguration = content
        }
        data = UICollectionViewDiffableDataSource(collectionView: collectionView) { collection, index, item in
            collection.dequeueConfiguredReusableCell(using: cells, for: index, item: item)
        }
        data.supplementaryViewProvider = { collection, _, index in
            collection.dequeueConfiguredReusableSupplementary(using: headers, for: index)
        }
        var snapshot = NSDiffableDataSourceSnapshot<String, Destination>()
        for (section, group) in zip(sections, rows) {
            snapshot.appendSections([section])
            snapshot.appendItems(group, toSection: section)
        }
        data.apply(snapshot, animatingDifferences: false)
        collectionView.selectItem(at: IndexPath(item: 0, section: 0), animated: false, scrollPosition: [])
        clearsSelectionOnViewWillAppear = false
    }

    override func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        if let item = data.itemIdentifier(for: indexPath) { select?(item) }
    }

    func highlight(_ item: Destination) {
        guard isViewLoaded, let index = data.indexPath(for: item) else { return }
        collectionView.selectItem(at: index, animated: false, scrollPosition: [])
    }
}

final class SearchInput: NSObject, ObservableObject, UISearchResultsUpdating {
    @Published var text = ""
    let controller = UISearchController(searchResultsController: nil)
    override init() {
        super.init()
        controller.obscuresBackgroundDuringPresentation = false
        controller.searchBar.placeholder = "片名或拼音首字母"
        controller.searchBar.autocapitalizationType = .none
        controller.searchResultsUpdater = self
    }
    func updateSearchResults(for searchController: UISearchController) { text = searchController.searchBar.text ?? "" }
    func choose(_ term: String) {
        controller.searchBar.text = term
        controller.searchBar.resignFirstResponder()
        text = term
    }
}

private final class SubjectHost<Content: View>: UIHostingController<Content> {
    var appearanceChanged: ((Bool) -> Void)?
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appearanceChanged?(true)
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        appearanceChanged?(false)
    }
}

final class PandaSplitView: UISplitViewController, UISplitViewControllerDelegate {
    private let sidebar = Sidebar()
    private let detailNavigation = UINavigationController()
    private let library = Library()
    private var pinnedSidebar: Bool?

    init() {
        super.init(style: .doubleColumn)
        delegate = self
        minimumPrimaryColumnWidth = 212
        maximumPrimaryColumnWidth = 270
        preferredPrimaryColumnWidthFraction = 0.225
        let primary = UINavigationController(rootViewController: sidebar)
        primary.navigationBar.prefersLargeTitles = true
        detailNavigation.navigationBar.prefersLargeTitles = true
        setViewController(primary, for: .primary)
        setViewController(detailNavigation, for: .secondary)
        sidebar.select = { [weak self] in self?.open($0, reveal: true) }
        open(.home, reveal: false)
    }
    required init?(coder: NSCoder) { fatalError("Use init()") }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        guard view.bounds.width > 0 else { return }
        // Leave room for a full poster grid beside the system sidebar.
        let pin = view.bounds.width >= 900
        guard pin != pinnedSidebar else { return }
        pinnedSidebar = pin
        preferredSplitBehavior = pin ? .tile : .overlay
        preferredDisplayMode = pin ? .oneBesideSecondary : .secondaryOnly
    }

    private func open(_ destination: Destination, reveal: Bool) {
        let select: (Subject) -> Void = { [weak self] in self?.showSubject($0, autoplay: false) }
        let resume: (Subject) -> Void = { [weak self] in self?.showSubject($0, autoplay: true) }
        let browse: (Destination) -> Void = { [weak self] in self?.open($0, reveal: true) }
        sidebar.highlight(destination)
        let host: UIViewController
        switch destination {
        case .home:
            host = UIHostingController(rootView: HomePage(select: select, resume: resume, browse: browse).environmentObject(library))
        case .channel(let channel):
            host = UIHostingController(rootView: ChannelPage(channel: channel, select: select).environmentObject(library))
        case .search:
            let input = SearchInput()
            host = UIHostingController(rootView: SearchPage(input: input, select: select).environmentObject(library))
            host.navigationItem.searchController = input.controller
            host.navigationItem.hidesSearchBarWhenScrolling = false
            if #available(iOS 16.0, *) { host.navigationItem.preferredSearchBarPlacement = .stacked }
            host.definesPresentationContext = true
        case .favorites, .history:
            host = UIHostingController(rootView: LibraryPage(history: destination == .history, select: select, browse: browse).environmentObject(library))
        }
        host.title = destination == .home ? "现在观看" : destination.title
        if destination != .search {
            let search = UIBarButtonItem(image: UIImage(systemName: "magnifyingglass"), style: .plain, target: self, action: #selector(openSearch))
            search.accessibilityLabel = "搜索"
            search.accessibilityIdentifier = "open-search"
            host.navigationItem.rightBarButtonItem = search
        }
        host.navigationItem.backButtonDisplayMode = .minimal
        host.navigationItem.leftBarButtonItem = displayModeButtonItem
        host.navigationItem.leftItemsSupplementBackButton = true
        detailNavigation.setViewControllers([host], animated: false)
        if reveal { show(.secondary) }
    }

    @objc private func openSearch() {
        open(.search, reveal: true)
        DispatchQueue.main.async { [weak self] in
            guard let search = self?.detailNavigation.topViewController?.navigationItem.searchController else { return }
            search.isActive = true
            search.searchBar.becomeFirstResponder()
        }
    }
    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: "f", modifierFlags: .command, action: #selector(openSearch))]
    }

    private func showSubject(_ subject: Subject, autoplay: Bool) {
        weak var detail: UIViewController?
        let presentation = PlaybackPresentation()
        let page = SubjectPage(initial: subject, autoplay: autoplay, presentation: presentation) { show in
            detail?.navigationItem.title = show ? subject.title : nil
        }.environmentObject(library)
        let controller = SubjectHost(rootView: page)
        controller.appearanceChanged = { visible in presentation.visible = visible }
        detail = controller
        controller.navigationItem.largeTitleDisplayMode = .never
        detailNavigation.pushViewController(controller, animated: true)
    }

    func splitViewController(_ svc: UISplitViewController, topColumnForCollapsingToProposedTopColumn proposed: UISplitViewController.Column) -> UISplitViewController.Column {
        .secondary
    }
}
