import type { ClientRequest } from 'node:http'
import { TLSSocket } from 'node:tls'

/**
 * Calls `late` when a request's new connection has not finished connecting (TCP, and TLS for
 * https) within `ms` of having its address. A request on a kept-alive connection is not watched.
 *
 * Why this exists: behind a local proxy the TCP connection is accepted at once and now and then
 * the TLS handshake behind it never completes. Nothing is sent or received, so only the
 * request's whole timeout would end it: 6–10 s for one poster or one list (measured
 * 2026-11-17, about one new connection in a hundred). A handshake takes 0.1–0.5 s, so the wait
 * for it can be far shorter than the wait for an answer.
 */
export function watchHandshake(request: ClientRequest, ms: number, late: () => void): void {
  request.once('socket', socket => {
    if (request.reusedSocket) return
    let timer = setTimeout(late, ms)
    const done = () => clearTimeout(timer)
    // The address may come from a lookup over the network, which has its own deadline.
    socket.once('lookup', () => { clearTimeout(timer); timer = setTimeout(late, ms) })
    socket.once(socket instanceof TLSSocket ? 'secureConnect' : 'connect', done)
    request.once('close', done)
  })
}
