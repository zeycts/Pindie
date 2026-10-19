// Invoked only inside the existing WSL -> Windows PowerShell boundary. Member
// references do NOT preserve a Job's name after the last handle closes. Keep an
// actual non-inheritable Job handle in the suspended browser root before resume.
// If that root/handle disappears, reopening can fail while descendants survive:
// missing name is always UNCONFIRMED, never permission to delete a profile.
// Descendants inherit membership (no breakaway). Never kill by arbitrary PID.
const jobApi = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PindieBrowserJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public uint cb; public string reserved; public string desktop; public string title;
    public uint x; public uint y; public uint width; public uint height;
    public uint charsX; public uint charsY; public uint fill; public uint flags;
    public ushort show; public ushort reservedSize; public IntPtr reservedData;
    public IntPtr stdin; public IntPtr stdout; public IntPtr stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr process; public IntPtr thread; public uint pid; public uint tid; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ACCOUNTING {
    public long user; public long kernel; public long periodUser; public long periodKernel;
    public uint faults; public uint total; public uint active; public uint terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
    ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool DuplicateHandle(IntPtr sourceProcess,
    IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job,
    int infoClass, out ACCOUNTING info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static uint Active(IntPtr job) {
    ACCOUNTING info;
    if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return info.active;
  }
}
'@
`;

function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function commandArgument(value: string): string {
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

export function windowsBrowserJobLaunch(job: string, executable: string, args: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'", jobApi,
    `$job = [PindieBrowserJob]::CreateJobObject([IntPtr]::Zero, ${literal(job)})`,
    "$createdError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "if ($job -eq [IntPtr]::Zero) { throw 'Could not create browser job' }",
    "if ($createdError -eq 183) { [PindieBrowserJob]::CloseHandle($job) | Out-Null; throw 'Browser job already exists' }",
    "$info = New-Object PindieBrowserJob+PROCESS_INFORMATION",
    "$startup = New-Object PindieBrowserJob+STARTUPINFO",
    "$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)",
    "$assigned = $false; $success = $false",
    "try {",
    `  $command = [Text.StringBuilder]::new(${literal([executable, ...args].map(commandArgument).join(" "))})`,
    // Suspend before the first instruction: no child can escape before assignment.
    `  if (-not [PindieBrowserJob]::CreateProcess(${literal(executable)}, $command, [IntPtr]::Zero, [IntPtr]::Zero, $false, 4, [IntPtr]::Zero, $null, [ref]$startup, [ref]$info)) { throw 'Could not create suspended browser' }`,
    "  if (-not [PindieBrowserJob]::AssignProcessToJobObject($job, $info.process)) { throw 'Could not assign browser job' }",
    "  $assigned = $true",
    // This is a handle in the launched process, NOT a handle owned by this
    // helper. Do not CloseHandle($browserJobHandle) in the helper's handle table.
    "  $browserJobHandle = [IntPtr]::Zero",
    "  if (-not [PindieBrowserJob]::DuplicateHandle([PindieBrowserJob]::GetCurrentProcess(), $job, $info.process, [ref]$browserJobHandle, 4, $false, 0)) { throw 'Could not retain browser job handle' }",
    "  if ([PindieBrowserJob]::ResumeThread($info.thread) -eq [uint32]::MaxValue) { throw 'Could not resume browser' }",
    "  Write-Output \"PID:$($info.pid)\"",
    "  $success = $true",
    "} finally {",
    "  if (-not $success -and $info.process -ne [IntPtr]::Zero) {",
    "    if ($assigned) { [PindieBrowserJob]::TerminateJobObject($job, 1) | Out-Null }",
    "    else { [PindieBrowserJob]::TerminateProcess($info.process, 1) | Out-Null }",
    "    [PindieBrowserJob]::WaitForSingleObject($info.process, 3000) | Out-Null",
    "  }",
    "  if ($info.thread -ne [IntPtr]::Zero) { [PindieBrowserJob]::CloseHandle($info.thread) | Out-Null }",
    "  if ($info.process -ne [IntPtr]::Zero) { [PindieBrowserJob]::CloseHandle($info.process) | Out-Null }",
    "  [PindieBrowserJob]::CloseHandle($job) | Out-Null",
    "}",
  ].join("\n");
}

export function windowsBrowserJobStop(job: string): string {
  return [
    "$ErrorActionPreference = 'Stop'", jobApi,
    `$job = [PindieBrowserJob]::OpenJobObject(12, $false, ${literal(job)})`, // QUERY | TERMINATE
    "if ($job -eq [IntPtr]::Zero) {",
    "  throw 'Owned browser job cannot be opened; termination is unconfirmed (a missing name does not prove process exit)'",
    "}",
    "try {",
    "  if (-not [PindieBrowserJob]::TerminateJobObject($job, 0)) { throw 'Could not terminate browser job' }",
    "  for ($attempt = 0; $attempt -lt 30; $attempt++) {",
    `    if ([PindieBrowserJob]::Active($job) -eq 0) { Write-Output ${literal(`STOPPED:${job}`)}; exit 0 }`,
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  throw 'Owned browser job still has active processes'",
    "} finally { [PindieBrowserJob]::CloseHandle($job) | Out-Null }",
  ].join("\n");
}
