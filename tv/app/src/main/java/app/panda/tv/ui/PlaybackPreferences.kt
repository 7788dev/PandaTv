package app.panda.tv.ui

import app.panda.tv.model.Quality
import app.panda.tv.model.Settings
import app.panda.tv.model.StateAction

object PlaybackPreferences {
    var quality: Quality? = null
    var speed: Double? = null
    private var defaultQuality: Quality? = null
    private var defaultSpeed: Double? = null

    fun observeDefaults(settings: Settings) {
        if (defaultQuality != null && defaultQuality != settings.quality) quality = null
        if (defaultSpeed != null && defaultSpeed != settings.speed) speed = null
        defaultQuality = settings.quality
        defaultSpeed = settings.speed
    }

    fun defaultsSaved(action: StateAction.UpdateSettings) {
        action.quality?.let { quality = null; defaultQuality = it }
        action.speed?.let { speed = null; defaultSpeed = it }
    }
}
