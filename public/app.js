'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const compactSidebar = window.matchMedia('(max-width:950px)');
  let sidebarPreference = null;
  try {
    const saved = localStorage.getItem('class-sidebar-collapsed');
    if (saved === 'true' || saved === 'false') sidebarPreference = saved === 'true';
  } catch {}
  function renderSidebar() {
    const collapsed = sidebarPreference ?? compactSidebar.matches;
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
    const button = $('sidebar-toggle'), label = collapsed ? '展开侧边栏' : '折叠侧边栏';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', label); button.title = label;
  }
  $('sidebar-toggle').addEventListener('click', () => {
    sidebarPreference = !document.documentElement.classList.contains('sidebar-collapsed');
    try { localStorage.setItem('class-sidebar-collapsed', String(sidebarPreference)); } catch {}
    renderSidebar();
  });
  compactSidebar.addEventListener('change', renderSidebar);
  document.querySelectorAll('.nav-item').forEach(button => button.title = button.getAttribute('aria-label'));
  renderSidebar();
  const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  const apiProtocols = {
    messages:{label:'Messages',suffix:'/v1/messages',hint:'Class 会追加 /v1/messages；baseurl 末尾已有 /v1 时不会重复拼接。'},
    responses:{label:'Responses',suffix:'/responses',hint:'baseurl 须以 /v1 结尾；Class 会追加 /responses。'},
    chat:{label:'Chat',suffix:'/chat/completions',hint:'baseurl 须以 /v1 结尾；Class 会追加 /chat/completions。'}
  };
  const agentProtocol = agent => Object.hasOwn(apiProtocols,agent?.protocol) ? agent.protocol : 'chat';
  const terminal = status => ['completed','failed','stopped','cancelled','interrupted'].includes(status);
  const statusNames = {idle:'等待开始',running:'讨论中',starting:'正在启动',paused:'已暂停',stopping:'正在停止',scheduled:'待执行',missed:'已错过',completed:'已完成',failed:'已失败',stopped:'已停止',cancelled:'已取消',interrupted:'已中断'};
  const roleNames = {teacher:'老师',student:'学生',principal:'校长'};
  let token = '', state = null, page = 'workspace', viewingRun = null, settingsDirty = false, settingsInitialized = false;
  let busy = false, shutdown = false, shuttingDown = false, pollTimer = null, lastConnection = true, refreshPending = false;
  let directoryPickerPending = false, directoryPickerTarget = '';
  let dataDirectoryDirty = false, dataDirectorySaving = false, stateEpoch = 0;
  let judgeBusy = false, judgeCheckController = null;
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

  function toast(message, error = false, compact = false) {
    if (error && updateRestarting()) return;
    const dialog = error && document.querySelector('dialog[open]:not(#principal-dialog)');
    if (dialog) {
      dialog.querySelector('.dialog-feedback')?.remove();
      const feedback = document.createElement('p'); feedback.className = 'dialog-feedback inline-error'; feedback.setAttribute('role','alert'); feedback.textContent = message;
      (dialog.querySelector('form') || dialog).appendChild(feedback); feedback.scrollIntoView({block:'nearest'}); return;
    }
    const item = document.createElement('div'); item.className = 'toast' + (error ? ' error' : '') + (compact ? ' compact' : '');
    item.innerHTML = icon(error ? 'close' : 'check') + '<span>' + esc(message) + '</span>';
    $('toasts').appendChild(item); while($('toasts').children.length>3)$('toasts').firstElementChild.remove(); setTimeout(() => item.remove(), error ? 9000 : 4500);
  }
  async function api(url, {method = 'GET', body, raw = false, signal, isCurrent = () => true} = {}) {
    const response = await fetch(url, {method, headers:{Authorization:'Bearer ' + token, ...(body !== undefined ? {'Content-Type':'application/json'} : {})}, ...(body !== undefined ? {body:JSON.stringify(body)} : {}), ...(signal ? {signal} : {}), cache:'no-store'});
    if (!response.ok) {
      let message; try { const result = await response.json(); message = storageDescription(result.storageError || result.storageDetails, result.error); } catch {}
      if ((response.status === 401 || response.status === 403) && !updateRestarting() && isCurrent()) showAccess('连接凭据已失效', '请重新启动 Class，从程序自动打开的页面继续。');
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
    $('connection-status').innerHTML = '<i></i>' + (updateRestarting() ? '重启中…' : shutdown ? '工作空间已关闭' : shuttingDown ? '服务正在退出' : online ? '本地服务已连接' : '连接已断开');
  }
  // Application updates run independently of classroom actions and task polling.
  let updateInfo = null, updateBusy = false, updatePollTimer = null, updateRequest = 0, updateNotice = '', previousUpdateFailureShown = false;
  const updateStates = new Set(['idle','checking','downloading','restarting','current','failed']);
  function updateRestarting() { return updateInfo?.state === 'restarting'; }
  function renderUpdateControls() {
    const version = state?.version || updateInfo?.version || '';
    $('app-version').textContent = version ? 'v' + String(version).replace(/^v/, '') : '';
    $('app-version').hidden = !version;
    const label = {checking:'检查中…',downloading:'下载中…',restarting:'重启中…'}[updateInfo?.state] || '更新';
    $('update-label').textContent = label;
    const button = $('update-button');
    button.disabled = updateBusy || !token || !lastConnection || shutdown || shuttingDown || updateInfo?.supported !== true;
    button.setAttribute('aria-busy', String(updateBusy));
    button.setAttribute('aria-label', updateBusy ? label : '检查更新');
    button.title = updateInfo?.supported === false ? '请使用 Class 桌面可执行文件更新' : updateBusy ? label : '检查更新';
  }
  function scheduleUpdatePoll() {
    if (updatePollTimer !== null || !updateBusy || updateRestarting() || shutdown || shuttingDown) return;
    updatePollTimer = setTimeout(() => { updatePollTimer = null; pollUpdate(); }, 800);
  }
  function acceptUpdate(value, notify = false) {
    if (!value || !updateStates.has(value.state)) return false;
    updateInfo = value;
    updateBusy = ['checking','downloading','restarting'].includes(value.state);
    renderUpdateControls();
    if (updateRestarting()) {
      shuttingDown = true;
      clearInterval(pollTimer); clearTimeout(updatePollTimer); updatePollTimer = null;
      closePrincipalView(); $('access-notice').hidden = true; $('reconnect-button').hidden = true;
      setConnection(true); updateControls();
    } else if (updateBusy) scheduleUpdatePoll();
    else {
      clearTimeout(updatePollTimer); updatePollTimer = null;
      if (notify && ['current','failed'].includes(value.state) && updateNotice !== value.state) {
        updateNotice = value.state;
        toast(value.state === 'current' ? '当前已是最新版' : '更新失败', value.state === 'failed', value.state === 'current');
      }
    }
    return true;
  }
  function acceptUpdateSnapshot(value) {
    // A state response started before this click must not replace a newer update.
    if (!updateBusy) {
      const previousFailure = value?.state === 'failed' && value.previousAttempt === true && !previousUpdateFailureShown;
      if (previousFailure) previousUpdateFailureShown = true;
      acceptUpdate(value, previousFailure);
    }
    else renderUpdateControls();
  }
  async function pollUpdate() {
    if (!updateBusy || updateRestarting() || shutdown || shuttingDown) return;
    const request = updateRequest, current = () => request === updateRequest && !shutdown && !shuttingDown;
    try {
      const result = await api('/api/update', { isCurrent: current });
      if (current() && !acceptUpdate(result, true)) throw Error('Invalid update response');
    } catch {
      if (current()) acceptUpdate({ ...updateInfo, state:'failed' }, true);
    }
  }
  async function requestUpdate() {
    if (updateBusy || !token || !lastConnection || shutdown || shuttingDown || updateInfo?.supported !== true) return;
    const request = ++updateRequest, current = () => request === updateRequest && !shutdown && !shuttingDown;
    updateNotice = ''; updateBusy = true; updateInfo = { ...updateInfo, state:'checking' }; renderUpdateControls();
    try {
      const result = await api('/api/update', { method:'POST', body:{}, isCurrent:current });
      if (current() && !acceptUpdate(result, true)) throw Error('Invalid update response');
    } catch {
      if (current()) acceptUpdate({ ...updateInfo, state:'failed' }, true);
    }
  }
  // End application updates.
  function navigate(next) {
    page = next; document.querySelectorAll('.page').forEach(node => node.hidden = node.id !== 'page-' + page);
    document.querySelectorAll('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.page === page));
    if (page === 'memory') refreshMemory(true);
    if (page === 'extensions') loadExtensions();
    closeConversationMenu(); if (page === 'workspace') requestAnimationFrame(resizeTaskInput);
  }
  // Classroom selection stays independent of all concurrently running tasks.
  let draftMode = false, draftTask = '', savedWorkspaceView = null, viewingLoading = false, workspaceHistoryMarkup = '';
  let draftTaskMode = 'auto';
  const emptyTaskSpec = () => ({ enabled:false, name:'', goal:'', scheduled:false, at:'' });
  let draftTaskSpec = emptyTaskSpec(), scheduledEditing = null;
  const taskTimeZone = 'Asia/Shanghai';
  const pendingStops = new Set(), stopRevisions = new Map();
  const runControlKey = (id, dataDir = state?.dataDir) => JSON.stringify([dataDir,id]);
  const pendingSchedule = run => ['scheduled','missed'].includes(run?.status) || run?.scheduled === true && run.status === 'failed';
  const activeRun = run => run?.scheduled !== true && ['running','starting','paused','stopping'].includes(run?.status);
  const activeRuns = (value = state) => (Array.isArray(value?.runs) ? value.runs : value?.run ? [value.run] : []).filter(activeRun);
  const runFromState = (id, value = state) => id ? value?.runs?.find(run => run.id === id) || (value?.run?.id === id ? value.run : null) : null;
  function acceptRun(run, select = false) {
    const runs = activeRuns().filter(item => item.id !== run.id);
    if (activeRun(run)) runs.push(run);
    state = { ...state, runs, run:select || state?.run?.id === run.id ? run : state?.run, history:[run, ...(state?.history || []).filter(item => item.id !== run.id)] };
    if (select || viewingRun?.id === run.id) viewingRun = run;
  }
  function scheduleDateInput(at) {
    const date = new Date(at); if (!Number.isFinite(date.getTime())) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:taskTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part => [part.type,part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  function scheduleValue(value) {
    const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? new Date(value + ':00+08:00') : new Date(NaN);
    if (!Number.isFinite(date.getTime()) || scheduleDateInput(date) !== value || date.getTime() <= Date.now()) throw Error('请选择未来的执行日期和时间。');
    return { at:date.toISOString(), timeZone:taskTimeZone };
  }
  function describeSchedule(run) {
    if (!run?.schedule?.at) return '';
    try { return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:taskTimeZone}).format(new Date(run.schedule.at)); } catch { return run.schedule.at; }
  }
  function renderTaskSpec() {
    const editable = draftMode, enabled = editable && draftTaskSpec.enabled;
    $('task-options').hidden = !editable;
    $('task-kind').checked = enabled; $('task-schedule').checked = enabled && draftTaskSpec.scheduled;
    $('task-spec-fields').hidden = !enabled; $('task-schedule-fields').hidden = !enabled || !draftTaskSpec.scheduled;
    $('task-name').value = draftTaskSpec.name; $('task-description').value = draftTask; $('task-goal').value = draftTaskSpec.goal; $('task-schedule-at').value = draftTaskSpec.at;
    $('task-name').required = enabled; $('task-description').required = enabled; $('task-goal').required = enabled; $('task-schedule-at').required = enabled && draftTaskSpec.scheduled;
    $('task-input').hidden = enabled; $('task-input').required = !enabled;
    $('task-input-label').textContent = '你希望解决什么问题？';
    if (editable) $('task-input').placeholder = '输入任务，让老师和学生一起讨论…';
    const selected = selectedRun(), pending = pendingSchedule(selected);
    $('scheduled-task-panel').hidden = !pending;
    $('scheduled-task-name').textContent = selected?.taskSpec?.name || '定时任务';
    $('scheduled-task-time').textContent = describeSchedule(selected);
    $('scheduled-task-note').textContent = selected?.status === 'missed' ? '已错过执行时间，请修改时间或选择立即启动。' : selected?.status === 'failed' ? '启动失败，可修改任务后重试、立即启动或取消定时。' : '将在指定时间执行一次；可在执行前修改或取消。';
    $('task-spec-summary').hidden = !selected?.taskSpec;
    $('task-spec-name').textContent = selected?.taskSpec?.name || '';
    $('task-spec-description-field').hidden = !pending && selected?.scheduled !== true;
    $('task-spec-description').textContent = selected?.taskSpec?.description || '';
    $('task-spec-goal').textContent = selected?.taskSpec?.goal || '';
  }
  function openScheduledTask() {
    const run = selectedRun(); if (!pendingSchedule(run) || busy || shutdown || shuttingDown) return;
    scheduledEditing = { id:run.id, dataDir:state.dataDir };
    $('schedule-edit-name').value = run.taskSpec?.name || '';
    $('schedule-edit-description').value = run.taskSpec?.description || run.task || '';
    $('schedule-edit-goal').value = run.taskSpec?.goal || '';
    $('schedule-edit-mode').innerHTML = availableTaskModes().map(mode => `<option value="${esc(mode.value)}">${esc(mode.label)}</option>`).join('');
    $('schedule-edit-mode').value = taskModeValue(run.taskMode);
    $('schedule-edit-at').value = scheduleDateInput(run.schedule?.at);
    openDialog('schedule-edit-dialog');
  }
  async function saveScheduledTask() {
    const editing = scheduledEditing; if (!editing || editing.dataDir !== state?.dataDir || busy) return;
    let body; try {
      body = { taskSpec:{name:$('schedule-edit-name').value.trim(),description:$('schedule-edit-description').value.trim(),goal:$('schedule-edit-goal').value.trim()}, taskMode:taskModeValue($('schedule-edit-mode').value), schedule:scheduleValue($('schedule-edit-at').value) };
      if (Object.values(body.taskSpec).some(value => !value)) throw Error('请填写任务名称、描述和目标。');
    } catch (error) { toast(error.message,true); return; }
    const session = dialogSessions.get($('schedule-edit-dialog'));
    await action(async () => {
      const result = await api('/api/runs/'+encodeURIComponent(editing.id),{method:'PATCH',body});
      if (state?.dataDir !== editing.dataDir) return;
      if (result.run?.id !== editing.id) throw Error('服务未确认定时任务已更新，请刷新后检查。');
      stateEpoch++; acceptRun(result.run); render(); closeSavedDialog('schedule-edit-dialog',session); toast('定时任务已更新。');
    });
  }
  async function controlRun(operation, id = selectedRun()?.id) {
    if (operation === 'stop') return stopRun(id);
    const run = conversationRecord(id);
    if (!run || pendingStops.has(runControlKey(id)) || run.status === 'stopping' || busy || shutdown || shuttingDown || !lastConnection || !token || dataDirectorySaving || state?.relocating) return;
    if (['start','cancel'].includes(operation) ? !pendingSchedule(run) : operation === 'pause' ? run.status !== 'running' : operation === 'resume' ? run.status !== 'paused' && run.recoverable !== true : operation === 'stop' ? !activeRun(run) || run.status === 'stopping' : true) return;
    const dataDir = state.dataDir, key = runControlKey(id), stopRevision = stopRevisions.get(key);
    await action(async () => {
      const result = await api('/api/runs/'+encodeURIComponent(id)+'/'+operation,{method:'POST',body:{}});
      if (state?.dataDir !== dataDir || stopRevisions.get(key) !== stopRevision) return;
      stateEpoch++;
      if (result.run?.id === id) acceptRun(result.run);
      render(); toast({start:'已请求立即启动。',cancel:'定时任务已取消。',pause:'已请求暂停此任务。',resume:'已请求继续此任务。',stop:'已请求停止此任务。'}[operation]);
    });
  }
  async function stopRun(id = selectedRun()?.id) {
    const run = conversationRecord(id), dataDir = state?.dataDir, key = runControlKey(id);
    const current = () => state?.dataDir === dataDir && clearingRunId !== id && Boolean(conversationRecord(id));
    if (!activeRun(run) || run.status === 'stopping' || pendingStops.has(key) || clearingRunId === id || viewingLoading || shutdown || shuttingDown || !lastConnection || !token || dataDirectorySaving || state?.relocating) return;
    pendingStops.add(key); stopRevisions.set(key,(stopRevisions.get(key) || 0)+1); updateControls();
    try {
      const result = await api('/api/runs/'+encodeURIComponent(id)+'/stop',{method:'POST',body:{},isCurrent:current});
      if (!current()) return;
      if (result.run?.id !== id) throw Error('服务未确认此任务已停止，请重试。');
      stateEpoch++; acceptRun(result.run); render(); toast('已请求停止此任务。');
    } catch (error) { if (current()) toast(error.message,true); }
    finally { pendingStops.delete(key); if (state?.dataDir === dataDir) updateControls(); }
  }
  const historyModes = [{ value:'auto', label:'自动', icon:'sparkles' }, { value:'web_pentest', label:'Web漏洞挖掘', icon:'shield' }, { value:'ctf_solve', label:'CTF题目求解', icon:'answer' }, { value:'binary_audit', label:'二进制漏洞挖掘', icon:'gdb' }, { value:'pentest', label:'渗透测试', icon:'tscan' }];
  const taskModeValue = value => historyModes.some(mode => mode.value === value) || /^custom-[a-zA-Z0-9-]+$/.test(value) ? value : 'auto';
  const taskModeIcon = value => historyModes.find(mode => mode.value === value)?.icon || 'sparkles';
  function availableTaskModes() {
    const items = new Map(historyModes.map(mode => [mode.value, mode]));
    for (const mode of state?.modes?.items || []) if (taskModeValue(mode.id) === mode.id) items.set(mode.id, { value:mode.id, label:mode.name, icon:taskModeIcon(mode.id) });
    return [...items.values()];
  }
  function historyTaskModes(records = []) {
    const items = new Map(availableTaskModes().map(mode => [mode.value, mode]));
    for (const run of records) { const id = taskModeValue(run.taskMode); if (!items.has(id)) items.set(id, { value:id, label:run.taskModeName || run.taskModeDefinition?.name || '历史模式', icon:'sparkles' }); }
    return [...items.values()];
  }
  function renderTaskModeOptions() {
    const modes = availableTaskModes(), run = selectedRun(), selected = draftMode ? draftTaskMode : taskModeValue(run?.taskMode);
    if (draftMode && !modes.some(mode => mode.value === selected)) draftTaskMode = 'auto';
    if (!draftMode && !modes.some(mode => mode.value === selected)) modes.push({ value:selected, label:run?.taskModeName || run?.taskModeDefinition?.name || '历史模式' });
    const markup = modes.map(mode => `<option value="${esc(mode.value)}">${esc(mode.label)}</option>`).join('');
    if ($('task-mode').innerHTML !== markup) $('task-mode').innerHTML = markup;
    $('task-mode').value = draftMode ? draftTaskMode : selected;
    const current = modes.find(mode => mode.value === $('task-mode').value);
    $('task-mode').title = $('task-mode').value === 'auto' ? '自动：沿用已启用并授权的MCP和Skill，按需加载。' : `${current?.label || '模式'}：合并关联MCP和Skills，按需加载；保留已有成员授权。`;
  }
  const collapsedHistoryModes = new Set();
  let taskResizeFrame = 0, taskResizeWidth = -1;
  let draftAttachments = [], attachmentSequence = 0, attachmentGeneration = 0, checkingAttachments = false, conversationMenuId = '';
  const sideDrafts = new Map();
  const btwQuestion = value => /^\/btw(?:\s|$)/i.test(value.trim()) ? value.trim().replace(/^\/btw\s*/i,'') : null;
  try {
    const saved = JSON.parse(sessionStorage.getItem('class-workspace-view') || 'null');
    if (saved && typeof saved.dataDir === 'string' && typeof saved.draftTask === 'string') savedWorkspaceView = saved;
  } catch {}
  const live = () => activeRuns()[0];
  const selectedRun = () => draftMode ? null : runFromState(viewingRun?.id || savedViewingRunId || state?.run?.id) || viewingRun || state?.run;
  function persistWorkspaceView() {
    if (!state?.dataDir) return;
    try { sessionStorage.setItem('class-workspace-view',JSON.stringify({dataDir:state.dataDir,draftMode,draftTask,draftTaskSpec,draftAttachments,sideDrafts:[...sideDrafts].slice(-30),runId:draftMode ? '' : selectedRun()?.id || ''})); } catch {}
  }
  function rememberViewingRun(id = '') {
    viewingRequest++;
    viewingLoading = false;
    savedViewingRunId = id;
    try { if(id)sessionStorage.setItem('class-viewing-run',id);else sessionStorage.removeItem('class-viewing-run'); } catch {}
    persistWorkspaceView();
  }
  function fillTaskInput(force = false) {
    const run = selectedRun(), id = run?.id || '';
    // Polling and historical reads must leave the separate new-task draft intact.
    if (!force && taskInputRunId === id) { resizeTaskInput(); return; }
    if (force || taskInputRunId !== null || !taskInputDirty) $('task-input').value = draftMode ? draftTask : sideDrafts.get(id) || '';
    $('task-input').placeholder = draftMode ? '输入任务，让老师和学生一起讨论…' : '输入 /btw 向校长提问';
    taskInputRunId = id; taskInputDirty = false; resizeTaskInput();
  }
  function resizeTaskInput() {
    const input = $('task-input');
    if (!input.getClientRects().length) return;
    const style = getComputedStyle(input), line = parseFloat(style.lineHeight) || 21;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const minimum = line + padding + borders, maximum = line * 3 + padding + borders, scrollTop = input.scrollTop;
    input.style.height = minimum + 'px'; input.style.overflowY = 'hidden';
    const needed = input.scrollHeight + borders;
    input.style.height = Math.min(maximum, Math.max(minimum, needed)) + 'px';
    input.style.overflowY = needed > maximum + 1 ? 'auto' : 'hidden';
    input.scrollTop = scrollTop;
  }
  function scheduleTaskInputResize() {
    if (taskResizeFrame) return;
    taskResizeFrame = requestAnimationFrame(()=>{taskResizeFrame=0;resizeTaskInput();});
  }
  const attachmentsBusy = () => checkingAttachments || draftAttachments.some(item => item.status === 'uploading' || item.status === 'removing');
  const attachmentSize = size => size < 1024 ? size + ' B' : size < 1024 * 1024 ? (size / 1024).toFixed(1) + ' KB' : (size / (1024 * 1024)).toFixed(1) + ' MB';
  function renderTaskAttachments() {
    const files = draftMode ? draftAttachments : selectedRun()?.attachments || [];
    $('task-attachments').hidden = files.length === 0;
    $('task-attachments').innerHTML = files.map(item => `<span class="task-attachment${item.status === 'error' ? ' is-error' : ''}" title="${esc(item.error || item.name)}">${icon('paperclip')}<span class="task-attachment-name">${esc(item.name)}</span><span class="task-attachment-status">${esc(item.status === 'uploading' ? '上传中' : item.status === 'removing' ? '移除中' : item.status === 'error' ? item.error || '上传失败' : attachmentSize(item.size || 0))}</span>${draftMode ? `<button type="button" class="icon-button" data-attachment-remove="${esc(item.key)}" aria-label="移除附件 ${esc(item.name)}"${item.status === 'uploading' || item.status === 'removing' || busy || checkingAttachments ? ' disabled' : ''}>${icon('close')}</button>` : ''}</span>`).join('');
  }
  function restoreDraftAttachments(saved) {
    draftAttachments = (Array.isArray(saved) ? saved : []).slice(0, 8).filter(item => item && typeof item.name === 'string').map(item => ({
      key: 'attachment-' + (++attachmentSequence), name: item.name, size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0,
      ...(typeof item.id === 'string' ? {id:item.id,status:'ready'} : {status:'error',error:'上传未完成，请移除后重新选择。'})
    }));
  }
  async function validateDraftAttachments() {
    const generation = attachmentGeneration, dataDir = state.dataDir;
    const current = () => generation === attachmentGeneration && dataDir === state?.dataDir;
    checkingAttachments = true; updateControls();
    try {
      const result = await api('/api/attachments',{isCurrent:current});
      if (!current()) return;
      const available = new Map((result.attachments || []).filter(item => typeof item?.id === 'string').map(item => [item.id,item]));
      draftAttachments = draftAttachments.map(item => {
        if (!item.id) return item;
        const file = available.get(item.id); available.delete(item.id);
        return file ? {...item,...file,status:'ready',error:undefined} : {...item,id:undefined,status:'error',error:'附件已不可用，请移除后重新选择。'};
      });
      // Pending files belong to the current profile's single draft. Recover files
      // whose successful response or browser session was lost, so they remain manageable.
      for (const file of available.values()) {
        const incomplete = draftAttachments.find(item => !item.id && item.status === 'error' && item.name === file.name && item.size === file.size);
        if (incomplete) Object.assign(incomplete,file,{status:'ready',error:undefined});
        else draftAttachments.push({...file,key:'attachment-'+(++attachmentSequence),status:'ready'});
      }
    } catch (error) {
      if (current()) draftAttachments = draftAttachments.map(item => item.id ? {...item,status:'error',error:'附件检查失败，请移除后重新选择。'} : item);
    } finally {
      if (current()) { checkingAttachments = false; persistWorkspaceView(); renderTaskAttachments(); updateControls(); }
    }
  }
  function fileBase64(file) {
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('无法读取所选文件。'));
      reader.onabort = () => reject(new Error('文件读取已取消。'));
      reader.readAsDataURL(file);
    });
  }
  async function uploadTaskFiles(files) {
    if (!draftMode || busy || !state || dataDirectorySaving || state.relocating || shutdown || shuttingDown || !lastConnection || !token || checkingAttachments) return;
    const selected = [...files];
    if (!selected.length) return;
    if (draftAttachments.length + selected.length > 8) { toast('每次任务最多上传 8 个文件。',true); return; }
    if (selected.some(file => file.size > 20 * 1024 * 1024)) { toast('单个文件不能超过 20 MB。',true); return; }
    const generation = attachmentGeneration, dataDir = state.dataDir;
    const current = () => generation === attachmentGeneration && dataDir === state?.dataDir && !shutdown && !shuttingDown;
    const queued = selected.map(file => ({file,item:{key:'attachment-' + (++attachmentSequence),name:file.name,size:file.size,status:'uploading'}}));
    draftAttachments.push(...queued.map(entry => entry.item)); persistWorkspaceView(); renderTaskAttachments(); updateControls();
    for (const {file,item} of queued) {
      if (!current()) break;
      try {
        const contentBase64 = await fileBase64(file);
        if (!current()) break;
        const result = await api('/api/attachments',{method:'POST',body:{name:file.name,contentBase64},isCurrent:current});
        if (!current()) break;
        if (!result.attachment?.id) throw new Error('服务未确认文件已上传。');
        Object.assign(item,result.attachment,{status:'ready'});
      } catch (error) { if (current()) Object.assign(item,{status:'error',error:error.message || '上传失败，请移除后重试。'}); }
      if (current()) { persistWorkspaceView(); renderTaskAttachments(); updateControls(); }
    }
  }
  async function removeDraftAttachment(key) {
    const item = draftAttachments.find(entry => entry.key === key);
    if (!draftMode || !item || busy || checkingAttachments || ['uploading','removing'].includes(item.status) || dataDirectorySaving || state?.relocating || shutdown || shuttingDown) return;
    const generation = attachmentGeneration, dataDir = state.dataDir, previous = item.status;
    const current = () => generation === attachmentGeneration && dataDir === state?.dataDir;
    item.status = 'removing'; renderTaskAttachments(); updateControls();
    try {
      if (item.id) await api('/api/attachments/'+encodeURIComponent(item.id),{method:'DELETE',isCurrent:current});
      if (current()) draftAttachments = draftAttachments.filter(entry => entry !== item);
    } catch (error) { if (current()) { item.status = previous; toast(error.message,true); } }
    finally { if (current()) { persistWorkspaceView(); renderTaskAttachments(); updateControls(); } }
  }
  function rememberDraft() {
    if (draftMode) draftTask = $('task-input').value;
    else if (selectedRun()?.id) sideDrafts.set(selectedRun().id,$('task-input').value);
    persistWorkspaceView();
  }
  function newConversation() {
    if (!state || busy || clearingRunId || dataDirectorySaving || state.relocating || shutdown || shuttingDown) return;
    closePrincipalView(); closeConversationMenu(); rememberDraft(); rememberBoard();
    draftMode = true; viewingRun = null; rememberViewingRun();
    fillTaskInput(true); navigate('workspace'); render(); $(draftTaskSpec.enabled ? 'task-name' : 'task-input').focus();
  }
  async function viewConversation(id) {
    if (!id || !state || busy || clearingRunId || dataDirectorySaving || state.relocating || shutdown || shuttingDown || !lastConnection || !token) return;
    closePrincipalView(); closeConversationMenu(); rememberDraft();
    const request = ++viewingRequest, dataDir = state.dataDir;
    const current = () => request === viewingRequest && state?.dataDir === dataDir && !clearingRunId && !shutdown && !shuttingDown;
    viewingLoading = true; updateControls();
    try {
      const cached = runFromState(id);
      const record = cached ? {run:cached} : await api('/api/runs/'+encodeURIComponent(id),{isCurrent:current});
      if (!current()) return;
      const run = record.run || record;
      if (run?.id !== id) throw new Error('服务未返回所选对话，请重新选择。');
      rememberDraft(); rememberBoard(); draftMode = false; viewingRun = run;
      rememberViewingRun(id); fillTaskInput(true); navigate('workspace'); render();
    } catch (error) { if (current()) toast(error.message,true); }
    finally { if (request === viewingRequest) { viewingLoading = false; updateControls(); } }
  }
  function renderWorkspaceHistory() {
    const records = new Map((state?.history || []).map(run=>[run.id,run]));
    if (state?.run?.id) records.set(state.run.id,state.run);
    for (const run of activeRuns()) records.set(run.id,run);
    const sorted = [...records.values()].sort((a,b)=>Number(b.pinned === true)-Number(a.pinned === true) || String(b.startedAt || b.createdAt || b.schedule?.at || '').localeCompare(String(a.startedAt || a.createdAt || a.schedule?.at || '')));
    const selected = selectedRun(), selectedId = selected?.id || '';
    const historyDate = run => (run.scheduled === true || pendingSchedule(run)) && run.schedule?.at ? scheduleDateInput(run.schedule.at).slice(5).replace('-', '/').replace('T', ' ') || '—' : formatDate(run.startedAt || run.createdAt);
    const historyRow = run=>`<div class="workspace-history-row${run.id===selectedId ? ' is-selected' : ''}${run.pinned ? ' is-pinned' : ''}"><button type="button" class="workspace-history-item${run.id===selectedId ? ' is-selected' : ''}" data-run-view="${esc(run.id)}"${run.id===selectedId ? ' aria-current="true"' : ''} title="${esc(run.title || run.taskSpec?.name || run.task || '未命名任务')}"><span class="workspace-history-title">${esc(run.title || run.taskSpec?.name || run.task || '未命名任务')}</span><span class="workspace-history-meta">${run.pinned ? '<span class="workspace-history-pinned" aria-label="已置顶">'+icon('pin')+'</span>' : ''}<span class="workspace-history-status ${Object.hasOwn(statusNames,run.status) ? run.status : 'idle'}">${esc(statusNames[run.status] || run.status)}</span><time title="${esc(describeSchedule(run))}">${esc(historyDate(run))}</time></span></button><button type="button" class="icon-button workspace-history-menu-button" data-run-menu="${esc(run.id)}" aria-label="对话菜单：${esc(run.title || run.taskSpec?.name || run.task || '未命名任务')}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button></div>`;
    const markup = sorted.length ? historyTaskModes(sorted).map(mode=>{
      const runs = sorted.filter(run=>taskModeValue(run.taskMode)===mode.value);
      if (!runs.length) return '';
      const expanded = !collapsedHistoryModes.has(mode.value), listId = 'workspace-history-'+mode.value;
      return `<section class="workspace-history-group"><button type="button" class="workspace-history-group-toggle" data-history-mode="${esc(mode.value)}" aria-expanded="${expanded}" aria-controls="${esc(listId)}" title="${expanded ? '收起' : '展开'}${esc(mode.label)}模式的历史对话"><span class="workspace-history-chevron">${icon('chevron-right')}</span><span class="workspace-history-mode-icon">${icon(mode.icon)}</span><span class="workspace-history-mode-name">${esc(mode.label)}</span><span class="workspace-history-count" aria-label="${runs.length}条对话">${runs.length}</span></button><div id="${esc(listId)}" class="workspace-history-group-items"${expanded ? '' : ' hidden'}>${runs.map(historyRow).join('')}</div></section>`;
    }).join('') : '<p class="workspace-history-empty">暂无对话</p>';
    if (workspaceHistoryMarkup !== markup) {
      const content = $('workspace-history-content');
      const scrollPositions = new Map([...content.querySelectorAll('.workspace-history-group-items')].map(node=>[node.id,node.scrollLeft]));
      closeConversationMenu(); content.innerHTML = markup; workspaceHistoryMarkup = markup;
      content.querySelectorAll('.workspace-history-group-items').forEach(node=>{node.scrollLeft=scrollPositions.get(node.id)||0;});
    }
    $('workspace-conversation-title').hidden = true;
    $('workspace-task-details').hidden = !selected;
    $('workspace-task-original').textContent = selected?.task || '';
    $('workspace-new-conversation').setAttribute('aria-pressed',String(draftMode));
    const others = activeRuns().filter(run => run.id !== selectedId), otherActive = others.length > 0;
    $('workspace-active-notice').hidden = !otherActive;
    $('workspace-active-message').textContent = otherActive ? `另有 ${others.length} 个任务进行中，可继续新建会话或切换查看。` : '';
    renderTaskAttachments();
  }
  const conversationRecord = id => runFromState(id) || (id === viewingRun?.id ? viewingRun : state?.history?.find(run => run.id === id));
  function closeConversationMenu(restoreFocus = false) {
    const trigger = [...document.querySelectorAll('[data-run-menu]')].find(button => button.dataset.runMenu === conversationMenuId);
    if (trigger) { trigger.setAttribute('aria-expanded','false'); if (restoreFocus) trigger.focus(); }
    conversationMenuId = ''; $('conversation-menu').hidden = true;
  }
  function openConversationMenu(id, trigger) {
    if (busy || clearingRunId || dataDirectorySaving || state?.relocating || shutdown || shuttingDown || !lastConnection || !token) return;
    const wasOpen = conversationMenuId === id; closeConversationMenu();
    const run = conversationRecord(id); if (wasOpen || !run) return;
    conversationMenuId = id;
    const menu = $('conversation-menu'); menu.querySelector('[data-conversation-action="pin"]').textContent = run.pinned ? '取消置顶' : '置顶';
    for (const action of ['pin','rename']) menu.querySelector(`[data-conversation-action="${action}"]`).hidden = run.scheduled === true || pendingSchedule(run);
    menu.hidden = false; trigger.setAttribute('aria-expanded','true');
    const box = trigger.getBoundingClientRect(), menuBox = menu.getBoundingClientRect();
    menu.style.left = Math.max(8,Math.min(box.right-menuBox.width,window.innerWidth-menuBox.width-8))+'px';
    menu.style.top = (box.bottom+menuBox.height+8 > window.innerHeight ? Math.max(8,box.top-menuBox.height-4) : box.bottom+4)+'px';
    menu.querySelector('button:not([hidden])')?.focus();
  }
  async function updateConversation(id, changes) {
    if (!conversationRecord(id) || busy || clearingRunId || dataDirectorySaving || state?.relocating || shutdown || shuttingDown || !lastConnection || !token) return;
    closeConversationMenu();
    await action(async () => {
      const dataDir = state.dataDir; stateEpoch++;
      const result = await api('/api/runs/'+encodeURIComponent(id),{method:'PUT',body:changes});
      if (state?.dataDir !== dataDir) return;
      if (result.run?.id !== id || !Array.isArray(result.history)) throw new Error('服务未确认对话已更新，请刷新后检查。');
      stateEpoch++; state = {...state,history:result.history};
      const metadata = {title:result.run.title,pinned:result.run.pinned};
      if (state.run?.id === id) state.run = {...state.run,...metadata};
      if (Array.isArray(state.runs)) state.runs = state.runs.map(run => run.id === id ? {...run,...metadata} : run);
      if (viewingRun?.id === id) viewingRun = {...viewingRun,...metadata};
      render();
    });
  }
  function conversationMenuAction(actionName) {
    const id = conversationMenuId, run = conversationRecord(id); closeConversationMenu(true);
    if (!run) return;
    if (actionName === 'delete') { deleteConversation(id); return; }
    if (run.scheduled === true || pendingSchedule(run)) return;
    if (actionName === 'pin') { updateConversation(id,{pinned:!run.pinned}); return; }
    if (actionName === 'rename') {
      const title = prompt('重命名对话',run.title || run.taskSpec?.name || run.task || '');
      if (title === null) return;
      if (!title.trim() || title.trim().length > 200) { toast('对话名称须为 1 至 200 个字符。',true); return; }
      updateConversation(id,{title:title.trim()});
    }
  }
  // End classroom selection.
  // Principal reports are an independent side conversation; they never lock the classroom.
  let principalView = null;
  const principalAgent = () => state?.agents?.find(agent => agent.role === 'principal');
  const principalTargetRun = () => { const run = selectedRun() || live() || state?.run; return pendingSchedule(run) || run?.scheduled === true ? null : run; };
  const principalPending = report => ['pending','running'].includes(report?.status);
  const principalConfigurationMessage = () => principalAgent()?.hasKey ? '' : '尚未配置校长，请到教室管理添加校长并配置密钥。';
  const principalCurrent = view => principalView === view && $('principal-dialog').open && state?.dataDir === view.dataDir && principalTargetRun()?.id === view.runId && !shutdown && !shuttingDown;
  function principalError(message = '') { $('principal-error').textContent = message; $('principal-error').hidden = !message; }
  function principalControls() {
    const unavailable = shutdown || shuttingDown || !state || !token || !lastConnection || dataDirectorySaving || state?.relocating === true || Boolean(clearingRunId);
    $('principal-button').disabled = unavailable || !principalTargetRun()?.id;
    const view = principalView, pending = view?.reports.find(principalPending), waiting = view?.loading || view?.posting || view?.cancelling;
    $('principal-send').disabled = unavailable || !view || waiting || Boolean(pending) || !principalAgent()?.hasKey;
    $('principal-question').disabled = unavailable || !view;
    $('principal-cancel').hidden = !pending;
    $('principal-cancel').disabled = unavailable || !pending || view?.cancelling === true;
    $('principal-form').setAttribute('aria-busy',String(Boolean(waiting || pending)));
  }
  function closePrincipalView() {
    const view = principalView; principalView = null;
    if (view) { clearTimeout(view.timer); view.controller?.abort(); view.pollController?.abort(); }
    if ($('principal-dialog').open) $('principal-dialog').close();
  }
  function renderPrincipal() {
    const view = principalView; if (!view || !principalCurrent(view)) return;
    $('principal-run-title').textContent = '当前任务：'+(conversationRecord(view.runId)?.title || view.task || view.runId);
    $('principal-agent-name').textContent = principalAgent()?.name || '尚未配置校长';
    const markup = view.reports.length ? view.reports.map(report => {
      const status = report.status === 'completed' ? '' : principalPending(report) ? '校长正在观察课堂…' : report.status === 'cancelled' ? '回答已停止。' : report.error || '汇报失败，请重试。';
      return `<article class="principal-message principal-user"><strong>你</strong><div class="principal-message-content">${esc(report.question)}</div></article><article class="principal-message principal-assistant${principalPending(report) ? ' principal-pending' : ''}"><strong>${esc(report.principal?.name || '校长')}</strong><div class="principal-message-content">${esc(report.status === 'completed' ? report.answer : status)}</div></article>`;
    }).join('') : '<p class="empty-small">可向校长询问当前课堂的进展与情况。</p>';
    const panel = $('principal-messages'), nearBottom = panel.scrollHeight-panel.scrollTop-panel.clientHeight < 60;
    if (view.markup !== markup) { panel.innerHTML = markup; view.markup = markup; if (nearBottom || view.scrollToEnd) panel.scrollTop = panel.scrollHeight; view.scrollToEnd = false; }
    principalControls();
  }
  function schedulePrincipalPoll(view, delay = 900) {
    clearTimeout(view.timer);
    if (principalCurrent(view) && view.reports.some(principalPending)) view.timer = setTimeout(()=>pollPrincipalReport(view),delay);
  }
  async function pollPrincipalReport(view) {
    if (!principalCurrent(view)) return;
    const report = view.reports.find(principalPending); if (!report || view.posting || view.cancelling) return;
    const revision = view.revision, controller = new AbortController(); view.pollController?.abort(); view.pollController = controller;
    const current = () => principalCurrent(view) && revision === view.revision;
    try {
      const result = await api(`/api/runs/${encodeURIComponent(view.runId)}/principal/${encodeURIComponent(report.id)}`,{signal:controller.signal,isCurrent:current});
      if (!current()) return;
      if (result.report?.id !== report.id || result.report.runId !== view.runId) throw new Error('服务未返回当前任务的校长汇报。');
      view.reports = view.reports.map(item=>item.id === report.id ? result.report : item); view.pollFailures = 0; principalError(principalConfigurationMessage()); renderPrincipal(); schedulePrincipalPoll(view);
    } catch (error) {
      if (current() && error.name !== 'AbortError') {
        view.pollFailures = (view.pollFailures || 0) + 1;
        principalError('汇报状态暂时无法更新，正在重试：'+error.message);
        schedulePrincipalPoll(view,Math.min(10000,900 * 2 ** Math.min(view.pollFailures,4)));
      }
    }
  }
  async function loadPrincipalReports(view) {
    const revision = ++view.revision, controller = new AbortController(); view.controller?.abort(); view.pollController?.abort(); clearTimeout(view.timer); view.controller = controller;
    const current = () => principalCurrent(view) && revision === view.revision;
    view.loading = true; principalControls();
    try {
      const result = await api(`/api/runs/${encodeURIComponent(view.runId)}/principal`,{signal:controller.signal,isCurrent:current});
      if (!current()) return false;
      if (!Array.isArray(result.reports)) throw new Error('服务未返回校长汇报记录。');
      view.reports = result.reports.filter(report=>report.runId === view.runId); view.loaded = true; view.pollFailures = 0; principalError(principalConfigurationMessage()); renderPrincipal(); schedulePrincipalPoll(view); return true;
    } catch (error) { if (current() && error.name !== 'AbortError') principalError(error.message); return false; }
    finally { if (current()) { view.loading = false; principalControls(); } }
  }
  async function openPrincipalReport(question) {
    if (shutdown || shuttingDown || !state || !token || !lastConnection || dataDirectorySaving || state.relocating || clearingRunId) return false;
    const run = principalTargetRun(); if (!run?.id) { toast('请先选择一个课堂任务，再向校长提问。',true); return false; }
    let view = principalView;
    if (!view || !$('principal-dialog').open || view.runId !== run.id || view.dataDir !== state.dataDir) {
      closePrincipalView(); view = principalView = {runId:run.id,dataDir:state.dataDir,task:run.task,reports:[],revision:0,loaded:false,scrollToEnd:true};
      dialogReturnFocus.set($('principal-dialog'),$('principal-button')); $('principal-dialog').show(); $('principal-question').value = '';
    }
    if (typeof question === 'string') $('principal-question').value = question;
    principalError(); renderPrincipal(); $('principal-question').focus();
    if (view.posting || view.cancelling) return false;
    if (!await loadPrincipalReports(view) || !principalCurrent(view)) return false;
    if (!principalAgent()?.hasKey) return false;
    if (typeof question === 'string' && question.trim()) return sendPrincipalQuestion(question);
    return false;
  }
  async function sendPrincipalQuestion(question = $('principal-question').value) {
    const view = principalView;
    if (!view || !principalCurrent(view) || !view.loaded || view.loading || view.posting || view.cancelling || !principalAgent()?.hasKey) return false;
    if (view.reports.some(principalPending)) { principalError('校长正在回答上一个问题，请等待完成或停止回答。'); return false; }
    question = question.trim(); if (!question || question.length > 8000) { principalError('请输入 1 至 8000 个字符的问题。'); return false; }
    const revision = ++view.revision, controller = new AbortController(); view.controller?.abort(); view.controller = controller;
    const current = () => principalCurrent(view) && revision === view.revision;
    view.posting = true; principalError(); principalControls();
    try {
      const result = await api(`/api/runs/${encodeURIComponent(view.runId)}/principal`,{method:'POST',body:{question},signal:controller.signal,isCurrent:current});
      if (!current()) return false;
      if (!result.report?.id || result.report.runId !== view.runId) throw new Error('服务未确认校长已接收问题。');
      view.reports.push(result.report); view.scrollToEnd = true;
      if ($('principal-question').value.trim() === question) $('principal-question').value = '';
      renderPrincipal(); schedulePrincipalPoll(view); return true;
    } catch (error) { if (current() && error.name !== 'AbortError') principalError(error.message); return false; }
    finally { if (current()) { view.posting = false; principalControls(); } }
  }
  async function cancelPrincipalReport() {
    const view = principalView, report = view?.reports.find(principalPending);
    if (!view || !report || !principalCurrent(view) || view.cancelling) return;
    const revision = ++view.revision, controller = new AbortController(); view.controller?.abort(); view.pollController?.abort(); clearTimeout(view.timer); view.controller = controller;
    const current = () => principalCurrent(view) && revision === view.revision;
    view.cancelling = true; principalError(); principalControls();
    try {
      const result = await api(`/api/runs/${encodeURIComponent(view.runId)}/principal/${encodeURIComponent(report.id)}/cancel`,{method:'POST',body:{},signal:controller.signal,isCurrent:current});
      if (!current()) return;
      if (result.report?.id !== report.id || result.report.runId !== view.runId) throw new Error('服务未确认校长已停止回答。');
      view.reports = view.reports.map(item=>item.id === report.id ? result.report : item); renderPrincipal();
    } catch (error) { if (current() && error.name !== 'AbortError') principalError(error.message); }
    finally { if (current()) { view.cancelling = false; principalControls(); schedulePrincipalPoll(view); } }
  }
  async function submitBtw(question) {
    const dataDir = state?.dataDir, wasDraft = draftMode, runId = selectedRun()?.id || '', value = $('task-input').value;
    if (!await openPrincipalReport(question)) return;
    if (state?.dataDir === dataDir && draftMode === wasDraft && (selectedRun()?.id || '') === runId && $('task-input').value === value) {
      $('task-input').value = ''; rememberDraft(); resizeTaskInput(); updateControls();
    }
  }
  // End independent principal reports.
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
    return activeRuns().some(item => item.id === run?.id && item.status === 'running') && failure?.canRetry === true && failure.status !== 'retrying';
  }
  function updateControls() {
    const locked = busy || judgeBusy || dataDirectorySaving || directoryPickerPending || attachmentsBusy() || state?.relocating === true || !lastConnection || !token || shutdown || shuttingDown;
    const selectedTask = selectedRun(), canStop = activeRun(selectedTask), stopping = canStop && (selectedTask.status === 'stopping' || pendingStops.has(runControlKey(selectedTask.id)));
    const sideInput = !draftMode || !draftTaskSpec.enabled && btwQuestion($('task-input').value) !== null;
    const submitLocked = viewingLoading || dataDirectorySaving || state?.relocating === true || shutdown || shuttingDown || !state || !lastConnection || !token;
    $('start-button').disabled = canStop ? stopping || submitLocked : sideInput ? submitLocked : locked || draftAttachments.some(item => item.status !== 'ready') || viewingLoading || !teamReady();
    const submitLabel = canStop ? stopping ? '正在停止…' : '停止任务' : sideInput ? '向校长提问' : draftTaskSpec.enabled && draftTaskSpec.scheduled ? '保存定时任务' : draftTaskSpec.enabled ? '开始任务' : '开始讨论';
    $('start-button').type = canStop ? 'button' : 'submit'; $('start-button').dataset.action = canStop ? 'stop' : 'submit';
    $('start-button').classList.toggle('danger',canStop); $('start-button').classList.toggle('primary',!canStop);
    $('start-button').innerHTML = icon(canStop ? 'stop' : 'arrow'); $('start-button').setAttribute('aria-busy',String(Boolean(stopping)));
    $('start-button').setAttribute('aria-label',submitLabel); $('start-button').title = submitLabel;
    ['settings-button','team-button','logs-button','answer-button'].forEach(id => $(id).disabled = Boolean(clearingRunId) || shutdown || shuttingDown || !lastConnection || !token || !state);
    $('evidence-button').disabled = Boolean(clearingRunId) || shutdown || shuttingDown || !lastConnection || !token || !selectedRun()?.id;
    $('clear-task-button').disabled = busy || viewingLoading || directoryPickerPending || state?.relocating === true || shutdown || shuttingDown || !lastConnection || !token || !selectedRun()?.id;
    $('clear-task-button').setAttribute('aria-busy',String(Boolean(clearingRunId)));
    $('clear-task-button').title = clearingRunId ? '正在清除任务…' : '清除任务';
    document.querySelectorAll('[data-run-view], [data-run-menu]').forEach(button => button.disabled = busy || Boolean(clearingRunId) || dataDirectorySaving || state?.relocating === true || shutdown || shuttingDown || !lastConnection);
    $('task-form').hidden = pendingSchedule(selectedTask);
    $('start-button').hidden = false;
    $('pause-button').hidden = selectedTask?.status !== 'running'; $('pause-button').disabled = locked || viewingLoading || stopping;
    $('resume-button').hidden = selectedTask?.status !== 'paused' && selectedTask?.recoverable !== true;
    $('resume-button').disabled = locked || viewingLoading || stopping;
    document.querySelectorAll('[data-run-resume]').forEach(button => button.disabled = locked);
    $('task-input').readOnly = false;
    $('task-input').disabled = shutdown || shuttingDown || !state;
    renderTaskModeOptions();
    renderTaskSpec();
    $('task-kind').disabled = !draftMode || locked; $('task-schedule').disabled = !draftMode || !draftTaskSpec.enabled || locked;
    for (const id of ['task-name','task-description','task-goal','task-schedule-at']) $(id).disabled = !draftMode || locked;
    for (const id of ['scheduled-edit','scheduled-start','scheduled-cancel']) $(id).disabled = locked || !pendingSchedule(selectedTask);
    $('task-mode').disabled = !draftMode || busy || dataDirectorySaving || state?.relocating === true || shutdown || shuttingDown || !state;
    $('attachment-button').hidden = !draftMode;
    $('attachment-button').disabled = busy || checkingAttachments || draftAttachments.length >= 8 || directoryPickerPending || dataDirectorySaving || state?.relocating === true || shutdown || shuttingDown || !state || !lastConnection || !token;
    $('task-files').disabled = $('attachment-button').disabled;
    $('workspace-new-conversation').disabled = busy || Boolean(clearingRunId) || dataDirectorySaving || state?.relocating === true || shutdown || shuttingDown || !state;
    $('workspace-return-active').disabled = busy || Boolean(clearingRunId) || !lastConnection || shutdown || shuttingDown;
    $('add-agent-button').disabled = locked; $('settings-save').disabled = locked;
    $('setting-directory-button').disabled = locked; $('setting-directory-button').setAttribute('aria-busy',String(directoryPickerPending && directoryPickerTarget === 'workspace'));
    $('data-directory-input').disabled = locked || Boolean(live()); $('data-directory-button').disabled = locked || Boolean(live());
    $('data-directory-button').setAttribute('aria-busy',String(directoryPickerPending && directoryPickerTarget === 'data'));
    $('data-directory-save').disabled = locked || Boolean(live()) || !dataDirectoryDirty || !$('data-directory-input').value.trim();
    $('data-directory-load').disabled = locked || Boolean(live()) || !dataDirectoryDirty || !$('data-directory-input').value.trim();
    $('data-directory-form').setAttribute('aria-busy',String(dataDirectorySaving));
    $('settings-form').querySelectorAll('input').forEach(input => input.disabled = locked);
    $('judge-settings-button').disabled = judgeBusy || busy || shutdown || shuttingDown || !lastConnection || !state?.judge;
    $('judge-settings-button').title = 'Jev设置：启用后按需辅助选择MCP和Skill；原有四项控制对应的上下文整理环节。';
    $('judge-settings-form').querySelectorAll('input,select,button').forEach(input => input.disabled = locked);
    judgeFeatureVisibility(locked);
    $('judge-settings-form').setAttribute('aria-busy',String(judgeBusy));
    $('agent-save').disabled = locked;
    document.querySelectorAll('[data-agent-edit],[data-agent-delete]').forEach(button => button.disabled = locked);
    document.querySelectorAll('[data-agent-check]').forEach(button => button.disabled = locked || pendingChecks.has(button.dataset.agentCheck));
    $('shutdown-button').disabled = busy || state?.relocating === true || shutdown || shuttingDown || !token;
    renderUpdateControls();
    extensionControls();
    principalControls();
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
  function judgeStatus(message = '', error = false) {
    $('judge-check-status').textContent=message;$('judge-check-status').hidden=!message;$('judge-check-status').classList.toggle('error',error);
  }
  function setJudgeEnabled(enabled) {
    $('judge-settings-form').dataset.enabled=String(enabled===true);
    $('judge-enable').setAttribute('aria-pressed',String(enabled===true));
    $('judge-disable').setAttribute('aria-pressed',String(enabled!==true));
    judgeStatus();judgeFeatureVisibility();
  }
  function judgeFeatureVisibility(locked = false) {
    const hasKey=$('judge-key').value.trim()||$('judge-settings-form').dataset.hasApiKey==='true';
    const visible=$('judge-settings-form').dataset.enabled==='true'&&Boolean(hasKey);
    $('judge-features').hidden=!visible;$('judge-features').disabled=locked||!visible;
  }
  function renderJudgeStats() {
    const stats=selectedRun()?.judgeStats;$('judge-run-stats').hidden=!stats;
    if(!stats)return;
    const count=value=>Number.isFinite(value)&&value>=0?Math.round(value).toLocaleString():'0';
    $('judge-run-status').textContent=!stats.enabled?'本次任务未启用 Jev':stats.mode==='shadow'?'历史任务：仅统计，未应用判断':'已启用 · 按所选环节应用';
    $('judge-run-requests').textContent=count(stats.requests);$('judge-run-timeouts').textContent=count(stats.timeouts);
    $('judge-run-fallbacks').textContent=count((Number(stats.failures)||0)+(Number(stats.unclear)||0));
    $('judge-run-saved').textContent=count(stats.savedChars);$('judge-run-latency').textContent=count(stats.totalLatencyMs)+' ms';
    $('judge-run-usage').hidden=!(stats.inputTokens||stats.outputTokens);
    $('judge-run-usage').textContent=`接口报告用量：输入 ${count(stats.inputTokens)} / 输出 ${count(stats.outputTokens)} tokens`;
  }
  function openJudgeSettings() {
    if(!state?.judge||judgeBusy||busy)return;
    if(document.querySelector('dialog[open]:not(#principal-dialog)'))return;
    const config=state.judge;$('judge-settings-form').reset();
    $('judge-url').value=config.baseUrl;$('judge-key').value='';
    $('judge-key-state').textContent=config.hasApiKey?'已保存':'';$('judge-key').placeholder='输入Jev密钥';
    for(const [feature,id] of [['taskDispatch','task-dispatch'],['toolCalls','tool-calls'],['toolResults','tool-results'],['submissionReview','submission-review']])$('judge-'+id).checked=config.features?.[feature]===true;
    $('judge-timeout').value=config.timeoutMs;$('judge-min-output').value=config.minOutputChars;
    $('judge-settings-form').dataset.maxConcurrency=String(config.maxConcurrency);
    $('judge-settings-form').dataset.hasApiKey=String(config.hasApiKey===true);
    setJudgeEnabled(config.enabled);renderJudgeStats();openDialog('judge-settings-dialog',$('judge-settings-button'));updateControls();
  }
  function judgeSettingsBody() {
    const body={enabled:$('judge-settings-form').dataset.enabled==='true',protocol:'system-one',baseUrl:$('judge-url').value.trim(),model:'jev-latest',timeoutMs:Number($('judge-timeout').value),minOutputChars:Number($('judge-min-output').value),maxConcurrency:Number($('judge-settings-form').dataset.maxConcurrency),features:{taskDispatch:$('judge-task-dispatch').checked,toolCalls:$('judge-tool-calls').checked,toolResults:$('judge-tool-results').checked,submissionReview:$('judge-submission-review').checked}};
    if($('judge-key').value.trim())body.apiKey=$('judge-key').value.trim();
    return body;
  }
  async function saveJudgeSettings() {
    if(judgeBusy||$('judge-save').disabled)return;
    if(!$('judge-key').value.trim()&&$('judge-settings-form').dataset.hasApiKey!=='true'){judgeStatus('尚未配置Jev密钥',true);return;}
    if(!$('judge-settings-form').reportValidity())return;
    const dialog=$('judge-settings-dialog'),session=dialogSessions.get(dialog),body=judgeSettingsBody();
    judgeBusy=true;judgeStatus();updateControls();
    try{
      const result=await api('/api/judge',{method:'PUT',body});
      stateEpoch++;state={...state,judge:result.judge};
      if(closeSavedDialog('judge-settings-dialog',session))$('judge-key').value='';
      toast('Jev设置已保存。');
    }catch(error){if(dialog.open&&dialogSessions.get(dialog)===session)judgeStatus(error.message,true);else toast(error.message,true);}
    finally{judgeBusy=false;updateControls();}
  }
  async function checkJudgeConnection() {
    if(judgeBusy||$('judge-check').disabled||!$('judge-settings-form').reportValidity())return;
    const dialog=$('judge-settings-dialog'),session=dialogSessions.get(dialog),controller=new AbortController();
    const current=()=>dialog.open&&dialogSessions.get(dialog)===session&&!controller.signal.aborted;
    judgeCheckController=controller;judgeBusy=true;judgeStatus('正在测试连接…');updateControls();
    try{const result=await api('/api/judge/check',{method:'POST',body:judgeSettingsBody(),signal:controller.signal,isCurrent:current});if(current())judgeStatus(result.message,result.ok!==true);}
    catch(error){if(current())judgeStatus(error.message,true);}
    finally{if(judgeCheckController===controller)judgeCheckController=null;judgeBusy=false;updateControls();}
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
    for (const principal of agents.filter(agent=>agent.role === 'principal')) if (!members.some(member=>member.id === principal.id)) members = [...members,principal];
    $('team-list').innerHTML = members.length ? members.map(agent => {
      const failure = memberFailures(run).find(item=>item.studentId===agent.id);
      let activity = '准备就绪';
      if (run && !terminal(run.status)) activity = agent.role === 'teacher' ? ({review:'审查候选答案',reviewing:'审查候选答案',judging:'验收结果',merging:'合并发现',discussing:'合并发现与投票',publishing_feedback:'发布审查反馈',resuming:'根据反馈继续求解'}[phase] || '观察讨论') : ({solving:'独立求解',merging:'暂停审视',discussing:'审视 / 投票',pausing:'等待工具暂停',voting:'审视 / 投票',review:'等待老师审查',reviewing:'等待老师审查',publishing_feedback:'等待审查反馈',resuming:'根据反馈继续求解',judging:'已停止求解'}[phase] || '准备中');
      else if (run && terminal(run.status)) activity = '';
      if (failure) activity = failure.status === 'retrying' ? '正在重试' : agent.role === 'teacher' ? '验收暂停' : '已隔离';
      else if (phase === 'waiting_recovery' && !terminal(run.status)) activity = agent.role === 'teacher' ? '等待成员恢复' : '等待恢复协调';
      else if (phase === 'preparing' && !terminal(run.status)) activity = agent.role === 'teacher' ? '整理验收条件' : '等待任务下发';
      if (agent.role === 'principal') activity = '观察并汇报课堂情况';
      return `<div class="team-person"><span class="avatar ${agent.role === 'teacher' ? 'teacher' : ''}">${esc(agent.name?.slice(0,1) || 'A')}</span><div class="person-info"><strong>${esc(agent.name)}</strong><small>${esc(roleNames[agent.role] || agent.role)}</small></div>${activity ? `<span class="person-state ${failure ? 'isolated' : run && !terminal(run.status) ? 'active' : ''}">${activity}</span>` : ''}</div>`;
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
    $('run-status').textContent = status === 'running' && !dispatchingTask ? ({preparing:'整理验收条件',pausing:'正在暂停',review:'老师审查中',reviewing:'老师审查中',publishing_feedback:'发布老师反馈',resuming:'根据反馈继续求解',waiting_recovery:'等待成员恢复'}[phase] || statusNames[status] || status) : statusNames[status] || status;
    if (clearingRunId) { $('run-status').textContent = '清除中…'; $('run-status').className = 'status-badge stopping'; }
    const order = ['assigned','solving','judging'], stage = dispatchingTask ? 'assigned' : progressStageOf(run);
    $('workflow').querySelectorAll('[data-stage]').forEach(node => {
      node.classList.toggle('active', node.dataset.stage === stage && (status === 'running' || status === 'starting'));
      node.classList.toggle('finished', Boolean(run) && (status === 'completed' || order.indexOf(node.dataset.stage) < order.indexOf(stage)));
      if(node.dataset.stage === stage)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');
    });
    const end = run?.finishedAt ? new Date(run.finishedAt).getTime() : Date.now(); const duration = run?.startedAt && !pendingSchedule(run) && run.scheduled !== true ? Math.max(0,Math.floor((end-new Date(run.startedAt).getTime())/1000)) : null;
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
      return `<div class="member-recovery-row"><div><strong>${esc(member)} · ${status}</strong><p>${esc(reason)}</p></div>${activeRun(run) && run.status === 'running' ? `<button type="button" class="button secondary" data-member-retry="${esc(failure.studentId)}" aria-label="${esc('重试成员 '+member)}" aria-busy="${retrying}">${retrying ? '重试中…' : '重试该成员'}</button>` : ''}</div>`;
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
      case 'phase.changed': return `阶段更新 · ${{preparing:'整理验收条件',solving:'并行求解',discussing:'讨论发现',pausing:'暂停工具',review:'老师审查中',reviewing:'老师审查中',publishing_feedback:'发布老师反馈',resuming:'根据反馈继续求解',waiting_recovery:'等待成员恢复',completed:'验收通过'}[event.phase] || event.phase}${event.reviewRound ? ` · 第 ${event.reviewRound} 轮审查` : ''}`;
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
    if (clearingRunId || !run?.id || document.querySelector('dialog[open]:not(#principal-dialog)')) return;
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
    $('agents-content').innerHTML = ['teacher','student','principal'].map(role => {
      const group=agents.filter(agent=>agent.role===role), label=roleNames[role];
      const empty=role==='teacher' ? '请添加一位老师。' : role==='student' ? '请添加至少两位学生。' : '可添加一位校长，观察并汇报课堂情况。';
      return `<h2 class="agent-group-title">${label} <small>${group.length} 位</small></h2><div class="agent-grid">${group.length ? group.map(agent=>`<article class="card agent-card"><div class="agent-card-head"><span class="avatar ${role==='teacher'?'teacher':''}">${esc(agent.name.slice(0,1))}</span><div><h3>${esc(agent.name)}</h3><span class="role-tag">${role.toUpperCase()} · ${label}</span></div></div><div class="agent-model-line"><div class="agent-model">${esc(agent.model)}</div><span class="protocol-badge">${apiProtocols[agentProtocol(agent)].label}</span></div><div class="agent-url">${esc(agent.baseUrl)}</div>${role==='principal'?'<p class="agent-perspective">观察并汇报课堂情况</p>':''}${agent.perspective?.trim() ? `<div class="agent-perspective">${esc(agent.perspective)}</div>` : ''}<p class="agent-key ${agent.hasKey?'':'missing'}">${agent.hasKey?'● 密钥已保存':'○ 未配置密钥'}${agent.jsonMode && agentProtocol(agent)!=='messages'?' · JSON 模式':''}</p><div class="agent-actions"><button class="link-button" data-agent-edit="${esc(agent.id)}">编辑配置</button><button class="link-button" data-agent-check="${esc(agent.id)}">${pendingChecks.has(agent.id)?'连接测试中…':'测试连接'}</button><button class="link-button delete-agent" data-agent-delete="${esc(agent.id)}">移除</button></div></article>`).join('') : `<div class="large-empty"><p>${empty}</p><button class="button secondary" data-add-agent="${role}">添加${label}</button></div>`}</div>`;
    }).join('');
  }
  // Extension management: persisted settings remain separate from running-task snapshots.
  let extensionsData = null, extensionTab = 'mcps', extensionsBusy = false, extensionsLoading = false, extensionsRequest = 0, extensionEditing = null;
  let modesData = null, modeEditing = null, extensionDeletion = null;
  const extensionSelected = new Set();
  const extensionTestResults = new Map();
  let extensionTestPending = null;
  const builtinMcpDescriptions = {
    browser: '对浏览器执行自动化操作',
    burpsuite: '调用Web测试神器burpsuite',
    tscan: '综合性Web安全分析工具',
    cyberchef: '数据分析工具',
    wireshark: '网络流量分析工具',
    windbg: '二进制漏洞分析工具',
    x64dbg: '对Windows程序进行动态调试',
    ida: '反汇编与反编译二进制程序',
    jadx: 'Android反编译与代码分析工具',
    ghidra: '分析二进制程序与反编译代码',
    gdb: '对Linux程序进行动态调试',
    sagemath: '数学与密码分析工具',
    pwntools: '二进制题目分析工具',
    metasploit: '渗透测试框架',
    bloodhound: '域环境关系分析工具',
    zsteg: '图片隐写分析工具',
    binwalk: '固件分析与提取工具',
    aflpp: '模糊测试工具',
  };
  const builtinMcpNames = { sagemath: 'sageMath', aflpp: 'AFL++' };
  const isBuiltinMcp = item => Object.hasOwn(builtinMcpDescriptions, item?.builtin);
  const isBuiltinSkill = item => typeof item?.builtin === 'string' && item.builtin.length > 0;
  const builtinMcpGuides = {
    jadx: [
      { text: '安装 JADX-GUI 1.5.1+ 和 uv；JADX 未附带运行环境时，按其安装说明配置 Java。', links: [['下载 JADX', 'https://github.com/skylot/jadx/releases'], ['安装 uv', 'https://docs.astral.sh/uv/getting-started/installation/']] },
      { text: '从 V6.4.1 发布页下载 jadx-ai-mcp-6.4.1.jar 和 jadx-mcp-server-6.4.1.zip，并解压 ZIP。在 JADX 的 Preferences → Plugins → Install plugin → Select Plugin jar 中选择该 JAR，点击 Install，然后重启 JADX。', links: [['下载 JADX MCP 插件与服务', 'https://github.com/zinja-coder/jadx-ai-mcp/releases/tag/V6.4.1']] },
      { text: '用 JADX 打开目标 APK。在 Plugins → JADX AI MCP Server → Server Status 中确认服务已启动、端口为 8650；未启动时点击 Restart Server。保持 JADX 运行。' },
      { text: '在解压后含 jadx_mcp_server.py 的目录打开终端，运行以下命令。首次运行会准备 Python 和依赖，保持终端开启。', code: 'uv run --python 3.12 jadx_mcp_server.py --http --host 127.0.0.1 --port 8651 --jadx-host 127.0.0.1 --jadx-port 8650' },
      { text: '回到 Class，在「编辑配置」中选择 http，地址填写以下内容，请求头留空。保存后点击「测试连接」，再启用并授权给所需成员。8650 是 JADX 插件端口，Class 连接的是 8651。', code: 'http://127.0.0.1:8651/mcp' },
    ],
    tscan: [
      { text: '从官方发布页下载适用于 Windows 或 Linux 的 TscanPlus 并解压。Linux 需先安装 GTK3 和 WebKitGTK 4.1 运行库。', links: [['下载 TscanPlus', 'https://github.com/TideSec/TscanPlus/releases']] },
      { text: '打开 TscanPlus，进入「AI辅助」→「MCP服务配置」，选择 Streamable HTTP，IP 填写 127.0.0.1、端口填写 8088，点击「启动」并保持 TscanPlus 运行。' },
      { text: '回到 Class，在「编辑配置」中选择 http，地址填写以下内容，请求头留空并保存。', code: 'http://127.0.0.1:8088/mcp' },
      { text: '点击卡片上的「测试连接」，确认连接成功并显示发现的工具数量。' },
    ],
    cyberchef: [
      { text: '安装 Node.js 26.x，安装后重新打开 PowerShell。运行以下命令，确认版本以 v26 开头。', code: 'node --version', links: [['下载 Node.js', 'https://nodejs.org/en/download'], ['CyberChef MCP 项目', 'https://github.com/doublegate/CyberChef-MCP']] },
      { text: '在 PowerShell 中安装 CyberChef MCP，完成后重新启动 Class。', code: 'npm.cmd install -g cyberchef-mcp@4.2.0' },
      { text: '在「编辑配置」中选择 stdio，命令填写 cmd.exe，参数填写以下内容。', code: '/d /s /c cyberchef-mcp' },
      { text: '在「环境变量」中填写以下内容并保存，使用按需查询的工具目录。', code: 'CYBERCHEF_TOOL_SURFACE=index\nCYBERCHEF_TRANSPORT=stdio' },
    ],
    wireshark: [
      { text: '安装 Wireshark，安装时保留 TShark 组件；安装 Python 3.12 并勾选 Add python.exe to PATH。', links: [['下载 Wireshark', 'https://www.wireshark.org/download.html'], ['下载 Python', 'https://www.python.org/downloads/windows/'], ['Wireshark MCP 项目', 'https://github.com/bx33661/Wireshark-MCP']] },
      { text: '重新打开 PowerShell，运行以下命令，安装完成后重新启动 Class。', code: 'python -m pip install wireshark-mcp==3.1.0' },
      { text: '在「编辑配置」中选择 stdio，命令填写 python，参数保留以下内容并保存。', code: '-m wireshark_mcp serve --transport stdio --profile analysis' },
      { text: '在「环境变量」中填写以下两行并保存；若 Wireshark 安装在其他位置，替换为实际文件路径，无需给路径加引号。', code: 'WIRESHARK_MCP_TSHARK_PATH=C:\\Program Files\\Wireshark\\tshark.exe\nWIRESHARK_MCP_CAPINFOS_PATH=C:\\Program Files\\Wireshark\\capinfos.exe' },
      { text: '布置任务时上传 PCAP/PCAPNG 文件，或填写文件的绝对路径。默认分析已有抓包文件，无需打开 Wireshark 窗口。' },
    ],
    windbg: [
      { text: '安装 WinDbg，以及 Python 3.12；安装 Python 时勾选 Add python.exe to PATH。', links: [['安装 WinDbg', 'https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/'], ['下载 Python', 'https://www.python.org/downloads/windows/'], ['WinDbg MCP 项目', 'https://github.com/svnscha/mcp-windbg']] },
      { text: '重新打开 PowerShell，运行以下命令，安装完成后重新启动 Class。', code: 'python -m pip install mcp-windbg==1.5.1' },
      { text: '在「编辑配置」中选择 stdio，命令填写 python，参数保留以下内容并保存。', code: '-m mcp_windbg --transport stdio' },
      { text: '布置任务时填写 .dmp 文件的绝对路径。无需预先打开 WinDbg 窗口；若未找到 cdb.exe，在参数末尾添加 --cdb-path "cdb.exe的完整路径"。调试内核时另需 kd.exe 及已配置的内核调试目标。' },
    ],
    browser: [
      { text: '安装Chrome、Firefox 149+或Edge', links: [['下载 Chrome', 'https://www.google.com/chrome/'], ['下载 Firefox', 'https://www.firefox.com/'], ['下载 Edge', 'https://www.microsoft.com/edge/download']] },
      { text: '在 Class 的「编辑配置」中选择 stdio，填写以下内容并保存。环境变量留空。', code: '命令：Class\n参数：--browser-mcp' },
    ],
    burpsuite: [
      { text: '启动 Burp Suite，在 Extensions → BApp Store 中选择 MCP Server，点击 Install。', links: [['下载 Burp Suite', 'https://portswigger.net/burp/releases'], ['MCP Server 扩展', 'https://portswigger.net/bappstore/9952290f04ed4f628e624d0aa9dccebc']] },
      { text: '打开 Burp 的 MCP 标签页，勾选 Enabled；主机设为 127.0.0.1，端口设为 9876。保持 Burp 运行。' },
      { text: '在 Class 的「编辑配置」中选择 sse，MCP服务器地址填写以下内容并保存。请求头留空。', code: 'http://127.0.0.1:9876' },
    ],
    x64dbg: [
      { text: '安装 x64dbg，下载 MCP 插件，将插件 dist 文件夹内的 x64、x32 目录复制到 x64dbg 根目录。', links: [['下载 x64dbg', 'https://x64dbg.com/'], ['下载 MCP 插件', 'https://github.com/duty1g/x64dbg-mcp-server/releases']] },
      { text: '启动 x64dbg 并打开目标程序。在 Plugins → x64dbg-MCP Server → Configure MCP Server… 中，将地址设为 127.0.0.1、端口设为 9094，点击 Copy 复制令牌。' },
      { text: '在 Class 的「编辑配置」中选择 http，MCP服务器地址填写：', code: 'http://127.0.0.1:9094/' },
      { text: '在「请求头」中填写以下内容，将占位文字换成刚复制的令牌，然后保存。保持 x64dbg 运行。', code: 'Authorization=Bearer 你的令牌' },
    ],
    ida: [
      { text: '安装 IDA 9.4+（含 idalib）、Python 3.11+、Git 和 uv。', links: [['IDA 安装要求', 'https://docs.hex-rays.com/core/mcp/getting-started'], ['安装 Python', 'https://www.python.org/downloads/'], ['安装 Git', 'https://git-scm.com/downloads'], ['安装 uv', 'https://docs.astral.sh/uv/getting-started/installation/']] },
      { text: '在 PowerShell 中运行以下命令安装官方 MCP 插件，然后重启 IDA 并打开目标文件。', code: 'uvx ida-hcli plugin install ida-mcp@https://github.com/HexRaysSA/ida-mcp' },
      { text: '在 PowerShell 中启动 MCP 服务，保持终端和 IDA 运行。', code: 'uvx ida-mcp http --host 127.0.0.1 --port 8737' },
      { text: '在 Class 的「编辑配置」中选择 http，MCP服务器地址填写以下内容并保存。请求头留空。', code: 'http://127.0.0.1:8737/mcp' },
    ],
    ghidra: [
      { text: '安装 Ghidra 12.1.4、64 位 JDK 21、Python 3.10+、Git 和 uv。', links: [['下载 Ghidra', 'https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build'], ['Ghidra 安装要求', 'https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/README.md'], ['安装 uv', 'https://docs.astral.sh/uv/getting-started/installation/']] },
      { text: '下载 GhidraMCP 2.0 的插件 ZIP，在 Ghidra 的 File → Install Extensions → + 中安装。重启后在 File → Configure → Developer 中启用 GhidraMCPPlugin，并在 CodeBrowser 中打开目标。', links: [['下载 MCP 插件', 'https://github.com/LaurieWired/GhidraMCP/releases/tag/2.0']] },
      { text: '在终端中运行以下命令，保持终端和 Ghidra 运行。', code: 'uvx --from git+https://github.com/LaurieWired/GhidraMCP@2.0 ghidra-mcp --transport streamable-http --mcp-host 127.0.0.1 --mcp-port 8081 --ghidra-server http://127.0.0.1:8080/' },
      { text: '在 Class 的「编辑配置」中选择 http，MCP服务器地址填写以下内容并保存。请求头留空。', code: 'http://127.0.0.1:8081/mcp' },
    ],
    gdb: [
      { text: '安装 GDB、Python 3.10+、Git 和 uv。Ubuntu / Debian 可先执行：', code: 'sudo apt install gdb python3 git', links: [['安装 uv', 'https://docs.astral.sh/uv/getting-started/installation/'], ['GDB MCP 安装说明', 'https://github.com/BeaCox/gdb-mcp/blob/v0.4.0/README.md']] },
      { text: '在终端中运行以下命令启动 MCP 服务，保持终端开启。', code: 'uvx --from git+https://github.com/BeaCox/gdb-mcp.git@v0.4.0 gdb-mcp-backend --transport streamable-http --host 127.0.0.1 --port 8000' },
      { text: '在 Class 的「编辑配置」中选择 http，MCP服务器地址填写以下内容并保存。请求头留空。', code: 'http://127.0.0.1:8000/mcp' },
    ],
    sagemath: [
      { text: '在 Linux 安装 uv，再安装以下 MCP 及数学运行库；首次下载较大，请在连接前完成安装。Class 不自带 SageMath。', code: "uv tool install --python 3.12 'sagemath-mcp[passagemath]==0.9.5'", links: [['安装 uv', 'https://docs.astral.sh/uv/getting-started/installation/'], ['sageMath MCP', 'https://github.com/XBP-Europe/sagemath-mcp']] },
      { text: '若已经安装 SageMath，可改用不带额外运行库的安装命令，并在 Class 的「环境变量」中将 SAGEMATH_MCP_SAGE_BINARY 设为 command -v sage 显示的绝对路径。', code: 'uv tool install --python 3.12 sagemath-mcp==0.9.5\ncommand -v sage' },
      { text: '在「编辑配置」中选择 stdio，命令填写 sagemath-mcp，参数填写 --transport stdio。重启 Class 后若仍找不到命令，用以下命令显示的绝对路径替换命令栏。', code: 'command -v sagemath-mcp' },
      { text: '保存后点击「测试连接」，确认显示发现的工具数量；布置任务时给出公式、矩阵或需要分析的数学问题。' },
    ],
    pwntools: [
      { text: 'Linux 版 Class 内置此 MCP 适配器，仍需安装 Python 和官方 pwntools。Ubuntu / Debian 可先安装依赖，再创建专用环境。', code: 'sudo apt install python3 python3-venv python3-dev build-essential binutils libssl-dev libffi-dev\npython3 -m venv "$HOME/.local/share/class-mcp/pwntools"\n"$HOME/.local/share/class-mcp/pwntools/bin/python" -m pip install pwntools==4.15.0', links: [['pwntools 安装说明', 'https://docs.pwntools.com/en/stable/install.html']] },
      { text: '在「编辑配置」中选择 stdio，保留以下命令和参数。Class 会解析自身入口，不要求把 Class 加入 PATH。', code: '命令：Class\n参数：--local-analysis-mcp pwntools' },
      { text: '默认使用上述专用环境的 Python。已有 pwntools 环境时，先激活它，用 command -v python 查到绝对路径，再把该路径填入环境变量 CLASS_PWNTOOLS_PYTHON；不要填写其他未安装 pwntools 的 Python。', code: 'command -v python' },
      { text: '保存后点击「测试连接」，检查依赖可用性和 MCP 工具目录；该检查不读取目标文件或执行用户分析脚本。布置任务时提供目标文件路径及分析要求。' },
    ],
    zsteg: [
      { text: 'Linux 版 Class 内置此 MCP 适配器。先安装 Ruby、file 和官方 zsteg；Ubuntu / Debian 可执行：', code: 'sudo apt install ruby ruby-dev build-essential file\ngem install --user-install zsteg', links: [['zsteg 项目', 'https://github.com/zed-0xff/zsteg']] },
      { text: '确认 zsteg 的绝对路径。若 command -v 没有输出，使用第二行显示的路径，在 Class「环境变量」中设置 CLASS_ZSTEG_PATH。', code: 'command -v zsteg\nprintf "%s/bin/zsteg\\n" "$(gem env user_gemhome)"' },
      { text: '在「编辑配置」中选择 stdio，保留以下命令和参数；保存后点击「测试连接」。', code: '命令：Class\n参数：--local-analysis-mcp zsteg' },
      { text: '布置任务时提供 PNG 或 BMP 文件。测试连接会检查 zsteg 依赖可用性和 MCP 工具目录，不读取目标文件或执行用户分析脚本。' },
    ],
    binwalk: [
      { text: 'Linux 版 Class 内置此 MCP 适配器，仍需安装 Rust 工具链及官方 Binwalk v3。Ubuntu / Debian 安装以下编译依赖后，通过 Cargo 安装固定版本。', code: 'sudo apt install build-essential libfontconfig1-dev liblzma-dev binutils\ncargo install binwalk --version 3.1.0 --locked', links: [['安装 Rust', 'https://rustup.rs/'], ['Binwalk 安装说明', 'https://github.com/ReFirmLabs/binwalk/wiki/Cargo-Installation'], ['提取器依赖', 'https://github.com/ReFirmLabs/binwalk/blob/master/dependencies/README.md']] },
      { text: '在「编辑配置」中选择 stdio，保留以下命令和参数。', code: '命令：Class\n参数：--local-analysis-mcp binwalk' },
      { text: '重启 Class；若分析时找不到 binwalk，在「环境变量」中将 CLASS_BINWALK_PATH 设为以下命令显示的绝对路径。解包部分格式还需按官方说明安装相应提取器。', code: 'command -v binwalk' },
      { text: '保存后点击「测试连接」，检查 Binwalk 依赖可用性和 MCP 工具目录，不读取目标文件或执行用户分析脚本；布置任务时提供固件文件路径及扫描或提取要求。' },
    ],
    metasploit: [
      { text: 'Linux 先按官方说明安装 Ruby 3.3.8 和 Metasploit 编译依赖。以下固定版本包含官方 msfmcpd；进入源码目录后安装 Bundler 和依赖。Class 不安装或启动 Metasploit。', code: 'git clone https://github.com/rapid7/metasploit-framework.git\ncd metasploit-framework\ngit checkout b22ce1fbae63e8caeb3a773366a6d3336bd66fb8\ngem install bundler -v 2.5.22\nbundle _2.5.22_ install', links: [['安装 Ruby', 'https://www.ruby-lang.org/en/documentation/installation/'], ['Metasploit 开发环境', 'https://docs.metasploit.com/docs/development/get-started/setting-up-a-metasploit-development-environment.html'], ['官方 MCP 指南', 'https://github.com/rapid7/metasploit-framework/blob/b22ce1fbae63e8caeb3a773366a6d3336bd66fb8/docs/metasploit-framework.wiki/How-to-use-Metasploit-MCP-Server.md']] },
      { text: '在源码目录运行以下命令，并保持终端开启。未运行本地 RPC 时会自动启动；若已有 RPC，需按官方指南另设其真实用户名和密码。', code: 'MSF_API_TYPE=messagepack MSF_API_HOST=127.0.0.1 MSF_API_PORT=55553 MSF_API_SSL=true MSF_MCP_HOST=127.0.0.1 MSF_MCP_PORT=3000 ./msfmcpd --mcp-transport http' },
      { text: '在 Class「编辑配置」中选择 http，地址填写 http://127.0.0.1:3000/。在「请求头」新增 Authorization，值填 Bearer 加一个空格及终端显示的实际令牌。默认令牌每次启动改变；需要固定令牌时在启动服务前自行设置 MSF_MCP_AUTH_TOKEN。' },
      { text: '保存后点击「测试连接」。若提示找不到 Ruby，可用 command -v ruby 检查安装路径；数据库查询还需初始化并启动 Metasploit 数据库。', code: 'command -v ruby' },
      { text: '上游默认关闭模块执行、check、会话写入和停止。确需这些能力时，由你在启动 msfmcpd 时添加 --enable-dangerous-actions；Class 的预设不会开启此选项。' },
    ],
    bloodhound: [
      { text: 'Linux 先安装 Docker Compose v2，再按官方指南下载对应架构的 bloodhound-cli，首次执行 install，以后使用 up 启动。需要 BloodHound CE 或 Enterprise API，旧版 Legacy 不适用。', code: 'chmod +x ./bloodhound-cli\n./bloodhound-cli install\n./bloodhound-cli up', links: [['BloodHound CE 安装指南', 'https://bloodhound.specterops.io/get-started/quickstart/community-edition-quickstart'], ['下载 bloodhound-cli 0.2.1', 'https://github.com/SpecterOps/bloodhound-cli/releases/tag/v0.2.1']] },
      { text: '打开 http://127.0.0.1:8080/ui/login，在 Administration → API Tokens 创建令牌并保存 Token ID 与 Token Key。安装 uv 后执行：', code: 'uv tool install --python 3.12 git+https://github.com/mwnickerson/bloodhound_mcp@cdb17097e761c8a8622cb93bc3ba49a9e150bb6e', links: [['安装 uv', 'https://docs.astral.sh/uv/getting-started/installation/'], ['BloodHound MCP 项目', 'https://github.com/mwnickerson/bloodhound_mcp']] },
      { text: '在「编辑配置」中选择 stdio，命令填写 bloodhound-mcp，参数留空。在「环境变量」中填写以下地址设置，再分别添加 BLOODHOUND_TOKEN_ID 和 BLOODHOUND_TOKEN_KEY，值使用刚创建的实际令牌。远程部署需改为真实地址、端口和协议。', code: 'BLOODHOUND_DOMAIN=127.0.0.1\nBLOODHOUND_PORT=8080\nBLOODHOUND_SCHEME=http' },
      { text: '重启 Class；找不到命令时，将以下命令显示的绝对路径填入命令栏。保存后点击「测试连接」；服务启动会校验令牌，凭据错误时无法连接。HTTPS 默认验证证书。', code: 'command -v bloodhound-mcp' },
    ],
    aflpp: [
      { text: 'Linux 先安装 Node.js、Git 和 AFL++ 编译依赖，再把 MCP 和 AFL++ 源码安装到专用目录。以下操作只需首次安装时完成，Class 不自动下载或编译。', code: 'sudo apt install git build-essential clang llvm-dev lld python3-dev automake\nmkdir -p "$HOME/.local/share/class-mcp"\ncd "$HOME/.local/share/class-mcp"\ngit clone https://github.com/kevin-valerio/aflpp-mcp.git\ncd aflpp-mcp\ngit checkout 72a4eb3d1e3ae03b217d4b09513483535e6e576c\nnpm ci\nnpm run build\ngit clone https://github.com/AFLplusplus/AFLplusplus.git AFLplusplus\ngit -C AFLplusplus checkout b449e4c544eaac1a0a9b7d1f2f15d5921907585e\nmake -C AFLplusplus all', links: [['安装 Node.js', 'https://nodejs.org/en/download'], ['AFL++ 编译说明', 'https://github.com/AFLplusplus/AFLplusplus/blob/stable/docs/INSTALL.md'], ['AFL++ MCP 项目', 'https://github.com/kevin-valerio/aflpp-mcp']] },
      { text: '上游没有全局命令入口；执行以下命令创建本地启动脚本。AFLPP_DIR 必须位于 AFLPP_MCP_ROOT 内。', code: 'mkdir -p "$HOME/.local/bin"\ncat > "$HOME/.local/bin/aflpp-mcp" <<\'EOF\'\n#!/bin/sh\nexport AFLPP_MCP_ROOT="$HOME/.local/share/class-mcp/aflpp-mcp"\nexport AFLPP_DIR="$AFLPP_MCP_ROOT/AFLplusplus"\nexec node "$AFLPP_MCP_ROOT/dist/index.js"\nEOF\nchmod +x "$HOME/.local/bin/aflpp-mcp"' },
      { text: '将 ~/.local/bin 加入 PATH 并重启 Class。在「编辑配置」中选择 stdio，命令填写 aflpp-mcp，参数和环境变量留空。找不到命令时，用 command -v 的结果或第二行显示的绝对路径替换命令栏。', code: 'command -v aflpp-mcp\nprintf "%s/.local/bin/aflpp-mcp\\n" "$HOME"' },
      { text: '保存后点击「测试连接」。布置任务时提供待测源码、构建方法和初始输入；长时间模糊测试由上游任务接口启动并查询状态。' },
    ],
  };
  const linuxWiresharkGuide = [
    { text: '在 Linux 安装 TShark 与 uv。Ubuntu / Debian 可执行以下命令；默认分析已有抓包文件，无需抓包权限或 Wireshark 窗口。', code: 'sudo apt install tshark\nuv tool install --python 3.12 wireshark-mcp==3.1.0', links: [['安装 uv', 'https://docs.astral.sh/uv/getting-started/installation/'], ['Wireshark MCP 项目', 'https://github.com/bx33661/Wireshark-MCP']] },
    { text: '在「编辑配置」中选择 stdio，命令填写 wireshark-mcp，参数填写以下内容；环境变量通常留空。', code: 'serve --transport stdio --profile analysis' },
    { text: '安装后重启 Class；若找不到命令，用第一行显示的绝对路径替换命令栏。若找不到 TShark 或 capinfos，分别把实际路径填入环境变量 WIRESHARK_MCP_TSHARK_PATH、WIRESHARK_MCP_CAPINFOS_PATH。', code: 'command -v wireshark-mcp\ncommand -v tshark\ncommand -v capinfos' },
    { text: '保存后点击「测试连接」。布置任务时上传 PCAP/PCAPNG 文件，或填写文件的绝对路径。Class 不自带 TShark 或这个外部 MCP 服务。' },
  ];
  function openExtensionGuide(id) {
    const item = extensionsData?.[extensionTab]?.find(entry => entry.id === id);
    if (!item || extensionTab === 'modes' || (extensionTab === 'skills' && isBuiltinSkill(item))) return;
    const builtin = extensionTab === 'mcps' && isBuiltinMcp(item);
    const guide = builtin ? item.builtin === 'wireshark' && extensionsData.platform === 'linux' ? linuxWiresharkGuide : builtinMcpGuides[item.builtin] : extensionTab === 'mcps' ? [
      { text: item.transport === 'stdio' ? '打开「编辑配置」，确认已保存的命令、参数及所需环境变量；在本机安装该MCP项目要求的程序，并确保命令可用。' : `先按该MCP项目的说明启动${item.transport}服务，再打开「编辑配置」核对已保存的服务器地址及必要的请求头。` },
      { text: '保存后点击「测试连接」，连接成功后再使用。具体安装命令请以该MCP项目的官方说明为准。' },
    ] : [{ text: '打开「编辑配置」，检查技能简介及完整Markdown正文，写清适用场景、操作步骤和所需工具。' }, { text: '保存后，Agent可在任务中按需查找并读取技能正文；若步骤需要外部工具，请先配置对应MCP。' }];
    const steps = [...(guide || []), { text: `回到卡片点击「启用」，勾选该${extensionTab === 'mcps' ? 'MCP' : 'Skill'} →「授权成员」→ 选择老师或学生 →「保存授权」。` + (item.builtin === 'gdb' ? '布置任务时填写目标程序的绝对路径。' : '') }];
    $('extension-guide-title').textContent = `${builtin ? builtinMcpNames[item.builtin] || item.builtin : item.name} 配置指南`;
    $('extension-guide-content').innerHTML = '<ol>' + steps.map(step => `<li><p>${esc(step.text)}</p>${step.code ? `<pre><code>${esc(step.code)}</code></pre>` : ''}${step.links?.length ? `<div class="extension-guide-links">${step.links.map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`).join('')}</div>` : ''}</li>`).join('') + '</ol>';
    $('extension-guide-content').scrollTop = 0;
    openDialog('extension-guide-dialog');
  }
  const extensionLocked = () => busy || extensionsBusy || extensionsLoading || state?.relocating === true || dataDirectorySaving || directoryPickerPending || shutdown || shuttingDown || !lastConnection || !token;
  const extensionItems = () => extensionTab === 'modes' ? (modesData?.items || []).filter(item => item.id !== 'auto') : extensionsData?.[extensionTab] || [];
  const protectedExtension = (item, kind = extensionTab) => kind === 'modes' ? item.builtin === true : Boolean(item.builtin);
  const deletableSelection = () => extensionItems().filter(item => extensionSelected.has(item.id) && !protectedExtension(item));
  function extensionControls() {
    const locked = extensionLocked();
    $('extension-add').disabled = locked || !extensionsData || (extensionTab === 'modes' && !modesData);
    $('extensions-refresh').disabled = extensionsBusy || extensionsLoading || shutdown || shuttingDown || !lastConnection || !token;
    $('extensions-grant').disabled = locked || !extensionSelected.size;
    $('extensions-grant').hidden = extensionTab === 'modes';
    $('extensions-delete').disabled = locked || !deletableSelection().length;
    $('extensions-select-all').disabled = locked || !extensionItems().length;
    $('extensions-run-notice').hidden = !live();
    $('extensions-run-notice').textContent = '配置修改应用于后续任务，正在运行的任务保持原配置。';
    document.querySelectorAll('[data-extension-edit],[data-extension-toggle],[data-extension-delete],[data-extension-select]').forEach(node => node.disabled = locked);
    document.querySelectorAll('[data-extension-test]').forEach(node => node.disabled = locked || Boolean(extensionTestPending));
    document.querySelectorAll('#extension-form input,#extension-form select,#extension-form textarea,#extension-form button,#extension-grant-form input,#extension-grant-form button').forEach(node => node.disabled = locked);
    for (const id of ['extension-stdio-fields', 'extension-remote-fields']) $(id).querySelectorAll('input,textarea').forEach(node => node.disabled = locked || $(id).hidden);
    $('extension-delete-confirm').disabled = locked || !extensionDeletion;
    document.querySelectorAll('#extension-delete-dialog [data-dialog-close]').forEach(node => node.disabled = extensionsBusy);
    document.querySelectorAll('#mode-form input,#mode-form textarea,#mode-form button').forEach(node => { node.disabled = locked || Boolean(modeEditing?.readonly && node.type === 'checkbox'); });
  }
  function extensionChoiceMarkup(items, selected, attribute, label) {
    return items.length ? items.map(item => `<label class="extension-choice"><input type="checkbox" ${attribute}="${esc(item.id)}"${selected.includes(item.id) ? ' checked' : ''}><span>${esc(item.name || item.id)}${label ? `<small>${esc(label(item))}</small>` : ''}</span></label>`).join('') : '<p class="field-note">暂无可选成员</p>';
  }
  function renderExtensions() {
    const items = extensionItems();
    for (const id of extensionSelected) if (!items.some(item => item.id === id)) extensionSelected.delete(id);
    document.querySelectorAll('[data-extension-tab]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.extensionTab === extensionTab)));
    $('extension-add-label').textContent = extensionTab === 'mcps' ? '添加 MCP' : extensionTab === 'skills' ? '添加 Skill' : '添加模式';
    $('extensions-selection-count').textContent = `已选择 ${extensionSelected.size} 项`;
    $('extensions-select-all').checked = items.length > 0 && extensionSelected.size === items.length;
    $('extensions-select-all').indeterminate = extensionSelected.size > 0 && extensionSelected.size < items.length;
    if (extensionTab === 'modes') {
      $('extensions-content').innerHTML = !modesData ? '<div class="large-empty"><p>正在读取模式…</p></div>' : items.length ? items.map(item => `<article class="card extension-card mode-card${extensionSelected.has(item.id) ? ' selected' : ''}"><div class="extension-card-heading"><label class="extension-check"><input type="checkbox" data-extension-select="${esc(item.id)}" aria-label="选择 ${esc(item.name)}"${extensionSelected.has(item.id) ? ' checked' : ''}></label><span class="extension-mark">${icon(taskModeIcon(item.id))}</span><div><h3><button type="button" class="mode-title-button" data-mode-view="${esc(item.id)}">${esc(item.name)}</button></h3></div><span class="memory-status active">${item.builtin ? '内置' : '自定义'}</span></div><p class="extension-description">${(item.mcps || []).length} 个MCP · ${(item.skills || []).length} 个Skill</p><div class="extension-card-actions"><button type="button" class="link-button" data-mode-view="${esc(item.id)}">查看配置</button>${item.builtin ? '' : `<button type="button" class="link-button extension-delete" data-extension-delete="${esc(item.id)}">删除</button>`}</div></article>`).join('') : '<div class="large-empty"><p>暂无模式</p></div>';
      extensionControls(); return;
    }
    $('extensions-content').innerHTML = !extensionsData ? '<div class="large-empty"><p>正在读取扩展配置…</p></div>' : items.length ? items.map(item => {
      const members = (item.agentIds || []).map(id => extensionsData.agents.find(agent => agent.id === id)?.name || id);
      const builtin = extensionTab === 'mcps' && isBuiltinMcp(item);
      const builtinSkill = extensionTab === 'skills' && isBuiltinSkill(item);
      const description = builtin ? builtinMcpDescriptions[item.builtin] : extensionTab === 'mcps' ? item.transport === 'stdio' ? [item.command, ...(item.args || [])].join(' ') : item.url : item.description || '按需加载的 Markdown 技能';
      const kind = extensionTab === 'mcps' ? item.transport.toUpperCase() : '';
      const testing = extensionTab === 'mcps' && extensionTestPending?.id === item.id;
      const testResult = extensionTab === 'mcps' ? extensionTestResults.get(item.id) : null;
      const toggle = `<button type="button" class="link-button" data-extension-toggle="${esc(item.id)}">${item.enabled ? '停用' : '启用'}</button>`;
      const connectionActions = extensionTab === 'mcps' ? `<span class="extension-connection-actions">${toggle}<button type="button" class="link-button" data-extension-test="${esc(item.id)}" aria-busy="${testing}">${testing ? '测试中…' : '测试连接'}</button></span>` : toggle;
      return `<article class="card extension-card${extensionSelected.has(item.id) ? ' selected' : ''}"><div class="extension-card-heading"><label class="extension-check"><input type="checkbox" data-extension-select="${esc(item.id)}" aria-label="选择 ${esc(item.name)}"${extensionSelected.has(item.id) ? ' checked' : ''}></label><span class="extension-mark">${icon(builtin ? item.builtin : extensionTab === 'mcps' ? 'extensions' : 'logs')}</span><div><h3>${esc(item.name)}</h3>${builtin || !kind ? '' : `<span class="extension-kind">${esc(kind)}</span>`}</div><span class="memory-status ${item.enabled ? 'active' : 'paused'}">${item.enabled ? '已启用' : '已停用'}</span></div><p class="extension-description">${esc(description)}</p><div class="extension-members">${icon('users')}<span>${esc(members.length ? members.join('、') : '尚未授权成员')}</span></div>${testResult ? `<p class="extension-test-result${testResult.ok ? '' : ' failed'}" data-extension-test-result="${esc(item.id)}" role="status">${esc(testResult.message)}</p>` : ''}<div class="extension-card-actions"><button type="button" class="link-button" data-extension-edit="${esc(item.id)}">编辑配置</button>${connectionActions}${builtinSkill ? '' : `<span class="extension-card-end"><button type="button" class="link-button extension-guide-button" data-extension-guide="${esc(item.id)}" aria-haspopup="dialog">配置指南</button>${protectedExtension(item) ? '' : `<button type="button" class="link-button extension-delete" data-extension-delete="${esc(item.id)}" aria-label="删除 ${esc(item.name)}" aria-haspopup="dialog">删除</button>`}</span>`}</div></article>`;
    }).join('') : `<div class="large-empty">${icon(extensionTab === 'mcps' ? 'extensions' : 'logs')}<h3>${extensionTab === 'mcps' ? '暂无 MCP' : '暂无Skill'}</h3></div>`;
    extensionControls();
  }
  function acceptExtensions(value) {
    if (!value || !Array.isArray(value.mcps) || !Array.isArray(value.skills) || !Array.isArray(value.agents) || !Number.isSafeInteger(value.revision)) throw new Error('扩展配置响应无效，请刷新后重试。');
    if (value.revision !== extensionsData?.revision) extensionTestResults.clear();
    for (const id of extensionTestResults.keys()) if (!value.mcps.some(item => item.id === id)) extensionTestResults.delete(id);
    extensionsData = value;
  }
  async function testExtensionConnection(id) {
    if (extensionTab !== 'mcps' || extensionLocked() || extensionTestPending || !extensionsData?.mcps.some(item => item.id === id)) return;
    const request = { id, revision: extensionsData.revision, token };
    const current = () => token === request.token && extensionsData?.revision === request.revision && extensionsData.mcps.some(item => item.id === id);
    extensionTestPending = request; extensionTestResults.delete(id); renderExtensions();
    try {
      const result = await api('/api/extensions/test', { method: 'POST', body: { id, revision: request.revision }, signal: AbortSignal.timeout(45000), isCurrent: current });
      if (!current()) return;
      if (result?.ok !== true) throw new Error(typeof result?.message === 'string' && result.message ? result.message : '连接测试失败，请检查配置后重试。');
      if (!Number.isSafeInteger(result.toolCount) || result.toolCount < 0) throw new Error('连接测试响应无效，请重试。');
      extensionTestResults.set(id, { ok: true, message: `连接成功，发现 ${result.toolCount} 个工具。` });
    } catch (error) {
      if (current()) extensionTestResults.set(id, { ok: false, message: '连接失败：' + (error.name === 'TimeoutError' ? '测试超时，请检查 MCP 是否已启动后重试。' : String(error.message || '请检查配置后重试。').slice(0, 500)) });
    } finally {
      if (extensionTestPending === request) extensionTestPending = null;
      renderExtensions();
    }
  }
  async function loadExtensions() {
    if (extensionsBusy || extensionsLoading || shutdown || shuttingDown || !token) return;
    const request = ++extensionsRequest; extensionsLoading = true; extensionControls();
    const dataDir = state?.dataDir, current = () => request === extensionsRequest && state?.dataDir === dataDir;
    try { const [result, modes] = await Promise.all([api('/api/extensions', { isCurrent:current }), api('/api/modes', { isCurrent:current })]); if (!current()) return; acceptExtensions(result); acceptModes(modes); $('extensions-error').hidden = true; renderExtensions(); }
    catch (error) { if (request === extensionsRequest) { $('extensions-error').hidden = false; $('extensions-error').textContent = error.message; } }
    finally { if (request === extensionsRequest) { extensionsLoading = false; extensionControls(); } }
  }
  function extensionConfiguration() {
    if (!extensionsData) throw new Error('请先读取扩展配置。');
    return { revision: extensionsData.revision, mcps: extensionsData.mcps.map(item => {
      const { id, name, enabled, transport, agentIds } = item;
      const common = { id, name, enabled, transport, agentIds: [...agentIds] };
      return { ...common, ...(item.builtin ? { builtin: item.builtin } : {}), command: item.command, args: item.args ? [...item.args] : [], cwd: item.cwd, url: item.url, ...(typeof item.skipTlsVerify === 'boolean' ? { skipTlsVerify: item.skipTlsVerify } : {}) };
    }), skills: extensionsData.skills.map(({ id, name, description, enabled, content, agentIds, builtin }) => ({ id, name, description, enabled, content, agentIds: [...agentIds], ...(builtin ? { builtin } : {}) })) };
  }
  async function mutateExtensions(makeConfig, afterSave) {
    if (extensionLocked()) return false;
    extensionsBusy = true; extensionControls();
    try {
      const config = makeConfig();
      const result = await api('/api/extensions', { method: 'PUT', body: config });
      acceptExtensions(result); $('extensions-error').hidden = true; renderExtensions(); afterSave?.(); toast('扩展配置已保存，将用于下一次任务。'); return true;
    } catch (error) { toast(error.message, true); return false; }
    finally { extensionsBusy = false; extensionControls(); }
  }
  function parseExtensionArgs(value) {
    const args = []; let word = '', quote = '', started = false;
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (quote) {
        if (char === quote) { quote = ''; continue; }
        if (quote === '"' && char === '\\') {
          const next = value[index + 1];
          // Only explicit quoted escapes are decoded; ordinary Windows paths keep \n, \t, etc.
          if (next === quote || next === '\\') { word += next; index++; continue; }
          const escaped = /^u\{([\da-f]{1,6})\}/i.exec(value.slice(index + 1));
          if (escaped && Number.parseInt(escaped[1], 16) <= 0x10ffff) {
            word += String.fromCodePoint(Number.parseInt(escaped[1], 16)); index += escaped[0].length; continue;
          }
        }
        word += char;
      } else if (char === '"' || char === "'") { quote = char; started = true; }
      else if (/\s/u.test(char)) { if (started) { args.push(word); word = ''; started = false; } }
      else { word += char; started = true; }
    }
    if (quote) throw new Error('启动参数的引号未闭合，请补全后再保存。');
    if (started) args.push(word);
    return args;
  }
  function formatExtensionArgs(args) {
    return args.map(value => value && !/[\s'"\u0000-\u001f\u007f]/u.test(value) ? value : '"' + value.replace(/[\\"\u0000-\u001f\u007f]/g, char => char === '\\' || char === '"' ? '\\' + char : `\\u{${char.charCodeAt(0).toString(16)}}`) + '"').join(' ');
  }
  function resizeExtensionInputs() {
    for (const id of ['extension-args', 'extension-env', 'extension-headers']) {
      const input = $(id); if (!input?.getClientRects().length) continue;
      const style = getComputedStyle(input), line = Number.parseFloat(style.lineHeight) || 22;
      const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
      const minimum = line + padding + border, maximum = line * 3 + padding + border;
      input.style.overflowY = 'hidden'; input.style.height = `${minimum}px`;
      const height = input.scrollHeight + border;
      input.style.height = `${Math.min(maximum, Math.max(minimum, height))}px`;
      input.style.overflowY = height > maximum ? 'auto' : 'hidden';
    }
  }
  function extensionTransportVisibility() {
    const configurable = extensionEditing?.type === 'mcps';
    const local = $('extension-transport').value === 'stdio';
    $('extension-transport-controls').hidden = !configurable;
    $('extension-stdio-fields').hidden = !configurable || !local; $('extension-remote-fields').hidden = !configurable || local;
    $('extension-command').required = configurable && local;
    $('extension-url').required = configurable && !local;
    document.querySelectorAll('[data-extension-transport]').forEach(button => {
      const selected = button.dataset.extensionTransport === $('extension-transport').value;
      button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
    extensionControls();
    requestAnimationFrame(resizeExtensionInputs);
  }
  function chooseExtensionTransport(value, focus = false) {
    if (extensionLocked() || extensionEditing?.type !== 'mcps' || !['stdio', 'http', 'sse'].includes(value)) return;
    $('extension-transport').value = value; extensionTransportVisibility();
    if (focus) document.querySelector(`[data-extension-transport="${value}"]`)?.focus();
  }
  function openExtension(id) {
    if (extensionLocked() || !extensionsData || document.querySelector('dialog[open]:not(#principal-dialog)')) return;
    if (extensionTab === 'modes') { openMode(); return; }
    const item = id ? extensionsData[extensionTab].find(entry => entry.id === id) : null;
    if (id && !item) return;
    const builtin = extensionTab === 'mcps' && isBuiltinMcp(item);
    extensionEditing = { type: extensionTab, id: item?.id || '', cwd: item?.cwd, ...(builtin ? { builtin: item.builtin } : {}) }; $('extension-form').reset();
    $('extension-dialog').dataset.extensionKind = extensionTab;
    $('extension-dialog-title').textContent = item && extensionTab === 'mcps' ? '编辑配置' : `${item ? '编辑' : '添加'} ${extensionTab === 'mcps' ? 'MCP' : 'Skill'}`;
    $('extension-name').value = item?.name || '';
    $('extension-mcp-fields').hidden = extensionTab !== 'mcps'; $('extension-skill-fields').hidden = extensionTab !== 'skills';
    $('extension-transport').value = item?.transport || 'stdio'; $('extension-command').value = item?.command || '';
    $('extension-args').value = formatExtensionArgs(item?.args || []); $('extension-url').value = item?.url || '';
    $('extension-skip-tls-verify').checked = item?.skipTlsVerify === true;
    $('extension-env').value = ''; $('extension-headers').value = '';
    $('extension-description').value = item?.description || ''; $('extension-content').value = item?.content || '';
    $('extension-content').required = extensionTab === 'skills';
    $('extension-env-keys').innerHTML = (item?.envKeys || []).map(key => `<label class="extension-check"><input type="checkbox" data-clear-env="${esc(key)}"><span>删除 ${esc(key)}</span></label>`).join('');
    $('extension-header-keys').innerHTML = (item?.headerKeys || []).map(key => `<label class="extension-check"><input type="checkbox" data-clear-header="${esc(key)}"><span>删除 ${esc(key)}</span></label>`).join('');
    extensionTransportVisibility(); openDialog('extension-dialog'); extensionControls();
  }
  function extensionChecked(container, attribute) { return [...$(container).querySelectorAll(`[${attribute}]:checked`)].map(node => node.getAttribute(attribute)); }
  function extensionSecretInput(id, header = false) {
    const lines = $(id).value.split(/\r\n?|\n/), parsed = Object.create(null), seen = new Set(), label = header ? '请求头' : '环境变量';
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const separator = line.indexOf('='), key = line.slice(0, separator).trim();
      if (separator < 1 || !key) throw new Error(`${label}第 ${index + 1} 行须使用 KEY=VALUE 格式。`);
      if (!(header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,127}$/).test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`${label}第 ${index + 1} 行的名称无效。`);
      const identity = header ? key.toLowerCase() : key;
      if (seen.has(identity)) throw new Error(`${label}第 ${index + 1} 行重复填写了“${key}”。`);
      const value = line.slice(separator + 1);
      if (value.length > 8192 || value.includes('\0') || (header && /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new Error(`${label}第 ${index + 1} 行的值无效。`);
      parsed[key] = value; seen.add(identity);
    }
    if (seen.size > 64) throw new Error(`${label}最多填写 64 项。`);
    return seen.size ? parsed : undefined;
  }
  async function saveExtension() {
    if (!extensionEditing) return;
    const editing = extensionEditing, session = dialogSessions.get($('extension-dialog'));
    await mutateExtensions(() => {
      const config = extensionConfiguration();
      const previous = editing.id ? config[editing.type].find(item => item.id === editing.id) : null;
      if (editing.id && !previous) throw new Error('扩展配置已更新，请刷新后重试。');
      const item = { ...(editing.id ? { id: editing.id } : {}), name: $('extension-name').value.trim(), enabled: previous ? previous.enabled : true, agentIds: previous ? [...previous.agentIds] : [] };
      if (editing.type === 'mcps') {
        const transport = $('extension-transport').value;
        Object.assign(item, { transport, ...(editing.builtin ? { builtin: editing.builtin } : {}), ...(editing.cwd ? { cwd: editing.cwd } : {}) });
        if (transport === 'stdio') Object.assign(item, { command: $('extension-command').value.trim(), args: parseExtensionArgs($('extension-args').value), env: extensionSecretInput('extension-env'), clearEnv: extensionChecked('extension-env-keys', 'data-clear-env') });
        else Object.assign(item, { url: $('extension-url').value.trim(), skipTlsVerify: $('extension-skip-tls-verify').checked, headers: extensionSecretInput('extension-headers', true), clearHeaders: extensionChecked('extension-header-keys', 'data-clear-header') });
      }
      else Object.assign(item, { description: $('extension-description').value.trim(), content: $('extension-content').value, ...(previous?.builtin ? { builtin: previous.builtin } : {}) });
      if (editing.id) config[editing.type] = config[editing.type].map(prior => prior.id === editing.id ? item : prior); else config[editing.type].push(item);
      return config;
    }, () => closeSavedDialog('extension-dialog', session));
  }
  function openExtensionGrant() {
    if (extensionTab === 'modes' || extensionLocked() || !extensionSelected.size || document.querySelector('dialog[open]:not(#principal-dialog)')) return;
    $('extension-grant-summary').textContent = `为已选择的 ${extensionSelected.size} 项 ${extensionTab === 'mcps' ? 'MCP' : 'Skills'} 添加成员授权。`;
    $('extension-grant-agents').innerHTML = extensionChoiceMarkup(extensionsData.agents.filter(agent=>agent.role!=='principal'), [], 'data-grant-agent', agent => roleNames[agent.role] || agent.role);
    openDialog('extension-grant-dialog'); extensionControls();
  }
  async function saveExtensionGrant() {
    const session = dialogSessions.get($('extension-grant-dialog'));
    await mutateExtensions(() => {
      const agentIds = extensionChecked('extension-grant-agents', 'data-grant-agent');
      if (!agentIds.length) throw new Error('请选择至少一位成员。');
      const config = extensionConfiguration();
      config[extensionTab] = config[extensionTab].map(item => extensionSelected.has(item.id) ? { ...item, agentIds: [...new Set([...item.agentIds, ...agentIds])] } : item);
      return config;
    }, () => closeSavedDialog('extension-grant-dialog', session));
  }
  async function toggleExtension(id) {
    await mutateExtensions(() => { const config = extensionConfiguration(); config[extensionTab] = config[extensionTab].map(item => item.id === id ? { ...item, enabled: !item.enabled } : item); return config; });
  }
  function acceptModes(value) {
    if (!value || !Array.isArray(value.items) || !Number.isSafeInteger(value.revision)) throw new Error('模式配置读取失败，请刷新后重试。');
    modesData = value;
    if (state) state.modes = { revision:value.revision, items:value.items.map(({ id, name, builtin }) => ({ id, name, builtin })) };
    renderTaskModeOptions(); renderWorkspaceHistory();
  }
  function modeChoices(kind, selected, readonly) {
    const source = extensionsData?.[kind] || [], items = readonly ? selected.map(id => source.find(item => item.id === id) || { id, name:id + '（已移除）' }) : source;
    return items.length ? items.map(item => `<label class="extension-choice"><input type="checkbox" data-mode-${kind === 'mcps' ? 'mcp' : 'skill'}="${esc(item.id)}"${selected.includes(item.id) ? ' checked' : ''}${readonly ? ' disabled' : ''}><span>${esc(item.name)}</span></label>`).join('') : '<p class="field-note">暂无关联项</p>';
  }
  function openMode(id = '') {
    if (!modesData || !extensionsData || (!id && extensionLocked()) || document.querySelector('dialog[open]:not(#principal-dialog)')) return;
    const item = id ? modesData.items.find(mode => mode.id === id) : null;
    if (id && !item) return;
    modeEditing = { readonly:Boolean(item), revision:modesData.revision, extensionRevision:extensionsData.revision, dataDir:state?.dataDir };
    $('mode-dialog-title').textContent = item ? item.name : '添加模式';
    $('mode-name').value = item?.name || ''; $('mode-name').readOnly = Boolean(item);
    $('mode-prompt').value = item?.prompt || ''; $('mode-prompt').readOnly = Boolean(item);
    $('mode-prompt').placeholder = item?.id === 'auto' ? '自动模式不附加系统提示词。' : '写明适用任务、执行方式与验收要求…';
    $('mode-mcps').innerHTML = modeChoices('mcps', item?.mcps || [], Boolean(item));
    $('mode-skills').innerHTML = modeChoices('skills', item?.skills || [], Boolean(item));
    $('mode-save-actions').hidden = Boolean(item); $('mode-form-note').hidden = Boolean(item);
    openDialog('mode-dialog'); extensionControls();
  }
  async function saveMode() {
    const editing = modeEditing;
    if (!editing || editing.readonly || extensionLocked()) return;
    const session = dialogSessions.get($('mode-dialog'));
    if (editing.dataDir !== state?.dataDir) { toast('数据目录已更改，请关闭后重新添加模式。', true); return; }
    extensionsBusy = true; stateEpoch++; extensionControls();
    try {
      const result = await api('/api/modes', { method:'POST', body:{ revision:editing.revision, extensionRevision:editing.extensionRevision, name:$('mode-name').value.trim(), prompt:$('mode-prompt').value, mcps:extensionChecked('mode-mcps', 'data-mode-mcp'), skills:extensionChecked('mode-skills', 'data-mode-skill') } });
      if (editing.dataDir !== state?.dataDir) return;
      stateEpoch++; acceptModes(result); renderExtensions(); closeSavedDialog('mode-dialog', session); toast('模式已添加，可在课堂中选择使用。');
    } catch (error) { toast(error.message, true); }
    finally { extensionsBusy = false; extensionControls(); }
  }
  function deleteExtension(id = '') {
    if (extensionLocked() || document.querySelector('dialog[open]:not(#principal-dialog)')) return;
    const selected = extensionItems().filter(item => id ? item.id === id : extensionSelected.has(item.id));
    const items = selected.filter(item => !protectedExtension(item));
    if (!items.length) return;
    extensionDeletion = { kind:extensionTab, ids:items.map(item => item.id), revision:extensionTab === 'modes' ? modesData.revision : extensionsData.revision, dataDir:state?.dataDir };
    $('extension-delete-title').textContent = '确认删除';
    $('extension-delete-summary').textContent = `删除以下 ${items.length} 项${extensionTab === 'modes' ? '模式' : extensionTab === 'mcps' ? 'MCP' : 'Skill'}？此操作无法撤销。`;
    $('extension-delete-items').innerHTML = items.map(item => `<li>${esc(item.name)}</li>`).join('');
    $('extension-delete-note').textContent = (selected.length > items.length ? `已勾选的 ${selected.length - items.length} 项内置项目将保留。` : '') + (extensionTab === 'modes' ? '仅删除模式配置，关联的MCP和Skills及历史对话不会删除。' : '同时移除相关授权和模式关联，历史对话保留。');
    openDialog('extension-delete-dialog'); extensionControls();
  }
  async function confirmExtensionDeletion() {
    const deletion = extensionDeletion;
    if (!deletion || extensionLocked()) return;
    const session = dialogSessions.get($('extension-delete-dialog'));
    if (deletion.dataDir !== state?.dataDir) { toast('数据目录已更改，请取消后重新选择。', true); return; }
    extensionsBusy = true; stateEpoch++; extensionControls();
    try {
      const isMode = deletion.kind === 'modes';
      const result = await api(isMode ? '/api/modes' : '/api/extensions', { method:'DELETE', body:{ revision:deletion.revision, ids:deletion.ids, ...(!isMode ? { kind:deletion.kind } : {}) } });
      if (deletion.dataDir !== state?.dataDir) return;
      stateEpoch++;
      if (isMode) acceptModes(result);
      else {
        acceptExtensions(result);
        if (modesData) { const removed = new Set(deletion.ids); modesData = { ...modesData, items:modesData.items.map(mode => ({ ...mode, [deletion.kind]:(mode[deletion.kind] || []).filter(id => !removed.has(id)) })) }; }
      }
      for (const id of deletion.ids) extensionSelected.delete(id);
      renderExtensions(); closeSavedDialog('extension-delete-dialog', session); extensionDeletion = null;
      toast(`已删除 ${deletion.ids.length} 项${isMode ? '模式' : deletion.kind === 'mcps' ? 'MCP' : 'Skill'}。`);
      if (!isMode) {
        try { const modes = await api('/api/modes'); if (deletion.dataDir === state?.dataDir) { acceptModes(modes); renderExtensions(); } }
        catch { toast('项目已删除，模式列表暂未刷新，请稍后点击刷新。', true); }
      }
    } catch (error) { toast(error.message, true); }
    finally { extensionsBusy = false; extensionControls(); }
  }
  // End extension management.
  function renderHistory() {
    const records = state?.history || []; $('history-count').textContent = `${records.length} 次讨论`;
    $('history-content').innerHTML = records.length ? records.map(run=>`<div class="history-row"><div><p class="history-task" title="${esc(run.task)}">${esc(run.title || run.taskSpec?.name || run.task || '未命名任务')}</p><span class="history-id">${esc(run.id)}</span></div><time class="history-date">${esc(pendingSchedule(run) ? describeSchedule(run) : formatDate(run.startedAt))}</time><span class="status-badge ${Object.hasOwn(statusNames,run.status)?run.status:'idle'}">${esc(statusNames[run.status] || run.status)}</span><div class="history-actions"><button class="button secondary" data-run-view="${esc(run.id)}">查看详情</button>${run.recoverable === true ? `<button class="button secondary" data-run-resume="${esc(run.id)}">继续任务</button>` : ''}</div></div>`).join('') : `<div class="large-empty">${icon('clock')}<h3>还没有讨论记录</h3><p>每次讨论的黑板与结果都会保留在本地。</p><button class="button secondary" data-go-workspace>开始第一次讨论</button></div>`;

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
  const memoryRoles = {user:'用户',teacher:'老师',student:'学生',principal:'校长',assistant:'助手',system:'系统',tool:'工具'};
  const memoryViews = {entries:{offset:0,nextOffset:null,total:0,loading:false,request:0,loaded:false}};
  let memoryStatus = null, memoryStatusRequest = 0, memoryStatusLoading = false, memoryLastStatus = 0;
  let memoryBusy = false, memorySettingsDirty = false, memoryContext = null, memoryContextRequest = 0, memoryDataDir = '';
  let memoryRequestedJob = null, memoryClearing = false;
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
    $('memory-clear').disabled=locked||!memoryStatus||memoryStatus.available===false;
    $('memory-clear').setAttribute('aria-busy',String(memoryClearing));
    $('memory-clear').title=memoryClearing?'正在清空长期记忆…':'清空长期记忆';
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
  async function clearLongTermMemory() {
    if(memoryBusy||$('memory-clear').disabled)return;
    if(!confirm('清空所有长期记忆？包含全部类型和状态，不受当前筛选影响。\n原始会话记录会保留，后续新会话仍可生成新记忆。此操作无法撤销。'))return;
    await memoryAction(async()=>{
      memoryClearing=true;memoryControls();
      try{
        await api('/api/memory/entries',{method:'DELETE'});
        // Ignore responses started before the clear, then reload from page one.
        memoryStatusRequest++;memoryRequestedJob=null;
        const view=memoryViews.entries;view.request++;view.offset=0;view.nextOffset=null;view.loaded=false;
        if(memoryStatus)memoryStatus={...memoryStatus,memories:0};
        memoryRenderStatus();await loadMemoryEntries();
        toast('所有长期记忆已清空，原始会话记录已保留。');
      }finally{memoryClearing=false;memoryControls();}
    });
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
    if(!id||document.querySelector('dialog[open]:not(#principal-dialog)'))return;
    let entry;
    try{const result=await api('/api/memory/entries/'+encodeURIComponent(id));entry=result.entry||result;}
    catch(error){toast(error.message,true);return;}
    if(document.querySelector('dialog[open]:not(#principal-dialog)'))return;
    $('memory-edit-id').value=entry.id||'';
    for(const key of ['kind','category','status','content'])$('memory-edit-'+key).value=key==='status'?memoryEntryStatus(entry.status):(entry[key]||'');
    memoryUpdateOptions();
    if(entry.agentId&&![...$('memory-edit-agent').options].some(option=>option.value===entry.agentId))$('memory-edit-agent').add(new Option(entry.agentId+'（历史成员）',entry.agentId));
    $('memory-edit-agent').value=entry.agentId||'';$('memory-edit-sources').value=(entry.sourceRefs||[]).join('\n');$('memory-edit-expires').value=memoryLocalDate(entry.expiresAt);
    openDialog('memory-entry-dialog',trigger);
  }
  async function openMemorySession(sessionId,reference='',trigger=document.activeElement) {
    if((!sessionId&&!reference)||document.querySelector('dialog[open]:not(#principal-dialog)'))return;
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
    if (principalView && (!principalCurrent(principalView) || !conversationRecord(principalView.runId))) closePrincipalView();
    fillSettings(); fillDataDirectory(); fillTaskInput(); renderStorageNotices(); renderRun(); renderTeam(); renderJudgeStats(); renderWorkspaceHistory();
    const nextAgents=JSON.stringify(state?.agents), nextHistory=JSON.stringify(state?.history);
    if(nextAgents!==agentsStamp){agentsStamp=nextAgents;renderAgents();}
    if(nextHistory!==historyStamp){historyStamp=nextHistory;renderHistory();}
    updateControls();
    memoryRender();
  }
  async function refresh() {
    if (!token || shutdown || shuttingDown || refreshPending || dataDirectorySaving || clearingRunId || pendingMemberRetries.size) return;
    refreshPending=true; const epoch=stateEpoch, selectionRequest=viewingRequest, selectedBefore=selectedRun(); let restoredAttachments = !state;
    try {
      const current=()=>!shutdown&&!shuttingDown&&epoch===stateEpoch;
      const nextState=await api('/api/state',{isCurrent:current}); if(!current())return;
      // A saved draft belongs to its data directory, never to a different profile.
      if (!state && selectionRequest === viewingRequest) {
        if (savedWorkspaceView) {
          const sameDirectory = savedWorkspaceView.dataDir === nextState.dataDir;
          draftTask = sameDirectory ? savedWorkspaceView.draftTask : '';
          const savedSpec = sameDirectory ? savedWorkspaceView.draftTaskSpec : null;
          draftTaskSpec = savedSpec && typeof savedSpec === 'object' ? {enabled:savedSpec.enabled === true,name:typeof savedSpec.name === 'string' ? savedSpec.name : '',goal:typeof savedSpec.goal === 'string' ? savedSpec.goal : '',scheduled:savedSpec.enabled === true && savedSpec.scheduled === true,at:typeof savedSpec.at === 'string' ? savedSpec.at : ''} : emptyTaskSpec();
          sideDrafts.clear();
          if (sameDirectory && Array.isArray(savedWorkspaceView.sideDrafts)) for (const item of savedWorkspaceView.sideDrafts.slice(-30)) if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') sideDrafts.set(item[0],item[1]);
          restoreDraftAttachments(sameDirectory ? savedWorkspaceView.draftAttachments : []);
          draftMode = sameDirectory && savedWorkspaceView.draftMode === true;
          savedViewingRunId = sameDirectory && !draftMode && typeof savedWorkspaceView.runId === 'string' ? savedWorkspaceView.runId : '';
        }
        if (!draftMode && savedViewingRunId && savedViewingRunId !== nextState.run?.id && nextState.history?.some(run=>run.id===savedViewingRunId)) {
          const restoring = () => current() && selectionRequest === viewingRequest;
          const record=await api('/api/runs/'+encodeURIComponent(savedViewingRunId),{isCurrent:restoring});
          if(!current())return;
          if(restoring())viewingRun=record.run || record;
        }
        if (!viewingRun && !nextState.run) draftMode = true;
      } else if (state && state.dataDir !== nextState.dataDir) {
        draftMode = !nextState.run; draftTask = ''; draftTaskMode = 'auto'; draftTaskSpec = emptyTaskSpec(); scheduledEditing = null; viewingRun = null;
        attachmentGeneration++; draftAttachments = []; checkingAttachments = false; closeConversationMenu();
        sideDrafts.clear(); closePrincipalView();
        restoredAttachments = true;
        taskInputRunId = null; taskInputDirty = false; savedWorkspaceView = null;
        extensionsRequest++; extensionsLoading = false; extensionsData = null; modesData = null; extensionSelected.clear(); modeEditing = null; extensionDeletion = null;
        for (const id of ['extension-dialog', 'extension-grant-dialog', 'extension-delete-dialog', 'mode-dialog','schedule-edit-dialog']) if ($(id).open) $(id).close();
        rememberViewingRun();
      }
      if (state?.dataDir === nextState.dataDir && selectedBefore && !draftMode && selectionRequest === viewingRequest) {
        const newest = runFromState(selectedBefore.id,nextState), summary = nextState.history?.find(run => run.id === selectedBefore.id);
        if (newest) viewingRun = newest;
        else if (summary && (activeRun(selectedBefore) || pendingSchedule(selectedBefore) || summary.status !== selectedBefore.status)) {
          const record = await api('/api/runs/'+encodeURIComponent(selectedBefore.id),{isCurrent:() => current() && selectionRequest === viewingRequest});
          if (!current()) return;
          if (selectionRequest === viewingRequest) viewingRun = record.run || record;
        } else if (summary) viewingRun = selectedBefore;
      }
      state=nextState;
      acceptUpdateSnapshot(state.update);
      if (shuttingDown) return;
      savedWorkspaceView = null;
      if(viewingRun && !runFromState(viewingRun.id) && !state.history?.some(run=>run.id===viewingRun.id)){viewingRun=null;draftMode=true;rememberViewingRun();fillTaskInput(true);}
      if (!draftMode && !selectedRun()) { draftMode = true; fillTaskInput(true); }
      persistWorkspaceView();
      setConnection(true); $('access-notice').hidden=true; $('reconnect-button').hidden=true; render();
      if (page === 'extensions' && !extensionsData) loadExtensions();
      if (restoredAttachments) await validateDraftAttachments();
    }
    catch(error){ if(shutdown||shuttingDown||epoch!==stateEpoch)return; setConnection(false); if(!state && $('access-notice').hidden) showAccess('暂时无法连接本地服务',error.message + '。如果服务已退出，请重新启动 Class。'); $('reconnect-button').hidden=false; updateControls(); }
    finally { refreshPending=false; }
  }
  async function action(work) {
    if(busy)return; busy=true;updateControls();
    try{await work();await refresh();}catch(error){toast(error.message,true);}finally{busy=false;updateControls();}
  }
  async function resumeRun(id) {
    if (!id || busy || shutdown || shuttingDown || !lastConnection || !token || dataDirectorySaving || state?.relocating) return;
    if (conversationRecord(id)?.status === 'paused') { await controlRun('resume',id); return; }
    const source = selectedRun()?.id === id ? selectedRun() : state?.history?.find(run => run.id === id);
    if (source?.recoverable !== true) return;
    await action(async () => {
      const result = await api(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} });
      if (result.run?.id !== id) throw new Error('服务未返回任务恢复状态，请刷新后检查。');
      stateEpoch++; acceptRun(result.run,true); draftMode = false; rememberViewingRun(id); fillTaskInput(true); navigate('workspace'); render(); toast('任务已从保存的进度继续。');
    });
  }
  async function retryMember(memberId) {
    const run = selectedRun(), failure = memberFailures(run).find(item=>item.studentId===memberId);
    if (!retryAllowed(run,failure) || pendingMemberRetries.size || busy || clearingRunId || shutdown || shuttingDown || !lastConnection || !token) return;
    const key = retryKey(run.id,memberId), epoch = ++stateEpoch;
    const current = () => epoch === stateEpoch && activeRuns().some(item => item.id === run.id) && !clearingRunId && !shutdown && !shuttingDown;
    pendingMemberRetries.add(key); renderMemberRecovery(run); updateControls();
    try {
      const result = await api(`/api/runs/${encodeURIComponent(run.id)}/members/${encodeURIComponent(memberId)}/retry`,{method:'POST',body:{},isCurrent:current});
      if (!current()) return;
      if (result.run?.id !== run.id) throw new Error('服务未返回当前任务的恢复状态，请刷新后检查。');
      stateEpoch++; acceptRun(result.run);
      if (viewingRun?.id === run.id) viewingRun = result.run;
      toast('已请求重试该成员，继续同一次任务。');
    } catch (error) { if (current()) toast(error.message,true); }
    finally { pendingMemberRetries.delete(key); render(); await refresh(); }
  }
  async function clearSelectedTask() { if (!$('clear-task-button').disabled) await deleteConversation(selectedRun()?.id); }
  async function deleteConversation(id) {
    const run = conversationRecord(id);
    if (!run?.id || busy || clearingRunId || directoryPickerPending || dataDirectorySaving || state?.relocating || shutdown || shuttingDown || !lastConnection || !token) return;
    closeConversationMenu();
    if (!confirm((activeRun(run) ? '这个任务仍在运行。停止并删除此对话、原始讨论记录及关联记忆？' : '删除此对话、原始讨论记录及关联记忆？')+'此操作无法撤销。')) return;
    if (principalView?.runId === id) closePrincipalView();
    const selectedWasDeleted = selectedRun()?.id === id, dataDir = state.dataDir;
    busy = true; clearingRunId = run.id;
    // State reads issued before deletion must never restore the deleted task.
    stateEpoch++; renderRun(); updateControls();
    try {
      const result = await api('/api/runs/' + encodeURIComponent(run.id),{method:'DELETE'});
      if (state?.dataDir !== dataDir) return;
      if (result.ok !== true || result.deletedId !== run.id || !Object.hasOwn(result,'run') || !Array.isArray(result.history)) throw new Error('服务未确认任务已清除，请刷新后检查。');
      stateEpoch++; state = {...state,...result};
      if (Array.isArray(state.runs)) state.runs = state.runs.filter(item => item.id !== id);
      sideDrafts.delete(id);
      if (selectedWasDeleted) { draftMode = true; viewingRun = null; rememberViewingRun(); fillTaskInput(true); $('blackboard-content').dataset.runId=''; }
      boardViews.delete(run.id); persistBoard();
      // Discard evidence pages and invalidate a response from an earlier dialog.
      if (selectedWasDeleted || evidenceState?.runId === id) {
      evidenceRequest++; evidenceState = null;
      evidenceReturnLogsRunId='';$('evidence-return-logs').hidden=true;
      $('evidence-content').innerHTML = '<p class="empty-small">请选择运行档案查看记录。</p>';
      $('evidence-page').textContent = ''; $('evidence-reference').value = ''; $('evidence-kind').value = '';
      $('evidence-member').innerHTML = '<option value="">所有成员</option>';
      $('evidence-error').textContent = ''; $('evidence-error').hidden = true; $('evidence-retry').hidden = true;
      $('evidence-warning').textContent = ''; $('evidence-warning').hidden = true;
      evidenceControls(); }
      setConnection(true);
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
    const dialog = $(id); if (document.querySelector('dialog[open]:not(#principal-dialog)')) return;
    dialogReturnFocus.set(dialog,trigger);
    dialogSessions.set(dialog,{});
    dialog.querySelector('.dialog-feedback')?.remove();
    if (id === 'settings-dialog') fillSettings();
    if (id === 'answer-dialog') renderResult(selectedRun());
    dialog.showModal();
  }
  document.querySelectorAll('dialog').forEach(dialog => {
    // Escape/backdrop cannot dismiss a modal. Explicit log/evidence navigation is allowed.
    dialog.addEventListener('cancel',event => { event.preventDefault(); if (dialog.id === 'principal-dialog') closePrincipalView(); });
    dialog.addEventListener('keydown',event => {
      // Keep Enter in an input from implicitly clicking Save; button keyboard activation still works.
      if (event.key === 'Enter' && !event.isComposing && event.target.matches('input')) event.preventDefault();
    });
    // Restore a visible launch target after an explicit close.
    dialog.addEventListener('close',() => {
      dialog.querySelector('.dialog-feedback')?.remove();
      if (document.querySelector('dialog[open]:not(#principal-dialog)')) return;
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
    if (document.querySelector('dialog[open]:not(#principal-dialog)')) return;
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
    if (conversationMenuId && !event.target.closest('#conversation-menu') && !event.target.closest('[data-run-menu]')) closeConversationMenu();
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.hasAttribute('data-dialog-close')){event.preventDefault();const dialog=button.closest('dialog');if(dialog?.id==='principal-dialog')closePrincipalView();else dialog?.close();}
    else if(button.hasAttribute('data-go-agents'))navigate('agents');
    else if(button.hasAttribute('data-go-workspace'))newConversation();
    else if(button.hasAttribute('data-add-agent'))openAgent(null,button.dataset.addAgent||undefined);
    else if(button.hasAttribute('data-evidence-reference'))openEvidence(button.dataset.evidenceReference,button);
    else if(button.hasAttribute('data-log-evidence'))openLogEvidence(button.dataset.logEvidence,button);
    else if(button.hasAttribute('data-full-content-reference'))openEvidence(button.dataset.fullContentReference,button);
    else if(button.hasAttribute('data-board-jump')){const target=$('blackboard-content'),entry=[...target.querySelectorAll('[data-board-entry]')].find(node=>node.dataset.boardEntry===button.dataset.boardJump);if(entry){target.scrollTop+=entry.getBoundingClientRect().top-target.getBoundingClientRect().top-12;rememberBoard();}}
    else if(button.hasAttribute('data-member-retry'))retryMember(button.dataset.memberRetry);
    else if(button.hasAttribute('data-run-resume'))resumeRun(button.dataset.runResume);
    else if(button.hasAttribute('data-output-reference')){if(evidenceState&&!evidenceState.loading){evidenceState.outputReference=button.dataset.outputReference;loadEvidence();}}
    else if(button.dataset.agentEdit)openAgent(button.dataset.agentEdit);
    else if(button.dataset.agentDelete){const id=button.dataset.agentDelete;if(confirm(`移除“${personName(id)}”？已有讨论记录会保留。`))action(async()=>{await api('/api/agents/'+encodeURIComponent(id),{method:'DELETE'});toast('成员已移除。');});}
    else if(button.dataset.agentCheck){const id=button.dataset.agentCheck;pendingChecks.add(id);renderAgents();updateControls();api('/api/agents/'+encodeURIComponent(id)+'/check',{method:'POST',body:{}}).then(result=>{if(result?.ok===false)throw Error(result.error||result.message||'连接测试失败');toast(result.message||'连接成功，模型接口已响应。');}).catch(error=>toast(error.message,true)).finally(()=>{pendingChecks.delete(id);renderAgents();updateControls();});}
    else if(button.dataset.runMenu)openConversationMenu(button.dataset.runMenu,button);
    else if(button.dataset.conversationAction)conversationMenuAction(button.dataset.conversationAction);
    else if(button.dataset.attachmentRemove)removeDraftAttachment(button.dataset.attachmentRemove);
    else if(button.dataset.runView)viewConversation(button.dataset.runView);
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
    if(directoryPickerPending||busy||!lastConnection||!token||shutdown||shuttingDown)return;
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
  $('judge-settings-button').addEventListener('click',openJudgeSettings);
  $('judge-settings-form').addEventListener('submit',event=>{event.preventDefault();saveJudgeSettings();});
  $('judge-check').addEventListener('click',checkJudgeConnection);
  $('judge-enable').addEventListener('click',()=>{setJudgeEnabled(true);updateControls();});
  $('judge-disable').addEventListener('click',()=>{setJudgeEnabled(false);updateControls();});
  $('judge-settings-form').addEventListener('input',()=>{judgeStatus();updateControls();});
  $('judge-settings-dialog').addEventListener('close',()=>{judgeCheckController?.abort();$('judge-key').value='';});
  $('workspace-new-conversation').addEventListener('click',newConversation);
  $('workspace-return-active').addEventListener('click',()=>viewConversation(activeRuns().find(run => run.id !== selectedRun()?.id)?.id));
  $('task-input').addEventListener('input',()=>{taskInputDirty=true;rememberDraft();resizeTaskInput();updateControls();});
  $('task-description').addEventListener('input',()=>{if(!draftMode || $('task-description').disabled)return;$('task-input').value=$('task-description').value;taskInputDirty=true;rememberDraft();updateControls();});
  $('task-input').addEventListener('keydown',event=>{
    if(event.key !== 'Enter' || event.isComposing || event.shiftKey || draftMode && draftTaskSpec.enabled)return;
    const question=btwQuestion($('task-input').value);if(question===null)return;
    event.preventDefault();submitBtw(question);
  });
  $('task-mode').addEventListener('change',()=>{if(draftMode && !$('task-mode').disabled)draftTaskMode=taskModeValue($('task-mode').value);updateControls();});
  $('task-kind').addEventListener('change',()=>{if(!draftMode || $('task-kind').disabled)return;draftTaskSpec.enabled=$('task-kind').checked;if(!draftTaskSpec.enabled)draftTaskSpec.scheduled=false;persistWorkspaceView();updateControls();});
  $('task-schedule').addEventListener('change',()=>{if(!draftMode || $('task-schedule').disabled)return;draftTaskSpec.scheduled=$('task-schedule').checked;persistWorkspaceView();updateControls();});
  for (const [id,key] of [['task-name','name'],['task-goal','goal'],['task-schedule-at','at']]) $(id).addEventListener('input',()=>{if(draftMode){draftTaskSpec[key]=$(id).value;persistWorkspaceView();}});
  $('scheduled-edit').addEventListener('click',openScheduledTask);
  $('scheduled-start').addEventListener('click',()=>controlRun('start'));
  $('scheduled-cancel').addEventListener('click',()=>controlRun('cancel'));
  $('schedule-edit-form').addEventListener('submit',event=>{event.preventDefault();saveScheduledTask();});
  $('pause-button').addEventListener('click',()=>controlRun('pause'));
  $('principal-button').addEventListener('click',()=>openPrincipalReport());
  $('principal-form').addEventListener('submit',event=>{event.preventDefault();sendPrincipalQuestion();});
  $('principal-cancel').addEventListener('click',cancelPrincipalReport);
  $('principal-dialog').addEventListener('close',()=>{if(!$('principal-dialog').open)closePrincipalView();});
  $('attachment-button').addEventListener('click',()=>{if(!$('attachment-button').disabled && draftMode)$('task-files').click();});
  $('task-files').addEventListener('change',()=>{const files=[...$('task-files').files];$('task-files').value='';uploadTaskFiles(files);});
  if (typeof ResizeObserver === 'function') {
    const taskInputObserver = new ResizeObserver(entries=>{
      const width=entries[0]?.contentRect.width;
      // Sidebar and container-query layout can settle after the window resize event.
      // Height-only notifications must not create an autosize feedback loop.
      if (typeof width!=='number' || Math.abs(width-taskResizeWidth)<0.5) return;
      taskResizeWidth=width;scheduleTaskInputResize();
    });
    taskInputObserver.observe($('task-input'));
  }
  window.addEventListener('resize',()=>{scheduleTaskInputResize();resizeExtensionInputs();closeConversationMenu();});
  $('workspace-history-content').addEventListener('click',event=>{
    const toggle = event.target.closest('[data-history-mode]');
    if (!toggle) return;
    const mode = toggle.dataset.historyMode;
    if (!historyTaskModes([...(state?.history || []), ...activeRuns(), ...(state?.run ? [state.run] : [])]).some(item=>item.value===mode)) return;
    if (collapsedHistoryModes.has(mode)) collapsedHistoryModes.delete(mode);
    else collapsedHistoryModes.add(mode);
    renderWorkspaceHistory(); updateControls();
    $('workspace-history-content').querySelector(`[data-history-mode="${mode}"]`)?.focus({preventScroll:true});
  });
  $('workspace-history-content').addEventListener('scroll',()=>closeConversationMenu(),true);
  document.addEventListener('keydown',event=>{
    if (!conversationMenuId) return;
    if (event.key === 'Escape' || event.key === 'Tab') { closeConversationMenu(event.key === 'Escape'); return; }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const buttons=[...$('conversation-menu').querySelectorAll('button:not([hidden])')], index=buttons.indexOf(document.activeElement);
      buttons[event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : (index+(event.key==='ArrowDown' ? 1 : buttons.length-1))%buttons.length]?.focus();
    }
  });
  $('task-form').addEventListener('submit',event=>{
    event.preventDefault();
    const sideQuestion = draftMode && draftTaskSpec.enabled ? null : btwQuestion($('task-input').value);
    if(sideQuestion !== null){submitBtw(sideQuestion);return;}
    if(!draftMode){toast('这里仅接收 /btw 校长提问；要布置新任务，请点击“新建对话”。',true);return;}
    if(busy || viewingLoading || directoryPickerPending || dataDirectorySaving || state?.relocating || shutdown || shuttingDown || !lastConnection || !token)return;
    if(attachmentsBusy() || draftAttachments.some(item=>item.status!=='ready')){toast('请等待附件上传完成，或移除上传失败的附件后重试。',true);return;}
    if(!teamReady()){navigate('agents');toast('请先配置 1 位老师和至少 2 位学生。',true);return;}
    if(settingsDirty){openDialog('settings-dialog',$('settings-button'));toast('运行设置尚未保存，请先保存设置。',true);return;}
    const task=$('task-input').value.trim(), attachmentIds=draftAttachments.map(item=>item.id), taskMode=draftTaskMode, dataDir=state.dataDir;
    let body={task,attachmentIds,taskMode};
    if(draftTaskSpec.enabled){
      const taskSpec={name:draftTaskSpec.name.trim(),description:task,goal:draftTaskSpec.goal.trim()};
      if(Object.values(taskSpec).some(value=>!value)){toast('请填写任务名称、描述和目标。',true);return;}
      body={taskSpec,attachmentIds,taskMode};
      try{if(draftTaskSpec.scheduled)body.schedule=scheduleValue(draftTaskSpec.at);}catch(error){toast(error.message,true);return;}
    }else if(!task){toast('请填写讨论内容。',true);return;}
    action(async()=>{
      dispatchingTask=true;renderRun();
      const result=await api('/api/runs',{method:'POST',body});
      if(state?.dataDir!==dataDir)return;
      if(!result.run?.id)throw new Error('服务未确认任务已创建，请刷新后检查。');
      stateEpoch++;acceptRun(result.run,true);draftMode=false;draftTask='';draftTaskMode='auto';draftTaskSpec=emptyTaskSpec();draftAttachments=[];attachmentGeneration++;rememberViewingRun(result.run.id);fillTaskInput(true);renderTaskAttachments();
      toast(result.run.status==='scheduled'?'定时任务已保存，将在指定时间执行一次。':'讨论已开始，所有学生正在独立求解。');
    }).finally(()=>{dispatchingTask=false;renderRun();});
  });
  $('start-button').addEventListener('click',event=>{
    if($('start-button').dataset.action!=='stop')return;
    event.preventDefault();if(!$('start-button').disabled)stopRun(selectedRun()?.id);
  });
  $('clear-task-button').addEventListener('click',clearSelectedTask);

  $('shutdown-button').addEventListener('click',()=>{if(!confirm(live()?'当前任务仍在执行。退出服务将停止任务，是否继续？':'退出 Class 本地服务？下次启动 Class 即可重新打开。'))return;action(async()=>{
    closePrincipalView();
    const reply=await api('/api/shutdown',{method:'POST',body:{}});
    shutdown=true;shuttingDown=false;clearInterval(pollTimer);
    // This closes the workspace on the server's cleanup ACK, not on a process-exit probe.
    if(reply.readyToExit){$('access-notice').hidden=true;setConnection(false);updateControls();}
    else showAccess('退出请求已发送','当前服务尚未确认任务停止与记录保存。本页面已停止交互，请稍候再关闭；此次未确认系统进程退出。');
    $('reconnect-button').hidden=true;
  });});
  $('memory-refresh').addEventListener('click',()=>refreshMemory(true));
  $('memory-clear').addEventListener('click',clearLongTermMemory);
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
  $('resume-button').addEventListener('click',()=>resumeRun(selectedRun()?.id));
  $('extensions-refresh').addEventListener('click',loadExtensions);
  $('extension-add').addEventListener('click',()=>openExtension());
  $('extensions-grant').addEventListener('click',openExtensionGrant);
  $('extensions-delete').addEventListener('click',()=>deleteExtension());
  $('extension-delete-confirm').addEventListener('click',confirmExtensionDeletion);
  $('extension-delete-dialog').addEventListener('close',()=>{extensionDeletion=null;});
  $('mode-form').addEventListener('submit',event=>{event.preventDefault();saveMode();});
  $('mode-dialog').addEventListener('close',()=>{modeEditing=null;});
  $('extension-transport').addEventListener('change',extensionTransportVisibility);
  document.querySelectorAll('[data-extension-transport]').forEach(button => {
    button.addEventListener('click',()=>chooseExtensionTransport(button.dataset.extensionTransport));
    button.addEventListener('keydown',event=>{
      const modes=['stdio','http','sse'],index=modes.indexOf(button.dataset.extensionTransport);
      const next=event.key==='Home'?0:event.key==='End'?2:['ArrowRight','ArrowDown'].includes(event.key)?(index+1)%3:['ArrowLeft','ArrowUp'].includes(event.key)?(index+2)%3:-1;
      if(next<0)return;event.preventDefault();chooseExtensionTransport(modes[next],true);
    });
  });
  for (const id of ['extension-args', 'extension-env', 'extension-headers']) $(id).addEventListener('input',resizeExtensionInputs);
  $('extension-form').addEventListener('submit',event=>{event.preventDefault();saveExtension();});
  $('extension-grant-form').addEventListener('submit',event=>{event.preventDefault();saveExtensionGrant();});
  $('extension-dialog').addEventListener('close',()=>{extensionEditing=null;$('extension-env').value='';$('extension-headers').value='';});
  $('extensions-select-all').addEventListener('change',()=>{extensionSelected.clear();if($('extensions-select-all').checked)for(const item of extensionItems())extensionSelected.add(item.id);renderExtensions();});
  $('extensions-content').addEventListener('change',event=>{const id=event.target.dataset.extensionSelect;if(id){event.target.checked?extensionSelected.add(id):extensionSelected.delete(id);renderExtensions();}});
  document.querySelectorAll('[data-extension-tab]').forEach(button=>button.addEventListener('click',()=>{extensionTab=button.dataset.extensionTab;extensionSelected.clear();renderExtensions();}));
  $('extensions-content').addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.hasAttribute('data-mode-view'))openMode(button.dataset.modeView);else if(button.hasAttribute('data-extension-guide'))openExtensionGuide(button.dataset.extensionGuide);else if(button.hasAttribute('data-extension-test'))testExtensionConnection(button.dataset.extensionTest);else if(button.hasAttribute('data-extension-edit'))openExtension(button.dataset.extensionEdit);else if(button.hasAttribute('data-extension-toggle'))toggleExtension(button.dataset.extensionToggle);else if(button.hasAttribute('data-extension-delete'))deleteExtension(button.dataset.extensionDelete);});
  $('reconnect-button').addEventListener('click',refresh);
  $('update-button').addEventListener('click',requestUpdate);
  if(!token){showAccess('请从桌面程序打开工作空间','启动 Class，程序会启动本地服务并自动打开已连接的页面。当前页面缺少本地连接凭据。');}
  else{updateControls();refresh();pollTimer=setInterval(refresh,1200);}
})();
