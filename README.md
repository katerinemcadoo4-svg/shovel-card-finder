# 铲牌识别

面向 iOS 17 及以上 Safari 的金铲铲之战角色识别网页应用。选择一张角色游戏图或原画，应用在设备上比对本地参考图，并展示角色、羁绊、技能、基础属性和带版本号的攻略。识别证据不足时显示“未确定”。这是一款可添加到主屏幕的 PWA，不是 IPA。

## 当前资料与使用边界

- 资料核对日期：2026-10-04，2026-10-05 再次确认官方当前版本未变；赛季：S19「自然之力」；游戏版本：18.18.3。`data/season.json` 收录 65 名角色，每名均有费用、羁绊、技能和基础属性。64 名有阵容建议，49 名有对应装备建议；没有来源支撑的建议保持空白。
- 赛季、角色、羁绊、装备和阵容来自金铲铲之战官方数据。每个来源的网址与核对日期保存在 `data/season.json`，角色详情中也可查看出处。它们是当日快照；更新前要重新核对官方当前赛季和补丁。
- 公开站点只分发文字资料、应用图标和识别程序。官方角色图片的公开再分发许可未经确认，因此角色参考图不在仓库或网站中。用户需在设备上导入个人素材 ZIP，才能识别图片。ZIP 只保存在浏览器的 IndexedDB，待识别图片也只在本机处理。
- OpenCV.js 4.8.0 随站点提供。图像候选接近且已有较强视觉证据时，才在设备本地启动中文 OCR 辅助判断；OCR 失败、名字不唯一或证据弱时仍显示“未确定”。Tesseract.js 6.0.1、Core 6.0.0 和 `chi_sim` 模型也从站点同源加载，不上传图片。来源与许可见 `vendor/OPENCV-LICENSE.txt`、`vendor/OPENCV-NOTICE.txt` 和 `vendor/tesseract/NOTICE.md`。

## 本地运行

需要 Node.js 20 或更新版本，无需安装 npm 依赖。

```powershell
npm test
npm run build
npm run preview
```

预览地址为 `http://127.0.0.1:8765/shovel-card-finder/`。预览服务模拟 GitHub Pages 的仓库子路径；为了方便开发，应用在 localhost 会注销 Service Worker。离线与主屏幕安装应在正式 HTTPS 地址和 iPhone Safari 上测试。

个人参考图 ZIP 的生成和导入步骤见 `scripts/PERSONAL_PACK.md`。生成物必须留在 `local-packs/` 或工作区外，不能提交到公开仓库。即使没有 ZIP，图鉴中的已核对文字资料仍可浏览。

## GitHub Pages 部署

1. 建立**公开** GitHub 仓库，将本项目源文件推送到 `main`。提交前检查 `git status`，确认没有 `local-packs/`、角色原画、截图或个人 ZIP。`.gitignore` 会排除 `local-packs/` 和 `dist/`，构建脚本另用明确文件清单限制公开产物。
2. 在仓库的 **Settings → Pages → Build and deployment** 中，把 **Source** 设为 **GitHub Actions**。
3. 推送 `main` 后，`.github/workflows/pages.yml` 会运行测试、生成 `dist/` 并部署。完成后访问 `https://<用户名>.github.io/<仓库名>/`。`manifest.webmanifest`、资源和 Service Worker 均使用相对路径，可在仓库子路径运行。
4. 在 iPhone 的 Safari 打开上述 HTTPS 地址，点分享按钮，选“添加到主屏幕”，然后从主屏幕启动。把个人素材 ZIP 传到 iPhone 的“文件”中，再在应用“资料”页导入。

首次访问、安装及获取新版本需要联网。首次完整加载后，Service Worker 缓存应用代码、资料、OpenCV.js 和中文 OCR 资源，公开构建合计约 20 MB；参考图保存在设备的 IndexedDB。新版本下载完成后应用显示“立即更新”，用户点击后切换缓存并重载。iOS 可能回收长期未使用站点的本地存储，因此建议保留个人 ZIP 以便重新导入。GitHub Pages 不支持自定义 `_headers` 文件；更新依靠构建内容哈希和浏览器的 Service Worker 更新机制。

## 发布前验证

当前自动测试和构建验证了解析、ZIP 导入、局部特征定位、OCR 判定及缓存清单；浏览器烟雾测试使用素材包内头像、原画和一张非目标图。尚未用独立的真实游戏截图、独立原画和足量非目标图片做完整测评，也未在实体 iPhone 测速。**目前不宣称完整覆盖或达到识别率目标。**独立样本评测的格式、脚本和统计口径见 `README-evaluation.md`。

正式宣称识别效果前，应在目标 iPhone 上记录每类已收录图片的首选识别率（目标分别 ≥90%）、未知图片误判率（目标 <5%）和识别耗时；测试图不能复用素材 ZIP 中的参考图。还需实测卡面自动定位、ZIP 导入、Safari 添加到主屏幕、断网重启和版本更新。未达到目标时补充个人参考图并校准规则。

如发布后需要回滚，恢复上一版 `main` 提交并重新触发 Pages 工作流；Service Worker 会把该构建作为新缓存安装。个人 ZIP 不包含在仓库或部署产物中。
