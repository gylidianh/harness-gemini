# word_worker.ps1 - convert ONE legacy Word file with an isolated Word/WPS COM process.
# Called by read_doc.py as:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File word_worker.ps1 -JobFile <job.json> [-Mode convert|cleanup|list]
# All parameters are passed through a UTF-8 JSON job file, never interpolated into a -Command string
# (avoids premature "$word" expansion and "$f:" drive/scope parsing problems).
# This file is intentionally ASCII-only so Windows PowerShell 5.1 parses it regardless of code page.
# "Word.Application" may be served by Microsoft Word (WINWORD.EXE) or by WPS Office (wps.exe /Automation -Embedding).
#
# 1.3.5: only the Word/WPS process THIS job started is ever ended. It used to end every automation
# process that appeared after the job began, which also killed a Word another conversation, Outlook
# or an ERP export had started meanwhile. The own process is identified by giving the new
# application a unique caption, finding that window and asking Windows which process owns it
# (GetWindowThreadProcessId). Its PID and start time are written to the pid file at once, so the
# timeout cleanup (a separate run of this script) can end exactly that process and nothing else.
# A PID is only acted on while the process still has the recorded start time (no PID reuse).
param(
    [string]$JobFile = '',
    [ValidateSet('convert', 'cleanup', 'list')][string]$Mode = 'convert'
)

$ErrorActionPreference = 'Stop'

function Get-AutomationPids {
    # Office/WPS processes started by COM automation (not interactive windows of the user)
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE' or Name='wps.exe'" -ErrorAction SilentlyContinue)
    @($procs | Where-Object { $_.CommandLine -match '(?i)/Automation|-Embedding' } | ForEach-Object { [int]$_.ProcessId })
}

function Write-Utf8([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-StartTicks([int]$ProcessId) {
    try { return [string]((Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks) } catch { return $null }
}

# True only for the recorded Word/WPS process: same PID, same start time, Word/WPS image name.
function Test-OwnProcess($Own) {
    if ($null -eq $Own -or -not $Own.pid) { return $false }
    try { $p = Get-Process -Id ([int]$Own.pid) -ErrorAction Stop } catch { return $false }
    if (@('WINWORD', 'wps') -notcontains $p.ProcessName) { return $false }
    if (-not $Own.start) { return $false }
    try { return ([string]$p.StartTime.ToUniversalTime().Ticks) -eq [string]$Own.start } catch { return $false }
}

# Ends the recorded process (if it is still the same process) and returns the PIDs ended.
function Stop-OwnProcess($Own) {
    if (-not (Test-OwnProcess $Own)) { return , @() }
    try { Stop-Process -Id ([int]$Own.pid) -Force -ErrorAction Stop } catch { return , @() }
    for ($i = 0; $i -lt 20 -and (Test-OwnProcess $Own); $i++) { Start-Sleep -Milliseconds 100 }
    , @([int]$Own.pid)
}

if ($Mode -eq 'list') {
    $ids = Get-AutomationPids
    Write-Output ((@{ automationPids = $ids }) | ConvertTo-Json -Compress)
    exit 0
}

$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json

if ($Mode -eq 'cleanup') {
    # Called by read_doc.py after a timeout. Ends only the process the convert run recorded as its own;
    # when it never got that far (no PID recorded), nothing is ended.
    $own = $null
    try { $own = (Get-Content -LiteralPath ([string]$job.pidFile) -Raw -Encoding UTF8 | ConvertFrom-Json).own } catch {}
    $k = Stop-OwnProcess $own
    $out = @{ killed = $k; identified = [bool]($own -and $own.pid) }
    Write-Output ($out | ConvertTo-Json -Compress)
    exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace HarnessReadDoc {
  public static class OwnWindow {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowW(string className, string windowName);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    public static uint ProcessOf(string caption) {
      IntPtr window = FindWindowW(null, caption);
      if (window == IntPtr.Zero) return 0;
      uint pid = 0;
      if (GetWindowThreadProcessId(window, out pid) == 0) return 0;
      return pid;
    }
  }
}
'@ | Out-Null

$result = @{
    ok          = $false
    docx        = $false
    pdf         = $false
    error       = $null
    hresult     = $null
    engine      = $null
    wordVersion = $null
    ownPid      = $null
    killed      = @()
    steps       = @()
}
function Add-Step([string]$msg) { $script:result.steps += $msg }

$own = $null
Write-Utf8 ([string]$job.pidFile) ((@{ own = $null }) | ConvertTo-Json -Compress)

# Locate the process behind this job's Word.Application by a caption no other window can have.
function Find-OwnProcess($App) {
    $caption = 'HarnessReadDoc-' + [guid]::NewGuid().ToString('N')
    try { $App.Caption = $caption } catch { Add-Step ('set Caption failed: ' + $_.Exception.Message); return $null }
    for ($i = 0; $i -lt 20; $i++) {
        $found = [HarnessReadDoc.OwnWindow]::ProcessOf($caption)
        if ($found -gt 0) {
            $name = $null
            try { $name = (Get-Process -Id ([int]$found) -ErrorAction Stop).ProcessName } catch {}
            if (@('WINWORD', 'wps') -contains $name) {
                $start = Get-StartTicks ([int]$found)
                if ($start) { return @{ pid = [int]$found; start = $start } }
            }
            Add-Step ('caption window belongs to an unexpected process: ' + $found)
            return $null
        }
        Start-Sleep -Milliseconds 100
    }
    Add-Step 'own Word window not found; its process will not be ended by this job'
    $null
}

$word = $null
$doc = $null
$missing = [System.Type]::Missing
$dummyPwd = 'x-no-password-x'   # protected files fail fast instead of showing a password dialog

try {
    $word = New-Object -ComObject Word.Application
    # Identify (and record) the own process before anything that can hang, such as opening the file.
    $own = Find-OwnProcess $word
    if ($own) {
        $result.ownPid = $own.pid
        Write-Utf8 ([string]$job.pidFile) ((@{ own = $own }) | ConvertTo-Json -Compress)
        Add-Step ('own process ' + $own.pid)
    }
    try { $result.engine = [string]$word.Name } catch {}
    try { $result.wordVersion = [string]$word.Version } catch {}
    try { $word.Visible = $false } catch {}
    try { $word.DisplayAlerts = 0 } catch {}                 # wdAlertsNone
    try { $word.AutomationSecurity = 3 } catch {}            # msoAutomationSecurityForceDisable (no macros)
    try { $word.ScreenUpdating = $false } catch {}

    $src = [string]$job.src
    $repair = [bool]$job.repair
    $opened = $false
    try {
        # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate,
        #      Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible, OpenAndRepair,
        #      DocumentDirection, NoEncodingDialog)
        $doc = $word.Documents.Open($src, $false, $true, $false, $dummyPwd, $dummyPwd, $false, $dummyPwd, $dummyPwd,
            $missing, $missing, $false, $repair, $missing, $true)
        $opened = ($null -ne $doc)
    }
    catch {
        $msg = $_.Exception.Message
        Add-Step ('Open(full) failed: ' + $msg)
        if ($msg -match '(?i)password|0x800A1520|0x800A156D') { throw }
    }
    if (-not $opened) {
        $doc = $word.Documents.Open($src, $false, $true, $false)
        if ($null -eq $doc) { throw 'Documents.Open returned null (Word could not open the file).' }
        Add-Step 'Open(short signature) succeeded'
    }
    Add-Step ('opened, repair=' + $repair)

    # ---- save as .docx (wdFormatXMLDocument = 12, Word 2007+ / WPS) ----
    $dst = [string]$job.dst
    $fmt = 12
    $saved = $false
    try { $doc.SaveAs2($dst, $fmt); $saved = $true; Add-Step 'SaveAs2 ok' }
    catch { Add-Step ('SaveAs2 failed: ' + $_.Exception.Message) }
    if (-not $saved) {
        try { $doc.SaveAs([ref]$dst, [ref]$fmt); $saved = $true; Add-Step 'SaveAs([ref]) ok' }
        catch { Add-Step ('SaveAs([ref]) failed: ' + $_.Exception.Message) }
    }
    if (-not $saved) { $doc.SaveAs($dst, $fmt); $saved = $true; Add-Step 'SaveAs(plain) ok' }
    $result.docx = (Test-Path -LiteralPath $dst)

    # ---- optional PDF (wdExportFormatPDF = 17) for seal / layout checks ----
    if ($job.pdfDst) {
        $pdfDst = [string]$job.pdfDst
        try { $doc.ExportAsFixedFormat($pdfDst, 17); Add-Step 'ExportAsFixedFormat(pdf) ok' }
        catch {
            Add-Step ('ExportAsFixedFormat failed: ' + $_.Exception.Message)
            try { $pf = 17; $doc.SaveAs([ref]$pdfDst, [ref]$pf); Add-Step 'SaveAs(pdf) ok' }
            catch { Add-Step ('SaveAs(pdf) failed: ' + $_.Exception.Message) }
        }
        $result.pdf = (Test-Path -LiteralPath $pdfDst)
    }
    $result.ok = [bool]$result.docx
}
catch {
    $result.error = $_.Exception.Message
    try { $result.hresult = ('0x{0:X8}' -f $_.Exception.HResult) } catch {}
}
finally {
    if ($null -ne $doc) {
        try { $doc.Close(0) } catch { try { $no = 0; $doc.Close([ref]$no) } catch {} }
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) } catch {}
        $doc = $null
    }
    if ($null -ne $word) {
        try { $word.Quit(0) } catch { try { $no = 0; $word.Quit([ref]$no) } catch {} }
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch {}
        $word = $null
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
    # Wait briefly for the own process to exit cleanly, then end it - and only it - if it is still there.
    for ($i = 0; $i -lt 12 -and (Test-OwnProcess $own); $i++) { Start-Sleep -Milliseconds 250 }
    $result.killed = Stop-OwnProcess $own
    Write-Utf8 ([string]$job.resultFile) ($result | ConvertTo-Json -Depth 5 -Compress)
}
if ($result.ok) { exit 0 } else { exit 1 }
