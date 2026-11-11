# Numen Tree DevTools build script (ASCII only)
# Compiles the dev-only GM portal mod, runs pure policy/HTTP self-tests,
# and produces both a dev jar (portal included) and a production jar
# (portal classes omitted, listener cannot start).
param(
    [switch]$TestOnly,
    [switch]$NoTest
)
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$Src = Join-Path $Root 'src'
$Tests = Join-Path $Root 'tests'
$Build = Join-Path $Root 'build'
$Classes = Join-Path $Build 'classes'
$TestClasses = Join-Path $Build 'test-classes'
$StageDev = Join-Path $Build 'stage-dev'
$StageProd = Join-Path $Build 'stage-prod'
$DevJar = Join-Path $Build 'numen-devtools-0.1.0.jar'
$ProdJar = Join-Path $Build 'numen-devtools-0.1.0-prod.jar'
$Evidence = Join-Path $Build 'selftest.json'
$BuildInfo = Join-Path $Build 'build-info.json'
$Version = '0.1.0'

$JDK = 'C:\Program Files\Microsoft\jdk-25.0.4.7-hotspot\bin'
if (-not (Test-Path (Join-Path $JDK 'javac.exe'))) {
    if ($env:JAVA_HOME) { $JDK = Join-Path $env:JAVA_HOME 'bin' }
}
$JAVAC = Join-Path $JDK 'javac.exe'
$JAR = Join-Path $JDK 'jar.exe'
$JAVA = Join-Path $JDK 'java.exe'
foreach ($tool in @($JAVAC, $JAR, $JAVA)) {
    if (-not (Test-Path $tool)) { throw "JDK tool not found: $tool" }
}

$LIB = 'E:\game\HMCL\.minecraft\libraries'
$MC = 'E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\1.21.1-NeoForge.jar'
$MC_CLIENT = "$LIB\net\minecraft\client\1.21.1-20240808.144430\client-1.21.1-20240808.144430-srg.jar"
$BRIGADIER = "$LIB\com\mojang\brigadier\1.3.10\brigadier-1.3.10.jar"
$CP = @(
    "$LIB\net\neoforged\neoforge\21.1.265\neoforge-21.1.265-universal.jar",
    "$LIB\net\neoforged\fancymodloader\loader\4.0.45\loader-4.0.45.jar",
    "$LIB\net\neoforged\bus\8.0.5\bus-8.0.5.jar",
    "$LIB\net\neoforged\mergetool\2.0.0\mergetool-2.0.0-api.jar",
    $BRIGADIER,
    "$LIB\com\mojang\datafixerupper\10.0.21\datafixerupper-10.0.21.jar",
    $MC_CLIENT,
    $MC
) -join ';'
foreach ($p in @("$LIB\net\neoforged\neoforge\21.1.265\neoforge-21.1.265-universal.jar", $MC_CLIENT, $MC)) {
    if (-not (Test-Path $p)) {
        throw "Minecraft/NeoForge dependency missing: $p (build only; do not install anything)"
    }
}

Write-Host "== devtools $Version =="
if (Test-Path $Build) { Remove-Item $Build -Recurse -Force }
foreach ($p in @($Classes, $TestClasses, $StageDev, $StageProd)) {
    New-Item -ItemType Directory -Path $p -Force | Out-Null
}

Write-Host '== javac (mod) =='
$sources = @(Get-ChildItem $Src -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { throw 'no Java sources found' }
$compileArgs = @('-encoding', 'UTF-8', '--release', '21', '-cp', $CP, '-d', $Classes) + $sources
& $JAVAC @compileArgs
if ($LASTEXITCODE -ne 0) { throw "javac failed (exit $LASTEXITCODE)" }

Write-Host '== javac (pure test path, no Minecraft) =='
$coreSources = @(Get-ChildItem $Src -Recurse -Filter *.java | Where-Object {
        $_.Name -ne 'DevToolsMod.java' -and $_.FullName -notlike '*\portal\PortalService.java'
    } | ForEach-Object { $_.FullName })
$testSources = @(Get-ChildItem $Tests -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$testArgs = @('-encoding', 'UTF-8', '--release', '21', '-d', $TestClasses) + $coreSources + $testSources
& $JAVAC @testArgs
if ($LASTEXITCODE -ne 0) { throw "test javac failed (exit $LASTEXITCODE)" }

$testsPassed = $null
if (-not $NoTest) {
    Write-Host '== selftest (policy + mock HTTP, no game) =='
    & $JAVA -cp "$TestClasses;$Classes" numentree.devtools.tests.Selftest $Evidence
    if ($LASTEXITCODE -ne 0) {
        $testsPassed = $false
        Write-Host 'selftest FAILED; jars will still be built for inspection'
    } else {
        $testsPassed = $true
    }
}

if (-not $TestOnly) {
    Write-Host '== assemble dev jar (portal included) =='
    Copy-Item (Join-Path $Classes '*') $StageDev -Recurse -Force
    Copy-Item (Join-Path $Src 'META-INF') $StageDev -Recurse -Force
    Copy-Item (Join-Path $Src 'pack.mcmeta') $StageDev -Force
    & $JAR --create --file $DevJar -C $StageDev .
    if ($LASTEXITCODE -ne 0) { throw 'dev jar failed' }

    Write-Host '== assemble production jar (portal classes omitted) =='
    Copy-Item (Join-Path $Classes '*') $StageProd -Recurse -Force
    $portalDir = Join-Path $StageProd 'numentree\devtools\portal'
    if (Test-Path $portalDir) { Remove-Item $portalDir -Recurse -Force }
    Copy-Item (Join-Path $Src 'META-INF') $StageProd -Recurse -Force
    Copy-Item (Join-Path $Src 'pack.mcmeta') $StageProd -Force
    & $JAR --create --file $ProdJar -C $StageProd .
    if ($LASTEXITCODE -ne 0) { throw 'production jar failed' }

    $devList = (& $JAR --list --file $DevJar) -join "`n"
    $prodList = (& $JAR --list --file $ProdJar) -join "`n"
    if ($devList -notmatch 'numentree/devtools/portal/PortalService\.class') {
        throw 'dev jar is missing PortalService.class'
    }
    if ($prodList -match 'numentree/devtools/portal/') {
        throw 'production jar still contains portal classes'
    }
    if ($prodList -notmatch 'numentree/devtools/DevToolsMod\.class') {
        throw 'production jar is missing DevToolsMod.class'
    }
}

if (Test-Path $Evidence) {
    $ev = Get-Content $Evidence -Raw | ConvertFrom-Json
    $testCounts = $ev.counts
} else {
    $testCounts = $null
}

$info = [ordered]@{
    version = $Version
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    jdk = (& $JAVAC -version 2>&1 | Out-String).Trim()
    tests = [ordered]@{
        evidence = 'devtools/build/selftest.json'
        passed = $testsPassed
        total = if ($testCounts) { $testCounts.total } else { $null }
        failed = if ($testCounts) { $testCounts.failed } else { $null }
    }
    devJar = $null
    prodJar = $null
}

if (-not $TestOnly) {
    $devHash = (Get-FileHash $DevJar -Algorithm SHA256).Hash.ToLower()
    $prodHash = (Get-FileHash $ProdJar -Algorithm SHA256).Hash.ToLower()
    $info.devJar = [ordered]@{
        path = 'devtools/build/numen-devtools-0.1.0.jar'
        size = (Get-Item $DevJar).Length
        sha256 = $devHash
        portalClasses = $true
    }
    $info.prodJar = [ordered]@{
        path = 'devtools/build/numen-devtools-0.1.0-prod.jar'
        size = (Get-Item $ProdJar).Length
        sha256 = $prodHash
        portalClasses = $false
        listenerReflectionFallback = $true
    }
    Write-Host "dev jar : $DevJar"
    Write-Host "prod jar: $ProdJar"
}
$jsonText = $info | ConvertTo-Json -Depth 6
# Write UTF-8 without BOM (PowerShell 5.1 Set-Content would add one)
[System.IO.File]::WriteAllText($BuildInfo, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "build info: $BuildInfo"

if ($testsPassed -eq $false) { throw 'selftest failed' }
Write-Host 'done'
