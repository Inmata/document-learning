import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {hash} from './io.mjs';

export async function engineFingerprint() {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const names=(await readdir(join(root,'src'))).filter(n=>n.endsWith('.mjs')).sort();
  const files=['bin/document-learning.mjs','skills/document-learning/SKILL.md',...names.map(n=>`src/${n}`)];
  const contents=await Promise.all(files.map(async path=>({path,text:await readFile(join(root,path),'utf8')})));
  return hash(contents);
}
