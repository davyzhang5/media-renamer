const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  downloadFile,
  getInstallLayout,
  getRuntimeTarget,
  inspectModelInstallation,
} = require('../electron/modelInstaller');

test('runtime download target is defined for the current Mac', () => {
  const target = getRuntimeTarget('darwin', 'arm64');
  assert.match(target.url, /llama\.cpp\/releases\/download\/b10809/);
  assert.equal(target.executable, 'llama-server');
});

test('Windows x64 runtime target and installer size are configured', () => {
  const target = getRuntimeTarget('win32', 'x64');
  assert.match(target.url, /bin-win-vulkan-x64\.zip$/);
  assert.equal(target.executable, 'llama-server.exe');
  assert.equal(target.size, 35221385);
});

test('custom installed model paths are detected without manual probing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-install-'));
  const llama = path.join(directory, 'llama-server');
  const model = path.join(directory, 'model.gguf');
  const mmproj = path.join(directory, 'mmproj.gguf');
  for (const file of [llama, model, mmproj]) fs.writeFileSync(file, 'x');

  const result = inspectModelInstallation(directory, {
    llamaServerPath: llama,
    modelPath: model,
    mmprojPath: mmproj,
  });
  assert.equal(result.installed, true);
  assert.equal(result.modelPath, model);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('missing model installation reports one-click download metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-install-'));
  const result = inspectModelInstallation(directory, {});
  assert.equal(result.installed, false);
  assert.ok(result.estimatedBytes > 3 * 1024 * 1024 * 1024);
  assert.equal(result.runtimeSupported, true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('downloadFile supports resuming an existing partial file', async () => {
  const payload = Buffer.from('0123456789abcdef');
  const server = http.createServer((request, response) => {
    const range = request.headers.range;
    if (range) {
      const start = Number(range.match(/bytes=(\d+)-/)?.[1] || 0);
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
        'Content-Length': payload.length - start,
      });
      response.end(payload.subarray(start));
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
    });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-download-'));
  const destination = path.join(directory, 'model.gguf');
  fs.writeFileSync(`${destination}.part`, payload.subarray(0, 6));

  await downloadFile({
    url: `http://127.0.0.1:${port}/model.gguf`,
    destination,
    expectedSize: payload.length,
  });
  assert.deepEqual(fs.readFileSync(destination), payload);
  assert.equal(fs.existsSync(`${destination}.part`), false);

  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
