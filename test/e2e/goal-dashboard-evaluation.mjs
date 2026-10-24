import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { LoopStore } from '../../src/store.ts';
import { GoalDashboard } from '../../src/ui/goal-dashboard.ts';

initTheme('dark', false);
const theme = { fg: (_token, text) => text, bold: text => text };
const fixturePolicy = { goal:'Validate the fixed fixture',criteria:['All fixed checks pass.','The required display behavior is preserved.'],verification:{command:'/not-executed/fixture',args:[],description:'Fixed fixture only; this evaluation never executes it.'} };
const output = '.artifacts/dashboard'; mkdirSync(output,{recursive:true});
const timings=[]; const matrix=[];
function make(count,rows=40){
  const store=new LoopStore();for(let i=0;i<count;i++)store.create({type:'dynamic'},`Goal ${i+1} · 문서 품질 🙂`,{recurring:true,maxFires:5,expiresIn:'1h',completion:fixturePolicy,completionCwd:process.cwd()});
  const signal=new AbortController();let action;
  const view=new GoalDashboard({entries:()=>store.list(),pendingGoal:()=>undefined,phase:()=>undefined,storageScope:()=> 'memory',nextFire:()=>undefined,current:()=>true,signal:signal.signal},
    {terminal:{rows},requestRender(){}},theme,result=>{action=result;},false);
  return{store,view,get action(){return action;}};
}
for(const columns of[48,80,120])for(const rows of[16,24,40])for(const count of[0,1,25]){
  const h=make(count,rows);const before=JSON.stringify(h.store.list());
  try{
    const sample=h.view.render(columns);assert(sample.length<=rows-4);assert(sample.every(line=>visibleWidth(line)<=columns));
    assert(sample.join('\n').includes('Esc close'));if(count)assert(sample.join('\n').includes('#1'));
    for(let i=0;i<100;i++){const start=performance.now();h.view.render(columns);timings.push(performance.now()-start);}
    assert.equal(JSON.stringify(h.store.list()),before);
    matrix.push({columns,rows,goals:count,overflowRows:0,overflowColumns:0,inspectionMutatedState:false});
    if(rows===40&&count===1)writeFileSync(join(output,`preview-${columns}.txt`),sample.join('\n')+'\n');
  }finally{h.view.dispose();}
}
const tasks=[];
function task(name,keys,check,rows=40){
  const h=make(3,rows);const before=JSON.stringify(h.store.list());const start=performance.now();
  try{h.view.render(120);for(const key of keys){h.view.handleInput(key);h.view.render(120);}check(h);
    assert.equal(JSON.stringify(h.store.list()),before,'Task intent must not mutate controller state');
    tasks.push({name,attempts:1,success:true,elapsedMs:performance.now()-start,logicalKeyPresses:keys.length,approvalRequests:0,blockingErrors:0,kind:'scripted_component_proxy'});
  }finally{h.view.dispose();}
}
task('read_selected_status_and_budget',[],h=>{const text=h.view.render(120).join('\n');assert(text.includes('#1')&&text.includes('fires'));});
task('read_selected_criteria',['\t'],h=>assert(h.view.render(120).join('\n').includes(fixturePolicy.criteria[0])));
task('select_third_goal',['\x1b[B','\x1b[B'],h=>assert(h.view.render(120).join('\n').includes('#3  WAITING')));
task('keyboard_detail_scroll',['\t','\x1b[6~'],h=>{const text=h.view.render(120).join('\n');assert(text.includes('DETAIL ')&&!text.includes('DETAIL 1–'));},24);
task('prepare_start_intent',['g'],h=>{assert.equal(h.action.type,'start');assert.equal(h.store.list().length,3);});
task('request_explicit_cancel_intent',['x'],h=>{assert.equal(h.action.type,'cancel');assert.equal(h.action.entry.id,'1');assert.equal(h.store.list().length,3);});
assert.equal(tasks.length,6);assert(tasks.every(value=>value.success),'Fixed task controls must pass');
assert(tasks.every(value=>Number.isFinite(value.elapsedMs)&&value.elapsedMs>=0),'Each fixed task must report measured elapsed time');
assert(tasks.every(value=>value.attempts===1&&value.approvalRequests===0&&value.blockingErrors===0),'Each fixed task must report attempts, approvals and observed errors');
timings.sort((a,b)=>a-b);
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const source=readFileSync('src/ui/goal-dashboard.ts');
const report={status:'passed',sourceHead:sha,candidateSourceSha256:createHash('sha256').update(source).digest('hex'),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),node:process.version,
  matrixFixtures:matrix.length,scriptedComponentTasks:tasks,scriptedTaskSuccessRate:tasks.filter(task=>task.success).length/tasks.length,
  renderSamples:timings.length,renderP50Ms:timings[Math.floor(timings.length*.5)],renderP95Ms:timings[Math.floor(timings.length*.95)],renderP95BudgetMs:16,renderBudgetMet:timings[Math.floor(timings.length*.95)]<=16,
  layoutMatrix:matrix,humanParticipants:0,humanTimeOnTask:null,umuxLiteRawScore:null,visualAestheticsAdaptedMean:null,visualInstrument:'Exploratory TUI adaptation of VisAWI-S; no human ratings collected',baselineMeasurements:null,
  limitations:['Logical keys and task timings exclude fixture creation, command entry and owner confirmation. These read-only intents request zero approvals; owner actions and CAS are separately tested.','These are synthetic component tasks, not representative human usability.','No real user goals, model calls, verifier execution or JEV requests.','Baseline comparison and human survey are not inferred from target values.']};
assert(report.renderBudgetMet,'Render engineering budget exceeded');
writeFileSync(join(output,'evaluation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,matrixFixtures:report.matrixFixtures,componentTasks:tasks.length,scriptedSuccessRate:report.scriptedTaskSuccessRate,renderP95Ms:report.renderP95Ms,renderBudgetMet:report.renderBudgetMet,humanParticipants:0,umuxLiteRawScore:null}));
