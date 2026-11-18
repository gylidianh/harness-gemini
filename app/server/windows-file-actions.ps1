& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  try { [Console]::InputEncoding = [Console]::OutputEncoding } catch {}
  $OutputEncoding = [Console]::OutputEncoding
  try {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Reflection;
using System.Threading;

public static class LocalHarnessFileActions {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
        public uint dwLowDateTime, dwHighDateTime;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
        public uint dwFileAttributes;
        public FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
        public uint dwVolumeSerialNumber, nFileSizeHigh, nFileSizeLow, nNumberOfLinks, nFileIndexHigh, nFileIndexLow;
    }
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private const uint ShareAll = 0x00000001 | 0x00000002 | 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FlagBackupSemantics = 0x02000000;
    private const uint AttributeDirectory = 0x00000010;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateFileW(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder filePath, uint filePathSize, uint flags);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION fileInformation);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool enabled);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetActiveWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

    private static bool ActivateRequestedWindow(IntPtr window) {
        if (window == IntPtr.Zero || !IsWindow(window) || !IsWindowVisible(window)) return false;
        ShowWindowAsync(window, IsIconic(window) ? 9 : 5);
        uint currentThread = GetCurrentThreadId();
        uint ignored;
        uint targetThread = GetWindowThreadProcessId(window, out ignored);
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        bool attachedForeground = false, attachedTarget = false;
        bool foregroundAccepted = false;
        long extendedStyle = IntPtr.Size == 8 ? GetWindowLongPtr(window, -20).ToInt64() : GetWindowLong(window, -20);
        bool alreadyTopmost = (extendedStyle & 0x00000008) != 0;
        try {
            if (foregroundThread != 0 && foregroundThread != currentThread) attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
            if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) attachedTarget = AttachThreadInput(currentThread, targetThread, true);
            // A brief z-order pulse is scoped to the requested window; its original topmost state is restored below.
            if (!alreadyTopmost) SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
            BringWindowToTop(window);
            foregroundAccepted = SetForegroundWindow(window);
            SetActiveWindow(window);
        } finally {
            if (!alreadyTopmost && IsWindow(window)) SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
        IntPtr foreground = GetForegroundWindow();
        bool activated = foreground == window || GetAncestor(foreground, 2) == window;
        return activated;
    }

    private static object Property(object value, string name) { return value.GetType().InvokeMember(name, BindingFlags.GetProperty, null, value, null); }
    private static object Method(object value, string name, params object[] args) { return value.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, value, args); }
    private static void ReleaseCom(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    private static bool SameFilePath(string left, string right) {
        try { return String.Equals(Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    private static IntPtr FindSelectedExplorerWindow(string target) {
        object shell = null, windows = null;
        try {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
            windows = Method(shell, "Windows");
            int count = Convert.ToInt32(Property(windows, "Count"));
            string explorerPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            for (int index = 0; index < count; index++) {
                object window = null, document = null, folder = null, folderItem = null, selected = null, selectedItem = null;
                try {
                    window = Method(windows, "Item", index);
                    if (window == null || !SameFilePath(Convert.ToString(Property(window, "FullName")), explorerPath)) continue;
                    document = Property(window, "Document");
                    folder = Property(document, "Folder");
                    folderItem = Property(folder, "Self");
                    if (!SameFilePath(Convert.ToString(Property(folderItem, "Path")), Path.GetDirectoryName(target))) continue;
                    selected = Method(document, "SelectedItems");
                    if (Convert.ToInt32(Property(selected, "Count")) != 1) continue;
                    selectedItem = Method(selected, "Item", 0);
                    if (!SameFilePath(Convert.ToString(Property(selectedItem, "Path")), target)) continue;
                    IntPtr handle = new IntPtr(Convert.ToInt64(Property(window, "HWND")));
                    StringBuilder className = new StringBuilder(128);
                    GetClassName(handle, className, className.Capacity);
                    if (IsWindowVisible(handle) && (className.ToString() == "CabinetWClass" || className.ToString() == "ExploreWClass")) return handle;
                } catch { /* A window may close or change folders while the shell collection is read. */ }
                finally { ReleaseCom(selectedItem); ReleaseCom(selected); ReleaseCom(folderItem); ReleaseCom(folder); ReleaseCom(document); ReleaseCom(window); }
            }
        } catch { /* The shell may still be creating the requested window. */ }
        finally { ReleaseCom(windows); ReleaseCom(shell); }
        return IntPtr.Zero;
    }

    private static string QuoteArgument(string value) {
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value) {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"') quoted.Append('\\', backslashes * 2 + 1);
            else quoted.Append('\\', backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static STARTUPINFO ExplorerStartupInfo() {
        // Explicit STARTF_USESHOWWINDOW + SW_SHOWNORMAL prevents inheriting the hidden PowerShell window state.
        return new STARTUPINFO { cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x00000001, wShowWindow = 1 };
    }

    private static void Reveal(string target) {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string explorer = Path.Combine(windows, "explorer.exe");
        if (!Path.IsPathRooted(explorer)) throw new IOException("WINDOWS_DIRECTORY_UNAVAILABLE");
        // CreateProcess starts this exact executable without a command shell. The selected path is one quoted data argument.
        StringBuilder commandLine = new StringBuilder(QuoteArgument(explorer) + " /select," + QuoteArgument(target));
        STARTUPINFO startup = ExplorerStartupInfo();
        PROCESS_INFORMATION process;
        if (!CreateProcessW(explorer, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, windows, ref startup, out process)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            if (process.dwProcessId == 0) throw new IOException("EXPLORER_NOT_STARTED");
        } finally {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        }
        DateTime deadline = DateTime.UtcNow.AddSeconds(8);
        bool matched = false;
        int activationAttempts = 0;
        while (DateTime.UtcNow < deadline) {
            IntPtr window = FindSelectedExplorerWindow(target);
            if (window != IntPtr.Zero) {
                matched = true;
                if (ActivateRequestedWindow(window)) return;
                if (++activationAttempts >= 3) break;
            }
            Thread.Sleep(100);
        }
        throw new IOException(matched ? "FOREGROUND_DENIED" : "EXPLORER_WINDOW_NOT_FOUND");
    }

    private static string StripExtendedPrefix(string value) {
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
        if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return value.Substring(4);
        return value;
    }

    private static string TrimNonRootSeparator(string fullPath) {
        string root = Path.GetPathRoot(fullPath);
        if (!String.IsNullOrEmpty(root) && fullPath.Length <= root.Length) return fullPath;
        return fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static string EnsureTrailingSeparator(string directoryPath) {
        if (directoryPath.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)) return directoryPath;
        return directoryPath + Path.DirectorySeparatorChar;
    }

    private static string ResolveFinalPath(string path, out bool isDirectory) {
        // Metadata-only access (0) avoids hydrating cloud-only OneDrive placeholders; omitting
        // FILE_FLAG_OPEN_REPARSE_POINT resolves symlinks and junctions to their final destination.
        IntPtr handle = CreateFileW(path, 0, ShareAll, IntPtr.Zero, OpenExisting, FlagBackupSemantics, IntPtr.Zero);
        if (handle == InvalidHandle || handle == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) throw new FileNotFoundException("FILE_NOT_FOUND", path);
            if (error == 3) throw new DirectoryNotFoundException("DIRECTORY_NOT_FOUND");
            throw new IOException("OPEN_HANDLE_FAILED", Marshal.GetHRForLastWin32Error());
        }
        try {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) {
                throw new IOException("FILE_INFO_FAILED", Marshal.GetHRForLastWin32Error());
            }
            isDirectory = (info.dwFileAttributes & AttributeDirectory) != 0;
            StringBuilder buffer = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length >= (uint)buffer.Capacity) {
                buffer = new StringBuilder((int)length + 1);
                length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            }
            if (length == 0 || length >= (uint)buffer.Capacity) {
                throw new IOException("FINAL_PATH_FAILED", Marshal.GetHRForLastWin32Error());
            }
            return Path.GetFullPath(StripExtendedPrefix(buffer.ToString(0, (int)length)));
        } finally {
            CloseHandle(handle);
        }
    }

    private static string ValidateFile(string file, string workspace) {
        string lexicalWorkspace = TrimNonRootSeparator(Path.GetFullPath(workspace));
        string lexicalRoot = EnsureTrailingSeparator(lexicalWorkspace);
        string lexicalTarget = Path.GetFullPath(file);
        bool lexicalIsRoot = String.Equals(TrimNonRootSeparator(lexicalTarget), lexicalWorkspace, StringComparison.OrdinalIgnoreCase);
        if (!lexicalIsRoot && !lexicalTarget.StartsWith(lexicalRoot, StringComparison.OrdinalIgnoreCase)) {
            throw new IOException("OUTSIDE_WORKSPACE");
        }
        bool workspaceIsDirectory;
        string finalWorkspace = TrimNonRootSeparator(ResolveFinalPath(lexicalWorkspace, out workspaceIsDirectory));
        if (!workspaceIsDirectory) throw new IOException("WORKSPACE_NOT_A_DIRECTORY");
        string finalRoot = EnsureTrailingSeparator(finalWorkspace);
        bool targetIsDirectory;
        string finalTarget = ResolveFinalPath(lexicalTarget, out targetIsDirectory);
        bool finalIsRoot = String.Equals(TrimNonRootSeparator(finalTarget), finalWorkspace, StringComparison.OrdinalIgnoreCase);
        if (!finalIsRoot && !finalTarget.StartsWith(finalRoot, StringComparison.OrdinalIgnoreCase)) {
            throw new IOException("REPARSE_POINT");
        }
        if (targetIsDirectory) throw new IOException("NOT_A_FILE");
        return finalTarget;
    }

    public static string Run(string file, string workspace, string action) {
        string target = ValidateFile(file, workspace);
        // Keep the selected regular file from being replaced while the shell handles this action.
        using (FileStream pinned = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
            if (action == "default") {
                try {
                    Process process = Process.Start(new ProcessStartInfo { FileName = target, Verb = "open", UseShellExecute = true, ErrorDialog = false });
                    if (process != null) process.Dispose();
                    return "done";
                } catch (System.ComponentModel.Win32Exception error) {
                    if (error.NativeErrorCode == 1223) return "cancelled";
                    throw;
                }
            }
            if (action == "reveal") {
                Reveal(target);
                return "done";
            }
            throw new ArgumentException("UNKNOWN_ACTION");
        }
    }
}
'@
    $fileActionResult = [LocalHarnessFileActions]::Run($env:LOCAL_HARNESS_FILE_PATH, $env:LOCAL_HARNESS_FILE_ROOT, $env:LOCAL_HARNESS_FILE_ACTION)
    [Console]::Out.WriteLine('LOCAL_HARNESS_FILE_RESULT:' + (@{status=$fileActionResult} | ConvertTo-Json -Compress))
    exit 0
  } catch {
    $fileActionError = $_.Exception
    while ($fileActionError.InnerException) { $fileActionError = $fileActionError.InnerException }
    $fileActionCode = if (@('FOREGROUND_DENIED', 'EXPLORER_WINDOW_NOT_FOUND') -contains $fileActionError.Message) { $fileActionError.Message } else { '0x{0:X8}' -f $fileActionError.HResult }
    [Console]::Out.WriteLine('LOCAL_HARNESS_FILE_RESULT:' + (@{status='error';code=$fileActionCode} | ConvertTo-Json -Compress))
    exit 1
  }
}
