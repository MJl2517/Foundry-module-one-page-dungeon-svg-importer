param(
  [string]$FoundryModulesPath = "Z:\TTRPG\Foundry\Foundry Data\Data\modules"
)

$ErrorActionPreference = "Stop"

$moduleId = "watabou-one-page-dungeon-importer"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $repoRoot $moduleId
$targetRoot = $FoundryModulesPath
$target = Join-Path $targetRoot $moduleId

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "Module source folder was not found: $source"
}

if (-not (Test-Path -LiteralPath (Join-Path $source "module.json") -PathType Leaf)) {
  throw "module.json was not found in source folder: $source"
}

if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
  throw "Foundry modules folder was not found: $targetRoot"
}

$resolvedTargetRoot = (Resolve-Path -LiteralPath $targetRoot).Path
$resolvedTargetParent = if (Test-Path -LiteralPath $target) {
  Split-Path -Parent (Resolve-Path -LiteralPath $target).Path
} else {
  $resolvedTargetRoot
}

if ($resolvedTargetParent -ne $resolvedTargetRoot) {
  throw "Refusing to replace unexpected target path: $target"
}

if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

Copy-Item -LiteralPath $source -Destination $target -Recurse -Force

Write-Host "Deployed $moduleId to:"
Write-Host "  $target"
