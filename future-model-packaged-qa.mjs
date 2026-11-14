import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const repo = process.cwd();
const head = 'e582cd0cce239eb6eeeb9debcb4fe3664d6609ca';
const base = 'de137dedbd72d660657517251fe8a1051dd43465';
const future = 'gpt-fixture-packaged-sol';
const root = await fs.mkdtemp(path.join(repo, 'future-model-packaged-qa-artifacts-'));
await fs.mkdir(path.join(root, 'logs'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, head, base, artifactRoot: root, runtime: { node: process.version, platform: process.platform, arch: process.arch }, commands: [], packages: {}, cases: [], findings: [], limits: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFile(path.join(repo, 'future-model-packaged-qa.json'), JSON.stringify(report, null, 2) + '\n');
await save();
let commandNumber = 0;
const buildEnv = { PATH: process.env.PATH, npm_config_cache: path.join(root, 'npm-cache'), npm_config_logs_dir: path.join(root, 'npm-logs'), npm_config_userconfig: path.join(root, 'empty-npmrc'), npm_config_globalconfig: path.join(root, 'empty-global-npmrc'), npm_config_offline: 'true', npm_config_update_notifier: 'false' };
await fs.writeFile(buildEnv.npm_config_userconfig, '');
await fs.writeFile(buildEnv.npm_config_globalconfig, '');
function launch(command, args, options = {}) {
  const id = ++commandNumber;
  const label = `${String(id).padStart(2, '0')}-${options.label ?? path.basename(command)}`;
  const record = { command, args, cwd: options.cwd ?? repo, stdout: path.join(root, 'logs', `${label}.stdout`), stderr: path.join(root, 'logs', `${label}.stderr`), startedAt: new Date().toISOString() };
  report.commands.push(record);
  const child = spawn(command, args, { cwd: record.cwd, env: options.env ?? buildEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      Object.assign(record, { exitCode: code, signal, completedAt: new Date().toISOString(), stdoutSha256: sha(stdout), stderrSha256: sha(stderr) });
      await fs.writeFile(record.stdout, stdout); await fs.writeFile(record.stderr, stderr);
      resolve({ code, signal, stdout, stderr, record });
    });
  });
  return { child, done, record, output: () => ({ stdout, stderr }) };
}
async function run(command, args, options = {}) {
  const running = launch(command, args, options);
  const result = await running.done;
  if (options.expected !== undefined) assert.equal(result.code, options.expected, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result;
}
async function recordCase(name, work) {
  const entry = { name, status: 'running' }; report.cases.push(entry); await save();
  try { entry.result = await work(); entry.status = 'pass'; }
  catch (error) { entry.status = 'fail'; entry.error = String(error.stack ?? error); throw error; }
  finally { await save(); }
}
async function buildPackage(label, commit) {
  const directory = path.join(root, label);
  await fs.mkdir(directory); await fs.mkdir(path.join(directory, 'source')); await fs.mkdir(path.join(directory, 'tarballs')); await fs.mkdir(path.join(directory, 'extracted'));
  const files = ['src', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'README.md', 'LICENSE', 'subswitch.config.example.json'].filter(name => existsSync(path.join(repo, name)));
  const sourceTar = path.join(directory, 'source.tar');
  await run('git', ['archive', '--format=tar', `--output=${sourceTar}`, commit, '--', ...files], { expected: 0, label: `${label}-archive` });
  await run('tar', ['-xf', sourceTar, '-C', path.join(directory, 'source')], { expected: 0, label: `${label}-extract-source` });
  await fs.symlink(path.join(repo, 'node_modules'), path.join(directory, 'source', 'node_modules'), 'dir');
  await run('npm', ['run', 'build'], { cwd: path.join(directory, 'source'), expected: 0, label: `${label}-build` });
  const packed = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', path.join(directory, 'tarballs'), '--json'], { cwd: path.join(directory, 'source'), expected: 0, label: `${label}-pack` });
  const metadata = JSON.parse(packed.stdout)[0];
  assert.ok(metadata.files.every(file => !file.path.startsWith('/') && !file.path.split('/').includes('..')));
  const tarball = path.join(directory, 'tarballs', metadata.filename);
  await run('tar', ['-xzf', tarball, '-C', path.join(directory, 'extracted')], { expected: 0, label: `${label}-extract-package` });
  const packageRoot = path.join(directory, 'extracted', 'package');
  await fs.symlink(path.join(repo, 'node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'subswitch'); assert.equal(manifest.version, '0.6.0'); assert.equal(manifest.bin.subswitch, 'dist/cli.js');
  const entry = path.join(packageRoot, manifest.bin.subswitch);
  report.packages[label] = { commit, sourceArchive: sourceTar, sourceArchiveSha256: sha(await fs.readFile(sourceTar)), tarball, tarballSha256: sha(await fs.readFile(tarball)), integrity: metadata.integrity, npmShasum: metadata.shasum, entry, entrySha256: sha(await fs.readFile(entry)), files: metadata.files.map(file => file.path), dependencyMode: 'Existing author-clone lockfile dependency tree, symlinked into a freshly extracted tarball. No registry install/network or new dependency resolution.' };
  return { label, commit, packageRoot, entry };
}
const shim = path.join(root, 'hermetic-runtime.cjs');
await fs.writeFile(shim, String.raw`const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { fileURLToPath } = require('node:url');
const fixture = process.env.QA_FIXTURE_ROOT;
const trace = process.env.QA_TRACE;
const append = fs.appendFileSync;
const log = value => append(trace, JSON.stringify(value) + '\n');
const fail = value => { log({ kind: 'blocked', ...value }); throw new Error('hermetic QA blocked: ' + JSON.stringify(value)); };
os.homedir = () => path.join(fixture, 'home');
const allowedRead = [process.env.QA_ARTIFACT_ROOT, process.env.QA_DEPENDENCIES];
const checkRead = value => {
  if (typeof value === 'number') return;
  const file = value instanceof URL ? fileURLToPath(value) : String(value);
  const absolute = path.resolve(file);
  if (!allowedRead.some(prefix => absolute === prefix || absolute.startsWith(prefix + path.sep)) && absolute !== process.env.QA_REPO_PACKAGE)
    fail({ operation: 'read', path: absolute });
  if (absolute.startsWith(fixture + path.sep)) log({ kind: 'fixture-read', path: absolute });
};
const readSync = fs.readFileSync; fs.readFileSync = function(file, ...args) { checkRead(file); return readSync.call(this, file, ...args); };
for (const name of ['readFile', 'readdir']) { const original = fsp[name]; fsp[name] = function(file, ...args) { checkRead(file); return original.call(this, file, ...args); }; }
const ports = new Set(JSON.parse(process.env.QA_ALLOWED_PORTS));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  let options = args[0]; if (Array.isArray(options)) options = options[0];
  const host = typeof options === 'object' ? options.host ?? options.hostname ?? 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  const port = Number(typeof options === 'object' ? options.port : options);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !ports.has(port)) fail({ operation: 'connect', host, port });
  log({ kind: 'fixture-connect', host, port }); return connect.apply(this, args);
};
tls.connect = function(options) {
  if (process.env.QA_DOCTOR_TLS !== 'stub' || options.host !== '127.0.0.1' || Number(options.port) !== 443)
    fail({ operation: 'tls', host: options.host, port: options.port });
  log({ kind: 'fixture-tls-stub', host: options.host, port: options.port });
  const socket = new EventEmitter(); socket.setTimeout = () => socket; socket.destroy = () => socket;
  queueMicrotask(() => socket.emit('secureConnect')); return socket;
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = (...args) => fail({ operation: 'child-process', method: name, command: String(args[0]) });
require('node:module').syncBuiltinESMExports();
`);
report.harness = { script: path.join(repo, 'future-model-packaged-qa.mjs'), scriptSha256: sha(await fs.readFile(path.join(repo, 'future-model-packaged-qa.mjs'))), runtimeShim: shim, runtimeShimSha256: sha(await fs.readFile(shim)), scope: 'Unmodified packaged CLI entry point; child-local homedir/read/network/process guard. Doctor TLS is an explicitly simulated secureConnect event, not a real external TLS handshake.' };

function frames(events) { return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''); }
function reply(model, text, toolPath) {
  const opening = { type: 'response.created', response: { id: 'resp_qa', model, status: 'in_progress' } };
  if (toolPath) {
    const item = { type: 'function_call', id: 'fc_qa', call_id: 'call_qa', name: 'read_fixture', arguments: JSON.stringify({ path: toolPath }) };
    return frames([opening, { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }, { type: 'response.function_call_arguments.delta', item_id: 'fc_qa', output_index: 0, delta: item.arguments }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_qa', model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } } }]);
  }
  const item = { type: 'message', id: 'msg_qa', role: 'assistant' };
  return frames([opening, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_text.delta', item_id: 'msg_qa', output_index: 0, delta: text }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_qa', model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } } }]);
}
async function getPort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function parseMessage(response, stream) {
  const raw = await response.text();
  if (!stream) return { message: JSON.parse(raw), raw };
  const content = new Map(), json = new Map(); let stopReason;
  const events = raw.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean).map(value => JSON.parse(value));
  for (const event of events) {
    if (event.type === 'content_block_start') content.set(event.index, structuredClone(event.content_block));
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') content.get(event.index).text += event.delta.text;
      if (event.delta.type === 'input_json_delta') json.set(event.index, (json.get(event.index) ?? '') + event.delta.partial_json);
    }
    if (event.type === 'message_delta') stopReason = event.delta.stop_reason;
  }
  for (const [index, value] of json) content.get(index).input = JSON.parse(value);
  assert.equal(events.at(-1).type, 'message_stop');
  return { message: { content: [...content.values()], stop_reason: stopReason }, raw };
}

async function qualify(packaged) {
  const state = path.join(root, 'runtime', packaged.label);
  const project = path.join(state, 'project'); const home = path.join(state, 'home');
  await fs.mkdir(path.join(project, '.claude', 'agents'), { recursive: true }); await fs.mkdir(path.join(home, '.claude', 'agents'), { recursive: true });
  const nonce = `owned-fixture-${randomUUID()}`; const nonceFile = path.join(state, 'nonce.txt'); await fs.writeFile(nonceFile, nonce);
  const token = ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'fixture-user', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_packaged_qa' } })).toString('base64url'), 'fabricated'].join('.');
  const authFile = path.join(state, 'fabricated-auth.json'); await fs.writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fabricated-refresh', account_id: 'acct_packaged_qa' } }));
  const requests = [];
  const origin = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, body, headers: req.headers });
    if (req.url !== '/codex/responses' || JSON.stringify(body).includes('qa-reject')) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: req.url === '/codex/responses' ? 'qa_model_unavailable' : 'qa_unmatched_at_local_anthropic' } })); return;
    }
    const toolResult = body.input?.find(item => item.type === 'function_call_output');
    if (toolResult && toolResult.output !== nonce) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'qa_bad_tool_result' } })); return; }
    const tool = !toolResult && JSON.stringify(body.input).includes('qa-tool-start');
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(reply(body.model, toolResult ? `ack:${toolResult.output}` : 'fixture answer', tool ? nonceFile : undefined));
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const originPort = origin.address().port; const originUrl = `http://127.0.0.1:${originPort}`; const port = await getPort();
  const configPath = path.join(state, 'config.json');
  const config = { port, logLevel: 'error', anthropic: { baseUrl: `${originUrl}/anthropic` }, providers: { codex: { aliases: { sol: future, worker: future }, authFile, baseUrl: `${originUrl}/codex`, oauthTokenUrl: `${originUrl}/unexpected-refresh` } }, codexIngress: { subscriptionBaseUrl: `${originUrl}/unexpected-subscription`, apiBaseUrl: `${originUrl}/unexpected-api`, claude: { baseUrl: `${originUrl}/unexpected-claude`, oauthTokenUrl: `${originUrl}/unexpected-claude-refresh`, authFile: path.join(state, 'absent-claude-auth.json'), configDir: path.join(state, 'absent-claude-config') } } };
  for (const url of [config.anthropic.baseUrl, config.providers.codex.baseUrl, config.providers.codex.oauthTokenUrl, config.codexIngress.subscriptionBaseUrl, config.codexIngress.apiBaseUrl, config.codexIngress.claude.baseUrl, config.codexIngress.claude.oauthTokenUrl]) assert.equal(new URL(url).origin, originUrl);
  for (const file of [authFile, config.codexIngress.claude.authFile, config.codexIngress.claude.configDir]) assert.ok(file.startsWith(state + path.sep));
  await fs.writeFile(configPath, JSON.stringify(config));
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SUBSWITCH_CONFIG: configPath, XDG_CONFIG_HOME: path.join(state, 'xdg'), NO_COLOR: '1', QA_FIXTURE_ROOT: state, QA_ARTIFACT_ROOT: root, QA_DEPENDENCIES: path.join(repo, 'node_modules'), QA_REPO_PACKAGE: path.join(repo, 'package.json'), QA_ALLOWED_PORTS: JSON.stringify([originPort, port]) };
  let server;
  const traces = [];
  const cli = (args, options = {}) => {
    const trace = path.join(state, `trace-${traces.length}.jsonl`); traces.push(trace);
    return launch(process.execPath, ['--require', shim, packaged.entry, ...args], { cwd: project, env: { ...env, QA_TRACE: trace, QA_DOCTOR_TLS: options.doctor ? 'stub' : '' }, label: `${packaged.label}-${args[0].replaceAll('-', '')}` });
  };
  const post = (model, stream, messages = [{ role: 'user', content: 'identity probe' }], extra = {}) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fabricated-incoming' }, body: JSON.stringify({ model, stream, max_tokens: 64, messages, ...extra }), signal: AbortSignal.timeout(5000) });
  try {
    server = cli(['serve']);
    await recordCase(`${packaged.label}: packaged CLI startup and health`, async () => {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(server.child.exitCode, null, server.output().stderr);
        try { const health = await fetch(`http://127.0.0.1:${port}/__subswitch/health`, { signal: AbortSignal.timeout(200) }); if (health.ok && (await health.json()).name === 'subswitch') { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(ready, true, server.output().stderr); assert.equal(server.child.exitCode, null);
      return { port, childPid: server.child.pid, configPath, configSha256: sha(await fs.readFile(configPath)), endpoints: 'All seven endpoint roots point to this owned origin.', nativePaths: 'Explicit fixture-owned files; no native user path.' };
    });
    await recordCase(`${packaged.label}: packaged help, version and effective alias table`, async () => {
      const help = await cli(['--help']).done; assert.equal(help.code, 0); assert.match(help.stdout, /Commands:/);
      const version = await cli(['--version']).done; assert.equal(version.code, 0); assert.equal(version.stdout.trim(), '0.6.0');
      const models = await cli(['models']).done; assert.equal(models.code, 0); assert.match(models.stdout, new RegExp(future));
      const json = await cli(['models', '--json']).done; assert.equal(json.code, 0); const table = JSON.parse(json.stdout); assert.equal(table.configFileFound, true); assert.equal(table.models.some(model => model.id === future), false);
      return { commands: ['--help', '--version', 'models', 'models --json'], futureIsRegistryEntry: false };
    });
    await recordCase(`${packaged.label}: real packaged doctor discovery, auth-file and warning severity (TLS stubbed)`, async () => {
      const knownModels = packaged.label === 'head' ? ['sol', 'codex:sol', future, `codex:${future}`] : ['sol'];
      for (const [index, model] of knownModels.entries()) await fs.writeFile(path.join(project, '.claude', 'agents', `known-${index}.md`), `---\nmodel: ${model}\n---\n`);
      const doctor = await cli(['doctor', '--client', 'claude-code'], { doctor: true }).done;
      assert.equal(doctor.code, packaged.label === 'head' ? 0 : 1, doctor.stdout + doctor.stderr); assert.match(doctor.stdout, /target not in registry/);
      if (packaged.label === 'head') { assert.match(doctor.stdout, /upstream support is not verified/); assert.doesNotMatch(doctor.stdout, /FAIL/); }
      if (packaged.label === 'head') {
        await fs.writeFile(path.join(home, '.claude', 'agents', 'unknown.md'), '---\nmodel: gpt-fixture-undeclared\n---\n');
        const invalid = await cli(['doctor', '--client', 'claude-code'], { doctor: true }).done; assert.equal(invalid.code, 1); assert.match(invalid.stdout, /FAIL.*gpt-fixture-undeclared|gpt-fixture-undeclared.*FAIL/);
        return { knownExitCode: doctor.code, unknownAgentExitCode: invalid.code, discovery: 'Actual packaged CLI filesystem discovery in isolated project and child-local homedir.', TLS: 'Fixture secureConnect stub only.' };
      }
      return { knownAliasExitCode: doctor.code, differential: 'Baseline treats the supported unknown target alias as a doctor failure.', TLS: 'Fixture secureConnect stub only.' };
    });
    await recordCase(`${packaged.label}: configured model spelling differential through packaged server`, async () => {
      const matrix = packaged.label === 'head' ? ['sol', 'worker', 'codex:sol', 'codex:worker', future, `codex:${future}`] : ['sol', 'codex:sol', future, `codex:${future}`];
      const result = [];
      for (const model of matrix) {
        const before = requests.length; const response = await post(model, false); const latest = requests.at(-1);
        const unsupported = packaged.label === 'baseline' && [future, `codex:${future}`].includes(model);
        assert.equal(response.status, unsupported ? 400 : 200, model); await response.text(); assert.equal(requests.length, before + 1);
        assert.equal(latest.path, unsupported ? '/anthropic/v1/messages' : '/codex/responses');
        if (!unsupported) { assert.equal(latest.body.model, packaged.label === 'baseline' && model === 'codex:sol' ? 'gpt-6.1-sol' : future); assert.equal(latest.headers.authorization, `Bearer ${token}`); }
        result.push({ requested: model, status: response.status, path: latest.path, selectedModel: latest.body.model });
      }
      return result;
    });
    for (const stream of [false, true]) await recordCase(`${packaged.label}: packaged tool/result continuation stream=${stream}`, async () => {
      const start = requests.length;
      const model = packaged.label === 'head' ? 'codex:sol' : 'sol'; const followupModel = packaged.label === 'head' ? `codex:${future}` : 'sol';
      const messages = [{ role: 'user', content: `qa-tool-start-${stream}` }];
      const extra = { tools: [{ name: 'read_fixture', description: 'Read an owned fixture file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
      const first = await post(model, stream, messages, extra); assert.equal(first.status, 200); const decoded = await parseMessage(first, stream); assert.equal(decoded.message.stop_reason, 'tool_use');
      const tool = decoded.message.content.find(block => block.type === 'tool_use'); assert.ok(tool); assert.equal(tool.name, 'read_fixture'); assert.equal(tool.input.path, nonceFile);
      // Deliberately execute only this owned read in the QA harness, never a native client.
      const output = await fs.readFile(tool.input.path, 'utf8'); assert.equal(output, nonce);
      const followup = [...messages, { role: 'assistant', content: decoded.message.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: output }] }];
      const second = await post(followupModel, stream, followup, extra); assert.equal(second.status, 200); const finished = await parseMessage(second, stream); assert.equal(finished.message.stop_reason, 'end_turn'); assert.ok(finished.message.content.some(block => block.type === 'text' && block.text.includes(`ack:${nonce}`)));
      const sent = requests.slice(start); assert.equal(sent.length, 2); assert.ok(sent.every(request => request.path === '/codex/responses' && request.body.model === future && request.headers.authorization === `Bearer ${token}`));
      assert.equal(sent[1].body.input.find(item => item.type === 'function_call_output').output, nonce); assert.equal(sent[1].body.input.find(item => item.type === 'function_call').call_id, 'call_qa'); assert.equal(sent[0].headers.session_id, sent[1].headers.session_id);
      return { turns: 2, firstModel: model, followupModel, exactOwnedNonceRoundTrip: true, stableCanonicalSessionId: sent[0].headers.session_id, nativeClientUsed: false };
    });
    await recordCase(`${packaged.label}: selected provider rejection is authoritative`, async () => {
      const modes = packaged.label === 'head' ? [false, true] : [false];
      for (const stream of modes) {
        const before = requests.length; const response = await post(packaged.label === 'head' ? future : 'sol', stream, [{ role: 'user', content: 'qa-reject' }]); assert.equal(response.status, 400); assert.match(await response.text(), /qa_model_unavailable/); assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).path, '/codex/responses');
      }
      return { streamModes: modes, retries: 0, fallbackCalls: 0 };
    });
  } finally {
    if (server) { server.child.kill('SIGTERM'); await server.done; }
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
    const entries = [];
    for (const trace of traces) { try { entries.push(...(await fs.readFile(trace, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    report.packages[packaged.label].runtimeGuard = { blocked: entries.filter(entry => entry.kind === 'blocked'), fixtureConnections: entries.filter(entry => entry.kind === 'fixture-connect').length, TLSStubs: entries.filter(entry => entry.kind === 'fixture-tls-stub').length, fixtureReads: [...new Set(entries.filter(entry => entry.kind === 'fixture-read').map(entry => entry.path))] };
    assert.equal(report.packages[packaged.label].runtimeGuard.blocked.length, 0);
    assert.ok(report.packages[packaged.label].runtimeGuard.fixtureReads.includes(authFile));
    await fs.rm(authFile); await fs.rm(nonceFile);
    report.packages[packaged.label].cleanup = { serverStopped: !server || server.child.exitCode !== null || server.child.signalCode !== null, originClosed: !origin.listening, fabricatedAuthAndNonceRemoved: true };
    await save();
  }
}
try {
  const current = await run('git', ['rev-parse', 'HEAD'], { expected: 0 }); assert.equal(current.stdout.trim(), head);
  const packages = [];
  for (const [label, commit] of [['baseline', base], ['head', head]]) packages.push(await buildPackage(label, commit));
  for (const packaged of packages) await qualify(packaged);
  report.status = 'pass';
  report.limits = ['No actual native Codex/Claude clients or live provider calls. Tool execution is a QA-owned file read driven by the packaged proxy tool event.', 'Doctor TLS probes are explicitly stubbed in the child runtime; no external reachability claim. Packaged config loading, auth-file read, health probe, filesystem agent discovery, output and exit codes run normally.', 'Tarballs are freshly built from pinned git archives; dependencies reuse the author clone lockfile tree via symlink. Four-green CI separately covers fresh npm install/tarball smoke on Node 22/24 and both platforms.', 'No full suite rerun; unchanged source retains previously green 973-case check/build and independent source approval.', 'PR81 v2 target restriction, original user-specific startup error and actual provider availability remain separate.'];
} catch (error) { report.status = 'fail'; report.findings.push({ error: String(error.stack ?? error) }); process.exitCode = 1; }
finally { report.completedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: report.status, report: path.join(repo, 'future-model-packaged-qa.json'), artifactRoot: root, passed: report.cases.filter(entry => entry.status === 'pass').length, failed: report.cases.filter(entry => entry.status === 'fail').length })); }
