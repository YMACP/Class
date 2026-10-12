import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSecrets, saveSecrets } from './secret-store.js';
import { storageError } from './storage-health.js';
import { normalizeJudgeConfig } from './judge-config.js';

export const DEFAULT_SETTINGS = Object.freeze({allowShell:true,voteTimeoutMs:30000,taskTimeoutMs:null,discoveryWindowMs:150,maxRounds:null,modelTimeoutMs:null});
// A colon cannot occur in an Agent ID, so this credential never replaces a member's key.
export const JUDGE_SECRET_ID = 'judge:jev';
export function storedJudgeConfig(value) {
  const {apiKey,hasApiKey,...config}=normalizeJudgeConfig(value??{}, {includeSecret:false});
  return config;
}
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
  config.judge=storedJudgeConfig(config.judge);
  const secrets=await loadSecrets(dataDir);
  return {config,secrets,async save(next,nextSecrets=this.secrets) {
    // Keep plaintext API keys out of profile JSON; secret-store protects its own file.
    const saved={...next,judge:storedJudgeConfig(next.judge)};
    const previousSecrets=this.secrets;
    await saveSecrets(dataDir,nextSecrets);
    try{await atomicJSON(filename,saved);}
    catch(error){
      // Publishing the profile failed: restore the old keys before reporting failure.
      // In-memory configuration changes only after both files have been saved.
      try{await saveSecrets(dataDir,previousSecrets);}
      catch(rollback){throw storageError(new AggregateError([error,rollback],'配置保存失败，凭据恢复也未完成，请检查数据目录后重试'),{operation:'恢复配置凭据',path:filename});}
      throw error;
    }
    this.config=saved;this.secrets=nextSecrets;
  }};
}
