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

await expectFile('scripts/prepare-mullvad-wireguard-config.sh', 'prepare script exists');
await expectFile('runtime/mullvad/.gitignore', 'runtime mullvad gitignore exists');
await expectFile('runtime/mullvad/README.md', 'runtime mullvad README exists');
await expectFile('examples/mullvad/compose.env.example', 'compose env example exists');
await expectFile('examples/mullvad/mount-snippet.example.yml', 'mount snippet example exists');
await expectFile('docs/runbooks/MULLVAD_WIREGUARD_CONTAINER_INPUTS.md', 'Mullvad runbook exists');
await expectFile('.githooks/pre-commit', 'pre-commit hook exists');

await expectIncludes('runtime/mullvad/.gitignore', '!README.md', 'runtime gitignore keeps README tracked');
await expectIncludes('runtime/mullvad/.gitignore', '*', 'runtime gitignore ignores generated files');
await expectIncludes('.githooks/pre-commit', 'prepare-mullvad-wireguard-config.sh', 'pre-commit hook points to the prepare helper');
await expectIncludes('.githooks/pre-commit', 'PrivateKey', 'pre-commit hook blocks WireGuard private keys');
await expectIncludes('.env.example', 'PHANTOM3_V2_MULLVAD_WIREGUARD_HOST_PATH', '.env.example exposes optional Mullvad host path');
await expectIncludes('README.md', 'docs/runbooks/MULLVAD_WIREGUARD_CONTAINER_INPUTS.md', 'README links to the Mullvad runbook');
await expectIncludes('README.md', 'prepare-mullvad-wireguard-config.sh', 'README documents the prepare helper');
await expectIncludes('docker-compose.example.yml', 'examples/mullvad/mount-snippet.example.yml', 'Compose example points to the mount snippet');
await expectIncludes('package.json', 'verify:mullvad-config-safety', 'package.json exposes the Mullvad safety verifier');

const passed = checks.filter((check) => check.ok).length;
const failed = checks.length - passed;

console.log('Mullvad config safety verification');
console.log('=================================');
for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`);
  console.log(`      ${check.detail}`);
}
console.log('---------------------------------');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('Note: this script validates the repo safety rails for runtime-only Mullvad inputs. It does not inspect or print any secret values.');

if (failed > 0) {
  process.exit(1);
}
