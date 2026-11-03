const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mediaRenamer', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseFiles: () => ipcRenderer.invoke('dialog:choose-files'),
  choosePath: (kind) => ipcRenderer.invoke('dialog:choose-path', kind),
  prepareFiles: (paths) => ipcRenderer.invoke('files:prepare', paths),
  analyzeFiles: (files, settings) =>
    ipcRenderer.invoke('files:analyze', files, settings),
  applyRenames: (items) => ipcRenderer.invoke('files:apply-renames', items),
  previewNames: (files, settings) =>
    ipcRenderer.invoke('files:preview-names', files, settings),
  undoLastRename: () => ipcRenderer.invoke('files:undo-last-rename'),
  checkModel: (settings) => ipcRenderer.invoke('model:check', settings),
  downloadModel: (settings) => ipcRenderer.invoke('model:download', settings),
  cancelModelDownload: () => ipcRenderer.invoke('model:cancel-download'),
  getModelStatus: () => ipcRenderer.invoke('model:status'),
  revealFile: (filePath) => ipcRenderer.invoke('files:reveal', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onAnalysisProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('analysis:progress', listener);
    return () => ipcRenderer.removeListener('analysis:progress', listener);
  },
  onModelStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('model:status', listener);
    return () => ipcRenderer.removeListener('model:status', listener);
  },
  onModelDownloadProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('model:download-progress', listener);
    return () =>
      ipcRenderer.removeListener('model:download-progress', listener);
  },
});
