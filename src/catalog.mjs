import {join} from 'node:path';
import {atomicWrite} from './io.mjs';

const escape=s=>String(s ?? '').replaceAll('|','／').replaceAll('\n',' ');
const categories={method:'制作方法',preference:'条件偏好',constraint:'操作约束',policy:'调用与维护规则',fact:'案例事实'};
function sourceLines(state,evidence=[]){return evidence.map(e=>{const s=state.sources[e.source];return `- 原文：${e.quote}\n  来源：${s?.path || s?.id || e.source}${s?.commit?`；提交 ${s.commit}`:''}`;}).join('\n');}
export async function exportCatalog(library) {
 const state=await library.read(),active=state.rules.filter(r=>r.status==='active'&&r.category!=='fact');
 const sections=active.map(r=>`## ${r.text}\n\n- 类别：${categories[r.category]}；执行强度：${r.strength}\n- 适用条件：${JSON.stringify(r.scope)}\n- 不自动扩大到条件之外；当前明确需求优先。\n- 标识：${r.id}\n\n${sourceLines(state,r.evidence)}\n`);
 const skills=Object.values(state.skills).filter(s=>s.status==='active');
 const index=`# 个人文档经验\n\n这里只列可供后续文档参考的经验；案例参数与临时任务状态分开保存。\n\n当前有效经验 ${active.length} 条，个人技能 ${skills.length} 个。\n\n## 个人技能\n\n${skills.map(s=>`- [${s.title}](${s.path.replaceAll('\\','/')})：适用 ${JSON.stringify(s.scope)}`).join('\n') || '尚无已发布技能。'}\n\n${sections.join('\n')}`;
 await atomicWrite(join(library.root,'knowledge','index.md'),index);
 const cases=state.rules.filter(r=>r.category==='fact'||r.status==='archived');
 await atomicWrite(join(library.root,'cases','index.md'),`# 案例与历史归档\n\n案例事实和已替代记录不作为跨文档通用规范。原始证据始终保留；临时状态仅用于理解历史。\n\n${cases.map(r=>`## ${r.text}\n\n范围：${JSON.stringify(r.scope)}；状态：${r.status}\n\n${sourceLines(state,r.evidence)}\n`).join('\n')}`);
 return {knowledge:join(library.root,'knowledge','index.md'),cases:join(library.root,'cases','index.md'),rules:active.length,skills:skills.length};
}
export function comparisonMarkdown(rows) {
 return '| 测试任务 | 直接适用经验 | 类比方法 | 匹配技能 |\n|---|---|---|---|\n'+rows.map(r=>`| ${escape(r.label)} | ${escape(r.apply.join('；')||'无')} | ${escape(r.transfer.join('；')||'无')} | ${escape(r.skills.join('；')||'无')} |`).join('\n');
}
