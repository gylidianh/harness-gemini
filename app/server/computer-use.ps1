& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding

  # Desktop control for the agent. Pure ASCII source so even legacy code-page pipelines cannot
  # corrupt localized messages; every value arrives as environment data and one result line is
  # written to stdout in UTF-8.
  #
  # Coordinates are physical pixels throughout. SetProcessDPIAware is called before anything is
  # measured, so a 125% display does not hand the model a screenshot it cannot click on.
  function U([string]$escaped) { return [regex]::Unescape($escaped) }

  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class LocalHarnessComputer {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion u; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScanW(char character);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    public sealed class WindowInfo {
        public string handle;
        public string title;
        public uint processId;
        public string process;
        public int x, y, width, height;
        public bool minimized;
        public bool foreground;
    }

    private const int SW_RESTORE = 9;
    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    public static string Handle(IntPtr hWnd) { return "0x" + hWnd.ToInt64().ToString("X"); }

    public static IntPtr Parse(string value) {
        if (String.IsNullOrWhiteSpace(value)) return IntPtr.Zero;
        string text = value.Trim();
        long number;
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) { if (!long.TryParse(text.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out number)) return IntPtr.Zero; }
        else if (!long.TryParse(text, out number)) return IntPtr.Zero;
        return number <= 0 ? IntPtr.Zero : new IntPtr(number);
    }

    public static List<WindowInfo> Windows() {
        IntPtr foreground = GetForegroundWindow();
        List<WindowInfo> found = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int length = GetWindowTextLengthW(hWnd);
            if (length <= 0 || length > 512) return true;
            StringBuilder title = new StringBuilder(length + 1);
            if (GetWindowTextW(hWnd, title, title.Capacity) <= 0) return true;
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            // 1x1 helper windows, IME canvases and tray shims are noise: they cannot be clicked on
            // and they push the windows a person actually means out of the list.
            if (rect.Right - rect.Left < 40 || rect.Bottom - rect.Top < 40) return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            string process = "";
            try { process = System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; } catch { }
            if (String.IsNullOrEmpty(process)) process = "pid-" + processId;
            found.Add(new WindowInfo {
                handle = Handle(hWnd), title = title.ToString(), processId = processId, process = process,
                x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top,
                minimized = IsIconic(hWnd), foreground = hWnd == foreground,
            });
            return true;
        }, IntPtr.Zero);
        // The window the user is looking at is the one a model almost always wants, so it leads.
        found.Sort(delegate(WindowInfo a, WindowInfo b) {
            if (a.foreground != b.foreground) return a.foreground ? -1 : 1;
            if (a.minimized != b.minimized) return a.minimized ? 1 : -1;
            long areaA = (long)a.width * a.height, areaB = (long)b.width * b.height;
            return areaB.CompareTo(areaA);
        });
        return found;
    }

    public static IntPtr Focus(string handleValue) {
        IntPtr hWnd = Parse(handleValue);
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) throw new InvalidOperationException("WINDOW_NOT_FOUND");
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
        if (!SetForegroundWindow(hWnd)) throw new InvalidOperationException("FOREGROUND_DENIED");
        return hWnd;
    }

    private static void Mouse(uint flags, int data) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dwFlags = flags;
        inputs[0].u.mi.mouseData = unchecked((uint)data);
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new InvalidOperationException("INPUT_REJECTED");
    }

    /**
     * Puts the pointer where the input queue expects it, which is what a press needs before it is
     * delivered. Fluent shells (Paint, Settings, Explorer) read the pointer position off that
     * queue; a SetCursorPos jump leaves them believing the mouse is still where it was, so the
     * next press at the new point is discarded as stale and only a second press at the same spot
     * works. Plain positioning keeps using Move below; only presses call this first.
     */
    private static void InjectMove(int x, int y) {
        int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (width > 1 && height > 1) {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
            inputs[0].u.mi.dy = (int)Math.Round((y - top) * 65535.0 / (height - 1));
            inputs[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
        // Some environments (RDP, secure desktop) ignore absolute injection: fall back, but only
        // when the cursor really is somewhere else, so a working injection is never fought over.
        POINT now;
        if (!GetCursorPos(out now) || Math.Abs(now.X - x) > 1 || Math.Abs(now.Y - y) > 1) {
            if (!SetCursorPos(x, y)) throw new InvalidOperationException("CURSOR_REJECTED");
        }
    }

    public static void Move(int x, int y) {
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("CURSOR_REJECTED");
    }

    public static void Click(int x, int y, bool right, int count) {
        InjectMove(x, y);
        for (int i = 0; i < count; i++) {
            Mouse(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN, 0);
            Mouse(right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP, 0);
            if (i + 1 < count) System.Threading.Thread.Sleep(60);
        }
    }

    public static void Drag(int fromX, int fromY, int toX, int toY) {
        Move(fromX, fromY);
        Mouse(MOUSEEVENTF_LEFTDOWN, 0);
        try {
            // A single jump is often ignored by drag targets; step it like a hand would.
            for (int step = 1; step <= 12; step++) {
                Move(fromX + (toX - fromX) * step / 12, fromY + (toY - fromY) * step / 12);
                System.Threading.Thread.Sleep(16);
            }
        } finally { Mouse(MOUSEEVENTF_LEFTUP, 0); }
    }

    public static void Scroll(int amount) { Mouse(MOUSEEVENTF_WHEEL, amount); }

    public static void TypeText(string text) {
        foreach (char character in text) {
            if (character == '\r') continue;
            if (character == '\n') { KeyStroke(0x0D, false); KeyStroke(0x0D, true); continue; }
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wScan = character; inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].u.ki.wScan = character; inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new InvalidOperationException("INPUT_REJECTED");
        }
    }

    private static void KeyStroke(ushort virtualKey, bool up) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = virtualKey;
        inputs[0].u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new InvalidOperationException("INPUT_REJECTED");
    }

    /** One chord such as "Control+Shift+T": modifiers go down first, up last, in reverse. */
    public static void Chord(ushort[] modifiers, ushort key) {
        foreach (ushort modifier in modifiers) KeyStroke(modifier, false);
        try { KeyStroke(key, false); KeyStroke(key, true); }
        finally { for (int i = modifiers.Length - 1; i >= 0; i--) KeyStroke(modifiers[i], true); }
    }

    public static POINT Cursor() { POINT point; GetCursorPos(out point); return point; }
}
'@

    $resultPath = $env:LOCAL_HARNESS_COMPUTER_OUTPUT
    $payload = $env:LOCAL_HARNESS_COMPUTER_PAYLOAD
    $request = if ([String]::IsNullOrWhiteSpace($payload)) { @{} } else { $payload | ConvertFrom-Json }
    $action = [string]$env:LOCAL_HARNESS_COMPUTER_ACTION

    [void][LocalHarnessComputer]::SetProcessDPIAware()
    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bounds = @{ x = $screen.X; y = $screen.Y; width = $screen.Width; height = $screen.Height }

    function Resolve-Point($xValue, $yValue, $label) {
        if ($null -eq $xValue -or $null -eq $yValue) { throw ($label + (U ' \u7f3a\u5c11\u5750\u6807\u3002')) }
        $x = [int]$xValue
        $y = [int]$yValue
        if ($x -lt $screen.X -or $x -ge ($screen.X + $screen.Width) -or $y -lt $screen.Y -or $y -ge ($screen.Y + $screen.Height)) {
            throw ($label + (U ' \u5750\u6807 ') + "($x, $y)" + (U ' \u4e0d\u5728\u5c4f\u5e55\u8303\u56f4 ') + "($($bounds.x),$($bounds.y) $($bounds.width)x$($bounds.height))" + (U ' \u5185\u3002'))
        }
        return @{ x = $x; y = $y }
    }

    function Foreground-Info {
        $handle = [LocalHarnessComputer]::Handle([LocalHarnessComputer]::GetForegroundWindow())
        $title = ''
        $window = [LocalHarnessComputer]::Windows() | Where-Object { $_.handle -eq $handle } | Select-Object -First 1
        if ($window) { $title = $window.title }
        return @{ handle = $handle; title = $title }
    }

    if ($action -eq 'windows') {
      $all = @([LocalHarnessComputer]::Windows() | ForEach-Object {
        @{ handle = $_.handle; title = $_.title; process = $_.process; processId = $_.processId
           x = $_.x; y = $_.y; width = $_.width; height = $_.height
           minimized = $_.minimized; foreground = $_.foreground }
      })
      $limit = 60
      $list = @($all | Select-Object -First $limit)
      $response = @{ status = 'done'; screen = $bounds; windows = $list; count = $all.Count
                     truncated = ($all.Count -gt $limit) }
    }
    elseif ($action -eq 'screenshot') {
      if ([String]::IsNullOrWhiteSpace($resultPath) -or -not [System.IO.Path]::IsPathRooted($resultPath) -or -not $resultPath.EndsWith('.png')) {
        throw 'OUTPUT_PATH_INVALID'
      }
      $region = $bounds
      $windowTitle = ''
      if (-not [String]::IsNullOrWhiteSpace([string]$request.window)) {
        $handle = [LocalHarnessComputer]::Parse([string]$request.window)
        if ($handle -eq [IntPtr]::Zero -or -not [LocalHarnessComputer]::IsWindow($handle)) { throw 'WINDOW_NOT_FOUND' }
        $rect = New-Object LocalHarnessComputer+RECT
        if (-not [LocalHarnessComputer]::GetWindowRect($handle, [ref]$rect)) { throw 'WINDOW_RECT_FAILED' }
        $region = @{ x = $rect.Left; y = $rect.Top; width = [Math]::Max(1, $rect.Right - $rect.Left); height = [Math]::Max(1, $rect.Bottom - $rect.Top) }
        $windowTitle = ([LocalHarnessComputer]::Windows() | Where-Object { $_.handle -eq ([LocalHarnessComputer]::Handle($handle)) } | Select-Object -First 1).title
      }
      # Cap the bitmap so a huge multi-monitor desktop cannot exhaust memory in this process.
      $maxPixels = 8000000
      if (($region.width * $region.height) -gt $maxPixels) { throw 'REGION_TOO_LARGE' }

      $bitmap = New-Object System.Drawing.Bitmap($region.width, $region.height)
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.CopyFromScreen($region.x, $region.y, 0, 0, (New-Object System.Drawing.Size($region.width, $region.height))) }
        finally { $graphics.Dispose() }
        $bitmap.Save($resultPath, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally { $bitmap.Dispose() }
      $response = @{ status = 'done'; screen = $bounds; region = $region; windowTitle = $windowTitle
                     width = $region.width; height = $region.height
                     bytes = (Get-Item -LiteralPath $resultPath).Length }
    }
    elseif ($action -eq 'act') {
      $dryRun = ($request.dryRun -eq $true)
      $kind = [string]$request.action
      $report = @{ status = 'done'; action = $kind; dryRun = $dryRun; screen = $bounds }
      switch ($kind) {
        'focus' {
          $target = [string]$request.window
          if ([String]::IsNullOrWhiteSpace($target)) { throw (U '\u805a\u7126\u7a97\u53e3\u9700\u8981 window\u3002') }
          if (-not $dryRun) { [void][LocalHarnessComputer]::Focus($target) }
          $report.window = $target
        }
        'move' {
          $point = Resolve-Point $request.x $request.y (U '\u79fb\u52a8')
          if (-not $dryRun) { [LocalHarnessComputer]::Move($point.x, $point.y) }
          $report.point = $point
        }
        'click' {
          $point = Resolve-Point $request.x $request.y (U '\u70b9\u51fb')
          if (-not $dryRun) { [LocalHarnessComputer]::Click($point.x, $point.y, $false, 1) }
          $report.point = $point
        }
        'double_click' {
          $point = Resolve-Point $request.x $request.y (U '\u53cc\u51fb')
          if (-not $dryRun) { [LocalHarnessComputer]::Click($point.x, $point.y, $false, 2) }
          $report.point = $point
        }
        'right_click' {
          $point = Resolve-Point $request.x $request.y (U '\u53f3\u952e')
          if (-not $dryRun) { [LocalHarnessComputer]::Click($point.x, $point.y, $true, 1) }
          $report.point = $point
        }
        'drag' {
          $from = Resolve-Point $request.fromX $request.fromY (U '\u62d6\u62fd\u8d77\u70b9')
          $to = Resolve-Point $request.toX $request.toY (U '\u62d6\u62fd\u7ec8\u70b9')
          if (-not $dryRun) { [LocalHarnessComputer]::Drag($from.x, $from.y, $to.x, $to.y) }
          $report.from = $from; $report.to = $to
        }
        'scroll' {
          $amount = [int]$request.amount
          if ($amount -eq 0 -or [Math]::Abs($amount) -gt 10000) { throw (U '\u6eda\u52a8\u91cf\u5fc5\u987b\u5728 -10000 \u5230 10000 \u4e4b\u95f4\u3002') }
          if (-not $dryRun) {
            if ($null -ne $request.x) { $point = Resolve-Point $request.x $request.y (U '\u6eda\u52a8'); [LocalHarnessComputer]::Move($point.x, $point.y); $report.point = $point }
            [LocalHarnessComputer]::Scroll($amount)
          }
          $report.amount = $amount
        }
        'type' {
          $text = [string]$request.text
          if ([String]::IsNullOrEmpty($text)) { throw (U '\u8f93\u5165\u9700\u8981 text\u3002') }
          if ($text.Length -gt 2000) { throw (U '\u4e00\u6b21\u8f93\u5165\u4e0d\u80fd\u8d85\u8fc7 2000 \u4e2a\u5b57\u7b26\u3002') }
          if (-not $dryRun) { [LocalHarnessComputer]::TypeText($text) }
          $report.characters = $text.Length
        }
        'key' {
          $keys = [string]$request.keys
          if ([String]::IsNullOrWhiteSpace($keys)) { throw (U '\u6309\u952e\u9700\u8981 keys\u3002') }
          if ($keys.Length -gt 120) { throw (U '\u6309\u952e\u8bf4\u660e\u8fc7\u957f\u3002') }
          $map = @{ ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; meta = 0x5B
                    enter = 0x0D; return = 0x0D; tab = 0x09; escape = 0x1B; esc = 0x1B; space = 0x20
                    backspace = 0x08; delete = 0x2E; del = 0x2E; insert = 0x2D; home = 0x24; end = 0x23
                    pageup = 0x21; pagedown = 0x22; up = 0x26; down = 0x28; left = 0x25; right = 0x27
                    '+' = 0xBB; plus = 0xBB; '-' = 0xBD; minus = 0xBD }
          $trimmedKeys = $keys.Trim()
          $rawParts = @($trimmedKeys.Split('+') | ForEach-Object { [string]$_.Trim() })
          if ($trimmedKeys -eq '+') {
            $parts = @('+')
          } elseif ($rawParts.Count -ge 3 -and $rawParts[$rawParts.Count - 1] -eq '' -and $rawParts[$rawParts.Count - 2] -eq '') {
            $prefix = @($rawParts[0..($rawParts.Count - 3)])
            if ($prefix -contains '') { throw ((U '\u65e0\u6cd5\u6620\u5c04\u6309\u952e\uff1a') + $keys + (U '\u3002')) }
            $parts = @($prefix + @('+'))
          } else {
            if ($rawParts -contains '') { throw ((U '\u65e0\u6cd5\u6620\u5c04\u6309\u952e\uff1a') + $keys + (U '\u3002')) }
            $parts = $rawParts
          }
          if ($parts.Count -lt 1) { throw (U '\u6309\u952e\u8bf4\u660e\u4e3a\u7a7a\u3002') }
          $modifiers = New-Object System.Collections.Generic.List[uint16]
          for ($i = 0; $i -lt $parts.Count - 1; $i++) {
            $name = ([string]$parts[$i]).ToLowerInvariant()
            if (-not $map.ContainsKey($name) -or @(0x11, 0x10, 0x12, 0x5B) -notcontains $map[$name]) { throw ((U '\u4e0d\u8ba4\u8bc6\u7684\u4fee\u9970\u952e\uff1a') + $parts[$i] + (U '\u3002')) }
            $modifiers.Add([uint16]$map[$name])
          }
          $last = [string]$parts[$parts.Count - 1]
          $lower = $last.ToLowerInvariant()
          if ($map.ContainsKey($lower)) { $virtualKey = [uint16]$map[$lower] }
          elseif ($last -match '^F([1-9]|1[0-2])$') { $virtualKey = [uint16](0x70 + [int]$Matches[1] - 1) }
          elseif ($last.Length -eq 1) {
            $scan = [LocalHarnessComputer]::VkKeyScanW([char]$last)
            if ($scan -eq -1) { throw ((U '\u65e0\u6cd5\u6620\u5c04\u6309\u952e\uff1a') + $last + (U '\u3002')) }
            $virtualKey = [uint16]($scan -band 0xFF)
            if ((($scan -shr 8) -band 1) -eq 1 -and -not $modifiers.Contains([uint16]0x10)) { $modifiers.Insert(0, [uint16]0x10) }
          } else { throw ((U '\u65e0\u6cd5\u6620\u5c04\u6309\u952e\uff1a') + $last + (U '\u3002')) }
          if (-not $dryRun) { [LocalHarnessComputer]::Chord($modifiers.ToArray(), $virtualKey) }
          $report.keys = $keys
          $report.virtualKey = [int]$virtualKey
          $report.modifiers = @($modifiers | ForEach-Object { [int]$_ })
        }
        'wait' {
          $milliseconds = [int]$request.amount
          if ($milliseconds -lt 0 -or $milliseconds -gt 10000) { throw (U '\u7b49\u5f85\u65f6\u95f4\u5fc5\u987b\u5728 0 \u5230 10000 \u6beb\u79d2\u4e4b\u95f4\u3002') }
          if (-not $dryRun) { Start-Sleep -Milliseconds $milliseconds }
          $report.waitedMs = $milliseconds
        }
        default { throw "UNKNOWN_COMPUTER_ACTION:$kind" }
      }
      if (-not $dryRun) {
        $cursor = [LocalHarnessComputer]::Cursor()
        $report.cursor = @{ x = $cursor.X; y = $cursor.Y }
        $report.foreground = Foreground-Info
      }
      $response = $report
    }
    else {
      throw 'UNKNOWN_COMPUTER_COMMAND'
    }

    [Console]::Out.WriteLine('LOCAL_HARNESS_COMPUTER_RESULT:' + ($response | ConvertTo-Json -Compress -Depth 6))
    exit 0
  } catch {
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    $code = if ($failure.Message -match '^[A-Z_]+$') { $failure.Message } elseif ($failure.Message -match '^[A-Z_]+:') { $failure.Message } else { 'COMPUTER_ACTION_FAILED' }
    $detail = if ($code -eq 'COMPUTER_ACTION_FAILED') { [string]$failure.Message } else { '' }
    [Console]::Out.WriteLine('LOCAL_HARNESS_COMPUTER_RESULT:' + (@{ status = 'error'; code = $code; detail = $detail } | ConvertTo-Json -Compress))
    exit 1
  }
}
