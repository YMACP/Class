'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  const apiProtocols = {
    messages:{label:'Messages',suffix:'/v1/messages',hint:'Class 会追加 /v1/messages；baseurl 末尾已有 /v1 时不会重复拼接。'},
    responses:{label:'Responses',suffix:'/responses',hint:'baseurl 须以 /v1 结尾；Class 会追加 /responses。'},
    chat:{label:'Chat',suffix:'/chat/completions',hint:'baseurl 须以 /v1 结尾；Class 会追加 /chat/completions。'}
  };
  const agentProtocol = agent => Object.hasOwn(apiProtocols,agent?.protocol) ? agent.protocol : 'chat';
  const terminal = status => ['completed','failed','stopped','cancelled','interrupted'].includes(status);
  const statusNames = {idle:'等待开始',running:'讨论中',starting:'正在启动',stopping:'正在停止',completed:'已完成',failed:'已失败',stopped:'已停止',cancelled:'已取消',interrupted:'已中断'};
  let token = '', state = null, page = 'workspace', viewingRun = null, settingsDirty = false, settingsInitialized = false;
  let busy = false, shutdown = false, shuttingDown = false, pollTimer = null, lastConnection = true, refreshPending = false;
  let directoryPickerPending = false, directoryPickerTarget = '';
  let dataDirectoryDirty = false, dataDirectorySaving = false, stateEpoch = 0;
  const pendingChecks = new Set();
  const pendingMemberRetries = new Set();
  const dialogReturnFocus = new WeakMap();
  const dialogSessions = new WeakMap();
  let evidenceRequest = 0, evidenceState = null;
  let evidenceReturnLogsRunId = '', timelineMarkup = '';
  let boardMarkup = '', boardSaveTimer = null;
  const boardViews = new Map();
  try { for (const [id, view] of JSON.parse(sessionStorage.getItem('class-board-views') || '[]').slice(-12)) if (typeof id === 'string' && view && typeof view === 'object') boardViews.set(id,view); } catch {}
  let dispatchingTask = false, clearingRunId = '';
  let taskInputRunId = null, taskInputDirty = false, savedViewingRunId = '', viewingRequest = 0;
  try { savedViewingRunId = sessionStorage.getItem('class-viewing-run') || ''; } catch {}
  const originalHash = new URLSearchParams(location.hash.slice(1));
  try {
    token = originalHash.get('token') || sessionStorage.getItem('class-token') || sessionStorage.getItem('discussion-token') || '';
    if (token) sessionStorage.setItem('class-token', token);
    if (originalHash.has('token')) history.replaceState(null, '', location.pathname + location.search);
  } catch { token = originalHash.get('token') || ''; if (originalHash.has('token')) history.replaceState(null, '', location.pathname + location.search); }

  function toast(message, error = false) {
    const dialog = error && document.querySelector('dialog[open]');
    if (dialog) {
      dialog.querySelector('.dialog-feedback')?.remove();
      const feedback = document.createElement('p'); feedback.className = 'dialog-feedback inline-error'; feedback.setAttribute('role','alert'); feedback.textContent = message;
      (dialog.querySelector('form') || dialog).appendChild(feedback); feedback.scrollIntoView({block:'nearest'}); return;
    }
    const item = document.createElement('div'); item.className = 'toast' + (error ? ' error' : '');
    item.innerHTML = icon(error ? 'close' : 'check') + '<span>' + esc(message) + '</span>';
    $('toasts').appendChild(item); while($('toasts').children.length>3)$('toasts').firstElementChild.remove(); setTimeout(() => item.remove(), error ? 9000 : 4500);
  }
  async function api(url, {method = 'GET', body, raw = false, isCurrent = () => true} = {}) {
    const response = await fetch(url, {method, headers:{Authorization:'Bearer ' + token, ...(body !== undefined ? {'Content-Type':'application/json'} : {})}, ...(body !== undefined ? {body:JSON.stringify(body)} : {}), cache:'no-store'});
    if (!response.ok) {
      let message; try { const result = await response.json(); message = storageDescription(result.storageError || result.storageDetails, result.error); } catch {}
      if ((response.status === 401 || response.status === 403) && isCurrent()) showAccess('连接凭据已失效', '请重新启动 Class，从程序自动打开的页面继续。');
      throw new Error(message || `请求失败（${response.status}）`);
    }
    return raw ? response : response.json();
  }
  function storageDescription(detail, fallback = '') {
    if (!detail || typeof detail !== 'object') return typeof fallback === 'string' ? fallback : '';
    let message = typeof detail.message === 'string' && detail.message ? detail.message : typeof fallback === 'string' ? fallback : '存储操作未完成。';
    const operations = {read:'读取',write:'写入',append:'追加记录',rename:'更新文件',mkdir:'创建目录',copy:'复制数据',unlink:'删除文件',fsync:'确认保存',save_run:'保存任务记录',save_interrupted_run:'保存中断任务',save_final_run:'保存最终任务记录',save_final_run_retry:'重新保存最终任务记录',flush_journal:'保存待写入的证据',read_evidence:'读取证据',start_task:'检查任务存储',start_task_record:'保存新任务',settle_run_before_migration:'迁移前保存任务',settle_journal_before_migration:'迁移前保存证据',read_migration_recovery:'读取迁移恢复记录',prune_history:'整理历史记录'};
    const operation = typeof detail.operation === 'string' ? operations[detail.operation] || detail.operation : '';
    if (operations[detail.operation] && message.startsWith(detail.operation)) message = operation+message.slice(detail.operation.length);
    const file = typeof detail.path === 'string' ? detail.path : '';
    return [message,operation && !message.includes(operation) ? '操作：'+operation : '',file && !message.includes(file) ? '路径：'+file : ''].filter(Boolean).join('\n');
  }
  function showAccess(title, message) {
    $('access-notice').hidden = false; $('access-title').textContent = title; $('access-message').textContent = message;
    setConnection(false); updateControls();
  }
  function setConnection(online) {
    lastConnection = online; $('connection-status').classList.toggle('offline', !online);
    $('connection-status').innerHTML = '<i></i>' + (shutdown ? '工作空间已关闭' : shuttingDown ? '服务正在退出' : online ? '本地服务已连接' : '连接已断开');
  }
  function navigate(next) {
    page = next; document.querySelectorAll('.page').forEach(node => node.hidden = node.id !== 'page-' + page);
    document.querySelectorAll('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.page === page));
    if (page === 'memory') refreshMemory(true);
  }
  const live = () => state?.run && !terminal(state.run.status);
  const selectedRun = () => viewingRun && viewingRun.id !== state?.run?.id ? viewingRun : state?.run || viewingRun;
  function rememberViewingRun(id = '') {
    viewingRequest++;
    savedViewingRunId = id;
    try { if(id)sessionStorage.setItem('class-viewing-run',id);else sessionStorage.removeItem('class-viewing-run'); } catch {}
  }
  function fillTaskInput(force = false) {
    const run = selectedRun(), id = run?.id || '';
    // Polling the same task must leave an editable new-task draft untouched.
    if (!force && taskInputRunId === id) return;
    if (force || taskInputRunId !== null || !taskInputDirty) $('task-input').value = typeof run?.task === 'string' ? run.task : '';
    taskInputRunId = id; taskInputDirty = false;
  }
  const person = id => state?.agents?.find(agent => agent.id === id);
  const personName = id => selectedRun()?.team?.students?.find(agent=>agent.id===id)?.name || person(id)?.name || (id === 'teacher' || id === selectedRun()?.team?.teacher ? '老师' : id || '小组');
  function teamReady() {
    const agents = state?.agents || [];
    return agents.filter(a => a.role === 'teacher').length === 1 && agents.filter(a => a.role === 'student').length >= 2;
  }
  function memberFailures(run) {
    const failures = run?.memberFailures;
    if (!failures || typeof failures !== 'object') return [];
    return Object.entries(failures).filter(([,failure])=>failure && typeof failure === 'object').map(([id,failure])=>({...failure,studentId:failure.studentId || id}));
  }
  const retryKey = (runId,memberId) => JSON.stringify([runId,memberId]);
  function retryAllowed(run, failure) {
    return run?.id === state?.run?.id && state?.run?.status === 'running' && failure?.canRetry === true && failure.status !== 'retrying';
  }
  function updateControls() {
    const locked = busy || dataDirectorySaving || directoryPickerPending || Boolean(live()) || state?.relocating === true || !lastConnection || !token || shutdown || shuttingDown;
    $('start-button').disabled = locked || !teamReady();
    ['settings-button','team-button','logs-button','answer-button'].forEach(id => $(id).disabled = Boolean(clearingRunId) || shutdown || shuttingDown || !lastConnection || !token || !state);
    $('evidence-button').disabled = Boolean(clearingRunId) || shutdown || shuttingDown || !lastConnection || !token || !selectedRun()?.id;
    $('clear-task-button').disabled = busy || directoryPickerPending || state?.relocating === true || shutdown || shuttingDown || !lastConnection || !token || !selectedRun()?.id;
    $('clear-task-button').setAttribute('aria-busy',String(Boolean(clearingRunId)));
    $('clear-task-button').title = clearingRunId ? '正在清除任务…' : '清除任务';
    document.querySelectorAll('[data-run-view]').forEach(button => button.disabled = Boolean(clearingRunId));
    $('start-button').hidden = Boolean(live()); $('stop-button').hidden = !live();
    $('stop-button').disabled = busy || shutdown || shuttingDown || !lastConnection || state?.run?.status === 'stopping';
    $('stop-button').innerHTML = icon('stop') + (state?.run?.status === 'stopping' ? '正在停止…' : '停止任务');
    $('task-input').disabled = Boolean(live()) || shutdown || shuttingDown;
    $('add-agent-button').disabled = locked; $('settings-save').disabled = locked;
    $('setting-directory-button').disabled = locked; $('setting-directory-button').setAttribute('aria-busy',String(directoryPickerPending && directoryPickerTarget === 'workspace'));
    $('data-directory-input').disabled = locked; $('data-directory-button').disabled = locked;
    $('data-directory-button').setAttribute('aria-busy',String(directoryPickerPending && directoryPickerTarget === 'data'));
    $('data-directory-save').disabled = locked || !dataDirectoryDirty || !$('data-directory-input').value.trim();
    $('data-directory-load').disabled = locked || !dataDirectoryDirty || !$('data-directory-input').value.trim();
    $('data-directory-form').setAttribute('aria-busy',String(dataDirectorySaving));
    $('settings-form').querySelectorAll('input').forEach(input => input.disabled = locked);
    $('agent-save').disabled = locked;
    document.querySelectorAll('[data-agent-edit],[data-agent-delete]').forEach(button => button.disabled = locked);
    document.querySelectorAll('[data-agent-check]').forEach(button => button.disabled = locked || pendingChecks.has(button.dataset.agentCheck));
    $('shutdown-button').disabled = busy || state?.relocating === true || shutdown || shuttingDown || !token;
    const selected = selectedRun(), failures = memberFailures(selected);
    document.querySelectorAll('[data-member-retry]').forEach(button => {
      const failure = failures.find(item=>item.studentId===button.dataset.memberRetry);
      button.disabled = !retryAllowed(selected,failure) || pendingMemberRetries.size > 0 || busy || Boolean(clearingRunId) || shutdown || shuttingDown || !lastConnection || !token;
    });

  }
  function fillSettings() {
    if (!state?.settings || settingsDirty || directoryPickerPending) return;
    const s = state.settings;
    $('setting-cwd').value = s.cwd || '';
    $('setting-vote').value = (s.voteTimeoutMs ?? 30000) / 1000;
    settingsInitialized = true;
  }
  function renderTeam() {
    const agents = state?.agents || [];
    $('setup-callout').hidden = teamReady();
    const run = selectedRun(); const phase = phaseOf(run);
    let members = agents;
    if (run?.team?.students) {
      const teacherId = run.team.teacher || 'teacher';
      members = [{id:teacherId,name:person(teacherId)?.name || (run.demo ? '演示老师' : '老师'),role:'teacher'}, ...run.team.students.map((student,i) => ({id:student.id,name:run.demo ? `演示学生 ${i + 1}` : student.name || person(student.id)?.name || student.id,role:'student'}))];
    } else if (run?.demo) {
      const ids = run.events?.find(e => e.type === 'task.started')?.studentIds || [];
      if (ids.length) members = [{id:'teacher',name:'演示老师',role:'teacher'}, ...ids.map((id,i) => ({id,name:`演示学生 ${i + 1}`,role:'student'}))];
    }
    $('team-list').innerHTML = members.length ? members.map(agent => {
      const failure = memberFailures(run).find(item=>item.studentId===agent.id);
      let activity = '准备就绪';
      if (run && !terminal(run.status)) activity = agent.role === 'teacher' ? ({review:'审查候选答案',reviewing:'审查候选答案',judging:'验收结果',merging:'合并发现',discussing:'合并发现与投票',publishing_feedback:'发布审查反馈',resuming:'根据反馈继续求解'}[phase] || '观察讨论') : ({solving:'独立求解',merging:'暂停审视',discussing:'审视 / 投票',pausing:'等待工具暂停',voting:'审视 / 投票',review:'等待老师审查',reviewing:'等待老师审查',publishing_feedback:'等待审查反馈',resuming:'根据反馈继续求解',judging:'已停止求解'}[phase] || '准备中');
      else if (run && terminal(run.status)) activity = '';
      if (failure) activity = failure.status === 'retrying' ? '正在重试' : agent.role === 'teacher' ? '验收暂停' : '已隔离';
      else if (phase === 'waiting_recovery' && !terminal(run.status)) activity = agent.role === 'teacher' ? '等待成员恢复' : '等待恢复协调';
      return `<div class="team-person"><span class="avatar ${agent.role === 'teacher' ? 'teacher' : ''}">${esc(agent.name?.slice(0,1) || 'A')}</span><div class="person-info"><strong>${esc(agent.name)}</strong><small>${agent.role === 'teacher' ? '老师' : '学生'}</small></div>${activity ? `<span class="person-state ${failure ? 'isolated' : run && !terminal(run.status) ? 'active' : ''}">${activity}</span>` : ''}</div>`;
    }).join('') : '<div class="empty-small">尚未添加成员</div>';
  }
  function phaseOf(run) {
    if (!run) return null;
    if (run.phase) return run.phase;
    const events = run.events || [];
    for (let i = events.length - 1; i >= 0; i--) {
      const phase = events[i].type === 'phase.changed' ? events[i].phase : {'review.started':'reviewing','review.rejected':'publishing_feedback','feedback.published':'publishing_feedback','solving.resumed':'solving','answer.judging':'judging','answer.submitted':'judging','discussion.resumed':'resuming','discovery.decided':'voting','discovery.proposed':'voting','discussion.pausing':'merging','student.result':'solving','task.started':'solving'}[events[i].type];
      if (phase) return phase;
    }
    return 'solving';
  }
  function renderRun() {
    const run = dispatchingTask ? null : selectedRun(), status = dispatchingTask ? 'starting' : run?.status || 'idle';
    $('run-status').className = 'status-badge ' + (Object.hasOwn(statusNames,status) ? status : 'idle');
    const phase = phaseOf(run);
    $('run-status').textContent = status === 'running' && !dispatchingTask ? ({pausing:'正在暂停',review:'老师审查中',reviewing:'老师审查中',publishing_feedback:'发布老师反馈',resuming:'根据反馈继续求解',waiting_recovery:'等待成员恢复'}[phase] || statusNames[status] || status) : statusNames[status] || status;
    if (clearingRunId) { $('run-status').textContent = '清除中…'; $('run-status').className = 'status-badge stopping'; }
    const order = ['assigned','solving','judging'], stage = dispatchingTask ? 'assigned' : progressStageOf(run);
    $('workflow').querySelectorAll('[data-stage]').forEach(node => {
      node.classList.toggle('active', node.dataset.stage === stage && !terminal(status));
      node.classList.toggle('finished', Boolean(run) && (status === 'completed' || order.indexOf(node.dataset.stage) < order.indexOf(stage)));
      if(node.dataset.stage === stage)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');
    });
    const end = run?.finishedAt ? new Date(run.finishedAt).getTime() : Date.now(); const duration = run?.startedAt ? Math.max(0,Math.floor((end-new Date(run.startedAt).getTime())/1000)) : null;
    $('run-elapsed').textContent = duration === null || !Number.isFinite(duration) ? '00:00:00' : `${Math.floor(duration/60)} 分 ${String(duration%60).padStart(2,'0')} 秒`;
    const storageError = run?.storageError || run?.storageErrors?.at(-1);
    const runError = storageError ? '该任务的存储错误记录\n'+storageDescription(storageError,typeof run?.error === 'string' ? reasonName(run.error) : '') : typeof run?.error === 'string' ? reasonName(run.error) : text(run?.error);
    $('run-error').hidden = !runError; $('run-error').textContent = runError;
    const reviewRound = run?.reviewRound ?? run?.result?.reviewRound ?? 0, feedbackVersion = run?.feedbackVersion ?? run?.result?.feedbackVersion ?? 0;
    $('review-progress').hidden = !reviewRound && !feedbackVersion;
    $('review-progress').textContent = `${reviewRound ? `第 ${reviewRound} 轮审查` : '持续求解'}${feedbackVersion ? ` · 已发布 ${feedbackVersion} 版反馈` : ''}`;
    renderMemberRecovery(run); renderBoard(run); renderTimeline(run); renderResult(run);
  }
  function renderMemberRecovery(run) {
    const target = $('member-recovery'), failures = memberFailures(run);
    target.hidden = !failures.length;
    const summary = terminal(run?.status) ? '本次任务已结束，以下为成员异常记录。' : run?.status === 'stopping' ? '正在停止任务。' : phaseOf(run) === 'waiting_recovery' ? '任务等待成员恢复，可重试成员或停止任务。' : '部分成员需要恢复，其他可用学生继续求解。';
    const markup = failures.length ? `<p class="member-recovery-heading">${summary}</p>${failures.map(failure=>{
      const retrying = failure.status === 'retrying' || pendingMemberRetries.has(retryKey(run.id,failure.studentId));
      const member = typeof failure.memberName === 'string' && failure.memberName.trim() ? failure.memberName : personName(failure.studentId);
      const status = retrying ? '正在重试' : failure.role === 'teacher' ? '验收暂停' : '已隔离';
      const reason = typeof failure.reason === 'string' ? failure.reason : '该成员暂时不可用，请查看讨论日志。';
      return `<div class="member-recovery-row"><div><strong>${esc(member)} · ${status}</strong><p>${esc(reason)}</p></div>${run.id === state?.run?.id && run.status === 'running' ? `<button type="button" class="button secondary" data-member-retry="${esc(failure.studentId)}" aria-label="${esc('重试成员 '+member)}" aria-busy="${retrying}">${retrying ? '重试中…' : '重试该成员'}</button>` : ''}</div>`;
    }).join('')}` : '';
    if (target.dataset.markup !== markup) { target.innerHTML = markup; target.dataset.markup = markup; }
  }
  function progressStageOf(run) {
    if (!run) return null;
    const events = run.events || [];
    // Candidate reviews stay within solving; only final approval attains step 3.
    if (run.status === 'completed') return 'judging';
    const continuous = Boolean(run.phase) || events.some(event => ['phase.changed','candidate.received','review.started','feedback.published'].includes(event.type));
    if (continuous && run.status !== 'starting') return 'solving';
    if (!continuous && (['answer_valid','answer_invalid'].includes(run.result?.reason) || events.some(event => event.type === 'answer.judging'))) return 'judging';
    return events.some(event => event.type === 'task.started' || /^(student\.|discovery\.|discussion\.)/.test(event.type)) ? 'solving' : 'assigned';
  }
  function renderBoard(run) {
    const target = $('blackboard-content'), runId = run?.id || '', sameRun = target.dataset.runId === runId;
    const outcomes = [...(run?.outcomes || run?.result?.outcomes || [])].filter(entry=>entry && typeof entry === 'object');
    if (run?.status === 'completed' && run.result?.reason !== 'answer_invalid' && !outcomes.some(entry=>entry.type==='final_answer') && run.result?.answer != null) outcomes.push({id:'legacy-final-answer',type:'final_answer',status:'completed',content:run.result.answer?.content ?? run.result.answer,report:run.result.report,createdAt:run.finishedAt,reviewRound:run.reviewRound});
    const reviewed = new Set(outcomes.filter(entry=>entry.type==='teacher_review').map(entry=>entry.reviewId || entry.id));
    const entries = [...(run?.blackboard || run?.result?.blackboard || [])];
    const decided = new Set(entries.map(entry => entry.id));
    for (const event of run?.events || []) if (event.type === 'discovery.proposed' && !decided.has(event.id)) entries.push({...event,status:'pending',pending:true});
    const visibleEntries = entries.filter(entry=>entry.type!=='teacher_feedback' || !reviewed.has(entry.reviewId));
    const feedbackCount = visibleEntries.filter(entry=>entry.type==='teacher_feedback').length, discoveryCount = entries.filter(entry=>entry.type!=='teacher_feedback').length;
    $('board-count').textContent = `${outcomes.length} 项成果 · ${discoveryCount} 条发现${feedbackCount ? ` · ${feedbackCount} 条反馈` : ''}`;
    let discoveryNumber = 0;
    const final = outcomes.filter(entry=>entry.type==='final_answer' && run?.status==='completed' && run.result?.reason!=='answer_invalid');
    const other = outcomes.filter(entry=>!final.includes(entry));
    const markup = !outcomes.length && !visibleEntries.length ? '<div class="board-empty"><div class="chalk-diagram"><span>独立成果</span><i>＋</i><span>共同发现</span><i>→</i><strong>完整答案</strong></div><h3>每一轮成果，都留在黑板上</h3><p>学生的提交、老师的结论与发现投票会在这里保留。<br>最终综合答案通过验收后置顶展示。</p></div>' : (run?.blackboardDropped || run?.outcomesDropped ? '<p class="board-archive-note">这里显示最近保留的成果与黑板记录；更早内容可在运行档案中查询。</p>' : '') + '<div class="discoveries">' + final.map(entry=>renderOutcome(entry,run,outcomes)).join('') + other.map(entry=>renderOutcome(entry,run,outcomes)).join('') + visibleEntries.map(entry => {
      if (entry.type === 'teacher_feedback') return renderTeacherFeedback(entry);
      discoveryNumber++;
      const accepted = entry.accepted === true || entry.status === 'accepted'; const votes = entry.votes || [];
      const yes = entry.yesVotes ?? votes.filter(v => !v.excluded && v.approve).length; const valid = entry.validVotes ?? votes.filter(v => !v.excluded).length;
      const status = entry.pending ? 'pending' : accepted ? 'accepted' : 'rejected';
      const label = entry.pending ? '正在审视' : accepted ? entry.automatic ? '共同发现 · 直接采纳' : '投票通过 · 已采纳' : '未通过 · 已舍弃';
      return `<article class="discovery ${status}" data-board-entry="${esc('discovery:'+entry.id)}"><div class="discovery-header"><span class="discovery-number">发现${discoveryNumber}</span><span class="discovery-status">${label}</span></div>${boardText(entry.content,'discovery:'+entry.id)}<p class="discovery-source">提出者：${esc((entry.proposerIds || []).map(personName).join('、') || '—')}</p>${entry.automatic ? '' : `<div class="vote-summary"><span>${entry.pending ? '等待本轮投票结果' : `${yes} / ${valid} 有效票赞成`}</span><span>${entry.pending ? '' : votes.some(v => v.excluded) ? `${votes.filter(v=>v.excluded).length} 人未计入有效票` : '提出者不参与投票'}</span></div>`}${votes.length ? `<details class="vote-list" data-discovery="${esc(entry.id)}" data-board-detail="${esc('votes:'+entry.id)}"><summary>查看每位成员的投票与理由</summary>${votes.map(vote=>`<div class="vote-row"><span>${esc(personName(vote.studentId))}</span><b class="${vote.approve ? 'vote-yes' : 'vote-no'}">${vote.excluded ? '剔除' : vote.approve ? '赞成' : '反对'}</b><span>${esc(voteReason(vote.reason))}</span></div>`).join('')}</details>` : ''}</article>`;
    }).join('') + '</div>';
    // A tool event or the timer does not rebuild the board or disturb its reader.
    if (sameRun && boardMarkup === markup) return;
    rememberBoard();
    const view = boardViews.get(runId);
    target.dataset.runId = runId; boardMarkup = markup; target.innerHTML = markup;
    const expanded = new Set(Array.isArray(view?.expanded) ? view.expanded : []);
    target.querySelectorAll('[data-board-detail]').forEach(node=>{node.open=expanded.has(node.dataset.boardDetail);});
    target.scrollTop = Number.isFinite(view?.scrollTop) ? view.scrollTop : 0;
    const anchor = [...target.querySelectorAll('[data-board-entry]')].find(node=>node.dataset.boardEntry===view?.anchor);
    // Readers already at the top should see the newly pinned final answer.
    if (anchor && Number.isFinite(view.anchorOffset) && !(final.length && view.scrollTop<=8)) target.scrollTop += anchor.getBoundingClientRect().top-target.getBoundingClientRect().top-view.anchorOffset;
  }
  function rememberBoard() {
    const target = $('blackboard-content'), id = target.dataset.runId;
    if (!id || !target.getClientRects().length) return;
    const top = target.getBoundingClientRect().top;
    const anchor = [...target.querySelectorAll('[data-board-entry]')].find(node=>node.getBoundingClientRect().bottom>top+8);
    boardViews.delete(id); boardViews.set(id,{scrollTop:target.scrollTop,expanded:[...target.querySelectorAll('[data-board-detail][open]')].map(node=>node.dataset.boardDetail).slice(-256),anchor:anchor?.dataset.boardEntry,anchorOffset:anchor ? anchor.getBoundingClientRect().top-top : 0});
    while(boardViews.size>12)boardViews.delete(boardViews.keys().next().value);
    clearTimeout(boardSaveTimer); boardSaveTimer=setTimeout(persistBoard,150);
  }
  function persistBoard() { try { sessionStorage.setItem('class-board-views',JSON.stringify([...boardViews])); } catch {} }
  $('blackboard-content').addEventListener('scroll',rememberBoard,{passive:true});
  $('blackboard-content').addEventListener('toggle',event=>{if(event.target.matches('[data-board-detail]'))rememberBoard();},true);
  window.addEventListener('pagehide',()=>{rememberBoard();persistBoard();});
  function boardText(value, key) {
    const content = text(value); if (!content) return '';
    if (content.length<=260 && content.split(/\r?\n/).length<=4) return `<p class="discovery-content">${esc(content)}</p>`;
    return `<details class="outcome-text" data-board-detail="${esc(key)}"><summary><span class="outcome-preview">${esc(content.slice(0,240))}…</span><span class="outcome-expand">展开内容</span><span class="outcome-collapse">收起内容</span></summary><p class="discovery-content">${esc(content)}</p></details>`;
  }
  function renderOutcome(entry, run, outcomes) {
    const type = entry.type, progress = entry.submissionType==='progress', teacher = type==='teacher_review' || type==='teacher_merge' || progress&&entry.role==='teacher', final = type==='final_answer';
    const completed = run.status==='completed' && run.result?.reason!=='answer_invalid';
    const title = final ? completed?'最终综合答案':'已验收成果（任务未完成）' : progress ? teacher?'老师公开进展':'学生公开进展' : type==='teacher_review' ? '老师验收结论' : type==='teacher_merge' ? '老师合并发现' : entry.submissionType==='answer' ? '学生提交答案' : '学生阶段成果';
    const member = entry.memberName || (teacher || final ? personName(run.team?.teacher || 'teacher') : personName(entry.studentId));
    const ended = terminal(run.status);
    const status = progress?'已公开 · 尚未核验':final&&completed?'已完成':{reported:'已记录',pending:ended?'尚未验收':'等待审查',reviewing:ended?'审查未完成':'老师审查中',deferred:'暂缓送审',accepted:type==='teacher_merge'?'合并完成':teacher||final?'验收通过':'本轮验收通过',rejected:'需补充改进',completed:'已完成',processing:ended?'处理未完成':'正在处理'}[entry.status] || '已记录';
    const round = entry.reviewRound ? `第 ${entry.reviewRound} 轮审查` : entry.round ? `第 ${entry.round} 轮讨论` : '尚未进入审查';
    const submissionIds = Array.isArray(entry.submissionIds)?entry.submissionIds:[], candidateIds = Array.isArray(entry.candidateIds)?entry.candidateIds:[];
    const submitted = outcomes.filter(item=>item.type==='student_submission' && (submissionIds.includes(item.submissionId || item.id) || candidateIds.includes(item.candidateId)));
    const sources = submitted.length ? `<div class="outcome-related"><span>本轮参考的提交：</span>${submitted.map(item=>`<button type="button" class="evidence-link" data-board-jump="${esc(item.id)}">${esc(item.memberName || personName(item.studentId))} · ${item.submissionType==='answer'?'答案':'阶段成果'}</button>`).join('')}</div>` : submissionIds.length || candidateIds.length ? '<p class="discovery-source">关联提交未保留在当前列表中，可查看本轮快照或运行档案。</p>' : '';
    const refs = [...new Set([entry.evidenceRef,entry.snapshotRef,...(Array.isArray(entry.evidenceRefs)?entry.evidenceRefs:[])].map(ref=>typeof ref==='string'?ref:ref?.reference || ref?.id).filter(Boolean))];
    const section = (label, value, className) => {const list=Array.isArray(value)?value:value==null||value===''?[]:[value];return list.length?`<section class="feedback-section ${className}"><h4>${label}</h4>${boardText(list.map(text).join('\n'),entry.id+':'+className)}</section>`:'';};
    return `<article class="discovery outcome-card ${teacher?'teacher-feedback':''} ${final&&completed?'final-outcome':''}" data-board-entry="${esc(entry.id)}" data-outcome-type="${esc(type)}"><div class="discovery-header"><strong class="discovery-number">${title}</strong><span class="discovery-status">${status}</span></div>
      <p class="outcome-meta"><span>${esc(member)}</span><span>${esc(round)}</span>${entry.createdAt?`<time datetime="${esc(entry.createdAt)}">${esc(formatDate(entry.createdAt))}</time>`:''}</p>
      ${boardText(entry.content || entry.report,entry.id+':content')}${entry.content && entry.report && entry.report!==entry.content?section('老师说明',entry.report,'feedback-report'):''}${!entry.content&&!entry.report?'<p class="discovery-source">正文未保存在当前摘要中，可查看留存档案。</p>':''}
      ${type==='student_submission'?section('提交依据',entry.evidence,'feedback-evidence-text')+section('完成声明（待老师核验）',entry.completionClaims,'feedback-claims')+section('尚未解决',entry.remainingIssues,'feedback-gaps'):''}
      ${section('老师综合答案',entry.answer?.content ?? entry.answer,'feedback-answer')}${section('已核实事实',entry.verifiedFacts,'feedback-facts')}${section('待补充与待验证',entry.gaps,'feedback-gaps')}${section('建议（尚未验证）',entry.recommendations,'feedback-suggestions')}${sources}
      ${entry.contentTruncated?'<p class="discovery-source">当前卡片展示留存摘要，完整正文请点击“查看完整成果”。</p>':''}<div class="feedback-evidence">${entry.fullContentRef?`<button type="button" class="evidence-link" data-full-content-reference="${esc(entry.fullContentRef)}">查看完整成果</button>`:''}${refs.map(ref=>`<button type="button" class="evidence-link" data-evidence-reference="${esc(ref)}">查看${ref===entry.snapshotRef?'本轮快照':'关联证据'}</button>`).join('')}${!entry.fullContentRef&&!refs.length?'<button type="button" class="evidence-link" data-evidence-reference="">查看运行档案</button>':''}</div></article>`;
  }
  function renderTeacherFeedback(entry) {
    const items = value => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
    const section = (label, value, className) => { const list=items(value); return list.length ? `<section class="feedback-section ${className}"><h4>${label}</h4><ul>${list.map(item=>`<li>${esc(text(item))}</li>`).join('')}</ul></section>` : ''; };
    const refs = items(entry.evidenceRefs);
    return `<article class="discovery teacher-feedback"><div class="discovery-header"><span class="discovery-number">老师反馈${entry.reviewRound ? ` · 第 ${esc(entry.reviewRound)} 轮` : ''}</span><span class="discovery-status">继续求解${entry.feedbackVersion ? ` · v${esc(entry.feedbackVersion)}` : ''}</span></div>${entry.report || entry.reason ? `<p class="discovery-content">${esc(text(entry.report || entry.reason))}</p>` : ''}${section('已核实事实',entry.verifiedFacts,'feedback-facts')}${section('待补充与待验证',entry.gaps,'feedback-gaps')}${section('建议（尚未验证）',entry.recommendations,'feedback-suggestions')}${items(entry.candidateIds).length ? `<p class="discovery-source">候选答案：${items(entry.candidateIds).map(item=>esc(text(item))).join('、')}</p>` : ''}${items(entry.sources).length ? `<p class="discovery-source">来源：${items(entry.sources).map(item=>esc(typeof item === 'string' ? personName(item) : item?.studentId ? personName(item.studentId) : text(item))).join('、')}</p>` : ''}<div class="feedback-evidence">${refs.map(ref=>{const reference=typeof ref==='string'?ref:ref.reference || ref.id || '';return reference ? `<button type="button" class="evidence-link" data-evidence-reference="${esc(reference)}">查看证据 ${esc(reference)}</button>` : '';}).join('')}<button type="button" class="evidence-link" data-evidence-reference="">查看本次运行档案</button></div></article>`;
  }
  function voteReason(reason) { return {timeout_or_cancelled:'超时或已取消，本轮不计票',invalid_vote:'返回的投票格式无效',vote_error:'投票请求失败'}[reason] || reason || '未提供理由'; }
  function toolValidationLabel(event) {
    const member = typeof event.memberName === 'string' && event.memberName.trim() ? event.memberName : personName(event.studentId);
    const tool = typeof event.toolName === 'string' && event.toolName.trim() ? event.toolName : '模型调用';
    const attempt = Number.isSafeInteger(event.attempt) && event.attempt > 0 ? event.attempt : null;
    const max = Number.isSafeInteger(event.maxAttempts) && event.maxAttempts > 0 ? event.maxAttempts : 3;
    const fatal = event.fatal === true || event.code === 'TOOL_CALL_PROTOCOL_INVALID';
    return { member, tool, attempt, max, fatal };
  }
  function describeToolValidation(event) {
    const { member, tool, attempt, max, fatal } = toolValidationLabel(event);
    const subject = `${member} 的 ${tool}`;
    if (event.type === 'tool.validation_recovered') return event.resolution==='valid_tool_batch' ? `${subject} 参数格式已恢复；命令是否执行请看执行记录` : ['final_response','valid_final_result'].includes(event.resolution) ? `${member} 已通过合法回复继续；不代表原工具已执行` : `${subject} 调用问题已恢复；执行结果另行记录`;
    if (event.type === 'tool.validation_normalized') return `${subject} 工具名称或参数别名已规范化，继续校验`;
    if (event.type === 'tool.validation_retrying') return `${subject} ${event.reasonCode==='TOOL_EXECUTION_FAILED'?'执行失败，正在调整后续调用':'接口或响应异常，正在重试'}${attempt ? `（第 ${attempt}/${max} 次）` : ''}`;
    if (event.type === 'tool.validation_exhausted') return `${subject} ${event.reasonCode==='MEMBER_NO_PROGRESS'?'同类问题反复出现且没有新进展，等待成员恢复':event.attempt === 0 ? immediateRecoveryReason(event) : `自动恢复已达 ${max} 次上限，等待成员恢复`}`;
    if (fatal) return `${subject} 调用结构异常，等待成员恢复处理`;
    // Use fixed summaries only; raw arguments and provider error text belong in the evidence archive.
    const reason = typeof event.reason === 'string' ? event.reason : typeof event.error === 'string' ? event.error : '';
    const issue = /missing|缺少|缺失|不完整/i.test(reason) ? '参数不完整' : '调用未通过校验';
    return `${subject} ${issue}，${event.recoveryStrategy==='targeted'?'正在针对同类问题纠正':'正在请求纠正'}${attempt ? `（第 ${attempt}/${max} 次）` : ''}`;
  }
  function immediateRecoveryReason(event) {
    const code = event.reasonCode || event.code || '';
    if (code === 'MODEL_CONTEXT_1M_UNSUPPORTED') return '当前模型或接口不支持 1M，请取消勾选后重试';
    if (code === 'MODEL_REQUEST_REJECTED') return '接口请求被拒绝，等待成员恢复';
    if (code === 'TOOL_RESULT_UNCERTAIN') return '执行结果不确定，已保留证据等待处理';
    if (/TOKEN_BUDGET_EXHAUSTED/.test(code)) return '输出预算不足，等待成员恢复';
    if (/CONTEXT/.test(code)) return '上下文无法继续，等待成员恢复';
    return '暂时无法继续，等待成员恢复';
  }
  function describeEvent(event) {
    const name = personName(event.studentId);
    switch(event.type) {
      case 'task.started': return `讨论开始 · ${(event.studentIds || []).length} 位学生同步求解`;
      case 'student.result': return `${name} ${event.result?.type === 'discovery' ? '提出了一项重大发现' : event.result?.type === 'answer' ? '提交了候选答案' : '完成一轮探索，继续解题'}`;
      case 'phase.changed': return `阶段更新 · ${{solving:'并行求解',discussing:'讨论发现',pausing:'暂停工具',review:'老师审查中',reviewing:'老师审查中',publishing_feedback:'发布老师反馈',resuming:'根据反馈继续求解',waiting_recovery:'等待成员恢复',completed:'验收通过'}[event.phase] || event.phase}${event.reviewRound ? ` · 第 ${event.reviewRound} 轮审查` : ''}`;
      case 'candidate.received': return `${name} 提交候选答案${event.candidateId ? ` · ${event.candidateId}` : ''}`;
      case 'review.started': return `老师开始第 ${event.reviewRound || '—'} 轮审查`;
      case 'review.rejected': return `本轮候选未通过，发布反馈后继续求解${event.reason ? ' · ' + text(event.reason) : ''}`;
      case 'feedback.published': return `老师反馈已写入黑板${event.entry?.feedbackVersion || event.feedbackVersion ? ` · 第 ${event.entry?.feedbackVersion || event.feedbackVersion} 版` : ''}`;
      case 'feedback.delivered': return `${name} 的模型请求已带上老师反馈${event.feedbackVersion ? ` · 第 ${event.feedbackVersion} 版` : ''}`;
      case 'candidate.deferred': return event.reason === 'no_new_evidence' ? `${name} 的答案与提交依据未变，暂不重复送审；请修改答案或补充相关证据` : `${name} 的旧版本候选已保留，等待结合最新反馈更新`;
      case 'candidate.duplicate': return `${name} 重复提交的候选暂不送审，继续补充证据`;
      case 'solving.resumed': return '学生根据老师反馈继续求解';
      case 'tool.validation_error':
      case 'tool.validation_recovered':
      case 'tool.validation_normalized':
      case 'tool.validation_retrying':
      case 'tool.validation_exhausted': return describeToolValidation(event);
      case 'tool.spawned': return `${event.memberName || name} 的 ${event.toolName || '命令'} 已启动`;
      case 'tool.completed': {
        const subject = `${event.memberName || name} 的 ${event.toolName || '工具'}`;
        if (event.executionStatus==='cancelled') return `${subject} 已取消`;
        if (event.executionStatus==='unknown' || event.executionStatus==='uncertain') return `${subject} 执行结果不确定，请查看证据`;
        if (event.success===false || Number.isInteger(event.exitCode)&&event.exitCode!==0 || event.signal) return `${subject} 执行失败${Number.isInteger(event.exitCode)?`（退出码 ${event.exitCode}）`:event.signal?`（信号 ${event.signal}）`:''}`;
        return event.success===true || event.exitCode===0 ? `${subject} 执行成功` : `${subject} 执行已结束，结果请查看证据`;
      }
      case 'tool.failed': return `${event.memberName || name} 的 ${event.toolName || '工具'} ${event.executionStatus==='cancelled'?'已取消':event.executionStatus==='unknown'||event.executionStatus==='uncertain'?'执行结果不确定，请查看证据':event.executionStatus==='not_started'?'未能启动':Number.isInteger(event.exitCode)?`执行失败（退出码 ${event.exitCode}）`:'启动或执行失败'}`;
      case 'tool.execution_feedback': return `${event.memberName || name} 的 ${event.toolName || '命令'} ${event.noProgressFailures>=2?'同一命令再次失败':'执行失败'}，正在调整方法`;
      case 'member.isolated': return `${event.memberName || name} ${event.role === 'teacher' ? '验收已暂停，等待重试老师' : '已隔离，其他可用学生继续求解'}${event.reason ? ' · '+text(event.reason) : ''}`;
      case 'member.retrying': return `${event.memberName || name} 正在重试，继续同一次任务`;
      case 'member.recovered': return `${event.memberName || name} 已恢复，${event.role === 'teacher' ? '继续验收' : '继续原任务'}`;
      case 'review.passed': return '老师审查通过，正在完成任务收尾';
      case 'discussion.pausing': return `第 ${event.round || '—'} 轮讨论 · 暂停工具，合并相似发现`;
      case 'discovery.proposed': return event.automatic ? '相似发现已超过全体半数，无需投票' : '发现已写入黑板，成员开始审视和投票';
      case 'discovery.decided': return event.accepted ? event.automatic ? '共同发现已直接采纳' : `发现通过 · ${event.yesVotes} / ${event.validVotes} 有效票赞成` : `发现舍弃 · ${event.yesVotes} / ${event.validVotes} 有效票赞成`;
      case 'discussion.resumed': return '本轮讨论结束，工具恢复，学生继续探索';
      case 'answer.submitted': return `${name} 已提交答案，交由老师审查`;
      case 'answer.judging': return '老师正在验证答案并汇总去重';
      case 'task.finished': return `讨论结束 · ${statusNames[event.status] || event.status || ''}${event.reason ? ' · ' + reasonName(event.reason) : ''}`;
      default: return text(event.message || event.detail || event.type);
    }
  }
  function renderTimeline(run) {
    const summary=run?.activitySummary,count=key=>Number.isSafeInteger(summary?.[key])&&summary[key]>=0?summary[key]:0;
    $('activity-summary').hidden=!summary;
    $('activity-summary').textContent=summary?`命令启动 ${count('commandStarted')} · 成功 ${count('commandSucceeded')} / 失败 ${count('commandFailed')}${count('commandCancelled')?' / 取消 '+count('commandCancelled'):''} · 校验恢复 ${count('formatCorrected')} · 公开进展 ${count('publicProgress')} · 答案提交 ${count('submittedAnswers')}`:'';
    const events = (run?.events || []).filter(event=>!['outcome.upsert','tool.started'].includes(event.type) && !(event.type==='tool.execution_feedback'&&event.noProgressFailures===1)), rows=[], groups=new Map();
    events.forEach((event,index)=>{
      const grouped = ['tool.validation_error','tool.validation_normalized','tool.validation_recovered'].includes(event.type) && !event.fatal;
      const key = grouped ? JSON.stringify([event.type,event.studentId,event.toolName,event.reasonCode,event.phaseId,event.reviewId,event.resolution]) : 'event:'+(event.sequence ?? index);
      let row=grouped?groups.get(key):null;
      if(!row){row={key,events:[],index};rows.push(row);if(grouped)groups.set(key,row);}
      row.events.push(event);row.index=index;
    });
    const recent=rows.sort((a,b)=>a.index-b.index).slice(-80);
    $('event-count').textContent=events.length?`${events.length} 条记录 · 最近 ${recent.length} 项${run?.eventsDropped?' · 更早见档案':''}`:'实时更新';
    const target=$('timeline'),sameRun=target.dataset.runId===(run?.id||''),nearBottom=target.scrollHeight-target.clientHeight-target.scrollTop<40,scrollTop=target.scrollTop;
    const markup=recent.length?recent.map(row=>{
      const event=row.events.at(-1), highlighted=/^(tool\.|member\.|review\.|feedback\.)/.test(event.type)||['discovery.decided','answer.judging','task.finished'].includes(event.type);
      const content=row.events.length>1?`<details class="timeline-group" data-log-group="${esc(row.key)}"><summary>${esc(describeEvent(event))}<span class="timeline-group-count">同类记录 ${row.events.length} 条 · 展开明细</span></summary><div class="timeline-group-records">${row.events.map(item=>`<div class="timeline-detail"><time>${esc(formatTime(item.time))}</time><p>${esc(describeEvent(item))}</p>${timelineEvidence(item)}</div>`).join('')}</div></details>`:esc(describeEvent(event))+timelineEvidence(event);
      return `<div class="timeline-event ${highlighted?'highlight':''}" data-log-row="${esc(row.key)}"><span class="timeline-time">${esc(formatTime(event.time))}</span><i class="timeline-dot"></i><div class="timeline-text">${content}</div></div>`;
    }).join(''):'<div class="empty-small">任务开始后，在这里跟进每一步进展。</div>';
    if(sameRun&&timelineMarkup===markup)return;
    const expanded=new Set(sameRun?[...target.querySelectorAll('[data-log-group][open]')].map(node=>node.dataset.logGroup):[]),top=target.getBoundingClientRect().top;
    const anchor=sameRun?[...target.querySelectorAll('[data-log-row]')].find(node=>node.getBoundingClientRect().bottom>top):null,anchorOffset=anchor?anchor.getBoundingClientRect().top-top:0,anchorId=anchor?.dataset.logRow;
    target.dataset.runId=run?.id||'';timelineMarkup=markup;target.innerHTML=markup;
    target.querySelectorAll('[data-log-group]').forEach(node=>node.open=expanded.has(node.dataset.logGroup));
    if(!sameRun||nearBottom)target.scrollTop=target.scrollHeight;
    else{target.scrollTop=scrollTop;const next=[...target.querySelectorAll('[data-log-row]')].find(node=>node.dataset.logRow===anchorId);if(next)target.scrollTop+=next.getBoundingClientRect().top-target.getBoundingClientRect().top-anchorOffset;}
  }
  function timelineEvidence(event) {
    const diagnostic=[event.toolCallId || event.callId ? '调用：'+(event.toolCallId || event.callId) : '',Number.isInteger(event.totalFailures)?'累计异常 '+event.totalFailures+' 次':'',Number.isInteger(event.noProgressFailures)?'无进展异常 '+event.noProgressFailures+' 次':'',typeof event.operationFingerprint==='string'?'操作标识：'+event.operationFingerprint:''].filter(Boolean);
    const reference=event.evidenceRef || event.outputRef;
    return `${diagnostic.length?`<small class="timeline-diagnostic">${esc(diagnostic.join(' · '))}</small>`:''}${reference?`<button type="button" class="link-button timeline-evidence" data-log-evidence="${esc(reference)}">查看明细证据</button>`:''}`;
  }
  function reasonName(reason) { return {answer_valid:'答案通过老师验收',answer_invalid:'历史任务的答案未通过老师验收并已结束',task_timeout:'已达到任务时间上限',discussion_round_limit:'已达到讨论轮数上限',review_round_limit:'已达到审查轮数上限',stopped:'用户已停止任务',user_stopped:'用户已停止任务',UserStopped:'用户已停止任务'}[reason] || reason || ''; }
  function renderResult(run) {
    const result = run?.result; const ready = Boolean(run && run.status === 'completed' && result?.reason !== 'answer_invalid');
    $('result-panel').hidden = !ready; $('answer-empty').hidden = ready;
    $('answer-empty').textContent = run && terminal(run.status) && !ready ? `本次任务未产生通过验收的最终答案。${run.error ? ' ' + reasonName(text(run.error)) : run.result?.reason ? ' ' + reasonName(run.result.reason) : ''}` : '暂无最终答案。老师审查通过后在这里显示；未通过的候选与改进意见可在黑板和讨论日志中查看。';
    const passed = ready && run.status === 'completed' && result?.reason !== 'answer_invalid';
    $('result-status').textContent = ready ? passed ? '验证通过' : '验证失败' : '';
    $('result-status').className = 'result-status' + (ready ? passed ? ' passed' : ' failed' : '');
    const answer = result?.answer?.content ?? result?.answer;
    $('result-content').innerHTML = passed ? `${answer != null ? `<section class="result-section"><h4>最终答案</h4><pre>${esc(text(answer))}</pre></section>` : ''}${result?.report != null ? `<section class="result-section"><h4>老师验收报告</h4><pre>${esc(text(result.report))}</pre></section>` : ''}` : '';
  }
  function evidenceControls() {
    const view = evidenceState;
    $('evidence-content').setAttribute('aria-busy',String(Boolean(view?.loading)));
    $('evidence-search').disabled = !view || view.loading;
    $('evidence-prev').disabled = !view || view.loading || !view.previous.length;
    $('evidence-next').disabled = !view || view.loading || view.nextOffset == null;
    $('evidence-back').hidden = !view?.outputReference;
    $('evidence-back').disabled = Boolean(view?.loading);
    $('evidence-retry').disabled = Boolean(view?.loading);
    $('evidence-filters').hidden = Boolean(view?.outputReference);
  }
  function renderEvidenceRecords(records) {
    return records.length ? records.map(record => {
      const activity = record.activity || {};
      const result = activity.result || record.result || {};
      const outputReference = record.entry?.fullContentRef || record.fullContentRef || result.fullContentRef || result.outputRef || activity.outputRef || record.outputRef;
      const reference = record.reference || '';
      const validation = record.kind === 'tool_validation' ? toolValidationLabel(record) : null;
      const validationStatus = record.status === 'exhausted' && record.attempt === 0 ? immediateRecoveryReason(record) : {rejected:'待模型纠正',error:'待模型纠正',validation_error:'待模型纠正','tool.validation_error':'待模型纠正',recovered:'已恢复',validation_recovered:'已恢复','tool.validation_recovered':'已恢复',normalized:'已规范化',retrying:'接口或响应重试',exhausted:'自动恢复已达上限',validation_exhausted:'自动恢复已达上限','tool.validation_exhausted':'自动恢复已达上限'}[record.status] || (validation?.fatal ? '调用结构异常' : '校验记录');
      const heading = validation ? ['工具恢复记录',validation.member,validation.tool,validationStatus,validation.attempt ? `第 ${validation.attempt}/${validation.max} 次` : '',reference].filter(Boolean).join(' · ') : [record.kind || '记录',record.studentId ? personName(record.studentId) : '',activity.action?.name || '',activity.status || '',reference].filter(Boolean).join(' · ');
      return `<article class="evidence-record"><h3>${esc(heading)}</h3><pre tabindex="0">${esc(text(record))}</pre>${result.truncated || activity.truncated || record.truncated ? '<p class="field-note">上方为截断摘要；如有原始输出，可分页查看完整留存内容。</p>' : ''}${outputReference ? `<button type="button" class="link-button" data-output-reference="${esc(outputReference)}">${record.entry?.fullContentRef || record.fullContentRef || result.fullContentRef ? '查看完整成果' : '查看原始工具输出'}</button>` : ''}</article>`;
    }).join('') : '<p class="empty-small">没有找到记录。旧任务可能没有保存独立成果档案。</p>';
  }
  async function loadEvidence(offset = 0, previous = []) {
    const view = evidenceState, dialog = $('evidence-dialog');
    if (!view || !dialog.open || view.loading) return;
    const request = ++evidenceRequest, session = dialogSessions.get(dialog);
    const current = () => evidenceState === view && request === evidenceRequest && dialog.open && dialogSessions.get(dialog) === session;
    view.loading = true; evidenceControls(); $('evidence-error').hidden = true; $('evidence-retry').hidden = true;
    const output = Boolean(view.outputReference);
    const query = new URLSearchParams({offset:String(offset),limit:output ? '32768' : '20'});
    if (output) query.set('reference',view.outputReference);
    else for (const key of ['reference','studentId','kind']) if (view[key]) query.set(key,view[key]);
    try {
      const result = await api(`/api/runs/${encodeURIComponent(view.runId)}/${output ? 'output' : 'evidence'}?${query}`,{isCurrent:current});
      if (!current()) return;
      view.offset = offset; view.previous = previous;
      view.nextOffset = Number.isSafeInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
      if (output) {
        $('evidence-content').innerHTML = `<p class="field-note">${esc(view.outputReference)}</p><pre class="evidence-output" tabindex="0">${esc(result.output || '')}</pre>`;
        $('evidence-page').textContent = `字节 ${offset}–${result.nextOffset ?? result.totalBytes ?? offset} / ${result.totalBytes ?? '—'}${view.nextOffset != null ? ' · 后续内容可翻页查看' : ' · 已到末页'}`;
      } else {
        const records = Array.isArray(result.records) ? result.records : [];
        $('evidence-content').innerHTML = renderEvidenceRecords(records);
        $('evidence-page').textContent = records.length ? `第 ${offset + 1}–${offset + records.length} 条 / ${result.total ?? '—'} 条` : '0 条记录';
      }
      const warnings = [typeof result.warning === 'string' ? result.warning : '',storageDescription(result.storageWarning)].filter(Boolean);
      if (Number.isSafeInteger(result.incompleteTailBytes) && result.incompleteTailBytes > 0 && !warnings.length) warnings.push('档案末尾有未完整保存的内容，当前仅显示可读取的记录。');
      $('evidence-warning').textContent = warnings.join('\n'); $('evidence-warning').hidden = !warnings.length;
      $('evidence-content').scrollTop = 0;
    } catch (error) {
      if (current()) { view.failedRequest={offset,previous}; $('evidence-error').textContent = error.message; $('evidence-error').hidden = false; $('evidence-retry').hidden = false; }
    } finally { if (current()) { view.loading = false; evidenceControls(); } }
  }
  function openEvidence(reference = '', trigger = document.activeElement) {
    const run = selectedRun();
    if (clearingRunId || !run?.id || document.querySelector('dialog[open]')) return;
    evidenceReturnLogsRunId='';$('evidence-return-logs').hidden=true;
    evidenceState = {runId:run.id,reference:reference.startsWith('output:') ? '' : reference,studentId:'',kind:'',outputReference:reference.startsWith('output:') ? reference : '',offset:0,previous:[],nextOffset:null,loading:false};
    $('evidence-dialog-title').textContent = reference.startsWith('output:') && reference.includes(':text-') ? '完整成果' : '运行档案';
    $('evidence-reference').value = evidenceState.reference;
    $('evidence-member').innerHTML = '<option value="">所有成员</option>' + (run.team?.students || state?.agents?.filter(agent=>agent.role==='student') || []).map(student=>`<option value="${esc(student.id)}">${esc(student.name || personName(student.id))}</option>`).join('') + `<option value="${esc(run.team?.teacher || 'teacher')}">老师</option>`;
    $('evidence-kind').value = '';
    $('evidence-content').innerHTML = '<p class="empty-small">正在读取运行档案…</p>'; $('evidence-page').textContent = '';
    $('evidence-warning').textContent = ''; $('evidence-warning').hidden = true;
    openDialog('evidence-dialog',trigger); evidenceControls(); loadEvidence();
  }
  $('evidence-button').addEventListener('click',()=>openEvidence('', $('evidence-button')));
  function openLogEvidence(reference, trigger) {
    const run=selectedRun();if(!$('logs-dialog').open||!run?.id||clearingRunId)return;
    $('logs-dialog').close();openEvidence(reference,trigger);
    if($('evidence-dialog').open){evidenceReturnLogsRunId=run.id;$('evidence-return-logs').hidden=false;}
  }
  $('evidence-return-logs').addEventListener('click',()=>{
    const runId=evidenceReturnLogsRunId;evidenceReturnLogsRunId='';evidenceRequest++;evidenceState=null;$('evidence-dialog').close();
    if(selectedRun()?.id===runId&&!clearingRunId)openDialog('logs-dialog',$('logs-button'));
  });
  $('evidence-search').addEventListener('click',()=>{
    if (!evidenceState || evidenceState.loading) return;
    const reference = $('evidence-reference').value.trim();
    Object.assign(evidenceState,{reference:reference.startsWith('output:') ? '' : reference,outputReference:reference.startsWith('output:') ? reference : '',studentId:$('evidence-member').value,kind:$('evidence-kind').value});
    loadEvidence();
  });
  $('evidence-prev').addEventListener('click',()=>{const view=evidenceState;if(view?.previous.length)loadEvidence(view.previous.at(-1),view.previous.slice(0,-1));});
  $('evidence-next').addEventListener('click',()=>{const view=evidenceState;if(view?.nextOffset!=null)loadEvidence(view.nextOffset,[...view.previous,view.offset]);});
  $('evidence-back').addEventListener('click',()=>{if(evidenceState&&!evidenceState.loading){evidenceState.outputReference='';loadEvidence();}});
  $('evidence-retry').addEventListener('click',()=>{const request=evidenceState?.failedRequest;if(request)loadEvidence(request.offset,request.previous);});
  $('evidence-dialog').addEventListener('close',()=>{if(!$('evidence-dialog').open){evidenceRequest++;evidenceState=null;}});
  function renderAgents() {
    const agents = state?.agents || [];
    if (!agents.length) { $('agents-content').innerHTML = `<div class="large-empty">${icon('users')}<h3>欢迎来到教室</h3><p>添加老师和学生，为每位成员设置模型与独特视角。</p><button class="button primary" data-add-agent>添加第一位成员</button></div>`; return; }
    $('agents-content').innerHTML = ['teacher','student'].map(role => { const group=agents.filter(a=>a.role===role); return `<h2 class="agent-group-title">${role==='teacher'?'老师':'学生'} <small>${group.length} 位</small></h2><div class="agent-grid">${group.length ? group.map(agent=>`<article class="card agent-card"><div class="agent-card-head"><span class="avatar ${role==='teacher'?'teacher':''}">${esc(agent.name.slice(0,1))}</span><div><h3>${esc(agent.name)}</h3><span class="role-tag">${role==='teacher'?'TEACHER · 老师':'STUDENT · 学生'}</span></div></div><div class="agent-model-line"><div class="agent-model">${esc(agent.model)}</div><span class="protocol-badge">${apiProtocols[agentProtocol(agent)].label}</span></div><div class="agent-url">${esc(agent.baseUrl)}</div>${agent.perspective?.trim() ? `<div class="agent-perspective">${esc(agent.perspective)}</div>` : ''}<p class="agent-key ${agent.hasKey?'':'missing'}">${agent.hasKey?'● 密钥已保存':'○ 未配置密钥'}${agent.jsonMode && agentProtocol(agent)!=='messages'?' · JSON 模式':''}</p><div class="agent-actions"><button class="link-button" data-agent-edit="${esc(agent.id)}">编辑配置</button><button class="link-button" data-agent-check="${esc(agent.id)}">${pendingChecks.has(agent.id)?'连接测试中…':'测试连接'}</button><button class="link-button delete-agent" data-agent-delete="${esc(agent.id)}">移除</button></div></article>`).join('') : `<div class="large-empty"><p>${role==='teacher'?'请添加一位老师。':'请添加至少两位学生。'}</p><button class="button secondary" data-add-agent="${role}">添加${role==='teacher'?'老师':'学生'}</button></div>`}</div>`; }).join('');
  }
  function renderHistory() {
    const records = state?.history || []; $('history-count').textContent = `${records.length} 次讨论`;
    $('history-content').innerHTML = records.length ? records.map(run=>`<div class="history-row"><div><p class="history-task" title="${esc(run.task)}">${esc(run.task || '未命名任务')}</p><span class="history-id">${esc(run.id)}</span></div><time class="history-date">${esc(formatDate(run.startedAt))}</time><span class="status-badge ${Object.hasOwn(statusNames,run.status)?run.status:'idle'}">${esc(statusNames[run.status] || run.status)}</span><button class="button secondary" data-run-view="${esc(run.id)}">查看详情</button></div>`).join('') : `<div class="large-empty">${icon('clock')}<h3>还没有讨论记录</h3><p>每次讨论的黑板与结果都会保留在本地。</p><button class="button secondary" data-go-workspace>开始第一次讨论</button></div>`;

  }
  function fillDataDirectory() {
    if (!state || dataDirectoryDirty || directoryPickerPending || dataDirectorySaving) return;
    $('data-directory-input').value = state.dataDir || '';
  }
  function dataDirectoryStatus(message, error = false) {
    $('data-directory-status').textContent = message;
    $('data-directory-status').hidden = !message;
    $('data-directory-status').classList.toggle('error',error);
  }
  function renderStorageNotices() {
    const warning = typeof state?.migrationWarning === 'string' ? state.migrationWarning : '';
    const launcher = typeof state?.recoveryLauncher === 'string' ? state.recoveryLauncher : '';
    const message = warning ? [warning,state?.dataDir ? '当前数据目录：'+state.dataDir : '',launcher ? '备用启动入口：\n'+launcher : ''].filter(Boolean).join('\n') : '';
    $('data-directory-warning').textContent = message; $('data-directory-warning').hidden = !warning;
    const warnings = Array.isArray(state?.storageWarnings) ? state.storageWarnings.filter(item=>item && typeof item==='object') : [];
    $('storage-warning-history').hidden = !warnings.length;
    $('storage-warning-count').textContent = `存储错误记录（${warnings.length}）`;
    $('storage-warning-list').innerHTML = warnings.slice(-20).reverse().map(item=>`<div class="storage-warning-record"><strong>${item.runId && item.runId===state?.run?.id ? '当前任务的记录' : '历史存储记录'}${item.recordedAt ? ' · '+esc(formatDate(item.recordedAt)) : ''}</strong><p>${esc(storageDescription(item))}</p>${item.runId ? `<small>任务：${esc(item.runId)}</small>` : ''}</div>`).join('');
  }
  function markDataDirectoryDraft() {
    dataDirectoryDirty = $('data-directory-input').value.trim() !== (state?.dataDir || '');
    dataDirectoryStatus(dataDirectoryDirty ? '目录已修改，点击保存后生效。' : '');
    updateControls();
  }
  function formatTime(value) { if(!value)return '—'; const d=new Date(value); return Number.isNaN(d.getTime())?'—':d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); }
  function formatDate(value) { if(!value)return '—'; const d=new Date(value); return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
  const memoryKinds = {user:'用户画像',agent:'Agent画像'};
  const memoryCategories = {fact:'事实',inference:'推断',preference:'偏好',experience:'经验'};
  const memoryStatuses = {active:'已启用',paused:'已暂停',invalid:'已失效'};
  const memoryEntryStatus = value => ['expired','superseded'].includes(value)?'invalid':value;
  const memoryRoles = {user:'用户',teacher:'老师',student:'学生',assistant:'助手',system:'系统',tool:'工具'};
  const memoryViews = {entries:{offset:0,nextOffset:null,total:0,loading:false,request:0,loaded:false}};
  let memoryStatus = null, memoryStatusRequest = 0, memoryStatusLoading = false, memoryLastStatus = 0;
  let memoryBusy = false, memorySettingsDirty = false, memoryContext = null, memoryContextRequest = 0, memoryDataDir = '';
  let memoryRequestedJob = null;
  function memoryError(message = '') { $('memory-error').textContent=message; $('memory-error').hidden=!message; }
  function memoryDeletionNotice(result, completedMessage) {
    if(result?.memoryCleanupPending!==true)return {pending:false,message:completedMessage};
    const warning=typeof result.warning==='string'&&result.warning.trim()?result.warning.trim():'记忆索引暂不可用，恢复后将根据删除记录继续清理残留。';
    return {pending:true,message:'原始任务档案已清除，关联记忆的索引清理尚未完成。\n'+warning};
  }
  function showMemoryDeletionNotice(notice) {
    if(notice.pending)memoryError(notice.message);
    toast(notice.message,notice.pending);
  }
  function memoryOptions(id, options, first) {
    const select=$(id), value=select.value;
    const markup=first+options.map(item=>`<option value="${esc(item.id)}">${esc(item.label||item.name||item.id)}</option>`).join('');
    if(select.innerHTML!==markup){select.innerHTML=markup;if([...select.options].some(option=>option.value===value))select.value=value;}
  }
  function memoryUpdateOptions() {
    const agents=(state?.agents||[]).map(agent=>({id:agent.id,label:`${agent.name} · ${memoryRoles[agent.role]||agent.role}`}));
    // Preserve a removed member when reviewing an existing role memory.
    const editAgent=$('memory-edit-agent').value;
    const editAgents=editAgent&&!agents.some(agent=>agent.id===editAgent)?[...agents,{id:editAgent,label:editAgent+'（历史成员）'}]:agents;
    memoryOptions('memory-edit-agent',editAgents,'<option value="">共享</option>');
  }
  function memoryControls() {
    const locked=memoryBusy||shutdown||shuttingDown||!lastConnection||!token||state?.relocating===true;
    $('page-memory').querySelectorAll('button').forEach(button=>{button.disabled=locked;});
    $('memory-enabled').disabled=locked||!memoryStatus;
    $('memory-settings-save').disabled=locked||!memorySettingsDirty||!memoryStatus;
    for(const name of ['entries']){
      const view=memoryViews[name];
      $(`memory-${name}-prev`).disabled=locked||view.loading||view.offset===0;
      $(`memory-${name}-next`).disabled=locked||view.loading||view.nextOffset==null;
    }
    $('memory-entry-save').disabled=locked;
    $('memory-context-prev').disabled=locked||!memoryContext||memoryContext.loading||memoryContext.offset===0;
    $('memory-context-next').disabled=locked||!memoryContext||memoryContext.loading||memoryContext.nextOffset==null;
    $('memory-extract').disabled=locked||!memoryContext||memoryContext.loading||!memoryStatus?.enabled;
    $('memory-forget').disabled=locked||!memoryContext||memoryContext.loading;
    $('memory-reflect').disabled=locked||!memoryStatus?.enabled;
  }
  function memoryActivity(status) {
    if(!status)return {label:'正在读取',className:'idle',detail:''};
    if(status.enabled!==true)return {label:'已关闭',className:'idle',detail:''};
    if(status.available===false||status.error)return {label:'暂时不可用',className:'failed',detail:text(status.error)};
    const jobs=Array.isArray(status.jobs)?status.jobs:status.jobs?.items||[];
    const activityTime=job=>Math.max(0,...['startedAt','finishedAt','createdAt'].map(key=>Date.parse(job[key])||0));
    const latest=items=>items.reduce((last,job)=>!last||activityTime(job)>=activityTime(last)?job:last,null);
    const running=latest(jobs.filter(job=>job.status==='running'));
    const requested=memoryRequestedJob&&(jobs.find(job=>job.id===memoryRequestedJob.id)||memoryRequestedJob);
    const selected=requested&&['pending','queued','running'].includes(requested.status)?requested:latest(requested?[...jobs,requested]:jobs);
    const job=running||selected;
    if(job?.status==='running')return {label:job.type==='extract'?'会话整理中':'记忆整理中',className:'running',detail:''};
    if(job?.status==='failed')return {label:'整理失败',className:'failed',detail:text(job.error)};
    if(['completed','succeeded'].includes(job?.status))return {label:'整理成功',className:'completed',detail:''};
    if(['pending','queued'].includes(job?.status))return {label:job.notice?.includes('模型')?'等待模型配置':job.type==='extract'?'等待会话整理':'等待记忆整理',className:'idle',detail:text(job.notice)};
    return {label:'已启用',className:'completed',detail:''};
  }
  function memoryRenderStatus() {
    const status=memoryStatus;
    if(!status){memoryControls();return;}
    const activity=memoryActivity(status);
    $('memory-state').textContent=activity.label;$('memory-state').className='status-badge '+activity.className;$('memory-state').title=activity.detail;
    $('memory-summary').textContent=[`${Number(status.sessions)||0} 个会话`,`${Number(status.records)||0} 条原始记录`,`${Number(status.memories)||0} 条长期记忆`].join(' · ');
    if(!memorySettingsDirty)$('memory-enabled').checked=status.enabled===true;
    memoryUpdateOptions();memoryControls();
  }
  async function refreshMemory(force=false) {
    const interval=$('memory-settings-dialog').open||['pending','queued','running'].includes(memoryRequestedJob?.status)?1000:5000;
    if(!token||shutdown||shuttingDown||memoryStatusLoading||memoryBusy||(!force&&Date.now()-memoryLastStatus<interval))return;
    memoryStatusLoading=true;const request=++memoryStatusRequest;
    try{
      const result=await api('/api/memory/status',{isCurrent:()=>request===memoryStatusRequest});
      if(request!==memoryStatusRequest)return;
      const changed=memoryStatus?.memories!==result.memories||JSON.stringify(memoryStatus?.jobs)!==JSON.stringify(result.jobs);
      if(changed)memoryViews.entries.loaded=false;
      const currentJob=memoryRequestedJob?.id&&(Array.isArray(result.jobs)?result.jobs:result.jobs?.items||[]).find(job=>job.id===memoryRequestedJob.id);
      if(currentJob)memoryRequestedJob=['completed','succeeded','failed','cancelled'].includes(currentJob.status)?null:currentJob;
      memoryStatus=result;memoryLastStatus=Date.now();memoryRenderStatus();
      if(force||!memoryViews.entries.loaded){memoryError();await loadMemoryEntries(force?0:memoryViews.entries.offset);}
    }catch(error){if(request===memoryStatusRequest){memoryError(error.message);$('memory-state').textContent='读取失败';}}
    finally{memoryStatusLoading=false;memoryControls();}
  }
  function memoryPagination(name,result,offset) {
    const view=memoryViews[name];view.offset=Number(result.offset??offset)||0;view.total=Number(result.total)||0;view.nextOffset=result.nextOffset??(result.hasMore?view.offset+(result.items?.length||20):null);view.loaded=true;
    $(`memory-${name}-page`).textContent=view.total?`${view.offset+1}–${Math.min(view.offset+(result.items?.length||0),view.total)} / ${view.total}`:'';
  }
  function memoryRecordMarkup(record) {
    const reference=record.reference||'';
    const body=record.text??record.content??text(record.payload);
    const member=record.agentName||person(record.agentId)?.name||record.agentId||'';
    return `<article class="card memory-record"><div class="memory-record-meta"><span>${esc(memoryRoles[record.role]||record.role||'记录')}</span>${member?`<span>${esc(member)}</span>`:''}<span>${esc(record.kind||'')}</span><time>${esc(formatDate(record.timestamp||record.startedAt))}</time></div><pre class="memory-original">${esc(body)}</pre>${reference?`<p class="memory-reference">来源：${esc(reference)}${record.chunkCount>1?` · 第 ${Number(record.chunkIndex)+1}/${Number(record.chunkCount)} 段`:''}</p>`:''}</article>`;
  }
  function memorySourceMarkup(reference) {
    if(String(reference).startsWith('memory:'))return `<button type="button" class="link-button memory-source" data-memory-edit="${esc(reference.slice(7))}">${esc(reference)}</button>`;
    return `<button type="button" class="link-button memory-source" data-memory-source="${esc(reference)}">${esc(reference)}</button>`;
  }
  function memoryEntryMarkup(entry) {
    const status=memoryEntryStatus(entry.status),nextStatus=status==='active'?'paused':'active';
    const review=[({usable:'可参考',uncertain:'待核验',expired:'已过期',invalid:'已失效'})[entry.reviewVerdict]||entry.reviewVerdict,entry.reviewReason,entry.reviewedAt?formatDate(entry.reviewedAt):''].filter(Boolean).join(' · ');
    return `<article class="card memory-record"><div class="memory-record-meta"><strong>${esc(memoryKinds[entry.kind]||entry.kind)}</strong><span>${esc(memoryCategories[entry.category]||entry.category)}</span><span class="memory-status ${esc(status)}">${esc(memoryStatuses[status]||status)}</span>${entry.agentId?`<span>${esc(person(entry.agentId)?.name||entry.agentId)}</span>`:''}<time>${esc(formatDate(entry.updatedAt||entry.createdAt))}</time></div><p class="memory-entry-text">${esc(entry.content)}</p>${entry.expiresAt?`<p class="field-note">有效期至 ${esc(formatDate(entry.expiresAt))}</p>`:''}${review?`<p class="memory-review">最近使用前评估：${esc(review)}</p>`:''}${status==='invalid'?'<p class="field-note">启用后仍受有效期与使用前评估限制，可编辑内容和有效期。</p>':''}<details class="memory-provenance"><summary>来源</summary><p class="memory-reference">${esc(entry.id)}</p><div class="memory-sources">${(entry.sourceRefs||[]).map(memorySourceMarkup).join('')||'<span>未关联来源</span>'}</div>${entry.reviewSourceRefs?.length?`<p>评估参考来源</p><div class="memory-sources">${entry.reviewSourceRefs.map(memorySourceMarkup).join('')}</div>`:''}</details><div class="memory-entry-actions"><button type="button" class="link-button" data-memory-toggle="${esc(entry.id)}" data-memory-status="${nextStatus}">${nextStatus==='paused'?'暂停':'启用'}</button><button type="button" class="link-button" data-memory-edit="${esc(entry.id)}">查看 / 编辑</button><button type="button" class="link-button memory-delete" data-memory-delete="${esc(entry.id)}">删除</button></div></article>`;
  }
  async function loadMemoryEntries(offset=0) {
    const view=memoryViews.entries,request=++view.request;view.loading=true;memoryControls();
    try{
      const params=new URLSearchParams({offset:String(offset),limit:'20'});
      for(const [key,id] of [['query','memory-entry-query'],['status','memory-entry-status'],['kind','memory-entry-kind']])if($(id).value.trim())params.set(key,$(id).value.trim());
      const result=await api('/api/memory/entries?'+params);
      if(request!==view.request)return;
      const empty=!result.items?.length;
      $('memory-entries-content').classList.toggle('memory-empty',empty);
      $('memory-entries-content').innerHTML=empty?'<div class="memory-empty-message">暂无记录</div>':result.items.map(memoryEntryMarkup).join('');
      memoryPagination('entries',result,offset);
    }catch(error){if(request===view.request){memoryError(error.message);view.nextOffset=null;}}
    finally{if(request===view.request)view.loading=false;memoryControls();}
  }
  async function memoryAction(work) {
    if(memoryBusy||shutdown||shuttingDown||!token)return;
    memoryBusy=true;memoryError();memoryControls();
    try{await work();}catch(error){toast(error.message,true);memoryError(error.message);}
    finally{memoryBusy=false;memoryLastStatus=0;memoryControls();await refreshMemory(false);}
  }
  async function memorySetEntryStatus(id,status) {
    if(!['active','paused'].includes(status))return;
    await memoryAction(async()=>{await api('/api/memory/entries/'+encodeURIComponent(id),{method:'PUT',body:{status}});toast(status==='active'?'记忆已启用。':'记忆已暂停。');await loadMemoryEntries(memoryViews.entries.offset);});
  }
  async function saveMemorySettings() {
    const session=dialogSessions.get($('memory-settings-dialog')),body={enabled:$('memory-enabled').checked};
    await memoryAction(async()=>{await api('/api/memory/settings',{method:'PUT',body});memorySettingsDirty=false;closeSavedDialog('memory-settings-dialog',session);toast('记忆设置已保存。');});
  }
  async function requestMemoryJob(type,sessionId) {
    await memoryAction(async()=>{
      memoryRequestedJob={type,status:'pending',createdAt:new Date().toISOString()};memoryRenderStatus();
      try{memoryRequestedJob=await api('/api/memory/jobs',{method:'POST',body:{type,...(sessionId?{sessionId}:{})}});memoryRenderStatus();}
      catch(error){memoryRequestedJob={type,status:'failed',error:error.message,finishedAt:new Date().toISOString()};memoryRenderStatus();throw error;}
    });
  }
  function memoryLocalDate(value) {
    if(!value)return '';
    const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
    return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
  }
  async function openMemoryEntry(id='',trigger=document.activeElement) {
    if(!id||document.querySelector('dialog[open]'))return;
    let entry;
    try{const result=await api('/api/memory/entries/'+encodeURIComponent(id));entry=result.entry||result;}
    catch(error){toast(error.message,true);return;}
    if(document.querySelector('dialog[open]'))return;
    $('memory-edit-id').value=entry.id||'';
    for(const key of ['kind','category','status','content'])$('memory-edit-'+key).value=key==='status'?memoryEntryStatus(entry.status):(entry[key]||'');
    memoryUpdateOptions();
    if(entry.agentId&&![...$('memory-edit-agent').options].some(option=>option.value===entry.agentId))$('memory-edit-agent').add(new Option(entry.agentId+'（历史成员）',entry.agentId));
    $('memory-edit-agent').value=entry.agentId||'';$('memory-edit-sources').value=(entry.sourceRefs||[]).join('\n');$('memory-edit-expires').value=memoryLocalDate(entry.expiresAt);
    openDialog('memory-entry-dialog',trigger);
  }
  async function openMemorySession(sessionId,reference='',trigger=document.activeElement) {
    if((!sessionId&&!reference)||document.querySelector('dialog[open]'))return;
    memoryContext={id:sessionId,reference,offset:0,nextOffset:null,loading:false};
    $('memory-context-reference').value=reference;$('memory-session-meta').textContent=sessionId;
    $('memory-context-content').innerHTML='';openDialog('memory-session-dialog',trigger);await loadMemoryContext();
  }
  async function loadMemoryContext(offset) {
    const view=memoryContext;if(!view)return;
    const request=++memoryContextRequest;view.loading=true;memoryControls();$('memory-context-error').hidden=true;
    try{
      const params=new URLSearchParams({limit:'20'});
      // Let the server center the first page on an opaque source reference.
      if(offset!==undefined||!view.reference)params.set('offset',String(offset??0));
      if(view.reference)params.set('reference',view.reference);
      const result=await api((view.id?'/api/memory/sessions/'+encodeURIComponent(view.id):'/api/memory/source')+'?'+params,{isCurrent:()=>request===memoryContextRequest});
      if(request!==memoryContextRequest||memoryContext!==view)return;
      if(result.session?.id)view.id=result.session.id;
      const records=result.items||result.records||[];
      $('memory-session-meta').textContent=[result.session?.task||view.id,formatDate(result.session?.startedAt)].filter(Boolean).join(' · ');
      $('memory-context-content').innerHTML=records.length?records.map(memoryRecordMarkup).join(''):'<div class="empty-small">没有可展示的原始记录。</div>';
      view.offset=Number(result.offset??offset)||0;view.nextOffset=result.nextOffset??(result.hasMore?view.offset+records.length:null);
      $('memory-context-page').textContent=result.total?`${view.offset+1}–${Math.min(view.offset+records.length,result.total)} / ${result.total}`:'暂无记录';
      $('memory-context-content').scrollTop=0;
    }catch(error){if(request===memoryContextRequest){$('memory-context-error').textContent=error.message;$('memory-context-error').hidden=false;}}
    finally{if(request===memoryContextRequest)view.loading=false;memoryControls();}
  }
  function memoryRender() {
    if(memoryDataDir&&memoryDataDir!==state?.dataDir){
      memoryStatusRequest++;memoryContextRequest++;memoryStatus=null;memoryLastStatus=0;memorySettingsDirty=false;memoryContext=null;memoryRequestedJob=null;
      for(const [name,view] of Object.entries(memoryViews)){view.request++;view.loaded=false;view.loading=false;view.nextOffset=null;$(`memory-${name}-content`).innerHTML='';}
      $('memory-context-content').innerHTML='';$('memory-session-meta').textContent='数据目录已更改，请重新选择会话。';
    }
    memoryDataDir=state?.dataDir||'';memoryUpdateOptions();memoryControls();
    if(page==='memory')refreshMemory();
  }
  let agentsStamp='', historyStamp='';
  function render() {
    fillSettings(); fillDataDirectory(); fillTaskInput(); renderStorageNotices(); renderRun(); renderTeam();
    const nextAgents=JSON.stringify(state?.agents), nextHistory=JSON.stringify(state?.history);
    if(nextAgents!==agentsStamp){agentsStamp=nextAgents;renderAgents();}
    if(nextHistory!==historyStamp){historyStamp=nextHistory;renderHistory();}
    updateControls();
    memoryRender();
  }
  async function refresh() {
    if (!token || shutdown || shuttingDown || refreshPending || dataDirectorySaving || clearingRunId || pendingMemberRetries.size) return;
    refreshPending=true; const epoch=stateEpoch;
    try {
      const current=()=>!shutdown&&!shuttingDown&&epoch===stateEpoch;
      const nextState=await api('/api/state',{isCurrent:current}); if(!current())return;
      // Remember only the historical selection; the original text stays in the
      // existing local task record, including across refreshes and restarts.
      if (!state && savedViewingRunId) {
        if (savedViewingRunId !== nextState.run?.id && nextState.history?.some(run=>run.id===savedViewingRunId)) {
          const record=await api('/api/runs/'+encodeURIComponent(savedViewingRunId),{isCurrent:current});
          if(!current())return;
          viewingRun=record.run || record;
        } else if (savedViewingRunId !== nextState.run?.id) rememberViewingRun();
      }
      state=nextState;
      if(viewingRun && viewingRun.id!==state.run?.id && !state.history?.some(run=>run.id===viewingRun.id)){viewingRun=null;rememberViewingRun();}
      setConnection(true); $('access-notice').hidden=true; $('reconnect-button').hidden=true; render();
    }
    catch(error){ if(shutdown||shuttingDown||epoch!==stateEpoch)return; setConnection(false); if(!state && $('access-notice').hidden) showAccess('暂时无法连接本地服务',error.message + '。如果服务已退出，请重新启动 Class。'); $('reconnect-button').hidden=false; updateControls(); }
    finally { refreshPending=false; }
  }
  async function action(work) {
    if(busy)return; busy=true;updateControls();
    try{await work();await refresh();}catch(error){toast(error.message,true);}finally{busy=false;updateControls();}
  }
  async function retryMember(memberId) {
    const run = selectedRun(), failure = memberFailures(run).find(item=>item.studentId===memberId);
    if (!retryAllowed(run,failure) || pendingMemberRetries.size || busy || clearingRunId || shutdown || shuttingDown || !lastConnection || !token) return;
    const key = retryKey(run.id,memberId), epoch = ++stateEpoch;
    const current = () => epoch === stateEpoch && state?.run?.id === run.id && !clearingRunId && !shutdown && !shuttingDown;
    pendingMemberRetries.add(key); renderMemberRecovery(run); updateControls();
    try {
      const result = await api(`/api/runs/${encodeURIComponent(run.id)}/members/${encodeURIComponent(memberId)}/retry`,{method:'POST',body:{},isCurrent:current});
      if (!current()) return;
      if (result.run?.id !== run.id) throw new Error('服务未返回当前任务的恢复状态，请刷新后检查。');
      stateEpoch++; state = {...state,run:result.run};
      if (viewingRun?.id === run.id) viewingRun = result.run;
      toast('已请求重试该成员，继续同一次任务。');
    } catch (error) { if (current()) toast(error.message,true); }
    finally { pendingMemberRetries.delete(key); render(); await refresh(); }
  }
  async function clearSelectedTask() {
    const run = selectedRun();
    if (!run?.id || $('clear-task-button').disabled || busy || clearingRunId) return;
    if (!confirm('清除这个任务、原始讨论记录及关联记忆？此操作无法撤销。')) return;
    busy = true; clearingRunId = run.id;
    // State reads issued before deletion must never restore the deleted task.
    stateEpoch++; renderRun(); updateControls();
    try {
      const result = await api('/api/runs/' + encodeURIComponent(run.id),{method:'DELETE'});
      if (result.ok !== true || result.deletedId !== run.id || !Object.hasOwn(result,'run') || !Array.isArray(result.history)) throw new Error('服务未确认任务已清除，请刷新后检查。');
      stateEpoch++; state = {...state,...result}; viewingRun = null; pendingMemberRetries.clear();
      rememberViewingRun(); fillTaskInput(true);
      boardViews.delete(run.id); $('blackboard-content').dataset.runId=''; persistBoard();
      // Discard evidence pages and invalidate a response from an earlier dialog.
      evidenceRequest++; evidenceState = null;
      evidenceReturnLogsRunId='';$('evidence-return-logs').hidden=true;
      $('evidence-content').innerHTML = '<p class="empty-small">请选择运行档案查看记录。</p>';
      $('evidence-page').textContent = ''; $('evidence-reference').value = ''; $('evidence-kind').value = '';
      $('evidence-member').innerHTML = '<option value="">所有成员</option>';
      $('evidence-error').textContent = ''; $('evidence-error').hidden = true; $('evidence-retry').hidden = true;
      $('evidence-warning').textContent = ''; $('evidence-warning').hidden = true;
      evidenceControls(); setConnection(true);
      showMemoryDeletionNotice(memoryDeletionNotice(result,'任务、讨论记录及关联记忆已清除。'));
    } catch (error) { toast(error.message,true); }
    finally { clearingRunId = ''; busy = false; render(); }
  }
  function closeSavedDialog(id, session) {
    const dialog = $(id);
    if (dialogSessions.get(dialog) !== session) return false;
    if (dialog.open) dialog.close();
    return true;
  }
  function openDialog(id, trigger = document.activeElement) {
    if (shutdown || shuttingDown || !lastConnection || !token) return;
    const dialog = $(id); if (document.querySelector('dialog[open]')) return;
    dialogReturnFocus.set(dialog,trigger);
    dialogSessions.set(dialog,{});
    dialog.querySelector('.dialog-feedback')?.remove();
    if (id === 'settings-dialog') fillSettings();
    if (id === 'answer-dialog') renderResult(selectedRun());
    dialog.showModal();
  }
  document.querySelectorAll('dialog').forEach(dialog => {
    // Escape/backdrop cannot dismiss a modal. Explicit log/evidence navigation is allowed.
    dialog.addEventListener('cancel',event => event.preventDefault());
    dialog.addEventListener('keydown',event => {
      // Keep Enter in an input from implicitly clicking Save; button keyboard activation still works.
      if (event.key === 'Enter' && !event.isComposing && event.target.matches('input')) event.preventDefault();
    });
    // Restore a visible launch target after an explicit close.
    dialog.addEventListener('close',() => {
      dialog.querySelector('.dialog-feedback')?.remove();
      if (document.querySelector('dialog[open]')) return;
      const trigger=dialogReturnFocus.get(dialog);
      const target=trigger?.isConnected&&!trigger.disabled&&trigger.getClientRects().length?trigger:document.querySelector('.nav-item.active');
      target?.focus({preventScroll:true});
    });
  });
  [['settings-button','settings-dialog'],['team-button','team-dialog'],['logs-button','logs-dialog'],['answer-button','answer-dialog']].forEach(([buttonId,dialogId]) => {
    $(buttonId).addEventListener('click',() => openDialog(dialogId,$(buttonId)));
  });
  function agentEndpoint() {
    const protocol = $('agent-protocol').value;
    const mode = apiProtocols[protocol];
    let baseUrl = $('agent-url').value.trim().replace(/\/+$/, '');
    if (!mode) return {baseUrl,error:'请选择有效的接口模式。'};
    if (!baseUrl) return {baseUrl,error:''};
    let parsed;
    try { parsed = new URL(baseUrl); } catch { return {baseUrl,error:'请输入有效的 HTTP 或 HTTPS baseurl。'}; }
    if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || /[?#\s]/.test(baseUrl)) return {baseUrl,error:'baseurl 须使用 HTTP 或 HTTPS，且不能包含账号、密码、查询参数或片段。'};
    if (/\/(?:messages|responses|chat\/completions)$/i.test(parsed.pathname)) return {baseUrl,error:'请填写基础地址，不要包含 /v1/messages、/responses 或 /chat/completions；Class 会自动追加接口。'};
    if (protocol !== 'messages' && !parsed.pathname.endsWith('/v1')) return {baseUrl,error:mode.label + ' 模式的 baseurl 须以 /v1 结尾。'};
    if (protocol === 'messages' && parsed.pathname.endsWith('/v1')) baseUrl = baseUrl.slice(0,-3);
    return {baseUrl,error:'',url:baseUrl + mode.suffix};
  }
  function updateAgentProtocol() {
    const mode = apiProtocols[$('agent-protocol').value] || apiProtocols.messages;
    const endpoint = agentEndpoint();
    updateAgentReasoning();
    $('agent-url-help').textContent = mode.hint;
    $('agent-url').placeholder = 'https://api.openai.com/v1';
    $('agent-url').setCustomValidity(endpoint.error);
    $('agent-url').setAttribute('aria-invalid',String(Boolean(endpoint.error)));
    $('agent-endpoint').textContent = endpoint.error || (endpoint.url ? '请求地址：' + endpoint.url : '填写基础地址后预览完整请求地址。');
    $('agent-endpoint').classList.toggle('invalid',Boolean(endpoint.error));
    return endpoint;
  }
  function updateAgentReasoning(value = $('agent-reasoning').value) {
    const select = $('agent-reasoning'), protocol = $('agent-protocol').value;
    const messages = protocol === 'messages';
    const options = [['low','Low'],['medium','Medium'],['high','High'],['xhigh',messages ? 'xHigh' : 'Extra high'],['max','Max'],[messages ? 'ultracode' : 'ultra',messages ? 'Ultracode' : 'Ultra']];
    if (select.dataset.protocol !== protocol) {
      select.innerHTML = options.map(([key,label])=>`<option value="${key}"${key === 'medium' ? ' selected' : ''}>${label}</option>`).join('');
      select.dataset.protocol = protocol;
    }
    if (value === 'ultra' || value === 'ultracode') value = messages ? 'ultracode' : 'ultra';
    select.value = options.some(([key])=>key === value) ? value : 'medium';
    $('agent-reasoning-help').textContent = ['ultra','ultracode'].includes(select.value) ? '此档位按同名扩展参数发送，需要接口服务商支持。' : '具体可用档位取决于接口和模型。';
  }
  function openAgent(id, role) {
    if (document.querySelector('dialog[open]')) return;
    if(live()){toast('请等待本轮讨论结束后再调整成员。',true);return;}
    const agent=id ? person(id) : null; $('agent-form').reset();
    $('agent-id').value=agent?.id || ''; $('agent-name').value=agent?.name || ''; $('agent-role').value=agent?.role || role || ((state?.agents || []).some(a=>a.role==='teacher')?'student':'teacher');
    $('agent-protocol').value=agent ? agentProtocol(agent) : 'messages';
    $('agent-url').value=agent?.baseUrl || ''; $('agent-model').value=agent?.model || ''; $('agent-key').value='';
    $('agent-context-1m').checked=agent?.context1M === true;
    $('agent-dialog-title').textContent=agent?'编辑成员':'添加成员'; $('key-state').textContent=agent?.hasKey?'已保存':''; $('key-help').textContent=agent?.hasKey?'留空会保留已经保存的密钥。':''; $('key-help').hidden=!agent?.hasKey; $('agent-key').placeholder=agent?.hasKey?'留空保留原密钥':'输入apikey';
    updateAgentProtocol();
    updateAgentReasoning(agent?.reasoningEffort || 'medium');
    openDialog('agent-dialog'); setTimeout(()=>{if($('agent-dialog').open)$('agent-name').focus();},0);
  }
  document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.page)));
  document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();navigate('workspace');});
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.hasAttribute('data-dialog-close')){event.preventDefault();button.closest('dialog')?.close();}
    else if(button.hasAttribute('data-go-agents'))navigate('agents');
    else if(button.hasAttribute('data-go-workspace')){viewingRun=null;rememberViewingRun();navigate('workspace');render();}
    else if(button.hasAttribute('data-add-agent'))openAgent(null,button.dataset.addAgent||undefined);
    else if(button.hasAttribute('data-evidence-reference'))openEvidence(button.dataset.evidenceReference,button);
    else if(button.hasAttribute('data-log-evidence'))openLogEvidence(button.dataset.logEvidence,button);
    else if(button.hasAttribute('data-full-content-reference'))openEvidence(button.dataset.fullContentReference,button);
    else if(button.hasAttribute('data-board-jump')){const target=$('blackboard-content'),entry=[...target.querySelectorAll('[data-board-entry]')].find(node=>node.dataset.boardEntry===button.dataset.boardJump);if(entry){target.scrollTop+=entry.getBoundingClientRect().top-target.getBoundingClientRect().top-12;rememberBoard();}}
    else if(button.hasAttribute('data-member-retry'))retryMember(button.dataset.memberRetry);
    else if(button.hasAttribute('data-output-reference')){if(evidenceState&&!evidenceState.loading){evidenceState.outputReference=button.dataset.outputReference;loadEvidence();}}
    else if(button.dataset.agentEdit)openAgent(button.dataset.agentEdit);
    else if(button.dataset.agentDelete){const id=button.dataset.agentDelete;if(confirm(`移除“${personName(id)}”？已有讨论记录会保留。`))action(async()=>{await api('/api/agents/'+encodeURIComponent(id),{method:'DELETE'});toast('成员已移除。');});}
    else if(button.dataset.agentCheck){const id=button.dataset.agentCheck;pendingChecks.add(id);renderAgents();updateControls();api('/api/agents/'+encodeURIComponent(id)+'/check',{method:'POST',body:{}}).then(result=>{if(result?.ok===false)throw Error(result.error||result.message||'连接测试失败');toast(result.message||'连接成功，模型接口已响应。');}).catch(error=>toast(error.message,true)).finally(()=>{pendingChecks.delete(id);renderAgents();updateControls();});}
    else if(button.dataset.runView)action(async()=>{
      const request=++viewingRequest, current=()=>request===viewingRequest&&!clearingRunId&&!shutdown&&!shuttingDown;
      const record=await api('/api/runs/'+encodeURIComponent(button.dataset.runView),{isCurrent:current});
      if(!current())return;
      viewingRun=record.run || record;rememberViewingRun(viewingRun.id);fillTaskInput(true);
      navigate('workspace');render();window.scrollTo({top:0,behavior:'smooth'});
    });
  });
  $('add-agent-button').addEventListener('click',()=>openAgent());
  $('agent-close').addEventListener('click',()=>$('agent-dialog').close());
  $('agent-protocol').addEventListener('change',updateAgentProtocol);
  $('agent-reasoning').addEventListener('change',()=>updateAgentReasoning());
  $('agent-url').addEventListener('input',updateAgentProtocol);
  $('agent-url').addEventListener('blur',()=>{const endpoint=agentEndpoint();$('agent-url').value=endpoint.baseUrl;updateAgentProtocol();});
  $('agent-form').addEventListener('submit',event=>{event.preventDefault();const endpoint=updateAgentProtocol();if(endpoint.error){$('agent-url').reportValidity();return;}const session=dialogSessions.get($('agent-dialog'));action(async()=>{
    const body={name:$('agent-name').value.trim(),role:$('agent-role').value,protocol:$('agent-protocol').value,baseUrl:endpoint.baseUrl,model:$('agent-model').value.trim(),reasoningEffort:$('agent-reasoning').value,context1M:$('agent-context-1m').checked};
    if($('agent-id').value)body.id=$('agent-id').value;if($('agent-key').value.trim())body.apiKey=$('agent-key').value.trim();
    await api('/api/agents',{method:'POST',body});if(closeSavedDialog('agent-dialog',session))$('agent-key').value='';toast('成员配置已保存。');
  });});
  $('setting-directory-button').addEventListener('click',async()=>{
    if(directoryPickerPending||busy||live()||!lastConnection||!token||shutdown||shuttingDown)return;
    directoryPickerPending=true;directoryPickerTarget='workspace';updateControls();$('settings-dialog').querySelector('.dialog-feedback')?.remove();
    try {
      const selected=await api('/api/directories/pick',{method:'POST',body:{initialPath:$('setting-cwd').value}});
      if(shutdown||shuttingDown||selected.cancelled===true)return;
      if(selected.cancelled!==false||typeof selected.path!=='string'||!selected.path.trim())throw new Error('目录选择未返回有效路径，请重试。');
      $('setting-cwd').value=selected.path;settingsDirty=true;$('settings-dirty').hidden=false;
    }catch(error){
      if(!shutdown&&!shuttingDown){if(lastConnection&&!$('settings-dialog').open)openDialog('settings-dialog',$('settings-button'));toast(error.message,true);}
    }finally{directoryPickerPending=false;directoryPickerTarget='';updateControls();}
  });
  $('data-directory-input').addEventListener('input',markDataDirectoryDraft);
  $('data-directory-button').addEventListener('click',async()=>{
    if(directoryPickerPending||busy||live()||!lastConnection||!token||shutdown||shuttingDown)return;
    directoryPickerPending=true;directoryPickerTarget='data';updateControls();
    try {
      const selected=await api('/api/directories/pick',{method:'POST',body:{initialPath:$('data-directory-input').value.trim() || state?.dataDir || ''}});
      if(shutdown||shuttingDown||selected.cancelled===true)return;
      if(selected.cancelled!==false||typeof selected.path!=='string'||!selected.path.trim())throw new Error('目录选择未返回有效路径，请重试。');
      $('data-directory-input').value=selected.path;markDataDirectoryDraft();
    }catch(error){if(!shutdown&&!shuttingDown){dataDirectoryStatus(error.message,true);toast(error.message,true);}}
    finally{directoryPickerPending=false;directoryPickerTarget='';updateControls();}
  });
  $('data-directory-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(directoryPickerPending||busy||live()||!lastConnection||!token||shutdown||shuttingDown||!dataDirectoryDirty)return;
    const path=$('data-directory-input').value.trim();
    if(!path){dataDirectoryStatus('请填写或选择本地数据目录。',true);return;}
    action(async()=>{
      dataDirectorySaving=true;stateEpoch++;updateControls();dataDirectoryStatus('正在迁移本地数据，请稍候…');
      try {
        const result=await api('/api/data-directory',{method:'PUT',body:{path}});
        if(typeof result.dataDir!=='string'||!result.dataDir.trim())throw new Error('服务未返回有效的数据目录，请刷新后检查。');
        // Discard any state response started before relocation completed.
        stateEpoch++;state={...state,dataDir:result.dataDir,migrationWarning:result.warning || '',recoveryLauncher:result.recoveryLauncher || '',...(Array.isArray(result.storageWarnings) ? {storageWarnings:result.storageWarnings} : {}),...(result.settings ? {settings:result.settings} : {})};
        dataDirectoryDirty=false;$('data-directory-input').value=result.dataDir;
        const recovered = Array.isArray(result.recoveredFailures) ? result.recoveredFailures.length : 0;
        const message = `本地数据目录已更新：${result.dataDir}${recovered ? `\n已恢复 ${recovered} 项历史存储记录。` : ''}`;
        dataDirectoryStatus(message);renderStorageNotices();
        if (result.warning) toast(result.warning,true);
        else toast(message);
      }catch(error){dataDirectoryStatus('保存失败：'+error.message,true);throw error;}
      finally{dataDirectorySaving=false;updateControls();}
    });
  });
  $('data-directory-load').addEventListener('click',()=>{
    if(directoryPickerPending||busy||live()||!lastConnection||!token||shutdown||shuttingDown||!dataDirectoryDirty)return;
    const path=$('data-directory-input').value.trim();
    if(!path)return;
    action(async()=>{
      dataDirectorySaving=true;stateEpoch++;updateControls();dataDirectoryStatus('正在加载所选目录…');
      try{
        const result=await api('/api/data-directory/load',{method:'POST',body:{path}});
        const target=new URL(result.url);
        if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||!/^#token=[a-f0-9]{64}$/.test(target.hash))throw new Error('服务返回的启动地址无效');
        window.location.replace(target.href);
      }catch(error){dataDirectorySaving=false;updateControls();dataDirectoryStatus('加载失败：'+error.message,true);throw error;}
    });
  });
  $('settings-form').addEventListener('input',()=>{settingsDirty=true;$('settings-dirty').hidden=false;$('settings-dialog').querySelector('.dialog-feedback')?.remove();});
  $('settings-form').addEventListener('submit',event=>{event.preventDefault();if(directoryPickerPending)return;const session=dialogSessions.get($('settings-dialog'));action(async()=>{
    const body={cwd:$('setting-cwd').value.trim(),voteTimeoutMs:Math.round(Number($('setting-vote').value)*1000)};
    await api('/api/settings',{method:'PUT',body});if(closeSavedDialog('settings-dialog',session)){settingsDirty=false;$('settings-dirty').hidden=true;}toast('运行设置已保存。');
  });});
  $('task-input').addEventListener('input',()=>{taskInputDirty=true;});
  $('task-form').addEventListener('submit',event=>{
    event.preventDefault();if(directoryPickerPending)return;
    if(!teamReady()){navigate('agents');toast('请先配置 1 位老师和至少 2 位学生。',true);return;}
    if(settingsDirty){openDialog('settings-dialog',$('settings-button'));toast('运行设置尚未保存，请先保存设置。',true);return;}
    const task=$('task-input').value.trim();
    action(async()=>{
      dispatchingTask=true;renderRun();
      const result=await api('/api/runs',{method:'POST',body:{task}});
      stateEpoch++;state={...state,run:result.run};viewingRun=null;rememberViewingRun();fillTaskInput(true);
      toast('讨论已开始，所有学生正在独立求解。');
    }).finally(()=>{dispatchingTask=false;renderRun();});
  });
  $('stop-button').addEventListener('click',()=>action(async()=>{if(state?.run?.id){stateEpoch++;await api('/api/runs/'+encodeURIComponent(state.run.id)+'/stop',{method:'POST',body:{}});toast('已请求停止，正在结束本轮任务。');}}));
  $('clear-task-button').addEventListener('click',clearSelectedTask);

  $('shutdown-button').addEventListener('click',()=>{if(!confirm(live()?'当前任务仍在执行。退出服务将停止任务，是否继续？':'退出 Class 本地服务？下次启动 Class 即可重新打开。'))return;action(async()=>{
    const reply=await api('/api/shutdown',{method:'POST',body:{}});
    shutdown=true;shuttingDown=false;clearInterval(pollTimer);
    // This closes the workspace on the server's cleanup ACK, not on a process-exit probe.
    showAccess(reply.readyToExit?'已退出工作空间':'退出请求已发送',reply.readyToExit?'任务已停止，记录已保存。可以关闭此页面，下次启动 Class 即可重新打开。':'当前服务尚未确认任务停止与记录保存。本页面已停止交互，请稍候再关闭；此次未确认系统进程退出。');
    $('reconnect-button').hidden=true;
    if(reply.readyToExit)toast('任务已停止，记录已保存。');
  });});
  $('memory-refresh').addEventListener('click',()=>refreshMemory(true));
  $('memory-settings-button').addEventListener('click',()=>{memorySettingsDirty=false;memoryRenderStatus();openDialog('memory-settings-dialog',$('memory-settings-button'));refreshMemory(true);});
  $('memory-settings-form').addEventListener('change',()=>{memorySettingsDirty=true;memoryControls();});
  $('memory-settings-form').addEventListener('submit',event=>{event.preventDefault();saveMemorySettings();});
  $('memory-entry-search').addEventListener('submit',event=>{event.preventDefault();memoryError();loadMemoryEntries();});
  for(const [name,loader] of [['entries',loadMemoryEntries]]){
    $(`memory-${name}-prev`).addEventListener('click',()=>loader(Math.max(0,memoryViews[name].offset-20)));
    $(`memory-${name}-next`).addEventListener('click',()=>{if(memoryViews[name].nextOffset!=null)loader(memoryViews[name].nextOffset);});
  }
  $('memory-entry-form').addEventListener('submit',event=>{
    event.preventDefault();const session=dialogSessions.get($('memory-entry-dialog')),id=$('memory-edit-id').value;
    if(!id)return;
    const body={category:$('memory-edit-category').value,status:$('memory-edit-status').value,content:$('memory-edit-content').value.trim(),sourceRefs:$('memory-edit-sources').value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),expiresAt:$('memory-edit-expires').value?new Date($('memory-edit-expires').value).toISOString():null};
    if(!body.content){toast('请填写记忆内容。',true);return;}
    memoryAction(async()=>{await api('/api/memory/entries/'+encodeURIComponent(id),{method:'PUT',body});closeSavedDialog('memory-entry-dialog',session);toast('记忆已保存。');await loadMemoryEntries();});
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled||memoryBusy)return;
    if(button.hasAttribute('data-memory-source'))openMemorySession('',button.dataset.memorySource,button);
    else if(button.hasAttribute('data-memory-edit'))openMemoryEntry(button.dataset.memoryEdit,button);
    else if(button.hasAttribute('data-memory-toggle'))memorySetEntryStatus(button.dataset.memoryToggle,button.dataset.memoryStatus);
    else if(button.hasAttribute('data-memory-delete')&&confirm('删除这条长期记忆？此操作不会删除原始会话记录。'))memoryAction(async()=>{await api('/api/memory/entries/'+encodeURIComponent(button.dataset.memoryDelete),{method:'DELETE'});toast('记忆已删除。');await loadMemoryEntries();});
  });
  $('memory-context-form').addEventListener('submit',event=>{event.preventDefault();if(memoryContext){memoryContext.reference=$('memory-context-reference').value.trim();loadMemoryContext();}});
  $('memory-context-prev').addEventListener('click',()=>{if(memoryContext)loadMemoryContext(Math.max(0,memoryContext.offset-20));});
  $('memory-context-next').addEventListener('click',()=>{if(memoryContext?.nextOffset!=null)loadMemoryContext(memoryContext.nextOffset);});
  $('memory-session-dialog').addEventListener('close',()=>{if(!$('memory-session-dialog').open){memoryContextRequest++;memoryContext=null;}});
  $('memory-extract').addEventListener('click',async()=>{const id=memoryContext?.id;if(id){await requestMemoryJob('extract',id);$('memory-context-error').hidden=false;$('memory-context-error').textContent='会话整理状态可在记忆设置中查看。';}});
  $('memory-forget').addEventListener('click',()=>{
    const view=memoryContext;if(!view?.id)return;
    if(live()){toast('请先停止当前任务，再删除会话。',true);return;}
    if(!confirm('删除此会话的原始讨论档案、检索记录及依赖它的记忆？此操作无法撤销。'))return;
    memoryAction(async()=>{const result=await api('/api/memory/sessions/'+encodeURIComponent(view.id),{method:'DELETE'}),notice=memoryDeletionNotice(result,'会话及关联记忆已删除。');if(memoryContext===view){memoryContextRequest++;memoryContext=null;$('memory-context-content').innerHTML=`<div class="empty-small">${esc(notice.message)}</div>`;$('memory-context-page').textContent='';$('memory-context-reference').value='';}showMemoryDeletionNotice(notice);await refresh();await loadMemoryEntries();});
  });
  $('memory-reflect').addEventListener('click',()=>requestMemoryJob('reflect'));
  $('reconnect-button').addEventListener('click',refresh);
  if(!token){showAccess('请从桌面程序打开工作空间','启动 Class，程序会启动本地服务并自动打开已连接的页面。当前页面缺少本地连接凭据。');}
  else{updateControls();refresh();pollTimer=setInterval(refresh,1200);}
})();
