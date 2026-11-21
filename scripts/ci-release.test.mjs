import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { metadata, propertyValue, prepareSigning, cleanSigning, packageNames, checksums } from './ci-release.mjs';

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'panda-release-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('metadata matches independent desktop / TV versions and the release tag', () => {
  const values = metadata(resolve('.'));
  assert.ok(values.tv_version_code);
  assert.ok(values.gradle_version);
  assert.deepEqual(metadata(resolve('.'), `v${values.desktop_version}`), values);
  assert.throws(() => metadata(resolve('.'), 'v0.0.0'), /Release tag must be/);
  assert.throws(() => metadata(resolve('.'), 'v1.2.3; echo unsafe'), /Release tag must be/);
});

test('signing requires all secrets and rejects malformed base64 without creating files', t => {
  const directory = temporary(t);
  const environment = { TV_KEYSTORE_BASE64: 'bad!', TV_STORE_PASSWORD: 'store', TV_KEY_ALIAS: 'alias', TV_KEY_PASSWORD: 'key' };
  assert.throws(() => prepareSigning(directory, {}), /four TV signing secrets/);
  assert.throws(() => prepareSigning(directory, environment), /invalid/);
  assert.deepEqual(readdirSync(directory), []);
});

test('signing properties preserve special characters and are cleaned after use', t => {
  const directory = temporary(t);
  const environment = { TV_KEYSTORE_BASE64: Buffer.from('test key').toString('base64'), TV_STORE_PASSWORD: ' leading:=!#\\\n中文', TV_KEY_ALIAS: 'panda', TV_KEY_PASSWORD: 'key' };
  prepareSigning(directory, environment);
  assert.equal(readFileSync(join(directory, 'tv/.keystore/ci-release.jks'), 'utf8'), 'test key');
  assert.ok(readFileSync(join(directory, 'tv/keystore.properties'), 'utf8').includes(`storePassword=${propertyValue(environment.TV_STORE_PASSWORD)}\n`));
  assert.equal(propertyValue(' 中文\\\n'), '\\ \\u4e2d\\u6587\\\\\\n');
  cleanSigning(directory);
  assert.equal(existsSync(join(directory, 'tv/keystore.properties')), false);
  assert.equal(existsSync(join(directory, 'tv/.keystore/ci-release.jks')), false);
});

test('preparing or cleaning CI signing never replaces a developer configuration', t => {
  const directory = temporary(t);
  mkdirSync(join(directory, 'tv'), { recursive: true });
  writeFileSync(join(directory, 'tv/keystore.properties'), 'storeFile=.keystore/release.jks\n');
  mkdirSync(join(directory, 'tv/.keystore'), { recursive: true });
  writeFileSync(join(directory, 'tv/.keystore/ci-release.jks'), 'existing key');
  const environment = { TV_KEYSTORE_BASE64: 'dGVzdA==', TV_STORE_PASSWORD: 'store', TV_KEY_ALIAS: 'alias', TV_KEY_PASSWORD: 'key' };
  assert.throws(() => prepareSigning(directory, environment), /overwrite/);
  cleanSigning(directory);
  assert.equal(readFileSync(join(directory, 'tv/keystore.properties'), 'utf8'), 'storeFile=.keystore/release.jks\n');
  assert.equal(readFileSync(join(directory, 'tv/.keystore/ci-release.jks'), 'utf8'), 'existing key');
});

test('unsigned CI APK cannot pass the release artifact gate', t => {
  const directory = temporary(t);
  const values = { desktop_version: '1.2.3', tv_version: '4.5.6' };
  for (const name of packageNames(values, false)) writeFileSync(join(directory, name), 'test');
  assert.throws(() => checksums(directory, values), /signed TV APK/);
});

test('release requires both nonempty packages and hashes the exact bytes', t => {
  const directory = temporary(t);
  const values = { desktop_version: '1.2.3', tv_version: '4.5.6' };
  const [windows, tv] = packageNames(values);
  writeFileSync(join(directory, windows), 'abc');
  assert.throws(() => checksums(directory, values), /exactly/);
  writeFileSync(join(directory, tv), '');
  assert.throws(() => checksums(directory, values), /Empty/);
  writeFileSync(join(directory, tv), 'abc');
  const output = checksums(directory, values);
  assert.ok(output.includes(`ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  ${windows}\n`));
  assert.equal(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8'), output);
  assert.equal(checksums(directory, values), output);
});
