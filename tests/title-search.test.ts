import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TitleSearchIndex, initialQuery, titleSearchScore, suggestedSubjectIds, type InitialsDictionary } from '../src/shared/title-search';

const dictionary = JSON.parse(readFileSync('resources/search-initials.json', 'utf8')) as InitialsDictionary;
const index = new TitleSearchIndex(dictionary, readFileSync('resources/search-titles.tsv', 'utf8'));

describe('title initials vocabulary and matching', () => {
  it('has real catalogue coverage on a fresh install and supplies Chinese query terms', () => {
    expect(index.size).toBeGreaterThan(20000);
    expect(index.terms('LBXX')).toContain('蜡笔小新');
    expect(index.terms('CQSL')).toContain('重庆森林');
    expect(index.terms('XSKDJS')).toContain('肖申克的救赎');
    expect(index.terms('LBXX')).toEqual(index.terms('l b x x'));
    expect(index.hints('LBXX')[0]).toBe('蜡笔小新');
    expect(index.hints('LBXX')).toEqual(index.hints('lbxx'));
    const windows = new TitleSearchIndex(dictionary, readFileSync('resources/search-titles.tsv', 'utf8').replace(/\n/g, '\r\n'));
    expect(windows.hints('LBXX')).toEqual(index.hints('LBXX'));
  });
  it('reads URL-only global search cards while rejecting books and mismatched identities', () => {
    expect(suggestedSubjectIds([
      { type: 'movie', url: 'https://movie.douban.com/subject/1306506/' },
      { type: 'book', url: 'https://book.douban.com/subject/1088065/' },
      { type: 'movie', id: '2', url: 'https://movie.douban.com/subject/3/' },
    ])).toEqual(['1306506']);
  });
  it('matches one first letter per syllable, including polyphones and traditional titles', () => {
    for (const [title, query] of [['蜡笔小新', 'LBXX'], ['蜡筆小新', 'lbxx'], ['重庆森林', 'CQSL'], ['甄嬛传', 'ZHC'], ['阿Q正传', 'AQZC'], ['长安十二时辰', 'CAS ESC'], ['你好，李焕英', 'LHY']]) {
      expect(titleSearchScore(title, query, dictionary), `${title}/${query}`).toBeLessThan(Infinity);
    }
    expect(titleSearchScore('蜡笔小新', 'lxx', dictionary)).toBe(Infinity);
    expect(titleSearchScore('星际穿越', 'LBXX', dictionary)).toBe(Infinity);
  });
  it('ranks complete titles ahead of sequels and keeps literal English search', () => {
    expect(titleSearchScore('蜡笔小新', 'lbxx', dictionary)).toBeLessThan(titleSearchScore('蜡笔小新 第二季', 'lbxx', dictionary));
    expect(titleSearchScore('Interstellar', 'Interstellar', dictionary)).toBe(-2);
    expect(initialQuery('ＬＢＸＸ')).toBe('lbxx');
    expect(initialQuery('蜡笔小新')).toBeUndefined();
    expect(initialQuery('x')).toBeUndefined();
    expect(initialQuery('123')).toBeUndefined();
    expect(initialQuery('a'.repeat(100))).toBeUndefined();
  });
});
