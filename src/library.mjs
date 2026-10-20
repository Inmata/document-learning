import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, access, constants, readdir, readFile } from 'node:fs/promises';
import { readJson, writeJson, withLock, hash, exists, fingerprint } from './io.mjs';
import { mergeLearning } from './knowledge.mjs';

const docSkillTerms = /报告|文档|说明书|作业指导|图注|版式|母版|模板|合同|信函|提案|汇报|清洗|实验|现场|docx|pptx|xlsx|report|presentation|document|spreadsheet|contract|letter|proposal|\bsop\b|\bword\b|\bpowerpoint\b/i;
const nonSkillDirs = new Set(['notes','docs','assets','scripts','tests','examples','history','cases','knowledge','versions','publish','skill-backups']);

export function dataRoot(env = process.env) {
  if (env.DOCUMENT_LEARNING_HOME) return resolve(env.DOCUMENT_LEARNING_HOME);
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DocumentLearning');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'document-learning');
}
const empty = () => ({ schema: 1, revision: 0, sources: {}, rules: [], observations: [], sessions: {}, skills: {}, jobs: {}, events: [] });

export class Library {
  constructor(root, { skillDirectory } = {}) {
    this.root = resolve(root);
    this.file = join(this.root, 'state.json');
    this.skillDirectory = resolve(skillDirectory || join(this.root, 'skills'));
  }
  static async open(root = join(dataRoot(), 'library'), { create = true, skillDirectory } = {}) {
    const lib = new Library(root, { skillDirectory });
    if (create) await withLock(lib.root, async () => {
      const state = await readJson(lib.file, null);
      if (!state) await writeJson(lib.file, empty());
    });
    const state = await lib.read();
    if (state.schema !== 1) throw new Error('不支持的个人库版本');
    return lib;
  }
  read() { return readJson(this.file); }
  async transact(label, update) {
    return withLock(this.root, async () => {
      const before = await this.read();
      const state = structuredClone(before);
      const result = await update(state);
      if (hash(before) === hash(state)) return { changed: false, revision: before.revision, result };
      const knowledgeChanged = hash({rules:before.rules,observations:before.observations,skills:before.skills}) !== hash({rules:state.rules,observations:state.observations,skills:state.skills});
      const version = knowledgeChanged ? `${before.revision}-${hash(before).slice(0,12)}` : null;
      if(version) await writeJson(join(this.root, 'versions', `${version}.json`), before);
      state.revision++;
      state.events.push({ revision: state.revision, label, at: new Date().toISOString(), rollback: version });
      if(state.events.length>2000)state.events=state.events.slice(-2000);
      await writeJson(this.file, state);
      return { changed: true, revision: state.revision, result };
    });
  }
  async rollback(version) {
    if (!/^\d+-[a-f0-9]{12}$/.test(version)) throw new Error('无效的回退版本');
    const old = await readJson(join(this.root, 'versions', `${version}.json`));
    return this.transact(`rollback:${version}`, state => {
      const revision = state.revision, events = state.events;
      Object.assign(state, old, { revision, events });
    });
  }
}

async function scanRepoDocumentSkills(skillDir) {
  if (!(await exists(skillDir))) return {};
  const entries = await readdir(skillDir, { withFileTypes: true });
  const found = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || nonSkillDirs.has(entry.name)) continue;
    const skillPath = join(skillDir, entry.name, 'SKILL.md');
    if (!(await exists(skillPath))) continue;
    const text = await readFile(skillPath, 'utf8');
    const description = text.match(/^description:\s*(.*)$/m)?.[1] || '';
    if (!docSkillTerms.test(description)) continue;
    const yamlPath = join(skillDir, entry.name, 'agents', 'openai.yaml');
    const yaml = (await exists(yamlPath)) ? await readFile(yamlPath, 'utf8') : '';
    found[entry.name] = {
      name: entry.name,
      title: yaml.match(/^\s*display_name:\s*"?([^"\r\n]+)"?\s*$/m)?.[1] || entry.name,
      description: description.replace(/^["']|["']$/g, ''),
      scope: { skill: entry.name },
      implicit: !/^\s*allow_implicit_invocation:\s*false/m.test(yaml) && !/^disable-model-invocation:\s*true/m.test(text),
      source: 'skill-repository',
      path: skillPath
    };
  }
  return found;
}

export async function syncMemoryFromSkillDirectory(lib) {
  const defaultSkillDir = resolve(lib.root, 'skills');
  const skillDir = resolve(lib.skillDirectory || defaultSkillDir);
  if (skillDir === defaultSkillDir || !(await exists(skillDir))) return false;
  const memoryPath = join(skillDir, 'knowledge', 'memory.json');
  const memory = (await exists(memoryPath)) ? await readJson(memoryPath, null) : null;
  const discovered = await scanRepoDocumentSkills(skillDir);
  const state = await lib.read();
  let needsUpdate = false;
  for (const [name, s] of Object.entries(state.skills || {})) {
    const expected = join(skillDir, name, 'SKILL.md');
    if (resolve(s.path) !== resolve(expected) && (await exists(expected))) { needsUpdate = true; break; }
  }
  for (const [name, info] of Object.entries(discovered)) {
    if (!state.skills?.[name] && (!state.sourceSkills?.[name] || resolve(state.sourceSkills[name].path || '') !== resolve(info.path))) {
      needsUpdate = true; break;
    }
  }
  if (!needsUpdate && memory) {
    if (Object.keys(memory.sources || {}).some(id => !state.sources?.[id])) needsUpdate = true;
    else if ((memory.rules || []).some(r => !state.rules?.some(existing => existing.id === r.id))) needsUpdate = true;
    else if ((memory.observations || []).some(o => !state.observations?.some(existing => existing.id === o.id))) needsUpdate = true;
    else if (Object.keys(memory.skills || {}).some(name => !state.skills?.[name])) needsUpdate = true;
  }
  if (!needsUpdate) return false;
  const fileHashes = {};
  for (const name of new Set([...Object.keys(state.skills || {}), ...Object.keys(memory?.skills || {})])) {
    const p = join(skillDir, name, 'SKILL.md');
    const y = join(skillDir, name, 'agents', 'openai.yaml');
    fileHashes[name] = { path: p, exists: await exists(p), fingerprint: await fingerprint(p), yamlFingerprint: await fingerprint(y) };
  }
  await lib.transact('sync-skill-repository', draft => {
    draft.sourceSkills ||= {};
    for (const [name, info] of Object.entries(discovered)) {
      if (!draft.skills?.[name]) draft.sourceSkills[name] = { ...(draft.sourceSkills[name] || {}), ...info };
    }
    if (memory) {
      for (const [id, src] of Object.entries(memory.sources || {})) if (!draft.sources[id]) draft.sources[id] = src;
      for (const rule of memory.rules || []) if (!draft.rules.some(existing => existing.id === rule.id)) draft.rules.push(rule);
      for (const obs of memory.observations || []) if (!draft.observations.some(existing => existing.id === obs.id)) draft.observations.push(obs);
      for (const [name, skill] of Object.entries(memory.skills || {})) {
        const info = fileHashes[name];
        if (!draft.skills[name]) {
          const { relativePath, ...rest } = skill;
          draft.skills[name] = {
            ...rest,
            path: info?.path || join(skillDir, name, 'SKILL.md'),
            ...(info?.fingerprint ? { fingerprint: info.fingerprint } : {}),
            ...(info?.yamlFingerprint ? { yamlFingerprint: info.yamlFingerprint } : {})
          };
        }
      }
    }
    for (const [name, skill] of Object.entries(draft.skills || {})) {
      const info = fileHashes[name];
      if (info?.exists && resolve(skill.path) !== resolve(info.path)) {
        skill.path = info.path;
        if (info.fingerprint) skill.fingerprint = info.fingerprint;
        if (info.yamlFingerprint) skill.yamlFingerprint = info.yamlFingerprint;
      }
    }
  });
  return true;
}

export async function resolveLibrary({ base = dataRoot(), root, create = true, skillDirectory, sync = true } = {}) {
  if (root) return Library.open(root, { create, skillDirectory });
  const binding = await readBinding(base);
  if (binding) {
    // A stale or inaccessible binding is an error, never an invitation to create a second library.
    const lib = await Library.open(binding.library, { create: false, skillDirectory: skillDirectory || binding.skillDirectory });
    if (sync) await syncMemoryFromSkillDirectory(lib);
    return lib;
  }
  if (!create) throw new Error('尚未绑定个人库');
  await mkdir(base, { recursive: true });
  const lib = await Library.open(join(base, 'library'), { skillDirectory });
  await withLock(base, async () => {
    const other = await readJson(join(base, 'binding.json'), null);
    if (other && resolve(other.library) !== lib.root) throw new Error('个人库绑定发生并发变化');
    if (!other) await writeJson(join(base, 'binding.json'), { schema: 2, library: lib.root, sourceRepositories: [], skillDirectory: lib.skillDirectory });
  });
  return lib;
}

export async function readBinding(base = dataRoot()) {
  const path=join(base,'binding.json'),old=await readJson(path,null);
  if(!old)return null;
  if(old.schema===2)return old;
  const binding={schema:2,library:old.library,sourceRepositories:old.skillRepository?[old.skillRepository]:[],skillDirectory:join(old.library,'skills')};
  await withLock(base,async()=>{
    const latest=await readJson(path,null);if(latest?.schema===2)return;
    if(hash(latest)!==hash(old))throw new Error('迁移期间个人库绑定变化');
    await writeJson(join(base,'install','backups',`binding-v1-${hash(old).slice(0,12)}.json`),old);
    await writeJson(path,binding);
  });
  return binding;
}

export async function bindLibrary({ base = dataRoot(), library, skillRepository = null, sourceRepositories, skillDirectory } = {}) {
  const old = await readBinding(base);
  const targetLibrary = resolve(library || old?.library || join(base, 'library'));
  const sameLibrary = old && resolve(old.library) === targetLibrary;
  const resolvedSources = sourceRepositories !== undefined
    ? sourceRepositories
    : (skillRepository ? [skillRepository] : (sameLibrary ? (old.sourceRepositories || []) : []));
  const resolvedSkillDir = skillDirectory
    ? resolve(skillDirectory)
    : (sameLibrary && old?.skillDirectory ? resolve(old.skillDirectory) : join(targetLibrary, 'skills'));
  if (skillDirectory) await mkdir(resolvedSkillDir, { recursive: true });
  const lib = await Library.open(targetLibrary, { skillDirectory: resolvedSkillDir });
  for (const repo of resolvedSources) await access(repo, constants.R_OK);
  await withLock(base, () => writeJson(join(base, 'binding.json'), {
    schema: 2,
    library: lib.root,
    sourceRepositories: resolvedSources.map(p => resolve(p)),
    skillDirectory: lib.skillDirectory
  }));
  await syncMemoryFromSkillDirectory(lib);
  return lib;
}
