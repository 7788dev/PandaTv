/** Shared title vocabulary. A match only supplies a query for real metadata, never a film. */
export interface InitialsDictionary {
  version: number;
  ranges: Array<[number, string]>;
  variants: { [code: string]: string };
}
interface TitleEntry { title: string; key: string; variants: string }
export interface TitleMatch { score: number; offset: number; length: number }

/** Public suggestions are identity hints. Their generic "movie" type is not media metadata. */
export function suggestedSubjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || item.type !== 'movie' || typeof item.url !== 'string') continue;
    try {
      const url = new URL(item.url);
      const id = /^\/subject\/(\d{1,16})\/?$/.exec(url.pathname)?.[1];
      if (id && (item.id === undefined || item.id === id) && url.protocol === 'https:' && url.hostname === 'movie.douban.com' && !url.username && !url.password) ids.add(id);
    } catch { /* Invalid identity hints do not become clickable results. */ }
    if (ids.size >= 8) break;
  }
  return [...ids];
}

export function initialQuery(value: string): string | undefined {
  const query = value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return /^[a-z][a-z0-9]{1,31}$/.test(query) ? query : undefined;
}

export function titleCharacters(title: string): string[] {
  return Array.from(title.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '').replace(/[^\p{L}\p{N}]/gu, ''));
}

function characterLetters(character: string, dictionary: InitialsDictionary): string {
  if (/^[a-z0-9]$/i.test(character)) return character.toLowerCase();
  const code = character.codePointAt(0)!;
  if (dictionary.variants[String(code)]) return dictionary.variants[String(code)];
  for (const [start, letters] of dictionary.ranges) {
    const offset = code - start;
    if (offset >= 0 && offset < letters.length) return letters[offset];
  }
  return '?';
}

function variantExpression(query: string): RegExp {
  // One position per letter; polyphonic readings do not create a Cartesian product.
  return new RegExp('(?:^|\\|)' + [...query].map(letter => `[^|]*${letter}[^|]*`).join('\\|') + '(?=\\||$)');
}

function entryMatch(entry: TitleEntry, query: string, expression: RegExp): TitleMatch | undefined {
  let offset = entry.key.indexOf(query);
  let alternate = false;
  if (offset < 0 && entry.variants) {
    const found = expression.exec(entry.variants);
    if (found) {
      offset = (entry.variants.slice(0, found.index).match(/\|/g)?.length ?? 0) + (found[0].startsWith('|') ? 1 : 0);
      alternate = true;
    }
  }
  if (offset < 0) return;
  const exact = offset === 0 && entry.key.length === query.length;
  return { score: (exact ? 0 : offset === 0 ? 10 : 40 + offset) + (alternate ? 2 : 0) + (entry.key.length - query.length) / 1000, offset, length: query.length };
}

/** Literal titles still outrank initials. Infinity means the title has no matching evidence. */
export function titleSearchScore(title: string, query: string, dictionary: InitialsDictionary): number {
  const characters = titleCharacters(title);
  const plain = characters.join('').toLowerCase();
  const literal = titleCharacters(query).join('').toLowerCase();
  if (literal && plain.includes(literal)) return plain === literal ? -2 : -1;
  const initials = initialQuery(query);
  if (!initials) return Infinity;
  const letters = characters.map(character => characterLetters(character, dictionary));
  const key = letters.map(group => group[0]).join('');
  return entryMatch({ title, key, variants: letters.join('|') }, initials, variantExpression(initials))?.score ?? Infinity;
}

export class TitleSearchIndex {
  private readonly entries: TitleEntry[];
  readonly generatedAt: string;
  constructor(readonly dictionary: InitialsDictionary, titles: string) {
    if (dictionary.version !== 1 || !Array.isArray(dictionary.ranges) || !dictionary.variants) throw new Error('Invalid initials dictionary');
    const lines = titles.replace(/\r\n?/g, '\n').split('\n');
    if (lines[0] !== '# Panda title index v1') throw new Error('Invalid title vocabulary');
    this.generatedAt = lines[1]?.replace(/^# /, '') ?? '';
    this.entries = lines.slice(2).flatMap(line => {
      const [key, variants, title] = line.split('\t');
      return key && title && /^[a-z0-9]{2,160}$/.test(key) ? [{ title, key, variants: variants ?? '' }] : [];
    });
  }
  get size() { return this.entries.length; }

  hints(input: string, limit = 8): string[] {
    return this.terms(input, limit);
  }

  terms(input: string, limit = 6): string[] {
    const query = initialQuery(input);
    if (!query) return [];
    const expression = variantExpression(query);
    const found: Array<{ entry: TitleEntry; match: TitleMatch }> = [];
    for (const entry of this.entries) {
      const match = entryMatch(entry, query, expression);
      if (match) found.push({ entry, match });
    }
    found.sort((a, b) => a.match.score - b.match.score);
    const terms = new Set<string>();
    for (const { entry, match } of found) {
      const term = titleCharacters(entry.title).slice(match.offset, match.offset + match.length).join('');
      if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(term)) terms.add(term);
      if (terms.size >= limit) break;
    }
    return [...terms];
  }
  score(title: string, query: string) { return titleSearchScore(title, query, this.dictionary); }
}
