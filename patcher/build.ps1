# Numen Lock Fix build script (ASCII only: avoid PowerShell 5.1 ANSI/UTF-8 issues)
# Requires: JDK 21+, NeoForge 1.21.1 libraries from this machine.
$ErrorActionPreference = 'Stop'

$JDK = 'C:\Program Files\Microsoft\jdk-25.0.4.7-hotspot\bin'
$JAVAC = Join-Path $JDK 'javac.exe'
$JAR = Join-Path $JDK 'jar.exe'

$LIB = 'E:\game\HMCL\.minecraft\libraries'
$MC = 'E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\1.21.1-NeoForge.jar'
# Real Minecraft classes (Component / Entity / Commands ...) live in the client srg jar.
$MC_CLIENT = "$LIB\net\minecraft\client\1.21.1-20240808.144430\client-1.21.1-20240808.144430-srg.jar"
# Command API needs Brigadier on the compile classpath.
$BRIGADIER = "$LIB\com\mojang\brigadier\1.3.10\brigadier-1.3.10.jar"

$CP = @(
    "$LIB\net\neoforged\neoforge\21.1.265\neoforge-21.1.265-universal.jar",
    "$LIB\net\neoforged\fancymodloader\loader\4.0.45\loader-4.0.45.jar",
    "$LIB\net\neoforged\bus\8.0.5\bus-8.0.5.jar",
    $BRIGADIER,
    $MC_CLIENT,
    $MC
) -join ';'

$Root = $PSScriptRoot
$Src = Join-Path $Root 'src'
$Out = Join-Path $Root 'build\classes'
$Stage = Join-Path $Root 'build\stage'
$JarOut = Join-Path $Root 'build\numenlockfix-1.1.0.jar'

foreach ($p in @($Out, $Stage)) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
    New-Item -ItemType Directory -Path $p -Force | Out-Null
}

Write-Host '== javac =='
$sources = Get-ChildItem $Src -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$args = @('-encoding', 'UTF-8', '--release', '21', '-cp', $CP, '-d', $Out) + $sources
$proc = Start-Process -FilePath $JAVAC -ArgumentList $args -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) { throw "javac failed (exit $($proc.ExitCode))" }

Write-Host '== assemble jar =='
Copy-Item (Join-Path $Out '*') $Stage -Recurse -Force
Copy-Item (Join-Path $Src 'META-INF') $Stage -Recurse -Force
Copy-Item (Join-Path $Src 'pack.mcmeta') $Stage -Force

& $JAR --create --file $JarOut -C $Stage .
if ($LASTEXITCODE -ne 0) { throw 'jar failed' }

Write-Host "done: $JarOut"
Get-Item $JarOut | Select-Object Name, Length
