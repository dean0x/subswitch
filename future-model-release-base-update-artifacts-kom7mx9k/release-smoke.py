from pathlib import Path
import datetime,hashlib,http.server,json,os,subprocess,tarfile,threading
repo=Path(__file__).resolve().parents[1]
p=repo/'future-model-release-candidate.json'; record=json.loads(p.read_text()); root=Path(record['artifactRoot'])
requests=[]
class Origin(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  requests.append({'method':'GET','path':self.path}); self.send_response(503); self.end_headers()
 def do_POST(self):
  requests.append({'method':'POST','path':self.path}); self.send_response(503); self.end_headers()
 def log_message(self,*args): pass
origin=http.server.ThreadingHTTPServer(('127.0.0.1',0),Origin); thread=threading.Thread(target=origin.serve_forever,daemon=True); thread.start()
base=f'http://127.0.0.1:{origin.server_port}'
for name in ['home','user-config','native-claude','consumer','tarballs']: (root/name).mkdir(exist_ok=True)
config=root/'owned-init.config.json'; config.write_text(json.dumps({'port':origin.server_port,'providers':{'codex':{'aliases':{'sol':'gpt-fixture-release-sol'}}}})); config.chmod(0o600)
env=dict(record['environment']); env.update({'SUBSWITCH_CONFIG':str(config),'XDG_CONFIG_HOME':str(root/'user-config'),'CLAUDE_CONFIG_DIR':str(root/'native-claude'),'NODE_OPTIONS':'--require '+str(root/'runtime-guard.cjs'),'RELEASE_QA_ROOT':str(root),'RELEASE_QA_TRACE':str(root/'runtime-trace.jsonl'),'RELEASE_QA_ORIGIN':base,'RELEASE_QA_DEPENDENCIES':str(repo/'node_modules'),'npm_config_offline':'false','BASH_ENV':str(root/'bash-fixtures.sh')})
commands=list(record.get('reusePackageCommands',[]))
def run(name,cmd,cwd=repo):
 result=subprocess.run(cmd,cwd=cwd,env=env,text=True,capture_output=True)
 out=root/'logs'/f'{name}.stdout'; err=root/'logs'/f'{name}.stderr'; out.write_text(result.stdout); err.write_text(result.stderr)
 commands.append({'name':name,'argv':cmd,'cwd':str(cwd),'exit':result.returncode,'stdout':str(out),'stderr':str(err)})
 if result.returncode: raise RuntimeError(name+' failed '+str(result.returncode)+'; '+result.stderr[-1800:])
 return result.stdout
try:
 packed=json.loads((root/'logs/pack.stdout').read_text() if commands else run('pack',['npm','pack','--pack-destination',str(root/'tarballs'),'--json']))[0]
 tarball=root/'tarballs'/packed['filename']; packageHash=hashlib.sha256(tarball.read_bytes()).hexdigest()
 assert packed['version']=='0.6.1'
 with tarfile.open(tarball) as archive:
  members=archive.getnames(); assert all(m.startswith('package/') and '..' not in Path(m).parts for m in members)
  packaged=json.load(archive.extractfile('package/package.json'))
  compiled=archive.extractfile('package/dist/version.js').read().decode()
  assert packaged['version']=='0.6.1' and '"0.6.1"' in compiled
  assert packaged['bin']=={'subswitch':'dist/cli.js'}
  assert 'package/subswitch.config.example.json' in members
  assert 'package/subswitch.wave1.example.json' not in members
  assert all('kimi' not in member and not member.startswith('package/dist/routing/') for member in members)
 if not any(command['name']=='install' for command in commands): run('install',['npm','--prefix',str(root/'consumer'),'install','--save','--ignore-scripts','--no-audit','--no-fund',str(tarball)],root/'consumer')
 cli=root/'consumer/node_modules/subswitch/dist/cli.js'
 assert run('version',['node',str(cli),'--version']).strip()=='0.6.1'
 assert 'subswitch' in run('help',['node',str(cli),'--help']).lower()
 metadata=json.loads(run('models-json',['node',str(cli),'models','--json']))
 assert metadata['subswitchVersion']=='0.6.1' and metadata['configPath']==str(config) and metadata['configFileFound'] is True
 assert 'gpt-fixture-release-sol' in run('models-text',['node',str(cli),'models'])
 smoke=run('guide-smoke',['/usr/bin/lockf','-t','0','/Users/dean/Sandbox/.devflow/locks/heavy-tests.lock','bash','scripts/smoke-tarball.sh'])
 assert 'subswitch version: 0.6.1' in smoke and smoke.count('Smoke: OK')==2 and '"translationAvailable":true' in smoke
 traces=[json.loads(line) for line in (root/'runtime-trace.jsonl').read_text().splitlines()]
 assert not [t for t in traces if t['kind']=='blocked']
 assert not requests
 # The installed smoke temp must be removed by its EXIT trap.
 smokePaths=[t['path'] for t in traces if t['kind']=='fixture-config' and t['command']=='serve']
 assert smokePaths and all(not Path(path).parent.exists() for path in smokePaths)
 record['packagedQA']={'status':'pass','completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tarball':str(tarball),'tarballSha256':packageHash,'npmIntegrity':packed['integrity'],'npmShasum':packed['shasum'],'inventory':packed,'commands':commands,'installedVersion':'0.6.1','configuredFutureAliasDisplayed':True,'guideSmokeHealthChecks':2,'guideSmokeCleanupVerified':True,'fixtureOrigin':base,'fixtureOriginRequests':requests,'runtimeGuardBlocks':0,'runtimeGuardActivations':sum(t['kind']=='guard-active' for t in traces),'runtimeTrace':str(root/'runtime-trace.jsonl'),'isolation':'Bash mktemp fixture helper pins temp installation under the owned artifact root; unchanged script source. CLI-only preload completes owned fixture endpoints/auth paths before config load, pins child homedir to owned fixture, blocks external reads/writes, outbound connections/TLS and spawned commands. No product source modification or fake success response. Npm dependency installation uses its separate owned cache/config and may access only registry dependencies. SUBSWITCH_CONFIG for init is explicitly fixture-owned.','limitations':['Metadata and health startup only; no inference or actual native clients/credentials.','Runtime fixture config enrichment and child-local homedir guard are QA isolation measures.','This candidate excludes unmerged PR81/85/87; no new Wave1 sample or runtime files.']}
 print(json.dumps({'status':'pass','tarballSha256':packageHash,'version':'0.6.1','commands':len(commands),'healthChecks':2,'runtimeGuardBlocks':0,'fixtureOriginRequests':len(requests)},indent=2))
except BaseException as error:
 record['packagedQA']={'status':'failed','error':str(error),'commands':commands,'fixtureOriginRequests':requests}
 raise
finally:
 origin.shutdown(); origin.server_close(); thread.join(timeout=5)
 p.write_text(json.dumps(record,indent=2)+'\n')
