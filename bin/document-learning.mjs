#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {resolveLibrary,bindLibrary,dataRoot,readBinding} from '../src/library.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {handleHook} from '../src/hooks.mjs';
import {applyLearning,retrieve} from '../src/knowledge.mjs';
import {importHistory} from '../src/history.mjs';
import {scanGit} from '../src/git-history.mjs';
import {runReplay,reconcileReplay} from '../src/replay.mjs';
import {createProvider} from '../src/provider.mjs';
import {install,uninstall,doctor,syncPersonalSkills,initSkillRepository,publishRepository} from '../src/install.mjs';
import {rollbackSkill,migrateManagedSkills} from '../src/skills.mjs';
import {runBackfill} from '../src/backfill.mjs';
import {exportCatalog} from '../src/catalog.mjs';
import {recoveryInput} from '../src/recovery.mjs';

const {values:options,positionals}=parseArgs({allowPositionals:true,options:{home:{type:'string'},library:{type:'string'},repository:{type:'string'},'source-repository':{type:'string'},'skill-directory':{type:'string'},'import-from':{type:'string',multiple:true},bind:{type:'boolean',default:false},repo:{type:'string'},remote:{type:'string'},visibility:{type:'string'},branch:{type:'string'},message:{type:'string'},'no-commit':{type:'boolean',default:false},'replace-history':{type:'string'},decision:{type:'string'},agent:{type:'string'},owner:{type:'string'},input:{type:'string',multiple:true},output:{type:'string'},context:{type:'string'},version:{type:'string'},name:{type:'string'},job:{type:'string'},provider:{type:'string'},expectations:{type:'string'},'replay-only':{type:'boolean',default:false},base64:{type:'string'},session:{type:'string'},turn:{type:'string'},token:{type:'string'},phase:{type:'string'},document:{type:'string'},task:{type:'string'},kind:{type:'string'},mode:{type:'string'},plan:{type:'boolean',default:false},'recovery-ticket':{type:'string'},merge:{type:'boolean',default:true},help:{type:'boolean',default:false}}});
const command=positionals[0] || 'help';
const base=options.home || dataRoot();
let activeHookEvent=null;
async function stdin(){let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>16*1024*1024)throw new Error('输入超过 16MB');}return text;}
async function input(){const file=options.input?.[0];return file&&file!=='-'?readJson(file):JSON.parse(await stdin());}
const print=value=>process.stdout.write(`${JSON.stringify(value,null,command==='signal'?0:2)}\n`);
async function main(){
  if(command==='signal'){
    if(options.document!==undefined&&!['true','false'].includes(options.document))throw new Error('--document 只能为 true 或 false');
    // 内联形式只组装显式给出的字段：没有 --task 就不生成 context.task，
    // 没有 --mode/--plan 就不生成 context.mode，避免模型忘记声明时被凭空推断。
    const context=options.task?{task:options.task,kind:options.kind}:{};
    const mode=options.plan?'plan':options.mode;
    if(mode)context.mode=mode;
    const packet=options.base64?JSON.parse(Buffer.from(options.base64,'base64').toString('utf8')):(options.session?{session:options.session,turn:options.turn,token:options.token,phase:options.phase || 'begin',...(options.document!==undefined?{document:options.document==='true'}:{}),...(Object.keys(context).length?{context}:{}),...(options['recovery-ticket']?{recoveryTicket:options['recovery-ticket']}:{})}:await input());
    print({document_learning_signal:packet});return;
  }
  if(command==='help'||options.help){process.stdout.write(`文档持续学习插件\n\nnode bin/document-learning.mjs <命令> [选项]\n\ninstall [--agent codex|claude|both] [--source-repository 只读来源仓库] [--skill-directory 个人技能与长期记忆仓库]\nuninstall [--agent codex|claude]\ndoctor\nbind [--library 个人库] [--source-repository 只读来源仓库] [--skill-directory 个人技能与长期记忆仓库]\ninit-skill-repo --output 新技能仓库目录 [--import-from 现有技能仓库] [--bind]\npublish-repo [--repo 仓库目录] [--remote 远端地址 | --name 仓库名 --owner 账号] [--visibility private|public] [--branch 分支] [--no-commit]\nquery --context 条件JSON文件\nlearn --input 已有原始证据及经验JSON\ncatalog：生成可阅读的经验及案例目录\nsync-skills：连接个人技能入口\nhistory-import --input 会话JSON或JSONL（可重复） [--source-repository 来源仓库] --output 数据集JSON\nbackfill --input 数据集 --decision 当前会话整理的JSON [--job 标识] [--replace-history 旧回放标识]\nbackfill --input 数据集 --provider 已明确选择的后端配置\nreplay --input 数据集JSON [--provider 后端配置JSON] [--job 标识] [--merge]\nreconcile --input 回放任务目录\nrollback --version doctor/events 中的回退版本\nrecover --session 当前会话 --turn 当前轮次 --token 当前票据：只读取恢复证据\nsignal [--session 会话 --turn 轮次 --token 票据 --phase begin|complete] [--document true|false] [--task 标识 --kind 类型] [--mode 模式 | --plan] [--recovery-ticket 恢复票据] [--base64 JSON]
        从 stdin 读取学习信号并输出；不修改文件。--plan 等价于 --mode plan；恢复信号用 --phase complete --recovery-ticket 提交；复杂 rules/skills 仍用 stdin 或 --base64\n\n--repository 是 --source-repository 的旧别名，不作为技能发布目录。\n--skill-directory 可选指定个人文档技能与长期经验 Git 仓库根目录；未指定时默认使用内置 library/skills。\n`);return;}
  if(command==='install'){print(await install({base,agents:!options.agent||options.agent==='both'?['codex','claude']:[options.agent],repository:options['source-repository'] || options.repository,skillDirectory:options['skill-directory']}));return;}
  if(command==='uninstall'){print(await uninstall({base,agents:options.agent?[options.agent]:undefined}));return;}
  if(command==='doctor'){print(await doctor({base}));return;}
  if(command==='init-skill-repo'){print(await initSkillRepository({output:options.output,base,bind:options.bind,importFrom:options['import-from'] || []}));return;}
  if(command==='publish-repo'){
    const binding=await readBinding(base);
    const directory=options.repo || options['skill-directory'] || binding?.skillDirectory;
    if(!directory)throw new Error('publish-repo 需要 --repo 目录，或先绑定 --skill-directory');
    print(await publishRepository({directory,remote:options.remote,name:options.name,owner:options.owner,visibility:options.visibility || 'private',branch:options.branch,message:options.message,commit:!options['no-commit']}));
    return;
  }
  if(command==='bind'){
    if(!options.library&&!options['skill-directory']&&!options['source-repository']&&!options.repository)throw new Error('bind 需要 --library 或 --skill-directory');
    const lib=await bindLibrary({base,library:options.library,skillRepository:options['source-repository'] || options.repository,skillDirectory:options['skill-directory']});
    if(options['skill-directory']) {
      const migrated=await migrateManagedSkills(lib,{targetDirectory:lib.skillDirectory});
      const catalog=await exportCatalog(lib,{skillDirectory:lib.skillDirectory});
      const links=await syncPersonalSkills({base,library:lib});
      print({library:lib.root,skillDirectory:lib.skillDirectory,migrated,catalog,links});return;
    }
    print({library:lib.root,skillDirectory:lib.skillDirectory});return;
  }
  if(command==='history-import'){
    if(!options.input?.length||!options.output)throw new Error('history-import 需要 --input 和 --output');
    const dataset=await importHistory(options.input);
    if(options['source-repository'] || options.repository)dataset.git=await scanGit(options['source-repository'] || options.repository);
    await writeJson(options.output,dataset);print({output:options.output,sessions:dataset.sessions.length,warnings:dataset.warnings,git:dataset.git?{commits:dataset.git.commits.length,relevant:dataset.git.commits.filter(c=>c.relevant).length}:null});return;
  }
  if(command==='hook'&&process.env.DOCUMENT_LEARNING_WORKER==='1'){print({});return;}
  if(!['hook','query','show-rule','learn','rollback','skill-rollback','replay','reconcile','backfill','catalog','sync-skills','recover'].includes(command))throw new Error(`未知命令：${command}`);
  if(command==='recover'){
    // recover 只读取证据，不同步技能目录，避免只读操作产生额外写入。
    const library=await resolveLibrary({base,root:options.library,sync:false});
    print(recoveryInput(await library.read(),options.session,options.turn,options.token));return;
  }
  const library=await resolveLibrary({base,root:options.library});
  const binding=await readBinding(base) || {};
  if(command==='catalog'){print(await exportCatalog(library));return;}
  if(command==='sync-skills'){print(await syncPersonalSkills({base,library}));return;}
  if(command==='backfill'){
    if(!options.provider&&!options.decision)throw new Error('补学默认由当前会话整理：先读取数据集，生成符合学习 schema 的 JSON，再用 --decision 提交。仅明确选择其他模型后端时使用 --provider；不会默认额外外发私人资料。');
    const learner=options.decision?async()=>readJson(options.decision):createProvider(await readJson(options.provider));
    if(options.decision)learner.identity='host-current-session';
    const result=await runBackfill(library,await input(),learner,{jobId:options.job,replaceRun:options['replace-history'],progress:p=>process.stderr.write(`补学 ${JSON.stringify(p)}\n`)});
    print({...result,links:await syncPersonalSkills({base,library})});return;
  }
  if(command==='hook'){
    const event=await input();activeHookEvent=event.hook_event_name;
    const output=await handleHook(library,options.agent || 'codex',event);
    if(Object.keys((await library.read()).skills).length)await syncPersonalSkills({base,library});print(output);return;
  }
  if(command==='query'){if(!options.context)throw new Error('query 需要 --context');print(await retrieve(library,await readJson(options.context)));return;}
  if(command==='learn'){const result=await applyLearning(library,await input());await exportCatalog(library);print(result);return;}
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
  if(command==='hook'){
    const message=`文档学习未完成：${error.message}。修正结构或引文后重交同一票据信号；scope 是对象，例如 {"task":"当前任务标识"}，不能写成字符串。未完成前不要宣称学习已保存，也不向用户输出内部治理状态。`;
    print(['SessionStart','UserPromptSubmit','PostToolUse'].includes(activeHookEvent)?{hookSpecificOutput:{hookEventName:activeHookEvent,additionalContext:message}}:{systemMessage:message});process.exitCode=0;
  }
  else{process.stderr.write(`文档学习：${error.message}\n`);process.exitCode=1;}
}
