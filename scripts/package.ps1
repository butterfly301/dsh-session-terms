param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'))
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
& node (Join-Path $project 'scripts\build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Locale build failed' }
$manifest = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$tempRoot = [IO.Path]::GetTempPath()
$stage = Join-Path $tempRoot ('dsh-terms-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Write-Output "Temporary package staging: $stage"
try {
    $package = Join-Path $stage 'dsh-session-terms'
    New-Item -ItemType Directory -Path $package | Out-Null
    $include = @('package.json', 'package-lock.json') + @($manifest.files)
    foreach ($entry in $include) {
        $source = Join-Path $project $entry
        if ($entry.Contains('*')) {
            $parent = Split-Path -Parent $entry
            $destination = Join-Path $package $parent
            New-Item -ItemType Directory -Path $destination -Force | Out-Null
            Copy-Item -Path $source -Destination $destination -Force
        } else {
            if (!(Test-Path -LiteralPath $source)) { throw "Missing package file: $entry" }
            $destination = Join-Path $package $entry
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        }
    }
    $destinationRoot = [IO.Path]::GetFullPath($OutputDirectory)
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    $archive = Join-Path $destinationRoot ("dsh-session-terms-$($manifest.version)-experimental.zip")
    Compress-Archive -LiteralPath $package -DestinationPath $archive -Force
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $([IO.Path]::GetFileName($archive))" -Encoding utf8
    Write-Output $archive
    Write-Output "SHA256 $hash"
} finally {
    $resolved = [IO.Path]::GetFullPath($stage)
    if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -ne $tempRoot.TrimEnd('\') -or ![IO.Path]::GetFileName($resolved).StartsWith('dsh-terms-package-')) { throw 'Unsafe temporary cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if (Test-Path -LiteralPath $resolved) { throw "Temporary staging remains: $resolved" }
    Write-Output "Removed temporary package staging: $resolved"
}
