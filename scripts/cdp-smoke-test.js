const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.CDP_PORT) || 9223;
const samplePaths = process.argv.slice(2);
const samplePath = samplePaths[0];

if (samplePaths.length === 0) {
  throw new Error('请传入用于测试的媒体路径');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
    (response) => response.json()
  );
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('没有找到应用页面');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(
        message.params?.exceptionDetails?.exception?.description ||
          message.params?.exceptionDetails?.text ||
          'Unknown exception'
      );
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  function send(method, params = {}, timeoutMs = 240000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      );
    }
    return result.result?.value;
  }

  return { socket, send, evaluate, exceptions };
}

async function main() {
  const cdp = await connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await wait(1000);
  const originalSettings = await cdp.evaluate(
    'window.mediaRenamer.getSettings()'
  );

  const state = await cdp.evaluate(`({
    title: document.title,
    readyState: document.readyState,
    apiReady: typeof window.mediaRenamer === 'object',
    heading: document.querySelector('h1')?.textContent,
    modelTitle: document.querySelector('#modelTitle')?.textContent,
    bodyTextLength: document.body.innerText.length
  })`);
  console.log('UI', JSON.stringify(state, null, 2));

  if (process.env.TEST_FIELD_CONFIG === '1') {
    const fieldInteraction = await cdp.evaluate(`(() => {
      document.querySelector('#settingsButton').click();
      const list = document.querySelector('#namingFieldList');
      const subject = list.querySelector('[data-field-key="subject"]');
      const date = list.querySelector('[data-field-key="date"]');
      const transfer = new DataTransfer();
      subject.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      date.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      date.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      list.querySelector('[data-field-key="resolution"]').click();
      list.querySelector('[data-field-key="date"]').click();
      const chips = [...list.querySelectorAll('[data-field-key]')];
      const result = {
        order: chips.map((chip) => chip.dataset.fieldKey),
        enabled: chips
          .filter((chip) => chip.classList.contains('enabled'))
          .map((chip) => chip.dataset.fieldKey),
        preview: document.querySelector('#namingPreview').textContent
      };
      document.querySelector('#saveSettingsButton').click();
      return result;
    })()`);
    await wait(800);
    const savedSettings = await cdp.evaluate(
      'window.mediaRenamer.getSettings()'
    );
    console.log(
      'FIELD_CONFIG',
      JSON.stringify(
        {
          interaction: fieldInteraction,
          savedFields: savedSettings.namingFields,
          template: savedSettings.namingTemplate,
        },
        null,
        2
      )
    );
  }

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  fs.writeFileSync(
    '/private/tmp/media-renamer-ui.png',
    Buffer.from(screenshot.data, 'base64')
  );

  const prepared = await cdp.evaluate(
    `window.mediaRenamer.prepareFiles(${JSON.stringify(samplePaths)})`
  );
  console.log(
    'PREPARED',
    JSON.stringify(
      prepared.map((file) => ({
        name: file.name,
        kind: file.kind,
        size: file.size,
        width: file.width,
        height: file.height,
        resolution: file.resolution,
        duration: file.duration,
        hasThumbnail: Boolean(file.thumbnail),
        error: file.error,
      })),
      null,
      2
    )
  );

  const analysis = await cdp.evaluate(`(async () => {
    const settings = await window.mediaRenamer.getSettings();
    return window.mediaRenamer.analyzeFiles(${JSON.stringify(prepared)}, settings);
  })()`);
  console.log('ANALYSIS', JSON.stringify(analysis, null, 2));

  const renameDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'media-renamer-cdp-')
  );
  const renameSource = path.join(renameDirectory, path.basename(samplePath));
  fs.copyFileSync(samplePath, renameSource);
  const renameResult = await cdp.evaluate(
    `window.mediaRenamer.applyRenames(${JSON.stringify([
      { path: renameSource, baseName: '自动测试_安全重命名' },
    ])})`
  );
  const renamedPath = renameResult[0]?.newPath;
  if (!renameResult[0]?.success || !fs.existsSync(renamedPath)) {
    throw new Error(`重命名测试失败：${JSON.stringify(renameResult)}`);
  }
  const undoResult = await cdp.evaluate(
    'window.mediaRenamer.undoLastRename()'
  );
  if (undoResult.some((item) => !item.success) || !fs.existsSync(renameSource)) {
    throw new Error(`撤销测试失败：${JSON.stringify(undoResult)}`);
  }
  console.log(
    'RENAME',
    JSON.stringify({ renamedPath, undoResult, restored: true }, null, 2)
  );
  fs.rmSync(renameDirectory, { recursive: true, force: true });

  if (cdp.exceptions.length > 0) {
    console.error('RENDERER_EXCEPTIONS', cdp.exceptions);
    process.exitCode = 1;
  }
  if (process.env.TEST_FIELD_CONFIG === '1') {
    await cdp.evaluate(
      `window.mediaRenamer.saveSettings(${JSON.stringify(originalSettings)})`
    );
  }
  cdp.socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
