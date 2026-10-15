import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,relative} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,inside} from '../src/io.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const pkg=await readJson(join(root,'package.json'));
const manifests=await Promise.all(['plugin.json','.codex-plugin/plugin.json','.claude-plugin/plugin.json'].map(p=>readJson(join(root,p))));
for(const manifest of manifests){assert.equal(manifest.name,pkg.name);assert.equal(manifest.version,pkg.version);}
assert.equal(manifests[0].extensions['com.openai'].hooks,manifests[1].hooks);
for(const path of [manifests[1].hooks,'./hooks/hooks.json']) {
  const config=await readJson(inside(root,path));
  for(const required of ['SessionStart','UserPromptSubmit','PostToolUse','Stop','SessionEnd'])assert.ok(config.hooks[required]?.length,`${path} 缺少 ${required}`);
  for(const groups of Object.values(config.hooks))for(const group of groups)for(const hook of group.hooks){assert.equal(hook.type,'command');assert.ok(hook.timeout>0 && hook.timeout<=30);}
}
const skill=await readFile(join(root,'skills','document-learning','SKILL.md'),'utf8');
assert.match(skill,/^---\nname: document-learning\n/);
const files=await readdir(root,{recursive:true});
const source=files.filter(p=>p.endsWith('.mjs')&&!p.startsWith('.git'));
const exec=promisify(execFile);
const checks=await Promise.allSettled(source.map(p=>exec(process.execPath,['--check',join(root,p)],{windowsHide:true})));
for(const [index,result]of checks.entries())if(result.status==='rejected')throw new Error(`${source[index]} 语法检查失败：${result.reason.message}`);
assert.ok(!files.some(p=>/(?:^|[\\/])(?:state\.json|binding\.json|dataset\.json|session-\d+\.json)$/.test(p)),'公开项目中发现个人数据文件');
console.log(`包检查通过：${manifests.length} 种清单、双宿主 hooks、${source.length} 个 JavaScript 文件；未发现个人数据文件。`);
