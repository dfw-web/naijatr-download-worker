import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import http from 'node:http';
import { decryptFlickUrl, resolveFlick, scopedMediaHeaders, validateFlickRef } from '../lib/flick.js';
import { checkUrl, makePolicy, safeGet } from '../lib/net.js';
import { loadSources } from '../lib/sources.js';
import { findSource } from '../lib/resolver.js';
import { createApp } from '../lib/app.js';
const KEY = Buffer.from('7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f','hex');
export function packed(url) {
  const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',KEY,iv);
  const bytes=Buffer.concat([cipher.update(url),cipher.final()]);
  return Buffer.concat([iv,bytes,cipher.getAuthTag()]).toString('base64url');
}
const policy=makePolicy('vidrock.net,cdn.example,api.example');
const sources=loadSources(JSON.stringify({flick:{flick:{provider:'vidrock'},hosts:['vidrock.net','cdn.example'],authorization:'test fixtures only'}}));
const source=sources.get('flick');

test('Flick URL metadata format and invalid authenticated payloads',()=>{
 assert.equal(decryptFlickUrl(packed('https://cdn.example/master.m3u8')),'https://cdn.example/master.m3u8');
 assert.equal(decryptFlickUrl('bad'),null);
 assert.equal(decryptFlickUrl(packed('file:///etc/passwd')),null);
 const damaged=Buffer.from(packed('https://cdn.example/a.mp4'),'base64url');damaged[14]^=1;
 assert.equal(decryptFlickUrl(damaged.toString('base64url')),null);
});

test('Flick validates movie/episode IDs before a provider request',()=>{
 assert.deepEqual(validateFlickRef({type:'tv',tmdbId:12,season:0,episode:1}),{type:'tv',tmdbId:'12',season:'0',episode:'1'});
 for(const ref of [{type:'x',tmdbId:1},{type:'movie',tmdbId:['1']},{type:'movie',tmdbId:'1/../../'},{type:'tv',tmdbId:1,season:1},{type:'movie',tmdbId:0}])assert.throws(()=>validateFlickRef(ref));
});

test('Vidrock requests exact Flick routes and prefers English sources',async()=>{
 for(const ref of [{type:'movie',tmdbId:10378},{type:'tv',tmdbId:1,season:2,episode:3}]){
  const media=await resolveFlick(source,ref,{policy,getText:async(url,_p,opts)=>{
   assert.equal(url,ref.type==='movie'?'https://vidrock.net/api/movie/10378':'https://vidrock.net/api/tv/1/2/3');
   assert.equal(opts.headersFor(new URL(url)).origin,'https://vidrock.net');
   assert.deepEqual(opts.headersFor(new URL('https://cdn.example/redirect')),{});
   return{text:JSON.stringify({foreign:{url:packed('https://cdn.example/foreign.m3u8'),language:'French'},english:{url:packed('https://cdn.example/master.m3u8'),language:'English'}})};
  }});
  assert.equal(media.url,'https://cdn.example/master.m3u8');
  assert.equal(media.headersFor(new URL(media.url)).referer,'https://vidrock.net/');
 }
});

test('Vidrock refuses private/unapproved media even if provider metadata names it',async()=>{
 for(const url of ['http://127.0.0.1/private','http://169.254.169.254/latest/meta-data/','https://not-approved.example/video.mp4'])await assert.rejects(resolveFlick(source,{type:'movie',tmdbId:1},{policy:makePolicy('vidrock.net,127.0.0.1,169.254.169.254'),getText:async()=>({text:JSON.stringify({x:{url:packed(url)}})})}),/not allowed/);
});

test('FlixQuest uses the configured API and returns supported links with scoped headers',async()=>{
 const s=loadSources(JSON.stringify({f:{flick:{provider:'flixquest',apiUrl:'https://api.example',providerId:'licensed'},hosts:['api.example','cdn.example'],authorization:'test fixtures'}})).get('f');
 const media=await resolveFlick(s,{type:'tv',tmdbId:1,season:1,episode:2},{policy,apiKey:'fixture-secret',getText:async(url,_p,opts)=>{
  const u=new URL(url);assert.equal(u.pathname,'/api/v2/stream-tv');assert.equal(u.searchParams.get('provider'),'licensed');assert.equal(u.searchParams.get('episode'),'2');
  assert.equal(opts.headersFor(u).authorization,'Bearer fixture-secret');
  assert.deepEqual(opts.headersFor(new URL('https://cdn.example/')),{});
  return{text:JSON.stringify({links:[{url:'https://cdn.example/manifest.mpd',isDASH:true},{url:'https://cdn.example/master.m3u8',headers:{Cookie:'fixture-cookie',Referer:'https://api.example/',Host:'evil.example'}}]})};
 }});
 assert.equal(media.headersFor(new URL(media.url)).cookie,'fixture-cookie');
 assert.equal(media.headersFor(new URL('https://other.example/')).cookie,undefined);
 assert.equal(media.headersFor(new URL(media.url)).host,undefined);
 await assert.rejects(resolveFlick(s,{type:'movie',tmdbId:1},{policy,getText:async()=>({text:'{"success":false,"error":"do-not-disclose https://private.example/?secret=x"}'})}),e=>!e.message.includes('private.example'));
});

test('Flick config and default selection require explicit approval',async()=>{
 assert.equal((await findSource({type:'movie',tmdbId:1},{sources,defaultSourceId:'flick'})).flick.provider,'vidrock');
 for(const bad of [
  {flick:{provider:'unknown'},hosts:['vidrock.net'],authorization:'test'},
  {flick:{provider:'vidrock'},hosts:['cdn.example'],authorization:'test'},
  {flick:{provider:'vidrock'},url:'https://vidrock.net/',hosts:['vidrock.net'],authorization:'test'},
  {flick:{provider:'flixquest',apiUrl:'https://user:pass@api.example',providerId:'p'},hosts:['api.example'],authorization:'test'},
  {flick:{provider:'vidrock'},hosts:['vidrock.net'],authorization:''},
 ])assert.throws(()=>loadSources(JSON.stringify({x:bad})));
});

test('redirects re-evaluate scoped credentials before making the next connection',async()=>{
 let received;const b=http.createServer((req,res)=>{received=req.headers.authorization;res.end('ok');});
 await new Promise(r=>b.listen(0,'127.0.0.1',r));
 const bUrl=`http://127.0.0.1:${b.address().port}/`;
 const a=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'fixture-secret');res.writeHead(302,{Location:bUrl}).end();});
 await new Promise(r=>a.listen(0,'127.0.0.1',r));
 const aUrl=`http://127.0.0.1:${a.address().port}/`;
 const p={allowHost:h=>h==='127.0.0.1',allowIp:ip=>ip==='127.0.0.1',allowPort:()=>true};
 try{const {res}=await safeGet(aUrl,p,{headersFor:scopedMediaHeaders({Authorization:'fixture-secret'},aUrl)});res.resume();assert.equal(received,undefined);}
 finally{await Promise.all([new Promise(r=>a.close(r)),new Promise(r=>b.close(r))]);}
});

test('Flick-only mode refuses legacy sources, caller URLs and browser fallback',async()=>{
 const configured=loadSources(JSON.stringify({legacy:{url:'https://cdn.example/file.mp4',hosts:['cdn.example'],authorization:'test'},flick:{flick:{provider:'vidrock'},hosts:['vidrock.net','cdn.example'],authorization:'test'}}));
 let ref;const app=createApp({apiKey:'k',sources:configured,jobs:{start:req=>{assert.equal(typeof req.url,'function');return{id:'fixture',token:'fixture'};}},downloadMode:'flick',detect:()=>{throw Error('browser must not be used');},flickResolve:async(_s,r)=>{ref=r;return{url:'https://cdn.example/video.mp4'};}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const post=body=>fetch(base+'/download/start',{method:'POST',headers:{Authorization:'Bearer k','Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  assert.equal((await post({sourceId:'legacy'})).status,403);
  assert.equal((await post({sourceId:'flick',tmdbId:1,url:'https://evil.example/'})).status,400);
  const started=await post({sourceId:'flick',tmdbId:10378,type:'movie'});assert.equal(started.status,202);assert.doesNotMatch(JSON.stringify(await started.json()),/cdn.example/);
  // /start queues resolution; resolveFlick runs inside the asynchronous job.
  assert.equal(ref,undefined);
  checkUrl('https://cdn.example/video.mp4',policy);
 }finally{await new Promise(r=>server.close(r));}
});
