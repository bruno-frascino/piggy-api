export function isConcurrentConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && (error.code === 'P2034' || error.code === 'P2002'))
    return true
  return (
    'name' in error &&
    error.name === 'DriverAdapterError' &&
    'cause' in error &&
    error.cause !== null &&
    typeof error.cause === 'object' &&
    'kind' in error.cause &&
    error.cause.kind === 'TransactionWriteConflict' &&
    'originalCode' in error.cause &&
    error.cause.originalCode === '40001'
  )
}
