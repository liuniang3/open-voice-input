param([ValidateSet('invoke','cancel')][string]$Action = 'invoke')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkspaceHotkeySender {
 [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
 public static void Key(byte key, bool up) { keybd_event(key, 0, up ? 2u : 0u, UIntPtr.Zero); }
}
'@
if ($Action -eq 'cancel') {
 [WorkspaceHotkeySender]::Key(27,$false)
 [WorkspaceHotkeySender]::Key(27,$true)
} else {
 try {
  foreach($key in @(17,18,16,120)) { [WorkspaceHotkeySender]::Key($key,$false); Start-Sleep -Milliseconds 15 }
  Start-Sleep -Milliseconds 35
 } finally {
  foreach($key in @(120,16,18,17)) { [WorkspaceHotkeySender]::Key($key,$true); Start-Sleep -Milliseconds 15 }
 }
}
