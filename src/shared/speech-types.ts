// Why kept: GlobalSettings.voice still loads from existing settings files; dictation itself is gone.
export type SpeechModelType =
  | 'transducer'
  | 'paraformer'
  | 'whisper'
  | 'senseVoice'
  | 'nemo-ctc'
  | 'openai'

export type UserModelConfig = {
  id: string
  type: SpeechModelType
  dir: string
  sampleRate?: number
}

export type DictationMode = 'toggle' | 'hold'

export type VoiceSettings = {
  enabled: boolean
  sttModel: string
  modelsDir: string
  language: string
  dictationMode: DictationMode
  terminalConfirmBeforeInsert: boolean
  userModels: UserModelConfig[]
  openAiApiKeyConfigured: boolean
  /** null = system default input device */
  microphoneDeviceId: string | null
  /** Cached label for display when the preferred device is unplugged */
  microphoneDeviceLabel: string | null
}
