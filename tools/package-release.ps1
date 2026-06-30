Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$moduleDir = Join-Path $repoRoot "watabou-one-page-dungeon-importer"
$moduleJsonPath = Join-Path $moduleDir "module.json"
$distDir = Join-Path $repoRoot "dist"
$stageDir = Join-Path $distDir "stage"

if (-not (Test-Path $moduleJsonPath)) {
    throw "module.json was not found: $moduleJsonPath"
}

$module = Get-Content $moduleJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$moduleId = $module.id
$version = $module.version

if (-not $moduleId -or -not $version) {
    throw "module.json must include id and version."
}

$zipPath = Join-Path $distDir "$moduleId.zip"
$manifestPath = Join-Path $distDir "module.json"

if (Test-Path $distDir) {
    Remove-Item $distDir -Recurse -Force
}

New-Item -ItemType Directory -Path $stageDir | Out-Null

$items = @(
    "module.json",
    "README.md",
    "lang",
    "scripts",
    "styles",
    "templates"
)

foreach ($item in $items) {
    $source = Join-Path $moduleDir $item
    if (-not (Test-Path $source)) {
        throw "Required module item is missing: $source"
    }

    Copy-Item $source -Destination $stageDir -Recurse
}

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
Copy-Item $moduleJsonPath -Destination $manifestPath
Remove-Item $stageDir -Recurse -Force

Write-Host ""
Write-Host "Release package created:" -ForegroundColor Green
Write-Host "  $zipPath"
Write-Host "  $manifestPath"
Write-Host ""
Write-Host "GitHub release tag should be: v$version"
Write-Host "Upload both files as release assets."
