# 识别率评估（本地命令行）

这个工具用**独立采集**的带标签图片检验 `src/recognition.mjs`，并按游戏截图、原画、非目标图片分别报告结果。图片和参考素材只在本机读取，不上传。仓库里的 `synthetic-test-pack.zip` 和 `local-packs/` 中的官方图片都是**参考图或流程测试图**，不能据此声称达到识别率目标。

## 准备测试集

先准备与应用导入时完全相同的参考素材 ZIP。正式测试时，测试图必须来自与参考图不同的独立采集，不得用参考图本身、裁剪、缩放、截图包裹或再压缩版本。每张测试图只标注一个需要识别的目标角色；非目标图中不得出现任何参考包内角色。可以把非目标游戏界面、其他赛季角色和普通图片都纳入 `unknown`。

在任意私有文件夹中建立 `cases.json` 和图片文件。下面是格式示例；`heroId` 必须是参考 ZIP 中的稳定 ID，赛季与补丁必须与 ZIP 一致。`sourceId` 表示独立采集来源，同一原始截图或原画只能算一个来源，所以每个样本的 `sourceId` 必须不同。

```json
{
  "schemaVersion": 1,
  "datasetKind": "independent",
  "seasonId": "s19",
  "patch": "18.18.3",
  "cases": [
    {
      "id": "game-001",
      "category": "game",
      "sourceId": "capture-001",
      "expectedHeroId": "填写资料中的角色id",
      "path": "images/game-001.png"
    },
    {
      "id": "splash-001",
      "category": "splash",
      "sourceId": "capture-002",
      "expectedHeroId": "填写资料中的角色id",
      "path": "images/splash-001.jpg"
    },
    {
      "id": "unknown-001",
      "category": "unknown",
      "sourceId": "capture-003",
      "path": "images/unknown-001.png"
    }
  ]
}
```

`path` 只能指向清单所在文件夹内的 PNG、JPEG 或 WebP 文件。工具会拒绝重复路径、重复测试文件，以及与参考 ZIP 中任何图片**字节完全相同**的测试文件。它无法自动证明裁剪、缩放或改格式的图片是否独立；收集和标注时仍需核查来源。

## 运行

需要 Node.js 20+、Python 3 和 Pillow。第一次运行前可执行 `python -m pip install Pillow`。本机 OpenCV 模式使用应用自带的 4.8.0 版本；若它不能初始化，命令会报错，不会静默切到纯 JS。

```powershell
node scripts/evaluate.mjs `
  --pack local-packs/jcc-s19-18.18.3-personal.zip `
  --manifest private-evaluation/cases.json `
  --output private-evaluation/report.json
```

可追加 `--mode js` 做不带 OpenCV 几何匹配的对照，或用 `--max-orb-references 32` 固定几何验证的候选数量。Python 命令不叫 `python` 时用 `--python PATH` 指定。输出路径必须是新文件，工具不会覆盖旧报告。

报告保存参考 ZIP、清单、识别代码和 OpenCV 文件的 SHA-256，另有逐张图片的 SHA-256、角色预测、最多三个候选及定位框、判定原因、OpenCV 诊断和分类统计。这样可以用同一批文件和参数重复测试。报告不包含图片内容；其中的路径和文件哈希仍可能属于私人测试资料，请自行保管。

统计口径：正例只有 `status=match` 且第一名 ID 与标签相同才算首选识别成功；`uncertain`、错误匹配和无法识别都记为未成功。非目标图中任何 `status=match` 都算误判。每类报告样本数、正确数或误判数、比例，以及识别和图片解码的中位数、95 分位、最大耗时。目标是游戏截图与独立原画各自首选识别率 **高于 90%**，非目标误判率 **低于 5%**。需要覆盖不同角色、尺寸、角度、遮挡和画质，并记录样本来源；少量样本或单一角色的比例不能代表整季效果。

CLI 的识别耗时在参考图预处理完成后计时，输入图片由 Pillow 先解码；它测量视觉识别器，不包含应用在候选接近时启动的本地中文 OCR，因此只供预评估和规则校准。正式的全流程准确率、速度与安装、离线重启、版本更新仍须在目标 iPhone 的 Safari 主屏幕应用上测量。CLI 报告的 `acceptanceEvidence` 始终为 `false`，以免把电脑测试误当作 iPhone 验收。

## 流程烟雾测试

下面的图由脚本把**同一张参考图**粘贴到更大的画布上，并生成一张无关图片。它只检查解码、定位入口、汇总和报告生成，不衡量真实识别率。报告会标记 `datasetKind: synthetic-smoke` 和 `acceptanceEvidence: false`。

```powershell
python scripts/make_evaluation_smoke.py local-packs/evaluation-smoke
node scripts/evaluate.mjs `
  --pack tests/fixtures/generated/synthetic-test-pack.zip `
  --manifest local-packs/evaluation-smoke/cases.json `
  --output local-packs/evaluation-smoke/report.json `
  --mode js --allow-synthetic-smoke
```

也可以运行 `node --test tests/evaluation.test.mjs`，测试会在系统临时目录生成并清理这些非独立样本。
