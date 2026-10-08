import { run } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const root = dirname(directory)
const headers = ['用例编号', '所属模块', '用例标题', '前置条件', '测试数据', '操作步骤', '预期结果', '优先级', '自动化状态', '对应测试']

export function parseCases(source) {
  const rows = []
  let row = [], field = '', quoted = false
  source = source.replace(/^\uFEFF/u, '')
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n') { row.push(field.replace(/\r$/u, '')); rows.push(row); row = []; field = '' }
    else field += char
  }
  if (quoted) throw new Error('Unclosed CSV quote')
  if (field || row.length) { row.push(field.replace(/\r$/u, '')); rows.push(row) }
  if (JSON.stringify(rows.shift()) !== JSON.stringify(headers)) throw new Error('Incorrect case CSV headers')
  const seen = new Set()
  const cases = rows.filter(row => row.some(Boolean)).map(row => {
    if (row.length !== headers.length) throw new Error('Incorrect CSV column count')
    const item = Object.fromEntries(headers.map((header, index) => [header, row[index]]))
    const id = item['用例编号']
    if (!id || seen.has(id)) throw new Error('Missing or duplicate case ID: ' + id)
    seen.add(id)
    if (item['自动化状态'] !== '已自动化') throw new Error(id + ': incomplete automation')
    item.references = item['对应测试'].split(' | ')
    for (const reference of item.references) {
      if (!/^test\/[\w-]+\.test\.mjs :: .+$/u.test(reference)) throw new Error(id + ': invalid mapping ' + reference)
    }
    return item
  })
  if (!cases.length) throw new Error('No functional cases')
  return cases
}

export function evaluateCases(cases, results) {
  return cases.map(item => ({ id: item['用例编号'], errors: item.references.flatMap(reference => {
    const result = results.get(reference)
    return result?.passed ? [] : [reference + ': ' + (result?.reason ?? 'missing test / not executed')]
  }) }))
}

async function main() {
  const cases = parseCases(readFileSync(join(directory, 'test_cases.csv'), 'utf8'))
  const files = [...new Set(cases.flatMap(item => item.references.map(reference => reference.split(' :: ')[0])))]
  const results = new Map()
  let failedTests = 0
  for await (const event of run({ files: files.map(file => join(root, file)), isolation: 'process' })) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue
    const data = event.data
    const file = data.file ? relative(root, resolve(data.file)).replaceAll('\\', '/') : ''
    const passed = event.type === 'test:pass' && !data.skip && !data.todo
    const reason = data.skip || data.todo ? 'skipped/TODO'
      : String(data.details?.error?.cause?.stack ?? data.details?.error?.message ?? 'test failed')
    const key = file + ' :: ' + data.name
    if (results.has(key)) throw new Error('Ambiguous duplicate test name: ' + key)
    results.set(key, { passed, reason })
    if (!passed) { failedTests++; console.error(key + '\n' + reason) }
  }
  const evaluated = evaluateCases(cases, results)
  const failures = evaluated.filter(item => item.errors.length)
  const passedCases = cases.length - failures.length
  for (const failure of failures) console.error(failure.id + '\n' + failure.errors.join('\n'))
  console.log(`${passedCases}/${cases.length} cases passed; ${failures.length || failedTests ? 'failed/incomplete' : 'all passed'}.`)
  process.exitCode = failures.length || failedTests ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
