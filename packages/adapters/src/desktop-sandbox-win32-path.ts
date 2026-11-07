export {
  createExclusiveChildViaDirectoryFdWin32,
  fileHandleFromFd,
  mkdirChildViaDirectoryFdWin32,
  openChildDirectoryViaDirectoryFdWin32,
  openExistingChildViaDirectoryFdWin32,
  pathFromDirectoryFd,
  pathFromWindowsHandle,
  win32NtRelativeAvailable,
} from "@rakazo/computer/desktop-sandbox-win32-path";
export type { Win32FileHandle } from "@rakazo/computer/desktop-sandbox-win32-path";
