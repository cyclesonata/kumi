# Kumi installer for Windows. Open PowerShell (Start menu → type "PowerShell") and run:
#
#   irm https://raw.githubusercontent.com/user1303836/kumi/main/install.ps1 | iex
#
# It puts Kumi and its own copy of Node in %USERPROFILE%\.kumi (no admin rights), adds its folder to your
# PATH, and checks every download against its published checksum. Running it again updates or repairs
# Kumi. Your settings, sign-ins and conversations in .kumi are never touched.
#
# Settings (optional, as environment variables): KUMI_HOME, KUMI_VERSION (e.g. 1.1.0), KUMI_RELEASES,
# KUMI_NO_MODIFY_PATH=1.

& {
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower in Windows PowerShell
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  function Say([string]$Text = '') { Write-Host $Text }
  function Step([string]$Text) { Write-Host "› $Text" -ForegroundColor DarkGray }
  function Fail([string]$Text) { Write-Host ''; Write-Host "Kumi couldn't be installed: $Text" -ForegroundColor Red; throw 'KumiInstallFailed' }

  # 'ok', 'missing' (the server answered 404: nothing there to get) or 'failed' (no answer, after three tries).
  function Fetch([string]$Url, [string]$File) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try { Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing -TimeoutSec 600; return 'ok' }
      catch {
        $response = $_.Exception.Response
        if ($response -and [int]$response.StatusCode -eq 404) { return 'missing' }
        if ($attempt -eq 3) { return 'failed' }
        Start-Sleep -Seconds 2
      }
    }
  }
  # Windows tells programs (Explorer, new windows) that the environment changed only when asked to.
  function Send-EnvironmentChange {
    try {
      if (-not ('Kumi.Env' -as [Type])) {
        Add-Type -Namespace Kumi -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
      }
      $result = [UIntPtr]::Zero
      [void][Kumi.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    } catch { }
  }
  function Sha([string]$File) { (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant() }
  function Swap([string]$Fresh, [string]$Target) {
    # Antivirus can hold new files for a moment: try a few times before giving up.
    $previous = "$Target.previous"
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      try {
        if (Test-Path -LiteralPath $Target) { Rename-Item -LiteralPath $Target -NewName (Split-Path $previous -Leaf) }
        Move-Item -LiteralPath $Fresh -Destination $Target
        return
      } catch {
        if ((Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $Target)) { Rename-Item -LiteralPath $previous -NewName (Split-Path $Target -Leaf) }
        if ($attempt -eq 5) { Fail "Windows kept $Target busy. Close every Kumi window (and anything open in that folder), then run this again." }
        Start-Sleep -Seconds 2
      }
    }
  }

  try {
    $KumiHome = if ($env:KUMI_HOME) { $env:KUMI_HOME } else { Join-Path $env:USERPROFILE '.kumi' }
    $base = if ($env:KUMI_RELEASES) { $env:KUMI_RELEASES.TrimEnd('/') }
      elseif ($env:KUMI_VERSION) { "https://github.com/user1303836/kumi/releases/download/v$($env:KUMI_VERSION.TrimStart('v'))" }
      else { 'https://github.com/user1303836/kumi/releases/latest/download' }

    Say ''
    Write-Host 'Installing Kumi' -NoNewline -ForegroundColor White; Say ', a studio partner for Ableton Live'
    Say ''

    # ── What this computer is ────────────────────────────────────────────
    if ([Environment]::OSVersion.Version.Major -lt 10) { Fail 'Kumi needs Windows 10 or 11.' }
    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($cpu) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { Fail "this processor ($cpu) isn't one Kumi's Node is made for." } }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { Fail 'this Windows is missing tar.exe (Windows 10 from 2018 on has it). Update Windows, then run this again.' }

    # ── Room and a place to work ─────────────────────────────────────────
    New-Item -ItemType Directory -Force -Path $KumiHome | Out-Null
    $drive = (Get-Item -LiteralPath $KumiHome).PSDrive
    if ($drive -and $drive.Free -and $drive.Free -lt 300MB) { Fail "there's only $([math]::Floor($drive.Free / 1MB)) MB free; Kumi needs about 300 MB. Free some space and run this again." }
    $work = Join-Path $KumiHome ('.install.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    try {
      # ── Which Kumi ─────────────────────────────────────────────────────
      Step 'Finding the latest Kumi…'
      $manifestFile = Join-Path $work 'release.json'
      switch (Fetch "$base/kumi-release.json" $manifestFile) {
        'missing' { Fail "there's no Kumi release to install at $($base -replace '^https://', '') yet. Try again later." }
        'failed' { Fail "couldn't reach GitHub ($base). Check your internet connection and try again." }
      }
      $release = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
      if (-not ($release.kumi -and $release.bundle -and $release.sha256 -and $release.node)) { Fail "the release description didn't make sense; try again later." }

      # ── Kumi's own Node ────────────────────────────────────────────────
      $nodeDir = Join-Path $KumiHome 'node'
      $nodeExe = Join-Path $nodeDir 'node.exe'
      $haveNode = $false
      if (Test-Path -LiteralPath $nodeExe) { try { $haveNode = ((& $nodeExe --version) -eq "v$($release.node)") } catch { } }
      if ($haveNode) { Step "Node $($release.node) is already here." }
      else {
        Step "Downloading Node $($release.node) for Kumi (about 30 MB, once)…"
        $nodeName = "node-v$($release.node)-win-$arch"
        $sums = Join-Path $work 'SHASUMS256.txt'; $zip = Join-Path $work 'node.zip'
        if ((Fetch "https://nodejs.org/dist/v$($release.node)/SHASUMS256.txt" $sums) -ne 'ok') { Fail "couldn't reach nodejs.org. Check your internet connection and try again." }
        if ((Fetch "https://nodejs.org/dist/v$($release.node)/$nodeName.zip" $zip) -ne 'ok') { Fail "couldn't download Node from nodejs.org." }
        $want = (Select-String -LiteralPath $sums -Pattern " $([regex]::Escape("$nodeName.zip"))$" | Select-Object -First 1).Line
        if (-not $want -or ($want.Split(' ')[0] -ne (Sha $zip))) { Fail "Node's download didn't match its checksum, so it wasn't used. Try again." }
        $unpacked = Join-Path $work 'node'
        New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
        & $tar -xf $zip -C $unpacked
        if ($LASTEXITCODE -ne 0) { Expand-Archive -LiteralPath $zip -DestinationPath $unpacked -Force }
        $freshNode = Join-Path $unpacked $nodeName
        try { & (Join-Path $freshNode 'node.exe') --version | Out-Null } catch { Fail "Node $($release.node) won't run on this computer." }
        Swap $freshNode $nodeDir
        Remove-Item -LiteralPath "$nodeDir.previous" -Recurse -Force -ErrorAction SilentlyContinue
      }

      # ── Kumi ───────────────────────────────────────────────────────────
      Step "Downloading Kumi $($release.kumi)…"
      $bundle = Join-Path $work 'kumi.tar.gz'
      if ((Fetch "$base/$($release.bundle)" $bundle) -ne 'ok') { Fail "couldn't download Kumi from GitHub." }
      if ((Sha $bundle) -ne $release.sha256) { Fail "Kumi's download didn't match its checksum, so it wasn't used. Try again." }
      $freshApp = Join-Path $work 'app'
      New-Item -ItemType Directory -Force -Path $freshApp | Out-Null
      & $tar -xzf $bundle -C $freshApp
      if ($LASTEXITCODE -ne 0) { Fail "couldn't unpack Kumi." }
      $hadHome = $env:KUMI_HOME
      $env:KUMI_INSTALLED = '1'; $env:KUMI_HOME = $KumiHome
      & $nodeExe (Join-Path $freshApp 'apps\kumi\bin\kumi.mjs') --version | Out-Null
      $started = ($LASTEXITCODE -eq 0)
      Remove-Item Env:KUMI_INSTALLED -ErrorAction SilentlyContinue
      if ($hadHome) { $env:KUMI_HOME = $hadHome } else { Remove-Item Env:KUMI_HOME -ErrorAction SilentlyContinue }
      if (-not $started) { Fail 'the downloaded Kumi didn''t start. Please report this at github.com/user1303836/kumi/issues.' }
      Swap $freshApp (Join-Path $KumiHome 'app')
    } finally {
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    # ── The kumi command ─────────────────────────────────────────────────
    $bin = Join-Path $KumiHome 'bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $launcher = @'
@echo off
rem Kumi's launcher, written by its installer: Kumi runs on its own Node, whatever Node this computer has.
setlocal
for %%I in ("%~dp0..") do set "KUMI_HOME=%%~fI"
set "KUMI_INSTALLED=1"
"%KUMI_HOME%\node\node.exe" "%KUMI_HOME%\app\apps\kumi\bin\kumi.mjs" %*
'@
    Set-Content -LiteralPath (Join-Path $bin 'kumi.cmd') -Value $launcher -Encoding Ascii

    # ── PATH ─────────────────────────────────────────────────────────────
    $added = $false
    if (-not $env:KUMI_NO_MODIFY_PATH) {
      # The user PATH as the registry keeps it: %VAR% entries stay unexpanded, and it's written back as a
      # REG_EXPAND_SZ, so they keep working (the .NET round trip would store them expanded, for good).
      $key = (Get-Item -LiteralPath 'HKCU:\').OpenSubKey('Environment', $true)
      $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $parts = @(); if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ } }
      if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $bin })) {
        $key.SetValue('Path', ((@($bin) + $parts) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        Send-EnvironmentChange
        $added = $true
      }
      $key.Close()
    }
    # This window too, so kumi works right away.
    if (-not (($env:Path.Split(';')) | Where-Object { $_.TrimEnd('\') -ieq $bin })) { $env:Path = "$bin;$env:Path" }

    # ── Done ─────────────────────────────────────────────────────────────
    Say ''
    Write-Host "Kumi $($release.kumi) is installed." -ForegroundColor White
    if ($added) { Write-Host "Added $bin to your PATH." -ForegroundColor DarkGray }
    Say ''
    Say 'Next (in this window, or any new one):'
    Say ''
    Say '  kumi login      sign in (ChatGPT, or an Anthropic, OpenAI or OpenCode key)'
    Say '  kumi bridge     with Live closed: connect Kumi to Ableton Live (once)'
    Say '  kumi            open Kumi next to your Set'
    Say ''
    Write-Host 'Kumi looks best in Windows Terminal (from the Microsoft Store, built into Windows 11).' -ForegroundColor DarkGray
    Write-Host 'Update with: kumi update · Remove with: kumi uninstall' -ForegroundColor DarkGray
  } catch {
    if ($_.Exception.Message -ne 'KumiInstallFailed') {
      Write-Host ''
      Write-Host "Kumi couldn't be installed: $($_.Exception.Message)" -ForegroundColor Red
      Write-Host 'If this keeps happening, please report it at github.com/user1303836/kumi/issues.' -ForegroundColor DarkGray
    }
  }
}
