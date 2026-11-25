# Writes a Tauri updater manifest (`latest.json`) for a built NSIS installer.
#
# Stage 6.2. The installer must have been produced by `make release-client`,
# which leaves a `<installer>.sig` next to it. Run this script after the build:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/client/make-manifest.ps1 `
#     -Version 0.1.1 `
#     -Installer client/src-tauri/target/release/bundle/nsis/RosTalk_0.1.1_x64-setup.exe `
#     -BaseUrl https://downloads.example/rostalk
#
# For a local directory source (an offline/LAN share), use -Relative: the
# manifest then names the installer by file name, and the client reads it from
# the same directory.
param(
    [Parameter(Mandatory = $true)]
    [string] $Version,

    [Parameter(Mandatory = $true)]
    [string] $Installer,

    [string] $BaseUrl = '',

    [string] $Out = 'latest.json',

    [string] $Notes = '',

    [switch] $Relative
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "installer not found: $Installer"
}
$signatureFile = "$Installer.sig"
if (-not (Test-Path -LiteralPath $signatureFile -PathType Leaf)) {
    throw "signature not found: $signatureFile (build with make release-client)"
}

$signature = (Get-Content -LiteralPath $signatureFile -Raw).Trim()
if ($signature.Length -eq 0) {
    throw "the signature file is empty: $signatureFile"
}

$leaf = Split-Path -Leaf $Installer
if ($Relative) {
    $url = $leaf
}
else {
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        throw 'pass -BaseUrl https://… or -Relative for a directory source'
    }
    $url = '{0}/{1}' -f $BaseUrl.TrimEnd('/'), [uri]::EscapeDataString($leaf)
}

$manifest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url       = $url
        }
    }
}

$json = $manifest | ConvertTo-Json -Depth 5
# Write UTF-8 without a BOM: the client tolerates one, but a manifest is JSON
# and should not depend on that.
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
[System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote $Out ($Version, $url)"
