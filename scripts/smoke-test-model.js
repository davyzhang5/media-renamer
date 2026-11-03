const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  analyzeMedia,
  startManagedServer,
  stopManagedServer,
} = require('../electron/model');

const renamerResources = path.join(
  os.homedir(),
  'Library',
  'Caches',
  'com.sancijun.renamerx',
  'resources'
);

const settings = {
  provider: 'managed',
  managedPort: Number(process.env.MEDIA_RENAMER_TEST_PORT) || 19080,
  contextSize: 4096,
  language: 'zh',
  titleLength: 24,
  customPrompt: '',
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
};

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error('请传入一张图片路径');
  }

  await startManagedServer(settings);
  try {
    const image = fs.readFileSync(imagePath);
    const result = await analyzeMedia(settings, {
      kind: 'image',
      images: [`data:image/jpeg;base64,${image.toString('base64')}`],
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopManagedServer();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
