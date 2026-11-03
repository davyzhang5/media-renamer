const fs = require('node:fs');
const path = require('node:path');

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
const RESERVED_WINDOWS_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const NAMING_FIELD_KEYS = [
  'date',
  'subject',
  'resolution',
  'width',
  'height',
  'size',
  'duration',
  'type',
  'location',
  'time',
  'original',
  'index',
];

const DEFAULT_ENABLED_FIELDS = new Set(['date', 'subject']);

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date, format = 'YYYYMMDD') {
  const parsed = date instanceof Date ? date : new Date(date);
  const value = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return format
    .replace(/YYYY/g, value.getFullYear())
    .replace(/MM/g, pad(value.getMonth() + 1))
    .replace(/DD/g, pad(value.getDate()))
    .replace(/HH/g, pad(value.getHours()))
    .replace(/mm/g, pad(value.getMinutes()))
    .replace(/ss/g, pad(value.getSeconds()));
}

function sanitizeFilenamePart(value, maxLength = 48) {
  let result = String(value || '')
    .normalize('NFKC')
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .trim();

  if (RESERVED_WINDOWS_NAMES.test(result)) result = `_${result}`;
  if (result.length > maxLength) result = result.slice(0, maxLength).trim();
  return result || '未命名';
}

function cleanModelText(value) {
  return String(value || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function parseModelJson(raw) {
  const text = cleanModelText(raw);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('模型没有返回有效的 JSON');
  }
}

function defaultNamingFields() {
  return NAMING_FIELD_KEYS.map((key) => ({
    key,
    enabled: DEFAULT_ENABLED_FIELDS.has(key),
  }));
}

function normalizeNamingFields(input, legacyTemplate = '') {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const result = [];

  const addField = (key, enabled) => {
    if (!NAMING_FIELD_KEYS.includes(key) || seen.has(key)) return;
    seen.add(key);
    result.push({ key, enabled: Boolean(enabled) });
  };

  if (source.length === 0 && legacyTemplate) {
    const tokens = [...String(legacyTemplate).matchAll(/\{(\w+)\}/g)].map(
      (match) => (match[1] === 'title' ? 'subject' : match[1])
    );
    for (const token of tokens) addField(token, true);
    if (result.length === 0) {
      for (const field of defaultNamingFields()) addField(field.key, field.enabled);
    }
  } else {
    for (const field of source) {
      if (!field || typeof field !== 'object') continue;
      const key = field.key === 'title' ? 'subject' : field.key;
      addField(key, field.enabled);
    }
  }

  for (const field of defaultNamingFields()) {
    addField(field.key, field.enabled);
  }
  return result;
}

function buildTemplateFromFields(fields) {
  const enabled = normalizeNamingFields(fields).filter(
    (field) => field.enabled
  );
  if (enabled.length === 0) return '';
  return enabled.map((field) => `{${field.key}}`).join('{sep}');
}

function formatFileSizeForName(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)}MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function formatDurationForName(seconds) {
  const value = Number(seconds) || 0;
  if (value <= 0) return '';
  const whole = Math.round(value);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainingSeconds = whole % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m${remainingSeconds}s`;
  }
  if (minutes > 0) return `${minutes}m${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function renderFilename({
  template,
  separator = '_',
  dateFormat = 'YYYYMMDD',
  originalName,
  date,
  index = 1,
  metadata = {},
  language = 'zh',
  titleLength = 24,
}) {
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  const requestDate = date || new Date();
  const values = {
    date: formatDate(requestDate, dateFormat),
    subject: sanitizeFilenamePart(metadata.title, titleLength),
    title: sanitizeFilenamePart(metadata.title, titleLength),
    width: width > 0 ? String(width) : '',
    height: height > 0 ? String(height) : '',
    resolution:
      width > 0 && height > 0
        ? sanitizeFilenamePart(metadata.resolution || `${width}x${height}`, 24)
        : '',
    size: formatFileSizeForName(metadata.size),
    duration:
      metadata.mediaKind === 'video'
        ? formatDurationForName(metadata.duration)
        : '',
    type: sanitizeFilenamePart(metadata.type, 24),
    location: sanitizeFilenamePart(metadata.location, 24),
    time: formatDate(requestDate, 'HHmmss'),
    original: sanitizeFilenamePart(
      path.basename(originalName || '', path.extname(originalName || '')),
      36
    ),
    index: String(index).padStart(3, '0'),
    lang: language,
  };

  let rendered = String(template || '{date}{sep}{title}');
  rendered = rendered.replace(/\{(\w+)\}/g, (match, key) => {
    if (key === 'sep') return separator;
    return Object.hasOwn(values, key) ? values[key] : match;
  });

  const collapsedSeparator = new RegExp(
    `(?:\\s*${separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*){2,}`,
    'g'
  );
  rendered = rendered
    .replace(collapsedSeparator, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitizeFilenamePart(rendered, 120);
}

function buildAvailablePath(directory, base, extension, reservedPaths = new Set()) {
  let candidate = path.join(directory, `${base}${extension}`);
  let counter = 2;
  while (fs.existsSync(candidate) || reservedPaths.has(candidate)) {
    candidate = path.join(directory, `${base} (${counter})${extension}`);
    counter += 1;
  }
  reservedPaths.add(candidate);
  return candidate;
}

function applyRenames(items, journalPath) {
  const reservedPaths = new Set();
  const results = [];

  for (const item of items) {
    const sourcePath = path.resolve(item.path);
    const directory = path.dirname(sourcePath);
    const extension = path.extname(sourcePath);
    const base = sanitizeFilenamePart(item.baseName, 120);
    const targetPath = buildAvailablePath(
      directory,
      base,
      extension,
      reservedPaths
    );

    if (sourcePath === targetPath) {
      results.push({
        success: true,
        skipped: true,
        originalPath: sourcePath,
        newPath: sourcePath,
        newName: path.basename(sourcePath),
      });
      continue;
    }

    try {
      fs.renameSync(sourcePath, targetPath);
      results.push({
        success: true,
        skipped: false,
        originalPath: sourcePath,
        newPath: targetPath,
        newName: path.basename(targetPath),
      });
    } catch (error) {
      results.push({
        success: false,
        originalPath: sourcePath,
        error: error.message,
      });
    }
  }

  if (journalPath) {
    const successful = results.filter((item) => item.success && !item.skipped);
    if (successful.length > 0) {
      fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      fs.writeFileSync(
        journalPath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            items: successful,
          },
          null,
          2
        )
      );
    }
  }

  return results;
}

module.exports = {
  applyRenames,
  buildTemplateFromFields,
  buildAvailablePath,
  defaultNamingFields,
  formatDate,
  formatDurationForName,
  formatFileSizeForName,
  NAMING_FIELD_KEYS,
  normalizeNamingFields,
  parseModelJson,
  renderFilename,
  sanitizeFilenamePart,
};
