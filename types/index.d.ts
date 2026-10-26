export type Recap = string
export type Stage = 'researching' | 'planning' | 'coding' | 'testing' | 'debugging' | 'reviewing' | 'writing' | 'shipping'
export type Entry = { stage: Stage | null; text: Recap }

declare module 'claude-code' {
  interface PluginState {
    'recap-box': {
      recap: Recap | null
      goal: string | null
      asks: readonly string[]
      stage: Stage | null
      history: readonly Entry[]
    }
  }
}
