// What the real-device test (sim-app-real.test.ts) takes for the app's own UI on screen.

// The dev launcher's own screen, the dev menu or its onboarding, React Native's loading banner or
// an error screen (LogBox, the red box, "Could not connect to development server"): not the app (yet).
const NOT_THE_APP =
  /Development Build|DEVELOPMENT SERVERS|Enter URL manually|developer menu|Open JS debugger|Toggle performance monitor|^(Uncaught|Render|Syntax|Console) Error$|^Log \d+ of \d+$|^Call Stack$|^Reload JS$|^(Loading|Bundling|Downloading)\b|^Could not connect to development server|^Dismiss \(ESC\)$|^Reload \(⌘R\)$/i

/**
 * The real-device test's "the app's own UI is on screen": some label, none of the screens above, and
 * the app running (the home screen has labels too). One label is enough: Portivo's map tab shows
 * only "Map" in a 60-node snapshot.
 */
export function simAppOwnUi(labels: readonly string[], running: boolean): boolean {
  return running && labels.length > 0 && !labels.some((label) => NOT_THE_APP.test(label))
}
