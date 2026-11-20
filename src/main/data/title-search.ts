import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TitleSearchIndex, type InitialsDictionary } from '../../shared/title-search';

/** Loaded on the first initials search, never on window or home-feed startup. */
export class SearchTitleVocabulary {
  private flight?: Promise<TitleSearchIndex>;
  constructor(private readonly directory = resolve('resources')) {}
  async load(): Promise<TitleSearchIndex> {
    if (!this.flight) this.flight = this.read().catch(error => { this.flight = undefined; throw error; });
    return this.flight;
  }
  private async read() {
    const dictionaryPath = join(this.directory, 'search-initials.json');
    const titlesPath = join(this.directory, 'search-titles.tsv');
    const sizes = await Promise.all([stat(dictionaryPath), stat(titlesPath)]);
    if (sizes[0].size > 512 * 1024 || sizes[1].size > 12 * 1024 * 1024) throw new Error('Title vocabulary is too large');
    const [dictionary, titles] = await Promise.all([readFile(dictionaryPath, 'utf8'), readFile(titlesPath, 'utf8')]);
    return new TitleSearchIndex(JSON.parse(dictionary) as InitialsDictionary, titles);
  }
}
