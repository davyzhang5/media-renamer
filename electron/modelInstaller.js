const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const execFileAsync = promisify(execFile);

const RUNTIME_VERSION = 'b10809';
const MODEL_REVISION = '167b4af';
const EXPECTED_SIZES = {
  runtime: 11123196,
  model: 2740937888,
  mmproj: 672423616,
};

const RUNTIME_TARGETS = {
  'darwin-arm64': {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_VERSION}/llama-${RUNTIME_VERSION}-bin-macos-arm64.tar.gz`,
    filename: `llama-${RUNTIME_VERSION}-bin-macos-arm64.tar.gz`,
    executable: 'llama-server',
    archive: 'tar',
    size: 11123196,
  },
  'darwin-x64': {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_VERSION}/llama-${RUNTIME_VERSION}-bin-macos-x64.tar.gz`,
    filename: `llama-${RUNTIME_VERSION}-bin-macos-x64.tar.gz`,
    executable: 'llama-server',
    archive: 'tar',
    size: 11123196,
  },
  'win32-x64': {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_VERSION}/llama-${RUNTIME_VERSION}-bin-win-vulkan-x64.zip`,
    filename: `llama-${RUNTIME_VERSION}-bin-win-vulkan-x64.zip`,
    executable: 'llama-server.exe',
    archive: 'zip',
    size: 35221385,
  },
};

let activeDownloadController = null;

function getRuntimeTarget(platform = process.platform, arch = process.arch) {
  return RUNTIME_TARGETS[`${platform}-${arch}`] || null;
}

function getInstallLayout(baseDir, target = getRuntimeTarget()) {
  return {
    baseDir,
    downloadsDir: path.join(baseDir, 'downloads'),
    runtimeDir: path.join(baseDir, `runtime-${RUNTIME_VERSION}`),
    modelsDir: path.join(baseDir, 'models'),
    runtimeArchive: target
      ? path.join(
          baseDir,
          'downloads',
          target.filename
        )
      : '',
    modelPath: path.join(
      baseDir,
      'models',
      'Qwen3.5-4B-Q4_K_M.gguf'
    ),
    mmprojPath: path.join(baseDir, 'models', 'mmproj-F16.gguf'),
    manifestPath: path.join(baseDir, 'installed.json'),
  };
}

function hasExpectedSize(filePath, expectedSize) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size === expectedSize;
  } catch {
    return false;
  }
}

function readManifest(layout) {
  try {
    return JSON.parse(fs.readFileSync(layout.manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(layout, values) {
  fs.mkdirSync(layout.baseDir, { recursive: true });
  fs.writeFileSync(
    layout.manifestPath,
    JSON.stringify(
      {
        ...values,
        runtimeVersion: RUNTIME_VERSION,
        modelRevision: MODEL_REVISION,
        installedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function findRuntimeExecutable(directory, executableName) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return '';
  }

  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === executableName) return candidate;
    if (entry.isDirectory()) {
      const nested = findRuntimeExecutable(candidate, executableName);
      if (nested) return nested;
    }
  }
  return '';
}

function inspectModelInstallation(baseDir, settings = {}) {
  const target = getRuntimeTarget();
  const layout = getInstallLayout(baseDir, target);
  const manifest = readManifest(layout);

  if (
    hasExpectedSize(layout.modelPath, EXPECTED_SIZES.model) &&
    hasExpectedSize(layout.mmprojPath, EXPECTED_SIZES.mmproj)
  ) {
    const runtimePath =
      (manifest?.llamaServerPath &&
      fs.existsSync(manifest.llamaServerPath)
        ? manifest.llamaServerPath
        : findRuntimeExecutable(
            layout.runtimeDir,
            target?.executable || 'llama-server'
          ));
    if (runtimePath) {
      return {
        installed: true,
        managed: true,
        llamaServerPath: runtimePath,
        modelPath: layout.modelPath,
        mmprojPath: layout.mmprojPath,
        baseDir,
      };
    }
  }

  const customPathsValid =
    settings.llamaServerPath &&
    settings.modelPath &&
    settings.mmprojPath &&
    fs.existsSync(settings.llamaServerPath) &&
    fs.existsSync(settings.modelPath) &&
    fs.existsSync(settings.mmprojPath);
  if (customPathsValid) {
    return {
      installed: true,
      managed: false,
      llamaServerPath: settings.llamaServerPath,
      modelPath: settings.modelPath,
      mmprojPath: settings.mmprojPath,
      baseDir,
    };
  }

  return {
    installed: false,
    managed: true,
    baseDir,
    estimatedBytes:
      EXPECTED_SIZES.runtime + EXPECTED_SIZES.model + EXPECTED_SIZES.mmproj,
    runtimeSupported: Boolean(target),
  };
}

async function downloadFile({
  url,
  destination,
  expectedSize,
  onProgress,
  signal,
}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partialPath = `${destination}.part`;

  if (hasExpectedSize(destination, expectedSize)) {
    onProgress?.(expectedSize, expectedSize);
    return;
  }

  let existingBytes = 0;
  try {
    existingBytes = fs.statSync(partialPath).size;
  } catch {
    existingBytes = 0;
  }
  if (existingBytes > expectedSize) {
    fs.rmSync(partialPath, { force: true });
    existingBytes = 0;
  }

  const headers = {
    'User-Agent': 'Media-Renamer/0.3.3',
  };
  if (existingBytes > 0) {
    headers.Range = `bytes=${existingBytes}-`;
  }

  const response = await fetch(url, { headers, redirect: 'follow', signal });
  if (!response.ok && response.status !== 206) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }

  let writeOffset = existingBytes;
  if (response.status === 200) {
    writeOffset = 0;
    fs.rmSync(partialPath, { force: true });
  } else if (response.status !== 206 && existingBytes > 0) {
    writeOffset = 0;
    fs.rmSync(partialPath, { force: true });
  }

  const contentRange = response.headers.get('content-range');
  const totalFromRange = contentRange
    ? Number(contentRange.split('/').pop()) || expectedSize
    : expectedSize;
  let received = writeOffset;
  const output = fs.createWriteStream(partialPath, {
    flags: writeOffset > 0 ? 'a' : 'w',
  });
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    onProgress?.(Math.min(received, totalFromRange), totalFromRange);
  });
  await pipeline(source, output, { signal });

  const finalSize = fs.statSync(partialPath).size;
  if (finalSize !== expectedSize) {
    throw new Error(
      `下载文件不完整：应为 ${expectedSize} 字节，实际为 ${finalSize} 字节`
    );
  }
  fs.renameSync(partialPath, destination);
}

async function extractRuntime(layout, target) {
  fs.rmSync(layout.runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(layout.runtimeDir, { recursive: true });
  if (target.archive === 'tar') {
    await execFileAsync('tar', [
      '-xzf',
      layout.runtimeArchive,
      '-C',
      layout.runtimeDir,
    ]);
  } else {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${layout.runtimeArchive.replaceAll(
        "'",
        "''"
      )}' -DestinationPath '${layout.runtimeDir.replaceAll("'", "''")}' -Force`,
    ]);
  }

  const executablePath = findRuntimeExecutable(
    layout.runtimeDir,
    target.executable
  );
  if (!executablePath) {
    throw new Error('推理运行时解压成功，但没有找到 llama-server');
  }
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

async function installLocalModel({ baseDir, onProgress }) {
  if (activeDownloadController) {
    throw new Error('本地模型正在下载');
  }
  const target = getRuntimeTarget();
  if (!target) {
    throw new Error(`当前平台暂时没有自动下载配置：${process.platform}-${process.arch}`);
  }

  const layout = getInstallLayout(baseDir, target);
  fs.mkdirSync(layout.downloadsDir, { recursive: true });
  fs.mkdirSync(layout.modelsDir, { recursive: true });

  let freeBytes = Number.POSITIVE_INFINITY;
  try {
    const statfs = fs.statfsSync(baseDir);
    freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
  } catch {
    // Some Windows filesystems do not expose statfs; continue without the precheck.
  }
  const runtimeSize = target.size || EXPECTED_SIZES.runtime;
  const requiredBytes =
    runtimeSize +
    EXPECTED_SIZES.model +
    EXPECTED_SIZES.mmproj;
  if (freeBytes < requiredBytes + 500 * 1024 * 1024) {
    throw new Error(
      `磁盘空间不足，需要至少 ${Math.ceil(
        (requiredBytes + 500 * 1024 * 1024) / 1024 / 1024 / 1024
      )} GB 可用空间`
    );
  }

  activeDownloadController = new AbortController();
  const overallTotal = requiredBytes;
  let completedBefore = 0;

  try {
    onProgress?.({
      phase: 'runtime',
      label: '正在下载本地推理运行时',
      percent: 0,
      overallBytes: completedBefore,
      overallTotal,
    });
    await downloadFile({
      url: target.url,
      destination: layout.runtimeArchive,
      expectedSize: runtimeSize,
      signal: activeDownloadController.signal,
      onProgress: (received) => {
        onProgress?.({
          phase: 'runtime',
          label: '正在下载本地推理运行时',
          percent: Math.round((received / runtimeSize) * 100),
          overallBytes: completedBefore + received,
          overallTotal,
        });
      },
    });
    completedBefore += runtimeSize;

    onProgress?.({
      phase: 'runtime',
      label: '正在安装本地推理运行时',
      percent: 100,
      overallBytes: completedBefore,
      overallTotal,
    });
    const llamaServerPath = await extractRuntime(layout, target);

    onProgress?.({
      phase: 'mmproj',
      label: '正在下载视觉投影文件',
      percent: 0,
      overallBytes: completedBefore,
      overallTotal,
    });
    await downloadFile({
      url: `https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/${MODEL_REVISION}/mmproj-F16.gguf`,
      destination: layout.mmprojPath,
      expectedSize: EXPECTED_SIZES.mmproj,
      signal: activeDownloadController.signal,
      onProgress: (received) => {
        onProgress?.({
          phase: 'mmproj',
          label: '正在下载视觉投影文件',
          percent: Math.round((received / EXPECTED_SIZES.mmproj) * 100),
          overallBytes: completedBefore + received,
          overallTotal,
        });
      },
    });
    completedBefore += EXPECTED_SIZES.mmproj;

    onProgress?.({
      phase: 'model',
      label: '正在下载 Qwen 视觉大模型（约 2.6 GB）',
      percent: 0,
      overallBytes: completedBefore,
      overallTotal,
    });
    await downloadFile({
      url: `https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/${MODEL_REVISION}/Qwen3.5-4B-Q4_K_M.gguf`,
      destination: layout.modelPath,
      expectedSize: EXPECTED_SIZES.model,
      signal: activeDownloadController.signal,
      onProgress: (received) => {
        onProgress?.({
          phase: 'model',
          label: '正在下载 Qwen 视觉大模型',
          percent: Math.round((received / EXPECTED_SIZES.model) * 100),
          overallBytes: completedBefore + received,
          overallTotal,
        });
      },
    });

    writeManifest(layout, {
      llamaServerPath,
      modelPath: layout.modelPath,
      mmprojPath: layout.mmprojPath,
    });
    onProgress?.({
      phase: 'complete',
      label: '本地模型安装完成',
      percent: 100,
      overallBytes: overallTotal,
      overallTotal,
    });
    return {
      llamaServerPath,
      modelPath: layout.modelPath,
      mmprojPath: layout.mmprojPath,
      baseDir,
    };
  } finally {
    activeDownloadController = null;
  }
}

function cancelLocalModelDownload() {
  if (!activeDownloadController) return false;
  activeDownloadController.abort();
  return true;
}

module.exports = {
  cancelLocalModelDownload,
  downloadFile,
  EXPECTED_SIZES,
  getInstallLayout,
  getRuntimeTarget,
  inspectModelInstallation,
  installLocalModel,
  RUNTIME_VERSION,
};
