const fs = require('node:fs');
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
