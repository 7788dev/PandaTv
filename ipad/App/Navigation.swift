import UIKit
import SwiftUI

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = PandaSplitView()
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

final class PandaSplitView: UISplitViewController, UISplitViewControllerDelegate {
    private let sidebar = Sidebar()
    private let detailNavigation = UINavigationController()
    private let library = Library()

    init() {
        super.init(style: .doubleColumn)
        delegate = self
        preferredDisplayMode = .oneBesideSecondary
        preferredSplitBehavior = .tile
        let primary = UINavigationController(rootViewController: sidebar)
        primary.navigationBar.prefersLargeTitles = true
        detailNavigation.navigationBar.prefersLargeTitles = true
        setViewController(primary, for: .primary)
        setViewController(detailNavigation, for: .secondary)
        sidebar.select = { [weak self] in self?.open($0, reveal: true) }
        open(.home, reveal: false)
    }
    required init?(coder: NSCoder) { fatalError("Use init()") }

    private func open(_ destination: Destination, reveal: Bool) {
        let select: (Subject) -> Void = { [weak self] in self?.showSubject($0) }
        let host: UIViewController
        switch destination {
        case .home:
            host = UIHostingController(rootView: HomePage(select: select).environmentObject(library))
        case .channel(let channel):
            host = UIHostingController(rootView: ChannelPage(channel: channel, select: select))
        case .search:
            let input = SearchInput()
            host = UIHostingController(rootView: SearchPage(input: input, select: select))
            host.navigationItem.searchController = input.controller
            host.navigationItem.hidesSearchBarWhenScrolling = false
            host.definesPresentationContext = true
        case .favorites, .history:
            host = UIHostingController(rootView: LibraryPage(history: destination == .history, select: select).environmentObject(library))
        }
        host.title = destination.title
        host.navigationItem.backButtonDisplayMode = .minimal
        host.navigationItem.leftBarButtonItem = displayModeButtonItem
        host.navigationItem.leftItemsSupplementBackButton = true
        detailNavigation.setViewControllers([host], animated: false)
        if reveal { show(.secondary) }
    }

    private func showSubject(_ subject: Subject) {
        let page = SubjectPage(initial: subject).environmentObject(library)
        let controller = UIHostingController(rootView: page)
        controller.title = subject.title
        controller.navigationItem.largeTitleDisplayMode = .never
        detailNavigation.pushViewController(controller, animated: true)
    }

    func splitViewController(_ svc: UISplitViewController, topColumnForCollapsingToProposedTopColumn proposed: UISplitViewController.Column) -> UISplitViewController.Column {
        .secondary
    }
}
