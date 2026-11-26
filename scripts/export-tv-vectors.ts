import { createCipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { HistoryEntry, MediaItem, Playback, Settings } from '../src/contract/types';
import {
  clock, episodeHeading, episodeLabel, episodeRanges, historyRecord,
  isFinished, metaParts, playLabel, progressPercent, progressText,
  resumePosition, scoreText, statusText, upNextSeconds,
} from '../src/contract/rules';
import {
  imageUrl, landscapePhoto, mediaType, normalize, portraitUrl,
  principalCredits, subtitleParts,
} from '../src/main/data/normalize';
import { GENRES, REGIONS, matchesRegion, matchesYear, yearChoices, yearSpan } from '../src/main/data/taxonomy';
import { combineHotQueries, hotQueries } from '../src/main/data/hot-search';
import {
  classifySourceType, episodeRange, issueKey, manifestVariants,
  matchRecord, normalizedTitle, numbering, parseLines, rank,
  referenceLine, runOf, sameIssue, searchTerms, titleKey, workTerms,
} from '../src/main/playback/service';
import { filterPlaylist, hasSynchronizedTracks } from '../src/main/playback/filter';
import { clearHead, pictureOf } from '../src/main/playback/picture';
import { isMp4Head } from '../src/main/playback/media-head';
import { adultShelf } from '../src/main/adult';
import { loadSourceRules } from '../src/main/playback/sources';
import { compareDelivery, compareSourceOrder, playbackMargin } from '../src/main/playback/delivery';
import { TitleSearchIndex, initialQuery, titleSearchScore, suggestedSubjectIds, type InitialsDictionary } from '../src/shared/title-search';
import type { ResolvedAlignmentConfig, ResolvedBudgetConfig, ResolvedBufferConfig, ResolvedHealthConfig } from '../src/shared/rules/config';
import type { BufferSample, DurationHistory, DurationInput, HealthEntry, ScoredSample, SwitchEvent } from '../src/shared/rules/types';
import { scoreOf, verdictOf } from '../src/shared/rules/health';
import { bufferThreshold, shouldTakeOver } from '../src/shared/rules/buffer';
import { evaluateSwitch, isUnavailable, markUnavailableOnce } from '../src/shared/rules/switch-budget';
import { durationVerdict, pickOffsets, similarity, windowSearch } from '../src/shared/rules/alignment';

const root = resolve(process.cwd());
const initialsDictionary = JSON.parse(readFileSync(resolve(root, 'resources/search-initials.json'), 'utf8')) as InitialsDictionary;
const titleVocabulary = readFileSync(resolve(root, 'resources/search-titles.tsv'), 'utf8');
const titleIndex = new TitleSearchIndex(initialsDictionary, titleVocabulary);
for (const name of ['search-initials.json', 'search-titles.tsv', 'LICENSE-pinyin-pro.txt', 'rule-calibration.json']) {
  writeFileSync(resolve(root, 'tv/app/src/main/assets', name), readFileSync(resolve(root, 'resources', name)));
}
const rulesConfig = loadSourceRules(resolve(root, 'resources/play-sources.json'));
const sourceOf = (key: string) => rulesConfig.sources.find(s => s.key === key)!;
const fixtureManifest = (name: string) => readFileSync(resolve(root, `docs/evidence/manifest-${name}.m3u8`), 'utf8');
const segmentHeads = JSON.parse(readFileSync(resolve(root, 'tv/app/src/test/resources/media-heads.json'), 'utf8')) as {
  heads: Array<{ source: string; title: string; encrypted: boolean; picture: string; head: string }>;
};

const baseItem: MediaItem = {
  id: 'db-26647087', title: '三体', type: 'tv', year: 2023, region: '中国大陆',
  score: 8.8, genres: ['剧情', '科幻'], episodes: 30, status: '更新至30集',
  poster: 'https://img1.doubanio.com/a.jpg', backdrop: null,
};
const filmItem: MediaItem = {
  id: 'db-1292052', title: '肖申克的救赎', type: 'movie', year: 1994, region: '美国',
  score: 9.7, genres: ['剧情', '犯罪'], runtime: 142,
  poster: 'https://img2.doubanio.com/b.jpg', backdrop: 'https://img2.doubanio.com/bg.jpg',
};
const sampleHistory: HistoryEntry = { id: 'db-26647087', episode: 5, position: 720, duration: 2700, at: 1700000000000 };
const finishedHistory: HistoryEntry = { id: 'db-1292052', episode: 1, position: 8300, duration: 8520, at: 1700000000000 };

const normalizeCases = [
  { id: '10477598', type: 'tv', title: '罗小黑战记', year: '2011', episodes_count: 46, genres: ['剧情', '喜剧', '动作'], card_subtitle: '2011 / 中国大陆 / 剧情 喜剧 动作 动画 奇幻 / 木头 / 山新 皇贞季' },
  { id: '37657706', type: 'movie', title: '余命一年买男人', card_subtitle: '2026 / 日本 / 剧情 爱情 / 某导演', rating: { value: 6.1 }, cover: { url: 'https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2935853700.jpg' } },
  { id: '37457082', type: 'tv', title: '凡人修仙传 年番4', year: '2026', genres: ['动画'], episodes_count: 52, aka: ['凡人修仙传 第177-228集', '凡人修仙传 年番4之慕兰之战'] },
  { id: '1', type: 'movie', title: '恶意主机', pic: { large: 'https://img1.doubanio.com.attacker.net/image.jpg' }, rating: { value: 0 }, durations: ['45分钟'] },
  { card: 'chart', id: '9', type: 'movie', title: '非条目卡片' },
  { id: '1828115', type: 'movie', title: '成人题材条目', card_subtitle: '2007 / 中国台湾 / 剧情 爱情 情色 / 某导演' },
  { id: '1828116', type: 'movie', title: '成人题材详情', genres: ['剧情', '情色'] },
];

const creditsSample = {
  items: [
    { id: '1313742', name: '于和伟', category: '演员', simple_character: '饰 史强', avatar: { normal: 'https://img1.doubanio.com/view/celebrity/raw/public/p1.jpg' } },
    { id: '1001', name: '杨磊', category: '导演', simple_character: '导演', avatar: { normal: 'https://img1.doubanio.com/view/celebrity/raw/public/p2.jpg' } },
    { id: '1001', name: '杨磊', category: '编剧', simple_character: '编剧', avatar: { normal: 'https://img1.doubanio.com/view/celebrity/raw/public/p2.jpg' } },
    { id: '1002', name: '无照影人', category: '演员', simple_character: '饰 配角', avatar: { normal: 'https://img1.doubanio.com/f/movie/8dd0c794499fe925ae2ae89ee30cd225750457b4/pics/movie/celebrity-default-medium.png' } },
  ],
};

const hotRaw = {
  success: true,
  data: {
    cards: [{
      component: 'tabImgInfoList',
      content: [{
        content: [
          { title: '电影甲', Sa: 'fyb_movie', hotScore: { desc: '热搜指数', value: '500' } },
          { title: '电影乙', Sa: 'fyb_movie', hotScore: { desc: '热搜指数', value: '900' } },
          { title: '生活话题', Sa: 'fyb_realtime', hotScore: { desc: '热搜指数', value: '1000' } },
        ],
      }],
    }],
  },
};

const run4: MediaItem = { id: 'db-37457082', title: '凡人修仙传 年番4', year: 2026, type: 'anime', poster: null, backdrop: null, genres: [] };
const run4Hints = { aliases: ['凡人修仙传 第177-228集', '凡人修仙传 年番4之慕兰之战', '凡人修仙传：慕兰之战', '凡人修仙传 第五季', "A Record of a Mortal's Journey to Immortality"], totalEpisodes: 52 };
const serialNumbered = parseLines('m3u8', Array.from({ length: 200 }, (_, i) => `第${String(i + 1).padStart(2, '0')}集$https://example.com/${i + 1}.m3u8`).join('#'))[0]!;
const extraEntries = [...Array.from({ length: 239 }, (_, i) => `第${String(i + 1).padStart(2, '0')}集`), '第240集上', '第240集下', ...Array.from({ length: 22 }, (_, i) => `第${241 + i}集`), '第263集完结', '90分钟结局', '导演剪辑版'];
const serialWithExtras = parseLines('m3u8', extraEntries.map((title, i) => `${title}$https://example.com/${i}.m3u8`).join('#'))[0]!;

const varietyRef = parseLines('m3u8', ['先导片上', '先导片下', '第20251023期', '第20251025期', '第20251026期', '第20260104期特别加更'].map((title, i) => `${title}$https://example.com/r${i}.m3u8`).join('#'))[0]!;
const varietyOther = parseLines('m3u8', ['20251018', '20251025上', '20260104(特别加更)', '第20251018期先导片上', '第20251019期先导片下'].map((title, i) => `${title}$https://example.com/o${i}.m3u8`).join('#'))[0]!;

const playlistBase = new URL('https://vip.ffzy-online2.com/main.m3u8');
const D = '#EXT-X-DISCONTINUITY';
const mkPlaylist = (...parts: Array<string | [number, string]>) => '#EXTM3U\n#EXT-X-TARGETDURATION:60\n' + parts.map(part => typeof part === 'string' ? part + '\n' : `#EXTINF:${part[0]},\n${part[1]}\n`).join('') + '#EXT-X-ENDLIST\n';
const mkContent = (dir: string, count: number, from = 0): Array<[number, string]> => Array.from({ length: count }, (_, i) => [10, `https://cdn.example/${dir}/${from + i}.ts`]);
const cuePlaylist = mkPlaylist(...mkContent('show', 10), '#EXT-X-CUE-OUT:10', [5, 'https://cdn.example/show/ad1.ts'], [5, 'https://cdn.example/show/ad2.ts'], '#EXT-X-CUE-IN', ...mkContent('show', 10, 10));
const implicitIvPlaylist = mkPlaylist('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/show/key.bin"', ...mkContent('show', 20), D, [5, 'https://ads.example/x/1.ts'], [5, 'https://ads.example/x/2.ts'], D, ...mkContent('show', 20, 20));
const explicitIvPlaylist = mkPlaylist('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/show/key.bin",IV=0x00000000000000000000000000000001', ...mkContent('show', 20), D, [5, 'https://ads.example/x/1.ts'], [5, 'https://ads.example/x/2.ts'], D, ...mkContent('show', 20, 20));
const longAdBlockPlaylist = mkPlaylist(...mkContent('show', 100), '# ppvod-ad-injected v1', D, ...mkContent('ads', 10), D, ...mkContent('show', 100, 100));
const shortPlaylist = mkPlaylist([10, 'https://cdn.example/a.ts'], [10, 'https://cdn.example/b.ts']);
const syncTracksPlaylist = mkPlaylist('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g1",NAME="zh",URI="audio.m3u8"', ...mkContent('show', 10));

const clearSample = Buffer.from(segmentHeads.heads[0]!.head, 'base64');
const aesKey = Buffer.from('0123456789abcdef');
const aesIv = Buffer.alloc(16, 9);
const cipher = createCipheriv('aes-128-cbc', aesKey, aesIv);
const sealedSample = Buffer.concat([cipher.update(Buffer.concat([clearSample, Buffer.alloc(5000, 1)])), cipher.final()]);

const ruleAt = 1_760_000_000_000;
const healthConfigStandard: ResolvedHealthConfig = {
  basisVersion: 'calib-a', decayVersion: '1', halfLifeDays: 30, baseline: 0.5,
  slowStartupSec: 6, playFloorSec: 60, workDeltaMax: 0.2,
  weights: { availability: 0.4, stability: 0.3, speed: 0.2, quality: 0.1 },
};
const healthConfigShortHalfLife: ResolvedHealthConfig = { ...healthConfigStandard, halfLifeDays: 7 };
const healthEntries: Array<{ label: string; entry: HealthEntry }> = [
  {
    label: 'recovered',
    entry: {
      sourceKey: 'ffzy', success: 20, failure: { catalogue: 0, probe: 0, firstSegment: 0, stall: 0, alignment: 0 },
      startupMedian: 1.2, startupWorst: 2.4, playSeconds: 600, stallSeconds: 18, shownQuality: '1080P',
      lastSuccessAt: ruleAt - 1_000, lastFailureAt: ruleAt - 86_400_000, lastFailureKind: 'probe',
      score: 0, scoredAt: ruleAt - 86_400_000, decayVersion: '1', cooldownUntil: null, lastAlignmentDegrade: null,
    },
  },
  {
    label: 'old-failure',
    entry: {
      sourceKey: 'lzi', success: 0, failure: { catalogue: 0, probe: 5, firstSegment: 0, stall: 0, alignment: 0 },
      startupMedian: null, startupWorst: null, playSeconds: 0, stallSeconds: 0, shownQuality: '720P',
      lastSuccessAt: null, lastFailureAt: ruleAt - 5_184_000_000, lastFailureKind: 'probe',
      score: 0, scoredAt: ruleAt - 5_184_000_000, decayVersion: '1', cooldownUntil: null, lastAlignmentDegrade: null,
    },
  },
  {
    label: 'stalling',
    entry: {
      sourceKey: 'bfzy', success: 8, failure: { catalogue: 0, probe: 0, firstSegment: 0, stall: 2, alignment: 0 },
      startupMedian: 2.4, startupWorst: 3.1, playSeconds: 600, stallSeconds: 108, shownQuality: '720P',
      lastSuccessAt: ruleAt - 3_600_000, lastFailureAt: ruleAt - 600_000, lastFailureKind: 'stall',
      score: 0, scoredAt: ruleAt - 600_000, decayVersion: '1', cooldownUntil: null, lastAlignmentDegrade: null,
    },
  },
  {
    label: 'cooled',
    entry: {
      sourceKey: '360zy', success: 12, failure: { catalogue: 1, probe: 0, firstSegment: 0, stall: 0, alignment: 0 },
      startupMedian: 0.9, startupWorst: 1.6, playSeconds: 900, stallSeconds: 12, shownQuality: '1080P',
      lastSuccessAt: ruleAt - 7_200_000, lastFailureAt: ruleAt - 60_000, lastFailureKind: 'catalogue',
      score: 0, scoredAt: ruleAt - 3_600_000, decayVersion: '1', cooldownUntil: ruleAt + 60_000, lastAlignmentDegrade: null,
    },
  },
  {
    label: 'fresh-strong',
    entry: {
      sourceKey: 'jyzy', success: 30, failure: { catalogue: 0, probe: 0, firstSegment: 0, stall: 0, alignment: 0 },
      startupMedian: 0.8, startupWorst: 1.4, playSeconds: 3_000, stallSeconds: 0, shownQuality: '4K',
      lastSuccessAt: ruleAt - 600_000, lastFailureAt: null, lastFailureKind: null,
      score: 0, scoredAt: ruleAt - 600_000, decayVersion: '1', cooldownUntil: null, lastAlignmentDegrade: null,
    },
  },
];
const healthVectors = {
  configs: { standard: healthConfigStandard, shortHalfLife: healthConfigShortHalfLife },
  at: ruleAt,
  cases: healthEntries.map(({ label, entry }) => ({
    label,
    entry,
    outputs: {
      standard: { score: scoreOf(entry, ruleAt, healthConfigStandard), verdict: verdictOf(entry, ruleAt, healthConfigStandard) },
      shortHalfLife: { score: scoreOf(entry, ruleAt, healthConfigShortHalfLife), verdict: verdictOf(entry, ruleAt, healthConfigShortHalfLife) },
    },
  })),
};

const bufferConfigStandard: ResolvedBufferConfig = {
  startupTargetSec: 4, startupWindowSec: 3, playingLowSec: 6,
  playingRiseWindowSec: 5, seekLowSec: 3, stallPositionSec: 20,
};
const bufferConfigHighWater: ResolvedBufferConfig = { ...bufferConfigStandard, playingLowSec: 8 };
const bufferSamples = {
  startupLow: [{ at: 0, ahead: 0, position: 0 }, { at: 1_000, ahead: 0, position: 0 }],
  startupTimeout: [{ at: 0, ahead: 1, position: 0 }, { at: 3_000, ahead: 2, position: 0 }],
  startupRecovered: [{ at: 0, ahead: 1, position: 0 }, { at: 3_000, ahead: 4, position: 0 }],
  recovering: [{ at: 0, ahead: 2, position: 100 }, { at: 2_000, ahead: 3, position: 102 }, { at: 4_000, ahead: 5, position: 104 }],
  falling: [{ at: 0, ahead: 10, position: 100 }, { at: 2_000, ahead: 8, position: 102 }, { at: 4_000, ahead: 5, position: 104 }],
  flip: [{ at: 0, ahead: 9, position: 100 }, { at: 2_000, ahead: 8, position: 102 }, { at: 4_000, ahead: 7, position: 104 }],
  seekLow: [{ at: 0, ahead: 2, position: 100 }],
  stalled: [{ at: 0, ahead: 20, position: 100 }, { at: 21_000, ahead: 20, position: 100 }],
} satisfies Record<string, BufferSample[]>;
const bufferCases: Array<{ label: string; scene: 'startup' | 'playing' | 'seek'; samples: BufferSample[]; config: 'standard' | 'highWater' }> = [
  { label: 'startup-low', scene: 'startup', samples: bufferSamples.startupLow, config: 'standard' },
  { label: 'startup-timeout', scene: 'startup', samples: bufferSamples.startupTimeout, config: 'standard' },
  { label: 'startup-recovered', scene: 'startup', samples: bufferSamples.startupRecovered, config: 'standard' },
  { label: 'buffered-ending', scene: 'playing', samples: [{ at: 0, position: 84, ahead: 6 }, { at: 1000, position: 85, ahead: 5, bufferedToEnd: true }], config: 'standard' },
  { label: 'stalled-at-buffered-ending', scene: 'playing', samples: [{ at: 0, position: 85, ahead: 5 }, { at: 21000, position: 85, ahead: 5, bufferedToEnd: true }], config: 'standard' },
  { label: 'recovering', scene: 'playing', samples: bufferSamples.recovering, config: 'standard' },
  { label: 'falling', scene: 'playing', samples: bufferSamples.falling, config: 'standard' },
  { label: 'seek-low', scene: 'seek', samples: bufferSamples.seekLow, config: 'standard' },
  { label: 'stalled', scene: 'playing', samples: bufferSamples.stalled, config: 'standard' },
  { label: 'threshold-flip', scene: 'playing', samples: bufferSamples.flip, config: 'highWater' },
];
const bufferVectors = {
  configs: { standard: bufferConfigStandard, highWater: bufferConfigHighWater },
  thresholds: {
    standard: {
      startup: bufferThreshold('startup', bufferConfigStandard),
      playing: bufferThreshold('playing', bufferConfigStandard),
      seek: bufferThreshold('seek', bufferConfigStandard),
    },
    highWater: {
      startup: bufferThreshold('startup', bufferConfigHighWater),
      playing: bufferThreshold('playing', bufferConfigHighWater),
      seek: bufferThreshold('seek', bufferConfigHighWater),
    },
  },
  cases: bufferCases.map(({ label, scene, samples, config }) => ({
    label, scene, samples, config,
    output: shouldTakeOver(scene, samples, config === 'standard' ? bufferConfigStandard : bufferConfigHighWater),
  })),
};

const budgetConfigStandard: ResolvedBudgetConfig = { maxSwitchesPerEpisode: 3, minIntervalSec: 30, failedSourceCooldownSec: 300 };
const budgetConfigTight: ResolvedBudgetConfig = { ...budgetConfigStandard, maxSwitchesPerEpisode: 2 };
const budgetEvents = {
  first: [] as SwitchEvent[],
  limit: [
    { at: ruleAt - 120_000, mode: 'auto' },
    { at: ruleAt - 90_000, mode: 'auto' },
    { at: ruleAt - 60_000, mode: 'auto' },
  ] as SwitchEvent[],
  interval: [{ at: ruleAt - 10_000, mode: 'auto' }] as SwitchEvent[],
  manual: [
    { at: ruleAt - 1_000, mode: 'manual' },
    { at: ruleAt - 2_000, mode: 'manual' },
    { at: ruleAt - 3_000, mode: 'manual' },
  ] as SwitchEvent[],
  tight: [
    { at: ruleAt - 120_000, mode: 'auto' },
    { at: ruleAt - 90_000, mode: 'auto' },
  ] as SwitchEvent[],
};
const budgetCases: Array<{ label: string; events: SwitchEvent[]; config: 'standard' | 'tight' }> = [
  { label: 'first', events: budgetEvents.first, config: 'standard' },
  { label: 'limit', events: budgetEvents.limit, config: 'standard' },
  { label: 'interval', events: budgetEvents.interval, config: 'standard' },
  { label: 'manual', events: budgetEvents.manual, config: 'standard' },
  { label: 'tight-limit', events: budgetEvents.tight, config: 'tight' },
];
const unavailableMark = markUnavailableOnce('b', ruleAt, budgetConfigStandard);
const budgetVectors = {
  configs: { standard: budgetConfigStandard, tight: budgetConfigTight },
  at: ruleAt,
  cases: budgetCases.map(({ label, events, config }) => ({
    label, events, config,
    output: evaluateSwitch(events, ruleAt, config === 'standard' ? budgetConfigStandard : budgetConfigTight),
  })),
  mark: {
    sourceKey: unavailableMark.sourceKey,
    until: unavailableMark.until,
    unavailableAt: ruleAt + 299_000,
    availableAt: ruleAt + 300_000,
    unavailable: isUnavailable(unavailableMark, ruleAt + 299_000),
    available: isUnavailable(unavailableMark, ruleAt + 300_000),
  },
};

const alignmentConfigStandard: ResolvedAlignmentConfig = {
  basisVersion: 'calib-a', ratioTolerance: 0.001, absoluteToleranceSec: 5,
  historyConsistencyRatio: 0.05, workSpreadFactor: 4, windowSeconds: 3,
  sampleLimit: 5, frameBudgetMs: 1_200, similarityThreshold: 0.9,
  offsetTtlDays: 7, takeoverHeadroomFactor: 1.5,
};
const alignmentConfigStrict: ResolvedAlignmentConfig = { ...alignmentConfigStandard, ratioTolerance: 0.0005, absoluteToleranceSec: 1 };
const durationInput = (from: number | null, to: number | null): DurationInput => ({
  fromSeconds: from, fromSource: from === null ? 'missing' : 'hls-extinf',
  toSeconds: to, toSource: to === null ? 'missing' : 'hls-extinf',
});
const emptyDurationHistory: DurationHistory = { sourceSamples: [], workRatios: [] };
const durationCases: Array<{ label: string; input: DurationInput; history: DurationHistory; config: 'standard' | 'strict' }> = [
  { label: 'missing', input: durationInput(1200, null), history: emptyDurationHistory, config: 'standard' },
  { label: 'longer', input: durationInput(1200, 1205), history: emptyDurationHistory, config: 'standard' },
  { label: 'shorter', input: durationInput(1200, 1195), history: emptyDurationHistory, config: 'standard' },
  { label: 'strict-suspect', input: durationInput(1200, 1205), history: emptyDurationHistory, config: 'strict' },
  { label: 'history-conflict', input: durationInput(1200, 1205), history: { sourceSamples: [1200, 1500], workRatios: [] }, config: 'standard' },
  { label: 'work-outlier', input: durationInput(1200, 1210), history: { sourceSamples: [], workRatios: [0.001, 0.001, 0.001] }, config: 'standard' },
];
const similarityCases = [
  { label: 'same', a: { valid: true, hash: 'ffffffffffffffff' }, b: { valid: true, hash: 'ffffffffffffffff' } },
  { label: 'opposite', a: { valid: true, hash: 'ffffffffffffffff' }, b: { valid: true, hash: '0000000000000000' } },
  { label: 'invalid', a: { valid: false, hash: 'ffffffffffffffff' }, b: { valid: true, hash: 'ffffffffffffffff' } },
];
const windowSamples: ScoredSample[] = [
  { offsetSeconds: 0, similarity: 0.2, valid: true },
  { offsetSeconds: 1, similarity: 0.95, valid: true },
  { offsetSeconds: 2, similarity: 0.4, valid: true },
];
const alignmentVectors = {
  configs: { standard: alignmentConfigStandard, strict: alignmentConfigStrict },
  duration: durationCases.map(({ label, input, history, config }) => ({
    label, input, history, config,
    output: durationVerdict(input, history, config === 'standard' ? alignmentConfigStandard : alignmentConfigStrict),
  })),
  offsets: [
    { label: 'delta', input: durationInput(1200, 1205), config: 'standard' },
    { label: 'missing', input: durationInput(1200, null), config: 'standard' },
  ].map(({ label, input, config }) => ({
    label, input, config,
    output: pickOffsets(input, config === 'standard' ? alignmentConfigStandard : alignmentConfigStrict),
  })),
  similarity: similarityCases.map(({ label, a, b }) => ({ label, a, b, output: similarity(a, b) })),
  window: [
    { label: 'best', anchors: [0, 5, -5], samples: windowSamples, elapsedMs: 400, config: 'standard' },
    { label: 'over-budget', anchors: [0], samples: windowSamples.slice(0, 1), elapsedMs: 1_201, config: 'standard' },
    { label: 'no-match', anchors: [0], samples: [{ offsetSeconds: 1, similarity: 0.5, valid: true }], elapsedMs: 100, config: 'standard' },
  ].map(({ label, anchors, samples, elapsedMs, config }) => ({
    label, anchors, samples, elapsedMs, config,
    output: windowSearch(anchors, samples, elapsedMs, config === 'standard' ? alignmentConfigStandard : alignmentConfigStrict),
  })),
};

const vectors = {
  mp4Heads: [
    '', '7b7d', '3c68746d6c3e6f66666c696e653c2f68746d6c3e', '00000000000000000000000000000000',
    '0000001866747970', '000000186674797069736f6d', '000000046674797069736f6d00000000',
    '000000186674797069736f6d0000000069736f6d6d703432',
    '0000000866726565000000186674797069736f6d0000000069736f6d6d703432',
    '000000106d6461740001020304050607', '000000006d64617400010203',
    '0000000166747970000000000000002069736f6d00000000', '0000000177696465ffffffffffffffff',
  ].map(hex => ({ hex, valid: isMp4Head(Buffer.from(hex, 'hex')) })),
  titleSearch: {
    suggestions: [
      [
        { id: '1431683', type: 'movie', url: 'https://movie.douban.com/subject/1431683/?suggest=title' },
        { id: '1431683', type: 'movie', url: 'https://movie.douban.com/subject/1431683/' },
        { id: '2', type: 'celebrity', url: 'https://movie.douban.com/subject/2/' },
        { id: '3', type: 'movie', url: 'https://movie.douban.com.attacker.invalid/subject/3/' },
        { id: '4', type: 'movie', url: 'https://movie.douban.com/subject/5/' },
        { id: '6', type: 'movie', url: 'HTTPS://MOVIE.DOUBAN.COM/subject/6' },
        { type: 'movie', url: 'https://movie.douban.com/subject/1306506/' },
        { type: 'book', url: 'https://book.douban.com/subject/1088065/' },
      ],
      null,
    ].map(value => ({ input: value, ids: suggestedSubjectIds(value) })),
    queries: ['LBXX', 'lbxx', 'L B X X', 'ＣＱＳＬ', 'ZHC', 'AQZC', 'BBSMX', 'ST', 'XSKDJS', '三体', 'x'].map(query => ({ query, initial: initialQuery(query) ?? null, terms: titleIndex.terms(query) })),
    matches: [
      { title: '蜡笔小新', query: 'LBXX' }, { title: '蜡筆小新：剧场版', query: 'lbxx' },
      { title: '蜡笔小新：好别致的影分身', query: 'LBXX' }, { title: '重庆森林', query: 'CQSL' },
      { title: '甄嬛传', query: 'ZHC' }, { title: '阿Q正传', query: 'AQZC' },
      { title: '爱情公寓', query: 'AQGY' }, { title: '海绵宝宝 第十二季', query: 'HMBB' },
      { title: '你好，李焕英', query: 'LHY' }, { title: '星际穿越', query: '蜡笔小新' },
      { title: '蜡笔小新', query: 'lxx' }, { title: 'B超', query: 'BC' },
    ].map(input => ({ ...input, score: Number.isFinite(titleSearchScore(input.title, input.query, initialsDictionary)) ? titleSearchScore(input.title, input.query, initialsDictionary) : null })),
  },
  rules: {
    scoreText: [scoreText(baseItem), scoreText({ ...baseItem, score: undefined }), scoreText({ ...baseItem, score: 0 })],
    statusText: [statusText(baseItem), statusText(filmItem), statusText({ ...filmItem, runtime: undefined })],
    episodeLabel: [episodeLabel(baseItem, 5), episodeLabel({ ...baseItem, unit: '期' }, 3)],
    episodeHeading: [episodeHeading(baseItem, 5), episodeHeading(filmItem, 1)],
    metaParts: [metaParts(baseItem, { region: true, genres: 3 }), metaParts(filmItem, { region: false, genres: 2 })],
    isFinished: [isFinished({ position: 95, duration: 100 }), isFinished({ position: 96, duration: 100 }), isFinished({ position: 0, duration: 0 })],
    progressPercent: [progressPercent(sampleHistory), progressPercent({ position: 0, duration: 0 })],
    progressText: [progressText(baseItem, sampleHistory), progressText(filmItem, finishedHistory)],
    playLabel: [playLabel(baseItem, undefined), playLabel(baseItem, sampleHistory), playLabel(filmItem, finishedHistory)],
    resumePosition: [resumePosition(sampleHistory, 5), resumePosition(sampleHistory, 6), resumePosition(finishedHistory, 1)],
    historyRecord: [historyRecord('db-1', 5, 2600.8, 2700, true), historyRecord('db-1', 5, 120.9, 2700, true), historyRecord('db-1', 30, 2650, 2700, false)],
    episodeRanges: [episodeRanges(50), episodeRanges(125)],
    clock: [clock(0), clock(307), clock(3723), clock(-5)],
    upNextSeconds: [
      upNextSeconds(2690.5, 2700, { hasNext: true, autoNext: true, cancelled: false }),
      upNextSeconds(2680, 2700, { hasNext: true, autoNext: true, cancelled: false }),
      upNextSeconds(2695, 2700, { hasNext: true, autoNext: true, cancelled: true }),
    ],
  },
  normalize: {
    imageUrl: [
      '//img1.doubanio.com/a.jpg',
      'https://img1.doubanio.com.attacker.net/a.jpg',
      'http://user:pass@img1.doubanio.com/a.jpg',
      'ftp://img1.doubanio.com/a.jpg',
    ].map(value => ({ input: value, output: imageUrl(value) })),
    portraitUrl: [
      'https://img1.doubanio.com/view/celebrity/raw/public/p1.jpg',
      'http://img1.doubanio.com/view/celebrity/raw/public/p1.jpg',
      'https://img1.doubanio.com/f/movie/8dd0c794499fe925ae2ae89ee30cd225750457b4/pics/movie/celebrity-default-medium.png',
    ].map(value => ({ input: value, output: portraitUrl(value) })),
    subtitleParts: [
      '2023 / 中国大陆 / 剧情 科幻 / 杨磊 / 张鲁一',
      '中国大陆 / 剧情 科幻 / 杨磊',
      '电视剧 / 日本 / 动画 悬疑',
    ].map(value => ({ input: value, output: subtitleParts(value) })),
    mediaType: [
      { kind: 'tv' as const, genres: ['剧情', '动画'], isShow: false, output: mediaType('tv', ['剧情', '动画'], false) },
      { kind: 'movie' as const, genres: ['历史', '纪录片'], isShow: false, output: mediaType('movie', ['历史', '纪录片'], false) },
      { kind: 'tv' as const, genres: ['音乐'], isShow: true, output: mediaType('tv', ['音乐'], true) },
      { kind: 'movie' as const, genres: ['剧情'], isShow: false, output: mediaType('movie', ['剧情'], false) },
    ],
    normalize: normalizeCases.map(input => ({ input, output: normalize(input) })),
    principalCredits: principalCredits(creditsSample),
    landscapePhoto: landscapePhoto({
      photos: [
        { image: { large: { url: 'https://img1.doubanio.com/small.jpg', width: 500, height: 280 } } },
        { image: { large: { url: 'https://img1.doubanio.com/tall.jpg', width: 900, height: 1200 } } },
        { image: { is_animated: true, large: { url: 'https://img1.doubanio.com/gif.jpg', width: 1280, height: 720 } } },
        { image: { large: { url: 'https://img1.doubanio.com/good.jpg', width: 1280, height: 720 } } },
      ],
    }),
  },
  taxonomy: {
    yearChoices2026: yearChoices(2026),
    yearSpan: ['2026', '2000年代', '90年代', '更早', '1990年代', '1900'].map(input => ({ input, output: yearSpan(input) ?? null })),
    matchesYear: [
      { year: 1994, selected: '90年代', output: matchesYear(1994, '90年代') },
      { year: 2000, selected: '90年代', output: matchesYear(2000, '90年代') },
      { year: 1957, selected: '更早', output: matchesYear(1957, '更早') },
      { year: undefined, selected: '2024', output: matchesYear(undefined, '2024') },
    ],
    matchesRegion: [
      { region: '中国大陆 / 中国香港', selected: '中国香港', output: matchesRegion('中国大陆 / 中国香港', '中国香港') },
      { region: '澳大利亚', selected: '欧美', output: matchesRegion('澳大利亚', '欧美') },
      { region: undefined, selected: '美国', output: matchesRegion(undefined, '美国') },
    ],
    genreCounts: Object.fromEntries(Object.entries(GENRES).map(([k, v]) => [k, v.length])),
    regionCounts: Object.fromEntries(Object.entries(REGIONS).map(([k, v]) => [k, v.length])),
  },
  hotSearch: {
    movie: hotQueries(hotRaw, 'movie'),
    combined: combineHotQueries([[{ title: '电影甲', score: 500 }], [{ title: '剧集乙', score: 600 }, { title: '电影甲', score: 200 }]]),
  },
  service: {
    normalizedTitle: ['空枪粤语', '肖申克的救赎（国语版）', '三体\u200b'].map(input => ({ input, output: normalizedTitle(input) })),
    titleKey: ['现在就出发 第二季', '现在就出发第2季', '一饭封神2', '怪奇物语 第十二季', '披荆斩棘2026', '1917', '空枪粤语'].map(input => ({ input, output: titleKey(input) })),
    classifySourceType: ['剧情片', '国产剧', '大陆综艺', '国产动漫', '纪录片', '记录片', '脑洞悬疑'].map(input => ({ input, output: classifySourceType(input) ?? null })),
    episodeRange: ['凡人修仙传 第177-228集', '吞噬星空131-156集', '凡人修仙传 第153～176集', '第1-12集', '凡人修仙传 第第五季'].map(input => ({ input, output: episodeRange(input) ?? null })),
    runOf: {
      slice200: runOf(serialNumbered, { name: '凡人修仙传', first: 177, last: 228 })!.episodes.map(e => ({ title: e.title, number: e.number, url: e.url })),
      extras263: runOf(serialWithExtras, { name: '斗罗大陆1', first: 235, last: 263 })!.episodes.map(e => ({ title: e.title, number: e.number })),
    },
    matchRecord: [
      ...['美国', '内地', '香港', '中国香港 / 中国大陆', '', '欧美'].map(area => {
        const raw = { vod_name: '三体第一季', vod_year: '2023–', type_name: '欧美剧', vod_area: area };
        return { item: baseItem, raw, hints: {}, output: matchRecord(baseItem, raw) ?? null };
      }),
      { item: run4, raw: { vod_name: '凡人修仙传', vod_year: '2020', type_name: '国产动漫' }, hints: run4Hints, output: matchRecord(run4, { vod_name: '凡人修仙传', vod_year: '2020', type_name: '国产动漫' }, run4Hints) ?? null },
      { item: run4, raw: { vod_name: '凡人修仙传 慕兰之战', vod_year: '2026', type_name: '国产动漫' }, hints: run4Hints, output: matchRecord(run4, { vod_name: '凡人修仙传 慕兰之战', vod_year: '2026', type_name: '国产动漫' }, run4Hints) ?? null },
      { item: { ...filmItem, year: 2025, title: '生日快乐' }, raw: { vod_name: '生日快乐', vod_year: '2007', type_name: '爱情片' }, hints: {}, output: matchRecord({ ...filmItem, year: 2025, title: '生日快乐' }, { vod_name: '生日快乐', vod_year: '2007', type_name: '爱情片' }) ?? null },
      { item: { id: 'db-9', title: '生命奇观', year: 2023, type: 'doc' as const, poster: null, backdrop: null, genres: [] }, raw: { vod_name: '生命奇观', vod_year: '2024', type_name: '记录片' }, hints: {}, output: matchRecord({ id: 'db-9', title: '生命奇观', year: 2023, type: 'doc', poster: null, backdrop: null, genres: [] }, { vod_name: '生命奇观', vod_year: '2024', type_name: '记录片' }) ?? null },
      ...['伦理片', '港台三级', '里番动漫', '福利', '爱情片'].map(shelf => ({ item: { ...filmItem, title: '生日快乐', year: 2007 }, raw: { vod_name: '生日快乐', vod_year: '2007', type_name: shelf }, hints: {}, output: matchRecord({ ...filmItem, title: '生日快乐', year: 2007 }, { vod_name: '生日快乐', vod_year: '2007', type_name: shelf }) ?? null })),
    ],
    adultShelf: ['伦理片', '倫理片', '韩国伦理', '港台三级', '里番动漫', '福利', '写真', '成人动漫', 'AV', 'av解说', '爱情片', '剧情片', '国产动漫', '日韩动漫', 'MV', '纪录片', '大陆综艺', '家庭剧', ''].map(input => ({ input, output: adultShelf(input) })),
    searchTerms: ['现在就出发 第二季', 'Doctor X：白色黑手党时代', '1917'].map(input => ({ input, output: searchTerms(input) })),
    workTerms: workTerms('凡人修仙传 年番4', run4Hints.aliases),
    parseLines: parseLines('dyttm3u8$$$yun123$$$dytt', '第01集$https://a.com/1.m3u8#第30集已完结$https://a.com/30.m3u8#第240集上$https://a.com/240a.m3u8#预告$https://a.com/t.m3u8$$$x$https://y.com/1.m3u8$$$HD$//b.com/v.mp4'),
    mirrorLines: (() => {
      const input = '彩蛋$https://e/bonus.mp4#第01集$https://e/a1.mp4#第01集$https://e/a1.mp4#第01集$https://e/b1.mp4#第02集$https://e/a2.mp4';
      return { input, output: parseLines('mp4', input) };
    })(),
    numbering: [
      numbering(parseLines('m', '第01集$https://e/1.m3u8#第04集$https://e/4.m3u8')[0]!),
      numbering(parseLines('m', '20241019$https://e/1.m3u8#20241024$https://e/2.m3u8')[0]!),
      numbering(parseLines('m', '第01集$https://e/1.m3u8#特别篇01$https://e/2.m3u8')[0]!),
    ].map(n => ({ numeric: n.numeric, titled: n.titled, count: n.count, keys: [...n.byNumber.keys()] })),
    issueKey: ['第20251025期上', '20251025(上)', '第20260104期特别加更', '先导片上'].map(input => ({ input, output: issueKey(input) })),
    sameIssue: [
      { wanted: '第20251025期', found: sameIssue(varietyRef.episodes[3]!, varietyRef, varietyOther)?.title ?? null },
      { wanted: '第20260104期特别加更', found: sameIssue(varietyRef.episodes[5]!, varietyRef, varietyOther)?.title ?? null },
      { wanted: '先导片上', found: sameIssue(varietyRef.episodes[0]!, varietyRef, varietyOther)?.title ?? null },
    ],
    manifestVariants: manifestVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttp://[bad\n#EXT-X-STREAM-INF:BANDWIDTH=1500\njavascript:alert(1)\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n720/index.m3u8\n', new URL('https://cdn.example/master.m3u8')),
    referenceLine: (() => {
      const l1 = parseLines('m', Array.from({ length: 12 }, (_, i) => `第${i + 1}集$https://e/${i}.m3u8`).join('#'))[0]!;
      const l2 = parseLines('m', [...Array.from({ length: 12 }, (_, i) => `第${i + 1}集`), '第特别篇01集'].map((t, i) => `${t}$https://e/${i}.m3u8`).join('#'))[0]!;
      return referenceLine([l2, l1]) === l1;
    })(),
    rank: rank([
      { source: { priority: 90 }, lines: [serialNumbered], dubbed: true, weak: false },
      { source: { priority: 50 }, lines: [serialNumbered], dubbed: false, weak: true },
      { source: { priority: 82 }, lines: [serialNumbered], dubbed: false, weak: false },
      { source: { priority: 95 }, lines: [serialNumbered], dubbed: false, weak: false },
    ]).map(r => ({ priority: r.source.priority, dubbed: r.dubbed, weak: r.weak })),
  },
  filter: {
    fixtures: (['dyttzy-0', 'dyttzy-2', 'ffzy-1', 'lzi-0', 'bfzy-0', 'bfzy-3', 'bfzy-4', '360zy-0', '360zy-2', 'jyzy-0', 'lzi-3'] as const).map(name => {
      const sourceKey = name.replace(/-\d+$/, '');
      const text = fixtureManifest(name);
      const result = filterPlaylist(text, playlistBase, sourceOf(sourceKey), rulesConfig);
      return { name, sourceKey, removedSegments: result.removedSegments, removedSeconds: result.removedSeconds, reason: result.reason, evidence: result.evidence ?? [] };
    }),
    cases: [
      { label: 'cue', sourceKey: 'lzi', maxDropRatio: 0.15, foreignMax: 60, preserve: false, text: cuePlaylist },
      { label: 'implicit-iv', sourceKey: '360zy', maxDropRatio: 0.15, foreignMax: 60, preserve: false, text: implicitIvPlaylist },
      { label: 'explicit-iv', sourceKey: '360zy', maxDropRatio: 0.15, foreignMax: 60, preserve: false, text: explicitIvPlaylist },
      { label: 'ad-block-too-long', sourceKey: 'lzi', maxDropRatio: 0.15, foreignMax: 60, preserve: false, text: longAdBlockPlaylist },
      { label: 'short-playlist', sourceKey: 'lzi', maxDropRatio: 0.15, foreignMax: 60, preserve: false, text: shortPlaylist },
      { label: 'safety-limit', sourceKey: 'ffzy', maxDropRatio: 0.001, foreignMax: 60, preserve: false, text: fixtureManifest('ffzy-1') },
      { label: 'synchronized-tracks', sourceKey: 'ffzy', maxDropRatio: 0.15, foreignMax: 60, preserve: hasSynchronizedTracks(syncTracksPlaylist), text: syncTracksPlaylist },
    ].map(c => {
      const r = filterPlaylist(c.text, playlistBase, sourceOf(c.sourceKey), { ...rulesConfig, maxDropRatio: c.maxDropRatio, foreignBlockMaxSeconds: c.foreignMax }, c.preserve);
      return { ...c, expected: { removedSegments: r.removedSegments, removedSeconds: r.removedSeconds, reason: r.reason, evidence: r.evidence ?? [] } };
    }),
  },
  delivery: {
    margin: [
      { seconds: 10, length: 2_000, received: 800, elapsedMs: 160, complete: false },
      { seconds: 0.05, length: 2_000, received: 1_600, elapsedMs: 160, complete: false },
      { seconds: 10, length: 2_000, received: 2_000, elapsedMs: 800, complete: true },
      { seconds: 10, length: undefined, received: 2_000, elapsedMs: 800, complete: true },
      { seconds: 10, length: undefined, received: 800, elapsedMs: 160, complete: false },
      { seconds: undefined, length: 2_000, received: 800, elapsedMs: 160, complete: false },
      { seconds: 0, length: 2_000, received: 800, elapsedMs: 160, complete: true },
    ].map(input => ({ input, output: playbackMargin(input.seconds, input.length, input.received, input.elapsedMs, input.complete) ?? null })),
    choices: [
      { a: { picture: 3, margin: 0.8 }, b: { picture: 1, margin: 2 } },
      { a: { picture: 3, margin: 2 }, b: { picture: 1, margin: 10 } },
      { a: { picture: 3, margin: 0.4 }, b: { picture: 1, margin: 0.9 } },
      { a: { picture: 3 }, b: { picture: 1, margin: 2 } },
      { a: { picture: 3 }, b: { picture: 1, margin: 0.9 } },
      { a: { picture: 3, margin: 2 }, b: { picture: 3, margin: 2 } },
    ].map(input => ({ ...input, output: Math.sign(compareDelivery(input.a, input.b)) })),
    sourceOrder: [
      { label: 'work-backoff', a: { behind: true, previous: false, winner: false }, b: { behind: false, previous: false, winner: false }, retry: false },
      { label: 'previous-episode-winner', a: { behind: false, previous: false, winner: false }, b: { behind: false, previous: false, winner: true }, retry: false },
      { label: 'retry-uses-an-alternative', a: { behind: false, previous: true, winner: true }, b: { behind: false, previous: false, winner: false }, retry: true },
    ].map(input => ({ ...input, output: Math.sign(compareSourceOrder(input.a, input.b, input.retry)) })),
  },
  picture: {
    heads: segmentHeads.heads.map(h => ({ source: h.source, title: h.title, head: h.head, expected: pictureOf(Buffer.from(h.head, 'base64')) ?? null })),
    nonTsExpected: pictureOf(Buffer.from('<html>not a segment</html>')) ?? null,
    encrypted: {
      keyHex: aesKey.toString('hex'),
      ivHex: aesIv.toString('hex'),
      sealedBase64: sealedSample.subarray(0, 8193).toString('base64'),
      expectedPicture: pictureOf(clearHead(sealedSample.subarray(0, 8193), aesKey, aesIv)) ?? null,
      shortLength: clearHead(sealedSample.subarray(0, 10), aesKey, aesIv).length,
    },
  },
  health: healthVectors,
  buffer: bufferVectors,
  budget: budgetVectors,
  alignment: alignmentVectors,
};

const outPath = resolve(root, 'tv/app/src/test/resources/golden-vectors.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(vectors, null, 2), 'utf8');
console.log('Wrote golden-vectors.json bytes:', readFileSync(outPath).length);
