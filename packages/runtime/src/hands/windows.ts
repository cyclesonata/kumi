/**
 * Kumi's hands on Windows: a PowerShell program, kept running, that drives Live through UI Automation
 * (its menus and dialogs, which Live exposes for screen readers) and SendInput (keys). Same protocol as
 * the Mac's: one JSON request a line on stdin, one JSON answer a line on stdout.
 */

export const WINDOWS_SOURCE = String.raw`# Kumi's hands (made by Kumi). One JSON request a line on stdin, one JSON answer a line on stdout.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KumiInput {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public long padding0; [FieldOffset(8)] public long padding1; [FieldOffset(16)] public long padding2; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  public static void Key(ushort vk, bool up) {
    var input = new INPUT { type = 1 };
    input.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? 2u : 0u };
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
$version = 1
$auto = [System.Windows.Automation.AutomationElement]
$tree = [System.Windows.Automation.TreeScope]
$types = [System.Windows.Automation.ControlType]

function Emit($object) { [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
function LiveProcess { Get-Process | Where-Object { $_.ProcessName -like 'Ableton Live*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
function LiveWindow($process) { $auto::FromHandle($process.MainWindowHandle) }
function Kids($element) { $element.FindAll($tree::Children, [System.Windows.Automation.Condition]::TrueCondition) }
function Named($element, $name) {
  $all = @(Kids $element)
  $exact = $all | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1
  if ($exact) { return $exact }
  return $all | Where-Object { $_.Current.Name -like "$name*" } | Select-Object -First 1
}
function Expand($element) { try { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); Start-Sleep -Milliseconds 40 } catch {} }
function Collapse($element) { try { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {} }
function Press($element) {
  try { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch {}
  try { $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return $true } catch {}
  return $false
}
function MenuBar($window) { $window.FindFirst($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $types::MenuBar))) }
$vk = @{ cmd = 0x11; ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; option = 0x12; return = 0x0D; enter = 0x0D; tab = 0x09; space = 0x20; escape = 0x1B; esc = 0x1B;
  delete = 0x2E; backspace = 0x08; left = 0x25; up = 0x26; right = 0x27; down = 0x28; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22 }
function Combo($combo) {
  $mods = @(); $key = $null
  foreach ($part in $combo.ToLower().Split('+')) {
    if (@('cmd','ctrl','control','shift','alt','option') -contains $part) { $mods += $vk[$part] }
    elseif ($vk.ContainsKey($part)) { $key = $vk[$part] }
    elseif ($part.Length -eq 1) { $key = [int][char]$part.ToUpper() }
    elseif ($part -match '^f(\d+)$') { $key = 0x6F + [int]$Matches[1] }
  }
  if ($null -eq $key) { return $false }
  foreach ($m in $mods) { [KumiInput]::Key([uint16]$m, $false) }
  [KumiInput]::Key([uint16]$key, $false); [KumiInput]::Key([uint16]$key, $true)
  foreach ($m in $mods) { [KumiInput]::Key([uint16]$m, $true) }
  return $true
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $request = $line | ConvertFrom-Json } catch { continue }
  $started = Get-Date
  $answer = @{ id = $request.id }
  function Done($fields) { foreach ($k in $fields.Keys) { $answer[$k] = $fields[$k] }; $answer.ms = [int]((Get-Date) - $started).TotalMilliseconds; Emit $answer }
  try {
    # (continue inside a switch only ends the switch, so these two are ifs.)
    if ($request.op -eq 'version') { Done @{ ok = $true; version = $version }; continue }
    if ($request.op -eq 'trusted') { Done @{ ok = $true; trusted = $true }; continue }
    $process = LiveProcess
    if (-not $process) { Done @{ ok = $false; error = 'no-live' }; continue }
    $window = LiveWindow $process
    switch ($request.op) {
      'menus' {
        $bar = MenuBar $window
        if (-not $bar) { Done @{ ok = $false; error = 'no-menus' }; break }
        $items = @()
        foreach ($top in @(Kids $bar)) {
          Expand $top
          foreach ($entry in @($top.FindAll($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $types::MenuItem))))) {
            if ($entry.Current.Name) { $items += @{ path = @($top.Current.Name, $entry.Current.Name); enabled = $entry.Current.IsEnabled } }
          }
          Collapse $top
        }
        Done @{ ok = $true; items = $items }
      }
      'menu' {
        $bar = MenuBar $window
        $previous = [KumiInput]::GetForegroundWindow()
        [KumiInput]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
        $current = $bar; $found = $true
        foreach ($name in $request.path) {
          if (-not $current) { $found = $false; break }
          Expand $current
          $next = Named $current $name
          if (-not $next) { $next = $current.FindFirst($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $name))) }
          if (-not $next) { $found = $false; break }
          $current = $next
        }
        if (-not $found) { Done @{ ok = $false; error = 'no-item' }; break }
        if (-not $current.Current.IsEnabled) { Done @{ ok = $false; error = 'disabled' }; break }
        $pressed = Press $current
        Start-Sleep -Milliseconds 60
        [KumiInput]::SetForegroundWindow($previous) | Out-Null
        if ($pressed) { Done @{ ok = $true } } else { Done @{ ok = $false; error = 'press-failed' } }
      }
      'keys' {
        $previous = [KumiInput]::GetForegroundWindow()
        [KumiInput]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 40
        $failed = $null
        foreach ($combo in $request.keys) { if (-not (Combo $combo)) { $failed = $combo; break }; Start-Sleep -Milliseconds 25 }
        Start-Sleep -Milliseconds 60
        [KumiInput]::SetForegroundWindow($previous) | Out-Null
        if ($failed) { Done @{ ok = $false; error = "Kumi doesn't know the key in $failed." } } else { Done @{ ok = $true } }
      }
      'dialog' {
        $modal = @($auto::RootElement.FindAll($tree::Children, (New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, $process.Id)))) | Where-Object { $_.NativeWindowHandle -ne [int]$process.MainWindowHandle } | Select-Object -First 1
        if (-not $modal) { Done @{ ok = $true; open = $false }; break }
        $buttons = @($modal.FindAll($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $types::Button))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
        $words = @($modal.FindAll($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $types::Text))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
        Done @{ ok = $true; open = $true; title = $modal.Current.Name; words = $words; buttons = $buttons }
      }
      'answer' {
        $modal = @($auto::RootElement.FindAll($tree::Children, (New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, $process.Id)))) | Where-Object { $_.NativeWindowHandle -ne [int]$process.MainWindowHandle } | Select-Object -First 1
        $button = if ($modal) { $modal.FindFirst($tree::Descendants, (New-Object System.Windows.Automation.AndCondition((New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $types::Button)), (New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $request.button))))) }
        if (-not $button) { Done @{ ok = $false; error = 'no-button' }; break }
        if (Press $button) { Done @{ ok = $true } } else { Done @{ ok = $false; error = 'press-failed' } }
      }
      'windows' {
        $all = @($auto::RootElement.FindAll($tree::Children, (New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, $process.Id))) | ForEach-Object { @{ title = $_.Current.Name; subrole = '' } })
        Done @{ ok = $true; windows = $all }
      }
      default { Done @{ ok = $false; error = 'unknown-op' } }
    }
  } catch { Done @{ ok = $false; error = $_.Exception.Message } }
}
`;
