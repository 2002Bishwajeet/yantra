import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The prompts cannot run without a live build loop, so this pins the Y-611 wording that stops a gate agent parking early.
const src = readFileSync(new URL('./build-rows.js', import.meta.url), 'utf8')
const constant = (name) => {
  const line = src.split('\n').find((l) => l.startsWith(`const ${name} = `))
  assert.ok(line, `${name} not found`)
  return line
}

test('gate agents wait for the GATE_EXIT sentinel', () => {
  const how = constant('GATE_HOW')
  assert.match(how, /GATE_EXIT=\$\?/)
  assert.match(how, /grep -q '\^GATE_EXIT='/)
  assert.match(how, /1800000/)
  assert.match(how, /Report nothing until that line exists/)
})

test('a failure outside the diff that passes alone is a retry', () => {
  const flaky = constant('FLAKY')
  assert.match(flaky, /rerun each failing test alone/)
  assert.match(flaky, /git diff --name-only origin\/main\.\.\.HEAD/)
  assert.match(flaky, /passes alone/)
})

test('both gate prompts include both rules', () => {
  const gateAgents = src.match(/\$\{GATE_HOW\}/g) ?? []
  assert.equal(gateAgents.length, 2)
  assert.equal((src.match(/\$\{FLAKY\}/g) ?? []).length, 2)
})
