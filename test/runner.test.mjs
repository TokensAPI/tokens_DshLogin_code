import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCases, evaluateCases } from './run-test-cases.mjs'

const header = '用例编号,所属模块,用例标题,前置条件,测试数据,操作步骤,预期结果,优先级,自动化状态,对应测试\n'
const row = 'LOGIN-001,模块,标题,前提,数据,步骤,预期,P1,已自动化,test/host.test.mjs :: named test\n'

test('case runner parses quoted CSV fields and rejects duplicate IDs and incomplete mappings', () => {
  assert.equal(parseCases(header + row.replace('标题', '"标题,含逗号"'))[0]['用例标题'], '标题,含逗号')
  assert.throws(() => parseCases(header + row + row), /duplicate/u)
  assert.throws(() => parseCases(header + row.replace('已自动化', '待自动化')), /incomplete/u)
  assert.throws(() => parseCases(header + row.replace('test/host.test.mjs', '../outside.test.mjs')), /invalid mapping/u)
  assert.throws(() => parseCases(header), /No functional cases/u)
})

test('case runner does not pass missing failed skipped or TODO tests', () => {
  const cases = parseCases(header + row)
  for (const result of [undefined, { passed: false, reason: 'failed' }, { passed: false, reason: 'skipped/TODO' }]) {
    const results = new Map(result ? [['test/host.test.mjs :: named test', result]] : [])
    assert.equal(evaluateCases(cases, results)[0].errors.length, 1)
  }
  assert.equal(evaluateCases(cases, new Map([['test/host.test.mjs :: named test', { passed: true }]]))[0].errors.length, 0)
})

test('case runner requires every mapped test of a multi-test case to pass', () => {
  const cases = parseCases(header + row.replace('named test', 'named test | test/host.test.mjs :: another test'))
  const results = new Map([['test/host.test.mjs :: named test', { passed: true }]])
  assert.equal(evaluateCases(cases, results)[0].errors.length, 1)
  results.set('test/host.test.mjs :: another test', { passed: true })
  assert.equal(evaluateCases(cases, results)[0].errors.length, 0)
})
