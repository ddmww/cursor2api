// Cursor2API Admin Console overlay

const ADMIN_TABS=['overview','logs','config'];
const CONFIG_GROUPS=[
  {id:'service',title:'服务基础',fields:[
    {path:'port',label:'服务端口',type:'number',help:'修改后需要重启服务才会切换监听端口。',min:1,max:65535},
    {path:'timeout',label:'请求超时（秒）',type:'number',help:'上游请求的超时时间。',min:1},
    {path:'proxy',label:'全局代理',type:'text',help:'例如 http://127.0.0.1:7890。',mono:true,placeholder:'http://127.0.0.1:7890'},
    {path:'cursor_model',label:'Cursor 模型',type:'text',help:'默认使用的 Cursor 模型标识。',mono:true,placeholder:'anthropic/claude-sonnet-4.6'}
  ]},
  {id:'security',title:'鉴权与安全',fields:[
    {path:'auth_tokens',label:'Auth Tokens',type:'list-secret',help:'每行一个 token。为空则 API 与后台开放。',mono:true,rows:4},
    {path:'sanitize_response',label:'响应内容清洗',type:'checkbox',help:'将响应中的 Cursor 身份引用替换为 Claude。'},
    {path:'fixed_fallback_responses',label:'固定身份/能力回复',type:'checkbox',help:'关闭后，不再注入 Claude 身份与能力说明模板。'},
    {path:'refusal_patterns',label:'自定义拒绝检测规则',type:'list',help:'每行一条规则。',mono:true,rows:5,full:true}
  ]},
  {id:'behavior',title:'上下文与行为',fields:[
    {path:'max_auto_continue',label:'自动续写次数',type:'number',help:'0 表示禁用。',min:0},
    {path:'max_history_messages',label:'历史消息上限',type:'number',help:'-1 表示不限制。',min:-1},
    {path:'thinking.enabled',label:'强制启用 Thinking',type:'checkbox',help:'覆盖客户端的 thinking 选择。'}
  ]},
  {id:'compression',title:'压缩',fields:[
    {path:'compression.enabled',label:'启用历史压缩',type:'checkbox',help:'关闭后完整保留历史消息。'},
    {path:'compression.level',label:'压缩级别',type:'select',help:'1=轻度，2=中等，3=激进。',options:[['1','1'],['2','2'],['3','3']]},
    {path:'compression.keep_recent',label:'保留最近消息数',type:'number',help:'默认 10。',min:0},
    {path:'compression.early_msg_max_chars',label:'早期消息字符上限',type:'number',help:'默认 4000。',min:1}
  ]},
  {id:'tools',title:'工具处理',fields:[
    {path:'tools.schema_mode',label:'Schema 模式',type:'select',help:'compact/full/names_only。',options:[['compact','compact'],['full','full'],['names_only','names_only']]},
    {path:'tools.description_max_length',label:'描述截断长度',type:'number',help:'0 表示不截断。',min:0},
    {path:'tools.passthrough',label:'工具透传模式',type:'checkbox',help:'跳过 few-shot 注入，直接嵌入原始工具 JSON。'},
    {path:'tools.disabled',label:'禁用工具注入',type:'checkbox',help:'完全不注入工具定义与 few-shot。'},
    {path:'tools.include_only',label:'工具白名单',type:'list',help:'每行一个工具名。',mono:true,rows:4},
    {path:'tools.exclude',label:'工具黑名单',type:'list',help:'每行一个工具名。',mono:true,rows:4}
  ]},
  {id:'vision',title:'视觉',fields:[
    {path:'vision.enabled',label:'启用视觉处理',type:'checkbox',help:'拦截图片并执行 OCR / 外部 Vision。'},
    {path:'vision.mode',label:'视觉模式',type:'select',help:'ocr 或 api。',options:[['ocr','ocr'],['api','api']]},
    {path:'vision.base_url',label:'Vision Base URL',type:'text',help:'mode=api 时必填。',mono:true,placeholder:'https://api.openai.com/v1/chat/completions'},
    {path:'vision.api_key',label:'Vision API Key',type:'secret',help:'mode=api 时必填。',mono:true,placeholder:'sk-...'},
    {path:'vision.model',label:'Vision 模型',type:'text',help:'mode=api 时必填。',mono:true,placeholder:'gpt-4o-mini'},
    {path:'vision.proxy',label:'Vision 独立代理',type:'text',help:'只影响图片 API。',mono:true,placeholder:'http://127.0.0.1:7890'}
  ]},
  {id:'logging',title:'日志',fields:[
    {path:'logging.file_enabled',label:'启用文件日志',type:'checkbox',help:'开启后写入 JSONL 并在重启后恢复。'},
    {path:'logging.dir',label:'日志目录',type:'text',help:'容器部署常用 /app/logs。',mono:true,placeholder:'./logs'},
    {path:'logging.max_days',label:'日志保留天数',type:'number',help:'超过该天数会自动清理。',min:1},
    {path:'logging.persist_mode',label:'落盘模式',type:'select',help:'compact/full/summary。',options:[['summary','summary'],['compact','compact'],['full','full']]}
  ]},
  {id:'fingerprint',title:'指纹',fields:[
    {path:'fingerprint.user_agent',label:'User-Agent',type:'textarea',help:'若环境变量 FP 生效，这里会被覆盖。',mono:true,rows:4,full:true}
  ]}
];

let dashboardTab=new URLSearchParams(window.location.search).get('tab');
if(!ADMIN_TABS.includes(dashboardTab))dashboardTab='overview';
let configData=null,configMeta=null,configErrors={},configDirty=false,saveState='clean';

function adminToken(){return localStorage.getItem('cursor2api_token')||''}
function adminUrl(tab){const p=new URLSearchParams(window.location.search);p.set('tab',tab);const t=adminToken();if(t)p.set('token',t);else p.delete('token');return '/admin?'+p.toString()}
function adminAuthQ(base){const t=adminToken();return t?(base.includes('?')?base+'&token=':base+'?token=')+encodeURIComponent(t):base}
function escAdmin(s){if(s===undefined||s===null)return'';const d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
function getPath(obj,path){return path.split('.').reduce((acc,key)=>acc&&acc[key],obj)}
function setPath(obj,path,value){const parts=path.split('.');let cur=obj;for(let i=0;i<parts.length-1;i++){if(!cur[parts[i]]||typeof cur[parts[i]]!=='object')cur[parts[i]]={};cur=cur[parts[i]]}cur[parts[parts.length-1]]=value}
function slug(path){return path.replace(/[^\w]+/g,'-')}
function envOverride(path){return configMeta?.envOverrides?.[path]}

const _origApplyStats=applyStats;
applyStats=function(s){_origApplyStats(s);renderOverview()};
const _origRenderRL=renderRL;
renderRL=function(){_origRenderRL();renderOverview()};
const _origClearLogs=clearLogs;
clearLogs=async function(){await _origClearLogs();renderOverview()};

function switchDashboardTab(tab,push){
  dashboardTab=ADMIN_TABS.includes(tab)?tab:'overview';
  document.querySelectorAll('[data-dashboard-tab]').forEach(btn=>btn.classList.toggle('a',btn.getAttribute('data-dashboard-tab')===dashboardTab));
  document.querySelectorAll('.dashboard-section').forEach(section=>section.classList.remove('active'));
  const active=document.getElementById('section-'+dashboardTab);if(active)active.classList.add('active');
  if(push)history.replaceState({},'',adminUrl(dashboardTab));
  if(dashboardTab==='overview')renderOverview();
  if(dashboardTab==='config')renderConfig();
}

function renderAlerts(){
  const el=document.getElementById('adminAlerts');
  const warnings=configMeta?.warnings||[];
  el.innerHTML=warnings.map(w=>'<div class="banner warn">'+escAdmin(w)+'</div>').join('');
}

function renderOverview(){
  renderOverviewCards();
  renderOverviewWarnings();
  renderRecentRequests();
}

function renderOverviewCards(){
  const cards=[
    ['当前模型',configData?.cursor_model||'-','运行时默认使用的模型。'],
    ['后台鉴权',configMeta?.authConfigured?'已启用 auth_tokens':'未启用 auth_tokens','未启用时公网风险较高。'],
    ['日志模式',configData?.logging?.file_enabled?('文件('+configData.logging.persist_mode+') → '+configData.logging.dir):'仅内存','控制台实时日志不受影响。'],
    ['配置文件',configMeta?.fileExists?'config.yaml':'首次保存会创建 config.yaml','后台只写 config.yaml。'],
    ['ENV 覆盖',String(configMeta?.overriddenFields?.length||0),'这些字段保存后可能不会立刻改变运行值。'],
    ['最近请求',document.getElementById('sT').textContent||'0','使用顶部统计同步展示。'],
    ['平均耗时',(document.getElementById('sA').textContent||'-')+' ms','已完成请求的平均耗时。'],
    ['平均 TTFT',(document.getElementById('sF').textContent||'-')+' ms','首 token 平均返回时间。'],
  ];
  document.getElementById('overviewCards').innerHTML=cards.map(([label,value,meta])=>'<div class="overview-card"><div class="label">'+escAdmin(label)+'</div><div class="value">'+escAdmin(value)+'</div><div class="meta">'+escAdmin(meta)+'</div></div>').join('');
}

function renderOverviewWarnings(){
  const el=document.getElementById('overviewWarnings');
  const warnings=(configMeta?.warnings||[]).slice();
  if(configMeta?.overriddenFields?.length)warnings.push('检测到 '+configMeta.overriddenFields.length+' 个字段被环境变量覆盖，后台保存的是文件值而非最终运行值。');
  el.innerHTML='<div class="warning-list">'+(warnings.length?warnings.map(w=>'<div class="warning-item">'+escAdmin(w)+'</div>').join(''):'<div class="warning-item">当前没有额外风险提示。</div>')+'</div>';
}

function renderRecentRequests(){
  const el=document.getElementById('recentRequests');
  if(!reqs||!reqs.length){el.innerHTML='<div class="empty compact"><div class="ic">📡</div><p>等待请求...</p></div>';return}
  el.innerHTML=reqs.slice(0,8).map(r=>'<div class="recent-item" onclick="openRecentRequest(\''+String(r.requestId).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+'\')"><div class="title">'+escAdmin(r.title||r.model)+'</div><div class="meta"><span>'+escAdmin(r.requestId)+'</span><span>'+escAdmin(r.status)+'</span><span>'+escAdmin(fmtDate(r.startTime))+'</span></div></div>').join('');
}

function openRecentRequest(id){switchDashboardTab('logs',true);selReq(id)}

async function readApiPayload(resp){
  const text=await resp.text();
  if(!text)return {};
  try{return JSON.parse(text)}catch{
    return {message:text.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()||('HTTP '+resp.status)}
  }
}

async function loadConfig(){
  const resp=await fetch(adminAuthQ('/api/admin/config'));
  if(resp.status===401||resp.status===403){localStorage.removeItem('cursor2api_token');window.location.href=adminUrl(dashboardTab);return}
  const payload=await readApiPayload(resp);
  if(!resp.ok)throw new Error(payload.message||'后台配置接口返回错误。');
  configData=payload.config;configMeta=payload.meta;configErrors={};
  renderAlerts();renderOverview();renderConfig();updateSaveState();
}

function renderConfig(){
  if(!configData||!configMeta)return;
  document.getElementById('configNav').innerHTML='<div class="config-nav-title">配置分组</div>'+CONFIG_GROUPS.map(group=>'<button class="config-link" data-group-link="'+group.id+'" onclick="scrollConfigGroup(\''+group.id+'\')">'+escAdmin(group.title)+'</button>').join('');
  document.getElementById('configSummary').innerHTML=[
    ['配置文件',configMeta.fileExists?'config.yaml':'首次保存会创建 config.yaml'],
    ['鉴权状态',configMeta.authConfigured?'已启用 auth_tokens':'未启用 auth_tokens'],
    ['日志模式',configData.logging.file_enabled?('文件('+configData.logging.persist_mode+') → '+configData.logging.dir):'仅内存'],
    ['ENV 覆盖',String(configMeta.overriddenFields.length)+' 个字段'],
  ].map(([label,value])=>'<div class="summary-chip"><div class="label">'+escAdmin(label)+'</div><div class="value">'+escAdmin(value)+'</div></div>').join('');
  document.getElementById('configGroups').innerHTML=CONFIG_GROUPS.map(group=>'<section class="config-group" id="group-'+group.id+'"><div class="config-group-header"><h3>'+escAdmin(group.title)+'</h3></div><div class="field-grid">'+group.fields.map(renderField).join('')+'</div></section>').join('');
}

function renderField(field){
  const value=getPath(configData,field.path),error=configErrors[field.path]||'',env=envOverride(field.path);
  const badges=[];if(env)badges.push('<span class="badge env">ENV '+escAdmin(env.envVar)+'</span>');if(configMeta.restartRequiredFields.includes(field.path))badges.push('<span class="badge restart">需重启</span>');else if(configMeta.liveReloadFields.includes(field.path))badges.push('<span class="badge live">保存后生效</span>');
  return '<div class="cfg-field'+(field.full?' full':'')+'"><div class="cfg-label-row"><div class="cfg-label">'+escAdmin(field.label)+'</div><div class="cfg-badges">'+badges.join('')+'</div></div><div class="cfg-help">'+escAdmin(field.help||'')+'</div>'+renderFieldInput(field,value)+(env?'<div class="field-note">当前运行值受环境变量 <b>'+escAdmin(env.envVar)+'</b> 覆盖。</div>':'<div class="field-note"></div>')+'<div class="field-error" data-error-for="'+field.path+'">'+escAdmin(error)+'</div></div>';
}

function renderFieldInput(field,value){
  const base='data-config-path="'+field.path+'"';
  if(field.type==='checkbox')return '<label class="toggle-row"><input type="checkbox" '+base+' '+(value?'checked':'')+' /><span>启用</span></label>';
  if(field.type==='select')return '<select class="cfg-select '+(field.mono?'mono':'')+'" '+base+'>'+field.options.map(([val,label])=>'<option value="'+escAdmin(val)+'" '+(String(value)===String(val)?'selected':'')+'>'+escAdmin(label)+'</option>').join('')+'</select>';
  if(field.type==='list'||field.type==='textarea'||field.type==='list-secret'){
    const text=Array.isArray(value)?value.join('\n'):(value||'');const secret=field.type==='list-secret';const sid='field-'+slug(field.path);
    return '<div class="secret-wrap">'+(secret?'<button type="button" class="secret-toggle" onclick="toggleSecretField(\''+slug(field.path)+'\',this)">显示</button>':'')+'<textarea id="'+sid+'" class="cfg-textarea '+(field.mono?'mono ':'')+(secret?'secret':'')+'" rows="'+(field.rows||4)+'" '+base+'>'+escAdmin(text)+'</textarea></div>';
  }
  if(field.type==='secret'){const sid='field-'+slug(field.path);return '<div class="secret-wrap"><button type="button" class="secret-toggle" onclick="toggleSecretField(\''+slug(field.path)+'\',this)">显示</button><input id="'+sid+'" type="password" class="cfg-input '+(field.mono?'mono':'')+'" '+base+' value="'+escAdmin(value||'')+'" placeholder="'+escAdmin(field.placeholder||'')+'" /></div>'}
  if(field.type==='number')return '<input type="number" class="cfg-input '+(field.mono?'mono':'')+'" '+base+' value="'+escAdmin(value)+'" min="'+(field.min!==undefined?field.min:'')+'" max="'+(field.max!==undefined?field.max:'')+'" />';
  return '<input type="text" class="cfg-input '+(field.mono?'mono':'')+'" '+base+' value="'+escAdmin(value||'')+'" placeholder="'+escAdmin(field.placeholder||'')+'" />';
}

function scrollConfigGroup(id){
  const el=document.getElementById('group-'+id);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
  document.querySelectorAll('[data-group-link]').forEach(btn=>btn.classList.toggle('a',btn.getAttribute('data-group-link')===id));
}

function toggleSecretField(id,btn){
  const el=document.getElementById('field-'+id);if(!el)return;
  if(el.tagName==='TEXTAREA'){el.classList.toggle('revealed');btn.textContent=el.classList.contains('revealed')?'隐藏':'显示';return}
  el.type=el.type==='password'?'text':'password';btn.textContent=el.type==='text'?'隐藏':'显示';
}

function markConfigDirty(path){
  if(path&&configErrors[path]){configErrors[path]='';const err=document.querySelector('[data-error-for="'+path+'"]');if(err)err.textContent=''}
  configDirty=true;saveState='dirty';updateSaveState();
}

function updateSaveState(){
  const el=document.getElementById('saveState'),btn=document.getElementById('saveBtn');
  btn.disabled=!configDirty;el.classList.remove('dirty','saved');
  if(configDirty){el.textContent='配置有未保存修改';el.classList.add('dirty');return}
  if(saveState==='saved'){el.textContent='配置已保存';el.classList.add('saved');return}
  el.textContent='配置未修改';
}

function serializeConfigForm(){
  const next=JSON.parse(JSON.stringify(configData));
  CONFIG_GROUPS.forEach(group=>group.fields.forEach(field=>{
    const el=document.querySelector('[data-config-path="'+field.path+'"]');if(!el)return;
    let value;if(field.type==='checkbox')value=el.checked;else if(field.type==='number')value=Number(el.value);else if(field.type==='list'||field.type==='list-secret')value=el.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);else value=el.value;
    setPath(next,field.path,value);
  }));
  return next;
}

async function saveConfig(){
  if(!configData)return;
  const payload=serializeConfigForm();
  const resp=await fetch(adminAuthQ('/api/admin/config'),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:payload})});
  if(resp.status===401||resp.status===403){localStorage.removeItem('cursor2api_token');window.location.href=adminUrl('config');return}
  const data=await readApiPayload(resp);
  if(!resp.ok){configData=payload;configErrors=data.errors||{};renderConfig();updateSaveState();showAdminToast(data.message||'保存失败，请检查配置。','error');return}
  configData=data.config;configMeta=data.meta;configErrors={};configDirty=false;saveState='saved';renderAlerts();renderOverview();renderConfig();updateSaveState();showAdminToast((data.changes&&data.changes.length?('已保存，'+data.changes.length+' 项变更。'):'配置已保存。')+(data.requiresRestart?' 端口变更需要重启服务。':''),'success');
}

function showAdminToast(message,kind){
  const old=document.getElementById('toast');if(old)old.remove();
  const el=document.createElement('div');el.id='toast';el.className='toast '+kind;el.textContent=message;document.body.appendChild(el);setTimeout(()=>el.remove(),3600);
}

document.getElementById('configGroups').addEventListener('input',e=>{const path=e.target.getAttribute('data-config-path');if(path)markConfigDirty(path)});
document.getElementById('configGroups').addEventListener('change',e=>{const path=e.target.getAttribute('data-config-path');if(path)markConfigDirty(path)});
window.addEventListener('popstate',()=>switchDashboardTab(new URLSearchParams(window.location.search).get('tab'),false));

loadConfig().then(()=>switchDashboardTab(dashboardTab,false)).catch(err=>{console.error(err);showAdminToast(err?.message||'后台配置加载失败。','error')});
