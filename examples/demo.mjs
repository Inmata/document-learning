import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Library} from '../src/library.mjs';
import {normalizeSession} from '../src/history.mjs';
import {hash} from '../src/io.mjs';
import {runReplay,reconcileReplay} from '../src/replay.mjs';
import {retrieve} from '../src/knowledge.mjs';

// 全部为虚构演示资料；固定后端只验证程序链路，不代表模型质量评测。
const session=normalizeSession({id:'fictional-example',context:{task:'example',kind:'instruction'},messages:[
  {role:'user',text:'操作说明按实际操作顺序组织。'},
  {role:'assistant',text:'已按提供的资料整理。'},
  {role:'user',text:'本次图片不加图注。'},
  {role:'user',text:'修复进程退出的编程问题。'}
]});
const library=await Library.open(await mkdtemp(join(tmpdir(),'document-learning-demo-')));
const data={schema:1,sessions:[session],inputDigest:hash(session),warnings:['虚构演示，无真实用户质量评价']};
const backend=async request=>{
  const text=request.current.text;
  const result={document:!text.includes('编程'),context:request.context,rules:[],observations:[],retire:[],skills:[]};
  if(text.includes('操作顺序'))result.rules.push({key:'instruction.order',value:'actual',text:'按实际操作顺序组织',category:'method',strength:'default',scope:{kind:'instruction'},evidence:[{source:request.current.id,quote:'操作说明按实际操作顺序组织。'}]});
  if(text.includes('图注'))result.rules.push({key:'figure.caption',value:'none',text:'本次图片不加图注',category:'preference',strength:'required',scope:{task:'example'},evidence:[{source:request.current.id,quote:'本次图片不加图注。'}]});
  return result;
};
backend.identity='fictional-fixed-backend';
const {root,run}=await runReplay(library,data,backend);
await reconcileReplay(library,root);
const another=await retrieve(library,{task:'another-object',kind:'instruction',object:'another'});
console.log(JSON.stringify({说明:'虚构记录与固定后端的功能演示，未评估模型或版式质量',个人数据目录:library.root,回放回合:run.summary.steps,经验数量:(await library.read()).rules.length,其他清洗对象可参考:another.apply.map(r=>r.text)},null,2));
