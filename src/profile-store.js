import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSecrets, saveSecrets } from './secret-store.js';
import { storageError } from './storage-health.js';

export const DEFAULT_SETTINGS = Object.freeze({allowShell:true,voteTimeoutMs:30000,taskTimeoutMs:null,discoveryWindowMs:150,maxRounds:null,modelTimeoutMs:null});
export async function atomicJSON(filename,value,{overwrite=true}={}) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const text=JSON.stringify(value,null,2)+'\n';
  let file,created=false;
  try {
    file=await fs.open(temporary,'wx',0o600);created=true;
    await file.writeFile(text);await file.sync();await file.close();file=undefined;
    if(overwrite)await fs.rename(temporary,filename);else{await fs.link(temporary,filename);await fs.unlink(temporary);}
  } catch(error) {
    await file?.close().catch(()=>{});
    if(created)await fs.unlink(temporary).catch(()=>{});
    throw storageError(error,{operation:'保存本地记录',path:filename});
  }
}
export async function createProfileStore(dataDir) {
  await fs.mkdir(dataDir,{recursive:true,...(process.platform === 'linux' ? {mode:0o700} : {})});
  const workspace=path.join(dataDir,'workspace');await fs.mkdir(workspace,{recursive:true});
  const filename=path.join(dataDir,'profiles.json');
  let config={version:1,agents:[],settings:{...DEFAULT_SETTINGS,cwd:workspace}};
  try { config=JSON.parse(await fs.readFile(filename,'utf8')); } catch(error) { if(error.code!=='ENOENT')throw new Error('Unable to read saved Agent settings'); }
  if(config.version!==1||!Array.isArray(config.agents)||!config.settings||typeof config.settings!=='object')throw new Error('Saved Agent settings have an unsupported format');
  config.settings={...DEFAULT_SETTINGS,...config.settings,allowShell:true,taskTimeoutMs:null,discoveryWindowMs:DEFAULT_SETTINGS.discoveryWindowMs,maxRounds:null,modelTimeoutMs:null};
  const secrets=await loadSecrets(dataDir);
  return {config,secrets,async save(next,nextSecrets=this.secrets) {
    // Keep plaintext API keys out of profile JSON; secret-store protects its own file.
    await saveSecrets(dataDir,nextSecrets);await atomicJSON(filename,next);
    this.config=next;this.secrets=nextSecrets;
  }};
}
