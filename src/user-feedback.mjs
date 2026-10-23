// 只接收宿主问答工具的实际返回值；问题、候选项及助手摘要均不作为用户引文。
// Codex 原生提问是 request_user_input（异步变体同格式），答案按问题 id 分组。
const questionTools = new Set(['AskUserQuestion','mcp__codeg-mcp__ask_user_question','mcp__codeg_mcp__ask_user_question','request_user_input','request_user_input_async']);
export const isUserQuestion = name => questionTools.has(name);

function responseObject(value,depth=0) {
  if(depth>4||!value)return null;
  if(typeof value==='string') {
    if(value.length>500000)return null;
    try{return responseObject(JSON.parse(value),depth+1);}catch{return null;}
  }
  if(typeof value!=='object'||Array.isArray(value)||value.isError||value.is_error)return null;
  if(value.answers||typeof value.response==='string')return value;
  if(value.structuredContent)return responseObject(value.structuredContent,depth+1);
  if(Array.isArray(value.content))for(const block of value.content) {
    if(block.type==='text'){const found=responseObject(block.text,depth+1);if(found)return found;}
  }
  return null;
}

export function userAnswers(event) {
  if(!isUserQuestion(event.tool_name)||event.is_error||event.tool_response?.isError)return [];
  const result=responseObject(event.tool_response ?? event.tool_result);
  // 自动超时、拒答与空响应均不表示用户选择了默认项。
  if(!result||result.declined||result.cancelled||result.canceled||result.afkTimeoutMs!==undefined)return [];
  let input=event.tool_input;
  if(typeof input==='string')try{input=JSON.parse(input);}catch{return [];}
  const questions=input?.questions;
  if(!Array.isArray(questions)||!questions.length)return [];
  const known=new Set(questions.map(q=>q.question).filter(q=>typeof q==='string'));
  const answers=[];
  if(Array.isArray(result.answers)) {
    for(const answer of result.answers) {
      if(!known.has(answer.question)||!Array.isArray(answer.selected)||!answer.selected.length||answer.selected.some(s=>typeof s!=='string'||!s.trim()))continue;
      answers.push({question:answer.question,text:answer.selected.join('\n')});
    }
  } else if(result.answers&&typeof result.answers==='object') {
    const byId=new Map(questions.filter(q=>typeof q.id==='string'&&typeof q.question==='string').map(q=>[q.id,q.question]));
    for(const [key,value] of Object.entries(result.answers)) {
      const question=known.has(key)?key:byId.get(key);
      // Codex：{answers:[选项, 'user_note: 补充']}，补充说明去掉前缀后保留用户原话。
      const text=typeof value==='string'?value:Array.isArray(value?.answers)&&value.answers.every(a=>typeof a==='string')?value.answers.map(a=>a.replace(/^user_note:\s*/,'')).filter(a=>a.trim()).join('\n'):'';
      if(question&&text.trim())answers.push({question,text});
    }
  }
  if(!answers.length&&typeof result.response==='string'&&result.response.trim())answers.push({question:questions.map(q=>q.question).join('\n'),text:result.response});
  return answers;
}
