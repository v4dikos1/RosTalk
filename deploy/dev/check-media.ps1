# Проверка медиа с Windows-хоста (гейт G3, ADR 0001).
#
# Запускает dev-сервер в Docker Desktop, создаёт две ссылки-приглашения и двух
# ботов на хосте. Боты подключаются к https://<LAN IP>:7443, поэтому медиа идёт
# через опубликованные порты, а не через loopback контейнера.
#
#   .\deploy\dev\check-media.ps1 -AdvertiseIP 192.168.1.10
#
# Требуется: Docker Desktop, Go (для сборки rostalkctl), запущенный compose из
# deploy/dev/compose.yaml с ROSTALK_ADVERTISE_IP=<тот же IP>.
#
# Критерий успеха: у обоих ботов растут счётчики принятых пакетов, а контейнер
# получил UDP-датаграммы на 7882. Если UDP закрыт, медиа пойдёт по TCP 7881;
# тогда счётчики растут, а UDP-датаграммы — нет (см. вывод в конце).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AdvertiseIP,

    [string]$Channel = "Лобби",
    [int]$Seconds = 15,
    [string]$ComposeFile = "",
    [string]$Port = "7443",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

if (-not $ComposeFile) {
    $ComposeFile = Join-Path $PSScriptRoot "compose.yaml"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$compose = @("compose", "-f", $ComposeFile)

function Invoke-Compose {
    param([string[]]$Arguments)
    $output = & docker @compose @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($Arguments -join ' ') failed:`n$output"
    }
    return $output
}

Write-Host "==> server container"
$container = (Invoke-Compose @("ps", "-q", "server") | Select-Object -First 1)
if (-not $container) {
    throw "the dev server is not running; start it with: docker compose -f $ComposeFile up --build -d"
}

Write-Host "==> UDP counters before the run"
function Get-UdpInDatagrams {
    $snmp = (Invoke-Compose @("exec", "-T", "server", "cat", "/proc/net/snmp")) -join "`n"
    $line = ($snmp -split "`n" | Where-Object { $_ -match '^Udp:' } | Select-Object -Last 1)
    if (-not $line) {
        return 0
    }
    $fields = $line -replace '^Udp:\s*', '' -split '\s+'
    return [int64]$fields[0]
}
$udpBefore = Get-UdpInDatagrams

Write-Host "==> invite links"
function New-InviteLink {
    param([string]$Nickname)
    $output = Invoke-Compose @(
        "exec", "-T", "server",
        "rostalk-server", "invite",
        "--data=/data",
        "--listen=:$Port",
        "--public-host=$AdvertiseIP"
    )
    $link = ($output | Where-Object { $_ -match '^rostalk://join\?' } | Select-Object -Last 1)
    if (-not $link) {
        throw "rostalk-server invite printed no link:`n$($output -join "`n")"
    }
    if ($link -match 'localhost' -or $link -match '127\.0\.0\.1') {
        throw "the invite link points at loopback, check ROSTALK_ADVERTISE_IP: $link"
    }
    Write-Host "    $Nickname -> $link"
    return $link
}
$aliceLink = New-InviteLink "alice"
$bobLink = New-InviteLink "bob"

Write-Host "==> rostalkctl"
$exe = Join-Path $env:TEMP "rostalkctl-check-media.exe"
if (-not $SkipBuild) {
    Push-Location (Join-Path $repoRoot "tools\rostalkctl")
    try {
        & go build -trimpath -o $exe .
        if ($LASTEXITCODE -ne 0) { throw "go build rostalkctl failed" }
    } finally {
        Pop-Location
    }
}

$work = Join-Path $env:TEMP ("rostalk-media-check-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null

function Start-Bot {
    param([string]$Nickname, [string]$Link, [double]$Frequency)
    $stdout = Join-Path $work "$Nickname.out"
    $stderr = Join-Path $work "$Nickname.err"
    $identity = Join-Path $work "$Nickname.key"
    $arguments = @(
        "bot", $Link,
        "--nick", $Nickname,
        "--identity", $identity,
        "--channel", $Channel,
        "--freq", $Frequency,
        "--duration", "$($Seconds)s"
    )
    $process = Start-Process -FilePath $exe -ArgumentList $arguments `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -PassThru -NoNewWindow
    return @{ Process = $process; Out = $stdout; Err = $stderr; Nickname = $Nickname }
}

Write-Host "==> two bots on the host for $Seconds s"
$alice = Start-Bot "alice" $aliceLink 440
$bob = Start-Bot "bob" $bobLink 550
$alice.Process.WaitForExit()
$bob.Process.WaitForExit()

$udpAfter = Get-UdpInDatagrams

function Test-BotOutput {
    param([hashtable]$Bot)
    $lines = @(Get-Content -Path $Bot.Out -ErrorAction SilentlyContinue)
    $received = $lines | Where-Object { $_ -match 'received:' } | Select-Object -Last 1
    Write-Host ""
    Write-Host "--- $($Bot.Nickname) ---"
    $lines | Select-Object -Last 4 | ForEach-Object { Write-Host "    $_" }
    if (-not $received) {
        Write-Host "    stderr:"
        Get-Content -Path $Bot.Err -ErrorAction SilentlyContinue | Select-Object -Last 10 |
            ForEach-Object { Write-Host "    $_" }
        return $false
    }
    # "received: 2:voice=123 packets/..." — a non-zero counter means audio flowed.
    return [bool]($received -match ':\w+=[1-9][0-9]* packets')
}

$aliceOK = Test-BotOutput $alice
$bobOK = Test-BotOutput $bob
$udpDelta = $udpAfter - $udpBefore

Write-Host ""
Write-Host "==> result"
Write-Host ("    alice received audio: {0}" -f $aliceOK)
Write-Host ("    bob received audio:   {0}" -f $bobOK)
Write-Host ("    UDP datagrams into the container during the run: {0}" -f $udpDelta)
if (-not $aliceOK -or -not $bobOK) {
    Write-Host ""
    Write-Host "FAIL: audio did not flow. Check ROSTALK_ADVERTISE_IP=$AdvertiseIP,"
    Write-Host "the published ports 7443/tcp, 7881/tcp, 7882/udp and the log above."
    exit 1
}
if ($udpDelta -le 0) {
    Write-Host "WARNING: no UDP datagrams arrived; media most likely used TCP 7881."
}
Write-Host "OK: both bots hear each other."
Write-Host ""
Write-Host "Note: Docker Desktop also routes directly to the container network, so this"
Write-Host "check proves the media path from the Windows host, not that the packet went"
Write-Host "through the published 7882/udp mapping in particular. On a real Linux host"
Write-Host "the published port is the only path."
