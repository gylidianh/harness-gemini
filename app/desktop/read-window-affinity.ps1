param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(?:0[xX][0-9a-fA-F]{1,16}|[0-9]{1,20})$')]
  [string]$WindowHandle,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 4294967295)]
  [long]$ExpectedProcessId
)

# Read-only smoke diagnostic for a caller-owned test window. No capture, window
# mutation, process injection, or system configuration changes are performed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$result = [ordered]@{
  ok = $false
  querySucceeded = $false
  windowHandle = $null
  expectedProcessId = $ExpectedProcessId
  ownerProcessId = $null
  affinity = $null
  affinityHex = $null
  protected = $false
  win32Error = 0
  error = $null
}

try {
  if ($WindowHandle.StartsWith('0x', [StringComparison]::OrdinalIgnoreCase)) {
    $unsignedHandle = [UInt64]::Parse($WindowHandle.Substring(2), [Globalization.NumberStyles]::AllowHexSpecifier, [Globalization.CultureInfo]::InvariantCulture)
  } else {
    $unsignedHandle = [UInt64]::Parse($WindowHandle, [Globalization.CultureInfo]::InvariantCulture)
  }
  $result.windowHandle = '0x' + $unsignedHandle.ToString('X')
  if ($unsignedHandle -eq 0) { throw 'INVALID_WINDOW_HANDLE' }
  if ([IntPtr]::Size -ne 8 -and $unsignedHandle -gt [UInt32]::MaxValue) { throw 'HANDLE_DOES_NOT_FIT_PROCESS' }
  $signedHandle = [BitConverter]::ToInt64([BitConverter]::GetBytes($unsignedHandle), 0)
  $targetHandle = [IntPtr]::new($signedHandle)

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace HarnessPetSmoke {
  public static class WindowAffinity {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
  }
}
'@ | Out-Null

  # Guard the HWND before reading protection: it must belong to the exact app
  # process which called this diagnostic, never an unrelated desktop window.
  $ownerProcessId = [UInt32]0
  $threadId = [HarnessPetSmoke.WindowAffinity]::GetWindowThreadProcessId($targetHandle, [ref]$ownerProcessId)
  if ($threadId -eq 0) {
    $result.win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw 'WINDOW_OWNER_QUERY_FAILED'
  }
  $result.ownerProcessId = [long]$ownerProcessId
  if ($ownerProcessId -ne $ExpectedProcessId) { throw 'WINDOW_OWNER_MISMATCH' }

  $affinity = [UInt32]0
  if (-not [HarnessPetSmoke.WindowAffinity]::GetWindowDisplayAffinity($targetHandle, [ref]$affinity)) {
    $result.win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw 'WINDOW_AFFINITY_QUERY_FAILED'
  }
  $result.querySucceeded = $true
  $result.affinity = [long]$affinity
  $result.affinityHex = '0x' + $affinity.ToString('X8')
  $result.protected = $affinity -eq 0x11
  $result.ok = $result.protected
  if (-not $result.protected) { $result.error = 'WINDOW_CAPTURE_EXCLUSION_NOT_ACTIVE' }
} catch {
  $result.error = [string]$_.Exception.Message
  if ($result.error.Length -gt 300) { $result.error = $result.error.Substring(0, 300) }
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 3))
if (-not $result.querySucceeded) { exit 2 }
