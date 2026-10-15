import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeJsonl} from '../src/history.mjs';

test('Codex JSONL 不重复读取 event_msg 与 response_item，工具结果保留为工具来源',()=>{
  const rows=[{type:'session_meta',payload:{id:'s',cwd:'/work'}},{type:'event_msg',payload:{type:'user_message',message:'实际需求'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'实际需求'}]}},{type:'response_item',payload:{type:'function_call_output',call_id:'tool',output:'验证通过'}}];
  const s=normalizeJsonl(rows.map(JSON.stringify).join('\n'),'codex.jsonl');
  assert.equal(s.messages.filter(m=>m.role==='user').length,1);
  assert.equal(s.messages.at(-1).role,'tool');assert.match(s.messages.at(-1).text,/验证通过/);
});
test('Claude 的 tool_result 不冒充用户反馈，末行不完整显式标记',()=>{
  const rows=[{sessionId:'s',uuid:'u',message:{role:'user',content:[{type:'text',text:'原始要求'}]}},{uuid:'t',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool',content:'模型生成的检查结果'}]}}];
  const s=normalizeJsonl(rows.map(JSON.stringify).join('\n')+'\n{"broken":','claude.jsonl');
  assert.equal(s.messages.filter(m=>m.role==='user').length,1);assert.equal(s.messages.at(-1).role,'tool');
  assert.equal(s.completeness.truncated,true);
});
