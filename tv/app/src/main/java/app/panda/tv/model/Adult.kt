package app.panda.tv.model

import java.text.Normalizer

/**
 * Nothing adult is shown or played (the owner's rule, 2026-11-20): the app is watched with family.
 *
 * Catalogues file such records on shelves of their own (伦理片, 港台三级, 里番动漫, 福利 and the
 * like); a record on one is never the work that was asked for, whatever its name and year.
 * Douban marks such works with one genre. Kept identical to desktop `src/main/adult.ts`.
 */
object Adult {
    private val SHELF = Regex(
        "伦理|倫理|三级|三級|情色|色情|成人|福利|写真|寫真|里番|肉番|无码|無碼|有码|有碼|擦边|(?<![a-z])av(?![a-z])",
        RegexOption.IGNORE_CASE,
    )
    const val GENRE = "情色"

    fun shelf(name: String): Boolean = SHELF.containsMatchIn(Normalizer.normalize(name, Normalizer.Form.NFKC))
}
