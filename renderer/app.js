const SETTING_IDS = [
  'provider',
  'apiBase',
  'apiKey',
  'modelName',
  'managedPort',
  'contextSize',
  'llamaServerPath',
  'modelPath',
  'mmprojPath',
  'ffmpegPath',
  'dateFormat',
  'separator',
  'language',
  'titleLength',
  'customPrompt',
];

const NAMING_FIELD_META = {
  date: { label: '日期', sample: '20261103', description: '媒体创建日期' },
  subject: { label: '主体', sample: '湖畔日落', description: '模型识别的画面主体' },
  resolution: {
    label: '分辨率',
    sample: '1600x1067',
    description: '图片或视频的宽 × 高',
  },
  width: { label: '宽度', sample: '1600', description: '媒体像素宽度' },
  height: { label: '高度', sample: '1067', description: '媒体像素高度' },
  size: { label: '文件大小', sample: '2.5MB', description: '文件体积' },
  duration: { label: '视频时长', sample: '1m32s', description: '视频时长' },
  type: { label: '类型', sample: 'photo', description: '照片、视频或截图' },
  location: { label: '地点', sample: '紫金山', description: '模型判断的地点' },
  time: { label: '时间', sample: '140509', description: '媒体创建时间' },
  original: { label: '原文件名', sample: 'IMG_0001', description: '原始文件名' },
  index: { label: '序号', sample: '001', description: '本批次中的顺序' },
};

const DEFAULT_FIELD_ORDER = Object.keys(NAMING_FIELD_META);

const api = window.mediaRenamer;
let settings = {};
let files = [];
let namingFields = [];
let draggedFieldKey = '';
let analyzing = false;
let modelInstalled = false;
let modelDownloading = false;
let latestUndoAvailable = false;
let toastTimer = null;

const elements = {
  addButton: document.querySelector('#addButton'),
  dropAddButton: document.querySelector('#dropAddButton'),
  fileInput: document.querySelector('#fileInput'),
  dropZone: document.querySelector('#dropZone'),
  fileList: document.querySelector('#fileList'),
  queueSummary: document.querySelector('#queueSummary'),
  analyzeButton: document.querySelector('#analyzeButton'),
  applyButton: document.querySelector('#applyButton'),
  clearButton: document.querySelector('#clearButton'),
  undoButton: document.querySelector('#undoButton'),
  settingsButton: document.querySelector('#settingsButton'),
  settingsDrawer: document.querySelector('#settingsDrawer'),
  drawerBackdrop: document.querySelector('#drawerBackdrop'),
  closeSettingsButton: document.querySelector('#closeSettingsButton'),
  saveSettingsButton: document.querySelector('#saveSettingsButton'),
  settingsMessage: document.querySelector('#settingsMessage'),
  managedSettings: document.querySelector('#managedSettings'),
  openAiSettings: document.querySelector('#openAiSettings'),
  provider: document.querySelector('#provider'),
  dateFormat: document.querySelector('#dateFormat'),
  separator: document.querySelector('#separator'),
  namingFieldList: document.querySelector('#namingFieldList'),
  namingPreview: document.querySelector('#namingPreview'),
  resetFieldOrderButton: document.querySelector('#resetFieldOrderButton'),
  checkModelButton: document.querySelector('#checkModelButton'),
  modelDot: document.querySelector('#modelDot'),
  modelTitle: document.querySelector('#modelTitle'),
  modelStatus: document.querySelector('#modelStatus'),
  modelProgress: document.querySelector('#modelProgress'),
  modelProgressBar: document.querySelector('#modelProgressBar'),
  toast: document.querySelector('#toast'),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  toastTimer = setTimeout(
    () => elements.toast.classList.remove('visible'),
    2800
  );
}

function setModelState(state, title, status) {
  elements.modelDot.className = 'status-dot';
  if (state) elements.modelDot.classList.add(state);
  elements.modelTitle.textContent = title;
  elements.modelStatus.textContent = status;
}

function setModelAction(mode, label) {
  elements.checkModelButton.dataset.mode = mode;
  elements.checkModelButton.textContent = label;
}

function applyModelStatus(status) {
  modelInstalled = Boolean(status.installed);
  if (!modelInstalled) {
    setModelState(
      '',
      '本地模型未安装',
      status.runtimeSupported === false
        ? '当前系统暂不支持自动安装'
        : `一键下载自动安装，约 ${formatBytes(status.estimatedBytes || 0)}`
    );
    setModelAction('download', '一键下载模型');
    elements.checkModelButton.disabled = status.runtimeSupported === false;
    return;
  }

  elements.checkModelButton.disabled = false;
  if (status.ready) {
    setModelState('ready', '本地模型已就绪', status.message || '可以开始分析素材');
  } else {
    setModelState(
      '',
      '本地模型已安装',
      status.message || '点击检查或开始分析以加载模型'
    );
  }
  setModelAction('check', '检查');
}

function fillSettingsForm() {
  for (const id of SETTING_IDS) {
    const field = document.querySelector(`#${id}`);
    if (field) field.value = settings[id] ?? '';
  }
  namingFields = normalizeNamingFieldsClient(
    settings.namingFields,
    settings.namingTemplate
  );
  renderNamingFields();
  elements.managedSettings.hidden = settings.provider !== 'managed';
  elements.openAiSettings.hidden = settings.provider !== 'openai';
}

function readSettingsForm() {
  const next = {};
  for (const id of SETTING_IDS) {
    const field = document.querySelector(`#${id}`);
    if (field) next[id] = field.value;
  }
  next.managedPort = Number(next.managedPort);
  next.contextSize = Number(next.contextSize);
  next.titleLength = Number(next.titleLength);
  next.namingFields = namingFields.map((field) => ({ ...field }));
  return next;
}

function normalizeNamingFieldsClient(input, legacyTemplate = '') {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const normalized = [];
  const add = (key, enabled) => {
    if (!NAMING_FIELD_META[key] || seen.has(key)) return;
    seen.add(key);
    normalized.push({ key, enabled: Boolean(enabled) });
  };

  if (source.length === 0 && legacyTemplate) {
    for (const match of String(legacyTemplate).matchAll(/\{(\w+)\}/g)) {
      add(match[1] === 'title' ? 'subject' : match[1], true);
    }
  } else {
    for (const field of source) {
      if (!field || typeof field !== 'object') continue;
      add(field.key === 'title' ? 'subject' : field.key, field.enabled);
    }
  }

  for (const key of DEFAULT_FIELD_ORDER) {
    add(key, key === 'date' || key === 'subject');
  }
  return normalized;
}

function formatSampleDate(format) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return String(format || 'YYYYMMDD')
    .replace(/YYYY/g, now.getFullYear())
    .replace(/MM/g, pad(now.getMonth() + 1))
    .replace(/DD/g, pad(now.getDate()))
    .replace(/HH/g, pad(now.getHours()))
    .replace(/mm/g, pad(now.getMinutes()))
    .replace(/ss/g, pad(now.getSeconds()));
}

function getNamingPreview() {
  const separator =
    elements.separator?.value || settings.separator || '_';
  const dateFormat =
    elements.dateFormat?.value || settings.dateFormat;
  const values = Object.fromEntries(
    Object.entries(NAMING_FIELD_META).map(([key, field]) => [key, field.sample])
  );
  values.date = formatSampleDate(dateFormat);
  const parts = namingFields
    .filter((field) => field.enabled)
    .map((field) => values[field.key])
    .filter(Boolean);
  return parts.length > 0 ? `${parts.join(separator)}.jpg` : '请至少点亮一个字段';
}

function updateNamingPreview() {
  elements.namingPreview.textContent = getNamingPreview();
}

function renderNamingFields() {
  elements.namingFieldList.innerHTML = namingFields
    .map((field) => {
      const meta = NAMING_FIELD_META[field.key];
      return `
        <div
          class="naming-field ${field.enabled ? 'enabled' : ''}"
          data-field-key="${field.key}"
          draggable="true"
          role="button"
          tabindex="0"
          aria-pressed="${field.enabled}"
          title="${escapeHtml(meta.description)}"
        >
          <span class="field-grip">⠿</span>
          <span class="field-name">${escapeHtml(meta.label)}</span>
          <span class="field-toggle">${field.enabled ? '✓' : '+'}</span>
        </div>
      `;
    })
    .join('');
  updateNamingPreview();
}

function toggleNamingField(key) {
  const field = namingFields.find((candidate) => candidate.key === key);
  if (!field) return;
  field.enabled = !field.enabled;
  renderNamingFields();
}

function moveNamingField(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const from = namingFields.findIndex((field) => field.key === sourceKey);
  const to = namingFields.findIndex((field) => field.key === targetKey);
  if (from < 0 || to < 0) return;
  const [moved] = namingFields.splice(from, 1);
  const targetIndex = namingFields.findIndex((field) => field.key === targetKey);
  namingFields.splice(from < to ? targetIndex + 1 : targetIndex, 0, moved);
  renderNamingFields();
}

function resetFieldOrder() {
  const enabledByKey = new Map(
    namingFields.map((field) => [field.key, field.enabled])
  );
  namingFields = DEFAULT_FIELD_ORDER.map((key) => ({
    key,
    enabled: enabledByKey.get(key) || false,
  }));
  renderNamingFields();
}

function openSettings() {
  fillSettingsForm();
  elements.settingsMessage.textContent = '';
  elements.settingsDrawer.classList.add('open');
  elements.settingsDrawer.setAttribute('aria-hidden', 'false');
  elements.drawerBackdrop.classList.add('open');
}

function closeSettings() {
  elements.settingsDrawer.classList.remove('open');
  elements.settingsDrawer.setAttribute('aria-hidden', 'true');
  elements.drawerBackdrop.classList.remove('open');
}

function statusLabel(file) {
  if (file.error) return '读取失败';
  if (file.analysisError) return '分析失败';
  if (file.alreadyApplied) return '已应用';
  if (file.suggestedBase) return '已生成建议';
  if (file.stage === 'cached') return '复用分析结果';
  if (file.stage === 'extracting') return '正在提取画面';
  if (file.stage === 'analyzing') return '正在分析';
  return '等待分析';
}

function renderFiles() {
  elements.fileList.innerHTML = '';
  const canAnalyze = files.length > 0 && !analyzing;
  const canApply =
    files.some((file) => file.suggestedBase && !file.alreadyApplied) &&
    !analyzing;
  elements.analyzeButton.disabled = !canAnalyze;
  elements.applyButton.disabled = !canApply;
  elements.clearButton.hidden = files.length === 0 || analyzing;
  elements.undoButton.hidden = !latestUndoAvailable;
  elements.fileList.hidden = files.length === 0;

  const readyCount = files.filter((file) => file.suggestedBase).length;
  elements.queueSummary.textContent = files.length
    ? `${files.length} 个文件 · ${readyCount} 个已生成命名建议`
    : '还没有添加文件';

  for (const file of files) {
    const row = document.createElement('article');
    row.className = 'file-row';
    const thumbnail = file.thumbnail
      ? `<img class="thumb" src="${file.thumbnail}" alt="" />`
      : `<div class="thumb placeholder">${escapeHtml(
          file.kind === 'video' ? 'VIDEO' : 'MEDIA'
        )}</div>`;
    const resultName = file.suggestedBase || '';
    const error = file.error || file.analysisError || '';
    const detail = [
      file.kind === 'video' ? '视频' : '图片',
      file.resolution,
      formatBytes(file.size),
      statusLabel(file),
    ]
      .filter(Boolean)
      .join(' · ');

    row.innerHTML = `
      ${thumbnail}
      <div class="file-original">
        <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
      <div class="file-result">
        <label>新文件名</label>
        <div class="name-field">
          <input
            data-name-id="${escapeHtml(file.id)}"
            value="${escapeHtml(resultName)}"
            placeholder="${analyzing ? '模型分析中…' : '等待生成'}"
            ${!file.suggestedBase || analyzing ? 'disabled' : ''}
          />
          <span>${escapeHtml(file.extension || '')}</span>
        </div>
        ${
          error
            ? `<p class="file-message error">${escapeHtml(error)}</p>`
            : file.metadata?.description
              ? `<p class="file-message">${escapeHtml(
                  file.metadata.description
                )}</p>`
              : ''
        }
      </div>
      <button class="delete-button" data-delete-id="${escapeHtml(
        file.id
      )}" title="移除">×</button>
    `;

    elements.fileList.appendChild(row);
  }
}

async function addPaths(paths) {
  const supported = paths.filter(Boolean);
  if (supported.length === 0) return;
  const existing = new Set(files.map((file) => file.path));
  const newPaths = supported.filter((filePath) => !existing.has(filePath));
  if (newPaths.length === 0) return;
  setModelState('working', '正在读取素材', '生成预览并读取媒体信息');
  try {
    const prepared = await api.prepareFiles(newPaths);
    files.push(...prepared);
    renderFiles();
    const failed = prepared.filter((file) => file.error);
    showToast(
      failed.length > 0
        ? `已添加 ${prepared.length - failed.length} 个，${failed.length} 个失败`
        : `已添加 ${prepared.length} 个素材`
    );
  } catch (error) {
    showToast(error.message || '添加文件失败');
  } finally {
    const status = await api.getModelStatus();
    applyModelStatus(status);
  }
}

async function chooseFiles() {
  if (analyzing) return;
  const paths = await api.chooseFiles();
  await addPaths(paths);
}

async function analyzeAll() {
  if (analyzing || files.length === 0) return;
  analyzing = true;
  files = files.map((file) => ({
    ...file,
    stage: '',
    analysisError: '',
  }));
  renderFiles();
  elements.analyzeButton.innerHTML = '<span class="spin"></span>分析中';
  setModelState('working', '正在分析素材', '首次启动模型可能需要几十秒');
  closeSettings();

  try {
    const results = await api.analyzeFiles(files, readSettingsForm());
    for (const result of results) {
      const file = files.find((candidate) => candidate.id === result.id);
      if (!file) continue;
      if (result.success) {
        file.suggestedBase = result.suggestedBase;
        file.metadata = result.metadata;
        file.raw = result.raw;
        file.analysisSignature = result.analysisSignature;
      } else {
        file.analysisError = result.error;
      }
    }
    setModelState('ready', '分析完成', '请检查新文件名后再应用');
    showToast('命名建议已生成');
  } catch (error) {
    showToast(error.message || '分析失败');
    setModelState('', '模型调用失败', error.message || '请检查设置');
  } finally {
    analyzing = false;
    elements.analyzeButton.textContent = '重新分析';
    renderFiles();
  }
}

async function applyNames() {
  const items = files
    .filter((file) => file.suggestedBase && !file.alreadyApplied)
    .map((file) => ({
      path: file.path,
      baseName: file.suggestedBase,
    }));
  if (items.length === 0) return;
  elements.applyButton.disabled = true;
  try {
    const results = await api.applyRenames(items);
    let renamed = 0;
    for (const result of results) {
      if (!result.success) continue;
      const file = files.find((candidate) => candidate.path === result.originalPath);
      if (!file) continue;
      file.path = result.newPath;
      file.name =
        result.newName || result.newPath.split(/[\\/]/).pop();
      file.alreadyApplied = true;
      renamed += result.skipped ? 0 : 1;
    }
    latestUndoAvailable = renamed > 0;
    showToast(renamed > 0 ? `已重命名 ${renamed} 个文件` : '文件名没有变化');
    renderFiles();
  } catch (error) {
    showToast(error.message || '重命名失败');
  } finally {
    elements.applyButton.disabled = false;
  }
}

async function undoLastRename() {
  try {
    const results = await api.undoLastRename();
    const restored = results.filter((item) => item.success).length;
    latestUndoAvailable = false;
    showToast(`已恢复 ${restored} 个文件名`);
    for (const result of results) {
      if (!result.success) continue;
      const file = files.find((candidate) => candidate.path === result.originalPath);
      if (file) {
        file.path = result.newPath;
        file.name =
          result.newName || result.newPath.split(/[\\/]/).pop();
      }
    }
    renderFiles();
  } catch (error) {
    showToast(error.message || '撤销失败');
  }
}

async function checkModel() {
  if (!modelInstalled) {
    await downloadModel();
    return;
  }
  elements.checkModelButton.disabled = true;
  setModelState('working', '正在连接模型', '加载 GGUF 可能需要几十秒');
  try {
    const status = await api.checkModel(readSettingsForm());
    applyModelStatus(status);
  } catch (error) {
    setModelState('', '模型连接失败', error.message || '请检查模型路径');
    showToast(error.message || '模型连接失败');
  } finally {
    elements.checkModelButton.disabled = false;
  }
}

async function downloadModel() {
  if (modelDownloading) return;
  modelDownloading = true;
  elements.checkModelButton.disabled = true;
  elements.checkModelButton.hidden = false;
  setModelAction('download', '准备下载…');
  setModelState('working', '正在准备下载', '下载约需数分钟，支持断点续传');
  elements.modelProgress.hidden = false;
  elements.modelProgressBar.style.width = '0%';
  try {
    const result = await api.downloadModel(readSettingsForm());
    settings = result.settings || (await api.getSettings());
    modelInstalled = true;
    fillSettingsForm();
    elements.modelProgressBar.style.width = '100%';
    setModelState('ready', '本地模型已就绪', result.message);
    setModelAction('check', '检查');
    showToast('本地模型已安装并启动');
  } catch (error) {
    setModelState('', '模型下载未完成', error.message || '请检查网络后重试');
    setModelAction('download', '继续下载');
    showToast(error.message || '模型下载失败');
  } finally {
    modelDownloading = false;
    elements.checkModelButton.disabled = false;
    setTimeout(() => {
      if (!modelDownloading) elements.modelProgress.hidden = true;
    }, 2500);
  }
}

async function saveSettings() {
  try {
    settings = await api.saveSettings(readSettingsForm());
    const previewable = files.filter(
      (file) => file.metadata && !file.alreadyApplied
    );
    if (previewable.length > 0) {
      const previews = await api.previewNames(previewable, settings);
      for (const preview of previews) {
        const file = files.find((candidate) => candidate.id === preview.id);
        if (file) file.suggestedBase = preview.suggestedBase;
      }
      renderFiles();
    }
    fillSettingsForm();
    elements.settingsMessage.textContent = '设置已保存';
    showToast('设置已保存');
  } catch (error) {
    elements.settingsMessage.textContent = error.message || '保存失败';
  }
}

async function browsePath(button) {
  const field = document.querySelector(`#${button.dataset.browse}`);
  if (!field) return;
  const path = await api.choosePath('file');
  if (path) field.value = path;
}

function attachEvents() {
  elements.addButton.addEventListener('click', chooseFiles);
  elements.dropAddButton.addEventListener('click', chooseFiles);
  elements.fileInput.addEventListener('change', async () => {
    const paths = [...elements.fileInput.files]
      .map((file) => api.getPathForFile(file))
      .filter(Boolean);
    elements.fileInput.value = '';
    await addPaths(paths);
  });

  for (const eventName of ['dragenter', 'dragover']) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      elements.dropZone.classList.add('dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      elements.dropZone.classList.remove('dragging');
    });
  }
  elements.dropZone.addEventListener('drop', async (event) => {
    const paths = [...event.dataTransfer.files]
      .map((file) => api.getPathForFile(file))
      .filter(Boolean);
    await addPaths(paths);
  });

  elements.analyzeButton.addEventListener('click', analyzeAll);
  elements.applyButton.addEventListener('click', applyNames);
  elements.undoButton.addEventListener('click', undoLastRename);
  elements.settingsButton.addEventListener('click', openSettings);
  elements.closeSettingsButton.addEventListener('click', closeSettings);
  elements.drawerBackdrop.addEventListener('click', closeSettings);
  elements.saveSettingsButton.addEventListener('click', saveSettings);
  elements.checkModelButton.addEventListener('click', checkModel);
  elements.provider.addEventListener('change', () => {
    elements.managedSettings.hidden =
      elements.provider.value !== 'managed';
    elements.openAiSettings.hidden =
      elements.provider.value !== 'openai';
  });
  elements.namingFieldList.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-field-key]');
    if (chip) toggleNamingField(chip.dataset.fieldKey);
  });
  elements.namingFieldList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const chip = event.target.closest('[data-field-key]');
    if (!chip) return;
    event.preventDefault();
    toggleNamingField(chip.dataset.fieldKey);
  });
  elements.namingFieldList.addEventListener('dragstart', (event) => {
    const chip = event.target.closest('[data-field-key]');
    if (!chip) return;
    draggedFieldKey = chip.dataset.fieldKey;
    chip.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedFieldKey);
  });
  elements.namingFieldList.addEventListener('dragend', () => {
    draggedFieldKey = '';
    elements.namingFieldList
      .querySelectorAll('.naming-field')
      .forEach((chip) => chip.classList.remove('dragging', 'drop-target'));
  });
  elements.namingFieldList.addEventListener('dragover', (event) => {
    const chip = event.target.closest('[data-field-key]');
    if (!chip || !draggedFieldKey) return;
    event.preventDefault();
    elements.namingFieldList
      .querySelectorAll('.naming-field')
      .forEach((item) => item.classList.remove('drop-target'));
    if (chip.dataset.fieldKey !== draggedFieldKey) {
      chip.classList.add('drop-target');
    }
  });
  elements.namingFieldList.addEventListener('drop', (event) => {
    const chip = event.target.closest('[data-field-key]');
    if (!chip) return;
    event.preventDefault();
    moveNamingField(draggedFieldKey, chip.dataset.fieldKey);
    draggedFieldKey = '';
  });
  elements.resetFieldOrderButton.addEventListener('click', resetFieldOrder);
  elements.dateFormat.addEventListener('input', updateNamingPreview);
  elements.separator.addEventListener('change', updateNamingPreview);
  elements.clearButton.addEventListener('click', () => {
    files = [];
    renderFiles();
  });

  elements.fileList.addEventListener('input', (event) => {
    const id = event.target.dataset.nameId;
    if (!id) return;
    const file = files.find((candidate) => candidate.id === id);
    if (file) {
      file.suggestedBase = event.target.value;
      file.alreadyApplied = false;
      elements.applyButton.disabled =
        !files.some(
          (candidate) => candidate.suggestedBase && !candidate.alreadyApplied
        ) || analyzing;
    }
  });
  elements.fileList.addEventListener('click', (event) => {
    const deleteId = event.target.dataset.deleteId;
    if (deleteId) {
      files = files.filter((file) => file.id !== deleteId);
      renderFiles();
    }
  });

  document.addEventListener('click', (event) => {
    const browseButton = event.target.closest('[data-browse]');
    if (browseButton) browsePath(browseButton);
  });

  api.onAnalysisProgress((progress) => {
    const file = files.find((candidate) => candidate.id === progress.file.id);
    if (!file) return;
    file.stage = progress.stage;
    renderFiles();
  });

  api.onModelStatus((status) => {
    if (status.state === 'ready') {
      setModelState(
        'ready',
        '本地模型已就绪',
        status.message || '可以开始分析素材'
      );
    }
  });

  api.onModelDownloadProgress((progress) => {
    if (!modelDownloading) return;
    const overallPercent =
      progress.overallTotal > 0
        ? Math.min(
            100,
            Math.round(
              (progress.overallBytes / progress.overallTotal) * 100
            )
          )
        : progress.percent || 0;
    elements.modelProgress.hidden = false;
    elements.modelProgressBar.style.width = `${overallPercent}%`;
    setModelState(
      'working',
      `正在下载本地模型 ${overallPercent}%`,
      `${progress.label} · ${formatBytes(progress.overallBytes)} / ${formatBytes(
        progress.overallTotal
      )}`
    );
    elements.checkModelButton.textContent =
      overallPercent >= 100 ? '安装中…' : `下载中 ${overallPercent}%`;
  });
}

async function init() {
  settings = await api.getSettings();
  fillSettingsForm();
  attachEvents();
  renderFiles();
  const status = await api.getModelStatus();
  applyModelStatus(status);
}

init().catch((error) => {
  setModelState('', '应用初始化失败', error.message);
  showToast(error.message || '应用初始化失败');
});
