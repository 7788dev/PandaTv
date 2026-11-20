/**
 * Nothing adult is shown or played (the owner's rule, 2026-11-20): the app is watched with family.
 *
 * Catalogues file such records on shelves of their own (伦理片, 港台三级, 里番动漫, 福利 and the
 * like, seen on every general catalogue measured that day); a record on one is never the work
 * that was asked for, whatever its name and year. Douban marks such works with one genre.
 */
const ADULT_SHELF = /伦理|倫理|三级|三級|情色|色情|成人|福利|写真|寫真|里番|肉番|无码|無碼|有码|有碼|擦边|(?<![a-z])av(?![a-z])/i
export const adultShelf = (name: string): boolean => ADULT_SHELF.test(name.normalize('NFKC'))
export const ADULT_GENRE = '情色'
