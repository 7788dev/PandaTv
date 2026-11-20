const asar = require('@electron/asar')
const file = process.argv[2]
const entries = asar.listPackage(file)
const bad = entries.filter(e => /node_modules|[\/]design[\/](mock|art|preview)|fixtures|[\/]tests[\/]|[\/]e2e[\/]|[\/]scripts[\/]|\.map$|\.tmp/.test(e))
console.log(`asar entries: ${entries.length}; node_modules / design mock·art·preview / fixtures / tests / e2e / scripts / source maps / .tmp: ${bad.length}`)
if (bad.length) {
  console.error(bad.join('\n'))
  process.exitCode = 1
}
const titles = asar.extractFile(file, 'resources/search-titles.tsv').toString('utf8')
const initials = JSON.parse(asar.extractFile(file, 'resources/search-initials.json').toString('utf8'))
if (!titles.startsWith('# Panda title index v1') || initials.version !== 1) throw new Error('Packaged title search resources are invalid')
console.log(`title search resources: ${Buffer.byteLength(titles)} bytes; dictionary v${initials.version}`)
