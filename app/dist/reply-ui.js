// Reply UI 1.6.1 — original implementation inspired by documented card-flow UX.
// No cc-haha code/assets copied. File changes and usage metrics stay in the existing UI.
export function localImageUrl(value, sessionId) {
  if (typeof value !== 'string' || !sessionId || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return '';
  let path = value.trim();
  // Markdown URL parser percent-encodes Unicode and spaces; decode exactly once before routing.
  if (!/^file:/i.test(path)) { try { path = decodeURIComponent(path); } catch { return ''; } }
  if (/^file:/i.test(path)) {
    try { const url = new URL(path); if (url.hostname && url.hostname !== 'localhost' || url.username || url.password) return ''; path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1'); } catch { return ''; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return '';
  if (path.startsWith('//') || path.startsWith('\\\\') || path.startsWith('~/')) return '';
  path = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.split('/').includes('..')) return '';
  return `/api/workspace/file-content?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`;
}

export function groupTools(tools) {
  const groups = [];
  for (const tool of tools || []) {
    const kind = toolKind(tool.name), previous = groups.at(-1);
    // Only adjacent same-kind calls collapse. Approval/question calls always stay actionable.
    if (previous && previous.kind === kind && kind !== 'question' && !tool.approvalId && !previous.items.some(t => t.approvalId)) previous.items.push(tool);
    else groups.push({ kind, items: [tool] });
  }
  return groups;
}
function toolKind(name = '') {
  if (name === 'ask_user') return 'question';
  if (name === 'update_tasks') return 'tasks';
  if (name === 'spawn_subagent') return 'agent';
  if (name === 'read_file' || /^ext_(read|pdf_inspect)/.test(name)) return 'read';
  if (name === 'write_file') return 'edit';
  if (name === 'list_directory' || name === 'web_search') return 'search';
  if (name === 'run_command') return 'command';
  if (/^browser_/.test(name) || name === 'fetch_url') return 'browser';
  if (name === 'download_file') return 'download';
  return name;
}
const LABELS = { read:['读取','个文件'], edit:['编辑','个文件'], search:['搜索','次'], command:['执行命令','次'], browser:['浏览网页','次'], download:['下载','个文件'], agent:['子代理','个'], tasks:['更新任务','次'] };
export function buildReplyFlow(message) {
  const text = message.text || '', reasoning = message.reasoning || '', tools = message.tools || [];
  const flow = [];
  // Older stored messages have no ordering metadata: keep every byte, avoid inventing order.
  if (!tools.length || tools.some(t => !Number.isInteger(t.textOffset) || !Number.isInteger(t.reasoningOffset))) {
    if (reasoning) flow.push({type:'reasoning',text:reasoning});
    if (text) flow.push({type:'text',text});
    if (tools.length) flow.push({type:'tools',tools});
    return flow;
  }
  let p = 0, r = 0, pending = [];
  for (const tool of tools) {
    const end = Math.max(p, Math.min(text.length, tool.textOffset));
    const rend = Math.max(r, Math.min(reasoning.length, tool.reasoningOffset));
    if ((end > p || rend > r) && pending.length) { flow.push({type:'tools',tools:pending}); pending = []; }
    if (rend > r) flow.push({type:'reasoning',text:reasoning.slice(r,rend)});
    if (end > p) flow.push({type:'text',text:text.slice(p,end)});
    pending.push(tool); p = end; r = rend;
  }
  if (pending.length) flow.push({type:'tools',tools:pending});
  if (reasoning.length > r) flow.push({type:'reasoning',text:reasoning.slice(r)});
  if (text.length > p) flow.push({type:'text',text:text.slice(p)});
  return flow;
}

export function createReplyUI(React, { Markdown, Tool, Artifact, Subagent, copyImage, downloadUrl, safeImage }) {
  const h = React.createElement;
  const status = (tool, active) => !active && ['pending','running'].includes(tool.status) ? 'cancelled' : tool.status;
  function Reasoning({text,running}) {
    // 1.6.3: live thinking opens by itself, follows the newest line, and folds once it is done.
    const [open,setOpen] = React.useState(!!running), body = React.useRef(null), stick = React.useRef(true);
    React.useEffect(()=>{
      stick.current = true;
      setOpen(!!running);
      // 1.6.5: folding takes hundreds of pixels away in one frame. The chat column is told, so the
      // scroll clamp that follows is not read as the reader scrolling up and turning the follow off.
      window.dispatchEvent(new CustomEvent('reply-layout-fold'));
    },[running]);
    React.useEffect(()=>{
      const el = body.current;
      if (!el || !open) return;
      if (running && (stick.current || el.scrollHeight - el.scrollTop - el.clientHeight < 48)) el.scrollTop = el.scrollHeight;
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    },[text,open,running]);
    if (!text) return null;
    return h('section',{className:`reasoning-block reply-reasoning ${open?'open':''} ${running?'live':''}`},
      h('button',{type:'button',className:'reasoning-toggle',onClick:()=>setOpen(!open),'aria-expanded':open},h('span',{className:running?'reply-spinner':'reply-check'},running?'◌':'✓'),h('span',{className:'reasoning-label'},running?'思考中':'已思考'),h('span',{className:'reply-chevron'},open?'⌄':'›')),
      open && h('div',{className:'reasoning-body',ref:body,tabIndex:0},text));
  }
  function Question({question,sessionId,active,onToast}) {
    const [answer,setAnswer] = React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[confirmed,setConfirmed]=React.useState(null);
    const live = question.status === 'pending' && active && !confirmed;
    async function submit(e) {
      e.preventDefault(); if (!live || busy || !answer.trim()) return;
      setBusy(true); setError('');
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(question.id)}/answer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answer})});
        const data = await response.json(); if (!response.ok || !data.accepted) throw Error(data.error || '回答未提交，请重试。');
        // Only server acknowledgment, never a filled input, is a submitted answer.
        setConfirmed(data.question);
      } catch (e) { setError(e.message); onToast?.(e.message,'error'); } finally { setBusy(false); }
    }
    const final = confirmed || question;
    return h('section',{className:`reply-question ${live?'pending':'settled'}`,'aria-label':'需要你的回答'},
      h('div',{className:'reply-question-caption'},live?'⚠ 需要你的回答':final.status==='done'?'✓ 已回答':'提问已中断'),h('strong',null,question.question),
      live ? h('form',{onSubmit:submit},question.options?.length>0 && h('div',{className:'reply-options'},question.options.map((option,i)=>h('button',{key:i,type:'button',className:answer===option?'selected':'',disabled:busy,'aria-pressed':answer===option,onClick:()=>setAnswer(option)},option))),
        h('label',null,'你的回答',h('textarea',{value:answer,maxLength:4000,disabled:busy,onChange:e=>setAnswer(e.target.value),placeholder:'选择上方选项，或输入其他答案',rows:2})),
        h('button',{type:'submit',className:'button button-approve small-button',disabled:busy || !answer.trim()},busy?'正在提交…':'提交回答'),h('small',null,'选择后需手动提交；回答不会批准其他工具操作。')) : h('p',{className:'reply-answer'},final.status==='done'?final.answer || '答案已保存':'已停止或断线，请重新发送消息。'),
      error && h('p',{role:'alert',className:'reply-inline-error'},error));
  }
  function Thumbnails({tools,sessionId,onPreview,onToast}) {
    const seen = new Set(), candidates=[];
    function add(value) {
      if (typeof value !== 'string' || value.length>4096 || !/\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.test(value) && !value.startsWith('/api/artifacts/')) return;
      const url = safeImage(value) || localImageUrl(value,sessionId);
      if (url && !seen.has(url)) { seen.add(url); candidates.push({url,name:value.split(/[\\/]/).at(-1),path:value,sessionId}); }
    }
    function visit(value,depth=0) {
      if (depth>5 || !value || typeof value!=='object') return;
      if (Array.isArray(value)) { value.slice(0,8).forEach(v=>visit(v,depth+1)); return; }
      for (const [key,v] of Object.entries(value)) {
        if (['path','imagePath','screenshotPath','previewUrl','url'].includes(key)) add(v);
        if (typeof v==='object') visit(v,depth+1);
      }
    }
    for (const tool of tools) if (tool.status==='done') {
      if (/^(read_file|ext_read|ext_pdf|browser_screenshot)/.test(tool.name)) {
        add(tool.args?.path); try { visit(typeof tool.output==='string'?JSON.parse(tool.output):tool.output); } catch {}
      }
    }
    return candidates.length ? h('div',{className:'reply-tool-thumbnails'},candidates.slice(0,6).map(image=>h(Artifact,{key:image.url,artifact:image,onPreview,onToast,compact:true}))) : null;
  }
  function ToolGroup({group,sessionId,active,approvals,decisions,approving,onApprove,onPreview,onToast}) {
    const [open,setOpen]=React.useState(false), id=React.useId();
    const items=group.items;
    const errors=items.filter(t=>['error','cancelled'].includes(status(t,active))).length;
    const working=active && items.some(t=>['pending','running'].includes(t.status));
    const waiting=items.some(t=>active && t.approvalId && t.status==='pending' && !decisions?.[t.approvalId]);
    const expanded=open || waiting;
    const [verb,unit]=LABELS[group.kind] || [items[0].name,'次'];
    const title=working?`${verb}中 · ${items.length} ${unit}`:`${verb}了 ${items.length} ${unit}`;
    return h('section',{className:`reply-tool-group ${errors?'failed':''} ${waiting?'needs-approval':''}`,'aria-label':title},
      h('button',{type:'button',className:'reply-tool-summary',onClick:()=>setOpen(!open),'aria-expanded':expanded,'aria-controls':id},h('span',{className:working?'reply-spinner':errors?'reply-failed':'reply-check'},working?'◌':errors?'!':'✓'),h('span',null,title),h('small',null,waiting?'等待确认':errors?`${errors} 项未完成`:working?'执行中':'已完成'),h('span',{className:'reply-chevron'},expanded?'⌄':'›')),
      h('div',{id,hidden:!expanded,className:'reply-tool-details'},items.map(tool=>h(Tool,{key:tool.id,tool,approval:approvals?.[tool.approvalId],decision:decisions?.[tool.approvalId],approving:approving?.[tool.approvalId],onApprove,onToast,active,timeline:true}))),
      h(Thumbnails,{tools:items,sessionId,onPreview,onToast}));
  }
  function TaskSummary({tasks,onOpen}) {
    const done=(tasks||[]).filter(t=>t.status==='completed').length;
    if (!tasks?.length) return null;
    return h('button',{type:'button',className:'reply-task-summary',onClick:onOpen},'☑ ',`任务进度 ${done}/${tasks.length}`,h('span',null,'在悬浮窗查看 ›'));
  }
  function Flow({message,sessionId,active,approvals,decisions,approving,onApprove,onPreview,onToast,onActivity}) {
    const flow=buildReplyFlow(message), questions=message.questions || [], tools=message.tools || [];
    // 1.6.6: which ask_user call carries which question is decided before anything renders. It used
    // to be decided while the tool group rendered, so a folded turn — whose work process is not
    // rendered until it is expanded — never marked the question as placed, and the card was appended
    // after the answer as if the model had asked it at the very end.
    const cardFor=new Map(), placed=new Set();
    for (const part of flow) {
      if (part.type!=='tools') continue;
      for (const tool of part.tools) {
        if (toolKind(tool.name)!=='question' || !tool.id || cardFor.has(tool.id)) continue;
        let qid; try { qid=JSON.parse(tool.output || '{}').questionId; } catch {}
        const q=questions.find(item=>item.id===qid && !placed.has(item.id)) || questions.find(item=>!placed.has(item.id) && item.question===tool.args?.question) || questions.find(item=>!placed.has(item.id));
        if (q) { placed.add(q.id); cardFor.set(tool.id,q); }
      }
    }
    const questionCard=q=>h(Question,{key:q.id,question:q,sessionId,active,onToast});
    function toolsNode(tools,index) {
      return groupTools(tools).map((group,i)=>{
        if (group.kind==='tasks') return h(TaskSummary,{key:`t${index}-${i}`,tasks:message.tasks,onOpen:onActivity});
        if (group.kind==='question') {
          const q=cardFor.get(group.items[0].id);
          if (q) return questionCard(q);
        }
        if (group.kind==='agent' && !group.items.some(t=>t.approvalId && t.status==='pending' && !decisions?.[t.approvalId])) return h('div',{className:'reply-agent-summary',key:`a${index}-${i}`},h('button',{type:'button',onClick:()=>window.dispatchEvent(new CustomEvent('reply-agents-open')),title:'在右侧面板查看子代理'},'子代理 · ',group.items.length,' 个 · 右侧面板查看 ›'));
        return h(ToolGroup,{key:group.items[0].id || `${index}-${i}`,group,sessionId,active,approvals,decisions,approving,onApprove,onPreview,onToast});
      });
    }
    const [processOpen,setProcessOpen]=React.useState(false);
    // 1.6.4: a tool call is usually announced by a blank two-character paragraph. Every one of
    // those used to become an empty markdown block that still paid one 12px flow gap, so a
    // hundred tool calls pushed the answer more than a thousand pixels down and left a blank
    // screen under the folded work bar. A blank text part renders nothing, so it is dropped
    // here; the original index is kept so live reasoning still sees the same part order.
    const parts=flow.map((part,index)=>[part,index]).filter(item=>item[0].type!=='text'||item[0].text.trim());
    // 1.6.6: the answer is the last block of text the model wrote. Everything before it was written
    // between two tool calls, so it is a step of the work process, not the answer.
    const answerIndex=parts.reduce((found,item)=>item[0].type==='text'?item[1]:found,undefined);
    const renderPart=(part,index)=>part.type==='text'?h(Markdown,{key:`p${index}`,text:part.text,artifacts:message.artifacts,sessionId,onPreview,onToast}):part.type==='reasoning'?h(Reasoning,{key:`r${index}`,text:part.text,running:active && index===flow.length-1}):h(React.Fragment,{key:`g${index}`},toolsNode(part.tools,index));
    const tail=()=>[!tools.some(t=>t.name==='update_tasks') && h(TaskSummary,{tasks:message.tasks,onOpen:onActivity}),questions.filter(q=>!placed.has(q.id)).map(questionCard)];
    // 1.6.2: a finished turn folds its thinking and tool calls into one bar, so old replies show only the answer.
    if (!active && message.status!=='running' && flow.some(part=>part.type!=='text')) {
      const work=parts.filter(item=>item[0].type!=='text');
      // 1.6.6: the short paragraphs the model writes between two tool calls are work process as
      // well. They used to stay outside the fold, so a long turn still showed every "先核对清单…
      // 再删除…" paragraph above the answer and the bar hid only the tool cards.
      const summaries=parts.filter(item=>item[0].type==='text' && item[1]!==answerIndex);
      const folded=[...work,...summaries].sort((a,b)=>a[1]-b[1]);
      const steps=tools.length + work.filter(item=>item[0].type==='reasoning').length + summaries.length;
      const open=processOpen || answerIndex===undefined;
      // The answer and the question cards are conversation, not work process: they stay outside the
      // fold. A card is placed where the model asked, so it can no longer land after the answer.
      const body=[];
      for (const [part,index] of parts) {
        if (part.type==='text') { if (index===answerIndex) body.push(renderPart(part,index)); continue; }
        if (open || part.type!=='tools') continue;
        for (const tool of part.tools) { const q=cardFor.get(tool.id); if (q) body.push(questionCard(q)); }
      }
      return h('div',{className:`reply-flow reply-flow-folded ${open?'is-open':''}`},
        h('button',{type:'button',className:'reply-process-toggle',onClick:()=>{window.dispatchEvent(new CustomEvent('reply-layout-fold'));setProcessOpen(value=>!value)},'aria-expanded':open,title:open?'收起工作过程':'展开工作过程'},
          h('span',{className:'reply-check','aria-hidden':'true'},'✓'),
          h('span',{className:'reply-process-label'},'工作过程'),
          h('span',{className:'reply-process-count'},`${steps} 步`),
          h('span',{className:'reply-process-hint'},open?'收起':'展开'),
          h('span',{className:'reply-chevron','aria-hidden':'true'},open?'⌄':'›')),
        open && h('div',{className:'reply-process-body'},folded.map(item=>renderPart(item[0],item[1]))),
        ...body,
        ...tail());
    }
    return h('div',{className:'reply-flow'},parts.map(item=>renderPart(item[0],item[1])),...tail());
  }
  // 1.6.1: a persistent floating task-progress window docked at the top-right, under the chat header.
  // It shows only the task list, can be minimized to a pill, and never covers the header controls.
  function Activity({messages = [], tasks: sessionTasks, active, expanded = true, onToggle}) {
    const [dock,setDock] = React.useState(null);
    React.useEffect(()=>{
      let frame = 0, observer = null;
      const measure = () => {
        frame = 0;
        const panel = document.querySelector('.main-panel');
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const header = panel.querySelector('.chat-header');
        const bottom = header ? header.getBoundingClientRect().bottom : rect.top;
        const right = Math.round(window.innerWidth - rect.right + 16), top = Math.round(bottom + 12);
        setDock(previous => previous && previous.right === right && previous.top === top ? previous : {right, top});
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
      measure();
      const panel = document.querySelector('.main-panel');
      if (panel && typeof ResizeObserver === 'function') { observer = new ResizeObserver(schedule); observer.observe(panel); }
      window.addEventListener('resize', schedule);
      return () => { if (frame) cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', schedule); };
    },[]);
    // 1.6.4: the checklist belongs to the conversation, not to one message. Scanning the messages
    // kept showing the previous turn's list, because a new turn starts with an empty tasks array of
    // its own; the newest message that still carries a list is only the fallback for an older
    // server that does not send the conversation's tasks.
    const fallback = [...messages].reverse().find(message => message.role === 'assistant' && Array.isArray(message.tasks) && message.tasks.length)?.tasks || [];
    const tasks = (Array.isArray(sessionTasks) ? sessionTasks : fallback).filter(task => task && task.text);
    const signature = tasks.map(task => (task.status || '') + ':' + task.text).join('|');
    // A finished checklist is cleared by the server. The panel says so once and then goes away,
    // instead of sitting at 3/3 for the rest of the conversation.
    const previous = React.useRef({signature: '', allDone: false, tasks: []});
    const [finished, setFinished] = React.useState(null);
    React.useEffect(() => {
      const before = previous.current;
      const allDone = tasks.length > 0 && tasks.every(task => task.status === 'completed');
      previous.current = {signature, allDone, tasks};
      if (tasks.length) { setFinished(value => value ? null : value); return undefined; }
      if (!before.signature || !before.allDone) return undefined;
      setFinished(before.tasks);
      const timer = setTimeout(() => setFinished(null), 4000);
      return () => clearTimeout(timer);
    }, [signature]);
    // An empty list renders nothing at all: no panel and no pill.
    const shown = tasks.length ? tasks : finished;
    if (!shown || !shown.length) return null;
    const closing = !tasks.length;
    const done = shown.filter(task => task.status === 'completed').length;
    const running = !closing && active && shown.some(task => task.status === 'in_progress');
    const style = dock ? {right: `${dock.right}px`, top: `${dock.top}px`} : {right: 0, top: 0, visibility: 'hidden'};
    const head = [
      h('span',{className:'reply-task-float-mark','aria-hidden':'true'},'☑'),
      h('strong',null,'任务进度'),
      h('span',{className:'reply-task-float-count','aria-live':'polite'},`${done}/${shown.length}`),
      closing ? h('span',{className:'reply-check','aria-hidden':'true'},'✓') : h('span',{className:'reply-chevron','aria-hidden':'true'},expanded ? '⌄' : '›'),
    ];
    return h('aside',{className:`reply-activity-panel reply-task-float ${closing ? 'is-finished' : expanded ? 'is-expanded' : 'is-minimized'}`,style,'aria-label':closing ? '任务全部完成' : '任务进度悬浮窗'},
      h('div',{className:'reply-task-float-head'},
        closing
          ? h('div',{className:'reply-task-float-toggle'},...head)
          : h('button',{type:'button',className:'reply-task-float-toggle',onClick:onToggle,'aria-expanded':expanded,title:expanded ? '最小化任务进度' : '展开任务进度'},...head),
        running && h('span',{className:'reply-task-float-live'},'运行中')),
      closing
        ? h('div',{className:'reply-task-float-body reply-task-float-done'},'✓ 任务全部完成')
        : expanded && h('div',{className:'reply-task-float-body'},
          h('progress',{max:shown.length,value:done,'aria-label':`任务进度 ${done}/${shown.length}`}),
          h('ol',{className:'reply-tasks'},shown.map((task,index)=>h('li',{key:task.id || index,className:task.status},
            h('span',{'aria-hidden':'true'},task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◌' : '○'),
            h('span',null,task.text),
            h('small',null,task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '进行中' : '待做'))))));
  }
  function WaitingButton({sessions=[],approvals={},decisions={},currentId,onSelect}) {
    const waiting=sessions.filter(s=>s.messages?.some(m=>m.status==='running' && m.questions?.some(q=>q.status==='pending')) || Object.values(approvals).some(a=>a.sessionId===s.id && !decisions[a.id]));
    if (!waiting.length) return null;
    const index=waiting.findIndex(s=>s.id===currentId), next=waiting[(index+1)%waiting.length];
    return h('button',{type:'button',className:'reply-waiting-button',title:'跳到下一个等待处理的会话',onClick:()=>onSelect(next.id)},'⚠ ',waiting.length,' 待处理');
  }
  function ImageViewer({artifact,onClose,onToast}) {
    const [zoom,setZoom]=React.useState(1),[pan,setPan]=React.useState({x:0,y:0}),[busy,setBusy]=React.useState(false),[canOpen,setCanOpen]=React.useState(false);
    const drag=React.useRef(null),root=React.useRef(null);
    const path=artifact.path || (()=>{try{return new URL(artifact.url,location.origin).searchParams.get('path');}catch{return null;}})();
    React.useEffect(()=>{
      const old=document.activeElement;root.current?.querySelector('button')?.focus();
      const key=e=>{
        if(e.key==='Escape'){e.preventDefault();onClose();}
        if(e.key==='Tab'){const all=[...root.current?.querySelectorAll('button:not(:disabled),a[href]')||[]];const at=all.indexOf(document.activeElement); if(e.shiftKey && at<=0 || !e.shiftKey && at===all.length-1){e.preventDefault();all[e.shiftKey?all.length-1:0]?.focus();}}
      };document.addEventListener('keydown',key);
      return()=>{document.removeEventListener('keydown',key);old?.isConnected && old.focus();};
    },[onClose]);
    React.useEffect(()=>{let alive=true;setCanOpen(false);if(path && artifact.sessionId)fetch(`/api/workspace/file-info?sessionId=${encodeURIComponent(artifact.sessionId)}&path=${encodeURIComponent(path)}`).then(r=>r.ok?r.json():null).then(v=>{if(alive)setCanOpen(v?.actions?.default===true);}).catch(()=>{});return()=>{alive=false;};},[path,artifact.sessionId]);
    const clamp=n=>Math.min(5,Math.max(.25,n));
    async function openFile(){setBusy(true);try{const r=await fetch('/api/workspace/open-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:artifact.sessionId,path,action:'default'})});const v=await r.json();if(!r.ok)throw Error(v.error || '无法打开图片');onToast?.('已请求系统应用打开图片');}catch(e){onToast?.(e.message,'error');}finally{setBusy(false);}}
    return h('div',{className:'image-modal-backdrop reply-image-modal',ref:root,role:'dialog','aria-modal':'true','aria-label':'图片预览',onMouseDown:e=>{if(e.target===e.currentTarget)onClose();}},
      h('div',{className:'image-modal-toolbar'},h('strong',null,artifact.name || '图片预览'),h('div',null,h('button',{type:'button',onClick:()=>setZoom(clamp(zoom-.25)),'aria-label':'缩小图片'},'−'),h('span',null,`${Math.round(zoom*100)}%`),h('button',{type:'button',onClick:()=>setZoom(clamp(zoom+.25)),'aria-label':'放大图片'},'+'),h('button',{type:'button',onClick:()=>{setZoom(1);setPan({x:0,y:0});}},'适应窗口'),h('button',{type:'button',disabled:busy,onClick:async()=>{setBusy(true);try{await copyImage(artifact.url);onToast?.('图片已复制');}catch(e){onToast?.(e.message,'error');}finally{setBusy(false);}}},'复制'),h('a',{href:downloadUrl(artifact),download:artifact.name || 'image'},'下载'),h('button',{type:'button',onClick:onClose,'aria-label':'关闭预览'},'×'))),
      h('div',{className:'reply-image-canvas',onWheel:e=>setZoom(clamp(zoom+(e.deltaY<0?.1:-.1))),onPointerDown:e=>{if(e.button!==0)return;drag.current={x:e.clientX-pan.x,y:e.clientY-pan.y};e.currentTarget.setPointerCapture(e.pointerId);},onPointerMove:e=>{if(drag.current)setPan({x:e.clientX-drag.current.x,y:e.clientY-drag.current.y});},onPointerUp:()=>{drag.current=null;},onPointerCancel:()=>{drag.current=null;}},h('img',{src:safeImage(artifact.url),alt:artifact.name || '图片',draggable:false,style:{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}})),
      h('footer',null,h('span',null,'滚轮缩放 · 拖动平移 · Esc 关闭'),canOpen && h('button',{type:'button',disabled:busy,onClick:openFile},'用系统程序打开')));
  }
  return { Flow, Reasoning, Activity, WaitingButton, ImageViewer, TaskSummary, Question, ToolGroup };
}
