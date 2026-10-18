"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const { EventEmitter }=require("node:events");
const { typeTextToWindow }=require("../src/platform/windows-text-input");
async function unit() {
 for(const target of ["", "0", "123;exit", "9999999999999999999"])
   await assert.rejects(typeTextToWindow(target,"hello"));
 let payload,args;
 await typeTextToWindow("123", "中文\nemoji 😀",{spawnImpl:(_file,argv)=>{
   args=argv; const child=new EventEmitter(); child.stderr={resume(){}};
   child.stdin=new EventEmitter(); child.stdin.end=value=>{payload=JSON.parse(value);setImmediate(()=>child.emit("close",0));};
   return child;
 }});
 assert.deepEqual(payload,{target:"123",text:"中文\nemoji 😀"});
 assert.ok(!args.includes(payload.text),"text travels only on stdin");
 await assert.rejects(typeTextToWindow("123","private text",{spawnImpl:()=>{
   const child=new EventEmitter();child.stderr={resume(){}};child.stdin=new EventEmitter();
   child.stdin.end=()=>setImmediate(()=>child.emit("close",1));return child;
 }}),/Direct input failed/);
 console.log("PASS direct-input validation, private stdin transport and native failure propagation");
}
async function native() {
 if(process.platform!=="win32")return;
 const {_electron}=require(process.env.PLAYWRIGHT_MODULE_PATH||"playwright");
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|TOKEN|SECRET|ELECTRON_RUN_AS_NODE/i.test(key)));
 const application=await _electron.launch({executablePath:require("electron"),args:[__filename,"--fixture"],env});
 try {
   const page=await application.firstWindow();await page.waitForSelector("textarea");
   const clipboardHash=()=>application.evaluate(({clipboard})=>{
     const hash=globalThis.testCrypto.createHash("sha256");
     for(const format of clipboard.availableFormats().sort()){hash.update(format);hash.update(clipboard.readBuffer(format));}
     return hash.digest("hex");
   });
   const before=await clipboardHash();
   const handle=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
   for(const selector of ["textarea","#editor"]) {
     await page.locator(selector).focus();
     const text="中文 English 😀 "+"完整句子，不省略。".repeat(150)+"\n第二行\t最后一句。";
     await typeTextToWindow(handle,text);
     await page.waitForTimeout(300);
     await page.waitForFunction(({selector,text})=>{const el=document.querySelector(selector);return (el.value??el.innerText)===text;},{selector,text},{timeout:8000});
     assert.equal(await page.evaluate(()=>window.commandKeys),0,"newlines/tabs must not submit or change focus");
     assert.equal(await clipboardHash(),before,"all clipboard formats remain unchanged");
     console.log("PASS real Windows native input: "+selector+", Chinese/Latin/emoji/long text/newline/tab, no clipboard change");
   }
   const retained=await page.locator("#editor").innerText();
   await assert.rejects(typeTextToWindow("1","must not reach the editor"),/Direct input failed/);
   assert.equal(await page.locator("#editor").innerText(),retained);
   assert.equal(await clipboardHash(),before);
   console.log("PASS invalid native target fails without typing into the foreground editor or changing clipboard");
 } finally {await application.close();}
}
if(process.versions.electron&&process.argv.includes("--fixture")) {
 const {app,BrowserWindow}=require("electron");
 globalThis.testCrypto=require("node:crypto");
 app.setPath("userData",fs.mkdtempSync(path.join(os.tmpdir(),"ovi-direct-input-")));
 app.whenReady().then(async()=>{
   const win=new BrowserWindow({width:700,height:420,webPreferences:{sandbox:true}});
   await win.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent('<textarea style="width:95%;height:130px"></textarea><div id="editor" contenteditable="true" style="white-space:pre-wrap;border:1px solid gray;height:130px;overflow:auto"></div><script>window.commandKeys=0;document.addEventListener("keydown",e=>{if((e.key==="Enter"&&!e.shiftKey)||e.key==="Tab")window.commandKeys++;});</script>'));
   win.show();win.focus();
 });
} else (async()=>{await unit();if(process.argv.includes("--native"))await native();})().catch(error=>{console.error(error);process.exitCode=1;});
