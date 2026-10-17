// Fork-only (Pod): what an automation keeps of its orca.yaml setup trust.
export type AutomationSetupTrust = {
  /** The hash of the base's orca.yaml setup the user approved at save. Each run sends it, so a host
   *  without the client's trust record runs that content, and only that. */
  setupTrustHash?: string | null
}
