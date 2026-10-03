# Probes what the Microsoft 365 Access Runtime allows when Access is driven through COM. Run it in Windows PowerShell 5.1.
# Each probe is independent. A failure is recorded and the script goes on.
param(
    [string]$Work = (Join-Path $env:RUNNER_TEMP 'spike1'),
    [string]$Fixtures = (Join-Path $PSScriptRoot 'fixtures')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$script:results = New-Object System.Collections.Generic.List[object]
$script:access = $null

function Probe([string]$Name, [scriptblock]$Body) {
    try {
        $detail = & $Body
        $script:results.Add([pscustomobject]@{ probe = $Name; ok = $true; detail = "$detail" })
        Write-Host "ok   $Name  $detail"
    } catch {
        $script:results.Add([pscustomobject]@{ probe = $Name; ok = $false; detail = $_.Exception.Message })
        Write-Host "FAIL $Name  $($_.Exception.Message)"
    }
}

$db = Join-Path $Work 'sample.accdb'
Remove-Item $db -ErrorAction SilentlyContinue

# The ACE provider comes with the Access Runtime. Use the newest provider name that is registered.
$provider = $null
foreach ($p in 'Microsoft.ACE.OLEDB.16.0', 'Microsoft.ACE.OLEDB.12.0') {
    if (Test-Path "Registry::HKEY_CLASSES_ROOT\$p") { $provider = $p; break }
}

Probe 'ACE provider is registered' { if (-not $provider) { throw 'no Microsoft.ACE.OLEDB provider is registered' }; $provider }

Probe 'create a sample .accdb with ACE' {
    $conn = "Provider=$provider;Data Source=$db"
    $cat = New-Object -ComObject ADOX.Catalog
    [void]$cat.Create($conn)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($cat)
    $cn = New-Object -ComObject ADODB.Connection
    $cn.Open($conn)
    [void]$cn.Execute('CREATE TABLE Customers (Id AUTOINCREMENT PRIMARY KEY, Name TEXT(50) NOT NULL, Joined DATETIME, Active YESNO, Balance CURRENCY)')
    [void]$cn.Execute('CREATE TABLE Orders (Id AUTOINCREMENT PRIMARY KEY, CustomerId LONG, Total CURRENCY)')
    [void]$cn.Execute('ALTER TABLE Orders ADD CONSTRAINT fk_cust FOREIGN KEY (CustomerId) REFERENCES Customers (Id)')
    [void]$cn.Execute("INSERT INTO Customers (Name, Joined, Active, Balance) VALUES ('Ada', #2024-01-15#, True, 12.5)")
    [void]$cn.Execute("INSERT INTO Customers (Name, Joined, Active, Balance) VALUES ('Brian', #2024-02-01#, False, 0)")
    [void]$cn.Execute('CREATE VIEW ActiveCustomers AS SELECT Id, Name FROM Customers WHERE Active = True')
    $cn.Close()
    "$((Get-Item $db).Length) bytes"
}

Probe 'start Access.Application' {
    $script:access = New-Object -ComObject Access.Application
    "version $($script:access.Version), build $($script:access.Build)"
}

if ($script:access) {
    Probe 'runtime mode (SysCmd 6)' { "runtime = $($script:access.SysCmd(6))" }

    # Must happen before the file is opened, so that an AutoExec macro in an untrusted file does not run.
    Probe 'disable macros (AutomationSecurity = 3)' { $script:access.AutomationSecurity = 3; "AutomationSecurity = $($script:access.AutomationSecurity)" }

    Probe 'open the database' { $script:access.OpenCurrentDatabase($db); 'opened' }

    Probe 'DAO: tables, fields, indexes, relations, queries' {
        $d = $script:access.CurrentDb()
        $t = @($d.TableDefs | Where-Object { -not ($_.Attributes -band -2147483648) -and -not $_.Name.StartsWith('MSys') -and -not $_.Name.StartsWith('~') })
        $fields = 0; $indexes = 0
        foreach ($x in $t) { $fields += $x.Fields.Count; $indexes += $x.Indexes.Count }
        $q = @($d.QueryDefs | Where-Object { -not $_.Name.StartsWith('~') }).Count
        "tables=$($t.Count) fields=$fields indexes=$indexes relations=$($d.Relations.Count) queries=$q"
    }

    Probe 'DoCmd.TransferText: export a table to CSV' {
        $csv = Join-Path $Work 'Customers.csv'
        $script:access.DoCmd.TransferText(2, $null, 'Customers', $csv, $true)
        (Get-Content $csv -TotalCount 3) -join ' | '
    }

    Probe 'LoadFromText: import a minimal form' {
        $script:access.LoadFromText(2, 'FrmProbe', (Join-Path $Fixtures 'form_min.txt'))
        "forms = $($script:access.CurrentProject.AllForms.Count)"
    }

    Probe 'SaveAsText: export that form' {
        $out = Join-Path $Work 'FrmProbe.frm'
        $script:access.SaveAsText(2, 'FrmProbe', $out)
        "$((Get-Item $out).Length) bytes"
    }

    Probe 'LoadFromText: import a minimal VBA module' {
        $script:access.LoadFromText(5, 'ModProbe', (Join-Path $Fixtures 'module_min.bas'))
        "modules = $($script:access.CurrentProject.AllModules.Count)"
    }

    Probe 'SaveAsText: export that module' {
        $out = Join-Path $Work 'ModProbe.bas'
        $script:access.SaveAsText(5, 'ModProbe', $out)
        "$((Get-Item $out).Length) bytes"
    }
}

# Close Access, and kill it if it does not exit.
try { if ($script:access) { $script:access.Quit() } } catch { Write-Host "Quit failed: $($_.Exception.Message)" }
Start-Sleep -Seconds 2
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force

$script:results | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $Work 'results.json')
if ($env:GITHUB_STEP_SUMMARY) {
    $lines = @('## Spike 1: Access Runtime probes', '', '| Probe | Result | Detail |', '|---|---|---|')
    foreach ($r in $script:results) {
        $detail = ($r.detail -replace '\|', '/' -replace "`r?`n", ' ')
        $lines += "| $($r.probe) | $(if ($r.ok) { 'ok' } else { 'FAIL' }) | $detail |"
    }
    $lines | Add-Content -Encoding UTF8 $env:GITHUB_STEP_SUMMARY
}
$failed = @($script:results | Where-Object { -not $_.ok }).Count
Write-Host "`n$($script:results.Count) probes, $failed failed"
exit 0
