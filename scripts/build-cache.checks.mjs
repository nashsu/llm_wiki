import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prune} from './build-cache.mjs';
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'build-cache-test-')));
 execFileSync('git',['init','-q',root]);
 await fs.mkdir(path.join(root,'src-tauri/target/debug/deps'),{recursive:true});
 await fs.mkdir(path.join(root,'src-tauri/target/release/bundle/macos/Synthetic.app'),{recursive:true});
 await fs.writeFile(path.join(root,'src-tauri/Cargo.toml'),'[package]\nname="synthetic"\nversion="0.0.0"');
 await fs.writeFile(path.join(root,'src-tauri/target/debug/deps/cached'),'cache');
 await fs.writeFile(path.join(root,'src-tauri/target/private-evaluation.local.json'),'keep');
 return root;
}
test('dry-run preserves caches; explicit pruning preserves bundles and evaluation data',async()=>{
 const root=await fixture();try{
  assert.deepEqual(await prune(root,{maxGiB:0}),{bytes:5,removed:0});
  assert.deepEqual(await prune(root,{apply:true,maxGiB:0,commands:''}),{bytes:5,removed:5});
  await fs.access(path.join(root,'src-tauri/target/release/bundle/macos/Synthetic.app'));
 assert.equal(await fs.readFile(path.join(root,'src-tauri/target/private-evaluation.local.json'),'utf8'),'keep');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('root compiler libraries are pruned but debug executable stays available',async()=>{
 const root=await fixture();try{
  await fs.writeFile(path.join(root,'src-tauri/target/debug/libsynthetic.a'),'archive');
  await fs.writeFile(path.join(root,'src-tauri/target/debug/synthetic'),'executable');
  await prune(root,{apply:true,maxGiB:0,commands:''});
  await assert.rejects(fs.access(path.join(root,'src-tauri/target/debug/libsynthetic.a')));
  assert.equal(await fs.readFile(path.join(root,'src-tauri/target/debug/synthetic'),'utf8'),'executable');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('active compiler and below-limit caches prevent deletion',async()=>{
 const root=await fixture();try{
  assert.equal((await prune(root,{apply:true,commands:''})).removed,0);
  await assert.rejects(prune(root,{apply:true,maxGiB:0,commands:'/usr/local/bin/cargo\n'}),/Build in progress/);
  await assert.rejects(prune(root,{apply:true,maxGiB:0,commands:root+'/src-tauri/target/debug/synthetic\n'}),/Debug application is running/);
  await fs.access(path.join(root,'src-tauri/target/debug/deps/cached'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('symlink candidates are rejected before any removal',async()=>{
 const root=await fixture();try{
  await fs.symlink(path.join(root,'src-tauri/target/private-evaluation.local.json'),path.join(root,'src-tauri/target/debug/deps/link'));
  await assert.rejects(prune(root,{apply:true,maxGiB:0,commands:''}),/symbolic-link/);
  await fs.access(path.join(root,'src-tauri/target/debug/deps/cached'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
