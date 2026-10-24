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
  // 核心层（无条件或只限工作区）经验需要用户原话明确说明适用全部文档；否则先按文档或类型记录，再经晋升确认扩大。
  if (Object.keys(scope).every(k => k === 'workspace') && input.category === 'method' && !generalExplicit) throw new Error('单个案例不能直接建立所有文档通用的经验，请限定 task 或 kind，跨文档通用需经晋升确认');
  if (input.category === 'fact' && !scope.task) throw new Error('个案事实必须限定到任务范围');
  if (input.category === 'preference' && !scope.task) {
    const explicit = input.scopeBasis === 'explicit' && evidence.some(e => /以后|今后|所有|一律|默认|这种|这类|always|all reports|by default|these reports/i.test(e.quote));
    if (!explicit) throw new Error('偏好扩大范围必须有明确表达范围的原始证据');
  }
  for (const s of sources) if (scopeMatch(scope, { ...s.context, task: s.task || s.context.task }) === 'no') throw new Error(`经验范围与证据场景矛盾：${input.key} / ${s.id}`);
  const rule = { key: input.key, value: input.value, text: input.text.trim(), category: input.category, strength: input.strength, scope, scopeBasis: input.scopeBasis || 'context', evidence, status: 'active', maturity: 'observed' };
  rule.id = hash({ key: rule.key, value: rule.value, scope, category: rule.category }).slice(0,24);
  return rule;
}
export function mergeLearning(state, payload = {}) {
  addSources(state, payload.sources || []);
  const changes = [];
  for(const revision of payload.revise || []) {
    const old=state.rules.find(r=>r.id===revision.id && r.status==='active');
    if(!old)throw new Error('修改目标不是有效经验');
    if(revision.scopeBasis!=='explicit' || !['suggestion','default','required'].includes(revision.strength))throw new Error('强度变更必须来自明确重定义，不能由重复次数推断');
    const evidence=verifyEvidence(state,revision.evidence);
    if(evidence.some(e=>scopeMatch(old.scope,state.sources[e.source].context)==='no'))throw new Error('其他场景的例外不能改写此范围的执行强度');
    const text=revision.text || old.text;
    if(typeof text!=='string'||!text.trim()||text.length>6000)throw new Error('经验修订正文无效');
    if(old.strength===revision.strength&&old.text===text)continue;
    if(!evidence.some(e=>!old.evidence.some(ref=>stable(ref)===stable(e))))throw new Error('相同证据不能被重新解释成新的强度指令');
    (old.revisions ||= []).push({from:old.strength,to:revision.strength,evidence});
    old.strength=revision.strength;old.text=text;
    for(const e of evidence)if(!old.evidence.some(ref=>stable(ref)===stable(e)))old.evidence.push(e);
    changes.push({id:old.id,action:'revise-explicit'});
  }
  for (const input of payload.rules || []) {
    const rule = normalizeRule(state, input);
    const old = state.rules.find(r => r.id === rule.id);
    if (old) {
      if (old.status === 'retired') { changes.push({ id: old.id, action: 'skip-retired' }); continue; }
      // 已晋升的旧规则不能被重复反馈复活；证据并入晋升后的规则。
      if (old.status === 'superseded') { const target=state.rules.find(r=>r.id===old.supersededBy&&r.status==='active'); if(target)for(const e of rule.evidence)if(!target.evidence.some(x=>stable(x)===stable(e)))target.evidence.push(e); changes.push({ id: old.id, action: 'skip-superseded', target: old.supersededBy }); continue; }
      const before = stable(old.evidence);
      for (const e of rule.evidence) if (!old.evidence.some(x => stable(x) === stable(e))) old.evidence.push(e);
      // Repetition cannot strengthen, broaden, or reactivate a rule.
      changes.push({ id: old.id, action: before === stable(old.evidence) ? 'skip' : 'merge-evidence' });
    } else { state.rules.push(rule); changes.push({ id: rule.id, action: 'create' }); }
  }
  for (const item of payload.attach || []) {
    // 把同一事实的新证据并入已有规则，而不是另建近义规则。
    let old = state.rules.find(r => r.id === item.id);
    if (old?.status === 'superseded') old = state.rules.find(r => r.id === old.supersededBy);
    if (!old || old.status !== 'active') throw new Error('证据合并目标不是有效经验');
    const evidence = verifyEvidence(state, item.evidence, { repository: old.category === 'policy' });
    for (const e of evidence) {
      const s = state.sources[e.source];
      if (scopeMatch(old.scope, { ...s.context, task: s.task || s.context.task }) === 'no') throw new Error(`合并证据与经验范围矛盾：${old.id} / ${s.id}`);
    }
    const before = stable(old.evidence);
    for (const e of evidence) if (!old.evidence.some(x => stable(x) === stable(e))) old.evidence.push(e);
    changes.push({ id: old.id, action: before === stable(old.evidence) ? 'skip' : 'merge-evidence' });
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
    r.tier=tierOf(r.scope);r.support=tasks.size;
    const conflicting=state.rules.some(other=>other.status==='active'&&other.id!==r.id&&other.key===r.key&&other.value!==r.value&&stable(other.scope)===stable(r.scope));
    r.maturity=conflicting?'conflicting':(tasks.size>1?'supported-in-several-tasks':(r.scope.task?'supported-in-scope':'observed'));
    r.exceptions=state.rules.filter(other=>other.status==='active'&&other.key===r.key&&other.value!==r.value&&narrower(other.scope,r.scope)).map(other=>other.id);
  }
  return changes;
}
export const applyLearning = (library, payload) => library.transact('learn', state => mergeLearning(state, payload));
// 用户手动撤销误收的经验：不需要会话原话，记录原因与时间；已撤销的规则不会被同 key 的新反馈复活。
export function retireRules(state, ids, reason) {
  if (!ids.length) throw new Error('retire 需要至少一个 --id 经验标识');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('retire 需要 --reason 撤销原因');
  const at = new Date().toISOString(), changes = [];
  for (const id of ids) {
    const rule = state.rules.find(r => r.id === id);
    if (!rule) throw new Error(`未找到经验：${id}`);
    if (rule.status === 'retired') { changes.push({ id, action: 'already-retired' }); continue; }
    if (rule.status !== 'active') throw new Error(`经验 ${id} 当前状态为 ${rule.status}，只能撤销有效经验`);
    rule.status = 'retired'; rule.retirement = { manual: true, reason: reason.trim(), at };
    changes.push({ id, action: 'retire' });
  }
  return changes;
}

// 核心层：无条件或只限工作区；文档类型层：不含 task；单份文档层：含 task。
export function tierOf(scope = {}) {
  const keys = Object.keys(scope);
  if (!keys.length || keys.every(k => k === 'workspace')) return 'core';
  return scope.task ? 'doc' : 'type';
}
// 支持度只按证据覆盖的不同文档计，同一文档的重复反馈不增加支持度。
export const support = (state, rule) => new Set(rule.evidence.map(e => state.sources[e.source]?.task).filter(Boolean)).size;
export function refreshMaturity(state) { return mergeLearning(state, {}); }

// 来源范围是否落在目标范围内。单份文档的规则只写了 task，其文档类型等条件取自证据来源的场景。
function within(state, rule, scope) {
  if (stable(rule.scope) === stable(scope) || narrower(rule.scope, scope)) return true;
  if (!rule.scope.task) return false;
  const contexts = rule.evidence.map(e => state.sources[e.source]?.context || {});
  return Object.entries(scope).every(([k, v]) => rule.scope[k] !== undefined ? values(rule.scope[k]).every(x => values(v).includes(x)) : contexts.every(c => c[k] !== undefined && values(c[k]).every(x => values(v).includes(x))));
}
export function validatePromotion(state, proposal, { minDocsForType = 2, minDocsForCore = 3 } = {}) {
  if (!Array.isArray(proposal.from) || proposal.from.length < 1) throw new Error('晋升提案缺少来源经验');
  const rules = [...new Set(proposal.from)].map(id => state.rules.find(r => r.id === id));
  if (rules.some(r => !r || r.status !== 'active')) throw new Error('晋升来源必须是有效经验');
  if (typeof proposal.text !== 'string' || !proposal.text.trim() || proposal.text.length > 6000) throw new Error('晋升提案缺少合并后的经验正文');
  if (!['suggestion','default','required'].includes(proposal.strength)) throw new Error('晋升提案的执行强度无效');
  const scope = normalizeScope(proposal.scope || {});
  if (scope.task) throw new Error('晋升目标不能限定到单份文档');
  for (const r of rules) if (!within(state, r, scope)) throw new Error(`晋升目标范围必须覆盖来源经验：${r.id}`);
  if (rules.every(r => stable(r.scope) === stable(scope))) throw new Error('晋升目标范围必须比来源经验更宽');
  const evidence = [];
  for (const r of rules) for (const e of r.evidence) if (!evidence.some(x => stable(x) === stable(e))) evidence.push(e);
  for (const e of evidence) {
    const s = state.sources[e.source];
    if (s && scopeMatch(scope, { ...s.context, task: undefined }) === 'no') throw new Error(`晋升范围与证据场景矛盾：${s.id}`);
  }
  const tasks = new Set(evidence.map(e => state.sources[e.source]?.task).filter(Boolean));
  const tier = tierOf(scope), required = tier === 'core' ? minDocsForCore : minDocsForType;
  if (tasks.size < required) throw new Error(`晋升到${tier === 'core' ? '核心' : '文档类型'}层至少需要 ${required} 份文档的证据，当前 ${tasks.size} 份`);
  const categories = new Set(rules.map(r => r.category));
  if (categories.has('fact')) throw new Error('个案事实不能晋升');
  // 晋升不能把来源中最弱的要求强化。
  const rank = { suggestion: 0, default: 1, required: 2 };
  if (rank[proposal.strength] > Math.min(...rules.map(r => rank[r.strength]))) throw new Error('晋升强度不能高于来源经验');
  return { rules, scope, evidence, tier, tasks: tasks.size, category: categories.size === 1 ? rules[0].category : (categories.has('constraint') ? 'constraint' : rules[0].category) };
}
export function applyPromotion(state, proposalId, confirmationEvidence, options = {}) {
  const proposal = (state.proposals || []).find(p => p.id === proposalId);
  if (!proposal || proposal.status !== 'pending') throw new Error('晋升提案不存在或已处理');
  const refs = Array.isArray(confirmationEvidence) ? confirmationEvidence : [confirmationEvidence];
  const confirmation = refs.map(ref => typeof ref === 'string' ? { source: ref } : ref).map(ref => {
    const s = state.sources[ref.source];
    // 确认只认原始用户输入（问答回答或用户消息），助手文本与回放输出都不算。
    if (!s || s.role !== 'user' || s.origin === 'replay-output') throw new Error('晋升确认必须来自用户的原始回答');
    // 只认提问工具的回答，且不能是来源经验自身的证据或提案提出之前的回答。
    if (s.origin !== 'user-question') throw new Error('晋升确认必须是用户在提问工具中的回答');
    if ((proposal.from || []).some(id => state.rules.find(r => r.id === id)?.evidence.some(e => e.source === s.id))) throw new Error('晋升确认不能引用来源经验的证据');
    if (proposal.at && s.at && s.at < proposal.at) throw new Error('晋升确认早于提案，不能作为本提案的同意');
    if (ref.quote !== undefined && (typeof ref.quote !== 'string' || !s.text.includes(ref.quote))) throw new Error('确认引文与原始来源不一致');
    return { source: s.id, quote: ref.quote ?? s.text.slice(0, 500) };
  });
  if (!confirmation.length) throw new Error('晋升需要用户确认');
  const checked = validatePromotion(state, proposal, options);
  const first = checked.rules[0];
  const key = proposal.key || first.key, value = proposal.value || first.value;
  const rule = { key, value, text: proposal.text.trim(), category: checked.category, strength: proposal.strength, scope: checked.scope, scopeBasis: 'promoted', evidence: checked.evidence, status: 'active', maturity: 'observed', promotion: { proposal: proposal.id, from: checked.rules.map(r => r.id), confirmation, at: new Date().toISOString() } };
  rule.id = hash({ key, value, scope: rule.scope, category: rule.category }).slice(0, 24);
  const existing = state.rules.find(r => r.id === rule.id);
  if (existing && existing.status !== 'active') throw new Error('目标经验已停用或已被替代，不能通过晋升复活');
  if (existing) { for (const e of rule.evidence) if (!existing.evidence.some(x => stable(x) === stable(e))) existing.evidence.push(e); existing.promotion = rule.promotion; }
  else state.rules.push(rule);
  // 比晋升结果更强的来源（如类型层 required）保留原样，只替代不强于结果的来源。
  const rank = { suggestion: 0, default: 1, required: 2 }, replaced = checked.rules.filter(r => r.id !== rule.id && rank[r.strength] <= rank[rule.strength]);
  for (const r of replaced) { r.status = 'superseded'; r.supersededBy = rule.id; r.supersededAt = rule.promotion.at; }
  for (const o of state.observations) if (o.status === 'observed' && o.evidence.some(e => rule.evidence.some(x => x.source === e.source)) && narrower(o.scope, rule.scope)) { o.status = 'promoted'; o.promotedTo = rule.id; }
  proposal.status = 'applied'; proposal.result = rule.id; proposal.confirmation = confirmation;
  refreshMaturity(state);
  return { id: rule.id, superseded: replaced.map(r => r.id), kept: checked.rules.filter(r => r.id !== rule.id && !replaced.includes(r)).map(r => r.id), tier: checked.tier, support: checked.tasks };
}

export function narrower(a, b) {
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
    // A task-only method has no evidence about its transfer boundary. Do not
    // recommend it to every document simply because it was inserted first.
    return Object.keys(remaining).some(k=>!['workspace','customer','template'].includes(k)) && scopeMatch(remaining,context)==='yes';
  }).sort((a,b)=>Object.keys(b.scope).length-Object.keys(a.scope).length || a.key.localeCompare(b.key)).slice(0,4).map(r=>({...r,strength:'suggestion',requiresAdaptation:true,originalScope:r.scope}));
  return { apply: apply.slice(0,limit), conflicts, transfer, uncertain: matches.filter(x => x.match === 'unknown').map(x => x.rule).slice(0,limit), omitted: Math.max(0, apply.length - limit) };
}
