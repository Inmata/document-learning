import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, access, constants } from 'node:fs/promises';
import { readJson, writeJson, withLock, hash } from './io.mjs';

export function dataRoot(env = process.env) {
  if (env.DOCUMENT_LEARNING_HOME) return resolve(env.DOCUMENT_LEARNING_HOME);
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DocumentLearning');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'document-learning');
}
const empty = () => ({ schema: 1, revision: 0, sources: {}, rules: [], observations: [], sessions: {}, skills: {}, jobs: {}, events: [] });

export class Library {
  constructor(root) { this.root = resolve(root); this.file = join(this.root, 'state.json'); }
  static async open(root = join(dataRoot(), 'library'), { create = true } = {}) {
    const lib = new Library(root);
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

export async function resolveLibrary({ base = dataRoot(), root, create = true } = {}) {
  if (root) return Library.open(root, { create });
  const binding = await readJson(join(base, 'binding.json'), null);
  if (binding) {
    // A stale or inaccessible binding is an error, never an invitation to create a second library.
    return Library.open(binding.library, { create: false });
  }
  if (!create) throw new Error('尚未绑定个人库');
  await mkdir(base, { recursive: true });
  const lib = await Library.open(join(base, 'library'));
  await withLock(base, async () => {
    const other = await readJson(join(base, 'binding.json'), null);
    if (other && resolve(other.library) !== lib.root) throw new Error('个人库绑定发生并发变化');
    if (!other) await writeJson(join(base, 'binding.json'), { schema: 1, library: lib.root, skillRepository: null });
  });
  return lib;
}

export async function bindLibrary({ base = dataRoot(), library, skillRepository = null }) {
  const lib = await Library.open(library);
  if (skillRepository) await access(skillRepository, constants.R_OK);
  await withLock(base, () => writeJson(join(base, 'binding.json'), { schema: 1, library: lib.root, skillRepository: skillRepository ? resolve(skillRepository) : null }));
  return lib;
}
