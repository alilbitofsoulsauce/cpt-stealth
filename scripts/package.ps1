param([ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Version = 'v0.1.0')

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$output = Join-Path $root 'dist'
$name = "PacketTracerHelper-$Version-windows-x64.zip"
$archive = Join-Path $output $name
$module = Join-Path $root 'packet-tracer\Packet Tracer Helper.pts'
if (-not (Test-Path -LiteralPath $module -PathType Leaf)) {
    throw 'Export the portable Packet Tracer module before packaging.'
}

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is required to package the app.' }

$nodeVersion = 'v24.22.3'
$nodeHash = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temp = [IO.Directory]::CreateTempSubdirectory('PacketTracerHelper-package-').FullName
if (-not ([IO.Path]::GetFullPath($temp).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Temporary staging directory is outside the Windows temp folder.'
}

try {
    $nodeArchive = Join-Path $temp 'node.zip'
    $nodeFolder = Join-Path $temp 'node'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip" -OutFile $nodeArchive
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash -ne $nodeHash) {
        throw 'The Node.js download did not match the pinned release checksum.'
    }
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeFolder
    $nodeFolder = Join-Path $nodeFolder "node-$nodeVersion-win-x64"

    $stage = Join-Path $temp 'Packet Tracer Helper'
    $runtime = Join-Path $stage 'runtime'
    $modules = Join-Path $stage 'packet-tracer'
    [void][IO.Directory]::CreateDirectory($runtime)
    [void][IO.Directory]::CreateDirectory($modules)
    [void][IO.Directory]::CreateDirectory($output)
    foreach ($file in @('node.exe', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $nodeFolder $file) -Destination $runtime
    }
    Copy-Item -LiteralPath $module -Destination $modules
    foreach ($entry in @('helper.mjs', 'lib', 'README.md')) {
        Copy-Item -LiteralPath (Join-Path $root $entry) -Destination $stage -Recurse
    }

    $exe = Join-Path $stage 'Packet Tracer Helper.exe'
    & $compiler /nologo /target:winexe /optimize+ "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll (Join-Path $root 'app\Tray.cs')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw 'The tray app failed to compile.' }
    Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stage).FullName -DestinationPath $archive -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $name" -Encoding ascii
    Write-Output $archive
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
}
