import { hash, stable } from './io.mjs';

export const dimensions = ['task','kind','purpose','audience','customer','template','format','process','object','workspace','skill'];
const categories = ['method','preference','fact','constraint','policy'];
const values = v => Array.isArray(v) ? v : [v];
export function scopeMatch(scope, context) {
  let unknown = false;
  for (const [key, expected] of Object.entries(scope)) {
    if (context[key] === undefined || context[key] === null || context[key] === '') unknown = true;
    else if (!values(expected).some(v => values(context[key]).includes(v))) return 'no';
  }
  return unknown ? 'unknown' : 'yes';
}
export function normalizeScope(scope = {}) {
  if (!scope || Array.isArray(scope) || typeof scope !== 'object') throw new Error('经验范围必须是对象');
  const normalized = {};
  for (const [key, value] of Object.entries(scope)) {
    if (!dimensions.includes(key) || !values(value).length || values(value).some(v => typeof v !== 'string' || !v.trim() || v.length > 500)) throw new Error(`无效的经验范围：${key}`);
    normalized[key] = Array.isArray(value) ? [...new Set(value)].sort() : value;
  }
  return normalized;
}
export function addSources(state, sources) {
  for (const incoming of sources) {
    if (typeof incoming.id!=='string' || !incoming.id || ['__proto__','constructor','prototype'].includes(incoming.id) || !incoming.text || typeof incoming.text !== 'string' || !incoming.role) throw new Error('来源缺少有效的 ID、角色或正文');
    const {digest: _digest, ...raw} = incoming;
    const source = { ...raw, context: incoming.context || {} };
    const digest = hash(source);
    const old = state.sources[source.id];
    if (old && old.digest !== digest) throw new Error(`来源 ID 内容冲突：${source.id}`);
    if (!old) state.sources[source.id] = { ...source, digest };
  }
}
export function verifyEvidence(state, evidence, { repository = false } = {}) {
  if (!Array.isArray(evidence) || !evidence.length) throw new Error('经验必须有原始证据');
  return evidence.map(ref => {
    const s = state.sources[ref.source];
    if (!s || s.origin === 'replay-output' || !['user', ...(repository ? ['repository'] : [])].includes(s.role)) throw new Error('经验的证据必须来自原始用户反馈或明确的仓库政策');
    if (typeof ref.quote !== 'string' || ref.quote.trim().length < 2 || !s.text.includes(ref.quote)) throw new Error('证据引文与原始来源不一致');
    return { source: ref.source, quote: ref.quote };
  });
}
function normalizeRule(state, input) {
  if (!/^[\w.-]{1,120}$/.test(input.key || '')) throw new Error('经验 key 必须为 1-120 位英文、数字、点、横线或下划线');
  if (typeof input.text!=='string' || !input.text.trim() || input.text.length>6000) throw new Error('经验 text 必须为非空字符串，最长 6000 字符');
  if (typeof input.value!=='string' || !input.value.length) throw new Error('经验 value 必须为非空字符串，不能使用布尔值、数组或对象');
  if (!categories.includes(input.category) || !['suggestion','default','required'].includes(input.strength)) throw new Error('无效的经验类别或执行强度');
  const scope = normalizeScope(input.scope);
  const evidence = verifyEvidence(state, input.evidence, { repository: input.category === 'policy' });
  const sources = evidence.map(e => state.sources[e.source]);
  const generalExplicit = input.scopeBasis === 'explicit' && evidence.some(e=>/所有|一律|全局|任何|个人默认|all (?:documents|reports|tasks)|always/i.test(e.quote));
  if (!Object.keys(scope).length && input.category !== 'method' && !generalExplicit) throw new Error('经验缺少适用范围');
  if (!Object.keys(scope).length && input.category === 'method' && input.strength === 'required' && !generalExplicit) throw new Error('单个案例不能建立无条件强制的方法');
  if (input.category === 'fact' && !scope.task) throw new Error('个案事实必须限定到任务范围');
  if (input.category === 'preference' && !scope.task) {
    const explicit = input.scopeBasis === 'explicit' && evidence.some(e => /以后|今后|所有|一律|默认|这种|这类|always|all reports|by default|these reports/i.test(e.quote));
    if (!explicit) throw new Error('偏好扩大范围必须有明确表达范围的原始证据');
  }
  for (const s of sources) if (scopeMatch(scope, { ...s.context, task: s.task || s.context.task }) === 'no') throw new Error('经验范围与证据场景矛盾');
  const rule = { key: input.key, value: input.value, text: input.text.trim(), category: input.category, strength: input.strength, scope, scopeBasis: input.scopeBasis || 'context', evidence, status: 'active', maturity: 'observed' };
  rule.id = hash({ key: rule.key, value: rule.value, scope, category: rule.category }).slice(0,24);
  return rule;
}
export function mergeLearning(state, payload = {}) {
  addSources(state, payload.sources || []);
  const changes = [];
  for (const input of payload.rules || []) {
    const rule = normalizeRule(state, input);
    const old = state.rules.find(r => r.id === rule.id);
    if (old) {
      if (old.status === 'retired') { changes.push({ id: old.id, action: 'skip-retired' }); continue; }
      const before = stable(old.evidence);
      for (const e of rule.evidence) if (!old.evidence.some(x => stable(x) === stable(e))) old.evidence.push(e);
      // Repetition cannot strengthen, broaden, or reactivate a rule.
      changes.push({ id: old.id, action: before === stable(old.evidence) ? 'skip' : 'merge-evidence' });
    } else { state.rules.push(rule); changes.push({ id: rule.id, action: 'create' }); }
  }
  for (const retirement of payload.retire || []) {
    verifyEvidence(state, retirement.evidence);
    const old = state.rules.find(r => r.id === retirement.id);
    if (!old) throw new Error('撤销目标不存在');
    if (!retirement.scope || stable(normalizeScope(retirement.scope)) !== stable(old.scope)) throw new Error('撤销范围与原经验不一致');
    if (!retirement.evidence.some(e=>/撤销|作废|不再|停用|取消|更正|搞反|改为|retire|no longer|supersede|correct/i.test(e.quote))) throw new Error('撤销需要明确的撤销或纠正表达，本次相反偏好先作为例外保存');
    if (scopeMatch(old.scope, state.sources[retirement.evidence[0].source].context) === 'no') throw new Error('本次例外不能撤销另一场景的经验');
    old.status = 'retired'; old.retirement = retirement.evidence;
  }
  for (const item of payload.observations || []) {
    verifyEvidence(state, item.evidence);
    const observation = { text: item.text, scope: normalizeScope(item.scope), evidence: item.evidence, status: 'observed' };
    const id = hash(observation).slice(0,24);
    if (!state.observations.some(o => o.id === id)) state.observations.push({ id, ...observation });
  }
  for(const r of state.rules) {
    if(r.status!=='active')continue;
    const tasks=new Set(r.evidence.map(e=>state.sources[e.source].task).filter(Boolean));
    const conflicting=state.rules.some(other=>other.status==='active'&&other.id!==r.id&&other.key===r.key&&other.value!==r.value&&stable(other.scope)===stable(r.scope));
    r.maturity=conflicting?'conflicting':(tasks.size>1?'supported-in-several-tasks':(r.scope.task?'supported-in-scope':'observed'));
    r.exceptions=state.rules.filter(other=>other.status==='active'&&other.key===r.key&&other.value!==r.value&&narrower(other.scope,r.scope)).map(other=>other.id);
  }
  return changes;
}
export const applyLearning = (library, payload) => library.transact('learn', state => mergeLearning(state, payload));

function narrower(a, b) {
  return Object.entries(b).every(([k, v]) => a[k] !== undefined && values(a[k]).every(x => values(v).includes(x))) && stable(a) !== stable(b);
}
export async function retrieve(library, context, { limit = 30 } = {}) {
  const state = await library.read();
  const matches = state.rules.filter(r => r.status === 'active').map(rule => ({ rule, match: scopeMatch(rule.scope, context) }));
  const applicable = matches.filter(x => x.match === 'yes').map(x => x.rule);
  const groups = new Map();
  for (const r of applicable) { if (!groups.has(r.key)) groups.set(r.key, []); groups.get(r.key).push(r); }
  const apply = [], conflicts = [];
  for (const [key, rules] of groups) {
    if (context.requirements && Object.hasOwn(context.requirements, key)) {
      apply.push({ key, value: String(context.requirements[key]), text: '按当前明确需求执行', scope: { task: context.task }, strength: 'required', current: true });
      continue;
    }
    const selected = rules.filter(r => !rules.some(other => narrower(other.scope, r.scope)));
    if (new Set(selected.map(r => r.value)).size > 1) conflicts.push({ key, rules: selected, reason: '适用范围相交且选择相反，需要当前需求或明确撤销依据' });
    else apply.push(...selected);
  }
  const transfer=matches.filter(x=>x.match==='no'&&x.rule.category==='method'&&x.rule.scope.task&&x.rule.scope.task!==context.task).map(x=>x.rule).filter(r=>{
    const {task,...remaining}=r.scope;
    return scopeMatch(remaining,context)!=='no';
  }).slice(0,4).map(r=>({...r,strength:'suggestion',requiresAdaptation:true,originalScope:r.scope}));
  return { apply: apply.slice(0,limit), conflicts, transfer, uncertain: matches.filter(x => x.match === 'unknown').map(x => x.rule).slice(0,limit), omitted: Math.max(0, apply.length - limit) };
}
