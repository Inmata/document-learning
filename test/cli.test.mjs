import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from '../src/provider.mjs';
import {readJson} from '../src/io.mjs';

const cli=fileURLToPath(new URL('../bin/document-learning.mjs',import.meta.url));
test('真实 CLI 的 signal 只输出信号，不初始化个人库',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const packet={session:'a',turn:'b',token:'c',phase:'complete',rules:[{text:'保留中文原话'}]};
  const output=await runProcess(process.execPath,[cli,'signal','--home',dir,'--base64',Buffer.from(JSON.stringify(packet)).toString('base64')],'');
  assert.deepEqual(JSON.parse(output).document_learning_signal,packet);
  await assert.rejects(readJson(join(dir,'binding.json')),e=>e.code==='ENOENT');
});
