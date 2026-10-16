import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { POD_SIM_RUNTIME_CAPABILITY } from '../pod-runtime-capabilities'
import { SIM_RPC_METHODS } from '../rpc-contract/sim-params'
import * as limits from './sim-call-limits'
import { SIM_HOLDER_KINDS } from './sim-holder'
import {
  SIM_DEVICE_EVENTS,
  SIM_DEVICE_STATES,
  SIM_LEASE_EVENTS,
  SIM_LEASE_STATES
} from './sim-lifecycle'
import { SIM_BRAKES, SIM_LEASE_END_REASONS, SIM_UNAVAILABLE_REASONS } from './sim-pool-snapshot'
import { SIM_REFUSAL_CODES } from './sim-refusals'
import { SIM_APP_CONTENT_NOTICE } from './sim-results'

// The vocabulary PodNative's Swift pins against the same file (SimulatorsContractTests).
const contract: unknown = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'contract.json'), 'utf8')
)

describe('the vocabulary both sides pin', () => {
  it('matches the TS contract exactly', () => {
    expect(contract).toEqual({
      runtimeCapability: POD_SIM_RUNTIME_CAPABILITY,
      // Pinned against the ui-host side in pod-sim-pane-protocol.test.ts.
      uiHostFeature: 'simulator',
      methods: [...SIM_RPC_METHODS],
      deviceStates: [...SIM_DEVICE_STATES],
      deviceEvents: [...SIM_DEVICE_EVENTS],
      leaseStates: [...SIM_LEASE_STATES],
      leaseEvents: [...SIM_LEASE_EVENTS],
      holderKinds: [...SIM_HOLDER_KINDS],
      brakes: [...SIM_BRAKES],
      leaseEndReasons: [...SIM_LEASE_END_REASONS],
      unavailableReasons: [...SIM_UNAVAILABLE_REASONS],
      refusalCodes: [...SIM_REFUSAL_CODES],
      callAgainExitCode: limits.SIM_CALL_AGAIN_EXIT_CODE,
      limits: {
        leaseDefaultWaitS: limits.SIM_LEASE_DEFAULT_WAIT_S,
        leaseMaxWaitS: limits.SIM_LEASE_MAX_WAIT_S,
        waiterAbandonS: limits.SIM_WAITER_ABANDON_S,
        reservationClaimS: limits.SIM_RESERVATION_CLAIM_S,
        takeoverIdleGiveBackS: limits.SIM_TAKEOVER_IDLE_GIVE_BACK_S,
        waitingListMax: limits.SIM_WAITING_LIST_MAX,
        stateDefaultMaxNodes: limits.SIM_STATE_DEFAULT_MAX_NODES,
        stateMaxNodes: limits.SIM_STATE_MAX_NODES,
        nodeTextMaxChars: limits.SIM_NODE_TEXT_MAX_CHARS,
        logsDefaultMaxLines: limits.SIM_LOGS_DEFAULT_MAX_LINES,
        logsMaxLines: limits.SIM_LOGS_MAX_LINES,
        logsDefaultMaxBytes: limits.SIM_LOGS_DEFAULT_MAX_BYTES,
        logsMaxBytes: limits.SIM_LOGS_MAX_BYTES,
        logLineMaxChars: limits.SIM_LOG_LINE_MAX_CHARS,
        screenshotDefaultScale: limits.SIM_SCREENSHOT_DEFAULT_SCALE,
        waitDefaultTimeoutS: limits.SIM_WAIT_DEFAULT_TIMEOUT_S,
        typeMaxChars: limits.SIM_TYPE_MAX_CHARS
      },
      appContentNotice: SIM_APP_CONTENT_NOTICE
    })
  })

  it('keeps every wait under the agent tool limits it was sized for', () => {
    expect(limits.SIM_LEASE_DEFAULT_WAIT_S).toBeLessThan(120)
    expect(limits.SIM_LEASE_MAX_WAIT_S).toBeLessThan(600)
  })
})
