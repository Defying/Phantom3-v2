#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const checks = [];
const composeFile = 'docker-compose.mullvad-socks5.example.yml';
const envFile = '.env.mullvad-socks5.example';

function record(ok, label, detail) {
  checks.push({ ok, label, detail });
}

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

function parseEnvFile(content) {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    values.set(key, value);
  }

  return values;
}

function readEnv(values, key) {
  const value = values.get(key);
  if (!value) {
    record(false, `${key} is defined`, `${envFile} is missing ${key}`);
    return null;
  }

  record(true, `${key} is defined`, `${key}=${value}`);
  return value;
}

function inspectComposeModel(compose) {
  const services = compose?.services;
  if (!services || typeof services !== 'object') {
    record(false, 'compose services parsed', 'docker compose config did not return a services object');
    return;
  }

  const proxyService = services['mullvad-socks5'];
  const appService = services['phantom3-v2'];

  record(Boolean(proxyService), 'compose defines mullvad-socks5 service', proxyService ? 'service found' : 'service missing');
  record(Boolean(appService), 'compose defines phantom3-v2 service', appService ? 'service found' : 'service missing');

  if (!proxyService || !appService) {
    return;
  }

  const proxyCapAdd = Array.isArray(proxyService.cap_add) ? proxyService.cap_add : [];
  record(proxyCapAdd.length === 0, 'mullvad-socks5 does not request NET_ADMIN', `cap_add=${JSON.stringify(proxyCapAdd)}`);

  const proxyCapDrop = Array.isArray(proxyService.cap_drop) ? proxyService.cap_drop : [];
  record(proxyCapDrop.includes('ALL'), 'mullvad-socks5 drops all capabilities', `cap_drop=${JSON.stringify(proxyCapDrop)}`);

  const appCapAdd = Array.isArray(appService.cap_add) ? appService.cap_add : [];
  record(!appCapAdd.includes('NET_ADMIN'), 'phantom3-v2 does not request NET_ADMIN', `cap_add=${JSON.stringify(appCapAdd)}`);

  const proxyPorts = Array.isArray(proxyService.ports) ? proxyService.ports : [];
  record(proxyPorts.length === 0, 'mullvad-socks5 does not publish ports to the host', proxyPorts.length === 0 ? 'no host ports published' : `ports=${JSON.stringify(proxyPorts)}`);

  const proxyExpose = Array.isArray(proxyService.expose) ? proxyService.expose : [];
  record(proxyExpose.some((port) => String(port) === '1080'), 'mullvad-socks5 exposes SOCKS5 internally', `expose=${JSON.stringify(proxyExpose)}`);

  const proxySecrets = Array.isArray(proxyService.secrets) ? proxyService.secrets : [];
  const mountedSecret = proxySecrets.find((secret) => secret?.target === 'mullvad-wg.conf');
  record(Boolean(mountedSecret), 'mullvad-socks5 mounts the WireGuard config as a secret', mountedSecret ? JSON.stringify(mountedSecret) : 'expected target mullvad-wg.conf');

  const appEnvironment = appService.environment && typeof appService.environment === 'object' ? appService.environment : {};
  record(appEnvironment.PHANTOM3_V2_POLYMARKET_PROXY_URL === 'socks5h://mullvad-socks5:1080', 'phantom3-v2 uses the internal SOCKS5 endpoint only for Polymarket', `PHANTOM3_V2_POLYMARKET_PROXY_URL=${JSON.stringify(appEnvironment.PHANTOM3_V2_POLYMARKET_PROXY_URL)}`);
  record(appEnvironment.PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY != null, 'phantom3-v2 includes the Polymarket eligibility scaffold', `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY=${JSON.stringify(appEnvironment.PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY ?? null)}`);
  record(appEnvironment.ALL_PROXY == null, 'phantom3-v2 does not set ALL_PROXY', `ALL_PROXY=${JSON.stringify(appEnvironment.ALL_PROXY ?? null)}`);
  record(appEnvironment.HTTP_PROXY == null, 'phantom3-v2 does not set HTTP_PROXY', `HTTP_PROXY=${JSON.stringify(appEnvironment.HTTP_PROXY ?? null)}`);
  record(appEnvironment.HTTPS_PROXY == null, 'phantom3-v2 does not set HTTPS_PROXY', `HTTPS_PROXY=${JSON.stringify(appEnvironment.HTTPS_PROXY ?? null)}`);

  record(appService.network_mode == null, 'phantom3-v2 keeps default bridge networking', `network_mode=${JSON.stringify(appService.network_mode ?? null)}`);

  const dependsOn = appService.depends_on;
  const dependsOnProxy = Array.isArray(dependsOn)
    ? dependsOn.includes('mullvad-socks5')
    : Boolean(dependsOn?.['mullvad-socks5']);
  record(dependsOnProxy, 'phantom3-v2 depends on mullvad-socks5', JSON.stringify(dependsOn));
}

async function main() {
  await expectFile(composeFile, 'Mullvad SOCKS5 compose example exists');
  await expectFile(envFile, 'Mullvad SOCKS5 env example exists');
  await expectFile('docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md', 'Mullvad SOCKS5 checklist exists');
  await expectFile('runtime/mullvad/.gitignore', 'runtime Mullvad gitignore exists');

  await expectIncludes('package.json', '"verify:mullvad-socks5"', 'package.json exposes the Mullvad SOCKS5 verifier');
  await expectIncludes('README.md', 'verify:mullvad-socks5', 'README documents the Mullvad SOCKS5 verifier');
  await expectIncludes('README.md', 'docker-compose.mullvad-socks5.example.yml', 'README links to the Mullvad SOCKS5 compose example');
  await expectIncludes('README.md', 'docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md', 'README links to the Mullvad SOCKS5 checklist');
  await expectIncludes('runtime/mullvad/README.md', 'gitignored drop zone', 'runtime Mullvad README explains the secret drop zone');
  await expectIncludes(composeFile, '${PHANTOM3_V2_ENV_FILE:-./.env.example}', 'compose example defaults PHANTOM3_V2_ENV_FILE to ./.env.example');
  await expectIncludes('docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md', 'verify:mullvad-socks5', 'checklist includes the Mullvad verifier command');
  await expectIncludes('docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md', 'host-local VPN startup', 'checklist keeps validation host-safe');

  const envValues = parseEnvFile(await read(envFile));
  const envPath = readEnv(envValues, 'PHANTOM3_V2_ENV_FILE');
  const secretPath = readEnv(envValues, 'PHANTOM3_V2_MULLVAD_WIREGUARD_HOST_PATH');
  const proxyUrl = readEnv(envValues, 'PHANTOM3_V2_POLYMARKET_PROXY_URL');
  const eligibility = readEnv(envValues, 'PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY');

  if (envPath) {
    record(envPath === './.env.example', 'PHANTOM3_V2_ENV_FILE stays on a committed example for static validation', `PHANTOM3_V2_ENV_FILE=${envPath}`);
  }

  if (secretPath) {
    record(secretPath.startsWith('./runtime/mullvad/'), 'PHANTOM3_V2_MULLVAD_WIREGUARD_HOST_PATH points at the gitignored runtime Mullvad directory', `PHANTOM3_V2_MULLVAD_WIREGUARD_HOST_PATH=${secretPath}`);
    record(secretPath.endsWith('.conf'), 'PHANTOM3_V2_MULLVAD_WIREGUARD_HOST_PATH uses a WireGuard .conf file', `PHANTOM3_V2_MULLVAD_WIREGUARD_HOST_PATH=${secretPath}`);
  }

  if (proxyUrl) {
    record(proxyUrl === 'socks5h://mullvad-socks5:1080', 'PHANTOM3_V2_POLYMARKET_PROXY_URL uses the internal SOCKS5 endpoint', `PHANTOM3_V2_POLYMARKET_PROXY_URL=${proxyUrl}`);
  }

  if (eligibility) {
    record(['unknown', 'confirmed-eligible', 'restricted'].includes(eligibility), 'PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY uses a supported value', `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY=${eligibility}`);
  }

  const composeResult = spawnSync(
    'docker',
    ['compose', '-f', composeFile, '--env-file', envFile, 'config', '--format', 'json'],
    { cwd: repoRoot, encoding: 'utf8' }
  );

  if (composeResult.status !== 0) {
    const detail = (composeResult.stderr || composeResult.stdout || 'docker compose config failed').trim();
    record(false, 'docker compose config renders the Mullvad model', detail);
  } else {
    record(true, 'docker compose config renders the Mullvad model', 'compose config parsed successfully');
    try {
      inspectComposeModel(JSON.parse(composeResult.stdout));
    } catch (error) {
      record(false, 'docker compose config JSON can be parsed', error instanceof Error ? error.message : String(error));
    }
  }

  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;

  console.log('Mullvad SOCKS5 static verification');
  console.log('================================');
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`);
    console.log(`      ${check.detail}`);
  }
  console.log('--------------------------------');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('Note: this verifier stays static. It checks compose rendering, env shape, secret-ignore coverage, and proxy wiring without starting the VPN stack or asserting live venue traffic actually flowed through the proxy.');

  if (failed > 0) {
    process.exit(1);
  }
}

await main();
