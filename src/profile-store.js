import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSecrets, saveSecrets } from './secret-store.js';
import { storageError } from './storage-health.js';
import { normalizeJudgeConfig } from './judge-config.js';
import { normalizeExtensions, ensureBuiltinMcpPresets } from './extension-config.js';
import { ensureBuiltinSkillPresets } from './builtin-skills.js';
import { normalizeModes } from './mode-config.js';

export const DEFAULT_SETTINGS = Object.freeze({allowShell:true,voteTimeoutMs:30000,taskTimeoutMs:null,discoveryWindowMs:150,maxRounds:null,modelTimeoutMs:null});
// A colon cannot occur in an Agent ID, so this credential never replaces a member's key.
export const JUDGE_SECRET_ID = 'judge:jev';
export const MAX_PROFILE_BYTES = 64 * 1024 * 1024;
const profileSizeError = maximum => Object.assign(new Error(`Class配置超过允许大小（${maximum === MAX_PROFILE_BYTES ? '64MiB' : maximum + '字节'}），请减少模式提示词或Skill正文后重试；原配置已保留`), { status: 400, code: 'PROFILE_TOO_LARGE' });
export function assertProfileJSONSize(text, maximum = MAX_PROFILE_BYTES) {
  if (Buffer.byteLength(text, 'utf8') > maximum) throw profileSizeError(maximum);
}
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
  try {
    if ((await fs.stat(filename)).size > MAX_PROFILE_BYTES) throw profileSizeError(MAX_PROFILE_BYTES);
    const raw = await fs.readFile(filename, 'utf8'); assertProfileJSONSize(raw); config = JSON.parse(raw);
  } catch(error) { if(error.code==='PROFILE_TOO_LARGE')throw error;if(error.code!=='ENOENT')throw new Error('Unable to read saved Agent settings'); }
  if(config.version!==1||!Array.isArray(config.agents)||!config.settings||typeof config.settings!=='object')throw new Error('Saved Agent settings have an unsupported format');
  config.settings={...DEFAULT_SETTINGS,...config.settings,allowShell:true,taskTimeoutMs:null,discoveryWindowMs:DEFAULT_SETTINGS.discoveryWindowMs,maxRounds:null,modelTimeoutMs:null};
  config.judge=storedJudgeConfig(config.judge);
  const legacyBrowserIds=(config.extensions?.mcps??[]).filter(item=>item.transport==='builtin').map(item=>item.id);
  config.extensions=ensureBuiltinSkillPresets(ensureBuiltinMcpPresets(normalizeExtensions(config.extensions)));
  config.modes=normalizeModes(config.modes);
  const secrets=await loadSecrets(dataDir);
  for(const id of legacyBrowserIds)delete secrets['extension:'+id];
  return {config,secrets,async save(next,nextSecrets=this.secrets) {
    // Keep plaintext API keys out of profile JSON; secret-store protects its own file.
    const saved={...next,judge:storedJudgeConfig(next.judge),extensions:ensureBuiltinSkillPresets(ensureBuiltinMcpPresets(normalizeExtensions(next.extensions))),modes:normalizeModes(next.modes)};
    // Check the exact representation atomicJSON writes, including indentation
    // and the trailing newline, before changing the separate credential file.
    assertProfileJSONSize(JSON.stringify(saved, null, 2) + '\n');
    nextSecrets={...nextSecrets};
    for(const item of next.extensions?.mcps??[])if(item.transport==='builtin')delete nextSecrets['extension:'+item.id];
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
