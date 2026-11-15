#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {handle,frame,createDecoder,createBackupSession,EXTENSION_ID}=require('./core.cjs');
let config;
try {config=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));}catch{process.exit(1);}
// The browser passes the calling extension's origin. The manifest and the host both bind to it.
const ids=[...(Array.isArray(config.extensionIds)?config.extensionIds:[]),config.extensionId].filter(id=>EXTENSION_ID.test(id||''));
if(!ids.some(id=>process.argv[2]===`chrome-extension://${id}/`)) process.exit(1);
const session=createBackupSession();
let chain=Promise.resolve();
const send=x=>process.stdout.write(frame(x));
const decoder=createDecoder(msg=>{chain=chain.then(async()=>{try{send(await handle(msg,{session,paperclip:config.paperclip}));}catch(e){send({ok:false,error:e.message});}});},e=>send({ok:false,error:e.message}));
process.stdin.on('data',chunk=>decoder.push(chunk));
// A backup cut off half way (browser closed) leaves nothing behind.
process.stdin.on('end',()=>{decoder.end();chain.then(()=>session.abort());});
process.stdout.on('error',()=>{session.abort();process.exit(1);});
