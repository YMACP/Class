import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ClassEngine } from './engine.js';
import { ToolManager } from './tools.js';
import { ModelClient, createStudent, createTeacher, createDemo } from './agents.js';
import { normalizeModelEndpoint, normalizeReasoningEffort } from './model-protocol.js';
import { normalizeContext1M } from './context-policy.js';
import { createProfileStore, atomicJSON, DEFAULT_SETTINGS, JUDGE_SECRET_ID, storedJudgeConfig } from './profile-store.js';
import { normalizeJudgeConfig } from './judge-config.js';
import { JevJudge } from './jev-judge.js';
import { JudgmentLayer } from './judgment-layer.js';
import { pickDirectory } from './directory-picker.js';
import { relocateProfileDirectory, readMigrationRecovery } from './data-location.js';
import { RunJournal } from './run-journal.js';
import { assertStorageSpace, storageError, storageDetails } from './storage-health.js';
import { MemoryManager, memoryProjectId, MEMORY_SUMMARY_PROMPT } from './memory-manager.js';
import { publicExtensions, prepareExtensionUpdate, prepareExtensionDeletion, assertBuiltinExtensionsPreserved, extensionSecrets, extensionSecretValues } from './extension-config.js';
import { CheckpointStore, CHECKPOINT_SECRET_ID, newCheckpointKey } from './checkpoint-store.js';
import { AttachmentStore, ATTACHMENT_BODY_LIMIT } from './attachment-store.js';
import { PrincipalManager } from './principal-manager.js';
import { normalizeTaskMode, normalizeTaskModeDefinition } from './task-mode.js';
import { publicModes, addMode, deleteModes, resolveModeDefinition, taskModeName, pruneModeExtensions } from './mode-config.js';
import { buildModeExtensions } from './mode-extensions.js';
import { ExtensionPlanner } from './extension-planner.js';
import { createTaskScheduler } from './task-scheduler.js';
import { normalizeTaskSpec, taskSpecText, normalizeSchedule, createRunWorkspace } from './task-request.js';
import { RunResources } from './run-resources.js';

import { VERSION } from './version.js';
const RUN_ID=/^run-[0-9a-f-]{36}$/;
const AGENT_ID=/^[A-Za-z0-9_-]{1,80}$/;
const BODY_LIMIT=65536,EVENT_LIMIT=1000,HISTORY_LIMIT=50,OUTCOME_LIMIT=500;
const SUMMARY_BYTES=2*1024*1024,ENTRY_BYTES=32768;
const ACTIVE=new Set(['running','paused','stopping']);
class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
function fail(status,message){throw new HttpError(status,message);}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function requiredText(value,name,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)fail(400,`${name} is required (maximum ${max} characters)`);return value.trim();}
function normalizeAgent(value,previous,{requireV1=true,defaultProtocol='messages'}={}) {
  if(!object(value))fail(400,'Agent must be an object');
  const id=value.id??previous?.id??randomUUID();
  if(typeof id!=='string'||!AGENT_ID.test(id))fail(400,'Invalid Agent ID');
  const name=requiredText(value.name,'name',80),model=requiredText(value.model,'model',200);
  if(!['teacher','student','principal'].includes(value.role))fail(400,'role must be teacher, student or principal');
  let endpoint;
  try{endpoint=normalizeModelEndpoint(requiredText(value.baseUrl,'baseUrl',2048),value.protocol??previous?.protocol??defaultProtocol,{requireV1});}
  catch(error){fail(400,error.message);}
  const {baseUrl,protocol}=endpoint;
  const hasReasoningEffort=Object.hasOwn(value,'reasoningEffort');
  let reasoningEffort=hasReasoningEffort?value.reasoningEffort:previous?.reasoningEffort;
  // An omitted edit preserves the saved setting. Protocol switches preserve
  // the top-level choice while using the destination protocol's spelling.
  if(!hasReasoningEffort&&previous?.protocol!==protocol){
    if(protocol==='messages'&&reasoningEffort==='ultra')reasoningEffort='ultracode';
    else if(protocol!=='messages'&&reasoningEffort==='ultracode')reasoningEffort='ultra';
  }
  try{reasoningEffort=normalizeReasoningEffort(reasoningEffort,protocol);}
  catch(error){fail(400,error.message);}
  let context1M;
  try{context1M=normalizeContext1M(Object.hasOwn(value,'context1M')?value.context1M:previous?.context1M);}
  catch(error){fail(400,error.message);}
  if(value.perspective!==undefined&&(typeof value.perspective!=='string'||value.perspective.length>8000))fail(400,'perspective must be text up to 8000 characters');
  if(value.jsonMode!==undefined&&typeof value.jsonMode!=='boolean')fail(400,'jsonMode must be boolean');
  if(value.apiKey!==undefined&&(typeof value.apiKey!=='string'||value.apiKey.length>8192))fail(400,'Invalid API key');
  if(value.clearKey!==undefined&&typeof value.clearKey!=='boolean')fail(400,'clearKey must be boolean');
  return {id,name,role:value.role,baseUrl,protocol,model,...(reasoningEffort===undefined?{}:{reasoningEffort}),context1M,perspective:value.perspective??previous?.perspective??'',jsonMode:value.jsonMode??previous?.jsonMode??false};
}
async function normalizeSettings(value,previous,checkDirectory=true) {
  if(!object(value))fail(400,'Settings must be an object');
  const allowed=new Set(['cwd','voteTimeoutMs']);
  if(Object.keys(value).some(k=>!allowed.has(k)))fail(400,'Unknown setting');
  const next={...previous,...value,allowShell:true,taskTimeoutMs:null,discoveryWindowMs:DEFAULT_SETTINGS.discoveryWindowMs,maxRounds:null,modelTimeoutMs:null};
  if(typeof next.cwd!=='string'||!path.isAbsolute(next.cwd))fail(400,'Workspace must be an absolute directory path');
  try { if(checkDirectory) { if(!(await fs.stat(next.cwd)).isDirectory())fail(400,'Workspace is not a directory');next.cwd=await fs.realpath(next.cwd); } } catch(error) {if(error instanceof HttpError)throw error;fail(400,'Workspace directory does not exist or cannot be accessed');}
  if(!Number.isSafeInteger(next.voteTimeoutMs)||next.voteTimeoutMs<100||next.voteTimeoutMs>300000)fail(400,'voteTimeoutMs must be an integer from 100 to 300000');
  return next;
}
async function readBody(req,limit=BODY_LIMIT) {
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(415,'Content-Type must be application/json');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)fail(413,'Request body is too large');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid JSON body');}
  if(!object(value))fail(400,'JSON body must be an object');return value;
}
function send(res,status,value,headers={}) {const body=typeof value==='string'?value:JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(body);}
function summary(run){return {id:run.id,status:run.status,task:run.task,taskSpec:run.taskSpec,schedule:run.schedule,scheduled:run.scheduled===true,taskMode:run.taskMode??'auto',taskModeName:run.taskModeName??taskModeName(run.taskMode??'auto',run.taskModeDefinition),title:typeof run.title==='string'?run.title:'',pinned:run.pinned===true,attachments:Array.isArray(run.attachments)?run.attachments:[],startedAt:run.startedAt,finishedAt:run.finishedAt,demo:run.demo===true,recoverable:run.recoverable===true,lastCheckpointAt:run.lastCheckpointAt};}
function failureMessage(reason) {
  const value=String(reason||'Task failed');
  const messages={storage_error:'任务记录或证据档案保存失败，已停止任务。',answer_invalid:'此历史任务的答案未通过老师验收。',task_timeout:'任务达到配置的运行时限。',max_rounds:'任务达到配置的求解轮数。',tool_cleanup_timeout:'工具清理尚未完成，请查看运行记录。',event_limit:'此历史任务达到旧版事件数量上限。',event_memory_limit:'此历史任务达到旧版事件容量上限。'};
  if(messages[value])return messages[value];
  if(/\b429\b/.test(value))return '模型接口限流（429）：'+value;
  if(/Model HTTP|fetch failed|ECONN|network/i.test(value))return '模型接口请求失败：'+value;
  return '任务未能继续：'+value;
}

/** A loopback-only, bearer-authenticated HTTP host for the existing coordinator. */
export async function createClassServer({dataDir,token,assets={},onShutdown,port=0,directoryPicker=pickDirectory,dataAnchor=dataDir,dataDirectoryLifecycle,dataDirectoryLoader,workspaceOverride,requireMemoryReady=false,mcpTestTimeoutMs=30000,updater}={}) {
  if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw new Error('dataDir must be an absolute path');
  if(typeof token!=='string'||token.length<24)throw new Error('A random local access token of at least 24 characters is required');
  if(typeof directoryPicker!=='function')throw new Error('directoryPicker must be a function');
  if(!Number.isSafeInteger(mcpTestTimeoutMs)||mcpTestTimeoutMs<1||mcpTestTimeoutMs>120000)throw new Error('Invalid MCP connection test timeout');
  if(typeof dataAnchor!=='string'||!path.isAbsolute(dataAnchor))throw new Error('dataAnchor must be an absolute path');
  if(dataDirectoryLifecycle!==undefined&&typeof dataDirectoryLifecycle!=='function')throw new Error('dataDirectoryLifecycle must be a function');
  let store=await createProfileStore(dataDir);
  const attachmentStore=new AttachmentStore(dataDir);
  if(workspaceOverride!==undefined){if(typeof workspaceOverride!=='string'||!path.isAbsolute(workspaceOverride))throw new Error('Invalid restored workspace');store.config.settings.cwd=workspaceOverride;}
  store.config.settings=await normalizeSettings({},store.config.settings,false);
  // Older profiles used Chat and may have custom gateway prefixes. Keep them
  // runnable; new saves use the explicit base-address rules shown in the UI.
  store.config.agents=store.config.agents.map(a=>normalizeAgent(a,undefined,{requireV1:false,defaultProtocol:'chat'}));
  if(store.config.agents.length>18||store.config.agents.filter(agent=>agent.role==='principal').length>1||store.config.agents.filter(agent=>agent.role==='student').length>16||store.config.agents.filter(agent=>agent.role==='teacher').length>1||new Set(store.config.agents.map(a=>a.id)).size!==store.config.agents.length)throw new Error('Saved Agent settings contain invalid members');
  const knownSecrets=new Set([token,...Object.values(store.secrets).filter(s=>typeof s==='string'&&s),...extensionSecretValues(store.secrets)]);
  let checkpointKeyPromise;
  const checkpoints=new CheckpointStore({directory:path.join(dataDir,'checkpoints'),getKey:async create=>{
    if(store.secrets[CHECKPOINT_SECRET_ID])return store.secrets[CHECKPOINT_SECRET_ID];
    if(!create)throw new Error('未找到任务快照密钥，原始记录已保留');
    if(!checkpointKeyPromise)checkpointKeyPromise=(async()=>{
      const key=newCheckpointKey();await store.save(store.config,{...store.secrets,[CHECKPOINT_SECRET_ID]:key});knownSecrets.add(key);return key;
    })().finally(()=>{checkpointKeyPromise=undefined;});
    return checkpointKeyPromise;
  }});
  const memberIdentity=agent=>Object.fromEntries(['id','name','role','baseUrl','protocol','model','reasoningEffort','context1M','perspective','jsonMode'].filter(key=>agent[key]!==undefined).map(key=>[key,agent[key]]));
  const insideWorkspace=relative=>relative!== '..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);
  function checkpointWorkspace(cwd){
    const relative=path.relative(path.join(dataDir,'workspace'),cwd);
    return {cwd,...(insideWorkspace(relative)?{workspaceRelative:relative}:{})};
  }
  function restoredWorkspace(metadata){
    if(typeof metadata.cwd!=='string'||!path.isAbsolute(metadata.cwd))throw new Error('续跑快照的工作目录无效');
    if(!Object.hasOwn(metadata,'workspaceRelative'))return metadata.cwd;
    const relative=metadata.workspaceRelative;
    if(typeof relative!=='string'||relative.length>32768||relative.includes('\0')||path.win32.isAbsolute(relative)||path.posix.isAbsolute(relative)||/^[A-Za-z]:/.test(relative)||relative.split(/[\\/]/).includes('..'))throw new Error('续跑快照的相对工作目录无效');
    const root=path.join(dataDir,'workspace'),cwd=path.resolve(root,relative);
    if(!insideWorkspace(path.relative(root,cwd)))throw new Error('续跑工作目录不能超出当前数据目录中的 workspace');
    return cwd;
  }
  function validateRecovery(saved,run){
    if(!saved?.state||saved.state.schemaVersion!==1||saved.state.runId!==run.id||saved.state.terminalStatus==='completed'||saved.metadata?.version!==1||typeof saved.state.task!=='string')throw new Error('该任务没有兼容的续跑快照');
    const taskMode=normalizeTaskMode(run.taskMode);
    if(normalizeTaskMode(saved.state.taskMode)!==taskMode||normalizeTaskMode(saved.metadata.taskMode)!==taskMode)throw new Error('续跑快照与任务模式不匹配');
    const definition=normalizeTaskModeDefinition(taskMode,saved.state.taskModeDefinition);
    if(JSON.stringify(definition)!==JSON.stringify(normalizeTaskModeDefinition(taskMode,saved.metadata.taskModeDefinition)))throw new Error('续跑快照与模式定义不匹配');
    restoredWorkspace(saved.metadata);
    if(saved.metadata.attachmentIds!==undefined&&JSON.stringify(saved.metadata.attachmentIds)!==JSON.stringify((run.attachments||[]).map(item=>item.id)))throw new Error('续跑快照与任务附件不匹配');
    if(!saved.metadata.demo){
      if(!Array.isArray(saved.metadata.agents)||saved.metadata.agents.length<3)throw new Error('续跑快照缺少成员配置');
      for(const original of saved.metadata.agents){const currentAgent=store.config.agents.find(agent=>agent.id===original.id);if(!currentAgent||JSON.stringify(memberIdentity(currentAgent))!==JSON.stringify(original))throw new Error('任务成员或模型配置已改变，请恢复原配置后继续任务');}
    }
    return saved;
  }
  function safe(value,depth=0,key='') {
    // A bounded, explicit user configuration must remain byte-for-byte durable
    // across restart. It is not model output and is already visible in /modes.
    if(depth===1&&key==='taskModeDefinition'&&value!==undefined){try{return normalizeTaskModeDefinition(value.id,value);}catch{/* Untrusted output still uses normal redaction below. */}}
    if(/^(apiKey|authorization|token|secret|password)$/i.test(key))return '[REDACTED]';
    if(depth>12)return '[truncated]';
    if(typeof value==='string') {let s=value;for(const secret of knownSecrets)if(secret)s=s.split(secret).join('[REDACTED]');s=s.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [REDACTED]');return s.length>16384?s.slice(0,16384)+'… [truncated]':s;}
    if(Array.isArray(value))return value.slice(0,1000).map(v=>safe(v,depth+1));
    if(object(value))return Object.fromEntries(Object.entries(value).slice(0,100).map(([k,v])=>[k,safe(v,depth+1,k)]));
    return value;
  }
  const storageWarnings=[];
  let migrationWarning, recoveryLauncher;
  function rememberStorageFailure(error,{run,operation,path:failurePath}={}) {
    const failure=storageError(error,{operation,path:failurePath});
    const detail=safe({...storageDetails(failure),recordedAt:new Date().toISOString(),...(run?{runId:run.id}:{})});
    if(run){run.storageError=detail;run.storageErrors=[...(Array.isArray(run.storageErrors)?run.storageErrors:[]),detail].slice(-20);}
    storageWarnings.push(detail);if(storageWarnings.length>50)storageWarnings.splice(0,storageWarnings.length-50);
    return failure;
  }
  try {
    const recovered=await readMigrationRecovery(dataDir);migrationWarning=recovered.warning;recoveryLauncher=recovered.recoveryLauncher;
    storageWarnings.push(...safe(recovered.recoveredFailures||[]).slice(-50));
  } catch(error) { rememberStorageFailure(error,{operation:'read_migration_recovery',path:path.join(dataDir,'migration-recovery.json')}); }
  async function checkTaskStorage(workspace,operation) {
    await assertStorageSpace(dataDir,{operation});
    if(path.resolve(workspace).toLowerCase()!==path.resolve(dataDir).toLowerCase())await assertStorageSpace(workspace,{operation:operation+'_workspace'});
  }
  let historyDir=path.join(dataDir,'history');await fs.mkdir(historyDir,{recursive:true});
  const journals=new Map();let memory;
  function journalFor(id) {
    if(!RUN_ID.test(id))throw new Error('Invalid task archive ID');
    if(!journals.has(id))journals.set(id,new RunJournal({directory:path.join(historyDir,id),secrets:knownSecrets,runId:id,onRecord:record=>memory?.observeRecord(id,record)}));
    return journals.get(id);
  }
  function boundedEntry(value) {
    const cleaned=safe(value);
    if(Buffer.byteLength(JSON.stringify(cleaned))<=ENTRY_BYTES)return cleaned;
    const brief={};let bytes=256;
    for(const [key,value] of Object.entries(cleaned)){if(value!==null&&!['string','number','boolean'].includes(typeof value))continue;const item=typeof value==='string'?value.slice(0,1024):value;const size=Buffer.byteLength(JSON.stringify({[key]:item}));if(bytes+size>ENTRY_BYTES)continue;brief[key]=item;bytes+=size;}
    return {...brief,truncated:true,summaryNotice:'内容较长，此处为摘要；完整记录请查看本次运行档案。'};
  }
  const summarySizes=new WeakMap();
  function appendSummary(run,field,value,counter) {
    let sizes=summarySizes.get(run);if(!sizes){sizes={};summarySizes.set(run,sizes);}
    let bytes=sizes[field]??Buffer.byteLength(JSON.stringify(run[field]));
    const entry=boundedEntry(value);run[field].push(entry);bytes+=Buffer.byteLength(JSON.stringify(entry))+1;
    while(run[field].length>EVENT_LIMIT||bytes>SUMMARY_BYTES){const removed=run[field].shift();bytes-=Buffer.byteLength(JSON.stringify(removed))+1;run[counter]=(run[counter]||0)+1;}
    sizes[field]=bytes;
  }
  function upsertOutcome(run,value) {
    if(!object(value)||typeof value.id!=='string'||!value.id||value.id.length>200)return;
    if(!Array.isArray(run.outcomes))run.outcomes=[];
    let entry=safe(value);
    if(Buffer.byteLength(JSON.stringify(entry))>ENTRY_BYTES){
      // Independent field budgets keep a long report from hiding the teacher's
      // gaps and next steps, or the identity and links needed to read originals.
      const brief={};
      function part(value,budget){
        let remaining=budget;
        function visit(item){
          if(remaining<24)return undefined;
          if(typeof item==='string'){const bytes=Buffer.from(item),limit=Math.max(0,Math.floor((remaining-24)/2));const text=bytes.length<=limit?item:bytes.subarray(0,limit).toString('utf8').replace(/\uFFFD$/,'')+'… [truncated]';remaining-=Buffer.byteLength(JSON.stringify(text))+1;return text;}
          remaining-=4;
          if(Array.isArray(item)){const result=[];for(const next of item.slice(0,12)){const kept=visit(next);if(kept===undefined)break;result.push(kept);}return result;}
          if(object(item)){const result={};for(const [key,next] of Object.entries(item).slice(0,12)){remaining-=Buffer.byteLength(JSON.stringify(key))+1;const kept=visit(next);if(kept===undefined)break;Object.defineProperty(result,key,{value:kept,enumerable:true});}return result;}
          remaining-=16;return item;
        }
        return visit(value);
      }
      for(const key of ['id','type','studentId','memberName','role','operation','submissionType','submissionId','candidateId','status','validated','reason','round','reviewRound','reviewId','feedbackVersion','evidenceRef','fullContentRef','snapshotRef','reviewFullContentRef','createdAt','updatedAt','legacy','summaryOnly','discoveryId'])if(entry[key]===null||['string','number','boolean'].includes(typeof entry[key]))brief[key]=typeof entry[key]==='string'?entry[key].slice(0,key.endsWith('Ref')?300:200):entry[key];
      const budgets={content:4500,report:2500,answer:1500,evidence:1000,verifiedFacts:1500,gaps:1500,recommendations:1500,completionClaims:1500,remainingIssues:1500,candidateIds:1000,submissionIds:1000,proposerIds:1000,sourceIds:1000,evidenceRefs:1000,groups:3000,inputs:2000};
      for(let scale=1;;scale*=0.75){
        for(const [key,budget] of Object.entries(budgets))if(entry[key]!==undefined)brief[key]=part(entry[key],Math.max(100,Math.floor(budget*scale)));
        if(Buffer.byteLength(JSON.stringify(brief))<ENTRY_BYTES-500)break;
      }
      entry={...brief,truncated:true,contentTruncated:true,summaryNotice:'内容较长，此处为摘要；完整记录请查看本次运行档案。'};
    }
    const index=run.outcomes.findIndex(item=>item.id===entry.id);
    if(index<0)run.outcomes.push(entry);else run.outcomes[index]=entry;
    let bytes=Buffer.byteLength(JSON.stringify(run.outcomes));
    while(run.outcomes.length>OUTCOME_LIMIT||bytes>SUMMARY_BYTES){const removed=run.outcomes.shift();bytes-=Buffer.byteLength(JSON.stringify(removed))+1;run.outcomesDropped=(run.outcomesDropped||0)+1;}
  }
  function hydrateOutcomes(run) {
    const stored=Array.isArray(run.outcomes)?run.outcomes:null;
    run.outcomes=[];run.outcomesDropped=Number.isSafeInteger(run.outcomesDropped)&&run.outcomesDropped>0?run.outcomesDropped:0;
    run.outcomesVersion=1;
    if(stored){for(const entry of stored)upsertOutcome(run,entry);return;}
    // Compatibility is a presentation-only projection of facts that actually
    // survived in old summaries. It never changes the verified blackboard or
    // invents an original-text reference for a previously truncated result.
    const published=run.events.filter(event=>event?.type==='outcome.upsert'&&object(event.entry));
    if(published.length){for(const event of published)upsertOutcome(run,event.entry);return;}
    const names=new Map((run.team?.students||[]).map(member=>[member.id,member.name||member.id]));
    const candidates=new Map(),latestAnswers=new Map(),reviews=new Map();
    let round=0,reviewRound=0;
    const stamp=event=>event?.time||event?.createdAt||run.startedAt;
    const put=(entry,event)=>upsertOutcome(run,{legacy:true,summaryOnly:true,createdAt:stamp(event),updatedAt:stamp(event),...entry});
    const update=(id,changes,event)=>{const previous=run.outcomes.find(entry=>entry.id===id);if(previous)put({...previous,...changes,updatedAt:stamp(event)},event);};
    function feedback(entry,event) {
      if(!object(entry)||typeof entry.report!=='string')return;
      const id=entry.reviewId||(Number.isSafeInteger(entry.reviewRound)?'review-'+entry.reviewRound:'legacy-review-'+entry.id);
      put({id,type:'teacher_review',studentId:run.team?.teacher,memberName:'老师',status:'rejected',report:entry.report,content:entry.report,
        reviewId:entry.reviewId,reviewRound:entry.reviewRound,feedbackVersion:entry.feedbackVersion,candidateIds:entry.candidateIds,
        verifiedFacts:entry.verifiedFacts,gaps:entry.gaps,recommendations:entry.recommendations,evidenceRefs:entry.evidenceRefs,evidenceRef:entry.evidenceRef},event);
    }
    for(const [index,event] of run.events.entries()) {
      if(!object(event))continue;
      if(Number.isSafeInteger(event.round))round=event.round;
      if(Number.isSafeInteger(event.reviewRound))reviewRound=event.reviewRound;
      if(event.type==='student.result'&&['continue','answer'].includes(event.result?.type)&&typeof event.result.content==='string'){
        const result=event.result,id=result.submissionId||event.submissionId||'legacy-submission-'+(event.sequence??index),candidateId=result.candidateId||event.candidateId;
        put({id,type:'student_submission',studentId:event.studentId,memberName:names.get(event.studentId)||event.studentId,
          submissionType:result.type,submissionId:id,candidateId,status:result.type==='answer'?'pending':'reported',content:result.content,
          evidence:result.evidence,evidenceRefs:result.evidenceRefs,evidenceRef:result.evidenceRecordRef,completionClaims:result.completionClaims,remainingIssues:result.remainingIssues,round,reviewRound},event);
        if(result.type==='answer'){latestAnswers.set(event.studentId,id);if(candidateId)candidates.set(candidateId,id);}
      }
      if(event.type==='candidate.received'){
        const candidate=event.candidate||{},candidateId=event.candidateId||candidate.candidateId;
        let id=candidates.get(candidateId)||candidate.submissionId||event.submissionId;
        if(!id){const last=run.outcomes.find(entry=>entry.id===latestAnswers.get(event.studentId));if(last&&(!candidate.content||last.content===candidate.content))id=last.id;}
        if(!id&&typeof candidate.content==='string'){
          id='legacy-candidate-'+(candidateId||event.sequence||index);
          put({id,type:'student_submission',studentId:event.studentId,memberName:names.get(event.studentId)||event.studentId,submissionType:'answer',submissionId:id,candidateId,status:'pending',content:candidate.content,evidence:candidate.evidence,evidenceRef:candidate.evidenceRecordRef,round,reviewRound},event);
        }
        if(id&&candidateId){candidates.set(candidateId,id);update(id,{candidateId},event);}
      }
      if(event.type==='review.started'){
        const id=event.reviewId||'review-'+reviewRound;reviews.set(id,event.candidateIds||[]);
        for(const candidateId of event.candidateIds||[])update(candidates.get(candidateId),{status:'reviewing',reviewId:id,reviewRound},event);
      }
      if(['review.passed','review.rejected'].includes(event.type)){
        const id=event.reviewId||'review-'+reviewRound;
        for(const candidateId of event.candidateIds||reviews.get(id)||[])update(candidates.get(candidateId),{status:event.type==='review.passed'?'accepted':'rejected',reviewId:id,reviewRound},event);
      }
      if(event.type==='candidate.deferred')update(candidates.get(event.candidateId),{status:'deferred',reason:event.reason,reviewRound},event);
      if(event.type==='discovery.proposed'||event.type==='discovery.decided'){
        if(typeof event.id==='string'&&typeof event.content==='string')put({id:'legacy-merge-'+event.id,type:'teacher_merge',studentId:run.team?.teacher,memberName:'老师',status:event.type==='discovery.proposed'?'processing':event.accepted?'accepted':'rejected',content:event.content,evidence:event.evidence,proposerIds:event.proposerIds,discoveryId:event.id,round:event.round??round},event);
      }
      if(event.type==='feedback.published')feedback(event.entry,event);
    }
    for(const entry of run.blackboard)if(entry?.type==='teacher_feedback'&&!run.outcomes.some(outcome=>outcome.id===(entry.reviewId||'review-'+entry.reviewRound)))feedback(entry,entry);
    if(typeof run.result?.answer==='string'&&run.result.answer){
      const validated=run.status==='completed'||run.result.status==='completed';
      put({id:'final-answer',type:'final_answer',studentId:run.team?.teacher,memberName:'老师',status:validated?'accepted':'reported',validated,content:run.result.answer,report:run.result.report,reviewRound:run.result.reviewRound??run.reviewRound},{time:run.finishedAt||run.startedAt});
    }
  }
  const checks=new Set(),mcpTests=new Set(),mcpProbeManagers=new Set();const records=new Map(),activeRuns=new Map(),runResources=new RunResources();let current=null,chooser=null,closing=false,relocating=false,dataTransition=false,starting=0,closePromise,mutations=Promise.resolve(),scheduler;
  const probeAgent='extension-connection-probe';
  function mcpTestFailure(error,signal) {
    const aborted=signal.aborted,reason=aborted?signal.reason:error;
    const codes=new Set(['MCP_TIMEOUT','MCP_CANCELLED','MCP_ERROR','MCP_REMOTE_ERROR','EXTENSION_UNAVAILABLE']);
    const code=aborted?(reason?.code==='MCP_TIMEOUT'?'MCP_TIMEOUT':'MCP_CANCELLED'):(codes.has(error?.code)?error.code:'MCP_ERROR');
    let message={MCP_TIMEOUT:'MCP连接测试超时，请检查服务是否已启动。',MCP_CANCELLED:'MCP连接测试已取消。',MCP_REMOTE_ERROR:'MCP服务拒绝连接测试，请检查配置和凭据。',EXTENSION_UNAVAILABLE:'MCP配置不可用，请检查启动参数和工作目录。'}[code];
    if(!message){
      const detail=String(error?.message||'');
      if(/process failed to start|process exited/i.test(detail))message='无法启动MCP服务，请检查启动命令和依赖是否已安装。';
      else if(/protocol version is unsupported/i.test(detail))message='MCP服务的协议版本不兼容。';
      else if(/does not provide tools/i.test(detail))message='MCP服务未提供工具列表能力。';
      else if(/invalid|exceeds/i.test(detail))message='MCP服务返回的工具列表或协议数据无效。';
      else message='MCP连接测试失败，请检查服务地址、凭据、网络和依赖。';
    }
    // Messages are fixed: remote errors, URLs, stderr and credentials never
    // become connection-test output, including failures before redaction exists.
    return {ok:false,message,code};
  }
  async function testMcpConnection(manager,id,controller) {
    const started=Date.now();let result;
    const timer=setTimeout(()=>controller.abort(Object.assign(new Error('MCP connection test timed out'),{code:'MCP_TIMEOUT'})),mcpTestTimeoutMs);
    try{result={ok:true,...await manager.extensions.probeConnection(probeAgent,id,controller.signal)};}
    catch(error){result=mcpTestFailure(error,controller.signal);}
    finally{
      clearTimeout(timer);
      try{await manager.stopAll();mcpProbeManagers.delete(manager);}
      catch{result={ok:false,message:'MCP测试已结束，但服务进程清理尚未完成，请稍后关闭应用重试。',code:'MCP_CLEANUP_FAILED'};}
    }
    return {...result,durationMs:Math.max(0,Date.now()-started)};
  }
  async function finishMcpTests() {
    await Promise.allSettled([...mcpTests]);
    // A failed cleanup stays owned so shutdown can retry instead of abandoning
    // its child process or reporting that the application is ready to exit.
    await Promise.all([...mcpProbeManagers].map(async manager=>{await manager.stopAll();mcpProbeManagers.delete(manager);}));
  }
  function openMemory() {
    const manager=new MemoryManager({dataDir,historyDir,secrets:knownSecrets,currentProject:()=>store.config.settings.cwd,isBusy:()=>Boolean(starting||activeRuns.size||relocating||closing),canSummarize:()=>store.config.agents.some(agent=>agent.role==='teacher'&&store.secrets[agent.id]),summarize:async({type,items,signal})=>{
      const teacher=store.config.agents.find(agent=>agent.role==='teacher');
      if(!teacher||!store.secrets[teacher.id])throw new Error('请先配置可用的老师模型；历史会话搜索不需要模型。');
      const client=new ModelClient({...provider(teacher),context1M:false,timeoutMs:60000,maxTokens:4096});
      return client.json(MEMORY_SUMMARY_PROMPT,{type,currentTime:new Date().toISOString(),sources:items},signal);
    }});manager.start();return manager;
  }
  const serial=fn=>{if(relocating)return Promise.reject(new HttpError(409,'Data directory migration is in progress'));const next=mutations.then(fn);mutations=next.catch(()=>{});return next;};
  const filename=id=>path.join(historyDir,`${id}.json`);
  const currentFilename=()=>path.join(dataDir,'current-run.json');
  const selectRun=id=>atomicJSON(currentFilename(),{version:1,runId:id});
  const writes=new Map();
  const removals=new Map(),clearingRuns=new Set();
  const principalManager=new PrincipalManager({historyDir,secrets:knownSecrets,beforeSnapshot:id=>{
    const pendingJournal=journals.get(id)?.queue, pendingConversations=memory?.conversations;
    return Promise.all([pendingJournal,pendingConversations]);
  }});
  function persist(run){const destination=filename(run.id);const write=(writes.get(run.id)||Promise.resolve()).catch(()=>{}).then(()=>atomicJSON(destination,safe(run))).catch(error=>{throw storageError(error,{operation:'save_run',path:destination});});writes.set(run.id,write);return write;}
  async function removeArchive(id) {
    const parent=path.resolve(historyDir),target=path.resolve(parent,id);
    if(!RUN_ID.test(id)||path.dirname(target)!==parent)throw new Error('Invalid archive cleanup path');
    async function inspect(directory) {
      const info=await fs.lstat(directory);
      if(info.isSymbolicLink())throw new Error('Task archive cleanup does not follow symbolic links');
      if(info.isDirectory())for(const entry of await fs.readdir(directory))await inspect(path.join(directory,entry));
    }
    try{if((await fs.lstat(parent)).isSymbolicLink())throw new Error('History directory cannot be a symbolic link');await inspect(target);}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    await fs.rm(target,{recursive:true,force:false,maxRetries:3,retryDelay:100});
  }
  async function removeStoredRun(id,{discardFailedWrites=false}={}) {
    if(removals.has(id))return removals.get(id);
    const operation=(async()=>{
      await principalManager.cancel(id,undefined,'该课堂正在删除，校长请求已取消');
      // Deletion may follow a storage-failed task. Wait for its queued writes
      // to settle without requiring a previously failed journal to recover.
      const pending=[writes.get(id),journals.get(id)?.flush()];
      if(discardFailedWrites)await Promise.allSettled(pending);
      else await Promise.all(pending);
      const selected=current?.id===id;
      if(selected)await selectRun(null);
      try {
        const run=records.get(id);
        if(run?.attachments?.length)await attachmentStore.removeRun(run,run.attachmentWorkspace?restoredWorkspace(run.attachmentWorkspace):run.cwd);
        await removeArchive(id);
        await checkpoints.remove(id);
        await fs.unlink(filename(id)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }catch(error){
        // Keep the record available for retry if filesystem cleanup fails.
        if(selected)await selectRun(id).catch(()=>{});
        throw error;
      }
      records.delete(id);journals.delete(id);writes.delete(id);
      if(scheduledItem(id))await scheduler.remove(id).catch(()=>{});
      if(current?.id===id)current=null;
    })();
    removals.set(id,operation);
    try{return await operation;}finally{removals.delete(id);}
  }
  async function pruneHistory(){const old=[...records.values()].filter(run=>run.pinned!==true).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(HISTORY_LIMIT);for(const run of old){if(activeRuns.has(run.id)||principalManager.hasActive(run.id)||run.recoverable||!memory?.canPrune(run.id))continue;await removeStoredRun(run.id);}}
  for(const entry of await fs.readdir(historyDir,{withFileTypes:true})) {
    if(!entry.isFile()||!RUN_ID.test(entry.name.slice(0,-5))||!entry.name.endsWith('.json'))continue;
    const f=path.join(historyDir,entry.name);if((await fs.stat(f)).size>32*1024*1024)throw new Error('A saved run is too large to load');
    let run;try{run=JSON.parse(await fs.readFile(f,'utf8'));}catch{throw new Error('A saved run is unreadable');}
    if(run.id!==entry.name.slice(0,-5)||typeof run.startedAt!=='string'||!Array.isArray(run.events)||!Array.isArray(run.blackboard))throw new Error('A saved run has an unsupported format');
    run=safe(run);run.taskMode??='auto';hydrateOutcomes(run);if(ACTIVE.has(run.status)){
      run.status='interrupted';run.finishedAt=new Date().toISOString();run.errorCode='application_restarted';run.error='应用重新启动，上次未完成的任务已标记为中断，未自动续跑。';
      try{await persist(run);}catch(error){rememberStorageFailure(error,{run,operation:'save_interrupted_run',path:f});run.error+=' 中断状态未能保存，请迁移数据目录后保存。';}
    }
    run.recoverable=false;
    if(run.status!=='completed')try{const saved=await checkpoints.read(run.id);if(saved){validateRecovery(saved,run);run.recoverable=true;run.lastCheckpointAt=saved.savedAt;}}catch(error){run.recoveryError=safe(error.message);}
    for(const detail of Array.isArray(run.storageErrors)?run.storageErrors:[run.storageError].filter(Boolean)){storageWarnings.push(detail);if(storageWarnings.length>50)storageWarnings.shift();}
    records.set(run.id,run);if(!current||run.startedAt>current.startedAt)current=run;
  }
  // An explicit empty selection survives restart. Profiles created before this
  // feature keep their existing latest-run behavior until a start or clear.
  try {
    if((await fs.lstat(currentFilename())).isSymbolicLink())throw new Error('Current task selection cannot be a symbolic link');
    const selected=JSON.parse(await fs.readFile(currentFilename(),'utf8'));
    if(selected?.version!==1||(selected.runId!==null&&(typeof selected.runId!=='string'||!RUN_ID.test(selected.runId))))throw new Error('Saved current task selection is invalid');
    current=selected.runId===null?null:records.get(selected.runId)||null;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  memory=openMemory();
  if(requireMemoryReady&&!await memory.start()){
    await memory.close();
    throw new Error('所选目录的记忆数据无法加载，原记录已保留，请检查目录后重试。');
  }
  try{await pruneHistory();}catch(error){if(!error.fatalStorage&&!['ENOSPC','EDQUOT','EACCES','EPERM','EIO','EROFS','STORAGE_ERROR'].includes(error.code))throw error;rememberStorageFailure(error,{operation:'prune_history',path:historyDir});}
  const publicAgent=a=>({...a,hasKey:Boolean(store.secrets[a.id])});
  const publicJudge=()=>({...store.config.judge,hasApiKey:Boolean(store.secrets[JUDGE_SECRET_ID])});
  const snapshot=()=>({agents:store.config.agents.map(publicAgent),settings:{...store.config.settings},judge:publicJudge(),modes:publicModes(store.config.modes,store.config.extensions,{metadataOnly:true}),run:current?safe(current):null,runs:[...activeRuns.values()].map(item=>safe(item.run)),history:[...records.values(),...scheduledRuns()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).map(summary),dataDir,relocating,storageWarnings:safe(storageWarnings),...(migrationWarning?{migrationWarning}:{}),...(recoveryLauncher?{recoveryLauncher}:{}),version:VERSION,update:updateStatus()});
  let updateTransition=false, updateRuns=[], updateStorageBefore;
  const updateStatus=()=>updater?.status()??{state:'idle',version:VERSION,supported:false};
  const available=({transition=false}={})=>{if(updateTransition)fail(409,'Class正在准备更新');if(relocating||dataTransition&&!transition)fail(409,'Data directory migration is in progress');if(closing)fail(503,'Application is shutting down');};
  const idle=(options)=>{available(options);if(chooser)fail(409,'Finish or cancel directory selection before continuing');if(activeRuns.size||starting)fail(409,'请先停止所有正在运行的任务');};
  async function beginDataTransition(){idle();dataTransition=true;try{await scheduler.close();}catch(error){dataTransition=false;throw error;}}
  async function endDataTransition({loaded=false}={}){try{if(!closing&&!loaded)scheduler=await openScheduler({markOverdueMissed:false});}finally{dataTransition=false;}}
  const provider=(a,{forCheck=false}={})=>({baseUrl:a.baseUrl,protocol:a.protocol,model:a.model,...(a.reasoningEffort===undefined?{}:{reasoningEffort:a.reasoningEffort}),context1M:!forCheck&&a.context1M===true,jsonMode:a.jsonMode,timeoutMs:store.config.settings.modelTimeoutMs,apiKey:store.secrets[a.id]||''});
  function judgeDraft(body) {
    const allowed=new Set(['enabled','mode','protocol','baseUrl','model','apiKey','clearKey','features','timeoutMs','maxConcurrency','minOutputChars']);
    if(Object.keys(body).some(key=>!allowed.has(key)))fail(400,'未知 Jev 设置');
    if(body.clearKey!==undefined&&typeof body.clearKey!=='boolean')fail(400,'清除密钥选项必须为布尔值');
    if(body.apiKey!==undefined&&(typeof body.apiKey!=='string'||body.apiKey.length>4096))fail(400,'Jev 密钥格式无效');
    if(body.features!==undefined&&!object(body.features))fail(400,'Jev 判断范围格式无效');
    const {clearKey,apiKey:given,...changes}=body;
    const apiKey=clearKey?'':given?.trim()||store.secrets[JUDGE_SECRET_ID]||'';
    let config;
    try{config=normalizeJudgeConfig({...store.config.judge,...changes,features:{...store.config.judge.features,...changes.features},apiKey});}
    catch(error){fail(400,error.message);}
    return config;
  }
  function requestStop(id,reason='user_stopped') {
    const execution=activeRuns.get(id);if(!execution)return records.get(id);execution.stopRequested=true;execution.run.status='stopping';execution.engine.stop(reason);return execution.run;
  }
  async function stopAllRuns(){const executions=[...activeRuns.values()];for(const item of executions)requestStop(item.run.id,'application_shutdown');await Promise.all(executions.map(item=>item.promise));}
  async function clearRun(id) {
    if(closing)fail(503,'Application is shutting down');
    if(chooser)fail(409,'Finish or cancel directory selection before clearing a task');
    if(!records.has(id))fail(404,'Task not found');
    await principalManager.cancel(id,undefined,'该课堂正在删除，校长请求已取消');
    // Capture the exact execution being removed. Never stop an unrelated task
    // when clearing an older record currently displayed in the workspace.
    const execution=activeRuns.get(id);
    if(execution){requestStop(id,'user_cleared');await execution.promise;}
    const forgotten=await memory.forgetSession(id);
    try{await removeStoredRun(id,{discardFailedWrites:true});}
    catch(error){const failure=rememberStorageFailure(error,{run:records.get(id),operation:'clear_run',path:filename(id)});failure.status=500;throw failure;}
    return {ok:true,deletedId:id,...snapshot(),...(forgotten.memoryCleanupPending?{memoryCleanupPending:true,warning:forgotten.warning}:{})};
  }
  function scheduledItem(id){return scheduler?.list().items.find(item=>item.id===id);}
  function scheduleRun(item){
    const payload=item.payload||{},taskSpec={name:item.name,description:item.description,goal:item.goal};
    return {id:item.runId,status:{pending:'scheduled',dispatched:'starting',interrupted:'missed'}[item.status]||item.status,task:taskSpecText(taskSpec),taskSpec,title:item.name,taskMode:payload.taskMode||'auto',taskModeName:taskModeName(payload.taskMode||'auto',payload.taskModeDefinition),schedule:{at:item.scheduledAt,timeZone:item.timezone},startedAt:item.createdAt,finishedAt:null,events:[],blackboard:[],outcomes:[],attachments:payload.attachments||[],error:item.reason||null,scheduled:true,recoverable:false};
  }
  function scheduledRuns(){return (scheduler?.list().items||[]).filter(item=>!records.has(item.runId)&&item.status!=='started').map(scheduleRun);}
  async function openScheduler({markOverdueMissed=true}={}){
    return createTaskScheduler({directory:dataDir,markOverdueMissed,lookupRun:id=>records.has(id),onDue:async({schedule,runId})=>{
      available();
      return serial(()=>{available();if(records.has(runId))return records.get(runId);return startRun({},undefined,schedule);});
    },onError:error=>{if(error.fatalStorage)rememberStorageFailure(error,{operation:'schedule_task',path:path.join(dataDir,'task-schedules.json')});}});
  }
  async function createSchedule(body){
    available();if(body.demo)fail(400,'演示任务不支持定时');
    const spec=normalizeTaskSpec(body.taskSpec),schedule=normalizeSchedule(body.schedule);
    if(Date.parse(schedule.at)<=Date.now())fail(400,'启动时间必须晚于当前时间');
    let taskMode,taskModeDefinition;try{taskMode=normalizeTaskMode(body.taskMode);taskModeDefinition=resolveModeDefinition(taskMode,store.config.modes);}catch(error){fail(400,error.message);}
    const agents=store.config.agents.filter(agent=>agent.role!=='principal');
    if(agents.filter(agent=>agent.role==='teacher').length!==1||agents.filter(agent=>agent.role==='student').length<2)fail(400,'请先配置一位老师和至少两位学生');
    if(agents.some(agent=>!store.secrets[agent.id]))fail(400,'请先配置所有成员的密钥');
    const settings=await normalizeSettings({},store.config.settings),runId=`run-${randomUUID()}`,root=settings.cwd;
    await checkTaskStorage(root,'schedule_task');
    settings.cwd=await createRunWorkspace(root,runId);
    const attachmentIds=body.attachmentIds??[],prepared=await attachmentStore.prepare(attachmentIds,runId,settings.cwd);
    const payload={taskMode,...(taskModeDefinition?{taskModeDefinition}:{}),agentIds:agents.map(agent=>agent.id),settings,workspace:checkpointWorkspace(settings.cwd),projectWorkspace:checkpointWorkspace(root),attachmentIds,attachments:prepared.attachments};
    try{await prepared.commit();await scheduler.create({id:runId,...spec,scheduledAt:schedule.at,timezone:schedule.timeZone,payload});}
    catch(error){await prepared.rollback().catch(()=>{});throw error;}
    return scheduleRun(scheduledItem(runId));
  }
  async function editSchedule(id,body){
    available();if(Object.keys(body).some(key=>!['taskSpec','taskMode','schedule'].includes(key))||!Object.keys(body).length)fail(400,'只能编辑待执行任务的内容、模式和时间');
    const previous=scheduledItem(id);if(!previous||records.has(id))fail(409,'该任务已经开始，不能编辑');
    const spec=body.taskSpec===undefined?{name:previous.name,description:previous.description,goal:previous.goal}:normalizeTaskSpec(body.taskSpec);
    const schedule=body.schedule===undefined?{at:previous.scheduledAt,timeZone:previous.timezone}:normalizeSchedule(body.schedule);
    let taskMode,taskModeDefinition;try{taskMode=body.taskMode===undefined?previous.payload.taskMode:normalizeTaskMode(body.taskMode);taskModeDefinition=body.taskMode===undefined?previous.payload.taskModeDefinition:resolveModeDefinition(taskMode,store.config.modes);}catch(error){fail(400,error.message);}
    const agents=store.config.agents.filter(agent=>agent.role!=='principal');
    if(agents.filter(agent=>agent.role==='teacher').length!==1||agents.filter(agent=>agent.role==='student').length<2||agents.some(agent=>!store.secrets[agent.id]))fail(400,'请先配置一位老师、至少两位学生及其密钥');
    const payload={...previous.payload,agentIds:agents.map(agent=>agent.id),taskMode,...(taskModeDefinition?{taskModeDefinition}:{})};if(!taskModeDefinition)delete payload.taskModeDefinition;
    await scheduler.update(id,{...spec,scheduledAt:schedule.at,timezone:schedule.timeZone,payload});return scheduleRun(scheduledItem(id));
  }
  async function deleteSchedule(id){
    const item=scheduledItem(id);if(!item)fail(404,'Task not found');
    if(item.status!=='cancelled')await scheduler.cancel(id);
    if(item.payload.attachments?.length)await attachmentStore.removeRun({id,attachments:item.payload.attachments},restoredWorkspace(item.payload.workspace));
    await scheduler.remove(id);return {ok:true,deletedId:id,...snapshot()};
  }
  async function startRun(body,resuming,scheduled) {
    available();if(resuming&&clearingRuns.has(resuming.id))fail(409,'该任务正在删除');if(resuming&&activeRuns.has(resuming.id))fail(409,'该任务已经在运行');starting++;memory.pauseBackground();
    try{return await prepareRun(body,resuming,scheduled);}finally{starting--;}
  }
  async function prepareRun(body,resuming,scheduled) {
    const configuration=structuredClone(store.config),secrets=structuredClone(store.secrets);
    let recovered;
    if(resuming){if(resuming.status==='completed')fail(409,'已完成的任务不能续跑');try{recovered=validateRecovery(await checkpoints.read(resuming.id),resuming);}catch(error){fail(409,error.message);}}
    const demo=recovered?recovered.metadata.demo===true:body.demo===true;
    if(body.demo!==undefined&&typeof body.demo!=='boolean')fail(400,'demo must be boolean');
    let taskMode,taskModeDefinition;
    try{
      taskMode=normalizeTaskMode(recovered?recovered.state.taskMode:scheduled?.payload.taskMode??body.taskMode);
      taskModeDefinition=recovered?normalizeTaskModeDefinition(taskMode,recovered.state.taskModeDefinition):scheduled?normalizeTaskModeDefinition(taskMode,scheduled.payload.taskModeDefinition):resolveModeDefinition(taskMode,configuration.modes);
    }catch(error){fail(400,error.message);}
    const taskSpec=recovered?resuming.taskSpec:scheduled?normalizeTaskSpec({name:scheduled.name,description:scheduled.description,goal:scheduled.goal}):body.taskSpec===undefined?undefined:normalizeTaskSpec(body.taskSpec);
    const task=recovered?recovered.state.task:taskSpec?taskSpecText(taskSpec):demo?'求 1 到 100 的整数之和，并验证。':requiredText(body.task,'task',20000);
    const runId=resuming?.id??scheduled?.runId??`run-${randomUUID()}`;
    if(records.has(runId)&&!resuming)fail(409,'任务已经启动，不能重复执行');
    const sourceSettings=recovered?{...configuration.settings,...recovered.metadata.settings,cwd:restoredWorkspace(recovered.metadata)}:scheduled?{...configuration.settings,...scheduled.payload.settings,cwd:restoredWorkspace(scheduled.payload.workspace)}:configuration.settings;
    const settings=await normalizeSettings({},sourceSettings);
    const workspaceRoot=recovered?(recovered.metadata.projectWorkspace?restoredWorkspace(recovered.metadata.projectWorkspace):settings.cwd):scheduled?(scheduled.payload.projectWorkspace?restoredWorkspace(scheduled.payload.projectWorkspace):settings.cwd):settings.cwd;
    if(!recovered&&!scheduled)settings.cwd=await createRunWorkspace(workspaceRoot,runId);
    if(recovered&&Object.hasOwn(recovered.metadata,'workspaceRelative')){
      const root=await fs.realpath(path.join(dataDir,'workspace'));
      if(!insideWorkspace(path.relative(root,settings.cwd)))fail(409,'续跑工作目录不能通过链接超出当前 workspace');
      if(path.relative(recovered.metadata.cwd,settings.cwd)!==''){
        const state=recovered.state.engine;
        if(!object(state))fail(409,'续跑快照缺少工作状态');
        state.resumeWarnings=[...(Array.isArray(state.resumeWarnings)?state.resumeWarnings:[]).filter(item=>item?.callId!=='workspace:moved'),{callId:'workspace:moved',toolName:'workspace',previousCwd:recovered.metadata.cwd,cwd:settings.cwd,resolved:false,reason:`工作目录已从 ${recovered.metadata.cwd} 迁移到 ${settings.cwd}。不要复用历史中的旧绝对路径或自动重放迁移前的操作；必须先用只读工具核查新目录中的文件和任务结果，再由老师通过 recoveryChecks 引用本次新证据确认 workspace:moved。`}];
      }
    }
    try{await checkTaskStorage(settings.cwd,'start_task');}
    catch(error){throw rememberStorageFailure(error,{operation:'start_task',path:dataDir});}
    const projectId=memoryProjectId(workspaceRoot);
    const selectedAgents=(recovered&&!demo?recovered.metadata.agents.map(agent=>configuration.agents.find(current=>current.id===agent.id)):scheduled?scheduled.payload.agentIds.map(id=>configuration.agents.find(agent=>agent.id===id)):configuration.agents).filter(agent=>agent&&agent.role!=='principal');
    if(scheduled&&selectedAgents.length!==scheduled.payload.agentIds.length)fail(409,'定时任务的成员已变更，请编辑任务后重试');
    const runtimeProvider=agent=>({...agent,timeoutMs:settings.modelTimeoutMs,apiKey:secrets[agent.id]||''});
    const identities=demo?{teacher:'demo-teacher',students:[]}:{teacher:selectedAgents.find(a=>a.role==='teacher')?.id,students:selectedAgents.filter(a=>a.role==='student').map(a=>({id:a.id,name:a.name}))};
    const memoryAdapter=memory.settings.enabled?memory.forRun({runId,projectId,team:identities}):undefined;
    // Freeze one independent helper for this run; a demonstration never calls it.
    const judgment=new JudgmentLayer({...configuration.judge,...(demo?{enabled:false}:{}),apiKey:demo?'':secrets[JUDGE_SECRET_ID]||''},{
      knownSecrets:[...knownSecrets],
      onDecision:record=>engine.record('judge.decision',record),
      onUpdate:stats=>{run.judgeStats=stats;}
    });
    const archiveForPrincipal=configuration.agents.some(agent=>agent.role==='principal');
    const observer={onConversation:value=>memory.captureConversation(runId,value,{forceArchive:archiveForPrincipal}),judgment,taskMode,taskModeDefinition};
    let team,tools,teacherTools;
    if(demo)team=createDemo();else{
      const teachers=selectedAgents.filter(a=>a.role==='teacher'),students=selectedAgents.filter(a=>a.role==='student');
      if(teachers.length!==1||students.length<2||students.length>16)fail(400,'Configure exactly one teacher and 2–16 students');
      if(selectedAgents.some(a=>!secrets[a.id]))fail(400,'Every Agent needs an API key before starting');
      await checkpoints.getKey(true);
      const planningState=new Map();
      // A selected mode grants only its otherwise-unassigned defaults for this
      // task. Existing explicit member grants and the saved profile stay intact.
      // Old recovery points do not silently gain capabilities introduced later.
      const modePolicy = !recovered || recovered.metadata.extensionModeVersion === 1;
      const extensionConfig=buildModeExtensions(recovered?.metadata.extensions??configuration.extensions,{taskMode:modePolicy?taskMode:'auto',taskModeDefinition,agents:selectedAgents,grantModeDefaults:modePolicy});
      const extensionOptions={extensionConfig,extensionSecrets:extensionSecrets(secrets,extensionConfig),extensionOptions:{
        task,taskMode,planner:new ExtensionPlanner({judgment}),autoPrepare:true,cacheDir:path.join(dataDir,'mcp-runtimes'),
        runResources,resourceOwner:runId,
        onStatus:record=>engine.record('extension.status',record),
      }};
      tools=new ToolManager({cwd:settings.cwd,workspaceRoot,allowShell:settings.allowShell,planningState,memory:memoryAdapter,...extensionOptions});
      teacherTools=new ToolManager({cwd:settings.cwd,workspaceRoot,allowShell:true,planningState,memory:memoryAdapter,...extensionOptions});
      team={teacher:createTeacher(teachers[0],runtimeProvider(teachers[0]),teacherTools,observer),students:students.map(a=>createStudent(a,runtimeProvider(a),tools,observer))};
    }
    const journal=journalFor(runId);
    const attachmentIds=recovered?(recovered.metadata.attachmentIds??(resuming.attachments||[]).map(item=>item.id)):(scheduled?.payload.attachmentIds??body.attachmentIds??[]);
    const preparedAttachments=await attachmentStore.prepare(attachmentIds,runId,settings.cwd,{resume:Boolean(recovered||scheduled)});
    const attachments=preparedAttachments.attachments;
    const checkpointMetadata={version:1,demo,taskMode,...(taskModeDefinition?{taskModeDefinition}:{}),extensionModeVersion:recovered?.metadata.extensionModeVersion??(!recovered?1:0),...checkpointWorkspace(settings.cwd),projectWorkspace:checkpointWorkspace(workspaceRoot),settings,extensions:recovered?.metadata.extensions??configuration.extensions,agents:demo?[]:selectedAgents.map(memberIdentity),attachmentIds:attachments.map(item=>item.id)};
    const engine=new ClassEngine({...settings,...team,tools,teacherTools,journal,attachments,taskMode,taskModeDefinition,resumeState:recovered?.state,onCheckpoint:demo?undefined:async(state,{reason})=>{
      try {
        const receipt=await checkpoints.write(runId,state,{...checkpointMetadata,reason});run.lastCheckpointAt=receipt.savedAt;run.recoverable=state.terminalStatus!=='completed';
      } catch(error) {
        // The engine converts a terminal checkpoint failure into its result;
        // retain the storage failure separately so update handoff cannot commit.
        throw rememberStorageFailure(error,{run,operation:'save_checkpoint',path:checkpoints.filename(runId)});
      }
    },...(demo?{discoveryWindowMs:150,taskTimeoutMs:10000}:{} )});
    const run=resuming?{...resuming,status:'running',phase:'solving',finishedAt:null,result:null,error:null,errorCode:null,recoveryError:null,recoverable:false,resumedAt:new Date().toISOString(),resumeCount:(resuming.resumeCount||0)+1}: {id:runId,status:'running',phase:'solving',reviewRound:0,feedbackVersion:0,task,demo,startedAt:new Date().toISOString(),finishedAt:null,events:[],blackboard:[],outcomes:[],outcomesDropped:0,outcomesVersion:1,memberFailures:[],result:null,error:null,errorCode:null,eventsDropped:0,blackboardDropped:0,hasJournal:true,team:demo?{teacher:'demo-teacher',students:team.students.map(s=>({id:s.id,name:s.id}))}:identities};
    run.activitySummary??={commandStarted:0,commandSucceeded:0,commandFailed:0,commandCancelled:0,formatRejected:0,formatCorrected:0,formatNormalized:0,publicProgress:0,submittedAnswers:0};
    run.judgeStats=judgment.getStats();
    run.cwd=settings.cwd;run.workspaceRoot=workspaceRoot;run.projectId=projectId;run.attachments=attachments;run.taskMode=taskMode;run.taskModeName=taskModeName(taskMode,taskModeDefinition);
    if(taskSpec){run.taskSpec=taskSpec;if(!resuming)run.title=taskSpec.name;}
    if(scheduled)run.schedule={at:scheduled.scheduledAt,timeZone:scheduled.timezone};
    if(taskModeDefinition)run.taskModeDefinition=structuredClone(taskModeDefinition);
    if(attachments.length)run.attachmentWorkspace=checkpointWorkspace(settings.cwd);
    memory.registerRun(run);
    try{
      await preparedAttachments.commit();
      await journal.append({kind:resuming?'run_resume':'run',task,demo,taskMode,taskModeName:run.taskModeName,...(taskModeDefinition?{taskModeDefinition}:{}),attachments,cwd:settings.cwd,projectId,startedAt:run.startedAt,team:run.team,...(resuming?{resumedAt:run.resumedAt}: {})});
      await persist(run);await selectRun(run.id);
    }
    catch(error){
      await preparedAttachments.rollback().catch(()=>{});
      const failure=rememberStorageFailure(error,{operation:'start_task_record',path:filename(run.id)});
      if(!resuming){await removeArchive(run.id).catch(()=>{});await checkpoints.remove(run.id).catch(()=>{});await fs.unlink(filename(run.id)).catch(()=>{});journals.delete(run.id);writes.delete(run.id);}
      throw failure;
    }
    records.set(run.id,run);current=run;
    const execution={run,engine,tools,teacherTools,journal,judgment,stopRequested:false,storageError:null,promise:null,write:Promise.resolve(),timer:null,spaceTimer:null,spaceCheck:null};activeRuns.set(run.id,execution);
    function stopForStorage(error,operation,failurePath) {
      execution.storageError=rememberStorageFailure(error,{run,operation,path:failurePath});run.errorCode='storage_error';run.error=failureMessage('storage_error');
      engine.fail(execution.storageError);
    }
    function saveSoon(){if(execution.timer)return;execution.timer=setTimeout(()=>{execution.timer=null;execution.write=execution.write.then(()=>persist(run)).catch(error=>stopForStorage(error,'save_run',filename(run.id)));},250);}
    execution.spaceTimer=setInterval(()=>{
      if(execution.spaceCheck||activeRuns.get(run.id)!==execution||engine.finished||execution.storageError)return;
      execution.spaceCheck=checkTaskStorage(settings.cwd,'monitor_task').catch(error=>stopForStorage(error,'monitor_task',dataDir)).finally(()=>{execution.spaceCheck=null;});
    },5000);
    execution.spaceTimer.unref?.();
    engine.on('event',event=>{
      run.judgeStats=judgment.getStats();
      appendSummary(run,'events',event,'eventsDropped');
      const counters=run.activitySummary;
      if(event.type==='tool.spawned')counters.commandStarted++;
      if(event.type==='tool.completed'||event.type==='tool.failed'){
        if(event.executionStatus==='cancelled')counters.commandCancelled++;
        else if(event.type==='tool.failed'||event.success===false)counters.commandFailed++;
        else if(event.success===true)counters.commandSucceeded++;
      }
      if(event.type==='tool.validation_error'||(event.type==='tool.validation_retrying'&&['MODEL_RESULT_INVALID','MODEL_RESPONSE_INVALID','TOOL_CALL_PROTOCOL_INVALID'].includes(event.reasonCode)))counters.formatRejected++;
      if(event.type==='tool.validation_recovered'&&event.resolution==='valid_tool_batch')counters.formatCorrected++;
      if(event.type==='tool.validation_normalized')counters.formatNormalized++;
      if(event.type==='outcome.upsert'&&event.entry?.submissionType==='progress')counters.publicProgress++;
      if(event.type==='outcome.upsert'&&event.entry?.submissionType==='answer'&&event.entry.status==='pending')counters.submittedAnswers++;
      run.memberFailures=safe(engine.getMemberFailures());
      if(event.type==='phase.changed')run.phase=event.phase;
      if(Number.isSafeInteger(event.reviewRound))run.reviewRound=event.reviewRound;
      if(Number.isSafeInteger(event.feedbackVersion))run.feedbackVersion=event.feedbackVersion;
      if(event.type==='discovery.decided')appendSummary(run,'blackboard',event,'blackboardDropped');
      if(event.type==='feedback.published'&&event.entry){appendSummary(run,'blackboard',event.entry,'blackboardDropped');run.feedbackVersion=event.entry.feedbackVersion??run.feedbackVersion;run.reviewRound=event.entry.reviewRound??run.reviewRound;}
      if(event.type==='outcome.upsert'&&event.entry)upsertOutcome(run,event.entry);
      saveSoon();
    });
    execution.promise=(async()=>{
      let result;
      try{result=await engine.run(task);}catch(error){if(error.fatalStorage||error.code==='STORAGE_ERROR')stopForStorage(error,'run_task',dataDir);result={status:'failed',reason:error.fatalStorage||error.code==='STORAGE_ERROR'?'storage_error':safe(error.message)};}
      clearInterval(execution.spaceTimer);execution.spaceTimer=null;await execution.spaceCheck;
      // Do not release the running reservation until every managed tool has exited.
      await Promise.all([tools,teacherTools].filter(Boolean).map(async manager=>{while(true){try{await manager.stopAll();break;}catch(error){run.status='stopping';run.error='Waiting for tool cleanup: '+safe(error.message);await persist(run).catch(()=>{});if(manager.children.size===0)break;await new Promise(r=>setTimeout(r,1000));}}}));
      clearTimeout(execution.timer);execution.timer=null;await execution.write;
      try{await journal.flush();}catch(error){execution.storageError=rememberStorageFailure(error,{run,operation:'flush_journal',path:journal.filename});}
      if(execution.storageError)result={...result,status:'failed',reason:'storage_error'};
      run.judgeStats=judgment.getStats();
      execution.finalizing=true;
      const finalRun={...run,status:execution.storageError||result.status==='failed'?'failed':execution.stopRequested||result.status==='stopped'?'stopped':result.status==='completed'?'completed':'failed',finishedAt:new Date().toISOString(),result:safe({...result,events:undefined,blackboard:undefined,outcomes:undefined})};
      if(finalRun.status==='completed'){finalRun.recoverable=false;await checkpoints.remove(run.id).catch(error=>rememberStorageFailure(error,{run:finalRun,operation:'remove_completed_checkpoint',path:checkpoints.filename(run.id)}));}
      if(finalRun.status==='failed'){finalRun.errorCode=/\bstorage_error\b/i.test(result.reason||'')?'storage_error':['TOOL_ARGUMENT_REPAIR_EXHAUSTED','TOOL_CALL_PROTOCOL_INVALID'].includes(result.errorCode)?result.errorCode:safe(result.reason||'task_failed');finalRun.error=safe(failureMessage(finalRun.errorCode==='storage_error'?'storage_error':result.reason||finalRun.errorCode));}
      else {finalRun.error=null;finalRun.errorCode=null;}
      try{await persist(finalRun);await pruneHistory();}catch(error){
        rememberStorageFailure(error,{run:finalRun,operation:'save_final_run',path:filename(run.id)});
        finalRun.error='任务已结束，但保存结果或清理历史档案失败。';finalRun.errorCode='storage_error';finalRun.status='failed';
        try{await persist(finalRun);}catch(retryError){rememberStorageFailure(retryError,{run:finalRun,operation:'save_final_run_retry',path:filename(run.id)});}
      }
      Object.assign(run,finalRun);if(activeRuns.get(run.id)===execution)activeRuns.delete(run.id);
      memory.finishRun(run);
      return run;
    })();
    return run;
  }
  let server;
  function assertUpdateSafe() {
    if(updateRuns.some(run=>run.errorCode==='storage_error'||run.storageError)
      || updateStorageBefore&&storageWarnings.some(item=>!updateStorageBefore.has(item))) throw Error('任务记录未完整保存，更新已取消');
  }
  async function prepareUpdate() {
    available();if(chooser)fail(409,'请先完成目录选择');
    updateTransition=true;updateStorageBefore=new Set(storageWarnings);
    const restore=async()=>{if(!closing){scheduler=await openScheduler({markOverdueMissed:false});updateTransition=false;}};
    try {
      await scheduler.close();await mutations;
      updateRuns=[...activeRuns.values()].map(item=>item.run);
      await stopAllRuns();assertUpdateSafe();
      return restore;
    } catch(error) {await restore();throw error;}
  }
  async function close() {
    if(closePromise)return closePromise;
    closing=true;const principalClosing=principalManager.close();for(const controller of checks)controller.abort(new Error('Application shutdown'));chooser?.controller.abort(new Error('Application shutdown'));closePromise=(async()=>{await updater?.close();await scheduler?.close();await mutations;await chooser?.promise?.catch(()=>{});await Promise.all([stopAllRuns(),principalClosing,finishMcpTests()]);await memory.close();if(server?.listening)await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections?.();});})();return closePromise;
  }
  scheduler=await openScheduler();
  server=http.createServer(async(req,res)=>{
    try{
      const address=server.address(),expectedPort=typeof address==='object'?address.port:port;
      const hosts=new Set([`127.0.0.1:${expectedPort}`,`localhost:${expectedPort}`]);
      if(!hosts.has((req.headers.host||'').toLowerCase()))fail(403,'Invalid local Host');
      const origin=req.headers.origin;
      if(origin&&![`http://127.0.0.1:${expectedPort}`,`http://localhost:${expectedPort}`].includes(origin))fail(403,'Cross-origin access is not allowed');
      if(req.headers['sec-fetch-site']==='cross-site')fail(403,'Cross-site access is not allowed');
      const url=new URL(req.url,`http://127.0.0.1:${expectedPort}`);
      if(url.pathname==='/health'&&req.method==='GET'){send(res,200,{app:'class',version:VERSION});return;}
      if(url.pathname.startsWith('/api/')){
        const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))fail(401,'Local access token is missing or invalid');
        if(closing&&url.pathname!=='/api/state')fail(503,'Application is shutting down');
        if(url.pathname==='/api/state'&&req.method==='GET'){res.once('finish',()=>updater?.acknowledgeRestart?.());send(res,200,snapshot());return;}
        if(url.pathname==='/api/update'&&req.method==='GET'){res.once('finish',()=>updater?.acknowledgeRestart?.());send(res,200,updateStatus());return;}
        if(url.pathname==='/api/update'&&req.method==='POST'){
          const body=await readBody(req);if(Object.keys(body).length)fail(400,'更新请求不接受其他字段');
          if(closing)fail(503,'Application is shutting down');if(relocating||dataTransition)fail(409,'Data directory migration is in progress');
          send(res,202,updater?updater.start({prepareRestart:prepareUpdate,dataDir}):{state:'failed',version:VERSION,supported:false,message:'更新失败'});return;
        }
        if(updateTransition&&req.method!=='GET')fail(409,'Class正在准备更新');
        const principalRoute=url.pathname.match(/^\/api\/runs\/(run-[0-9a-f-]{36})\/principal(?:\/(principal-[0-9a-f-]{36})(\/cancel)?)?$/);
        if(principalRoute){
          if(relocating)fail(409,'Data directory migration is in progress');
          const run=records.get(principalRoute[1]);if(!run||removals.has(run.id))fail(404,'Task not found');
          const reportId=principalRoute[2];
          if(req.method==='GET'&&!principalRoute[3]){send(res,200,reportId?{report:await principalManager.get(run.id,reportId)}:{reports:await principalManager.reports(run.id)});return;}
          if(req.method==='POST'){
            const directory=dataDir,body=await readBody(req);
            if(closing)fail(503,'Application is shutting down');if(relocating||directory!==dataDir||removals.has(run.id)||!records.has(run.id))fail(409,'课堂正在切换或删除，请稍后重试');
            if(reportId&&principalRoute[3]){if(Object.keys(body).length)fail(400,'取消请求不接受其他字段');send(res,200,{report:await principalManager.cancel(run.id,reportId)});return;}
            if(!reportId){
              if(Object.keys(body).some(key=>key!=='question'))fail(400,'校长提问只接受 question');
              const principal=store.config.agents.find(agent=>agent.role==='principal');
              if(!principal)fail(400,'请先在教室管理中配置校长');if(!store.secrets[principal.id])fail(400,'请先配置校长的 API Key');
              send(res,202,{report:principalManager.ask(records.get(run.id),principal,provider(principal),body.question)});return;
            }
          }
          fail(404,'Principal API route not found');
        }
        if(url.pathname==='/api/attachments'&&req.method==='GET'){send(res,200,{attachments:await serial(()=>{if(closing)fail(503,'Application is shutting down');return attachmentStore.pending();})});return;}
        if(url.pathname==='/api/attachments'&&req.method==='POST'){
          const uploadDirectory=dataDir;
          const body=await readBody(req,ATTACHMENT_BODY_LIMIT);
          const attachment=await serial(async()=>{if(closing)fail(503,'Application is shutting down');if(relocating||dataDir!==uploadDirectory)fail(409,'数据目录已改变，请重新上传附件');if(chooser)fail(409,'请先完成目录选择');return attachmentStore.upload(body);});
          send(res,201,{attachment});return;
        }
        const attachmentRoute=url.pathname.match(/^\/api\/attachments\/(attachment-[0-9a-f-]{36})$/);
        if(attachmentRoute&&req.method==='DELETE'){req.resume();send(res,200,await serial(()=>{if(closing)fail(503,'Application is shutting down');return attachmentStore.removePending(attachmentRoute[1]);}));return;}
        if(url.pathname==='/api/modes'&&req.method==='GET'){send(res,200,publicModes(store.config.modes,store.config.extensions));return;}
        if(url.pathname==='/api/modes'&&['POST','DELETE'].includes(req.method)){
          const directory=dataDir,body=await readBody(req,1024*1024);
          const result=await serial(async()=>{
            available();if(directory!==dataDir)fail(409,'数据目录已改变，请刷新后重试');
            const modes=req.method==='POST'?addMode(body,store.config.modes,store.config.extensions):deleteModes(body,store.config.modes);
            await store.save({...store.config,modes});
            return publicModes(store.config.modes,store.config.extensions);
          });send(res,req.method==='POST'?201:200,result);return;
        }
        if(url.pathname==='/api/extensions'&&req.method==='GET'){send(res,200,publicExtensions(store.config.extensions,store.secrets,store.config.agents));return;}
        if(url.pathname==='/api/extensions'&&req.method==='DELETE'){
          const directory=dataDir,body=await readBody(req);
          const result=await serial(async()=>{
            available();if(directory!==dataDir)fail(409,'数据目录已改变，请刷新后重试');
            if(mcpTests.size||mcpProbeManagers.size)fail(409,'MCP连接测试进行中，请稍后删除');
            const next=prepareExtensionDeletion(body,store.config.extensions,store.config.agents,store.secrets);
            await store.save({...store.config,extensions:next.extensions,modes:pruneModeExtensions(store.config.modes,next.extensions)},next.secrets);
            return publicExtensions(store.config.extensions,store.secrets,store.config.agents);
          });send(res,200,result);return;
        }
        if(url.pathname==='/api/extensions/test'&&req.method==='POST'){
          const directory=dataDir,body=await readBody(req);
          if(Object.keys(body).some(key=>key!=='id'&&key!=='revision'))fail(400,'MCP连接测试只接受 id 和 revision');
          const id=requiredText(body.id,'id',128);
          if(!Number.isSafeInteger(body.revision)||body.revision<0)fail(400,'Invalid MCP configuration revision');
          const controller=new AbortController(),disconnected=()=>controller.abort(new Error('Connection check cancelled'));
          res.once('close',disconnected);req.once('aborted',disconnected);
          if(req.aborted||res.destroyed)disconnected();
          try{
            // Serialize only the saved snapshot, never the network operation.
            // Configuration changes and classroom tasks remain independent.
            const {operation}=await serial(()=>{
              if(closing)fail(503,'Application is shutting down');
              if(relocating||directory!==dataDir)fail(409,'数据目录已改变，请重新测试');
              if(body.revision!==store.config.extensions.revision)fail(409,'MCP配置已更新，请刷新后重试');
              const saved=store.config.extensions.mcps.find(item=>item.id===id);
              if(!saved)fail(404,'MCP configuration not found');
              if(mcpTests.size||mcpProbeManagers.size)fail(409,'已有MCP连接测试进行中，请稍后重试');
              if(controller.signal.aborted)fail(499,'MCP连接测试已取消');
              const config={revision:body.revision,mcps:[{...structuredClone(saved),enabled:true,agentIds:[probeAgent]}],skills:[]};
              let secrets,manager;
              try{
                // Temporary authorization also validates credentials that are
                // bound to a saved, currently disabled server configuration.
                const available=extensionSecrets(store.secrets,config);
                secrets=available[id]?{[id]:available[id]}:{};
                manager=new ToolManager({cwd:store.config.settings.cwd,allowShell:false,extensionConfig:config,extensionSecrets:secrets,extensionOptions:{timeoutMs:mcpTestTimeoutMs,runResources,resourceOwner:'probe-'+randomUUID()}});
              }catch(error){fail(error?.status===409?409:400,error?.status===409?'MCP配置已变化，请重新保存对应凭据后测试。':'MCP配置无效，请检查保存的连接设置。');}
              checks.add(controller);mcpProbeManagers.add(manager);
              const operation=testMcpConnection(manager,id,controller);mcpTests.add(operation);
              operation.then(()=>mcpTests.delete(operation),()=>mcpTests.delete(operation));
              return {operation};
            });
            const result=await operation;if(!res.destroyed)send(res,200,result);
          }finally{checks.delete(controller);res.off('close',disconnected);req.off('aborted',disconnected);}
          return;
        }
        if(url.pathname==='/api/extensions'&&req.method==='PUT'){
          const directory=dataDir,body=await readBody(req,2*1024*1024);
          const result=await serial(async()=>{
            available();if(directory!==dataDir)fail(409,'数据目录已改变，请刷新后重试');
            const next=prepareExtensionUpdate(body,store.config.extensions,store.config.agents,store.secrets);
            assertBuiltinExtensionsPreserved(store.config.extensions,next.extensions);
            const deleting=Object.keys({mcps:0,skills:0}).some(kind=>store.config.extensions[kind].some(item=>!next.extensions[kind].some(candidate=>candidate.id===item.id)));
            if(deleting&&(mcpTests.size||mcpProbeManagers.size))fail(409,'MCP连接测试进行中，请稍后删除');
            await store.save({...store.config,extensions:next.extensions,modes:pruneModeExtensions(store.config.modes,next.extensions)},next.secrets);
            for(const secret of extensionSecretValues(store.secrets))knownSecrets.add(secret);
            return publicExtensions(store.config.extensions,store.secrets,store.config.agents);
          });send(res,200,result);return;
        }
        if(url.pathname.startsWith('/api/memory/')){
          if(relocating)fail(409,'Data directory migration is in progress');
          const admin={admin:true},query=Object.fromEntries(url.searchParams);
          if(query.projectId==='*')delete query.projectId;
          const endpoint=url.pathname.slice('/api/memory/'.length);
          if(endpoint==='status'&&req.method==='GET'){send(res,200,await memory.status());return;}
          if(endpoint==='entries'&&req.method==='DELETE'){
            req.resume();const result=await serial(async()=>{idle();return memory.clearMemories();});send(res,200,result);return;
          }
          if(endpoint==='settings'&&req.method==='PUT'){send(res,200,await serial(()=>readBody(req).then(body=>memory.configure(body))));return;}
          const sessionRoute=/^sessions\/([^/]+)$/.exec(endpoint),entryRoute=/^entries\/([^/]+)$/.exec(endpoint);
          if(sessionRoute&&req.method==='DELETE'){
            const id=decodeURIComponent(sessionRoute[1]);if(!RUN_ID.test(id))fail(400,'无效会话');req.resume();
            const result=await serial(async()=>{idle();const result=await memory.forgetSession(id);if(records.has(id))await removeStoredRun(id,{discardFailedWrites:true});return result;});send(res,200,result);return;
          }
          const index=await memory.requireStore();
          if(endpoint==='sessions/search'&&req.method==='POST'){
            const body=await readBody(req);if(body.projectId==='*')delete body.projectId;
            send(res,200,await index.sessionSearch(body,admin));return;
          }
          if(endpoint==='sessions'&&req.method==='GET'){send(res,200,await index.listSessions(query,admin));return;}
          if(endpoint==='source'&&req.method==='GET'){const result=await index.sessionGet({reference:query.reference,offset:query.offset,limit:query.limit},admin);if(!result)fail(404,'来源已删除或不存在');send(res,200,result);return;}
          if(sessionRoute&&req.method==='GET'){delete query.projectId;const result=await index.sessionGet({...query,sessionId:decodeURIComponent(sessionRoute[1])},admin);if(!result)fail(404,'会话不存在');send(res,200,result);return;}
          if(endpoint==='entries'&&req.method==='GET'){send(res,200,await index.listMemories(query,admin));return;}
          if(endpoint==='entries'&&req.method==='POST'){req.resume();fail(405,'长期记忆由系统自动生成，不支持手动新增');}
          if(entryRoute&&req.method==='GET'){const result=await index.memoryGet(decodeURIComponent(entryRoute[1]),admin);if(!result)fail(404,'记忆不存在');send(res,200,result);return;}
          if(entryRoute&&req.method==='PUT'){const id=decodeURIComponent(entryRoute[1]),body=await readBody(req);if(!await index.memoryGet(id,admin))fail(404,'记忆不存在');send(res,200,await index.saveMemory({...body,id},admin));return;}
          if(entryRoute&&req.method==='DELETE'){req.resume();send(res,200,await index.deleteMemory(decodeURIComponent(entryRoute[1]),admin));return;}
          if(endpoint==='rebuild'&&req.method==='POST'){req.resume();const result=await index.rebuild();memory.cursors.clear();memory.scan();send(res,200,result);return;}
          if(endpoint==='export'&&req.method==='GET'){send(res,200,await index.exportData(query,admin),{'Content-Disposition':'attachment; filename="class-memory.json"'});return;}
          if(endpoint==='jobs'&&req.method==='POST'){const body=await readBody(req);send(res,202,await memory.queueJob({type:body.type,sessionId:body.sessionId}));return;}
          fail(404,'Memory endpoint not found');
        }
        if(relocating&&req.method!=='GET')fail(409,'Data directory migration is in progress');
        if(url.pathname==='/api/judge'&&req.method==='GET'){send(res,200,{judge:publicJudge()});return;}
        if(url.pathname==='/api/judge'&&req.method==='PUT'){
          const body=await readBody(req);
          const judge=await serial(async()=>{
            available();const config=judgeDraft(body),secrets={...store.secrets};
            if(!config.apiKey)fail(400,'尚未配置Jev密钥');
            secrets[JUDGE_SECRET_ID]=config.apiKey;knownSecrets.add(config.apiKey);
            await store.save({...store.config,judge:storedJudgeConfig(config)},secrets);
            return publicJudge();
          });
          send(res,200,{judge});return;
        }
        if(url.pathname==='/api/judge/check'&&req.method==='POST'){
          const body=await readBody(req);available();const config=judgeDraft(body);
          if(!config.apiKey)fail(400,'请填写 Jev 密钥后测试连接');
          knownSecrets.add(config.apiKey);
          const controller=new AbortController();checks.add(controller);
          const disconnected=()=>controller.abort(new Error('Connection check cancelled'));res.once('close',disconnected);
          try{
            // This standalone check only classifies fixed sample text. No
            // JudgmentLayer, task, tool execution or persistent setting is used.
            const judge=new JevJudge({...config,enabled:true,features:{...config.features,toolResults:true}},{knownSecrets});
            const result=await judge.decide('toolResults',{state:{text:'1 + 1 = 2'},questions:{ready:{type:'boolean',instructions:'Does the text state that one plus one equals two?'}}},{signal:controller.signal});
            const ok=['ok','unclear'].includes(result.status);
            const messages={timeout:'Jev 请求超时',aborted:'连接测试已取消',rate_limited:'Jev 接口限流，请稍后重试',auth:'Jev 密钥无效或无权使用该模型',invalid:'Jev 接口返回格式不匹配',error:'无法连接 Jev，请检查地址、模型和网络'};
            if(!res.destroyed)send(res,200,{ok,status:result.status,message:ok?'Jev 连接成功；测试未保存设置':messages[result.status]||'Jev 连接测试未完成'});
          }finally{checks.delete(controller);res.off('close',disconnected);}
          return;
        }
        if(url.pathname==='/api/data-directory/load'&&req.method==='POST'){
          const body=await readBody(req);
          if(Object.keys(body).some(key=>key!=='path'))fail(400,'Unknown data directory option');
          const requested=requiredText(body.path,'path',32768);
          if(checks.size||mcpProbeManagers.size)fail(409,'Finish connection checks before loading another data directory');
          if(typeof dataDirectoryLoader!=='function')fail(400,'Loading another data directory requires the desktop launcher');
          await beginDataTransition();
          let result;try{result=await serial(async()=>{
            idle({transition:true});if(checks.size||mcpProbeManagers.size)fail(409,'Finish connection checks before loading another data directory');await principalManager.cancelAll('正在加载另一数据目录，校长请求已取消');
            if(typeof dataDirectoryLoader!=='function')fail(400,'Loading another data directory requires the desktop launcher');
            relocating=true;
            try{return await dataDirectoryLoader({path:requested});}
            catch(error){relocating=false;throw error;}
          });}finally{await endDataTransition({loaded:relocating});}
          send(res,200,result);return;
        }
        if(url.pathname==='/api/data-directory'&&req.method==='PUT'){
          const body=await readBody(req);
          if(Object.keys(body).some(key=>key!=='path'))fail(400,'Unknown data directory option');
          const requested=requiredText(body.path,'path',32768);
          if(checks.size||mcpProbeManagers.size)fail(409,'Finish connection checks before moving the data directory');
          await beginDataTransition();
          let result;try{result=await serial(async()=>{
            idle({transition:true});if(checks.size||mcpProbeManagers.size)fail(409,'Finish connection checks before moving the data directory');
            relocating=true;
            try{
              await principalManager.cancelAll('数据目录正在迁移，校长请求已取消');
              await memory.close();
              const pending=[...[...writes].map(([id,promise])=>({id,promise,path:filename(id),operation:'settle_run_before_migration'})),...[...journals].map(([id,journal])=>({id,promise:journal.flush(),path:journal.filename,operation:'settle_journal_before_migration'}))];
              const settled=await Promise.allSettled(pending.map(item=>item.promise));
              for(let index=0;index<settled.length;index++)if(settled[index].status==='rejected')rememberStorageFailure(settled[index].reason,{run:records.get(pending[index].id),operation:pending[index].operation,path:pending[index].path});
              const moved=await relocateProfileDirectory({sourceDir:dataDir,targetPath:requested,anchorDir:dataAnchor,config:store.config,secrets:store.secrets,lifecycle:dataDirectoryLifecycle,snapshots:{runs:[...records.values()].map(run=>safe(run)),currentRunId:current?.id??null,storageWarnings:safe(storageWarnings)}});
              if(!moved.unchanged){
                store=moved.store;dataDir=moved.dataDir;attachmentStore.dataDir=dataDir;historyDir=path.join(dataDir,'history');principalManager.historyDir=historyDir;checkpoints.directory=path.join(dataDir,'checkpoints');writes.clear();journals.clear();migrationWarning=moved.warning;recoveryLauncher=moved.recoveryLauncher;
                if(Array.isArray(moved.recoveredFailures))storageWarnings.splice(0,storageWarnings.length,...safe(moved.recoveredFailures).slice(-50));
              }
              return {dataDir,settings:{...store.config.settings},...(moved.warning?{warning:moved.warning}:{}),...(moved.recoveryLauncher?{recoveryLauncher:moved.recoveryLauncher}:{}),...(moved.recoveredFailures?{recoveredFailures:moved.recoveredFailures}:{})};
            }finally{relocating=false;memory=openMemory();}
          });}finally{await endDataTransition();}
          send(res,200,result);return;
        }

        if(url.pathname==='/api/directories/pick'&&req.method==='POST'){
          const body=await readBody(req);
          if(Object.keys(body).some(key=>key!=='initialPath'))fail(400,'Unknown directory picker option');
          if(body.initialPath!==undefined&&(typeof body.initialPath!=='string'||body.initialPath.length>32768||body.initialPath.includes('\0')||!path.isAbsolute(body.initialPath)))fail(400,'initialPath must be an absolute directory path');
          const controller=new AbortController(),pending={controller,promise:null};
          const disconnected=()=>controller.abort(new Error('Directory selection cancelled'));
          res.once('close',disconnected);
          try{
            await serial(()=>{idle();if(controller.signal.aborted)fail(499,'Directory selection cancelled');chooser=pending;});
            pending.promise=(async()=>{
              const selected=await directoryPicker({initialPath:body.initialPath??store.config.settings.cwd,signal:controller.signal});
              if(controller.signal.aborted||selected?.cancelled===true)return {cancelled:true};
              if(selected?.cancelled!==false||typeof selected.path!=='string'||!path.isAbsolute(selected.path))fail(500,'The directory chooser returned an invalid selection');
              let real;try{real=await fs.realpath(selected.path);if(!(await fs.stat(real)).isDirectory())fail(400,'Selected path is not a directory');}catch(error){if(error instanceof HttpError)throw error;fail(400,'Selected directory does not exist or cannot be accessed');}
              return {cancelled:false,path:real};
            })();
            const result=await pending.promise;if(!res.destroyed)send(res,200,result);
          }finally{if(chooser===pending)chooser=null;res.off('close',disconnected);}
          return;
        }
        if(url.pathname==='/api/agents'&&req.method==='POST'){
          const body=await readBody(req);const agent=await serial(async()=>{available();const previous=store.config.agents.find(a=>a.id===body.id);if(body.id&&!previous)fail(404,'Agent not found');const value=normalizeAgent(body,previous);if(!previous&&store.config.agents.length>=18)fail(400,'Maximum 18 Agents');if(value.role==='teacher'&&store.config.agents.some(a=>a.role==='teacher'&&a.id!==value.id))fail(400,'Only one teacher can be configured');if(value.role==='principal'&&store.config.agents.some(a=>a.role==='principal'&&a.id!==value.id))fail(400,'Only one principal can be configured');if(value.role==='student'&&store.config.agents.filter(a=>a.role==='student'&&a.id!==value.id).length>=16)fail(400,'Maximum 16 students');const secrets={...store.secrets};if(body.clearKey)delete secrets[value.id];else if(body.apiKey?.trim()){secrets[value.id]=body.apiKey.trim();knownSecrets.add(secrets[value.id]);}const agents=previous?store.config.agents.map(a=>a.id===value.id?value:a):[...store.config.agents,value];let extensions=store.config.extensions;if(value.role==='principal'){extensions={...extensions,revision:extensions.revision+1};for(const kind of ['mcps','skills'])extensions[kind]=extensions[kind].map(item=>({...item,agentIds:item.agentIds.filter(id=>id!==value.id)}));}await store.save({...store.config,agents,extensions},secrets);return publicAgent(value);});send(res,200,{agent});return;
        }
        const agentRoute=url.pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]{1,80})(\/check)?$/);
        // Bun's Node HTTP adapter retains unread request bodies across an
        // asynchronous response, which can keep server.close pending forever.
        // These routes have no body schema; consume and discard unused bytes.
        if(agentRoute&&req.method==='DELETE'&&!agentRoute[2]){req.resume();await serial(async()=>{available();const id=agentRoute[1];if(!store.config.agents.some(a=>a.id===id))fail(404,'Agent not found');const secrets={...store.secrets};delete secrets[id];const extensions={...store.config.extensions,revision:store.config.extensions.revision+1};for(const kind of ['mcps','skills'])extensions[kind]=store.config.extensions[kind].map(item=>({...item,agentIds:item.agentIds.filter(agentId=>agentId!==id)}));await store.save({...store.config,extensions,agents:store.config.agents.filter(a=>a.id!==id)},secrets);});send(res,200,{ok:true});return;}
        if(agentRoute&&req.method==='POST'&&agentRoute[2]){req.resume();available();const a=store.config.agents.find(a=>a.id===agentRoute[1]);if(!a)fail(404,'Agent not found');if(!store.secrets[a.id])fail(400,'Save an API key for this Agent first');const controller=new AbortController();checks.add(controller);const disconnected=()=>controller.abort(new Error('Connection check cancelled'));res.once('close',disconnected);try{const started=Date.now();const response=await new ModelClient(provider(a,{forCheck:true})).json('Connection check. Return exactly {"ok":true}.',{check:true},controller.signal);if(response.ok!==true)fail(502,'Model responded, but did not return the requested JSON object');send(res,200,{ok:true,message:'Model connection verified',latencyMs:Date.now()-started});}finally{checks.delete(controller);res.off('close',disconnected);}return;}
        if(url.pathname==='/api/settings'&&req.method==='PUT'){const body=await readBody(req);const settings=await serial(async()=>{available();const next=await normalizeSettings(body,store.config.settings);await store.save({...store.config,settings:next},store.secrets);return next;});send(res,200,{settings});return;}
        if(url.pathname==='/api/runs'&&req.method==='POST'){const body=await readBody(req);const run=await serial(()=>body.schedule===undefined?startRun(body):createSchedule(body));send(res,202,{run:safe(run)});return;}
        const scheduledRoute=url.pathname.match(/^\/api\/runs\/(run-[0-9a-f-]{36})(?:\/(start|cancel))?$/);
        if(scheduledRoute?.[2]&&records.has(scheduledRoute[1]))fail(409,'该任务已经开始，请使用任务运行控制');
        if(scheduledRoute&&!records.has(scheduledRoute[1])&&scheduledItem(scheduledRoute[1])){
          const id=scheduledRoute[1];
          if(req.method==='GET'&&!scheduledRoute[2]){send(res,200,{run:safe(scheduleRun(scheduledItem(id)))});return;}
          if(req.method==='PATCH'&&!scheduledRoute[2]){const body=await readBody(req);const run=await serial(()=>editSchedule(id,body));send(res,200,{run:safe(run)});return;}
          if(req.method==='POST'&&scheduledRoute[2]){
            const body=await readBody(req);if(Object.keys(body).length)fail(400,'操作不接受其他参数');available();
            // startNow invokes onDue, which acquires the short setup lock itself.
            if(scheduledRoute[2]==='start')await scheduler.startNow(id);else await scheduler.cancel(id);
            send(res,202,{run:safe(records.get(id)||scheduleRun(scheduledItem(id)))});return;
          }
          if(req.method==='DELETE'&&!scheduledRoute[2]){req.resume();send(res,200,await serial(()=>deleteSchedule(id)));return;}
        }
        const pauseRoute=url.pathname.match(/^\/api\/runs\/(run-[0-9a-f-]{36})\/pause$/);
        if(pauseRoute&&req.method==='POST'){
          const body=await readBody(req);if(Object.keys(body).length)fail(400,'暂停请求不接受其他参数');available();
          const execution=activeRuns.get(pauseRoute[1]);if(!execution||execution.stopRequested)fail(409,'当前任务不可暂停');
          await execution.engine.requestPause();if(activeRuns.get(execution.run.id)===execution&&!execution.stopRequested){execution.run.status='paused';await persist(execution.run);}send(res,200,{run:safe(execution.run)});return;
        }
        const resumeRoute=url.pathname.match(/^\/api\/runs\/(run-[0-9a-f-]{36})\/resume$/);
        if(resumeRoute&&req.method==='POST'){
          const body=await readBody(req);if(Object.keys(body).length)fail(400,'续跑请求不能更改原始任务或成员');
          const execution=activeRuns.get(resumeRoute[1]);
          if(execution){available();if(execution.stopRequested||!execution.engine.userPaused)fail(409,'当前任务未处于手动暂停状态');await execution.engine.requestResume();if(activeRuns.get(execution.run.id)===execution&&!execution.stopRequested){execution.run.status='running';await persist(execution.run);}send(res,202,{run:safe(execution.run)});return;}
          const run=await serial(()=>{const previous=records.get(resumeRoute[1]);if(!previous)fail(404,'Task not found');return startRun({},previous);});send(res,202,{run:safe(run)});return;
        }
        const retryRoute=url.pathname.match(/^\/api\/runs\/(run-[0-9a-f-]{36})\/members\/([A-Za-z0-9_-]{1,80})\/retry$/);
        if(retryRoute&&req.method==='POST'){
          const body=await readBody(req);if(Object.keys(body).length)fail(400,'Member retry does not accept configuration changes');
          const result=await serial(async()=>{
            if(closing)fail(503,'Application is shutting down');
            const execution=activeRuns.get(retryRoute[1]);
            if(!execution||execution.run.id!==retryRoute[1]||execution.stopRequested)fail(409,'当前任务不可重试成员。');
            try{await execution.engine.retryMember(retryRoute[2]);}
            catch(error){if(['MEMBER_NOT_ISOLATED','TASK_NOT_ACTIVE'].includes(error.code))fail(409,error.message);throw error;}
            execution.run.memberFailures=safe(execution.engine.getMemberFailures());
            // The engine persists the retry event before waking the member;
            // saveSoon/finalization own summary writes to avoid a late retry
            // response overwriting a task that has already completed.
            return {run:safe(execution.run)};
          });send(res,200,result);return;
        }
        const evidenceRoute=url.pathname.match(/^\/api\/runs\/(run-[0-9a-f-]{36})\/(evidence|output)$/);
        if(evidenceRoute&&req.method==='GET'){
          if(relocating)fail(409,'数据目录迁移中，请稍后读取档案。');
          if(removals.has(evidenceRoute[1]))fail(409,'任务正在清除，请稍后重试。');
          const run=records.get(evidenceRoute[1]);if(!run)fail(404,'Task not found');
          const output=evidenceRoute[2]==='output',allowed=output?new Set(['reference','offset','limit']):new Set(['reference','studentId','kind','callId','offset','limit','byteOffset','maxBytes']);
          for(const key of url.searchParams.keys())if(!allowed.has(key))fail(400,'Unknown evidence query option');
          const query={};
          for(const key of ['reference','studentId','kind','callId'])if(url.searchParams.has(key))query[key]=requiredText(url.searchParams.get(key),key,300);
          for(const [key,fallback,min,max] of output?[['offset',0,0,Number.MAX_SAFE_INTEGER],['limit',32768,4,65536]]:[['offset',0,0,Number.MAX_SAFE_INTEGER],['limit',50,1,200],['byteOffset',0,0,Number.MAX_SAFE_INTEGER],['maxBytes',32768,4,65536]]){
            if(!output&&['byteOffset','maxBytes'].includes(key)&&!url.searchParams.has(key))continue;
            const raw=url.searchParams.get(key);if(raw!==null&&!/^\d+$/.test(raw))fail(400,`Invalid evidence ${key}`);
            const value=raw===null?fallback:Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,`Invalid evidence ${key}`);query[key]=value;
          }
          if(output&&!query.reference)fail(400,'Output reference is required');
          if(output||query.reference?.startsWith('output:')){const prefix=`output:${run.id}:`;if(!query.reference.startsWith(prefix)||!/^\w[\w-]{0,159}$/.test(query.reference.slice(prefix.length)))fail(400,'Invalid output reference');}
          else if(query.byteOffset!==undefined||query.maxBytes!==undefined){const prefix=`journal:${run.id}:`;if(!query.reference?.startsWith(prefix)||!/^\d+$/.test(query.reference.slice(prefix.length)))fail(400,'Chunked evidence requires a reference from this task journal');}
          if(!run.hasJournal){if(output||query.reference)fail(404,'此旧任务没有独立证据档案。');send(res,200,{records:[],nextOffset:null,total:0,legacy:true});return;}
          const journal=journalFor(run.id);
          // Journal output is already redacted and bounded. Passing it through
          // the UI summary truncation would silently lose evidence page bytes.
          let page;
          try{page=output?await journal.readOutput(query):await journal.read(query);}
          catch(error){if(['Output evidence does not exist','Evidence record does not exist'].includes(error.message))fail(404,'请求的证据不存在。');if(error.fatalStorage){rememberStorageFailure(error,{run,operation:'read_evidence',path:journal.filename});const execution=activeRuns.get(run.id);if(execution){execution.storageError=error;execution.engine.fail(error);}}throw error;}
          send(res,200,page);return;
        }
        const runRoute=url.pathname.match(/^\/api\/runs\/(run-[0-9a-f-]{36})(\/(stop|export))?$/);
        if(runRoute){
          if(req.method==='DELETE'&&!runRoute[2]){req.resume();const id=runRoute[1];available();if(clearingRuns.has(id))fail(409,'该任务正在删除');clearingRuns.add(id);try{const execution=activeRuns.get(id);if(execution){requestStop(id,'user_cleared');await execution.promise;}const result=await serial(()=>clearRun(id));send(res,200,result);}finally{clearingRuns.delete(id);}return;}
          if(req.method==='PUT'&&!runRoute[2]){
            const body=await readBody(req);
            if(!Object.keys(body).length||Object.keys(body).some(key=>!['title','pinned'].includes(key)))fail(400,'仅可修改对话名称与置顶状态');
            if(Object.hasOwn(body,'pinned')&&typeof body.pinned!=='boolean')fail(400,'置顶状态必须为布尔值');
            const changes={...(Object.hasOwn(body,'title')?{title:requiredText(body.title,'title',200)}:{}),...(Object.hasOwn(body,'pinned')?{pinned:body.pinned}:{})};
            const result=await serial(async()=>{
              if(closing)fail(503,'Application is shutting down');
              const execution=activeRuns.get(runRoute[1]);if(execution?.finalizing)await execution.promise;
              if(removals.has(runRoute[1]))fail(409,'任务正在清除，请稍后重试。');
              const run=records.get(runRoute[1]);if(!run)fail(404,'Task not found');
              const previous={title:run.title,pinned:run.pinned};Object.assign(run,changes);
              try{await persist(run);}catch(error){Object.assign(run,previous);throw error;}
              return {run:safe(run),history:snapshot().history};
            });send(res,200,result);return;
          }
          if(removals.has(runRoute[1]))fail(409,'任务正在清除，请稍后重试。');
          const run=records.get(runRoute[1]);if(!run)fail(404,'Task not found');if(req.method==='GET'&&!runRoute[2]){send(res,200,{run:safe(run)});return;}if(req.method==='GET'&&runRoute[3]==='export'){send(res,200,safe(run),{'Content-Disposition':`attachment; filename="Class-${run.id}.json"`});return;}if(req.method==='POST'&&runRoute[3]==='stop'){req.resume();available();if(activeRuns.has(run.id)){requestStop(run.id);await persist(run);}send(res,200,{run:safe(run)});return;}
        }
        if(url.pathname==='/api/shutdown'&&req.method==='POST'){req.resume();closing=true;const principalClosing=principalManager.close();for(const controller of checks)controller.abort(new Error('Application shutdown'));chooser?.controller.abort(new Error('Application shutdown'));await scheduler?.close();await mutations;await chooser?.promise?.catch(()=>{});await Promise.all([stopAllRuns(),principalClosing,finishMcpTests()]);send(res,202,{ok:true,readyToExit:true});setImmediate(()=>close().then(()=>onShutdown?.()).catch(()=>{}));return;}
        fail(404,'API route not found');
      }
      if(req.method==='GET'&&Object.hasOwn(assets,url.pathname)){const asset=assets[url.pathname];res.writeHead(200,{'Content-Type':asset.contentType||'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(asset.body);return;}
      fail(404,'Not found');
    }catch(error){if(res.headersSent){res.destroy();return;}const storage=error.fatalStorage||['STORAGE_ERROR','STORAGE_LOW_SPACE','ENOSPC','EDQUOT'].includes(error.code);send(res,error.status||500,{error:safe(storage?'存储操作未完成：'+error.message:error.status?error.message:'Request failed: '+error.message),...(storage?{code:'storage_error',storageError:safe(storageDetails(error))}:{})});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const url=`http://127.0.0.1:${server.address().port}`;
  return {server,url,close,assertUpdateSafe,get dataDir(){return dataDir;}};
}

// Compatibility for existing embedders.
export { createClassServer as createDiscussionServer };
