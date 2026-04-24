#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const checks = [];

async function fileExists(relativePath) {
  try {
    await access(join(repoRoot, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function read(relativePath) {
  return readFile(join(repoRoot, relativePath), 'utf8');
}

function record(ok, label, detail) {
  checks.push({ ok, label, detail });
}

async function expectFile(relativePath, label) {
  const ok = await fileExists(relativePath);
  record(ok, label, ok ? relativePath : `missing: ${relativePath}`);
}

async function expectIncludes(relativePath, needle, label) {
  try {
    const content = await read(relativePath);
    const ok = content.includes(needle);
    record(ok, label, ok ? `${relativePath} includes ${JSON.stringify(needle)}` : `${relativePath} is missing ${JSON.stringify(needle)}`);
  } catch (error) {
    record(false, label, `${relativePath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function expectMatch(relativePath, pattern, label) {
  try {
    const content = await read(relativePath);
    const ok = pattern.test(content);
    record(ok, label, ok ? `${relativePath} matches ${pattern}` : `${relativePath} does not match ${pattern}`);
  } catch (error) {
    record(false, label, `${relativePath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await expectFile('docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md', 'milestone doc exists');
await expectFile('docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md', 'QA checklist exists');
await expectFile('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'operator runbook exists');

await expectIncludes('package.json', '"verify:paper-safe"', 'package.json exposes the paper-safe verification command');
await expectIncludes('README.md', 'docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md', 'README links to the milestone doc');
await expectIncludes('README.md', 'docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md', 'README links to the QA checklist');
await expectIncludes('README.md', 'docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'README links to the operator runbook');

await expectMatch(
  'packages/config/src/index.ts',
  /WRAITH_CONTROL_TOKEN:\s*z\.string\(\)\.min\(16/,
  'control token minimum length is enforced'
);
await expectIncludes('packages/contracts/src/index.ts', "runtimeModeSchema = z.enum(['simulation', 'paper', 'live-disarmed'])", 'runtime contract supports simulation/paper/live-disarmed only');
await expectMatch('packages/config/src/index.ts', /WRAITH_RUNTIME_MODE:\s*runtimeModeSchema\.default\('paper'\)/, 'runtime config defaults to paper mode');
await expectIncludes('apps/api/src/runtime-store.ts', 'mode: config.runtimeMode', 'runtime store uses parsed runtime mode');
await expectIncludes('apps/api/src/runtime-store.ts', "label: 'Paper mode only'", 'runtime watchlist still advertises paper-only mode');
await expectIncludes('apps/api/src/runtime-store.ts', 'Live trading remains disarmed by design.', 'runtime event log still documents live-disarmed posture');
await expectIncludes('apps/api/src/runtime-store.ts', 'Live execution intentionally not implemented in milestone 1.', 'execution module remains blocked in the bootstrap runtime');
await expectIncludes('packages/ledger/README.md', 'append-only paper ledger', 'ledger placeholder still calls for append-only paper truth');
await expectIncludes('docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md', 'It does **not** mean:', 'milestone doc includes explicit non-goals');
await expectIncludes('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'This repo is not live-trading ready.', 'operator runbook includes explicit live-trading warning');

const passed = checks.filter((check) => check.ok).length;
const failed = checks.length - passed;

console.log('Paper-safe static verification');
console.log('==============================');
for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`);
  console.log(`      ${check.detail}`);
}
console.log('------------------------------');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('Note: this script only validates repository guardrails and documentation markers. It does not prove runtime safety, execution correctness, or trading readiness.');

if (failed > 0) {
  process.exit(1);
}
