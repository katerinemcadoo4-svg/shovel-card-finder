# 个人参考图 ZIP

这个脚本从金铲铲之战官方公开配置读取当前 S19 版本，并为 `data/season.json` 中的 65 名角色下载官方头像和大图。图片只写入你指定的 ZIP，供本机或 iPhone 的“导入素材包”功能使用。请勿将 ZIP 或图片放入网站目录、公开仓库或公开网盘。

在项目目录使用 Node.js 20 或更新版本运行：

```powershell
node scripts/make_personal_s19_pack.mjs --output local-packs/jcc-s19-18.18.3-personal.zip
```

`local-packs/` 已被 `.gitignore` 忽略，静态构建也不会复制该目录。也可以把 `--output` 设为项目目录外的 Downloads 路径；脚本会拒绝 `assets/`、`dist/` 和其他公开目录。默认不覆盖已有 ZIP，确实需要替换同一路径时追加 `--overwrite`。它会在下载前核对官方当前赛季、最新补丁、角色数量及 ID 与本地目录的一致性；如果本地 `data/season.json` 已过期，会停止并提示当前补丁。下载后会检查官方地址、图片格式与大小，并用应用自身的 ZIP 导入器校验成品。

把生成的 ZIP 私下传到 iPhone 的“文件”，再从应用“资料”页的素材包入口选择它。ZIP 内 `manifest.json` 保留每张图片的官方 URL 和 SHA-256，便于核对来源。导入后首页会用角色图片生成每套 20 道选择题，图鉴也会显示对应头像。
