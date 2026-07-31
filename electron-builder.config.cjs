'use strict'

/* Release-candidate package contract. Models, test fixtures, diagnostics and
   workspace artifacts are deliberately absent. Mutable data belongs under
   Electron userData; the packaged application tree remains read-only. */

module.exports = {
  appId: 'com.live-subtitle.desktop',
  productName: 'Live Subtitle',
  artifactName: 'Live-Subtitle-${version}-${arch}.${ext}',
  asar: true,
  npmRebuild: false,
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
  },
  directories: {
    output: '.artifacts/release-package'
  },
  files: [
    'package.json',
    'src/**/*'
  ],
  asarUnpack: [
    'node_modules/sherpa-onnx-win-x64/**/*'
  ],
  win: {
    executableName: 'LiveSubtitle',
    requestedExecutionLevel: 'asInvoker',
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Live Subtitle',
    packElevateHelper: false
  }
}
