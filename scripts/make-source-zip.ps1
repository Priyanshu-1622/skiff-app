# Creates a dependency-free zip of the source tree for sharing.
# Usage: powershell -File scripts\make-source-zip.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyy-MM-dd'
$staging = Join-Path $env:TEMP "skiff-src-$stamp"
$zip = Join-Path $root "skiff-work-source-$stamp.zip"

# Directories to skip anywhere in the tree
$skipDirs = @(
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.vite', '.turbo', '.next', '.cache', '.pnpm-store',
  'data', 'logs', '.idea', 'marketing'
)
# File patterns to skip (secrets, lockfiles, binaries, build artifacts)
$skipFiles = @(
  '.env', '.env.local', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  '*.log', '*.tsbuildinfo', '*.sqlite', '*.sqlite-shm', '*.sqlite-wal',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.webp', '*.svg',
  '*.woff', '*.woff2', '*.ttf', '*.eot', '*.mp4', '*.pdf', '*.zip'
)

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

$skipDirRegex = '\\(' + (($skipDirs | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')(\\|$)'

$files = Get-ChildItem -Path $root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch $skipDirRegex } |
  Where-Object {
    $name = $_.Name
    -not ($skipFiles | Where-Object { $name -like $_ })
  }

foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $dest = Join-Path $staging $rel
  $destDir = Split-Path -Parent $dest
  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  Copy-Item $f.FullName -Destination $dest
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output "Wrote $zip  ($size KB, $($files.Count) files)"
