// Model -> real tool -> desktop callback -> actual answer/selection HTTP routes.
// All content is synthetic. No API key, model service, OS notification or user profile is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startServer } from '../app/server/index.mjs';

async function until(get) {
  for (let n = 0; n < 400; n++) { const value = await get(); if (value) return value; await delay(25); }
  assert.fail('expected pending user action within 10 seconds');
}
test('desktop receives true → false → done for team member/model selection and ask_user; stop does not post a completion', async () => {
  let nextTool, app;
  const events = [], dir = await mkdtemp(path.join(tmpdir(), 'harness-taskbar-'));
  const provider = createServer(async (req, res) => {
    for await (const _ of req) { /* consume fixture request */ }
    const tool = nextTool; nextTool = null;
    if (tool?.simulateFailure) {
      res.writeHead(400, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'synthetic request failure'}})); return;
    }
    const delta = tool ? {tool_calls:[{index:0,id:'call_stub',type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]} : {content:'fixture done'};
    const frame = choice => `data: ${JSON.stringify({choices:[{index:0,...choice}]})}\n\n`;
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end(frame({delta}) + frame({delta:{}, finish_reason:tool?'tool_calls':'stop'}) + 'data: [DONE]\n\n');
  });
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    app = await startServer({port:0,dataDir:dir,defaultWorkspace:path.join(dir,'workspace'),seedExternalSkills:false,
      onWaitingForUser:(...args)=>events.push(args), onRunFinished:({status})=>events.push(status)});
    const origin = `http://127.0.0.1:${app.address().port}`;
    async function api(method, route, data) {
      const response = await fetch(origin+route,{method,headers:{'content-type':'application/json'},body:JSON.stringify(data)});
      assert.equal(response.ok, true, `fixture ${route} returned ${response.status}`); return response;
    }
    await api('PUT','/api/settings',{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,agentModel:'fixture',chatModel:'fixture',apiKey:'fixture-only',protocol:'chat'});
    const json = async response => (await response).json();
    async function run(tool) {
      const body = await json(api('POST','/api/sessions',{})), id = body.id ?? body.session.id;
      nextTool = tool;
      const result = api('POST',`/api/sessions/${id}/messages`,{mode:'agent',text:'fixture task'}).then(r=>r.text());
      void result.catch(()=>{}); return {id,result};
    }
    const {id:teamId,result:team} = await run({name:'team_run',args:{background:false,name:'test team',goal:'test selection',members:[{name:'A',task:'fixture task'}]}});
    const proposal = await until(async ()=>(await json(api('GET',`/api/team-configurations?sessionId=${teamId}`))).configurations[0]);
    assert.deepEqual(events, [[true]]);
    await api('POST',`/api/team-configurations/${proposal.id}`,{sessionId:teamId,members:proposal.members.map(m=>({id:m.id,model:'chosen-model',profile:''}))});
    await team; assert.deepEqual(events.splice(0), [[true],[false],'done']);
    for (const stop of [false,true]) {
      const {id,result} = await run({name:'ask_user',args:{question:'fixture question',options:['one','two']}});
      const question = await until(()=>app.app.locals.harness.runs.get(id)?.assistant?.questions?.[0]);
      assert.deepEqual(events, [[true]]);
      if (stop) await api('POST',`/api/sessions/${id}/stop`,{});
      else await api('POST',`/api/sessions/${id}/questions/${question.id}/answer`,{answer:'two'});
      await result; assert.deepEqual(events.splice(0), stop ? [[true],[false]] : [[true],[false],'done']);
    }
    const failed = await run({simulateFailure:true});
    await failed.result; assert.deepEqual(events.splice(0), ['error']);
  } finally {
    try { await app?.stop(); } finally { await new Promise(resolve=>provider.close(resolve)); await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
  }
});
