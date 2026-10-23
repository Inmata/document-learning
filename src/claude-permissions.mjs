import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const scriptPath=pluginRoot=>join(pluginRoot,'bin','document-learning.mjs').replaceAll('\\','/');
// 可选授权：只允许模型以绝对脚本路径运行 remember，避免 Claude 自动模式拦截用户要求的记忆。
export const rememberCommand=(pluginRoot=root)=>`node ${JSON.stringify(scriptPath(pluginRoot))} remember`;
export function rememberAllowRule(pluginRoot=root) {
  if(/[*\r\n$`"]/.test(scriptPath(pluginRoot)))throw new Error('插件路径含不支持的权限模式字符，未添加允许规则');
  return `Bash(${rememberCommand(pluginRoot)} *)`;
}
// 自动模式也会拦截用户主导的提问和晋升：promote 只接受问答回答作证据，proposals 只读。
export function pluginAllowRules(pluginRoot=root) {
  const cli=`node ${JSON.stringify(scriptPath(pluginRoot))}`;
  return [rememberAllowRule(pluginRoot),`Bash(${cli} proposals)`,`Bash(${cli} promote *)`,'AskUserQuestion','mcp__codeg-mcp__ask_user_question'];
}

export function removeSignalPermission(config,record) {
  if(!record)return;
  const permissions=config.permissions;
  if(!permissions||!Array.isArray(permissions.allow))return;
  permissions.allow=permissions.allow.filter(rule=>!record.added.includes(rule));
  if(record.allowCreated&&!permissions.allow.length)delete permissions.allow;
  if(record.permissionsCreated&&!Object.keys(permissions).length) {
    if(record.permissionsWasNull)config.permissions=null;else delete config.permissions;
  }
}
export function addSignalPermission(config,pluginRoot) {
  const rules=pluginAllowRules(pluginRoot),before=config.permissions;
  if(before!==undefined&&before!==null&&(typeof before!=='object'||Array.isArray(before)))throw new Error('现有 permissions 格式无法识别，保留原文件');
  if(before?.allow!==undefined&&!Array.isArray(before.allow))throw new Error('现有 permissions.allow 格式无法识别，保留原文件');
  const record={enabled:true,added:[],permissionsCreated:!before,permissionsWasNull:before===null,allowCreated:before?.allow===undefined};
  const permissions=config.permissions ||= {};permissions.allow ||= [];
  for(const rule of rules)if(!permissions.allow.includes(rule)){permissions.allow.push(rule);record.added.push(rule);}
  return record;
}
