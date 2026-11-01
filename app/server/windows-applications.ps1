& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  try {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32;

public static class LocalHarnessApplications {
    public sealed class Application {
        public string Id;
        public string Name;
        public bool Recommended;
        internal string Executable;
    }

    private sealed class Definition {
        public string Key, Name, Extensions;
        public string[] ExecutableNames, RelativePaths, AbsolutePaths;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private const string TextExtensions = "|.txt|.md|.markdown|.mdx|.log|.csv|.tsv|.json|.jsonl|.yaml|.yml|.xml|.html|.htm|.css|.scss|.less|.js|.mjs|.cjs|.jsx|.ts|.tsx|.py|.go|.rs|.java|.c|.h|.cpp|.hpp|.cs|.sql|.sh|.ps1|.bat|.cmd|.ini|.cfg|.conf|.toml|.env|.svg|.tex|.sln|.csproj|.vue|.svelte|";
    private const string BrowserExtensions = "|.html|.htm|.svg|.pdf|.png|.jpg|.jpeg|.gif|.webp|.avif|.txt|";
    private const string ImageExtensions = "|.bmp|.dib|.jpg|.jpeg|.jpe|.jfif|.png|.gif|.tif|.tiff|.ico|.webp|";
    private const string WordExtensions = "|.doc|.docx|.docm|.dot|.dotx|.rtf|.odt|";
    private const string ExcelExtensions = "|.xls|.xlsx|.xlsm|.xlsb|.xlt|.xltx|.csv|.tsv|.ods|";
    private const string PowerPointExtensions = "|.ppt|.pptx|.pptm|.pps|.ppsx|.pot|.potx|.odp|";

    private static string Folder(Environment.SpecialFolder folder) { return Environment.GetFolderPath(folder); }

    private static List<Definition> Definitions() {
        string windows = Folder(Environment.SpecialFolder.Windows);
        string local = Folder(Environment.SpecialFolder.LocalApplicationData);
        return new List<Definition> {
            new Definition { Key = "notepad", Name = "\u8bb0\u4e8b\u672c", Extensions = TextExtensions, ExecutableNames = new[] { "notepad.exe" }, AbsolutePaths = new[] { Path.Combine(windows, "System32", "notepad.exe") } },
            new Definition { Key = "zcode", Name = "ZCode", Extensions = TextExtensions, ExecutableNames = new[] { "ZCode.exe" }, RelativePaths = new[] { @"ZCode\ZCode.exe" } },
            new Definition { Key = "vscode", Name = "Visual Studio Code", Extensions = TextExtensions, ExecutableNames = new[] { "Code.exe" }, RelativePaths = new[] { @"Microsoft VS Code\Code.exe" } },
            new Definition { Key = "cursor", Name = "Cursor", Extensions = TextExtensions, ExecutableNames = new[] { "Cursor.exe" }, RelativePaths = new[] { @"Cursor\Cursor.exe" } },
            new Definition { Key = "trae", Name = "Trae", Extensions = TextExtensions, ExecutableNames = new[] { "Trae.exe", "Trae CN.exe" }, RelativePaths = new[] { @"Trae\Trae.exe", @"Trae CN\Trae CN.exe" } },
            new Definition { Key = "windsurf", Name = "Windsurf", Extensions = TextExtensions, ExecutableNames = new[] { "Windsurf.exe" }, RelativePaths = new[] { @"Windsurf\Windsurf.exe" } },
            new Definition { Key = "notepadpp", Name = "Notepad++", Extensions = TextExtensions, ExecutableNames = new[] { "notepad++.exe" }, RelativePaths = new[] { @"Notepad++\notepad++.exe" } },
            new Definition { Key = "sublime", Name = "Sublime Text", Extensions = TextExtensions, ExecutableNames = new[] { "sublime_text.exe" }, RelativePaths = new[] { @"Sublime Text\sublime_text.exe", @"Sublime Text 3\sublime_text.exe" } },
            new Definition { Key = "zed", Name = "Zed", Extensions = TextExtensions, ExecutableNames = new[] { "zed.exe" }, RelativePaths = new[] { @"Zed\zed.exe" } },
            new Definition { Key = "edge", Name = "Microsoft Edge", Extensions = BrowserExtensions, ExecutableNames = new[] { "msedge.exe" }, RelativePaths = new[] { @"Microsoft\Edge\Application\msedge.exe" } },
            new Definition { Key = "chrome", Name = "Google Chrome", Extensions = BrowserExtensions, ExecutableNames = new[] { "chrome.exe" }, RelativePaths = new[] { @"Google\Chrome\Application\chrome.exe" }, AbsolutePaths = new[] { Path.Combine(local, @"Google\Chrome\Application\chrome.exe") } },
            new Definition { Key = "firefox", Name = "Firefox", Extensions = BrowserExtensions, ExecutableNames = new[] { "firefox.exe" }, RelativePaths = new[] { @"Mozilla Firefox\firefox.exe" } },
            new Definition { Key = "brave", Name = "Brave", Extensions = BrowserExtensions, ExecutableNames = new[] { "brave.exe" }, RelativePaths = new[] { @"BraveSoftware\Brave-Browser\Application\brave.exe" }, AbsolutePaths = new[] { Path.Combine(local, @"BraveSoftware\Brave-Browser\Application\brave.exe") } },
            new Definition { Key = "acrobat", Name = "Adobe Acrobat", Extensions = "|.pdf|", ExecutableNames = new[] { "Acrobat.exe", "AcroRd32.exe" }, RelativePaths = new[] { @"Adobe\Acrobat DC\Acrobat\Acrobat.exe", @"Adobe\Acrobat Reader DC\Reader\AcroRd32.exe" } },
            new Definition { Key = "foxit", Name = "Foxit PDF Reader", Extensions = "|.pdf|", ExecutableNames = new[] { "FoxitPDFReader.exe", "FoxitReader.exe" }, RelativePaths = new[] { @"Foxit Software\Foxit PDF Reader\FoxitPDFReader.exe", @"Foxit Software\Foxit Reader\FoxitReader.exe" } },
            new Definition { Key = "sumatra", Name = "SumatraPDF", Extensions = "|.pdf|.epub|.mobi|.xps|.djvu|.cbz|.cbr|", ExecutableNames = new[] { "SumatraPDF.exe" }, RelativePaths = new[] { @"SumatraPDF\SumatraPDF.exe" }, AbsolutePaths = new[] { Path.Combine(local, @"SumatraPDF\SumatraPDF.exe") } },
            new Definition { Key = "word", Name = "Microsoft Word", Extensions = WordExtensions, ExecutableNames = new[] { "WINWORD.EXE" }, RelativePaths = OfficePaths("WINWORD.EXE") },
            new Definition { Key = "excel", Name = "Microsoft Excel", Extensions = ExcelExtensions, ExecutableNames = new[] { "EXCEL.EXE" }, RelativePaths = OfficePaths("EXCEL.EXE") },
            new Definition { Key = "powerpoint", Name = "Microsoft PowerPoint", Extensions = PowerPointExtensions, ExecutableNames = new[] { "POWERPNT.EXE" }, RelativePaths = OfficePaths("POWERPNT.EXE") },
            new Definition { Key = "wps-word", Name = "WPS \u6587\u5b57", Extensions = WordExtensions, ExecutableNames = new[] { "wps.exe" }, RelativePaths = new[] { @"Kingsoft\WPS Office\office6\wps.exe" } },
            new Definition { Key = "wps-sheet", Name = "WPS \u8868\u683c", Extensions = ExcelExtensions, ExecutableNames = new[] { "et.exe" }, RelativePaths = new[] { @"Kingsoft\WPS Office\office6\et.exe" } },
            new Definition { Key = "wps-slide", Name = "WPS \u6f14\u793a", Extensions = PowerPointExtensions, ExecutableNames = new[] { "wpp.exe" }, RelativePaths = new[] { @"Kingsoft\WPS Office\office6\wpp.exe" } },
            new Definition { Key = "paint", Name = "\u753b\u56fe", Extensions = ImageExtensions, ExecutableNames = new[] { "mspaint.exe" }, AbsolutePaths = new[] { Path.Combine(windows, "System32", "mspaint.exe"), Path.Combine(local, @"Microsoft\WindowsApps\mspaint.exe") } }
        };
    }

    private static string[] OfficePaths(string executable) {
        return new[] { Path.Combine(@"Microsoft Office\root\Office16", executable), Path.Combine(@"Microsoft Office\Office16", executable), Path.Combine(@"Microsoft Office\Office15", executable) };
    }

    private static string ExistingExecutable(string value, Definition definition) {
        try {
            if (String.IsNullOrWhiteSpace(value)) return null;
            value = Environment.ExpandEnvironmentVariables(value.Trim());
            if (value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"') value = value.Substring(1, value.Length - 2);
            // App Paths values must be a single absolute executable, never a command line.
            if (!Path.IsPathRooted(value) || value.IndexOf('"') >= 0) return null;
            string path = Path.GetFullPath(value);
            string name = Path.GetFileName(path);
            bool knownName = false;
            foreach (string expected in definition.ExecutableNames) if (String.Equals(name, expected, StringComparison.OrdinalIgnoreCase)) { knownName = true; break; }
            return knownName && File.Exists(path) ? path : null;
        } catch { return null; }
    }

    private static string FindExecutable(Definition definition) {
        // The system Notepad entry point also activates packaged Notepad correctly.
        if (definition.Key == "notepad" && definition.AbsolutePaths != null) foreach (string value in definition.AbsolutePaths) {
            string candidate = ExistingExecutable(value, definition);
            if (candidate != null) return candidate;
        }
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine }) {
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
                foreach (string executableName in definition.ExecutableNames) {
                    try {
                        using (RegistryKey registry = RegistryKey.OpenBaseKey(hive, view))
                        using (RegistryKey key = registry.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + executableName, false)) {
                            string candidate = key == null ? null : ExistingExecutable(key.GetValue(null, null) as string, definition);
                            if (candidate != null) return candidate;
                        }
                    } catch { /* An absent or inaccessible registration is not an installed option. */ }
                }
            }
        }
        if (definition.AbsolutePaths != null) foreach (string value in definition.AbsolutePaths) {
            string candidate = ExistingExecutable(value, definition);
            if (candidate != null) return candidate;
        }
        if (definition.RelativePaths != null) {
            string localPrograms = Path.Combine(Folder(Environment.SpecialFolder.LocalApplicationData), "Programs");
            foreach (string root in new[] { localPrograms, Folder(Environment.SpecialFolder.ProgramFiles), Folder(Environment.SpecialFolder.ProgramFilesX86) }) {
                if (String.IsNullOrWhiteSpace(root)) continue;
                foreach (string relative in definition.RelativePaths) {
                    string candidate = ExistingExecutable(Path.Combine(root, relative), definition);
                    if (candidate != null) return candidate;
                }
            }
        }
        return null;
    }

    private static string Identifier(string key, string executable) {
        using (SHA256 hash = SHA256.Create()) {
            byte[] bytes = hash.ComputeHash(Encoding.UTF8.GetBytes(key + "\0" + executable.ToUpperInvariant()));
            StringBuilder id = new StringBuilder("app_");
            foreach (byte value in bytes) id.Append(value.ToString("x2"));
            return id.ToString();
        }
    }

    private static string ValidateFile(string file, string workspace) {
        string root = Path.GetFullPath(workspace).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string target = Path.GetFullPath(file);
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new IOException("OUTSIDE_WORKSPACE");
        string current = target;
        while (current != null && (current.StartsWith(root, StringComparison.OrdinalIgnoreCase) || String.Equals(current.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))) {
            FileAttributes attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("REPARSE_POINT");
            current = Path.GetDirectoryName(current);
        }
        if ((File.GetAttributes(target) & FileAttributes.Directory) != 0) throw new IOException("NOT_A_FILE");
        return target;
    }

    public static List<Application> List(string file, string workspace) {
        string target = ValidateFile(file, workspace);
        string extension = Path.GetExtension(target).ToLowerInvariant();
        List<Application> applications = new List<Application>();
        HashSet<string> found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Definition definition in Definitions()) {
            string executable = FindExecutable(definition);
            if (executable == null || !found.Add(executable)) continue;
            bool recommended = definition.Extensions.IndexOf("|" + extension + "|", StringComparison.Ordinal) >= 0;
            if (extension.Length == 0 && definition.Extensions == TextExtensions) recommended = true;
            applications.Add(new Application { Id = Identifier(definition.Key, executable), Name = definition.Name, Recommended = recommended, Executable = executable });
        }
        // Preserve the fixed display order inside the recommended and other groups.
        List<Application> ordered = applications.FindAll(delegate(Application app) { return app.Recommended; });
        ordered.AddRange(applications.FindAll(delegate(Application app) { return !app.Recommended; }));
        return ordered;
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
        quoted.Append('\\', backslashes * 2).Append('"');
        return quoted.ToString();
    }

    public static string Open(string file, string workspace, string applicationId) {
        string target = ValidateFile(file, workspace);
        Application selected = null;
        // Re-detect installed, known executables on every click; a client ID is never a command or a path.
        foreach (Application application in List(target, workspace)) if (String.Equals(application.Id, applicationId, StringComparison.Ordinal)) { selected = application; break; }
        if (selected == null) throw new IOException("APPLICATION_NOT_FOUND");
        using (FileStream pinned = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
            STARTUPINFO startup = new STARTUPINFO { cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x00000001, wShowWindow = 1 };
            PROCESS_INFORMATION process;
            StringBuilder commandLine = new StringBuilder(QuoteArgument(selected.Executable) + " " + QuoteArgument(target));
            if (!CreateProcessW(selected.Executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, Path.GetDirectoryName(selected.Executable), ref startup, out process)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            try { if (process.dwProcessId == 0) throw new IOException("APPLICATION_NOT_STARTED"); }
            finally {
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            }
        }
        return "done";
    }
}
'@
    if ($env:LOCAL_HARNESS_FILE_ACTION -eq 'applications') {
      $installedApplications = [LocalHarnessApplications]::List($env:LOCAL_HARNESS_FILE_PATH, $env:LOCAL_HARNESS_FILE_ROOT)
      $visibleApplications = @($installedApplications | ForEach-Object { @{id=$_.Id;name=$_.Name;recommended=$_.Recommended} })
      $applicationResult = @{status='done';applications=$visibleApplications}
    } elseif ($env:LOCAL_HARNESS_FILE_ACTION -eq 'application') {
      $applicationStatus = [LocalHarnessApplications]::Open($env:LOCAL_HARNESS_FILE_PATH, $env:LOCAL_HARNESS_FILE_ROOT, $env:LOCAL_HARNESS_APPLICATION_ID)
      $applicationResult = @{status=$applicationStatus}
    } else {
      throw 'UNKNOWN_ACTION'
    }
    [Console]::Out.WriteLine('LOCAL_HARNESS_FILE_RESULT:' + ($applicationResult | ConvertTo-Json -Compress -Depth 4))
    exit 0
  } catch {
    $applicationError = $_.Exception
    while ($applicationError.InnerException) { $applicationError = $applicationError.InnerException }
    $applicationCode = if (@('APPLICATION_NOT_FOUND', 'APPLICATION_NOT_STARTED') -contains $applicationError.Message) { $applicationError.Message } else { '0x{0:X8}' -f $applicationError.HResult }
    [Console]::Out.WriteLine('LOCAL_HARNESS_FILE_RESULT:' + (@{status='error';code=$applicationCode} | ConvertTo-Json -Compress))
    exit 1
  }
}
