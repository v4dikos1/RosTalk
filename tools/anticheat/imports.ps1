<#
.SYNOPSIS
    Checks the imports of the release client against the anti-cheat ban list.

.DESCRIPTION
    Stage 2.3.3, docs/anticheat.md: anti-cheat hygiene is enforced
    on sources by `make check-anticheat` (tools/anticheat/check.sh), and on the
    shipped binary by this script. It takes `dumpbin /imports` of
    client/src-tauri/target/release/rostalk.exe and compares the imported Win32
    symbols with tools/anticheat/forbidden-imports.txt.

    An import that is already listed in tools/anticheat/imports-baseline.txt is
    a known import of a third-party crate (tao, WebView2, libwebrtc) and does
    not fail. Any other forbidden import does: it means our code, or a new
    dependency, started using an API the white list does not allow.

    The baseline is a decision record, not a cache: every line names the crate
    it comes from and is approved by a human (docs/anticheat.md). The script
    never edits it.

    Run it on Windows after `make build-client`:
        powershell -NoProfile -File tools/anticheat/imports.ps1

.PARAMETER ExePath
    Release executable to inspect. Relative paths are resolved from the
    repository root.

.PARAMETER ForbiddenList
    Ban list of import names.

.PARAMETER BaselinePath
    Known third-party imports.

.PARAMETER List
    Print every imported symbol as well, grouped by DLL. Use it to find the
    crate behind a new import before adding a baseline line.

.NOTES
    Exit codes: 0 clean, 1 a new forbidden import (or a broken baseline), 2 the
    check could not run (no dumpbin, no executable).
#>
[CmdletBinding()]
param(
    [string] $ExePath = 'client/src-tauri/target/release/rostalk.exe',
    [string] $ForbiddenList = 'tools/anticheat/forbidden-imports.txt',
    [string] $BaselinePath = 'tools/anticheat/imports-baseline.txt',
    [switch] $List
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string] $Message)
    Write-Host "imports: $Message"
}

function Stop-Check {
    param([string] $Message)
    Write-Host "imports: FAILED — $Message"
    exit 2
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) {
    Stop-Check "cannot locate the repository root from $PSScriptRoot"
}

function Resolve-RepoPath {
    param([string] $Path)
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }
    return (Join-Path $repoRoot $Path)
}

function Read-NameList {
    param([string] $Path)
    $names = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
            continue
        }
        # `symbol # comment`: only the first token is the name.
        $names.Add(($trimmed -split '\s+')[0])
    }
    return $names
}

function Find-Dumpbin {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $found = & $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' 2>$null
        if ($LASTEXITCODE -eq 0 -and $found) {
            return ($found | Select-Object -First 1)
        }
    }
    $onPath = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }
    return $null
}

$exe = Resolve-RepoPath $ExePath
$forbiddenFile = Resolve-RepoPath $ForbiddenList
$baselineFile = Resolve-RepoPath $BaselinePath

if (-not (Test-Path -LiteralPath $forbiddenFile -PathType Leaf)) {
    Stop-Check "ban list not found: $forbiddenFile"
}

$dumpbin = Find-Dumpbin
if (-not $dumpbin) {
    Stop-Check 'dumpbin not found: install the MSVC build tools (Visual Studio Build Tools 2022) so vswhere can locate them'
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Stop-Check "release client not found: $exe (run `make build-client` first)"
}

Write-Info "executable: $exe"
Write-Info "dumpbin:    $dumpbin"

$dump = & $dumpbin /nologo /imports $exe 2>&1
if ($LASTEXITCODE -ne 0) {
    $dump | ForEach-Object { Write-Host "    $_" }
    Stop-Check "dumpbin /imports failed for $exe"
}

# dumpbin prints a DLL header, an import-address table and then
# `    <hex> <symbol>` per imported name. Delay-load imports look the same.
$imports = New-Object 'System.Collections.Generic.List[object]'
$currentDll = '<unknown>'
foreach ($line in $dump) {
    if ($line -match '^\s{4}([^\s]+\.dll)\s*$') {
        $currentDll = $Matches[1]
        continue
    }
    if ($line -match '^\s+[0-9A-Fa-f]+\s+([A-Za-z_][A-Za-z0-9_@?$]*)\s*$') {
        $imports.Add([pscustomobject]@{ Dll = $currentDll; Name = $Matches[1] })
    }
}

if ($imports.Count -eq 0) {
    Stop-Check "no imports parsed from $exe — dumpbin output format changed"
}

$dllCount = ($imports | Select-Object -ExpandProperty Dll -Unique).Count
Write-Info "parsed $($imports.Count) imports from $dllCount DLLs"

$forbidden = Read-NameList $forbiddenFile
if ($forbidden.Count -eq 0) {
    Stop-Check "the ban list is empty: $forbiddenFile"
}

$baseline = @{}
$stale = New-Object 'System.Collections.Generic.List[string]'
if (Test-Path -LiteralPath $baselineFile -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $baselineFile -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
            continue
        }
        $parts = $trimmed -split '\s+', 2
        $name = $parts[0]
        $note = if ($parts.Count -gt 1) { $parts[1].TrimStart('#').Trim() } else { '' }
        $baseline[$name] = $note
    }
}

if ($List) {
    foreach ($group in ($imports | Group-Object -Property Dll | Sort-Object Name)) {
        Write-Info "$($group.Name)"
        foreach ($entry in ($group.Group | Sort-Object Name)) {
            Write-Host "    $($entry.Name)"
        }
    }
}

$imported = @{}
foreach ($entry in $imports) {
    $imported[$entry.Name] = $entry.Dll
}

$newImports = New-Object 'System.Collections.Generic.List[object]'
$knownImports = New-Object 'System.Collections.Generic.List[object]'
foreach ($name in ($forbidden | Sort-Object -Unique)) {
    if (-not $imported.ContainsKey($name)) {
        continue
    }
    $entry = [pscustomobject]@{
        Dll  = $imported[$name]
        Name = $name
    }
    if ($baseline.ContainsKey($name)) {
        $knownImports.Add($entry)
    }
    else {
        $newImports.Add($entry)
    }
}

foreach ($name in ($baseline.Keys | Sort-Object)) {
    if (-not $imported.ContainsKey($name)) {
        $stale.Add($name)
    }
    elseif ($forbidden -notcontains $name) {
        $stale.Add($name)
    }
}

Write-Info "forbidden imports present: $($knownImports.Count + $newImports.Count) (baseline: $($knownImports.Count))"
foreach ($entry in ($knownImports | Sort-Object Name)) {
    Write-Info ("  baseline  {0}!{1}  — {2}" -f $entry.Dll, $entry.Name, $baseline[$entry.Name])
}
foreach ($entry in ($newImports | Sort-Object Name)) {
    Write-Info ("  NEW       {0}!{1}" -f $entry.Dll, $entry.Name)
}

foreach ($name in ($stale | Sort-Object -Unique)) {
    Write-Info "note: $name is in imports-baseline.txt but is not imported any more; drop the line"
}

if ($newImports.Count -gt 0) {
    Write-Host ''
    Write-Host "imports: FAILED — $($newImports.Count) new forbidden import(s)."
    Write-Host 'Our code must not call them. Do not patch third-party crates and do not'
    Write-Host 'extend the baseline without a human decision: docs/anticheat.md.'
    exit 1
}

Write-Info "OK — no forbidden import outside $BaselinePath"
exit 0
