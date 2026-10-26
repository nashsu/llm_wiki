// Build-time maintenance only. Never delete application bundles or user data.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

export const cachePaths = ['debug/deps', 'debug/build', 'debug/incremental',
  'debug/.fingerprint', 'release/deps', 'release/build', 'release/incremental', 'release/.fingerprint'];
export async function bytesAt(p) {
  const s=await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!s)return 0;
  if(s.isSymbolicLink())throw Error('Refusing symbolic-link cache: '+p);
  if(!s.isDirectory())return s.size;
  return (await Promise.all((await fs.readdir(p)).map(n=>bytesAt(path.join(p,n))))).reduce((a,b)=>a+b,0);
}
export async function prune(root, {apply=false, maxGiB=6, commands}={}) {
  if(!Number.isFinite(maxGiB)||maxGiB<0)throw Error('Invalid cache size limit');
  const target=path.join(root,'src-tauri/target');
  const manifest=path.join(root,'src-tauri/Cargo.toml');
  await fs.access(manifest);
  // Validate target and each candidate before any mutation; never follow links.
  if(await fs.realpath(root)!==root)throw Error('Repository must use its real path');
  const targetStat=await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!targetStat)return {bytes:0,removed:0};
  if(targetStat.isSymbolicLink()||!targetStat.isDirectory())throw Error('Invalid target directory');
  for(const profile of ['debug','release']) {
    const s=await fs.lstat(path.join(target,profile)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(s&&(s.isSymbolicLink()||!s.isDirectory()))throw Error('Invalid build profile');
  }
  const candidates=[...cachePaths];
  for(const profile of ['debug','release']) {
    const names=await fs.readdir(path.join(target,profile)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    candidates.push(...names.filter(n=>/^lib.+\.(a|rlib|dylib|so)$/.test(n)).map(n=>profile+'/'+n));
  }
  const sizes=await Promise.all(candidates.map(p=>bytesAt(path.join(target,p))));
  const bytes=sizes.reduce((a,b)=>a+b,0);
  if(!apply||bytes<=maxGiB*1024**3)return {bytes,removed:0};
  const running=commands??execFileSync('ps',['-axo','comm'],{encoding:'utf8'});
  // Conservative: another repository's compiler also prevents cleanup.
  if(running.split('\n').some(c=>/(^|\/)(cargo|rustc|rustdoc)(\s|$)/.test(c.trim())))
    throw Error('Build in progress; retry cache maintenance after it finishes');
  if(running.includes(target+'/debug/'))throw Error('Debug application is running; stop it before maintenance');
  const tracked=execFileSync('git',['-C',root,'ls-files','src-tauri/target'],{encoding:'utf8'});
  if(tracked.trim())throw Error('Refusing to remove tracked build files');
  for(const p of candidates)await fs.rm(path.join(target,p),{recursive:true,force:true});
  return {bytes,removed:bytes};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=await fs.realpath(fileURLToPath(new URL('..',import.meta.url)));
  const limitArg=process.argv.find(a=>a.startsWith('--max-gib='));
  const result=await prune(root,{apply:process.argv.includes('--apply'),maxGiB:limitArg?Number(limitArg.slice(10)):6});
  console.log(JSON.stringify({compilerCacheGiB:Number((result.bytes/1024**3).toFixed(2)),removedGiB:Number((result.removed/1024**3).toFixed(2)),applicationBundlesPreserved:true}));
}
