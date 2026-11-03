const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const {
  buildTemplateFromFields,
  defaultNamingFields,
  normalizeNamingFields,
} = require('./rename');

const DEFAULT_PORT = 19080;

function detectedDefaults() {
  const home = os.homedir();
  const bundledFfmpegDir = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg')
    : path.join(__dirname, '..', 'vendor', 'ffmpeg');
  const renamerResources = path.join(
    home,
    'Library',
    'Caches',
    'com.sancijun.renamerx',
    'resources'
  );

  const candidates = {
    llamaServerPath: path.join(
      renamerResources,
      'llama-b10809-bin-macos-arm64',
      'llama-b10809',
      'llama-server'
    ),
    modelPath: path.join(
      renamerResources,
      'qwen3_5-4b-q4km-v1',
      'Qwen3.5-4B-Q4_K_M.gguf'
    ),
    mmprojPath: path.join(
      renamerResources,
      'qwen3_5-4b-q4km-v1-mmproj',
      'mmproj-F16.gguf'
    ),
    ffmpegPath:
      process.platform === 'win32'
        ? path.join(bundledFfmpegDir, 'ffmpeg.exe')
        : '/opt/homebrew/bin/ffmpeg',
    ffprobePath:
      process.platform === 'win32'
        ? path.join(bundledFfmpegDir, 'ffprobe.exe')
        : '/opt/homebrew/bin/ffprobe',
  };

  return Object.fromEntries(
    Object.entries(candidates).map(([key, value]) => [
      key,
      fs.existsSync(value) ? value : '',
    ])
  );
}

function defaultSettings() {
  return {
    provider: 'managed',
    apiBase: `http://127.0.0.1:${DEFAULT_PORT}/v1`,
    apiKey: '',
    modelName: '',
    managedPort: DEFAULT_PORT,
    contextSize: 8192,
    ...detectedDefaults(),
    namingFields: defaultNamingFields(),
    namingTemplate: '{date}{sep}{subject}',
    dateFormat: 'YYYYMMDD',
    separator: '_',
    language: 'zh',
    titleLength: 24,
    customPrompt: '',
    includeDescriptionInLog: false,
  };
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeSettings(input = {}) {
  const defaults = defaultSettings();
  const merged = { ...defaults, ...input };
  const namingFields = normalizeNamingFields(
    merged.namingFields,
    merged.namingTemplate
  );
  return {
    ...merged,
    namingFields,
    namingTemplate: buildTemplateFromFields(namingFields),
    managedPort: Number(merged.managedPort) || DEFAULT_PORT,
    contextSize: Math.max(2048, Number(merged.contextSize) || 8192),
    titleLength: Math.min(60, Math.max(8, Number(merged.titleLength) || 24)),
    separator: ['_', '-', ' '].includes(merged.separator)
      ? merged.separator
      : '_',
    language: ['zh', 'en'].includes(merged.language) ? merged.language : 'zh',
    provider: ['managed', 'openai'].includes(merged.provider)
      ? merged.provider
      : 'managed',
  };
}

function readSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

function writeSettings(input) {
  const settings = normalizeSettings(input);
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
  return settings;
}

module.exports = {
  defaultSettings,
  getSettingsPath,
  normalizeSettings,
  readSettings,
  writeSettings,
};
