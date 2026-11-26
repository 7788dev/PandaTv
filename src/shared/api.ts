import type { DataSource, HistoryEntry, HomeFeed, MediaItem, Page, Person, Playback, Quality, Settings, UserState } from '../contract/types'
import type { AlignInput, AlignmentResult, SourceHealthSnapshot } from './rules/types'
import type { ResolvedAlignmentConfig, ResolvedBudgetConfig, ResolvedBufferConfig } from './rules/config'

export type Availability = { episodes?: number; episodeTitles?: string[] }
/** One of the people on a title's page. With an `id` their works can be listed; `photo` is absent when there is none. */
export type Credit = Person & { id?: string; photo?: string }
/**
 * A title as its detail page shows it. `people` are the few Douban puts on the title's own page
 * (directors, leading actors, heads of other departments), in its order; `cast` are the actors among them.
 */
export type Detail = MediaItem & { people?: Credit[] }
export type PersonInfo = { id: string; name: string; photo?: string }
/** The sources that carry an episode, best first, and the one it is playing from. */
export type PlaySources = { current?: string; list: { key: string; name: string }[] }
export type WindowState = { maximized: boolean; fullscreen: boolean }
export type StateAction =
  | { type: 'favorite'; id: string }
  | { type: 'history:record'; entry: HistoryEntry }
  | { type: 'history:remove'; id: string }
  | { type: 'history:restore'; entry: HistoryEntry }
  | { type: 'history:clear' }
  | { type: 'search:add'; query: string }
  | { type: 'search:clear' }
  | { type: 'settings'; patch: Partial<Settings> }
export type UpdateResult = { status: 'current' | 'available'; version: string }
export type AppNotice = { code: string; message: string }
export type LibraryFailure = { id: string; code: string }
export type LibraryPage = Page<MediaItem> & { failures: LibraryFailure[]; pending: string[] }
export type StateRecovery = { needed: boolean; canRestore: boolean }
export type PlaybackRuntimeRules = { alignment: ResolvedAlignmentConfig; buffer: ResolvedBufferConfig; budget: ResolvedBudgetConfig }
export interface PandaBridge {
  data: Omit<DataSource, 'detail'> & {
    detail(id: string): Promise<Detail>
    /** Primary verified metadata, without waiting for optional credits and photos. */
    subject(id: string): Promise<MediaItem>
    libraryPage(ids: string[], cursor?: string, request?: string, cachedOnly?: boolean): Promise<LibraryPage>
    cancelLibrary(request: string): Promise<void>
    /** Catalogue-derived search terms for local initials completion; no film metadata. */
    titleHints(query: string): Promise<string[]>
    person(id: string): Promise<PersonInfo>
    /** Everything the person worked on, best rated first, a page at a time. */
    personWorks(id: string, cursor?: string): Promise<Page<MediaItem>>
    availability(id: string): Promise<Availability>
    retryPlayback(id: string, episode: number, quality?: Quality, failure?: 'probe' | 'stall'): Promise<Playback>
    /** Which sources carry the episode; the player offers them when there is more than one. */
    sources(id: string, episode: number): Promise<PlaySources>
    playbackRules(): Promise<PlaybackRuntimeRules>
    prepareSwitch(id: string, episode: number, options: { quality: Quality; retry?: boolean; failure?: 'probe' | 'stall'; from?: string }): Promise<Playback>
    acceptSwitch(id: string, episode: number, selectionId: number): Promise<boolean>
    /** Layered time alignment for a source switch. The renderer supplies frame scores, never thresholds. */
    align(input: AlignInput): Promise<AlignmentResult>
    /** The episode from the one source the viewer picked. */
    playbackFrom(id: string, episode: number, source: string, quality?: Quality): Promise<Playback>
    /** A home feed read after the one `home()` answered with, when it differs. */
    onHome(listener: (feed: HomeFeed) => void): () => void
  }
  sources: {
    /** Read-only source health snapshot; no addresses, cookies or samples. */
    health(workId?: string): Promise<SourceHealthSnapshot>
    observe(sourceKey: string, playSeconds: number, stallSeconds: number): Promise<void>
  }
  user: {
    get(): Promise<UserState>
    dispatch(action: StateAction): Promise<UserState>
    subscribe(listener: (state: UserState) => void): () => void
    recovery(): Promise<StateRecovery>
    recover(restoreBackup: boolean): Promise<UserState>
    exportRecovery(): Promise<{ status: 'saved' | 'cancelled' }>
  }
  window: {
    minimize(): Promise<void>
    maximize(): Promise<void>
    close(): Promise<void>
    fullscreen(value: boolean): Promise<void>
    getState(): Promise<WindowState>
    subscribe(listener: (state: WindowState) => void): () => void
  }
  app: {
    info(): Promise<{ version: string }>
    checkUpdate(): Promise<UpdateResult>
    subscribe(listener: (notice: AppNotice) => void): () => void
    onBeforeClose(listener: () => void | Promise<void>): () => void
  }
}
declare global { interface Window { panda: PandaBridge } }
