import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink, open, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function readJson(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw error; }
}
export async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx');
    try { await file.writeFile(contents, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(tmp, path);
  } finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export const writeJson = (path, value) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
export function inside(root, candidate) {
  const path = resolve(root, candidate);
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) throw new Error('路径超出允许的根目录');
  return path;
}
export async function withLock(root, fn, timeout = 10000) {
  await mkdir(root, { recursive: true });
  const path = resolve(root, '.write-lock');
  const owner = { pid: process.pid, id: randomUUID(), created: Date.now() };
  const start = Date.now();
  while (true) {
    try {
      const f = await open(path, 'wx');
      try { await f.writeFile(JSON.stringify(owner)); } finally { await f.close(); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const old = await readJson(path);
        let alive = true;
        try { process.kill(old.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (!alive && (await readJson(path)).id === old.id) { await unlink(path); continue; }
      } catch (e) { if (e.code === 'ENOENT') continue; if (!(e instanceof SyntaxError)) throw e; }
      if (Date.now() - start > timeout) throw new Error(`个人库正被其他进程使用：${path}`);
      await delay(25);
    }
  }
  try { return await fn(); }
  finally { if ((await readJson(path, {})).id === owner.id) await unlink(path); }
}
export async function fingerprint(path) { try { return hash(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export async function exists(path) { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
