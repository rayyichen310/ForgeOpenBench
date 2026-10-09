param(
    [ValidateSet('start', 'stop', 'status')][string]$Action = 'start',
    [string]$NodePath = ''
)
$ErrorActionPreference = 'Stop'
$forgeRoot = Split-Path $PSScriptRoot -Parent
$forgePython = Join-Path $forgeRoot '.venv\Scripts\python.exe'
$forgeLogDir = Join-Path $forgeRoot 'logs'
$forgeStateFile = Join-Path $forgeLogDir 'windows-services.json'
New-Item -ItemType Directory -Path $forgeLogDir -Force | Out-Null
$forgeServices = @()
if (Test-Path -LiteralPath $forgeStateFile) {
    $forgeServices = @(Get-Content -LiteralPath $forgeStateFile -Raw | ConvertFrom-Json)
}
if ($Action -eq 'status') {
    foreach ($service in $forgeServices) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($service.pid)"
        [pscustomobject]@{Service=$service.name; Port=$service.port; Running=($null -ne $process -and $process.CreationDate.ToUniversalTime() -eq ([datetime]$service.created).ToUniversalTime())}
    }
    return
}
if ($Action -eq 'stop') {
    foreach ($service in $forgeServices) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($service.pid)"
        if (!$process -or $process.CreationDate.ToUniversalTime() -ne ([datetime]$service.created).ToUniversalTime()) { continue }
        if (!$process.CommandLine.Contains($forgeRoot)) { throw "Process ownership changed: $($service.name)" }
        if ($service.name -eq 'usb') {
            # Stop the hardware before terminating its bridge, including when no view is open.
            $stopCode = @'
import asyncio,json
from websockets.asyncio.client import connect
async def stop():
    async with connect('ws://127.0.0.1:8766') as ws:
        await ws.send(json.dumps({'type':'usb_stop','req_id':'shutdown'}))
        while True:
            raw=await asyncio.wait_for(ws.recv(),15)
            if isinstance(raw,bytes): continue
            reply=json.loads(raw)
            if reply.get('req_id')=='shutdown':
                if reply['type']=='usb_error': raise RuntimeError(reply['message'])
                return
asyncio.run(stop())
'@
            & $forgePython -c $stopCode
            if ($LASTEXITCODE -ne 0) { throw 'Hardware stop failed; services were not terminated.' }
        }
        Stop-Process -Id $process.ProcessId
    }
    return
}
if (!(Test-Path -LiteralPath $forgePython)) { throw 'Install project .venv dependencies first.' }
if (!$NodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $NodePath = if ($nodeCommand) {$nodeCommand.Source} else {Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
}
if (!(Test-Path -LiteralPath $NodePath)) { throw 'Specify -NodePath with an installed Node.js executable.' }
$forgePlans = @(
    @{name='usb'; port=8766; exe=$forgePython; args=@((Join-Path $forgeRoot 'server\usb-bridge\usb_server.py')); cwd=$forgeRoot},
    @{name='backend'; port=8000; exe=$forgePython; args=@('-m','uvicorn','backend.app:app','--app-dir',$forgeRoot,'--host','127.0.0.1','--port','8000'); cwd=$forgeRoot},
    @{name='frontend'; port=5173; exe=$NodePath; args=@((Join-Path $forgeRoot 'frontend\node_modules\vite\bin\vite.js'),'preview','--host','127.0.0.1','--port','5173','--strictPort'); cwd=(Join-Path $forgeRoot 'frontend')}
)
# Check all ports before starting anything; never take over another process.
foreach ($plan in $forgePlans) {
    if (Get-NetTCPConnection -State Listen -LocalPort $plan.port -ErrorAction SilentlyContinue) { throw "Port $($plan.port) is in use; inspect or stop the existing service first." }
}
$forgeServices = @()
foreach ($plan in $forgePlans) {
    $arguments = ($plan.args | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $launcher = Start-Process $plan.exe -ArgumentList $arguments -WorkingDirectory $plan.cwd -WindowStyle Hidden -RedirectStandardOutput (Join-Path $forgeLogDir "$($plan.name).out.log") -RedirectStandardError (Join-Path $forgeLogDir "$($plan.name).err.log") -PassThru
    $listener = $null
    for ($attempt=0; $attempt -lt 50 -and !$listener; $attempt++) {
        Start-Sleep -Milliseconds 200
        $listener = Get-NetTCPConnection -State Listen -LocalPort $plan.port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($launcher.HasExited -and !$listener) { throw "$($plan.name) exited. See logs/$($plan.name).err.log" }
    }
    if (!$listener) { throw "$($plan.name) failed to listen. Inspect its logs." }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if (!$process.CommandLine.Contains($forgeRoot)) { throw "Unexpected process on port $($plan.port)" }
    $forgeServices += [pscustomobject]@{name=$plan.name;port=$plan.port;pid=$process.ProcessId;created=$process.CreationDate.ToString('o')}
    $forgeServices | ConvertTo-Json -AsArray | Set-Content -LiteralPath $forgeStateFile
}
Write-Output 'ForgeOpenBench ready: http://127.0.0.1:5173/ (logs in project logs/)'
