#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {resolveLibrary,bindLibrary,dataRoot} from '../src/library.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {handleHook} from '../src/hooks.mjs';
import {applyLearning,retrieve} from '../src/knowledge.mjs';
import {importHistory} from '../src/history.mjs';
import {scanGit} from '../src/git-history.mjs';
import {runReplay,reconcileReplay} from '../src/replay.mjs';
import {createProvider} from '../src/provider.mjs';
import {install,uninstall,doctor} from '../src/install.mjs';
import {rollbackSkill} from '../src/skills.mjs';

const {values:options,positionals}=parseArgs({allowPositionals:true,options:{home:{type:'string'},library:{type:'string'},repository:{type:'string'},agent:{type:'string'},owner:{type:'string'},input:{type:'string',multiple:true},output:{type:'string'},context:{type:'string'},version:{type:'string'},name:{type:'string'},job:{type:'string'},provider:{type:'string'},expectations:{type:'string'},'replay-only':{type:'boolean',default:false},base64:{type:'string'},session:{type:'string'},turn:{type:'string'},token:{type:'string'},phase:{type:'string'},document:{type:'string'},task:{type:'string'},kind:{type:'string'},merge:{type:'boolean',default:true},help:{type:'boolean',default:false}}});
const command=positionals[0] || 'help';
const base=options.home || dataRoot();
async function stdin(){let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>16*1024*1024)throw new Error('输入超过 16MB');}return text;}
async function input(){const file=options.input?.[0];return file&&file!=='-'?readJson(file):JSON.parse(await stdin());}
const print=value=>process.stdout.write(`${JSON.stringify(value,null,command==='signal'?0:2)}\n`);
async function main(){
  if(command==='signal'){
    const packet=options.base64?JSON.parse(Buffer.from(options.base64,'base64').toString('utf8')):(options.session?{session:options.session,turn:options.turn,token:options.token,phase:options.phase || 'begin',...(options.document!==undefined?{document:options.document==='true'}:{}),...(options.task?{context:{task:options.task,kind:options.kind}}:{})}:await input());
    if(options.document!==undefined&&!['true','false'].includes(options.document))throw new Error('--document 只能为 true 或 false');
    print({document_learning_signal:packet});return;
  }
  if(command==='help'||options.help){process.stdout.write(`文档持续学习插件\n\nnode bin/document-learning.mjs <命令> [选项]\n\ninstall [--agent codex|claude|both] [--repository 技能仓库]\nuninstall [--agent codex|claude]\ndoctor\nbind --library 个人库 [--repository 技能仓库]\nquery --context 条件JSON文件\nlearn --input 已有原始证据及经验JSON\nhistory-import --input 会话JSON或JSONL（可重复） [--repository 技能仓库] --output 数据集JSON\nreplay --input 数据集JSON [--provider 后端配置JSON] [--job 标识] [--merge]\nreconcile --input 回放任务目录\nrollback --version doctor/events 中的回退版本\nsignal：从 stdin 读取学习信号并输出；不修改文件\n\n--home 指定插件配置目录；--library 显式指定个人库。\n`);return;}
  if(command==='install'){print(await install({base,agents:!options.agent||options.agent==='both'?['codex','claude']:[options.agent],repository:options.repository}));return;}
  if(command==='uninstall'){print(await uninstall({base,agents:options.agent?[options.agent]:undefined}));return;}
  if(command==='doctor'){print(await doctor({base}));return;}
  if(command==='bind'){if(!options.library)throw new Error('bind 需要 --library');print({library:(await bindLibrary({base,library:options.library,skillRepository:options.repository})).root});return;}
  if(command==='history-import'){
    if(!options.input?.length||!options.output)throw new Error('history-import 需要 --input 和 --output');
    const dataset=await importHistory(options.input);
    if(options.repository)dataset.git=await scanGit(options.repository);
    await writeJson(options.output,dataset);print({output:options.output,sessions:dataset.sessions.length,warnings:dataset.warnings,git:dataset.git?{commits:dataset.git.commits.length,relevant:dataset.git.commits.filter(c=>c.relevant).length}:null});return;
  }
  if(command==='hook'&&process.env.DOCUMENT_LEARNING_WORKER==='1'){print({});return;}
  if(!['hook','query','show-rule','learn','rollback','skill-rollback','replay','reconcile'].includes(command))throw new Error(`未知命令：${command}`);
  const library=await resolveLibrary({base,root:options.library});
  const binding=await readJson(join(base,'binding.json'),{});
  if(command==='hook'){
    print(await handleHook(library,options.agent || 'codex',await input(),{repository:binding.skillRepository}));return;
  }
  if(command==='query'){if(!options.context)throw new Error('query 需要 --context');print(await retrieve(library,await readJson(options.context)));return;}
  if(command==='learn'){print(await applyLearning(library,await input()));return;}
  if(command==='show-rule'){
    const state=await library.read(),rule=state.rules.find(r=>r.id===options.name);
    if(!rule)throw new Error('未找到对应经验');
    print({rule,sources:rule.evidence.map(e=>state.sources[e.source])});return;
  }
  if(command==='rollback'){print(await library.rollback(options.version));return;}
  if(command==='skill-rollback'){print(await rollbackSkill(library,options.name,options.version));return;}
  if(command==='replay'){
    const dataset=await input(),config=options.provider?await readJson(options.provider):{type:'claude'};
    const expectations=options.expectations?await readJson(options.expectations):(dataset.expectations || {});
    const result=await runReplay(library,dataset,createProvider(config),{jobId:options.job,expectations,progress:p=>process.stderr.write(`回放 ${p.index+1}/${p.total} ${p.source}\n`)});
    const merged=options.merge&&!options['replay-only']?await reconcileReplay(library,result.root,{repository:binding.skillRepository}):null;
    print({root:result.root,summary:result.run.summary,merged});return;
  }
  if(command==='reconcile'){const path=options.input?.[0];if(!path)throw new Error('reconcile 需要 --input 回放任务目录');print(await reconcileReplay(library,path,{repository:binding.skillRepository}));return;}
  throw new Error(`未知命令：${command}`);
}
try {await main();}catch(error){
  if(command==='hook'){print({systemMessage:`文档学习未完成：${error.message}`});process.exitCode=0;}
  else{process.stderr.write(`文档学习：${error.message}\n`);process.exitCode=1;}
}
