param([string]$HelperPath, [string]$ForegroundHandle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InputFieldFixture {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("user32.dll")] public static extern bool PeekMessage(IntPtr msg, IntPtr hwnd, uint first, uint last, uint flags);
    public static void Activate(IntPtr hwnd) {
        IntPtr msg = Marshal.AllocHGlobal(64);
        try { PeekMessage(msg, IntPtr.Zero, 0, 0, 0); }
        finally { Marshal.FreeHGlobal(msg); }
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        uint current = GetCurrentThreadId();
        uint target = GetWindowThreadProcessId(hwnd, IntPtr.Zero);
        bool attached = foreground != current && AttachThreadInput(foreground, current, true);
        bool targetAttached = target != current && target != foreground && AttachThreadInput(target, current, true);
        try { SetForegroundWindow(hwnd); }
        finally {
            if (targetAttached) AttachThreadInput(target, current, false);
            if (attached) AttachThreadInput(foreground, current, false);
        }
    }
}
'@
if ($ForegroundHandle) {
    if ($ForegroundHandle -notmatch '^[1-9]\d{0,19}$') { throw 'Invalid synthetic target handle' }
    $target = [IntPtr]([long]$ForegroundHandle)
    [InputFieldFixture]::Activate($target)
    if ([InputFieldFixture]::GetForegroundWindow() -ne $target) { throw 'Synthetic target could not take focus' }
    return
}
if (-not $HelperPath) { throw 'HelperPath is required for the text-box test' }
[void][InputFieldFixture]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Dictation positioning test'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(520, 240)
$form.TopMost = $true
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Location = New-Object System.Drawing.Point(30, 50)
$box.Size = New-Object System.Drawing.Size(430, 110)
$box.Text = 'Synthetic input only'
$form.Controls.Add($box)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$script:fixtureFailure = $null
$script:fixtureComplete = $false
$timer.Add_Tick({
    $timer.Stop()
    try {
        $form.Activate()
        [InputFieldFixture]::Activate($form.Handle)
        [void]$box.Focus()
        $box.SelectionStart = 6
        [System.Windows.Forms.Application]::DoEvents()
        if ([InputFieldFixture]::GetForegroundWindow() -ne $form.Handle) {
            throw 'Desktop prevented the synthetic test window from taking foreground focus'
        }
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $HelperPath
        $startInfo.Arguments = '--input-context'
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $native = [System.Diagnostics.Process]::Start($startInfo)
        try {
            if (-not $native.WaitForExit(1500)) { $native.Kill(); throw 'Input-context query timed out' }
            $lines = $native.StandardOutput.ReadToEnd().Trim() -split "`r?`n"
            if ($native.ExitCode -ne 0) { throw 'Native input-context failed' }
        } finally { $native.Dispose() }
        $context = $lines[-1] | ConvertFrom-Json
        if ($context.target -ne $form.Handle.ToInt64().ToString() -or $context.source -ne 'caret') {
            throw ('Expected synthetic target and caret; targetMatch={0}, source={1}' -f
                ($context.target -eq $form.Handle.ToInt64().ToString()), $context.source)
        }
        $origin = $box.PointToScreen([System.Drawing.Point]::Empty)
        if ($context.rect.x -lt $origin.X -or $context.rect.x -gt ($origin.X + $box.Width) -or
            $context.rect.y -lt $origin.Y -or $context.rect.y -gt ($origin.Y + $box.Height) -or
            $context.rect.height -le 0 -or $context.coordinateSpace -ne 'physical') {
            throw 'Caret rectangle must lie inside the synthetic text box in physical pixels'
        }
        $script:fixtureComplete = $true
    } catch { $script:fixtureFailure = $_ }
    finally { $form.Close() }
})
$form.Add_Shown({ [void]$box.Focus(); $timer.Start() })
try { [void]$form.ShowDialog() }
finally { $timer.Dispose(); $form.Dispose() }
if ($script:fixtureFailure) { throw $script:fixtureFailure }
if (-not $script:fixtureComplete) { throw 'Synthetic input test closed before validation' }
Write-Output 'PASS Windows native text-box caret and foreground target; no user input read'
