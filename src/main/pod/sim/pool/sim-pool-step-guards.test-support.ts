// Test support: what PoolWorld checks around every step, so a core rule that breaks the draft's
// promises fails the test that ran it: no in-place edit of the input, no field the contract lacks.

export function deepFrozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFrozen(child)
    }
  }
  return value
}

/** Change detection compares only the contract's fields, so the core may write no other. */
export function onlyContractFields(rows: readonly object[], shape: object, what: string): void {
  for (const row of rows) {
    const stray = Object.keys(row).find((field) => !(field in shape))
    if (stray) {
      throw new Error(`the core wrote ${what}.${stray}, a field the contract does not name`)
    }
  }
}
