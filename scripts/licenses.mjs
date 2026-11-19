import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const packages = Object.entries(lock.packages).filter(([name, info]) => name && !info.dev)
const output = join(root, 'resources/licenses')
await mkdir(output, { recursive: true })
const inventory = []
for (const [location, info] of packages) {
  const directory = join(root, location)
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const files = (await readdir(directory)).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE|OFL)(?:\.|$)/i.test(name))
  const folder = pkg.name.replace(/[^a-z0-9.-]/gi, '_')
  await mkdir(join(output, folder), { recursive: true })
  for (const file of files) await copyFile(join(directory, file), join(output, folder, file))
  if (!files.length) throw new Error(`Missing license text: ${pkg.name}`)
  inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? info.license, files: files.map(file => `licenses/${folder}/${file}`) })
}
const electronPkg = JSON.parse(await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'))
await mkdir(join(output, 'electron'), { recursive: true })
await copyFile(join(root, 'node_modules/electron/dist/LICENSE'), join(output, 'electron/LICENSE'))
inventory.push({ name: 'electron', version: electronPkg.version, license: electronPkg.license, files: ['licenses/electron/LICENSE'] })
await writeFile(join(root, 'resources/dependency-licenses.json'), JSON.stringify(inventory, null, 2))
console.log(`Verified ${inventory.length} runtime dependency licenses`)
