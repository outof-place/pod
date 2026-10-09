// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { EditorGpuAccelerationExperimentalSetting } from './EditorGpuAccelerationExperimentalSetting'

afterEach(() => {
  cleanup()
})

const TOGGLE = '[aria-label="Toggle GPU editor rendering"]'

function renderSetting(overrides: Partial<GlobalSettings>, updateSettings = vi.fn()) {
  return render(
    <EditorGpuAccelerationExperimentalSetting
      settings={{ ...getDefaultSettings('/tmp'), ...overrides }}
      updateSettings={updateSettings}
    />
  )
}

describe('EditorGpuAccelerationExperimentalSetting', () => {
  it('defaults off', () => {
    expect(getDefaultSettings('/tmp').experimentalEditorGpuAcceleration).toBe(false)
  })

  it.each([
    [false, true],
    [true, false]
  ])('flips the setting from %s to %s', (current, next) => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(
      { experimentalEditorGpuAcceleration: current },
      updateSettings
    )
    fireEvent.click(container.querySelector(TOGGLE)!)
    expect(updateSettings).toHaveBeenCalledWith({ experimentalEditorGpuAcceleration: next })
  })
})
