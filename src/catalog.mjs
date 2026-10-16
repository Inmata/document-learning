import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {atomicWrite,writeJson,exists,fingerprint} from './io.mjs';
import {prepareCommit,commitPublished} from './versioning.mjs';

const escape=s=>String(s ?? '').replaceAll('|','／').replaceAll('\n',' ');
const categories={method:'制作方法',preference:'条件偏好',constraint:'操作约束',policy:'调用与维护规则',fact:'案例事实'};
const repoSkillsStart='<!-- document-learning:repo-skills:start -->';
const repoSkillsEnd='<!-- document-learning:repo-skills:end -->';
function sourceLines(state,evidence=[]){return evidence.map(e=>{const s=state.sources[e.source];return `- 原文：${e.quote}\n  来源：${s?.path || s?.id || e.source}${s?.commit?`；提交 ${s.commit}`:''}`;}).join('\n');}

export function renderRepoSkillTable(state, skillDir) {
 const byName=new Map();
 for(const s of Object.values(state.sourceSkills || {})) {
  if(s.path && resolve(s.path,'..','..')===resolve(skillDir))byName.set(s.name,{name:s.name,title:s.title || s.name,description:s.description || '',implicit:s.implicit!==false});
 }
 for(const s of Object.values(state.skills || {})) {
  if(s.status==='active')byName.set(s.name,{name:s.name,title:s.title || s.name,description:s.description || `适用条件：${JSON.stringify(s.scope)}`,implicit:s.implicit!==false});
 }
 const rows=[...byName.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(s=>`| [${escape(s.title)}](${s.name}/README.md) | ${escape(s.description || '见技能说明')} | \`$${s.name}\`（${s.implicit?'自动匹配／显式调用':'仅显式调用'}） |`);
 return `${repoSkillsStart}\n| 技能与使用指南 | 用途与适用范围 | 调用标识与方式 |\n| --- | --- | --- |\n${rows.join('\n') || '| 暂无技能 | - | - |'}\n${repoSkillsEnd}`;
}

export async function exportCatalog(library,{skillDirectory}={}) {
 const state=await library.read(),active=state.rules.filter(r=>r.status==='active'&&r.category!=='fact');
 const sections=active.map(r=>`## ${r.text}\n\n- 类别：${categories[r.category]}；执行强度：${r.strength}\n- 适用条件：${JSON.stringify(r.scope)}\n- 不自动扩大到条件之外；当前明确需求优先。\n- 标识：${r.id}\n\n${sourceLines(state,r.evidence)}\n`);
 const skills=Object.values(state.skills).filter(s=>s.status==='active');
 const index=`# 个人文档经验\n\n这里只列可供后续文档参考的经验；案例参数与临时任务状态分开保存。\n\n当前有效经验 ${active.length} 条，个人技能 ${skills.length} 个。\n\n## 个人技能\n\n${skills.map(s=>`- [${s.title}](${s.path.replaceAll('\\','/')})：适用 ${JSON.stringify(s.scope)}`).join('\n') || '尚无已发布技能。'}\n\n${sections.join('\n')}`;
 await atomicWrite(join(library.root,'knowledge','index.md'),index);
 const cases=state.rules.filter(r=>r.category==='fact'||r.status==='archived');
 const casesText=`# 案例与历史归档\n\n案例事实和已替代记录不作为跨文档通用规范。原始证据始终保留；临时状态仅用于理解历史。\n\n${cases.map(r=>`## ${r.text}\n\n范围：${JSON.stringify(r.scope)}；状态：${r.status}\n\n${sourceLines(state,r.evidence)}\n`).join('\n')}`;
 await atomicWrite(join(library.root,'cases','index.md'),casesText);
 const skillDir=resolve(skillDirectory || library.skillDirectory || join(library.root,'skills'));
 const defaultSkillDir=resolve(library.root,'skills');
 if(skillDir!==defaultSkillDir) {
  const repoKnowledge=join(skillDir,'knowledge','index.md');
  const repoCases=join(skillDir,'cases','index.md');
  const repoMemory=join(skillDir,'knowledge','memory.json');
  const repoReadme=join(skillDir,'README.md');
  const tracked=[repoKnowledge,repoCases,repoMemory,...((await exists(repoReadme))?[repoReadme]:[])];
  const prepared=await prepareCommit(skillDir,tracked);
  const repoIndex=`# 个人文档经验\n\n这里只列可供后续文档参考的经验；案例参数与临时任务状态分开保存。\n\n当前有效经验 ${active.length} 条，个人技能 ${skills.length} 个。\n\n## 个人技能\n\n${skills.map(s=>`- [${s.title}](../${s.name}/SKILL.md)：适用 ${JSON.stringify(s.scope)}`).join('\n') || '尚无已发布技能。'}\n\n${sections.join('\n')}`;
  const portableSkills={};
  for(const [name,s] of Object.entries(state.skills || {})) {
   const {path:_p,...rest}=s;
   portableSkills[name]={...rest,relativePath:`${name}/SKILL.md`};
  }
  const portableSourceSkills={};
  for(const [name,s] of Object.entries(state.sourceSkills || {})) {
   const {path:_p,...rest}=s;
   portableSourceSkills[name]={...rest,relativePath:`${name}/SKILL.md`};
  }
  await atomicWrite(repoKnowledge,repoIndex);
  await atomicWrite(repoCases,casesText);
  await writeJson(repoMemory,{schema:1,rules:state.rules,observations:state.observations,skills:portableSkills,sourceSkills:portableSourceSkills,sources:state.sources});
  const committedFiles={[repoKnowledge]:await fingerprint(repoKnowledge),[repoCases]:await fingerprint(repoCases),[repoMemory]:await fingerprint(repoMemory)};
  if(await exists(repoReadme)) {
   const currentReadme=await readFile(repoReadme,'utf8');
   if(currentReadme.includes(repoSkillsStart)&&currentReadme.includes(repoSkillsEnd)) {
    const nextReadme=currentReadme.slice(0,currentReadme.indexOf(repoSkillsStart))+renderRepoSkillTable(state,skillDir)+currentReadme.slice(currentReadme.indexOf(repoSkillsEnd)+repoSkillsEnd.length);
    if(nextReadme!==currentReadme) {
     await atomicWrite(repoReadme,nextReadme);
     committedFiles[repoReadme]=await fingerprint(repoReadme);
    }
   }
  }
  await commitPublished(prepared,committedFiles,{libraryRoot:library.root,name:'knowledge-catalog'});
  return {knowledge:repoKnowledge,cases:repoCases,memory:repoMemory,rules:active.length,skills:skills.length};
 }
 return {knowledge:join(library.root,'knowledge','index.md'),cases:join(library.root,'cases','index.md'),rules:active.length,skills:skills.length};
}
export function comparisonMarkdown(rows) {
 return '| 测试任务 | 直接适用经验 | 类比方法 | 匹配技能 |\n|---|---|---|---|\n'+rows.map(r=>`| ${escape(r.label)} | ${escape(r.apply.join('；')||'无')} | ${escape(r.transfer.join('；')||'无')} | ${escape(r.skills.join('；')||'无')} |`).join('\n');
}
