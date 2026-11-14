const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const cp = require('node:child_process');
const { fileURLToPath } = require('node:url');
if (/\/(?:dist\/cli\.js|node_modules\/\.bin\/subswitch)$/.test(process.argv[1] ?? '')) {
  const root = process.env.RELEASE_QA_ROOT;
  const trace = process.env.RELEASE_QA_TRACE;
  const rawTraceWrite = fs.writeFileSync;
  const log = value => rawTraceWrite(trace, JSON.stringify({pid:process.pid,...value})+'\n', {flag:'a'});
  const owned = file => file === root || file.startsWith(root+path.sep);
  const fail = value => { log({kind:'blocked',...value}); throw new Error('release fixture guard blocked '+JSON.stringify(value)); };
  os.homedir = () => path.join(root,'home');
  process.env.CLAUDE_CONFIG_DIR = path.join(root,'native-claude');
  const selected = process.env.SUBSWITCH_CONFIG;
  if (!selected || !owned(path.resolve(selected))) fail({operation:'config-selection',path:selected});
  // The unchanged smoke creates minimal configs. Complete those owned fixtures before the CLI loads them.
  if (fs.existsSync(selected)) {
    const config = JSON.parse(fs.readFileSync(selected,'utf8'));
    const base = process.env.RELEASE_QA_ORIGIN;
    config.anthropic = {...config.anthropic,baseUrl:base};
    config.providers = {...config.providers,codex:{...config.providers?.codex,baseUrl:base+'/backend-api/codex',oauthTokenUrl:base+'/codex-oauth',authFile:path.join(root,'unused-codex-auth.json')}};
    const ingress = config.codexIngress ?? {};
    config.codexIngress = {...ingress,apiBaseUrl:base+'/v1',subscriptionBaseUrl:base+'/backend-api/codex',claude:{...ingress.claude,baseUrl:base,oauthTokenUrl:base+'/claude-oauth',authFile:path.join(root,'unused-claude-auth.json'),configDir:path.join(root,'native-claude')}};
    fs.writeFileSync(selected,JSON.stringify(config),{mode:0o600});
    log({kind:'fixture-config',path:selected,command:process.argv[2],endpointOrigin:base});
  }
  const readRoots = [root,process.env.RELEASE_QA_DEPENDENCIES];
  const absolute = value => value instanceof URL ? fileURLToPath(value) : path.resolve(String(value));
  const check = (value,write=false) => {
    if (typeof value === 'number') return;
    const file=absolute(value);
    if (!(write ? owned(file) : readRoots.some(prefix=>file===prefix||file.startsWith(prefix+path.sep)))) fail({operation:write?'write':'read',path:file});
    if (owned(file)) log({kind:write?'fixture-write':'fixture-read',path:file});
  };
  for (const name of ['readFileSync','existsSync','realpathSync','statSync','lstatSync']) { const original=fs[name]; fs[name]=function(file,...args){check(file);return original.call(this,file,...args)}; }
  for (const name of ['writeFileSync','mkdirSync','unlinkSync']) { const original=fs[name]; fs[name]=function(file,...args){check(file,true);return original.call(this,file,...args)}; }
  for (const name of ['readFile','readdir','realpath','stat','lstat']) { const original=fsp[name]; fsp[name]=function(file,...args){check(file);return original.call(this,file,...args)}; }
  for (const name of ['writeFile','mkdir','unlink','open']) { const original=fsp[name]; fsp[name]=function(file,...args){check(file,true);return original.call(this,file,...args)}; }
  const rename=fsp.rename; fsp.rename=function(from,to,...args){check(from,true);check(to,true);return rename.call(this,from,to,...args)};
  net.Socket.prototype.connect=function(...args){fail({operation:'outbound-connect',target:JSON.stringify(args[0])});};
  tls.connect=function(){fail({operation:'tls-connect'});};
  for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name]=(...args)=>fail({operation:'child-process',method:name,command:String(args[0])});
  require('node:module').syncBuiltinESMExports();
  log({kind:'guard-active',entry:process.argv[1],command:process.argv[2]});
}
