# Media Renamer

一个本地优先、可自定义的图片/视频内容重命名工具。首版使用 Electron，
当前在 macOS 上测试，后续可沿用同一套 Node.js 核心逻辑打包 Windows 版本。

应用图标与应用内左上角 Logo 统一使用 `build/icon.svg` 生成的黑底大写 M。

## 首版功能

- 拖入图片或视频，支持常见 JPG、PNG、HEIC、WebP、MP4、MOV、MKV 等格式。
- 调用本地 `llama-server` 视觉模型，不上传媒体。
- 视频只抽取并复用一个代表性画面，配合快速缩放和硬件解码降低分析耗时。
- 视觉输入限制在每帧最多 256 tokens，同时关闭思考模式并缩短输出。
- 可视化配置文件名字段：点击启用/停用，拖拽调整前后顺序。
- 支持日期、主体、分辨率、宽、高、文件大小、视频时长等字段。
- 先预览并手动修改，再批量应用新文件名。
- 自动避免同名覆盖，并保留最近一次重命名记录用于撤销。
- 支持已安装的 Qwen GGUF 视觉模型，也可连接其他 OpenAI 兼容本地服务。
- 图片压缩到适合视觉模型识别的尺寸，并并行分析队列中的文件。
- “视频时长”字段只对视频生效，图片会自动跳过该字段。
- 应用启动后在后台预加载模型，并持久化内容分析缓存；相同文件再次分析可快速复用。
- 本机没有模型时，右上角自动显示“一键下载模型”，自动安装运行时、视觉模型和视觉投影文件。

## 开发运行

```bash
cd /Users/davyzhang/Documents/media-renamer
npm install
npm test
npm start
```

应用会自动检测当前电脑上 RenamerX 下载的 Qwen3.5 4B 模型和
`llama-server`。也可以在“设置”中改成任意兼容文件路径。

如果没有检测到任何本地模型，应用会显示一键下载按钮。下载约 3.2 GB，
支持断点续传；安装完成后会自动写入模型路径并启动，无需手动配置。

## 命名字段

设置中使用可视化字段列表：

- 点亮字段表示加入文件名，再次点击取消。
- 拖拽字段可以调整前后顺序。
- 设置窗口会实时显示文件名预览。
- 保存设置后会刷新已经分析素材的命名建议，无需重新调用模型。

- `{date}`：媒体创建日期
- `{time}`：创建时间
- `{subject}`：模型生成的主体/简短标题
- `{resolution}`：分辨率，例如 `1600x1067`
- `{width}`：像素宽度
- `{height}`：像素高度
- `{size}`：文件大小，例如 `2.5MB`
- `{duration}`：视频时长，例如 `1m32s`
- `{type}`：photo/video/screenshot/illustration
- `{location}`：模型能判断出的地点
- `{original}`：原文件名
- `{index}`：本批次序号

扩展名会自动保留，不需要写进模板。

## 本地模型

默认配置会寻找：

```text
~/Library/Caches/com.sancijun.renamerx/resources/llama-b10809-bin-macos-arm64/llama-b10809/llama-server
~/Library/Caches/com.sancijun.renamerx/resources/qwen3_5-4b-q4km-v1/Qwen3.5-4B-Q4_K_M.gguf
~/Library/Caches/com.sancijun.renamerx/resources/qwen3_5-4b-q4km-v1-mmproj/mmproj-F16.gguf
```

应用调用模型时只用本机 `127.0.0.1`。若切换到 OpenAI 兼容地址，请自行确认
该服务是否联网以及它的数据隐私政策。

## 打包

```bash
npm run pack:mac
```

生成未安装的 macOS 应用目录；执行 `npm run dist:mac` 可生成 DMG/ZIP。

## GitHub 自动发布

仓库包含 `.github/workflows/release.yml`。推送 `v*` 标签后，GitHub Actions
会分别构建 Apple Silicon 和 Intel Mac 安装包，并创建 GitHub Release：

```bash
git tag v0.4.0
git push origin v0.4.0
```

当前自动发布仅覆盖 macOS。Windows 需要完成 FFmpeg 自动安装、Windows
路径验证和实际安装测试后再加入发布矩阵。

## 后续计划

- 监听文件夹与自动处理
- 受控词表和品牌/项目词库
- 批量并发与失败重试
- 自定义文件夹分类树
- Windows 打包和 FFmpeg 自动配置
- 模型资源管理界面
