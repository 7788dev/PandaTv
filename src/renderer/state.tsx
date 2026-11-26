import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react'
import { Toast } from '@base-ui/react/toast'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import type { UserState } from '../contract/types'
import { DEFAULT_SETTINGS, TOAST_ACTION_MS, TOAST_MS } from '../contract/constants'
import { t } from '../contract/copy'
import { extra } from '../copy.extra'
import type { StateAction } from '../shared/api'
import { playbackPreferences } from './playback-preferences'

const emptyUser: UserState = { favorites: [], history: [], searches: [], settings: { ...DEFAULT_SETTINGS } }
const UserContext = createContext<{
  state: UserState
  ready: boolean
  error: unknown
  dispatch: (action: StateAction) => Promise<UserState>
  reload: () => void
} | null>(null)

export function UserProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(emptyUser)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    let changed = false
    if (!window.panda) {
      setError(new Error(extra.appUnavailable))
      return
    }
    const unsubscribe = window.panda.user.subscribe(next => {
      changed = true
      if (active) { setState(next); setReady(true); setError(null) }
    })
    window.panda.user.get().then(next => {
      if (active) { if (!changed) setState(next); setReady(true); setError(null) }
    }, problem => { if (active) setError(problem) })
    return () => { active = false; unsubscribe() }
  }, [revision])
  const dispatch = useCallback(async (action: StateAction) => {
    const next = await window.panda.user.dispatch(action)
    if (action.type === 'settings') playbackPreferences.defaultsSaved(action.patch)
    setState(next)
    return next
  }, [])
  const reload = useCallback(() => { setError(null); setRevision(value => value + 1) }, [])
  return <UserContext.Provider value={{ state, ready, error, dispatch, reload }}>{children}</UserContext.Provider>
}

export function useUser() {
  const value = useContext(UserContext)
  if (!value) throw new Error('UserProvider missing')
  return value
}

export function useRemote<T>(loader: () => Promise<T>, dependencies: DependencyList, keepPreviousData = false, requestKey?: string | number) {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [revision, setRevision] = useState(0)
  const [settledKey, setSettledKey] = useState<string | number | undefined>()
  const settleToken = requestKey === undefined ? undefined : `${typeof requestKey}:${requestKey}:${revision}`
  const latest = useRef(loader)
  latest.current = loader
  useEffect(() => {
    let active = true
    setLoading(true)
    if (!keepPreviousData) setData(undefined)
    setError(null)
    Promise.resolve().then(() => latest.current()).then(next => {
      if (active) setData(next)
    }, problem => { if (active) setError(problem) }).finally(() => {
      if (active) { setLoading(false); setSettledKey(settleToken) }
    })
    return () => { active = false }
  }, [...dependencies, revision, keepPreviousData, requestKey])
  const reload = useCallback(() => setRevision(value => value + 1), [])
  const requestSettled = settleToken === undefined || settledKey === settleToken
  return { data, loading: loading || !requestSettled, error: requestSettled ? error : null, reload }
}

export function useCatalogueRevision(id: string) {
  const [revision, setRevision] = useState(0)
  useEffect(() => window.panda.data.onCatalogueUpdate(updated => {
    if (updated === id) setRevision(value => value + 1)
  }), [id])
  return revision
}

export function errorText(error: unknown) {
  if (!navigator.onLine || (error instanceof Error && /offline|network.*unavailable/i.test(error.message))) return t.state.offline
  if (error instanceof Error && error.message && !/https?:|\bat\s|stack|IPC|invoke|Error:|ENOTFOUND|ECONN|fetch failed/i.test(error.message)) return error.message
  return t.state.error
}

export function useNotify() {
  const manager = Toast.useToastManager()
  return useCallback((text: string, action?: { label: string; onClick: () => void }) => {
    manager.close()
    manager.add({
      title: text,
      timeout: action ? TOAST_ACTION_MS : TOAST_MS,
      actionProps: action ? { children: action.label, onClick: action.onClick } : undefined,
    })
  }, [manager])
}

function ToastViewport() {
  const { toasts } = Toast.useToastManager()
  return <Toast.Portal><Toast.Viewport className="toast-viewport">
    {toasts.map(toast => <Toast.Root className="toast" key={toast.id} toast={toast}>
      <Toast.Title />
      {toast.actionProps && <Toast.Action className="toast__action" />}
    </Toast.Root>)}
  </Toast.Viewport></Toast.Portal>
}

type ConfirmOptions = { title: string; confirm?: string; danger?: boolean }
const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)
const WindowControlsContext = createContext<HTMLElement | null>(null)
export const useWindowControlsContainer = () => useContext(WindowControlsContext)
export function useConfirm() {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('ConfirmProvider missing')
  return confirm
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [confirmation, setConfirmation] = useState<ConfirmOptions | null>(null)
  const [open, setOpen] = useState(false)
  const resolveRef = useRef<((result: boolean) => void) | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const dialogActions = useRef<AlertDialog.Root.Actions | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null)
  const ask = useCallback((options: ConfirmOptions) => new Promise<boolean>(resolve => {
    resolveRef.current?.(false)
    resolveRef.current = resolve
    setConfirmation(options)
    setOpen(true)
  }), [])
  const finish = (result: boolean) => {
    resolveRef.current?.(result)
    resolveRef.current = null
    dialogActions.current?.close()
  }
  useEffect(() => {
    if (open || !controlsHost) return
    let active = true
    const frame = requestAnimationFrame(() => {
      const animations = [surface.current, backdrop.current].flatMap(element => element?.getAnimations() ?? [])
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (active) dialogActions.current?.unmount()
      })
    })
    return () => { active = false; cancelAnimationFrame(frame) }
  }, [open, controlsHost])
  return <Toast.Provider limit={1} timeout={TOAST_MS}>
    <ConfirmContext.Provider value={ask}><WindowControlsContext.Provider value={controlsHost}>{children}</WindowControlsContext.Provider></ConfirmContext.Provider>
    <ToastViewport />
    <AlertDialog.Root open={open} actionsRef={dialogActions} onOpenChange={(value, details) => {
      if (!value) {
        details.preventUnmountOnClose()
        setOpen(false)
        resolveRef.current?.(false)
        resolveRef.current = null
      }
    }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" ref={backdrop} />
        <AlertDialog.Viewport className="dialog-viewport">
          <AlertDialog.Popup className="dialog-shell" initialFocus={cancel} render={(props, popup) => <div {...props}>
            <div ref={surface} className="dialog" data-open={popup.open ? '' : undefined} data-starting-style={popup.transitionStatus === 'starting' ? '' : undefined} data-ending-style={popup.transitionStatus === 'ending' ? '' : undefined}>{props.children}</div>
            <div ref={setControlsHost} />
          </div>}>
            <AlertDialog.Title className="dialog__title">{confirmation?.title}</AlertDialog.Title>
            <div className="dialog__actions">
              <AlertDialog.Close className="btn btn--ghost" ref={cancel}>{t.action.cancel}</AlertDialog.Close>
              <button className={`btn ${confirmation?.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => finish(true)}>{confirmation?.confirm ?? t.action.confirm}</button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </Toast.Provider>
}
