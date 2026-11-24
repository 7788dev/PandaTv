import type { Quality, Settings, Speed } from '../contract/types'

/** A player's temporary choices survive episodes, until the viewer explicitly saves a new default. */
export class PlaybackPreferences {
  speed?: Speed
  activeSpeed?: Speed
  quality?: Quality
  private defaultQuality?: Quality
  private defaultSpeed?: Speed

  observeDefaults(settings: { quality: Quality; speed?: Speed }) {
    if (this.defaultQuality !== undefined && this.defaultQuality !== settings.quality) this.quality = undefined
    this.defaultQuality = settings.quality
    if (settings.speed !== undefined) {
      if (this.defaultSpeed !== undefined && this.defaultSpeed !== settings.speed) { this.speed = undefined; this.activeSpeed = undefined }
      this.defaultSpeed = settings.speed
    }
  }

  defaultsSaved(patch: Partial<Settings>) {
    if (patch.quality !== undefined) { this.quality = undefined; this.defaultQuality = patch.quality }
    if (patch.speed !== undefined) { this.speed = undefined; this.activeSpeed = undefined; this.defaultSpeed = patch.speed }
  }

  wantedQuality(settings: { quality: Quality }) {
    this.observeDefaults(settings)
    return this.quality ?? settings.quality
  }
}

export const playbackPreferences = new PlaybackPreferences()
