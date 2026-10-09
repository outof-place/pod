import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getEditorGpuAccelerationSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.editorGpuAcceleration.title',
      'GPU editor rendering'
    ),
    description: translate(
      'auto.components.settings.experimental.search.editorGpuAcceleration.description',
      'Draw file-editor text with the GPU (WebGPU) instead of the page layout engine.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.editorGpuAcceleration.gpu',
        'gpu'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.editorGpuAcceleration.webgpu',
        'webgpu'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.editorGpuAcceleration.editor',
        'editor'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.editorGpuAcceleration.rendering',
        'rendering'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.editorGpuAcceleration.scroll',
        'scroll'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.editorGpuAcceleration.performance',
        'performance'
      )
    ]
  }
}
