#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {HOST,BROWSERS,SUPPORT,EXTENSION_ID,extensionIdFromKey}=require('./core.cjs');

function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}

/**
 * Extension IDs of every Threadkeeper found on this Mac: the fixed ID (shared/extension-key.json),
 * and any Threadkeeper a browser profile has loaded (from the profile's own list
 * of extensions; nothing else in the profile is read).
 */
function detectExtensionIds({home=os.homedir(),source=__dirname}={}){
  const found=new Map();
  // The fixed ID every keyed build has, registered ahead of time so the helper (and the library
  // backups it holds) is reachable the moment Threadkeeper moves to that ID.
  const fixed=readJson(path.join(source,'..','shared','extension-key.json'));
  if(fixed&&typeof fixed.key==='string'&&fixed.key) found.set(extensionIdFromKey(fixed.key),'fixed ID');
  for(const browser of BROWSERS){
    const base=path.join(home,SUPPORT,browser.dir);
    let profiles=[];
    try{profiles=fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()&&(d.name==='Default'||/^Profile \d+$/.test(d.name))).map(d=>d.name);}catch{continue;}
    for(const profile of profiles){
      for(const prefs of ['Secure Preferences','Preferences']){
        const settings=readJson(path.join(base,profile,prefs))?.extensions?.settings;
        if(!settings||typeof settings!=='object') continue;
        for(const [id,entry] of Object.entries(settings)){
          if(!EXTENSION_ID.test(id)||!entry||typeof entry!=='object') continue;
          // Only a Threadkeeper loaded from a folder on this Mac (unpacked) is trusted without
          // asking: such an entry has no manifest copy in the profile, only its folder. An
          // installed extension that merely calls itself Threadkeeper is not added; the helper
          // hands library backups to every ID it is installed for.
          if(entry.manifest||typeof entry.path!=='string'||!path.isAbsolute(entry.path)) continue;
          const name=readJson(path.join(entry.path,'manifest.json'))?.name;
          if(name==='Threadkeeper'&&!found.has(id)) found.set(id,browser.name);
        }
      }
    }
  }
  return [...found].map(([id,where])=>({id,where}));
}

function install({platform=process.platform,home=os.homedir(),extensionId,extensionIds=[],node=process.execPath,source=__dirname,paperclipRoot}={}) {
  if(platform!=='darwin')throw Error('Run this installer on your Mac.');
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Install Node.js 22 or newer first.');
  const wanted=[...extensionIds,extensionId].filter(Boolean);
  if(!wanted.length||wanted.some(id=>!EXTENSION_ID.test(id)))throw Error('Paste the 32-letter extension ID from the Threadkeeper card on the extensions page.');
  if(!path.isAbsolute(node))throw Error('Node.js must have an absolute installation path.');
  const root=path.join(home,SUPPORT,'Threadkeeper/Bridge');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  // IDs registered earlier stay registered, so Threadkeeper in a second browser keeps working.
  const before=readJson(path.join(root,'config.json'))||{};
  const ids=[...new Set([...wanted,...(Array.isArray(before.extensionIds)?before.extensionIds:[]),before.extensionId].filter(id=>EXTENSION_ID.test(id||'')))];
  for(const file of ['core.cjs','host.cjs']) fs.writeFileSync(path.join(root,file),fs.readFileSync(path.join(source,file)),{mode:0o600});
  const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
  const sourceRoot=path.resolve(source,'../..');
  const candidate=paperclipRoot || (readJson(path.join(sourceRoot,'package.json'))?.name==='paperclip'?sourceRoot:before.paperclip?.root);
  let paperclip=before.paperclip;
  if(candidate && (paperclipRoot || readJson(path.join(candidate,'package.json'))?.name==='paperclip')){
    if(!path.isAbsolute(candidate)||readJson(path.join(candidate,'package.json'))?.name!=='paperclip')throw Error('Choose the Paperclip fork folder.');
    if(Number(process.versions.node.split('.')[0])<24)throw Error('Paperclip requires Node.js 24.11 or newer.');
    const cli=path.join(candidate,'cli/src/index.ts'),tsx=path.join(candidate,'cli/node_modules/tsx/dist/cli.mjs');
    if(!fs.existsSync(cli)||!fs.existsSync(tsx))throw Error('Install the Paperclip fork dependencies before registering it with the helper.');
    const shim=path.join(root,'paperclip-source');
    paperclip={root:fs.realpathSync(candidate),node,cli,tsx,shim,instanceId:'default'};
    fs.writeFileSync(shim,`#!/bin/sh\ncd ${quote(paperclip.root)} || exit 1\nexport PAPERCLIP_SHIM_PATH=${quote(shim)}\nexport PAPERCLIP_THREADKEEPER_EXTENSION_IDS=${quote(ids.join(','))}\nexport PAPERCLIP_BUNDLED_PLUGIN_ROOT=${quote(path.join(paperclip.root,'packages/plugins'))}\nexport PATH=${quote(path.dirname(node)+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}\nexec ${quote(node)} ${quote(tsx)} ${quote(cli)} "$@"\n`,{mode:0o700});
    fs.chmodSync(shim,0o700);
  }
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({extensionIds:ids,...(paperclip?{paperclip}:{})}),{mode:0o600});
  const launcher=path.join(root,'launch-host');
  // The Node.js found at install time first; if it was since removed (nvm, Homebrew upgrades),
  // any other installed Node.js. A browser starts the helper with almost no PATH.
  fs.writeFileSync(launcher,`#!/bin/sh
HOST=${quote(path.join(root,'host.cjs'))}
for NODE in ${quote(node)} /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" /usr/bin/node; do
  if [ -x "$NODE" ]; then exec "$NODE" "$HOST" "$@"; fi
done
exit 1
`,{mode:0o700});
  fs.chmodSync(launcher,0o700);
  const body=JSON.stringify({name:HOST,description:'Threadkeeper account windows and library backups',path:launcher,type:'stdio',allowed_origins:ids.map(id=>`chrome-extension://${id}/`)},null,2);
  const manifests=[],browsers=[];
  for(const browser of BROWSERS){
    const base=path.join(home,SUPPORT,browser.dir);
    // Google Chrome always (it opens the account windows); the others only where installed.
    if(browser.dir!=='Google/Chrome'&&!fs.existsSync(base)) continue;
    const dir=path.join(base,'NativeMessagingHosts');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const file=path.join(dir,HOST+'.json');
    fs.writeFileSync(file,body,{mode:0o600});
    manifests.push(file);browsers.push(browser.name);
  }
  return {root,manifest:manifests[0],manifests,browsers,extensionIds:ids};
}

function uninstall({home=os.homedir()}={}){
  const removed=[];
  const files=BROWSERS.map(b=>path.join(home,SUPPORT,b.dir,'NativeMessagingHosts',HOST+'.json'));
  const root=path.join(home,SUPPORT,'Threadkeeper/Bridge');
  for(const file of [...files,...['launch-host','config.json','host.cjs','core.cjs'].map(n=>path.join(root,n))]){
    try{fs.unlinkSync(file);removed.push(file);}catch{/* not there */}
  }
  return {removed};
}

if(require.main===module){
  try{
    if(process.argv[2]==='--uninstall'){
      uninstall();
      console.log('Helper removed. Account profiles and library backups were kept.');
    }else{
      const args=process.argv.slice(2).filter(Boolean);
      const folderIndex=args.indexOf('--paperclip-root');
      const paperclipRoot=folderIndex>=0?args.splice(folderIndex,2)[1]:undefined;
      if(folderIndex>=0&&!paperclipRoot)throw Error('Pass the Paperclip fork folder after --paperclip-root.');
      const typed=args;
      const detected=typed.length?[]:detectExtensionIds();
      if(!typed.length&&!detected.length)throw Error('Threadkeeper was not found in any browser on this Mac. Load it first, or run this again and paste its extension ID.');
      for(const d of detected)console.log(`Found Threadkeeper ${d.id} (${d.where}).`);
      const r=install({extensionIds:typed.length?typed:detected.map(d=>d.id),paperclipRoot});
      console.log(`\nMac helper installed for: ${r.browsers.join(', ')}.\n\nReturn to Threadkeeper and choose Check connection.\nNo existing browser profiles were changed.`);
    }
  }catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={install,uninstall,detectExtensionIds};
