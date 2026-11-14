import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const root = import.meta.dirname;
const author = '/Users/dean/Sandbox/subswitch-kimi';
const qa = join(author, '.git/kimi-phase-a');
const expected = JSON.parse(await fs.readFile(join(author, 'kimi-phase-a-runner-fix-delivery.json'), 'utf8'));
const results = [];
let networkAttempts = 0;
const noNetwork = () => { networkAttempts++; throw new Error('independent_preflight_network_forbidden'); };
globalThis.fetch = noNetwork; net.Socket.prototype.connect = noNetwork; net.connect = noNetwork; net.createConnection = noNetwork;
http.request = noNetwork; http.get = noNetwork; https.request = noNetwork; https.get = noNetwork; tls.connect = noNetwork;
const realExec = childProcess.execFileSync;
let observations = [];
childProcess.execFileSync = function (file, args, options) {
  assert.equal(file, '/usr/bin/git', 'only_read_only_git_helpers_expected');
  assert.ok(args.includes('rev-parse') || args.includes('diff') || args.includes('ls-tree'));
  const names = realExec('/usr/bin/env', [], { env: options?.env, encoding: 'utf8' }).trim().split('\n').map(line => line.slice(0, line.indexOf('='))).sort();
  observations.push({ explicit: !!options?.env, names, args });
  return realExec(file, args, options);
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork']) childProcess[name] = () => { throw new Error('unexpected_process_launch'); };
syncBuiltinESMExports();
const pins = await import(join(qa, 'pins.mjs'));
const { authorize } = await import(join(qa, 'core.mjs'));
pins.assertPlainBootstrap();
const source = await pins.sourcePin(), runner = await pins.runnerPin(), runtime = await pins.runtimePin();
assert.equal(source, expected.sourceHash); assert.equal(runner, expected.runnerHash);
assert.equal(runtime.hash, expected.runtimeHash); assert.deepEqual(runtime.details, expected.runtimeDetails);
results.push({ case: 'actual_source_runner_binary_config_dependency_symlink_pins', passed: true, sourceHash: source, runnerHash: runner, runtimeHash: runtime.hash, runtimeDetails: runtime.details });
const greenObservations = observations; observations = [];
const canaries = ['UNRELATED_FAKE_SENTINEL','FAKE_PROVIDER_KEY','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_EXTERNAL_DIFF'];
assert.equal(greenObservations.length, 3);
assert.ok(greenObservations.every(o => o.explicit && canaries.every(name => !o.names.includes(name))));
results.push({ case: 'actual_git_helpers_exclude_six_synthetic_canaries', passed: true, observations: greenObservations });
const envName = 'FAKE_PROVIDER_KEY';
let keyReads = 0, wouldStartWorker = 0, wouldDispatch = 0;
const fake = new Proxy({}, { get(_obj, name) { assert.equal(name, envName); keyReads++; return 'fabricated-key'; } });
const approval = { phase:'A', liveAuthorized:true, credentialBindingApproved:true, continuityPrerequisiteConfirmed:true,
 product:'kimi-code',region:'global',model:'kimi-for-coding',effort:'high',credentialKind:'coding-plan-key', head:pins.HEAD,
 sourceHash:source,runnerHash:runner,runtimeHash:runtime.hash,runtimeDetails:runtime.details,
 credentialEnvName:envName,expiresAt:new Date(Date.now()+60000).toISOString() };
assert.equal(authorize(approval,envName,source,runner,runtime,fake),'fabricated-key'); keyReads = 0;
results.push({case:'matching_runtime_allows_fabricated_credential_getter',passed:true});
const copy = join(root,'runtime-copy');
await fs.mkdir(copy); await fs.cp(join(author,'node_modules'),join(copy,'node_modules'),{recursive:true,verbatimSymlinks:true});
await fs.cp(join(author,'tsconfig.json'),join(copy,'tsconfig.json'));
try {
 assert.deepEqual(await pins.runtimePin(copy),runtime);
 const refuse = (measured) => {
   assert.throws(() => { authorize(approval,envName,source,runner,measured,fake); wouldStartWorker++; wouldDispatch++; },/approval_runtime_hash|approval_runtime_details/);
   assert.equal(keyReads,0);assert.equal(wouldStartWorker,0);assert.equal(wouldDispatch,0);
 };
 for (const name of ['tsconfig.json','node_modules/tsx/dist/esm/api/index.mjs','node_modules/zod/package.json']) {
   const path=join(copy,name), bytes=await fs.readFile(path);
   try {
     if(name==='tsconfig.json'){const c=JSON.parse(bytes);c.compilerOptions.target='ES2022';await fs.writeFile(path,JSON.stringify(c));}
     else await fs.writeFile(path,Buffer.concat([bytes,Buffer.from('\n')]));
     const changed=await pins.runtimePin(copy);assert.notEqual(changed.hash,runtime.hash);refuse(changed);
     assert.equal(await pins.sourcePin(),source);assert.equal(await pins.runnerPin(),runner);
     results.push({case:`owned_copy_only_drift:${name}`,passed:true,keyReads,workerStarts:wouldStartWorker,transports:wouldDispatch});
   } finally {await fs.writeFile(path,bytes);}
 }
 const exe=join(copy,'node_modules/@esbuild/darwin-arm64/bin/esbuild'), mode=(await fs.stat(exe)).mode&0o777;
 try {await fs.chmod(exe,mode^0o100);refuse(await pins.runtimePin(copy));results.push({case:'owned_copy_executable_mode_drift',passed:true});}finally{await fs.chmod(exe,mode);}
 const link=join(copy,'node_modules/.bin/tsx'), target=await fs.readlink(link);
 try {await fs.unlink(link);await fs.symlink('../zod/index.js',link);refuse(await pins.runtimePin(copy));results.push({case:'owned_copy_internal_symlink_target_drift',passed:true});}finally{await fs.unlink(link);await fs.symlink(target,link);}
 const outside=join(root,'outside-dependency');await fs.writeFile(outside,'owned-placeholder');
 try {await fs.unlink(link);await fs.symlink(outside,link);await assert.rejects(pins.runtimePin(copy),/external_dependency_symlink/);results.push({case:'owned_copy_external_dependency_symlink_refused',passed:true});}finally{await fs.unlink(link);await fs.symlink(target,link);}
 const configPath=join(copy,'tsconfig.json'),configBytes=await fs.readFile(configPath);
 try {const c=JSON.parse(configBytes);c.extends='../unreviewed.json';await fs.writeFile(configPath,JSON.stringify(c));await assert.rejects(pins.runtimePin(copy),/selected_config_shape/);results.push({case:'selected_configuration_extends_refused',passed:true});}finally{await fs.writeFile(configPath,configBytes);}
 assert.deepEqual(await pins.runtimePin(copy),runtime);
} finally {await fs.rm(copy,{recursive:true,force:true});}
for(const field of ['version','executableSha256']) {
 const details=structuredClone(runtime.details);details.node[field]='fabricated-drift';
 assert.throws(()=>authorize({...approval,runtimeHash:pins.digest(JSON.stringify(details)),runtimeDetails:details},envName,source,runner,runtime,fake),/approval_runtime_hash/);
 results.push({case:`wrong_node_approval_pin:${field}`,passed:true});
}
assert.throws(()=>authorize({...approval,runtimeDetails:{fake:true}},envName,source,runner,runtime,fake),/approval_runtime_details/);
results.push({case:'component_details_bound_independently',passed:true});
assert.throws(()=>pins.assertPlainBootstrap({execArgv:['--import','unchecked']},{}),/plain_node/);
for(const name of ['NODE_OPTIONS','NODE_PATH','NODE_COMPILE_CACHE','TSX_TSCONFIG_PATH','ESBUILD_BINARY_PATH','DYLD_INSERT_LIBRARIES']) {
 const fakeEnv={};Object.defineProperty(fakeEnv,name,{enumerable:true,get(){throw new Error('selector_value_must_not_be_read');}});
 assert.throws(()=>pins.assertPlainBootstrap({execArgv:[]},fakeEnv),/ambient_runtime/);
}
results.push({case:'bootstrap_flags_and_six_selector_names_refused_without_value_reads',passed:true});
const before=await import(join(author,'.git/kimi-phase-a-before-fix/core.mjs'));
const oldSource=await before.sourcePin();assert.equal(oldSource,source);
const redObservations=observations.slice(-3);
assert.equal(redObservations.length,3);assert.ok(redObservations.every(o=>!o.explicit&&canaries.every(n=>o.names.includes(n))));
results.push({case:'preserved_old_git_helpers_red_control',passed:true,expectedIsolationAssertionFailed:true,observations:redObservations});
let oldReads=0;before.authorize({...approval,runtimeHash:'unmatched-runtime'},envName,source,runner,new Proxy({},{get(){oldReads++;return'fabricated-key';}}));assert.equal(oldReads,1);
results.push({case:'preserved_old_runtime_authorization_red_control',passed:true,expectedZeroGetterAssertionFailed:true,fabricatedGetterReads:oldReads});
assert.equal(keyReads,0);assert.equal(networkAttempts,0);
assert.equal(await pins.sourcePin(),source);assert.equal(await pins.runnerPin(),runner);assert.deepEqual(await pins.runtimePin(),runtime);
process.stdout.write(JSON.stringify({passed:true,checks:results.length,results,networkAttempts,realCredentials:false,thirdPartyLoaderImported:false,realWorkerStarted:false,fabricatedWorkerCounter:wouldStartWorker,fabricatedTransportCounter:wouldDispatch,copyRemoved:true})+'\n');
