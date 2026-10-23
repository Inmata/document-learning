import { readFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite, fingerprint, inside, hash, withLock, writeJson, readJson, exists } from './io.mjs';
import { verifyEvidence, normalizeScope, scopeMatch } from './knowledge.mjs';
import {prepareCommit,commitPublished} from './versioning.mjs';
import {safeName} from './catalog.mjs';

const start = '<!-- document-learning:start -->';
const end = '<!-- document-learning:end -->';
const readmeMarker = '<!-- document-learning:readme -->';
const reservedNames = new Set(['notes','docs','assets','scripts','tests','examples','history','cases','knowledge','versions','publish','skill-backups']);
const documentSkillTerms = /报告|文档|说明书|作业指导|图注|版式|母版|模板|合同|信函|提案|汇报|清洗|实验|现场|docx|pptx|xlsx|report|presentation|document|spreadsheet|contract|letter|proposal|\bsop\b|\bword\b|\bpowerpoint\b/i;
const slug = name => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);

export function renderSkillReadme({ name, title, description, scope, positive = [], negative = [], body = '' }, { implicit = true } = {}) {
  const display = title || name;
  const invokeNote = implicit
    ? `满足适用条件时可由文档学习自动匹配，也可通过 \`$${name}\` 明确调用。`
    : `本技能仅在用户明确指定使用时启动，例如 \`$${name} 整理当前目录资料\`。`;
  const cleanBody = body.replace(start, '').replace(end, '').replace(/^## 持续学习的适用经验\s+当前明确需求优先于下列历史经验。保留各条的适用范围。\s*(?:制作前先读个人经验手册[^\n]*\n)?\s*/m, '').trim();
  return `${readmeMarker}
# ${display}

${description}

调用标识是 \`$${name}\`，界面显示名是“${display}”。${invokeNote}

## 适用范围

- 适用条件：\`${JSON.stringify(scope || {})}\`
${positive.length ? `- 典型适用场景：\`${JSON.stringify(positive[0])}\`\n` : ''}${negative.length ? `- 相近不适用场景：\`${JSON.stringify(negative[0])}\`\n` : ''}
## 先准备什么

| 输入 | 怎么准备 |
| --- | --- |
| 工作目录 | 把本次任务的原始记录、参考资料与现场或实验图片放入当前工作目录，或提供明确路径 |
| 任务要求 | 说明文档读者、用途、交付格式及本次必须保留或省略的内容 |
| 现有成稿 | 若修订已有文档，指出最新文件位置及需要保留的手工修改 |

## 如何开始

复制并按实际任务替换路径与要求：

~~~text
$${name} 读取当前目录的资料，先核对已知事实并询问影响正文的缺项，再按本技能流程完成文档。
~~~

## 流程与验收要点

${cleanBody || '按 SKILL.md 中的步骤核对原始资料、组织结构并执行交付检查。'}
`;
}

export function validateSkillProposal(state, proposal) {
  if (!slug(proposal.name)) throw new Error('无效的技能标识');
  if (reservedNames.has(proposal.name)) throw new Error('不能使用保留目录名作为技能标识');
  if (!proposal.description?.trim() || proposal.description.length > 500 || !proposal.body?.trim()) throw new Error('技能缺少用途或流程');
  verifyEvidence(state, proposal.evidence);
  const scope = normalizeScope(proposal.scope);
  if (!Object.keys(scope).length) throw new Error('新技能必须有明确的匹配范围');
  if (!Array.isArray(proposal.positive) || !proposal.positive.length || !Array.isArray(proposal.negative) || !proposal.negative.length) throw new Error('技能必须包含正例和相近反例');
  if (!proposal.positive.every(c => scopeMatch(scope,c) === 'yes') || !proposal.negative.every(c => scopeMatch(scope,c) === 'no')) throw new Error('技能匹配边界未通过正反例检查');
  if (/^sop$|^report$|^document$/.test(proposal.name)) throw new Error('单一案例不能建立无范围的通用技能');
  for (const id of proposal.ruleIds || []) if (!state.rules.some(r => r.id === id && r.status === 'active')) throw new Error('ruleIds 只能引用已知经验的 id，不能填 key；本轮新经验尚无 id 时可留空，技能正文应自包含');
  return { ...proposal, scope, implicit: proposal.implicit !== false };
}

export async function publishSkills(library, proposals, { skillDirectory } = {}) {
  if (!proposals?.length) return [];
  return withLock(join(library.root, 'publish'), async () => {
    const state = await library.read();
    const checked = proposals.map(p => validateSkillProposal(state,p));
    const results = [];
    const root = resolve(skillDirectory || library.skillDirectory || join(library.root, 'skills'));
    for (const p of checked) {
      await mkdir(root, { recursive: true });
      const folder = inside(root, p.name);
      // Existing junctions may target another authorized library, but publication never follows them implicitly.
      try { if ((await lstat(folder)).isSymbolicLink()) throw new Error('技能目录是链接，请绑定真实仓库路径'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const path = join(folder, 'SKILL.md');
      const yaml = join(folder,'agents','openai.yaml');
      const readmePath = join(folder, 'README.md');
      const prepared=await prepareCommit(root,[path,yaml,readmePath]);
      const previous = state.skills[p.name];
      if(previous?.status==='retired'){results.push({name:p.name,status:'skip-retired',path});continue;}
      const currentHash = await fingerprint(path);
      if (previous && previous.path === path && previous.fingerprint !== currentHash && p.baseFingerprint !== currentHash) {
        results.push({ name:p.name, status:'manual-change', path, fingerprint:currentHash }); continue;
      }
      let old = currentHash ? await readFile(path,'utf8') : '';
      const existingYaml = await fingerprint(yaml) ? await readFile(yaml,'utf8') : '';
      const existingReadmeHash = await fingerprint(readmePath);
      const existingReadme = existingReadmeHash ? await readFile(readmePath, 'utf8') : '';
      const frontmatter=old.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
      if (currentHash && !previous) {
        const existingDesc = frontmatter.match(/^description:\s*(.*)$/m)?.[1] || '';
        if (!documentSkillTerms.test(existingDesc) && !state.sourceSkills?.[p.name]) {
          throw new Error(`目标技能不是文档技能，拒绝修改：${p.name}`);
        }
      }
      const explicitOnly = state.sourceSkills?.[p.name]?.implicit===false || /^\s*allow_implicit_invocation:\s*false\s*(?:#.*)?$/m.test(existingYaml) || /^disable-model-invocation:\s*true\s*$/m.test(frontmatter);
      const implicit = p.implicit && !explicitOnly;
      if (old.includes(start) !== old.includes(end) || old.split(start).length > 2 || old.split(end).length > 2) throw new Error('技能管理区标记损坏');
      const rules = (p.ruleIds || []).map(id => state.rules.find(r => r.id === id));
      const shared = rules.map(r => `- ${r.text}（适用条件：${JSON.stringify(r.scope)}；${r.strength}）`).join('\n');
      // 跨文档经验集中在手册里维护，技能只留一行指向对应类型的手册，避免两处内容漂移。
      const kind = [p.scope?.kind ?? []].flat()[0];
      const pointer = `制作前先读个人经验手册 \`knowledge/core.md\`${kind ? ` 和 \`knowledge/${safeName(kind)}.md\`` : ''}（位于个人技能仓库或个人库）。`;
      const body = `${start}\n## 持续学习的适用经验\n\n当前明确需求优先于下列历史经验。保留各条的适用范围。\n\n${pointer}\n\n${p.body.trim()}${shared ? `\n\n${shared}` : ''}\n${end}`;
      let next;
      if (old) {
        if (old.includes(start)) next = old.slice(0,old.indexOf(start)) + body + old.slice(old.indexOf(end)+end.length);
        else next = `${old.trimEnd()}\n\n${body}\n`;
      } else {
        next = `---\nname: ${p.name}\ndescription: ${JSON.stringify(p.description)}\n---\n\n# ${p.title || p.name}\n\n${body}\n`;
      }
      await mkdir(folder, { recursive:true });
      if (currentHash) {
        await atomicWrite(join(library.root,'skill-backups',p.name,`${currentHash}.md`),old);
        const yamlPath=join(folder,'agents','openai.yaml');
        const yamlHash=await fingerprint(yamlPath);
        await writeJson(join(library.root,'skill-backups',p.name,`${currentHash}.json`),{previous:previous || null,yaml:yamlHash?await readFile(yamlPath,'utf8'):null,readme:existingReadmeHash?existingReadme:null});
      }
      // Compare again immediately before writing; user edits win over stale model output.
      if (await fingerprint(path) !== currentHash) throw new Error('发布期间技能被修改，请基于新版本重新整理');
      await atomicWrite(path,next);
      if (!currentHash && !existingYaml) await atomicWrite(yaml,`interface:\n  display_name: ${JSON.stringify(p.title || p.name)}\n  short_description: ${JSON.stringify(p.description.slice(0,64))}\n  default_prompt: ${JSON.stringify(`使用 $${p.name} 完成当前适用的文档任务。`)}\npolicy:\n  allow_implicit_invocation: ${implicit}\n`);
      let wroteReadme = false;
      if (!existingReadme || existingReadme.includes(readmeMarker)) {
        await atomicWrite(readmePath, renderSkillReadme(p, { implicit }));
        wroteReadme = true;
      }
      const yamlFingerprint=await fingerprint(yaml);
      const readmeFingerprint=await fingerprint(readmePath);
      await library.transact('publish-skill',draft => { draft.skills[p.name] = { name:p.name,title:p.title || p.name,status:'active',origin:previous?.origin || (currentHash?'existing':'generated'), path, fingerprint:hash(next),yamlFingerprint, scope:p.scope, implicit, evidence:p.evidence, ruleIds:p.ruleIds || [], positive:p.positive, negative:p.negative }; });
      const files={[path]:hash(next),...(yamlFingerprint?{[yaml]:yamlFingerprint}:{}),...(wroteReadme&&readmeFingerprint?{[readmePath]:readmeFingerprint}:{})};
      const versioning=await commitPublished(prepared,files,{libraryRoot:library.root,name:p.name});
      results.push({ name:p.name, status:'published', path, versioning });
    }
    return results;
  });
}

export async function migrateManagedSkills(library, { targetDirectory } = {}) {
  const root = resolve(targetDirectory || library.skillDirectory || join(library.root, 'skills'));
  await mkdir(root, { recursive: true });
  const state = await library.read();
  const migrated = [];
  for (const s of Object.values(state.skills || {})) {
    const folder = inside(root, s.name);
    const targetPath = join(folder, 'SKILL.md');
    const targetYaml = join(folder, 'agents', 'openai.yaml');
    const targetReadme = join(folder, 'README.md');
    const sourcePath = s.path;
    const sourceYaml = join(resolve(sourcePath, '..'), 'agents', 'openai.yaml');
    if (!(await exists(sourcePath)) && !(await exists(targetPath))) continue;
    await mkdir(join(folder, 'agents'), { recursive: true });
    const skillText = (await exists(targetPath)) ? await readFile(targetPath, 'utf8') : await readFile(sourcePath, 'utf8');
    if (!(await exists(targetPath)) || resolve(sourcePath) !== resolve(targetPath)) {
      await atomicWrite(targetPath, skillText);
    }
    if (!(await exists(targetYaml)) && (await exists(sourceYaml))) {
      await atomicWrite(targetYaml, await readFile(sourceYaml, 'utf8'));
    }
    const desc = skillText.match(/^description:\s*(.*)$/m)?.[1]?.replace(/^["']|["']$/g, '') || s.title || s.name;
    const managedBody = skillText.includes(start) && skillText.includes(end)
      ? skillText.slice(skillText.indexOf(start) + start.length, skillText.indexOf(end)).trim()
      : '';
    const existingReadme = (await exists(targetReadme)) ? await readFile(targetReadme, 'utf8') : '';
    if (!existingReadme || existingReadme.includes(readmeMarker)) {
      await atomicWrite(targetReadme, renderSkillReadme({
        name: s.name,
        title: s.title || s.name,
        description: desc,
        scope: s.scope,
        positive: s.positive || [],
        negative: s.negative || [],
        body: managedBody
      }, { implicit: s.implicit !== false }));
    }
    const nextHash = await fingerprint(targetPath);
    const nextYamlHash = await fingerprint(targetYaml);
    await library.transact('migrate-skill', draft => {
      if (draft.skills[s.name]) {
        draft.skills[s.name].path = targetPath;
        if (nextHash) draft.skills[s.name].fingerprint = nextHash;
        if (nextYamlHash) draft.skills[s.name].yamlFingerprint = nextYamlHash;
      }
    });
    migrated.push({ name: s.name, path: targetPath, readme: targetReadme });
  }
  return migrated;
}
export async function rollbackSkill(library,name,version) {
  if(!slug(name)||!/^[a-f0-9]{64}$/.test(version || ''))throw new Error('无效的技能或回退指纹');
  return withLock(join(library.root,'publish'),async()=>{
    const record=(await library.read()).skills[name];
    if(!record)throw new Error('未找到插件管理的技能');
    if(await fingerprint(record.path)!==record.fingerprint)throw new Error('技能存在手动修改，保留当前文件');
    const backup=await readFile(join(library.root,'skill-backups',name,`${version}.md`),'utf8');
    const metadata=await readJson(join(library.root,'skill-backups',name,`${version}.json`));
    const yamlPath=join(record.path,'..','agents','openai.yaml');
    if(await fingerprint(yamlPath)!==record.yamlFingerprint)throw new Error('技能元数据存在手动修改，保留当前文件');
    await atomicWrite(record.path,backup);
    if(metadata.yaml!==null && metadata.yaml!==undefined)await atomicWrite(yamlPath,metadata.yaml);
    await library.transact('rollback-skill',state=>{if(metadata.previous)state.skills[name]=metadata.previous;else delete state.skills[name];});
    return {name,path:record.path,status:'restored',fingerprint:hash(backup)};
  });
}

export async function retireSkills(library,proposals=[]) {
  const results=[];
  for(const p of proposals) {
    const state=await library.read(),record=state.skills[p.name];
    if(!record)throw new Error('停用目标不是插件管理的技能');
    const evidence=verifyEvidence(state,p.evidence);
    if(!evidence.some(e=>/停用|弃用|移除|不再使用|retire|disable|stop using/i.test(e.quote)))throw new Error('停用技能需要明确的原始要求');
    if(!evidence.some(e=>e.quote.includes(p.name)||e.quote.includes(record.title)||state.sources[e.source].context.skill===p.name))throw new Error('无法确定原始要求对应哪个技能');
    if(record.status==='retired'){results.push({name:p.name,status:'already-retired'});continue;}
    await withLock(join(library.root,'publish'),async()=>{
      const yaml=join(record.path,'..','agents','openai.yaml');
      if(await fingerprint(record.path)!==record.fingerprint || await fingerprint(yaml)!==record.yamlFingerprint)throw new Error('技能存在手动修改，保留当前文件');
      const old=await readFile(record.path,'utf8');
      await atomicWrite(join(library.root,'skill-backups',p.name,`${record.fingerprint}.md`),old);
      await writeJson(join(library.root,'skill-backups',p.name,`${record.fingerprint}.json`),{previous:record,yaml:record.yamlFingerprint?await readFile(yaml,'utf8'):null});
      const frontmatter=old.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if(!frontmatter)throw new Error('技能 frontmatter 不完整，保留文件');
      const updated=/^disable-model-invocation:/m.test(frontmatter[1])?frontmatter[0].replace(/^disable-model-invocation:.*$/m,'disable-model-invocation: true'):frontmatter[0].replace(/^---\r?\n/,'---\ndisable-model-invocation: true\n');
      const next=updated+old.slice(frontmatter[0].length);
      await atomicWrite(record.path,next);
      let config=record.yamlFingerprint?await readFile(yaml,'utf8'):'';
      if(/allow_implicit_invocation:\s*(true|false)/.test(config))config=config.replace(/allow_implicit_invocation:\s*(true|false)/,'allow_implicit_invocation: false');
      else config+='\npolicy:\n  allow_implicit_invocation: false\n';
      await atomicWrite(yaml,config);
      const yamlFingerprint=await fingerprint(yaml);
      await library.transact('retire-skill',draft=>{draft.skills[p.name]={...record,status:'retired',implicit:false,fingerprint:hash(next),yamlFingerprint,retirement:evidence};});
    });
    results.push({name:p.name,status:'retired'});
  }
  return results;
}
