"use strict";
const { spawn } = require("node:child_process");
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DirectTextInput {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
 public static void Activate(IntPtr target) {
   uint current=GetCurrentThreadId(), foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
   bool attached=current!=foreground && AttachThreadInput(current,foreground,true);
   try { SetForegroundWindow(target); }
   finally { if(attached) AttachThreadInput(current,foreground,false); }
 }
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION U; }
 // The union must include its largest member even for keyboard-only input.
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public IntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
 public static void Type(IntPtr target, string text) {
   int size = Marshal.SizeOf(typeof(INPUT));
   if (size != (IntPtr.Size == 8 ? 40 : 28)) throw new Exception("Invalid INPUT size");
   for(int offset=0; offset<text.Length;) {
     if(GetForegroundWindow()!=target) throw new Exception("Target lost focus");
     foreach(int key in new[]{16,17,18,91,92})
       if((GetAsyncKeyState(key)&0x8000)!=0) throw new Exception("Modifier held");
     int count=Math.Min(32,text.Length-offset);
     if(offset+count<text.Length && char.IsHighSurrogate(text[offset+count-1])) count--;
     var events=new List<INPUT>();
     for(int i=0;i<count;i++) {
       char unit=text[offset+i];
       if(unit==10) {
         // Chromium ignores Unicode CR/LF packets; Shift+Enter inserts a soft newline.
         events.Add(new INPUT {type=1,U=new UNION {ki=new KEYBDINPUT {vk=16}}});
         events.Add(new INPUT {type=1,U=new UNION {ki=new KEYBDINPUT {vk=13}}});
         events.Add(new INPUT {type=1,U=new UNION {ki=new KEYBDINPUT {vk=13,flags=2}}});
         events.Add(new INPUT {type=1,U=new UNION {ki=new KEYBDINPUT {vk=16,flags=2}}});
       } else {
         var down=new INPUT {type=1,U=new UNION {ki=new KEYBDINPUT {scan=unit,flags=4}}};
         events.Add(down); down.U.ki.flags=6; events.Add(down);
       }
     }
     var inputs=events.ToArray();
     if(SendInput((uint)inputs.Length,inputs,size)!=inputs.Length) throw new Exception("Input rejected or incomplete");
     offset+=count; System.Threading.Thread.Sleep(8);
   }
 }
}
"@
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [IntPtr]::new([Int64]$payload.target)
[DirectTextInput]::Activate($target)
Start-Sleep -Milliseconds 180
[DirectTextInput]::Type($target, $payload.text)
`;
function typeTextToWindow(target, text, { spawnImpl = spawn, timeoutMs = 120000 } = {}) {
 if(!/^[1-9]\d{0,18}$/.test(String(target)) || BigInt(target)>9223372036854775807n || typeof text!=="string" || text.length>250000)
   return Promise.reject(new Error("Invalid direct input target or content"));
 return new Promise((resolve,reject)=>{
   const child=spawnImpl("powershell.exe",["-NoProfile","-NonInteractive","-STA","-Command",script],{windowsHide:true,stdio:["pipe","ignore","pipe"]});
   let settled=false;
   const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
   const failure=()=>new Error("Direct input failed; recognition text remains available in history");
   const timer=setTimeout(()=>{child.kill();finish(failure());},timeoutMs);
   child.stderr?.resume();
   child.once("error",()=>finish(failure()));
   child.once("close",code=>finish(code===0?null:failure()));
   child.stdin.once("error",()=>{child.kill();finish(failure());});
   child.stdin.end(JSON.stringify({target:String(target),text:text.replace(/\r\n?/g,"\n")}),"utf8");
 });
}
module.exports={typeTextToWindow};
