import {join} from 'node:path';
import {readJson,writeJson,exists} from './io.mjs';

// 用户可编辑的配置。以 "_" 开头的键只作说明，读取时忽略。
export const defaults={
 schedule:{intervalMinutes:120,runAtLogon:true},
 consolidate:{minSessions:3,maxWaitHours:24,maxSessionsPerRun:20,model:null,effort:'high',baseUrl:null,apiKey:null},
 sources:{claude:true,codex:true,excludePaths:['*codeg-acp*','*workflow*','*\\Temp\\*']},
 judge:{provider:'jev',documentThreshold:0.85,model:'jev-latest',baseUrl:null,apiKey:null},
 manual:{maxChars:3000},
 hooks:{documentSkills:['docx','pptx','xlsx','pdf','officecli','doc-coauthoring','dispensing-test-report','customer-site-report','customer-cleaning-instructions','exploratory-experiment-report']},
 promotion:{minDocsForType:2,minDocsForCore:3}
};
const notes={
 _说明:'修改 schedule 后需重新运行 install 才会更新计划任务；其余字段在下次运行时生效。各字段含义见 README“配置文件”一节。',
 _schedule:'intervalMinutes：后台整理检查间隔（分钟）；runAtLogon：登录时也检查一次。',
 _consolidate:'minSessions：待整理会话达到该数量才调用模型；maxWaitHours：有待整理会话且距上次整理超过该小时数也会整理；maxSessionsPerRun：单次最多处理的会话数；model：整理模型，null 跟随 ~/.claude/settings.json；effort：整理模型的推理强度（low/medium/high/xhigh/max）；baseUrl/apiKey：只给整理进程使用的 Anthropic 兼容网关地址与密钥（如本机 magpie），null 跟随 ~/.claude/settings.json。apiKey 以明文保存，真实密钥请用环境变量。',
 _sources:'claude/codex：是否扫描对应宿主的会话文件；excludePaths：按完整路径排除的通配模式（* 匹配任意字符，不区分大小写）。',
 _judge:'provider：jev 使用 Jev 判断，none 全部交给整理模型；documentThreshold：Jev 自动判定所需的最低概率；model：Jev 模型（jev-latest 为稳定别名）；baseUrl/apiKey：只给 Jev 使用的 TypeSafe 兼容网关（如本机 magpie http://127.0.0.1:3425），null 时从环境变量 TYPESAFE_API_KEY 等读取凭据。',
 _manual:'maxChars：单个经验手册的最大字数，超出时按排序截断尾部。',
 _hooks:'documentSkills：进入这些文档技能时，PostToolUse 提醒先读个人经验手册；个人技能目录下的技能也会自动识别，document-learning 自身不提醒。',
 _promotion:'minDocsForType：晋升到文档类型层所需的最少文档数；minDocsForCore：晋升到核心层所需的最少文档数。'
};
export const configPath=base=>join(base,'config.json');

const positiveInt=(v,field)=>{if(!Number.isSafeInteger(v)||v<1)throw new Error(`配置 ${field} 必须是正整数`);};
const bool=(v,field)=>{if(typeof v!=='boolean')throw new Error(`配置 ${field} 必须是 true 或 false`);};
export function validateConfig(raw) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('配置文件必须是 JSON 对象');
 const config=structuredClone(defaults);
 for(const [section,value] of Object.entries(raw)) {
  if(section.startsWith('_'))continue;
  if(!Object.hasOwn(defaults,section))throw new Error(`未知配置字段：${section}`);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`配置 ${section} 必须是对象`);
  for(const [key,v] of Object.entries(value)) {
   if(key.startsWith('_'))continue;
   if(!Object.hasOwn(defaults[section],key))throw new Error(`未知配置字段：${section}.${key}`);
   config[section][key]=v;
  }
 }
 const c=config;
 positiveInt(c.schedule.intervalMinutes,'schedule.intervalMinutes');if(c.schedule.intervalMinutes>1439)throw new Error('配置 schedule.intervalMinutes 不能超过 1439（schtasks 的分钟间隔上限）');bool(c.schedule.runAtLogon,'schedule.runAtLogon');
 positiveInt(c.consolidate.minSessions,'consolidate.minSessions');positiveInt(c.consolidate.maxWaitHours,'consolidate.maxWaitHours');positiveInt(c.consolidate.maxSessionsPerRun,'consolidate.maxSessionsPerRun');
 if(c.consolidate.model!==null&&(typeof c.consolidate.model!=='string'||!c.consolidate.model.trim()))throw new Error('配置 consolidate.model 必须是模型名或 null');
 if(!['low','medium','high','xhigh','max'].includes(c.consolidate.effort))throw new Error('配置 consolidate.effort 只能为 low、medium、high、xhigh 或 max');
 if(c.consolidate.baseUrl!==null&&(typeof c.consolidate.baseUrl!=='string'||!/^https?:\/\/\S+$/.test(c.consolidate.baseUrl)))throw new Error('配置 consolidate.baseUrl 必须是 http(s) 地址或 null');
 if(c.consolidate.apiKey!==null&&(typeof c.consolidate.apiKey!=='string'||!c.consolidate.apiKey))throw new Error('配置 consolidate.apiKey 必须是非空字符串或 null');
 bool(c.sources.claude,'sources.claude');bool(c.sources.codex,'sources.codex');
 if(!Array.isArray(c.sources.excludePaths)||c.sources.excludePaths.some(p=>typeof p!=='string'||!p))throw new Error('配置 sources.excludePaths 必须是非空字符串数组');
 if(!['jev','none'].includes(c.judge.provider))throw new Error('配置 judge.provider 只能为 jev 或 none');
 if(typeof c.judge.documentThreshold!=='number'||!(c.judge.documentThreshold>0.5&&c.judge.documentThreshold<=1))throw new Error('配置 judge.documentThreshold 必须在 0.5 与 1 之间');
 if(typeof c.judge.model!=='string'||!c.judge.model.trim())throw new Error('配置 judge.model 必须是模型名');
 if(c.judge.baseUrl!==null&&(typeof c.judge.baseUrl!=='string'||!/^https?:\/\/\S+$/.test(c.judge.baseUrl)))throw new Error('配置 judge.baseUrl 必须是 http(s) 地址或 null');
 if(c.judge.apiKey!==null&&(typeof c.judge.apiKey!=='string'||!c.judge.apiKey))throw new Error('配置 judge.apiKey 必须是非空字符串或 null');
 positiveInt(c.manual.maxChars,'manual.maxChars');
 if(!Array.isArray(c.hooks.documentSkills)||c.hooks.documentSkills.some(s=>typeof s!=='string'||!s.trim()))throw new Error('配置 hooks.documentSkills 必须是非空字符串数组');
 // 与 hooks.mjs 的比较一致：统一去掉首尾空格，避免 `" docx "` 这类配置静默失效。
 c.hooks.documentSkills=c.hooks.documentSkills.map(s=>s.trim());
 positiveInt(c.promotion.minDocsForType,'promotion.minDocsForType');positiveInt(c.promotion.minDocsForCore,'promotion.minDocsForCore');
 return config;
}
export async function loadConfig(base) {
 const raw=await readJson(configPath(base),null);
 return validateConfig(raw || {});
}
export async function writeDefaultConfig(base) {
 const path=configPath(base);
 if(await exists(path))return {path,created:false};
 const commented=Object.fromEntries([['_说明',notes._说明],...Object.entries(defaults).flatMap(([k,v])=>[[k,{_说明:notes[`_${k}`],...v}]])]);
 await writeJson(path,commented);
 return {path,created:true};
}
