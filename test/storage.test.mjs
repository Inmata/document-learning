import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Library} from '../src/library.mjs';
import {applyLearning} from '../src/knowledge.mjs';

test('并发写入不丢失规则，知识变更可回退，失败批次不留下部分数据',async t=>{
  const root=await mkdtemp(join(tmpdir(),'doc-storage-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const lib=await Library.open(root);
  await Promise.all(Array.from({length:8},(_,i)=>applyLearning(lib,{sources:[{id:`s${i}`,role:'user',text:`保留图片${i}`,task:'a',origin:'conversation',context:{task:'a'}}],rules:[{key:`image.${i}`,value:'keep',text:`保留图片${i}`,category:'preference',strength:'default',scope:{task:'a'},evidence:[{source:`s${i}`,quote:`保留图片${i}`}]}]})));
  const state=await lib.read();assert.equal(state.rules.length,8);
  const snapshot=state.events.at(-1).rollback;assert.ok(snapshot);
  await lib.rollback(snapshot);assert.equal((await lib.read()).rules.length,7);
  const before=(await lib.read()).revision;
  await assert.rejects(applyLearning(lib,{sources:[{id:'bad',role:'assistant',text:'用户喜欢',origin:'conversation'}],rules:[{key:'bad',value:'x',text:'坏数据',category:'preference',strength:'default',scope:{task:'a'},evidence:[{source:'bad',quote:'用户喜欢'}]}]}));
  assert.equal((await lib.read()).revision,before);assert.equal((await lib.read()).sources.bad,undefined);
});
