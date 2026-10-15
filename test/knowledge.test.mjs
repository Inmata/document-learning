import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.mjs';
import { applyLearning, retrieve } from '../src/knowledge.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'document-learning-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = await Library.open(root);
  return library;
}
const source = (id, text, task = 'A') => ({ id, role: 'user', text, task, context: { task, kind: 'report' }, origin: 'conversation' });
const rule = (id, quote, task = 'A') => ({ key: 'figure.caption', value: 'below', text: '图片下方保留图注', category: 'preference', strength: 'default', scope: { task }, evidence: [{ source: id, quote }] });

test('当前文档的反向要求优先，历史的一百次支持仍保留原范围', async t => {
  const lib = await fixture(t);
  const sources = Array.from({ length: 100 }, (_, i) => source(`a${i}`, '图片下方保留图注'));
  await applyLearning(lib, { sources, rules: [rule('a0', sources[0].text)] });
  const b = source('b', '本次不要图注', 'B');
  await applyLearning(lib, { sources: [b], rules: [{ ...rule('b', b.text, 'B'), value: 'none', text: b.text, strength: 'required' }] });
  const a = await retrieve(lib, { task: 'A', kind: 'report' });
  const br = await retrieve(lib, { task: 'B', kind: 'report' });
  assert.equal(a.apply[0].value, 'below');
  assert.equal(br.apply[0].value, 'none');
  assert.equal((await lib.read()).rules.length, 2);
});

test('不同清洗对象共享表达方法，不继承 PCB 个案参数', async t => {
  const lib = await fixture(t);
  const s = source('s', '操作说明按实际操作顺序组织；这次 PCB 清洗为 480 秒', 'pcb');
  s.context = { task: 'pcb', kind: 'instruction', process: 'cleaning', object: 'pcb' };
  await applyLearning(lib, { sources: [s], rules: [
    { key: 'instruction.order', value: 'actual', text: '按实际操作顺序组织', category: 'method', strength: 'default', scope: { kind: 'instruction' }, evidence: [{ source: 's', quote: '操作说明按实际操作顺序组织' }] },
    { key: 'process.duration', value: '480s', text: '480 秒', category: 'fact', strength: 'required', scope: { task: 'pcb' }, evidence: [{ source: 's', quote: '这次 PCB 清洗为 480 秒' }] }
  ] });
  const result = await retrieve(lib, { task: 'metal', kind: 'instruction', process: 'cleaning', object: 'metal' });
  assert.deepEqual(result.apply.map(r => r.key), ['instruction.order']);
});

test('助手输出、沉默、虚构引文不能作为新偏好的证据', async t => {
  const lib = await fixture(t);
  await assert.rejects(applyLearning(lib, { sources: [{ ...source('a', '用户喜欢这样'), role: 'assistant' }], rules: [rule('a', '用户喜欢这样')] }), /证据/);
  await assert.rejects(applyLearning(lib, { sources: [source('b', '收到')], rules: [rule('b', '图片下方保留图注')] }), /引文/);
  assert.equal((await lib.read()).rules.length, 0);
});

test('重复导入幂等，来源 ID 不允许被悄悄改写', async t => {
  const lib = await fixture(t);
  const payload = { sources: [source('a', '图片下方保留图注')], rules: [rule('a', '图片下方保留图注')] };
  await applyLearning(lib, payload);
  await applyLearning(lib, payload);
  assert.equal((await lib.read()).rules.length, 1);
  await assert.rejects(applyLearning(lib, { sources: [source('a', '改写内容')], rules: [] }), /来源/);
});

test('相同适用范围内未声明撤销的矛盾进入核对，不用频次和时间猜测', async t => {
  const lib = await fixture(t);
  await applyLearning(lib, { sources: [source('a', '图片下方保留图注'), source('b', '不要图注')], rules: [rule('a', '图片下方保留图注'), { ...rule('b', '不要图注'), value: 'none' }] });
  const result = await retrieve(lib, { task: 'A' });
  assert.equal(result.apply.length, 0);
  assert.equal(result.conflicts.length, 1);
});

test('偏好无法仅凭次数扩大范围，机械要求同样需要依据', async t => {
  const lib = await fixture(t);
  await assert.rejects(applyLearning(lib, { sources: [source('a', '图片下方保留图注')], rules: [{ ...rule('a', '图片下方保留图注'), scope: {} }] }), /范围/);
});

test('用户明确的个人默认可以全局保存，单份报告的例外不撤销它',async t=>{
  const lib=await fixture(t);
  const a=source('a','以后所有文档默认在图片下面保留图注');
  await applyLearning(lib,{sources:[a],rules:[{...rule('a',a.text),scope:{},scopeBasis:'explicit'}]});
  const b=source('b','本次报告不要图注','B');
  await applyLearning(lib,{sources:[b],rules:[{...rule('b',b.text,'B'),value:'none',text:b.text}]});
  assert.equal((await retrieve(lib,{task:'B'})).apply[0].value,'none');
  assert.equal((await retrieve(lib,{task:'C'})).apply[0].value,'below');
  const global=(await lib.read()).rules.find(r=>!r.scope.task);assert.equal(global.exceptions.length,1);assert.equal(global.strength,'default');
});

test('尚未晋升的局部方法能作为跨对象类比检索，偏好和参数不随之迁移',async t=>{
  const lib=await fixture(t),s=source('a','操作按真实顺序组织。本次图片下方保留图注。','pcb');
  await applyLearning(lib,{sources:[s],rules:[
    {key:'instruction.order',value:'actual',text:'按真实顺序组织',category:'method',strength:'required',scope:{task:'pcb'},evidence:[{source:'a',quote:'操作按真实顺序组织'}]},
    rule('a','本次图片下方保留图注。','pcb')
  ]});
  const result=await retrieve(lib,{task:'metal',kind:'instruction'});
  assert.equal(result.apply.length,0);assert.equal(result.transfer.length,1);
  assert.equal(result.transfer[0].strength,'suggestion');assert.equal(result.transfer[0].requiresAdaptation,true);
  assert.equal((await lib.read()).rules[0].strength,'required');assert.deepEqual((await lib.read()).rules[0].scope,{task:'pcb'});
});
