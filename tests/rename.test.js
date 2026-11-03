const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildAvailablePath,
  buildTemplateFromFields,
  defaultNamingFields,
  formatDate,
  normalizeNamingFields,
  parseModelJson,
  renderFilename,
  sanitizeFilenamePart,
} = require('../electron/rename');

test('sanitizeFilenamePart removes cross-platform invalid characters', () => {
  assert.equal(
    sanitizeFilenamePart('  紫金山/湖畔:日落?.jpg  '),
    '紫金山 湖畔 日落 .jpg'
  );
});

test('formatDate supports the documented tokens', () => {
  const date = new Date(2026, 10, 3, 14, 5, 9);
  assert.equal(formatDate(date, 'YYYYMMDD_HHmmss'), '20261103_140509');
});

test('renderFilename substitutes metadata and separator tokens', () => {
  const value = renderFilename({
    template: '{date}{sep}{location}{sep}{title}',
    separator: '_',
    dateFormat: 'YYYYMMDD',
    originalName: 'IMG_0001.jpg',
    date: new Date(2026, 10, 3),
    metadata: { location: '紫金山', title: '湖畔日落' },
  });
  assert.equal(value, '20261103_紫金山_湖畔日落');
});

test('renderFilename supports dimensions, size and duration fields', () => {
  const value = renderFilename({
    template: '{subject}{sep}{resolution}{sep}{size}{sep}{duration}',
    separator: '_',
    originalName: 'clip.mov',
    date: new Date(2026, 10, 3),
    metadata: {
      title: '庭院聚会',
      width: 1920,
      height: 1080,
      size: 5 * 1024 * 1024,
      duration: 92,
      mediaKind: 'video',
    },
  });
  assert.equal(value, '庭院聚会_1920x1080_5.0MB_1m32s');
});

test('duration is omitted from image filenames and empty separators collapse', () => {
  const value = renderFilename({
    template: '{subject}{sep}{duration}{sep}{resolution}',
    separator: '_',
    originalName: 'photo.jpg',
    date: new Date(2026, 10, 3),
    metadata: {
      title: '庭院',
      width: 1600,
      height: 1067,
      mediaKind: 'image',
      duration: 10,
    },
  });
  assert.equal(value, '庭院_1600x1067');
});

test('naming fields preserve order and toggle state', () => {
  const fields = normalizeNamingFields([
    { key: 'subject', enabled: true },
    { key: 'resolution', enabled: true },
    { key: 'date', enabled: false },
  ]);
  assert.deepEqual(fields.slice(0, 3), [
    { key: 'subject', enabled: true },
    { key: 'resolution', enabled: true },
    { key: 'date', enabled: false },
  ]);
  assert.equal(
    buildTemplateFromFields(fields),
    '{subject}{sep}{resolution}'
  );
});

test('naming fields migrate the old title token to subject', () => {
  const fields = normalizeNamingFields([], '{date}{sep}{title}');
  assert.equal(fields[0].key, 'date');
  assert.equal(fields[0].enabled, true);
  assert.equal(fields[1].key, 'subject');
  assert.equal(fields[1].enabled, true);
  assert.equal(defaultNamingFields().length, 12);
});

test('parseModelJson accepts fenced JSON and surrounding prose', () => {
  assert.deepEqual(
    parseModelJson('```json\n{"title":"湖畔日落"}\n```'),
    { title: '湖畔日落' }
  );
  assert.deepEqual(parseModelJson('结果如下：{"title":"秋日森林"}'), {
    title: '秋日森林',
  });
});

test('buildAvailablePath avoids files that already exist', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-renamer-'));
  const existing = path.join(directory, '图片.jpg');
  fs.writeFileSync(existing, '');
  assert.equal(
    buildAvailablePath(directory, '图片', '.jpg'),
    path.join(directory, '图片 (2).jpg')
  );
  fs.rmSync(directory, { recursive: true, force: true });
});
