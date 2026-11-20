import type { DataSource, HistoryEntry, HomeFeed, MediaItem, Page, Person, Playback, Quality, Settings, UserState } from '../../design/contract/types'

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
export interface PandaBridge {
  data: Omit<DataSource, 'detail'> & {
    detail(id: string): Promise<Detail>
    /** Catalogue-derived search terms for local initials completion; no film metadata. */
    titleHints(query: string): Promise<string[]>
    person(id: string): Promise<PersonInfo>
    /** Everything the person worked on, best rated first, a page at a time. */
    personWorks(id: string, cursor?: string): Promise<Page<MediaItem>>
    availability(id: string): Promise<Availability>
    retryPlayback(id: string, episode: number, quality?: Quality): Promise<Playback>
    /** Which sources carry the episode; the player offers them when there is more than one. */
    sources(id: string, episode: number): Promise<PlaySources>
    /** The episode from the one source the viewer picked. */
    playbackFrom(id: string, episode: number, source: string, quality?: Quality): Promise<Playback>
    /** A home feed read after the one `home()` answered with, when it differs. */
    onHome(listener: (feed: HomeFeed) => void): () => void
  }
  user: {
    get(): Promise<UserState>
    dispatch(action: StateAction): Promise<UserState>
    subscribe(listener: (state: UserState) => void): () => void
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
