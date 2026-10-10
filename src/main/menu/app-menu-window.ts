import { podNativeWindowMenuItems } from '../pod/native-app/pod-native-app'

export function createAppWindowMenu(
  label: string,
  isMac: boolean
): Electron.MenuItemConstructorOptions {
  return {
    label,
    submenu: [
      {
        // Why: Electron's minimize role otherwise steals Ctrl+M from terminal apps such as Crush.
        role: 'minimize',
        ...(isMac ? {} : { accelerator: '', registerAccelerator: false })
      },
      { role: 'zoom' },
      // Pod: opens the nested native UI; empty for upstream builds.
      ...podNativeWindowMenuItems()
    ]
  }
}
