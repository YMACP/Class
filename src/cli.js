import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClassEngine } from './engine.js';
import { ToolManager } from './tools.js';
import { RunJournal } from './run-journal.js';
import {createStudent,createTeacher,createDemo,resolveModelApiKey,ModelClient} from './agents.js';
import {MemoryManager,memoryProjectId,MEMORY_SUMMARY_PROMPT} from './memory-manager.js';

const args=process.argv.slice(2);
if(args.includes('--help')){console.log('node src/cli.js --demo [--output-dir <folder>]\nnode src/cli.js --config examples/config.json [--task "任务"] [--output-dir <folder>] [--no-memory]');process.exit(0);}
function option(flag){const i=args.indexOf(flag);if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing value: '+flag);return args[i+1];}
function atomic(file,text){fs.writeFileSync(file+'.tmp',text,{mode:0o600});fs.renameSync(file+'.tmp',file);}
function clean(value,secrets){return JSON.stringify(value,(key,v)=>{if(/^(api_?key|authorization|token|secret|password)$/i.test(key))return '[REDACTED]';if(typeof v==='bigint')return String(v);if(typeof v!=='string')return v;for(const secret of secrets)if(secret)v=v.split(secret).join('[REDACTED]');return v.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [REDACTED]');});}
async function main(){
 const demo=args.includes('--demo');let config,team,tools,teacherTools;
 if(demo){config={task:'求1到100的整数之和，并验证。',voteTimeoutMs:1000,taskTimeoutMs:10000,discoveryWindowMs:100,maxRounds:10};team=createDemo();}
 else{
  const file=path.resolve(option('--config')||'config.local.json');config=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Array.isArray(config.students)||config.students.length<2)throw Error('Configure at least two students');
  if(config.students.some(s=>!s.id)||new Set(config.students.map(s=>s.id)).size!==config.students.length)throw Error('Student IDs must be nonempty and unique');
  if(typeof config.allowShell!=='undefined'&&typeof config.allowShell!=='boolean')throw Error('allowShell must be boolean');
  const planningState=new Map();
  tools=new ToolManager({cwd:path.resolve(path.dirname(file),config.cwd||'.'),allowShell:config.allowShell===true,planningState});
  teacherTools=new ToolManager({cwd:path.resolve(path.dirname(file),config.cwd||'.'),allowShell:config.allowShell===true,planningState});
 }
 const task=option('--task')||config.task;if(typeof task!=='string'||!task.trim())throw Error('Task is required');
 const secrets=[config.provider,...(config.students||[]).map(s=>s.provider),config.teacher?.provider].filter(Boolean).map(p=>resolveModelApiKey({...config.provider,...p})).filter(Boolean);
 const base=path.resolve(option('--output-dir')||process.env.CLASS_RUNS_DIR||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','runs'));fs.mkdirSync(base,{recursive:true});
 const runDir=fs.mkdtempSync(path.join(base,'Class-'));
 const runId=path.basename(runDir),cwd=tools?.cwd||process.cwd(),identities={teacher:config.teacher?.id||'teacher',students:(config.students||team?.students||[]).map(s=>({id:s.id,name:s.name||s.id}))};
 let taskRunning=true;
 const memory=args.includes('--no-memory')?null:new MemoryManager({dataDir:base,historyDir:base,secrets,currentProject:()=>cwd,isBusy:()=>taskRunning,summarize:demo?undefined:async({type,items,signal})=>{
  const client=new ModelClient({...config.provider,...config.teacher?.provider,context1M:false,timeoutMs:60000,maxTokens:4096});
  return client.json(MEMORY_SUMMARY_PROMPT,{type,currentTime:new Date().toISOString(),sources:items},signal);
 }});
 memory?.start();
 const meta={id:runId,task,demo,cwd,projectId:memoryProjectId(cwd),startedAt:new Date().toISOString(),status:'running',hasJournal:true,team:identities};
 atomic(path.join(runDir,'session.json'),clean(meta,secrets)+'\n');memory?.registerRun(meta,runDir);
 if(!demo){
  const adapter=memory?.forRun({runId,projectId:meta.projectId,team:identities});tools.memory=adapter;teacherTools.memory=adapter;
  const observer={onConversation:value=>memory?.captureConversation(runId,value)};
  team={students:config.students.map(s=>createStudent(s,config.provider,tools,observer)),teacher:createTeacher(config.teacher||{},config.provider,teacherTools,observer)};
 }
 const journal=new RunJournal({directory:runDir,secrets,runId,onRecord:record=>memory?.observeRecord(runId,record)});
 await journal.append({kind:'run',task,demo,cwd,projectId:meta.projectId,team:identities,startedAt:meta.startedAt});
 const engine=new ClassEngine({...team,tools,teacherTools,journal,voteTimeoutMs:config.voteTimeoutMs,taskTimeoutMs:config.taskTimeoutMs,discoveryWindowMs:config.discoveryWindowMs,maxRounds:config.maxRounds});
 let storageError;
 engine.on('event',event=>{
  try{fs.appendFileSync(path.join(runDir,'events.jsonl'),clean(event,secrets)+'\n',{mode:0o600});}
  catch(error){storageError=error;engine.stop('storage_error');}
  if(['phase.changed','discussion.pausing','discovery.decided','candidate.received','review.started','review.rejected','feedback.published','feedback.delivered','solving.resumed','review.passed','task.finished','member.isolated','member.retrying','member.recovered'].includes(event.type)) console.log(clean({event:event.type,studentId:event.studentId,status:event.status,phase:event.phase,reviewRound:event.reviewRound,feedbackVersion:event.feedbackVersion,accepted:event.accepted,automatic:event.automatic,...(event.type.startsWith('member.')?{memberName:event.memberName,role:event.role,reason:event.reason,code:event.code,canRetry:event.canRetry}: {})},secrets));
 });
 const onInterrupt=()=>{engine.stop('user_stopped');memory?.pauseBackground();};process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
 try{
  console.log('Class started ('+(demo?'deterministic demo':'live model')+'): '+task);
  let result=await engine.run(task);
  try{await journal.flush();}catch(error){storageError=error;}
  if(storageError)result={...result,status:'failed',reason:'storage_error'};
  atomic(path.join(runDir,'result.json'),clean(result,secrets)+'\n');
  atomic(path.join(runDir,'blackboard.json'),clean(result.blackboard,secrets)+'\n');
  Object.assign(meta,{status:result.status,finishedAt:new Date().toISOString()});atomic(path.join(runDir,'session.json'),clean(meta,secrets)+'\n');memory?.registerRun(meta,runDir);memory?.scan();
  console.log(clean({status:result.status,reason:result.reason,answer:result.answer,report:result.report,runDir},secrets));
  if(result.status!=='completed')process.exitCode=1;
  if(memory&&!demo&&!engine.stopRequested){await memory.scan();await memory.flush();taskRunning=false;memory._runJobs(runId);await memory.jobPromise;}
 }finally{process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);await Promise.all([tools,teacherTools].filter(Boolean).map(manager=>manager.stopAll()));await journal.flush();await memory?.close();}
}
main().catch(error=>{console.error('Class failed: '+error.message);process.exitCode=1;});
