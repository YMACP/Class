using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// A GUI-subsystem process whose only IPC is its inherited standard streams.
internal static class FolderPicker
{
    private const uint PickFolders = 0x00000020;
    private const uint ForceFileSystem = 0x00000040;
    private const uint PathMustExist = 0x00000800;
    private const uint DontAddToRecent = 0x02000000;
    private const uint NoChangeDirectory = 0x00000008;
    private const uint FileSystemPath = 0x80058000;
    private const int Cancelled = unchecked((int)0x800704C7);

    [STAThread]
    private static int Main()
    {
        IFileOpenDialog dialog = null;
        IShellItem initialFolder = null;
        IShellItem selectedFolder = null;
        IntPtr selectedPath = IntPtr.Zero;
        bool uninitialize = false;
        IntPtr iconHook = IntPtr.Zero, largeIcon = IntPtr.Zero, smallIcon = IntPtr.Zero;
        HookProc iconCallback = null;
        try
        {
            EnableDpiAwareness();
            SetCurrentProcessExplicitAppUserModelID("Class.FolderPicker");
            int initialized = CoInitializeEx(IntPtr.Zero, 0x2 | 0x4);
            Check(initialized);
            uninitialize = true;

            dialog = (IFileOpenDialog)new FileOpenDialog();
            uint options;
            Check(dialog.GetOptions(out options));
            Check(dialog.SetOptions(options | PickFolders | ForceFileSystem |
                PathMustExist | DontAddToRecent | NoChangeDirectory));
            Check(dialog.SetTitle("选择 Class 的工作目录"));
            Check(dialog.SetOkButtonLabel("选择文件夹"));

            string encodedInitial = Environment.GetEnvironmentVariable("CLASS_PICKER_INITIAL_BASE64");
            if (!String.IsNullOrEmpty(encodedInitial))
            {
                string initial = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(encodedInitial));
                if (!String.IsNullOrWhiteSpace(initial))
                {
                    initial = Path.GetFullPath(initial);
                    if (Directory.Exists(initial))
                    {
                        Guid shellItemId = typeof(IShellItem).GUID;
                        Check(SHCreateItemFromParsingName(initial, IntPtr.Zero, ref shellItemId, out initialFolder));
                        Check(dialog.SetFolder(initialFolder));
                    }
                }
            }

            // Keep this dialog ownerless: the caller may terminate this helper on
            // disconnect, which must never leave another process's window disabled.
            // The shell manages the native dialog's initial position and activation.
            // Embed the same icon as Class.exe, and assign it to the actual shell
            // dialog before activation so its taskbar button uses our identity.
            ExtractIconEx(typeof(FolderPicker).Assembly.Location, 0, out largeIcon, out smallIcon, 1);
            iconCallback = delegate(int code, IntPtr window, IntPtr detail)
            {
                try
                {
                  if (code == 5) // HCBT_ACTIVATE; this hook observes only our UI thread.
                  {
                    StringBuilder className = new StringBuilder(64);
                    GetClassName(window, className, className.Capacity);
                    if (className.ToString() == "#32770" && GetWindow(window, 4) == IntPtr.Zero)
                    {
                        if (smallIcon != IntPtr.Zero) SendMessage(window, 0x0080, IntPtr.Zero, smallIcon); // WM_SETICON / ICON_SMALL
                        if (largeIcon != IntPtr.Zero) SendMessage(window, 0x0080, new IntPtr(1), largeIcon); // ICON_BIG
                    }
                }
                  }
                catch { /* Branding must not interrupt the native chooser. */ }
                return CallNextHookEx(iconHook, code, window, detail);
            };
            iconHook = SetWindowsHookEx(5, iconCallback, IntPtr.Zero, GetCurrentThreadId()); // WH_CBT
            int result = dialog.Show(IntPtr.Zero);
            if (result == Cancelled)
            {
                WriteResult("{\"cancelled\":true}");
                return 0;
            }
            Check(result);
            Check(dialog.GetResult(out selectedFolder));
            Check(selectedFolder.GetDisplayName(FileSystemPath, out selectedPath));
            string folder = Marshal.PtrToStringUni(selectedPath);
            if (String.IsNullOrEmpty(folder)) throw new InvalidOperationException("The selected folder has no filesystem path.");
            WriteResult("{\"cancelled\":false,\"path\":" + JsonString(Path.GetFullPath(folder)) + "}");
            return 0;
        }
        catch (Exception error)
        {
            using (StreamWriter stderr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
            {
                stderr.WriteLine("Class directory picker failed (0x" + error.HResult.ToString("X8") + "): " + error.Message);
            }
            return 1;
        }
        finally
        {
            if (iconHook != IntPtr.Zero) UnhookWindowsHookEx(iconHook);
            GC.KeepAlive(iconCallback);
            if (selectedPath != IntPtr.Zero) Marshal.FreeCoTaskMem(selectedPath);
            if (selectedFolder != null) Marshal.ReleaseComObject(selectedFolder);
            if (initialFolder != null) Marshal.ReleaseComObject(initialFolder);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
            if (largeIcon != IntPtr.Zero) DestroyIcon(largeIcon);
            if (smallIcon != IntPtr.Zero && smallIcon != largeIcon) DestroyIcon(smallIcon);
            if (uninitialize) CoUninitialize();
        }
    }

    private static void Check(int result)
    {
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    private static void WriteResult(string value)
    {
        using (StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
        {
            stdout.WriteLine(value);
        }
    }

    private static string JsonString(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': result.Append("\\\\"); break;
                case '"': result.Append("\\\""); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 0x20) result.Append("\\u" + ((int)character).ToString("x4"));
                    else result.Append(character);
                    break;
            }
        }
        return result.Append('"').ToString();
    }

    private static void EnableDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; // PER_MONITOR_AWARE_V2
        }
        catch (EntryPointNotFoundException) { }
        try { SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { }
    }

    private delegate IntPtr HookProc(int code, IntPtr window, IntPtr detail);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint ExtractIconEx(string file, int index, out IntPtr large, out IntPtr small, uint count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int hook, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr window, IntPtr detail);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr kind, IntPtr icon);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint coInit);
    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext,
        ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDPIAware();

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    // All inherited methods are declared in native vtable order. In particular,
    // IModalWindow.Show precedes the IFileDialog and IFileOpenDialog methods.
    [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        [PreserveSig] int SetFileTypes(uint count, IntPtr filters);
        [PreserveSig] int SetFileTypeIndex(uint index);
        [PreserveSig] int GetFileTypeIndex(out uint index);
        [PreserveSig] int Advise(IntPtr events, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOptions(uint options);
        [PreserveSig] int GetOptions(out uint options);
        [PreserveSig] int SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] IShellItem folder);
        [PreserveSig] int SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem folder);
        [PreserveSig] int GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem folder);
        [PreserveSig] int GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int GetFileName(out IntPtr name);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        [PreserveSig] int GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        [PreserveSig] int AddPlace([MarshalAs(UnmanagedType.Interface)] IShellItem item, uint alignment);
        [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        [PreserveSig] int Close(int result);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr filter);
        [PreserveSig] int GetResults(out IntPtr items);
        [PreserveSig] int GetSelectedItems(out IntPtr items);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr context, ref Guid handler, ref Guid interfaceId, out IntPtr result);
        [PreserveSig] int GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint displayName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare([MarshalAs(UnmanagedType.Interface)] IShellItem other, uint hint, out int order);
    }
}
