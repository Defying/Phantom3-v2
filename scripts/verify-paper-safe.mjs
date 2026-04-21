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
await expectFile('docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md', 'Mullvad SOCKS5 checklist exists');
await expectFile('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'operator runbook exists');
await expectFile('docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md', 'Mullvad SOCKS5 Compose runbook exists');
await expectFile('docs/runbooks/MULLVAD_WIREGUARD_CONTAINER_INPUTS.md', 'Mullvad WireGuard input runbook exists');
await expectFile('docker-compose.mullvad-socks5.example.yml', 'Mullvad SOCKS5 compose example exists');
await expectFile('.env.mullvad-socks5.example', 'Mullvad SOCKS5 env example exists');
await expectFile('scripts/prepare-mullvad-wireguard-config.sh', 'Mullvad prep script exists');
await expectFile('scripts/verify-mullvad-config-safety.mjs', 'Mullvad config safety verifier exists');
await expectFile('scripts/verify-mullvad-socks5.mjs', 'Mullvad SOCKS5 static verifier exists');

await expectIncludes('package.json', '"verify:mullvad-config-safety"', 'package.json exposes the Mullvad config safety command');
await expectIncludes('package.json', '"verify:mullvad-socks5"', 'package.json exposes the Mullvad SOCKS5 verification command');
await expectIncludes('package.json', '"verify:paper-safe"', 'package.json exposes the paper-safe verification command');
await expectIncludes('package.json', '"verify:paper-runtime"', 'package.json exposes the paper runtime smoke verifier');
await expectIncludes('README.md', 'docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md', 'README links to the milestone doc');
await expectIncludes('README.md', 'docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md', 'README links to the QA checklist');
await expectIncludes('README.md', 'docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md', 'README links to the Mullvad SOCKS5 checklist');
await expectIncludes('README.md', 'docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'README links to the operator runbook');
await expectIncludes('README.md', 'docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md', 'README links to the Mullvad SOCKS5 Compose runbook');
await expectIncludes('README.md', 'docs/runbooks/MULLVAD_WIREGUARD_CONTAINER_INPUTS.md', 'README links to the Mullvad WireGuard input runbook');
await expectIncludes('README.md', 'verify:mullvad-socks5', 'README documents the Mullvad SOCKS5 verifier');
await expectIncludes('README.md', 'verify:paper-runtime', 'README documents the paper runtime smoke verifier');
await expectIncludes('README.md', 'PHANTOM3_V2_POLYMARKET_PROXY_URL', 'README documents the scoped Polymarket proxy setting');
await expectIncludes('README.md', 'geoblock bypass', 'README warns against geoblock bypass behavior');
await expectIncludes('.gitignore', '.secrets/', 'repo-local secret mounts are gitignored');

await expectMatch(
  'packages/config/src/index.ts',
  /PHANTOM3_V2_CONTROL_TOKEN:\s*z\.string\(\)\.min\(16/,
  'control token minimum length is enforced'
);
await expectIncludes('packages/config/src/index.ts', 'PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY', 'config includes the Polymarket eligibility scaffold');
await expectIncludes('packages/contracts/src/index.ts', "runtimeModeSchema = z.enum(['paper', 'live-disarmed'])", 'runtime contract remains paper/live-disarmed only');
await expectIncludes('packages/contracts/src/index.ts', 'marketDataTransportSchema', 'runtime contract exposes market-data transport metadata');
await expectIncludes('packages/contracts/src/index.ts', 'polymarketOperatorEligibilitySchema', 'runtime contract exposes operator eligibility metadata');
await expectMatch('apps/api/src/runtime-store.ts', /mode:\s*'paper'/, 'runtime store defaults to paper mode');
await expectIncludes('apps/api/src/runtime-store.ts', "label: 'Paper mode only'", 'runtime watchlist still advertises paper-only mode');
await expectIncludes('apps/api/src/runtime-store.ts', 'Live trading remains disarmed by design.', 'runtime event log still documents live-disarmed posture');
await expectIncludes('apps/api/src/runtime-store.ts', 'Live execution intentionally not implemented in milestone 1.', 'execution module remains blocked in the bootstrap runtime');
await expectIncludes('packages/ledger/README.md', 'append-only paper ledger', 'ledger placeholder still calls for append-only paper truth');
await expectIncludes('docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md', 'It does **not** mean:', 'milestone doc includes explicit non-goals');
await expectIncludes('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'This repo is not live-trading ready.', 'operator runbook includes explicit live-trading warning');
await expectIncludes('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md', 'operator runbook references the Mullvad SOCKS5 Compose runbook');
await expectIncludes('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY', 'operator runbook documents the venue eligibility scaffold');
await expectIncludes('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'Do not use the proxy setting to evade geographic restrictions.', 'operator runbook explicitly forbids proxy-based geoblock bypass');
await expectIncludes('docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md', 'container-only', 'Mullvad runbook describes the container-only boundary');
await expectIncludes('docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md', 'Docker Compose', 'Mullvad runbook documents Docker Compose deployment');
await expectIncludes('docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md', 'geoblocks', 'Mullvad runbook documents compliance and geoblock limitations');
await expectIncludes('docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md', 'verify:paper-runtime', 'QA checklist includes the paper runtime smoke verifier');
await expectIncludes('docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md', 'verify:paper-runtime', 'operator runbook includes the paper runtime smoke verifier');

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
console.log('Note: this script only validates repository guardrails and documentation markers. Pair it with npm run verify:paper-runtime for a local smoke check of ledger truth, restart recovery, and the sanitized paper API shape.');

if (failed > 0) {
  process.exit(1);
}
