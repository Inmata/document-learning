#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {resolveLibrary,bindLibrary,dataRoot,readBinding} from '../src/library.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {handleHook} from '../src/hooks.mjs';
import {applyLearning,retrieve,retireRules} from '../src/knowledge.mjs';
import {importHistory} from '../src/history.mjs';
import {scanGit} from '../src/git-history.mjs';
import {runReplay,reconcileReplay} from '../src/replay.mjs';
import {createProvider} from '../src/provider.mjs';
import {install,uninstall,doctor,syncPersonalSkills,initSkillRepository,publishRepository} from '../src/install.mjs';
import {rollbackSkill,migrateManagedSkills} from '../src/skills.mjs';
import {runBackfill} from '../src/backfill.mjs';
import {exportCatalog} from '../src/catalog.mjs';
import {loadConfig} from '../src/config.mjs';
import {runConsolidation,consolidationInstructions,consolidationSchema} from '../src/consolidate.mjs';
import {createJudge} from '../src/judge.mjs';
import {remember} from '../src/remember.mjs';
import {applyPromotion} from '../src/knowledge.mjs';

const {values:options,positionals}=parseArgs({allowPositionals:true,options:{home:{type:'string'},library:{type:'string'},repository:{type:'string'},'source-repository':{type:'string'},'skill-directory':{type:'string'},'import-from':{type:'string',multiple:true},bind:{type:'boolean',default:false},repo:{type:'string'},remote:{type:'string'},visibility:{type:'string'},branch:{type:'string'},message:{type:'string'},'no-commit':{type:'boolean',default:false},'replace-history':{type:'string'},decision:{type:'string'},agent:{type:'string'},owner:{type:'string'},input:{type:'string',multiple:true},output:{type:'string'},context:{type:'string'},version:{type:'string'},name:{type:'string'},job:{type:'string'},provider:{type:'string'},expectations:{type:'string'},'replay-only':{type:'boolean',default:false},session:{type:'string'},task:{type:'string'},kind:{type:'string'},merge:{type:'boolean',default:true},'allow-claude-signal':{type:'boolean',default:false},schedule:{type:'boolean',default:false},text:{type:'string'},quote:{type:'string'},source:{type:'string'},category:{type:'string'},strength:{type:'string'},scope:{type:'string'},key:{type:'string'},value:{type:'string'},'scope-basis':{type:'string'},id:{type:'string',multiple:true},reason:{type:'string'},'confirm-source':{type:'string',multiple:true},'confirm-quote':{type:'string'},'if-due':{type:'boolean',default:false},now:{type:'boolean',default:false},'all-existing':{type:'boolean',default:false},help:{type:'boolean',default:false}}});
const command=positionals[0] || 'help';
const base=options.home || dataRoot();
async function stdin(){let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>16*1024*1024)throw new Error('输入超过 16MB');}return text;}
async function input(){const file=options.input?.[0];return file&&file!=='-'?readJson(file):JSON.parse(await stdin());}
const print=value=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`);
async function main(){
  if(command==='help'||options.help){process.stdout.write(`文档持续学习插件\n\nnode bin/document-learning.mjs <命令> [选项]\n\ninstall [--agent codex|claude|both] [--schedule] [--allow-claude-signal] [--source-repository 只读来源仓库] [--skill-directory 个人技能与长期记忆仓库]\nuninstall [--agent codex|claude]\ndoctor\nbind [--library 个人库] [--source-repository 只读来源仓库] [--skill-directory 个人技能与长期记忆仓库]\ninit-skill-repo --output 新技能仓库目录 [--import-from 现有技能仓库] [--bind]\npublish-repo [--repo 仓库目录] [--remote 远端地址 | --name 仓库名 --owner 账号] [--visibility private|public] [--branch 分支] [--no-commit]\nquery --context 条件JSON文件\nlearn --input 已有原始证据及经验JSON\ncatalog：生成可阅读的经验及案例目录\nsync-skills：连接个人技能入口\nhistory-import --input 会话JSON或JSONL（可重复） [--source-repository 来源仓库] --output 数据集JSON\nbackfill --input 数据集 --decision 当前会话整理的JSON [--job 标识] [--replace-history 旧回放标识]\nbackfill --input 数据集 --provider 已明确选择的后端配置\nreplay --input 数据集JSON [--provider 后端配置JSON] [--job 标识] [--merge]\nreconcile --input 回放任务目录\nrollback --version doctor/events 中的回退版本\nretire --id 经验标识（可重复） --reason 撤销原因：撤销误收的经验，保留回退版本\nremember --session 会话 --text 经验 --quote 用户原话 [--category method|preference|constraint|fact] [--strength suggestion|default|required] [--scope 范围JSON | --task 文档标识 --kind 类型] [--key 维度 --value 选择] [--source 已登记的用户回答来源]：仅在用户明确要求记住时使用
consolidate [--if-due | --now | --all-existing]：扫描宿主会话并批量整理经验；--if-due 未到期时不调用模型
proposals：列出待确认的晋升提案
promote --id 提案 --confirm-source 用户回答来源 [--confirm-quote 原文]：用户确认后执行晋升\n\n--repository 是 --source-repository 的旧别名，不作为技能发布目录。\n--skill-directory 可选指定个人文档技能与长期经验 Git 仓库根目录；未指定时默认使用内置 library/skills。\n`);return;}
  if(command==='install'){print(await install({base,agents:!options.agent||options.agent==='both'?['codex','claude']:[options.agent],repository:options['source-repository'] || options.repository,skillDirectory:options['skill-directory'],allowClaudeSignal:options['allow-claude-signal'],schedule:options.schedule}));return;}
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
  // 整理器调用的模型进程会继承 WORKER=1：其中的宿主 hook 直接放行，也不允许再触发整理以外的写入。
  if(command==='hook'&&process.env.DOCUMENT_LEARNING_WORKER==='1'){print({});return;}
  if(!['hook','query','show-rule','learn','rollback','retire','skill-rollback','replay','reconcile','backfill','catalog','sync-skills','remember','consolidate','proposals','promote'].includes(command))throw new Error(`未知命令：${command}`);
  const library=await resolveLibrary({base,root:options.library});
  const binding=await readBinding(base) || {};
  const config=['catalog','remember','promote','consolidate','retire'].includes(command)?await loadConfig(base):null;
  const catalogOptions={maxChars:config?.manual.maxChars};
  if(command==='catalog'){print(await exportCatalog(library,catalogOptions));return;}
  if(command==='remember'){
    const scope=options.scope?JSON.parse(options.scope):{...(options.task?{task:options.task}:{}),...(!options.task&&options.kind?{kind:options.kind}:{})};
    print(await remember(library,{session:options.session,text:options.text,quote:options.quote,source:options.source,category:options.category,strength:options.strength,scope,key:options.key,value:options.value,scopeBasis:options['scope-basis'],task:options.task,kind:options.kind,catalog:catalogOptions}));return;
  }
  if(command==='proposals'){
    const state=await library.read();
    print((state.proposals || []).filter(p=>p.status==='pending').map(p=>({...p,sources:p.from.map(id=>{const r=state.rules.find(x=>x.id===id);return r?{id,text:r.text,scope:r.scope,strength:r.strength,support:r.support}:{id,missing:true};})})));return;
  }
  if(command==='promote'){
    if(!options.id||!options['confirm-source']?.length)throw new Error('promote 需要 --id 提案和 --confirm-source 用户确认回答的来源');
    const confirmation=options['confirm-source'].map(source=>({source,...(options['confirm-quote']?{quote:options['confirm-quote']}:{})}));
    const {result}=await library.transact('promote',state=>applyPromotion(state,options.id[0],confirmation,config.promotion));
    print({...result,catalog:await exportCatalog(library,catalogOptions)});return;
  }
  if(command==='consolidate'){
    const mode=options['all-existing']?'all-existing':(options.now?'now':'if-due');
    const learner=createProvider({type:'claude',...(config.consolidate.model?{model:config.consolidate.model}:{}),effort:config.consolidate.effort,timeout:900000,...(config.consolidate.baseUrl?{environment:{ANTHROPIC_BASE_URL:config.consolidate.baseUrl,...(config.consolidate.apiKey?{ANTHROPIC_API_KEY:config.consolidate.apiKey,ANTHROPIC_AUTH_TOKEN:config.consolidate.apiKey}:{})}}:{})},{schema:consolidationSchema,instructions:consolidationInstructions,check:output=>{if(!Array.isArray(output?.sessions))throw new Error('整理模型输出缺少 sessions 判断');}});
    const judge=createJudge(config.judge);
    const result=await runConsolidation(library,{config,learner,judge,mode,progress:p=>process.stderr.write(`整理 ${JSON.stringify(p)}
`)});
    if(result.status==='consolidated'&&Object.keys((await library.read()).skills).length)await syncPersonalSkills({base,library});
    print(result);return;
  }
  if(command==='sync-skills'){print(await syncPersonalSkills({base,library}));return;}
  if(command==='backfill'){
    if(!options.provider&&!options.decision)throw new Error('补学默认由当前会话整理：先读取数据集，生成符合学习 schema 的 JSON，再用 --decision 提交。仅明确选择其他模型后端时使用 --provider；不会默认额外外发私人资料。');
    const learner=options.decision?async()=>readJson(options.decision):createProvider(await readJson(options.provider));
    if(options.decision)learner.identity='host-current-session';
    const result=await runBackfill(library,await input(),learner,{jobId:options.job,replaceRun:options['replace-history'],progress:p=>process.stderr.write(`补学 ${JSON.stringify(p)}\n`)});
    print({...result,links:await syncPersonalSkills({base,library})});return;
  }
  if(command==='hook'){
    const event=await input();
    const output=await handleHook(library,options.agent || 'codex',event);
    // 技能入口同步要等安装锁，只在会话开始时做，避免 SessionEnd 等短超时 hook 被宿主终止。
    if(event.hook_event_name==='SessionStart'&&Object.keys((await library.read()).skills).length)await syncPersonalSkills({base,library});print(output);return;
  }
  if(command==='query'){if(!options.context)throw new Error('query 需要 --context');print(await retrieve(library,await readJson(options.context)));return;}
  if(command==='learn'){const result=await applyLearning(library,await input());await exportCatalog(library);print(result);return;}
  if(command==='show-rule'){
    const state=await library.read(),rule=state.rules.find(r=>r.id===options.name);
    if(!rule)throw new Error('未找到对应经验');
    print({rule,sources:rule.evidence.map(e=>state.sources[e.source])});return;
  }
  if(command==='rollback'){print(await library.rollback(options.version));return;}
  if(command==='retire'){
    const {revision,result}=await library.transact('retire',state=>retireRules(state,options.id || [],options.reason));
    const version=(await library.read()).events.findLast(e=>e.revision===revision)?.rollback || null;
    print({revision,rollback:version,changes:result,catalog:await exportCatalog(library,catalogOptions)});return;
  }
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
  // hook 失败不阻断宿主，也不向当前会话注入长提示；原因写到 stderr。
  if(command==='hook'){process.stderr.write(`文档学习 hook：${error.message}
`);print({});process.exitCode=0;}
  else{process.stderr.write(`文档学习：${error.message}\n`);process.exitCode=1;}
}
