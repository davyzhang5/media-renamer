const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { nativeImage } = require('electron');

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.gif',
  '.tif',
  '.tiff',
  '.bmp',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.3gp',
  '.mts',
  '.m2ts',
]);

function getMediaKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function isSupportedMedia(filePath) {
  return getMediaKind(filePath) !== null;
}

const ANALYSIS_IMAGE_WIDTH = 768;
const VIDEO_FRAME_WIDTH = 640;
const videoFrameCache = new Map();

function imageToJpegBuffer(filePath, maxWidth = 1200, quality = 80) {
  const image = nativeImage.createFromPath(filePath);
  if (!image.isEmpty()) {
    const size = image.getSize();
    const resized =
      size.width > maxWidth
        ? image.resize({ width: maxWidth, quality: 'good' })
        : image;
    return resized.toJPEG(quality);
  }
  return null;
}

function inferFfprobePath(ffmpegPath) {
  if (!ffmpegPath) return '';
  const basename = path.basename(ffmpegPath).toLowerCase();
  if (!basename.startsWith('ffmpeg')) return '';
  const suffix = basename.slice('ffmpeg'.length);
  return path.join(path.dirname(ffmpegPath), `ffprobe${suffix}`);
}

function resolveFfprobe(settings) {
  if (settings.ffprobePath && fs.existsSync(settings.ffprobePath)) {
    return settings.ffprobePath;
  }
  const inferred = inferFfprobePath(settings.ffmpegPath);
  if (inferred && fs.existsSync(inferred)) return inferred;
  return settings.ffprobePath || inferred;
}

async function getVideoInfo(filePath, settings) {
  const ffprobePath = resolveFfprobe(settings);
  if (!ffprobePath) return { duration: 0, width: 0, height: 0 };
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=width,height,duration:format=duration',
        '-select_streams',
        'v:0',
        '-of',
        'json',
        filePath,
      ],
      { maxBuffer: 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    const stream = data?.streams?.[0] || {};
    return {
      duration:
        Number.parseFloat(stream.duration) ||
        Number.parseFloat(data?.format?.duration) ||
        0,
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
    };
  } catch {
    return { duration: 0, width: 0, height: 0 };
  }
}

async function extractVideoFrame(filePath, outputPath, seconds, settings) {
  if (!settings.ffmpegPath) {
    throw new Error('未配置 FFmpeg，无法读取视频画面');
  }
  await execFileAsync(
    settings.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-hwaccel',
      'auto',
      '-skip_frame',
      'nokey',
      '-ss',
      Math.max(0, seconds).toFixed(3),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=min(${VIDEO_FRAME_WIDTH}\\,iw):-2:flags=fast_bilinear`,
      '-q:v',
      '4',
      '-y',
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 * 8 }
  );
}

async function getRepresentativeVideoFrame(
  filePath,
  settings,
  tempDir,
  knownDuration = 0
) {
  const stat = await fs.promises.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  if (videoFrameCache.has(cacheKey)) {
    return videoFrameCache.get(cacheKey);
  }

  fs.mkdirSync(tempDir, { recursive: true });
  const duration =
    knownDuration > 0
      ? knownDuration
      : (await getVideoInfo(filePath, settings)).duration;
  const seconds = duration > 4 ? Math.min(duration * 0.35, 8) : 0;
  const outputPath = path.join(
    tempDir,
    `frame-${Date.now()}-${process.pid}.jpg`
  );
  try {
    await extractVideoFrame(filePath, outputPath, seconds, settings);
    const frame = fs.readFileSync(outputPath);
    videoFrameCache.set(cacheKey, frame);
    while (videoFrameCache.size > 80) {
      videoFrameCache.delete(videoFrameCache.keys().next().value);
    }
    return frame;
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
}

async function createMediaPayload(
  filePath,
  settings,
  tempDir,
  knownDuration = 0
) {
  const kind = getMediaKind(filePath);
  if (!kind) throw new Error('不支持该文件类型');

  let buffers = [];
  if (kind === 'image') {
    const jpeg = imageToJpegBuffer(filePath, ANALYSIS_IMAGE_WIDTH, 78);
    if (jpeg) {
      buffers = [jpeg];
    } else {
      buffers = [
        await getRepresentativeVideoFrame(
          filePath,
          settings,
          tempDir,
          knownDuration
        ),
      ];
    }
  } else {
    buffers = [
      await getRepresentativeVideoFrame(
        filePath,
        settings,
        tempDir,
        knownDuration
      ),
    ];
  }

  if (buffers.length === 0) {
    throw new Error('无法从媒体文件中提取画面');
  }

  return {
    kind,
    images: buffers.map(
      (buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`
    ),
  };
}

async function createThumbnail(
  filePath,
  settings,
  tempDir,
  knownDuration = 0
) {
  const kind = getMediaKind(filePath);
  if (kind === 'image') {
    const jpeg = imageToJpegBuffer(filePath, 360, 78);
    if (jpeg) return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }

  if (kind === 'video') {
    const videoFrame = await getRepresentativeVideoFrame(
      filePath,
      settings,
      tempDir,
      knownDuration
    );
    const frame = nativeImage.createFromBuffer(videoFrame);
    if (!frame.isEmpty()) {
      const width = Math.min(frame.getSize().width, 360);
      return `data:image/jpeg;base64,${frame
        .resize({ width, quality: 'good' })
        .toJPEG(72)
        .toString('base64')}`;
    }
  }

  return null;
}

async function inspectFile(filePath, settings, tempDir) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('不是文件');
  const kind = getMediaKind(filePath);
  if (!kind) throw new Error('不支持的媒体格式');
  const extension = path.extname(filePath);
  const birthtime = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  let thumbnail = null;
  let width = 0;
  let height = 0;
  let duration = 0;
  if (kind === 'image') {
    try {
      const image = nativeImage.createFromPath(filePath);
      if (!image.isEmpty()) {
        const size = image.getSize();
        width = size.width;
        height = size.height;
      }
    } catch {
      // Fall through to ffprobe below.
    }
  }
  if (width === 0 || height === 0 || kind === 'video') {
    const info = await getVideoInfo(filePath, settings);
    width = width || info.width;
    height = height || info.height;
    duration = info.duration;
  }
  try {
    thumbnail = await createThumbnail(
      filePath,
      settings,
      tempDir,
      duration
    );
  } catch {
    thumbnail = null;
  }

  return {
    id: `${path.basename(filePath)}-${stat.size}-${stat.mtimeMs}`,
    path: filePath,
    name: path.basename(filePath),
    extension,
    baseName: path.basename(filePath, extension),
    kind,
    size: stat.size,
    width,
    height,
    resolution: width > 0 && height > 0 ? `${width}x${height}` : '',
    duration,
    mtime: stat.mtimeMs,
    date: new Date(birthtime),
    thumbnail,
  };
}

module.exports = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  createMediaPayload,
  getMediaKind,
  getVideoInfo,
  inspectFile,
  isSupportedMedia,
};
