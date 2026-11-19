const asar = require('@electron/asar')
const file = process.argv[2]
const entries = asar.listPackage(file)
const bad = entries.filter(e => /node_modules|[\/]design[\/](mock|art|preview)|fixtures|[\/]tests[\/]|[\/]e2e[\/]|[\/]scripts[\/]|\.map$|\.tmp/.test(e))
console.log(`asar entries: ${entries.length}; node_modules / design mock·art·preview / fixtures / tests / e2e / scripts / source maps / .tmp: ${bad.length}`)
