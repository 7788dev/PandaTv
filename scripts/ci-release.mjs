import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionPattern = /^\d+\.\d+\.\d+$/;

export function metadata(directory, tag = '') {
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  const gradle = readFileSync(join(directory, 'tv/app/build.gradle.kts'), 'utf8');
  const wrapper = readFileSync(join(directory, 'tv/gradle/wrapper/gradle-wrapper.properties'), 'utf8');
  const match = (pattern, text, label) => {
    const value = text.match(pattern)?.[1];
    if (!value) throw new Error(`Missing ${label}`);
    return value;
  };
  const values = {
    desktop_version: pkg.version,
    tv_version: match(/versionName\s*=\s*"([^"]+)"/, gradle, 'TV version'),
    tv_version_code: match(/versionCode\s*=\s*(\d+)/, gradle, 'TV versionCode'),
    compile_sdk: match(/compileSdk\s*=\s*(\d+)/, gradle, 'compileSdk'),
    build_tools: match(/buildToolsVersion\s*=\s*"([\d.]+)"/, gradle, 'buildToolsVersion'),
    gradle_version: match(/gradle-([\d.]+)-bin\.zip/, wrapper, 'Gradle version'),
  };
  // API 37+ SDK package IDs include the minor version (verified with sdkmanager --list).
  values.sdk_platform = `android-${values.compile_sdk}${Number(values.compile_sdk) >= 37 ? '.0' : ''}`;
  if (!versionPattern.test(values.desktop_version) || !versionPattern.test(values.tv_version)) throw new Error('Expected stable x.y.z desktop and TV versions');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('package.json and package-lock.json versions differ');
  if (tag && tag !== `v${pkg.version}`) throw new Error(`Release tag must be v${pkg.version}; received ${tag}`);
  return values;
}

// java.util.Properties reads ISO-8859-1 and treats backslashes as escapes.
export function propertyValue(value) {
  return String(value).split('').map(character => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    if ('\\ :=#!'.includes(character)) return '\\' + character;
    const code = character.charCodeAt(0);
    return code > 126 || code < 32 ? '\\u' + code.toString(16).padStart(4, '0') : character;
  }).join('');
}

export function prepareSigning(directory, environment) {
  const keys = ['TV_KEYSTORE_BASE64', 'TV_STORE_PASSWORD', 'TV_KEY_ALIAS', 'TV_KEY_PASSWORD'];
  if (keys.some(key => !environment[key])) throw new Error('All four TV signing secrets are required for a release');
  const properties = join(directory, 'tv/keystore.properties');
  const keyFile = join(directory, 'tv/.keystore/ci-release.jks');
  if (existsSync(properties) || existsSync(keyFile)) throw new Error('Refusing to overwrite existing signing files');
  const encoded = environment.TV_KEYSTORE_BASE64.replace(/\s/g, '');
  const key = Buffer.from(encoded, 'base64');
  if (!key.length || key.toString('base64') !== encoded) throw new Error('TV_KEYSTORE_BASE64 is invalid');
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
  const entries = {
    storeFile: '.keystore/ci-release.jks',
    storePassword: environment.TV_STORE_PASSWORD,
    keyAlias: environment.TV_KEY_ALIAS,
    keyPassword: environment.TV_KEY_PASSWORD,
  };
  writeFileSync(properties, Object.entries(entries).map(([key, value]) => `${key}=${propertyValue(value)}\n`).join(''), { mode: 0o600, flag: 'wx' });
}

export function cleanSigning(directory) {
  const properties = join(directory, 'tv/keystore.properties');
  // Never delete an existing developer key or configuration, even after a failed prepare.
  if (existsSync(properties) && readFileSync(properties, 'utf8').startsWith('storeFile=.keystore/ci-release.jks\n')) {
    rmSync(properties);
    rmSync(join(directory, 'tv/.keystore/ci-release.jks'), { force: true });
  }
}

export function packageNames(values, signed = true) {
  return [`Panda-${values.desktop_version}-Setup.exe`, `Panda-TV-${values.tv_version}${signed ? '' : '-unsigned'}.apk`];
}

export function checksums(directory, values) {
  const expected = packageNames(values);
  const actual = readdirSync(directory).filter(name => name !== 'SHA256SUMS.txt').sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('A release must contain exactly the Windows installer and the signed TV APK');
  const lines = expected.map(name => {
    const data = readFileSync(join(directory, name));
    if (!data.length) throw new Error(`Empty release artifact: ${name}`);
    return `${createHash('sha256').update(data).digest('hex')}  ${name}\n`;
  }).join('');
  writeFileSync(join(directory, 'SHA256SUMS.txt'), lines);
  return lines;
}

function main(command) {
  const values = metadata(root, process.env.PANDA_RELEASE_TAG || '');
  const output = join(root, '.tmp/ci-dist');
  switch (command) {
    case 'prepare': {
      if (!process.env.GITHUB_ACTIONS) throw new Error('Registry preparation is limited to GitHub Actions');
      // Keep local mirrors intact; hosted runners use upstream registries with the same lockfile integrity hashes.
      const lockFile = join(root, 'package-lock.json');
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      for (const item of Object.values(lock.packages)) {
        if (item.resolved?.startsWith('https://registry.npmmirror.com/')) item.resolved = item.resolved.replace('https://registry.npmmirror.com/', 'https://registry.npmjs.org/');
      }
      writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
      writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
      const settings = join(root, 'tv/settings.gradle.kts');
      writeFileSync(settings, readFileSync(settings, 'utf8').replace(/^.*maven\.aliyun\.com.*\r?\n/gm, ''));
      mkdirSync(join(root, '.tmp'), { recursive: true });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
      console.log(JSON.stringify(values));
      break;
    }
    case 'prepare-signing':
      prepareSigning(root, process.env);
      console.log('TV release signing files restored (credentials omitted)');
      break;
    case 'clean-signing':
      cleanSigning(root);
      break;
    case 'collect-windows':
    case 'collect-tv': {
      const signed = process.env.PANDA_SIGNED_TV === 'true';
      const windows = command === 'collect-windows';
      const name = packageNames(values, signed)[windows ? 0 : 1];
      const source = windows ? join(root, 'release', name) : join(root, 'tv/app/build/outputs/apk/release', signed ? 'app-release.apk' : 'app-release-unsigned.apk');
      mkdirSync(output, { recursive: true });
      copyFileSync(source, join(output, name));
      console.log(`Collected ${name}`);
      break;
    }
    case 'checksums':
      console.log(checksums(output, values));
      break;
    default:
      throw new Error(`Unknown CI release command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]);
