const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} = require('electron');
const {
  getSettingsPath,
  readSettings,
  writeSettings,
} = require('./config');
const {
  analyzeMedia,
  getManagedStatus,
  startManagedServer,
  stopManagedServer,
} = require('./model');
const {
  cancelLocalModelDownload,
  inspectModelInstallation,
  installLocalModel,
} = require('./modelInstaller');
const {
  createMediaPayload,
  inspectFile,
  isSupportedMedia,
} = require('./media');
const {
  applyRenames,
  parseModelJson,
  renderFilename,
  sanitizeFilenamePart,
} = require('./rename');

let mainWindow = null;
let analysisInProgress = false;
const analysisCache = new Map();
let cacheWriteTimer = null;

function getAnalysisCachePath() {
  return path.join(app.getPath('userData'), 'analysis-cache.json');
}

function getLocalModelBaseDir() {
  return path.join(app.getPath('userData'), 'local-model');
}

function resolveInstalledModelSettings(settings) {
  const installation = inspectModelInstallation(
    getLocalModelBaseDir(),
    settings
  );
  if (!installation.installed) return { settings, installation };
  if (
    settings.llamaServerPath === installation.llamaServerPath &&
    settings.modelPath === installation.modelPath &&
    settings.mmprojPath === installation.mmprojPath
  ) {
    return { settings, installation };
  }
  return {
    settings: writeSettings({
      ...settings,
      llamaServerPath: installation.llamaServerPath,
      modelPath: installation.modelPath,
      mmprojPath: installation.mmprojPath,
    }),
    installation,
  };
}

function loadAnalysisCache() {
  try {
    const entries = JSON.parse(
      fs.readFileSync(getAnalysisCachePath(), 'utf8')
    );
    for (const [filePath, value] of Object.entries(entries)) {
      if (value && typeof value.signature === 'string') {
        analysisCache.set(filePath, value);
      }
    }
  } catch {
    // A missing or stale cache should never stop the app from starting.
  }
}

function flushAnalysisCache() {
  if (cacheWriteTimer) {
    clearTimeout(cacheWriteTimer);
    cacheWriteTimer = null;
  }
  try {
    const outputPath = getAnalysisCachePath();
    const temporaryPath = `${outputPath}.tmp`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(Object.fromEntries(analysisCache))
    );
    fs.renameSync(temporaryPath, outputPath);
  } catch {
    // Cache persistence is an optimization; analysis can continue without it.
  }
}

function scheduleCacheWrite() {
  if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
  cacheWriteTimer = setTimeout(flushAnalysisCache, 700);
}

function getAnalysisSignature(file, settings) {
  return JSON.stringify({
    analysisVersion: 3,
    path: file.path,
    size: file.size,
    mtime: file.mtime,
    provider: settings.provider,
    modelPath: settings.modelPath,
    modelName: settings.modelName,
    language: settings.language,
    titleLength: settings.titleLength,
    customPrompt: settings.customPrompt,
  });
}

function cacheAnalysis(file, signature, result) {
  analysisCache.delete(file.path);
  analysisCache.set(file.path, { signature, ...result });
  while (analysisCache.size > 500) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
  scheduleCacheWrite();
}

async function mapWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  const results = new Array(items.length);
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

function getTempDir() {
  const tempDir = path.join(app.getPath('temp'), 'media-renamer');
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function getJournalPath() {
  return path.join(app.getPath('userData'), 'last-rename.json');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: '媒体命名助手',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#f3f1eb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  loadAnalysisCache();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  const { settings, installation } = resolveInstalledModelSettings(
    readSettings()
  );
  if (settings.provider === 'managed' && installation.installed) {
    setTimeout(() => {
      startManagedServer(settings)
        .then(() => {
          mainWindow?.webContents.send('model:status', {
            state: 'ready',
            message: '本地模型已预加载',
          });
        })
        .catch(() => {
          // The first analysis attempt will surface a detailed error.
        });
    }, 1200);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  flushAnalysisCache();
  stopManagedServer().catch(() => {});
});

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:save', (_event, settings) => writeSettings(settings));

ipcMain.handle('dialog:choose-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片或视频',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '图片与视频',
        extensions: [
          'jpg',
          'jpeg',
          'png',
          'webp',
          'heic',
          'heif',
          'gif',
          'tif',
          'tiff',
          'bmp',
          'mp4',
          'mov',
          'm4v',
          'avi',
          'mkv',
          'webm',
          'wmv',
          'flv',
          '3gp',
          'mts',
          'm2ts',
        ],
      },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:choose-path', async (_event, kind) => {
  const isDirectory = kind === 'directory';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isDirectory ? '选择文件夹' : '选择文件',
    properties: isDirectory ? ['openDirectory'] : ['openFile'],
    filters:
      kind === 'ffmpeg'
        ? [{ name: 'FFmpeg', extensions: ['*'] }]
        : undefined,
  });
  return result.canceled ? '' : result.filePaths[0] || '';
});

ipcMain.handle('files:prepare', async (_event, filePaths) => {
  const settings = readSettings();
  const tempDir = getTempDir();
  const uniquePaths = [...new Set(filePaths)].filter(isSupportedMedia);
  return mapWithConcurrency(uniquePaths, 3, async (filePath) => {
    try {
      return await inspectFile(path.resolve(filePath), settings, tempDir);
    } catch (error) {
      return {
        id: `${filePath}-error`,
        path: filePath,
        name: path.basename(filePath),
        error: error.message,
      };
    }
  });
});

ipcMain.handle('files:analyze', async (event, files, settingsInput) => {
  if (analysisInProgress) throw new Error('已有分析任务正在运行');
  analysisInProgress = true;
  const settings = writeSettings(settingsInput || readSettings());
  const tempDir = getTempDir();
  const results = [];

  try {
    if (settings.provider === 'managed') await startManagedServer(settings);
    const analyzed = await mapWithConcurrency(files, 2, async (file, index) => {
      event.sender.send('analysis:progress', {
        index,
        total: files.length,
        file,
        stage: 'extracting',
      });

      try {
        const signature = getAnalysisSignature(file, settings);
        const cached = analysisCache.get(file.path);
        let analysis;
        let payload;

        if (cached?.signature === signature) {
          analysis = cached;
          payload = { kind: file.kind };
          event.sender.send('analysis:progress', {
            index,
            total: files.length,
            file,
            stage: 'cached',
          });
        } else {
          payload = await createMediaPayload(
            file.path,
            settings,
            tempDir,
            file.duration
          );
          event.sender.send('analysis:progress', {
            index,
            total: files.length,
            file,
            stage: 'analyzing',
          });
          analysis = await analyzeMedia(settings, payload);
          cacheAnalysis(file, signature, {
            metadata: analysis.metadata,
            raw: analysis.raw,
            model: analysis.model,
          });
        }

        const metadata = {
          ...analysis.metadata,
          title: sanitizeFilenamePart(
            analysis.metadata.title,
            settings.titleLength
          ),
          type: payload.kind === 'video' ? 'video' : analysis.metadata.type,
          width: file.width,
          height: file.height,
          resolution: file.resolution,
          size: file.size,
          duration: file.duration,
          mediaKind: file.kind,
        };
        const parsedDate = new Date(file.date);
        const fileDate = Number.isNaN(parsedDate.getTime())
          ? new Date(file.mtime || Date.now())
          : parsedDate;
        const suggestedBase = renderFilename({
          template: settings.namingTemplate,
          separator: settings.separator,
          dateFormat: settings.dateFormat,
          originalName: file.name,
          date: fileDate,
          index: index + 1,
          metadata,
          language: settings.language,
          titleLength: settings.titleLength,
        });
        return {
          id: file.id,
          success: true,
          metadata,
          suggestedBase,
          raw: analysis.raw,
          model: analysis.model,
          analysisSignature: signature,
        };
      } catch (error) {
        return {
          id: file.id,
          success: false,
          error: error.message,
        };
      } finally {
        event.sender.send('analysis:progress', {
          index,
          total: files.length,
          file,
          stage: 'done',
        });
      }
    });
    results.push(...analyzed);
  } finally {
    analysisInProgress = false;
  }

  return results;
});

ipcMain.handle('files:apply-renames', (_event, items) => {
  const safeItems = (items || []).map((item) => ({
    path: item.path,
    baseName: item.baseName,
  }));
  return applyRenames(safeItems, getJournalPath());
});

ipcMain.handle('files:preview-names', (_event, files, settingsInput) => {
  const currentSettings = writeSettings(settingsInput || readSettings());
  return (files || []).map((file, index) => {
    if (!file.metadata) {
      return { id: file.id, suggestedBase: '' };
    }
    const parsedDate = new Date(file.date);
    const fileDate = Number.isNaN(parsedDate.getTime())
      ? new Date(file.mtime || Date.now())
      : parsedDate;
    return {
      id: file.id,
      suggestedBase: renderFilename({
        template: currentSettings.namingTemplate,
        separator: currentSettings.separator,
        dateFormat: currentSettings.dateFormat,
        originalName: file.name,
        date: fileDate,
        index: index + 1,
        metadata: {
          ...file.metadata,
          width: file.width,
          height: file.height,
          resolution: file.resolution,
          size: file.size,
          duration: file.duration,
          mediaKind: file.kind,
        },
        language: currentSettings.language,
        titleLength: currentSettings.titleLength,
      }),
    };
  });
});

ipcMain.handle('files:undo-last-rename', () => {
  const journalPath = getJournalPath();
  if (!fs.existsSync(journalPath)) throw new Error('没有可撤销的重命名记录');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const reverseItems = [...(journal.items || [])]
    .reverse()
    .map((item) => ({
      path: item.newPath,
      baseName: path.basename(item.originalPath, path.extname(item.originalPath)),
    }));
  const result = applyRenames(reverseItems, null);
  fs.rmSync(journalPath, { force: true });
  return result;
});

ipcMain.handle('model:check', async (_event, settingsInput) => {
  const settings = writeSettings(settingsInput || readSettings());
  const installation = inspectModelInstallation(
    getLocalModelBaseDir(),
    settings
  );
  if (!installation.installed) {
    throw new Error('本地模型尚未安装，请先点击一键下载');
  }
  if (settings.provider === 'managed') {
    await startManagedServer(settings);
    return {
      ...getManagedStatus(),
      installed: true,
      message: '本地模型已就绪',
    };
  }

  const response = await fetch(
    `${String(settings.apiBase).replace(/\/+$/, '')}/models`,
    {
      headers: settings.apiKey
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : {},
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
  const data = await response.json();
  return {
    ready: true,
    running: true,
    installed: true,
    message: `已连接 ${data?.data?.length || 0} 个模型`,
    logs: [],
  };
});

ipcMain.handle('model:status', () => {
  const settings = readSettings();
  const installation = inspectModelInstallation(
    getLocalModelBaseDir(),
    settings
  );
  return {
    ...getManagedStatus(),
    installed: installation.installed,
    downloadRequired: !installation.installed,
    estimatedBytes: installation.estimatedBytes || 0,
    runtimeSupported: installation.runtimeSupported !== false,
  };
});

ipcMain.handle('model:download', async (event, settingsInput) => {
  const currentSettings = writeSettings(settingsInput || readSettings());
  const paths = await installLocalModel({
    baseDir: getLocalModelBaseDir(),
    onProgress: (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('model:download-progress', progress);
      }
    },
  });
  const settings = writeSettings({
    ...currentSettings,
    provider: 'managed',
    ...paths,
  });
  await startManagedServer(settings);
  return {
    success: true,
    installed: true,
    ready: true,
    settings,
    message: '本地模型已安装并启动',
  };
});

ipcMain.handle('model:cancel-download', () => cancelLocalModelDownload());
ipcMain.handle('files:reveal', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});
