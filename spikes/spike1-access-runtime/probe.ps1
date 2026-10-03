# Probes what the Microsoft 365 Access Runtime allows when Access is driven through COM. Run it in Windows PowerShell 5.1.
# Each probe is independent. A failure is recorded and the script goes on.
#
# The first runs showed that New-Object -ComObject Access.Application fails with 0x80080005 on a machine that has only the
# Runtime, although MSACCESS.EXE starts fine when it is given a database. So when COM activation fails, this script starts
# MSACCESS.EXE with the sample database and attaches to that running instance with GetActiveObject.
param(
    [string]$Work = (Join-Path $env:RUNNER_TEMP 'spike1'),
    [string]$Fixtures = (Join-Path $PSScriptRoot 'fixtures')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$script:results = New-Object System.Collections.Generic.List[object]
$script:access = $null
$script:attached = $false
$script:exe = $null

# Watchdog: a modal dialog or a hung COM call would block the script forever. Killing Access makes a blocked call fail.
$watchdog = Start-Job -ScriptBlock { Start-Sleep -Seconds 420; Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force }

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

Probe 'start Access.Application (COM activation)' {
    $script:access = New-Object -ComObject Access.Application
    "version $($script:access.Version), build $($script:access.Build)"
}

# COM activation failed: find out where the executable is, then start it with a database and attach to it.
if (-not $script:access) {
    Probe 'diagnostics: session' {
        "user=$env:USERNAME interactive=$([Environment]::UserInteractive) session=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
    }

    Probe 'diagnostics: COM registration' {
        $k = 'Registry::HKEY_CLASSES_ROOT\CLSID\{73A4C9C1-D68D-11D0-98BF-00A0C90DC8D9}\LocalServer32'
        $v = (Get-ItemProperty $k).'(default)'
        $script:exe = ($v -replace '^"?([^"]+\.exe).*$', '$1')
        "$v (exists = $(Test-Path $script:exe))"
    }

    Probe 'start MSACCESS.EXE with the sample database, then attach with GetActiveObject' {
        if (-not $script:exe) { throw 'no executable path from the COM registration' }
        $p = Start-Process -FilePath $script:exe -ArgumentList "`"$db`"" -PassThru
        $obj = $null
        $deadline = (Get-Date).AddSeconds(60)
        while (-not $obj -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            try { $obj = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Access.Application') } catch { }
        }
        if (-not $obj) { throw "could not attach to the running instance (process exited = $($p.HasExited))" }
        $script:access = $obj
        $script:attached = $true
        "attached; version $($obj.Version), build $($obj.Build)"
    }

    # The instance started above is still running with the sample database open. Try binding to the database file by name, in a
    # separate process with a time limit, because the call can start a new Access or block.
    if (-not $script:access) {
        Probe 'GetObject on the database file (file moniker) while Access has it open' {
            $j = Start-Job -ArgumentList $db -ScriptBlock {
                param($path)
                Add-Type -AssemblyName Microsoft.VisualBasic
                try { $o = [Microsoft.VisualBasic.Interaction]::GetObject($path); "bound; type $($o.GetType().FullName)" }
                catch { "error: $($_.Exception.Message)" }
            }
            if (Wait-Job $j -Timeout 40) { $r = Receive-Job $j; Remove-Job $j -Force; $r } else { Stop-Job $j; Remove-Job $j -Force; throw 'timed out after 40 seconds' }
        }
    }
}

if ($script:access) {
    Probe 'runtime mode (SysCmd 6)' { "runtime = $($script:access.SysCmd(6))" }

    # In the COM activation case this must happen before the file is opened, so that an AutoExec macro does not run.
    # When attached, the sample database is already open, so this only shows that the property can be set.
    Probe 'disable macros (AutomationSecurity = 3)' { $script:access.AutomationSecurity = 3; "AutomationSecurity = $($script:access.AutomationSecurity)" }

    if ($script:attached) {
        Probe 'the sample database is the current database' { $script:access.CurrentProject.FullName }
    } else {
        Probe 'open the database' { $script:access.OpenCurrentDatabase($db); 'opened' }
    }

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

# DAO through the ACE database engine reads a database without starting the Access application.
$script:dao = $null
Probe 'DAO via ACE (no Access process): open the sample database read-only' {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $script:dao = $dbe.OpenDatabase($db, $false, $true)
    "DAO engine version $($dbe.Version)"
}

if ($script:dao) {
    Probe 'DAO via ACE: tables, fields, indexes, relations, queries' {
        $t = @($script:dao.TableDefs | Where-Object { -not ($_.Attributes -band -2147483648) -and -not $_.Name.StartsWith('MSys') -and -not $_.Name.StartsWith('~') })
        $fields = 0; $indexes = 0
        foreach ($x in $t) { $fields += $x.Fields.Count; $indexes += $x.Indexes.Count }
        $q = @($script:dao.QueryDefs | Where-Object { -not $_.Name.StartsWith('~') })
        "tables=$($t.Count) fields=$fields indexes=$indexes relations=$($script:dao.Relations.Count) queries=$($q.Count) ($(($q | ForEach-Object { $_.Name }) -join ', '))"
    }

    Probe 'DAO via ACE: field details the importer needs' {
        $td = $script:dao.TableDefs.Item('Customers')
        $out = foreach ($f in $td.Fields) {
            "$($f.Name): type=$($f.Type) size=$($f.Size) required=$($f.Required) autoincrement=$([bool]($f.Attributes -band 16)) allowZeroLength=$(try { $f.AllowZeroLength } catch { 'n/a' })"
        }
        $out -join ' | '
    }

    Probe 'DAO via ACE: indexes and relations' {
        $ix = foreach ($i in $script:dao.TableDefs.Item('Customers').Indexes) { "$($i.Name) primary=$($i.Primary) unique=$($i.Unique)" }
        $rel = foreach ($r in $script:dao.Relations) { "$($r.Name): $($r.Table) -> $($r.ForeignTable) attributes=$($r.Attributes)" }
        "indexes: $($ix -join '; ') || relations: $($rel -join '; ')"
    }

    Probe 'DAO via ACE: read rows with their types' {
        $rs = $script:dao.OpenRecordset('SELECT * FROM Customers ORDER BY Id')
        $rows = while (-not $rs.EOF) {
            ($rs.Fields | ForEach-Object { "$($_.Name)=$($_.Value) [$($_.Value.GetType().Name)]" }) -join ', '
            $rs.MoveNext()
        }
        $rs.Close()
        $rows -join ' || '
    }

    Probe 'DAO via ACE: query SQL' {
        $q = $script:dao.QueryDefs.Item('ActiveCustomers')
        $q.SQL.Trim()
    }

    Probe 'DAO via ACE: inventory of forms, reports, macros, modules (names only)' {
        $out = foreach ($c in 'Forms', 'Reports', 'Scripts', 'Modules') {
            $n = 0; foreach ($d in $script:dao.Containers.Item($c).Documents) { $n++ }
            "$c=$n"
        }
        $out -join ' '
    }

    Probe 'DAO via ACE: read MSysObjects' {
        $rs = $script:dao.OpenRecordset("SELECT Name, Type FROM MSysObjects WHERE Name NOT LIKE 'MSys*' AND Name NOT LIKE '~*' ORDER BY Name")
        $rows = while (-not $rs.EOF) { "$($rs.Fields.Item('Name').Value)=$($rs.Fields.Item('Type').Value)"; $rs.MoveNext() }
        $rs.Close()
        $rows -join ', '
    }

    try { $script:dao.Close() } catch { }
}

# Close Access, and kill it if it does not exit.
try { if ($script:access) { $script:access.Quit() } } catch { Write-Host "Quit failed: $($_.Exception.Message)" }
Start-Sleep -Seconds 3
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force
Stop-Job $watchdog -ErrorAction SilentlyContinue
Remove-Job $watchdog -Force -ErrorAction SilentlyContinue

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
