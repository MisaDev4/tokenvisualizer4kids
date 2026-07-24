using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TokenTracker;

/// <summary>
/// Brings the terminal window hosting a claude process to the front. A console
/// app usually has no top-level window of its own — the window belongs to an
/// ancestor (Windows Terminal, VS Code, an IDE's shell) — so this walks the
/// parent chain from the claude pid until a process with a window turns up.
/// Best effort: multi-tab hosts come to the front but stay on whatever tab
/// they had focused.
/// </summary>
public static class TerminalFocusService
{
    private const int SwRestore = 9;

    public static bool TryFocus(int pid)
    {
        if (pid <= 0)
        {
            return false;
        }

        try
        {
            var current = pid;
            DateTime? childStart = null;
            for (var hop = 0; hop < 8 && current > 4; hop++)
            {
                using var process = Process.GetProcessById(current);

                // A recycled parent pid belongs to a process born after its
                // supposed child; stop rather than focus a stranger.
                var started = process.StartTime;
                if (childStart is not null && started > childStart.Value)
                {
                    return false;
                }

                childStart = started;
                var handle = process.MainWindowHandle;
                if (handle != IntPtr.Zero)
                {
                    if (IsIconic(handle))
                    {
                        ShowWindow(handle, SwRestore);
                    }

                    return SetForegroundWindow(handle);
                }

                current = ParentPid(process.Handle);
                if (current <= 0)
                {
                    return false;
                }
            }
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException
                                              or System.ComponentModel.Win32Exception)
        {
            // The process exited mid-walk or denies access.
        }

        return false;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    private static int ParentPid(IntPtr processHandle)
    {
        var information = new ProcessBasicInformation();
        return NtQueryInformationProcess(
            processHandle, 0, ref information, Marshal.SizeOf<ProcessBasicInformation>(), out _) == 0
            ? (int)information.InheritedFromUniqueProcessId
            : 0;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int informationClass,
        ref ProcessBasicInformation information,
        int informationLength,
        out int returnLength);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);
}
