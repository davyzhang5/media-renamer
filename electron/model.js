const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseModelJson } = require('./rename');

let managedProcess = null;
let managedConfigKey = '';
let managedLogs = [];
let managedReady = false;

function appendManagedLog(chunk) {
  const lines = chunk
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  managedLogs.push(...lines);
  managedLogs = managedLogs.slice(-80);
}

function getManagedStatus() {
  return {
    ready: managedReady,
    running: Boolean(managedProcess && !managedProcess.killed),
    logs: managedLogs.slice(-20),
  };
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }
  return raw ? JSON.parse(raw) : {};
}

async function waitForServer(port, child, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `本地模型服务已退出：${managedLogs.slice(-6).join(' | ')}`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return;
    } catch {
      // The server is still loading the model.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('本地模型加载超时，请检查模型路径和可用内存');
}

async function startManagedServer(settings) {
  if (!settings.llamaServerPath || !fs.existsSync(settings.llamaServerPath)) {
    throw new Error('找不到 llama-server，请先在设置中选择路径');
  }
  if (!settings.modelPath || !fs.existsSync(settings.modelPath)) {
    throw new Error('找不到视觉模型 GGUF 文件，请先在设置中选择路径');
  }
  if (!settings.mmprojPath || !fs.existsSync(settings.mmprojPath)) {
    throw new Error('找不到视觉投影 mmproj 文件，请先在设置中选择路径');
  }

  const key = JSON.stringify({
    llamaServerPath: settings.llamaServerPath,
    modelPath: settings.modelPath,
    mmprojPath: settings.mmprojPath,
    port: settings.managedPort,
    contextSize: settings.contextSize,
  });

  if (managedProcess && !managedProcess.killed && managedConfigKey === key) {
    return { port: settings.managedPort, reused: true };
  }

  await stopManagedServer();
  managedLogs = [];
  managedReady = false;
  managedConfigKey = key;

  const serverDirectory = path.dirname(settings.llamaServerPath);
  const environment = {
    ...process.env,
    DYLD_LIBRARY_PATH: [
      serverDirectory,
      process.env.DYLD_LIBRARY_PATH || '',
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };

  const args = [
    '--host',
    '127.0.0.1',
    '--port',
    String(settings.managedPort),
    '--model',
    settings.modelPath,
    '--mmproj',
    settings.mmprojPath,
    '--image-min-tokens',
    '64',
    '--image-max-tokens',
    '256',
    '--mtmd-batch-max-tokens',
    '512',
    '--ctx-size',
    String(settings.contextSize),
    '--batch-size',
    '2048',
    '--ubatch-size',
    '512',
    '--parallel',
    '2',
    '--gpu-layers',
    'auto',
    '--flash-attn',
    'auto',
    '--reasoning',
    'off',
    '--reasoning-budget',
    '0',
    '--jinja',
    '--no-ui',
    '--no-slots',
  ];

  managedProcess = spawn(settings.llamaServerPath, args, {
    cwd: serverDirectory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  managedProcess.stdout.on('data', appendManagedLog);
  managedProcess.stderr.on('data', appendManagedLog);
  managedProcess.once('exit', () => {
    managedReady = false;
  });

  await waitForServer(settings.managedPort, managedProcess);
  managedReady = true;
  return { port: settings.managedPort, reused: false };
}

async function stopManagedServer() {
  if (managedProcess && managedProcess.exitCode === null) {
    managedProcess.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => managedProcess.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (managedProcess.exitCode === null) managedProcess.kill('SIGKILL');
  }
  managedProcess = null;
  managedReady = false;
}

async function resolveApiBase(settings) {
  if (settings.provider === 'managed') {
    await startManagedServer(settings);
    return `http://127.0.0.1:${settings.managedPort}/v1`;
  }
  return String(settings.apiBase || '').replace(/\/+$/, '');
}

async function getModelId(settings, apiBase) {
  if (settings.modelName && settings.modelName.trim()) {
    return settings.modelName.trim();
  }
  const payload = await fetchJson(`${apiBase}/models`, {
    headers: settings.apiKey
      ? { Authorization: `Bearer ${settings.apiKey}` }
      : {},
  });
  const first = payload?.data?.[0]?.id;
  if (!first) throw new Error('本地模型服务没有返回可用模型名称');
  return first;
}

function buildAnalysisMessages(settings, payload) {
  const languageName = settings.language === 'en' ? 'English' : '简体中文';
  const videoHint =
    payload.kind === 'video'
      ? payload.images.length > 1
        ? '这些图片是同一段视频在不同时间点的画面。'
        : '这是视频中的一个代表性画面。'
      : '这是同一张图片。';
  const customPrompt = settings.customPrompt
    ? `\n用户附加规则：\n${settings.customPrompt}`
    : '';

  const instruction = [
    '你是媒体素材命名助手。',
    videoHint,
    '总结最稳定、最具辨识度的主体、场景和动作。',
    `使用${languageName}输出。`,
    `title 不超过 ${settings.titleLength} 个字符，不加扩展名和标点。`,
    '不可见的信息留空，不要编造。',
    '只返回 JSON，不要 Markdown 或解释：',
    '{"title":"...","location":"...","type":"photo|video|screenshot|illustration","description":"一句话描述"}',
    customPrompt,
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    {
      role: 'user',
      content: [
        ...payload.images.map((url) => ({
          type: 'image_url',
          image_url: { url },
        })),
        {
          type: 'text',
          text: '分析以上媒体，按要求返回 JSON。',
        },
      ],
    },
  ];
}

async function analyzeMedia(settings, payload) {
  const apiBase = await resolveApiBase(settings);
  const model = await getModelId(settings, apiBase);
  const headers = {
    'Content-Type': 'application/json',
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const body = {
    model,
    messages: buildAnalysisMessages(settings, payload),
    temperature: 0.1,
    max_tokens: payload.kind === 'video' ? 140 : 180,
    stream: false,
    response_format: {
      type: 'json_object',
    },
    chat_template_kwargs: {
      enable_thinking: false,
    },
  };
  const response = await fetchJson(
    `${apiBase}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    240000
  );
  const raw =
    response?.choices?.[0]?.message?.content ||
    response?.choices?.[0]?.text ||
    '';
  if (!raw) {
    throw new Error(
      `模型没有返回内容；原始响应：${JSON.stringify(response).slice(0, 1600)}`
    );
  }
  let metadata;
  try {
    metadata = parseModelJson(raw);
  } catch (error) {
    error.message = `${error.message}；原始输出：${raw.slice(0, 1200)}`;
    throw error;
  }
  return {
    raw,
    metadata,
    model,
  };
}

module.exports = {
  analyzeMedia,
  getManagedStatus,
  startManagedServer,
  stopManagedServer,
};
