export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value
  throw Object.assign(new Error(result.error.message), { code: result.error.code })
}
