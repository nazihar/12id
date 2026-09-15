# Mirrors the aries-uniffi-wrappers AARs into third_party/m2 so the build needs no GitHub
# Packages token (4-init §9). Sources, in order: an existing Gradle cache entry, or a download
# from GitHub Packages with GITHUB_ACTOR/GITHUB_TOKEN set. Writes a POM per artifact (the
# upstream Askar POM's dependency list; the three wrappers share one build) and a .sha256 file.
# Run once per machine or after a wrapper version bump; commit only third_party/m2/CHECKSUMS.
param(
    [string]$GradleHome = $(if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { "$env:USERPROFILE\.gradle" })
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$repo = Join-Path $root 'third_party\m2'
$artifacts = @(
    @{ id = 'askar_uniffi-android'; version = '0.2.0-wrapper.1'; name = 'Askar Uniffi Kotlin' },
    @{ id = 'anoncreds_uniffi-android'; version = '0.2.0-wrapper.1'; name = 'AnonCreds Uniffi Kotlin' },
    @{ id = 'indy_vdr_uniffi-android'; version = '0.2.1-wrapper.2'; name = 'Indy VDR Uniffi Kotlin' }
)

$pomTemplate = @'
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <!-- Mirrored for 12id by scripts/mirror-uniffi.ps1; dependencies copied from the upstream askar_uniffi-android POM. -->
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.hyperledger</groupId>
  <artifactId>@ID@</artifactId>
  <version>@VERSION@</version>
  <packaging>aar</packaging>
  <name>@NAME@</name>
  <url>https://github.com/hyperledger/aries-uniffi-wrappers</url>
  <dependencies>
    <dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-stdlib</artifactId><version>1.9.20</version><scope>compile</scope></dependency>
    <dependency><groupId>net.java.dev.jna</groupId><artifactId>jna</artifactId><version>5.7.0</version><type>aar</type><scope>runtime</scope>
      <exclusions><exclusion><groupId>*</groupId><artifactId>*</artifactId></exclusion></exclusions></dependency>
    <dependency><groupId>org.jetbrains.kotlinx</groupId><artifactId>atomicfu-jvm</artifactId><version>0.22.0</version><scope>runtime</scope></dependency>
    <dependency><groupId>com.squareup.okio</groupId><artifactId>okio-jvm</artifactId><version>3.2.0</version><scope>runtime</scope></dependency>
    <dependency><groupId>org.jetbrains.kotlinx</groupId><artifactId>kotlinx-serialization-json-jvm</artifactId><version>1.5.1</version><scope>runtime</scope></dependency>
    <dependency><groupId>org.jetbrains.kotlinx</groupId><artifactId>kotlinx-coroutines-core-jvm</artifactId><version>1.7.0-RC</version><scope>runtime</scope></dependency>
  </dependencies>
</project>
'@

$checksums = @()
foreach ($a in $artifacts) {
    $dir = Join-Path $repo ("org\hyperledger\{0}\{1}" -f $a.id, $a.version)
    New-Item -ItemType Directory -Force $dir | Out-Null
    $aar = Join-Path $dir ("{0}-{1}.aar" -f $a.id, $a.version)

    if (-not (Test-Path $aar)) {
        $cacheDir = Join-Path $GradleHome ("caches\modules-2\files-2.1\org.hyperledger\{0}\{1}" -f $a.id, $a.version)
        $cached = if (Test-Path $cacheDir) { Get-ChildItem $cacheDir -Recurse -Filter *.aar | Select-Object -First 1 }
        if ($cached) {
            Copy-Item $cached.FullName $aar
            Write-Host "$($a.id): copied from Gradle cache"
        } elseif ($env:GITHUB_TOKEN) {
            $url = "https://maven.pkg.github.com/hyperledger/aries-uniffi-wrappers/org/hyperledger/{0}/{1}/{0}-{1}.aar" -f $a.id, $a.version
            $pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($env:GITHUB_ACTOR):$($env:GITHUB_TOKEN)"))
            Invoke-WebRequest $url -Headers @{ Authorization = "Basic $pair" } -OutFile $aar
            Write-Host "$($a.id): downloaded from GitHub Packages"
        } else {
            throw "$($a.id) $($a.version): not in $cacheDir and GITHUB_TOKEN is not set"
        }
    }

    $pom = $pomTemplate.Replace('@ID@', $a.id).Replace('@VERSION@', $a.version).Replace('@NAME@', $a.name)
    Set-Content -Path (Join-Path $dir ("{0}-{1}.pom" -f $a.id, $a.version)) -Value $pom -Encoding utf8

    $hash = (Get-FileHash $aar -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -Path "$aar.sha256" -Value $hash -Encoding ascii
    $checksums += "$hash  org/hyperledger/$($a.id)/$($a.version)/$($a.id)-$($a.version).aar"
}

$checksumFile = Join-Path $repo 'CHECKSUMS'
if (Test-Path $checksumFile) {
    $expected = (Get-Content $checksumFile) -join "`n"
    if ($expected -ne ($checksums -join "`n")) { throw "AAR checksums differ from the committed third_party/m2/CHECKSUMS" }
    Write-Host 'checksums match CHECKSUMS'
} else {
    Set-Content -Path $checksumFile -Value $checksums -Encoding ascii
    Write-Host 'CHECKSUMS written; commit it'
}
