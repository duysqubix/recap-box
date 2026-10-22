export type Recap = string
export type Stage = 'researching' | 'planning' | 'coding' | 'testing' | 'debugging' | 'reviewing' | 'writing' | 'shipping'

declare module 'claude-code' {
  interface PluginState {
    'recap-box': { recap: Recap | null; stage: Stage | null; left: number }
  }
}
