import type { AtermApi } from '../../preload/index'

declare global {
  interface Window {
    aterm: AtermApi
  }
}

export {}
