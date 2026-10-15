'use strict';
/*
 * The handful of Windows calls the window watcher needs, made directly from the
 * app through koffi (a small foreign-function library). This replaces the hidden
 * PowerShell the watcher used to run: no extra process, no encoded script for
 * security software to worry about, and far less memory.
 *
 * Everything here is read-only: which window is in front, its title, which
 * program owns it, and whether it covers its whole screen.
 */

// Bound once and shared: koffi refuses to define the same structure twice.
const bound = new WeakMap();

function bindWin32(koffi) {
  if (!bound.has(koffi)) bound.set(koffi, bind(koffi));
  return bound.get(koffi);
}

function bind(koffi) {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const RECT = koffi.struct('FO_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const MONITORINFO = koffi.struct('FO_MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });

  const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr hWnd, _Out_ uint8_t *lpString, int nMaxCount)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *lpdwProcessId)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hWnd, _Out_ FO_RECT *lpRect)');
  const IsZoomed = user32.func('bool __stdcall IsZoomed(intptr hWnd)');
  const MonitorFromWindow = user32.func('intptr __stdcall MonitorFromWindow(intptr hWnd, uint32 dwFlags)');
  const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(intptr hMonitor, _Inout_ FO_MONITORINFO *lpmi)');
  const FindWindowW = user32.func('intptr __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)');
  const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
  const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr hProcess, uint32 dwFlags, _Out_ uint8_t *lpExeName, _Inout_ uint32 *lpdwSize)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr hObject)');

  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const MONITOR_DEFAULTTONEAREST = 2;

  // UTF-16 text out of a buffer the call filled in (n characters).
  const text16 = (buf, n) => (n > 0 ? buf.toString('utf16le', 0, n * 2) : '');

  function windowText(fn, h, max) {
    const buf = Buffer.alloc(max * 2);
    return text16(buf, fn(h, buf, max));
  }

  return {
    foreground: () => Number(GetForegroundWindow()),
    find: (cls, title) => Number(FindWindowW(cls || null, title || null)),
    title: (h) => windowText(GetWindowTextW, h, 512),
    className: (h) => windowText(GetClassNameW, h, 64),
    pid: (h) => {
      const out = [0];
      GetWindowThreadProcessId(h, out);
      return out[0] >>> 0;
    },
    // The program's file name without ".exe", the way PowerShell's ProcessName gave it.
    exeName: (pid) => {
      const proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!proc) return '';
      try {
        const buf = Buffer.alloc(1040);
        const size = [520];
        if (!QueryFullProcessImageNameW(proc, 0, buf, size)) return '';
        const full = text16(buf, size[0]);
        return full.slice(full.lastIndexOf('\\') + 1).replace(/\.exe$/i, '');
      } finally {
        CloseHandle(proc);
      }
    },
    rect: (h) => {
      const r = {};
      return GetWindowRect(h, r) ? r : null;
    },
    zoomed: (h) => !!IsZoomed(h),
    monitor: (h) => {
      const mi = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
      const mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
      return mon && GetMonitorInfoW(mon, mi) ? mi.rcMonitor : null;
    },
  };
}

module.exports = { bindWin32 };
