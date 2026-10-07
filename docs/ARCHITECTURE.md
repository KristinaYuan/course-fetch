# Course Fetch 架构与技术细节

本文面向想了解实现或参与开发的读者。使用方法见 [README](../README.md)，MP4 转封装的细节见 [MP4.md](MP4.md)。

## 整体流程

```
课堂实录列表页（videoList.action）
  │ page.js    解析当前页 + 沿「前进」翻页 → parser.js 去重、排序、编号、命名
  │ ui.js      Shadow DOM 面板
  ▼
点击「下载」/「下载选中」
  │ directory.js  选一次目录（用户手势内），每条录像创建独立文件流
  │ capture.js    后台打开临时播放页，捕获播放器请求的 playlist.m3u8
  │ downloader.js 请求 m3u8 / key / 分片，AES-128 解密，按序输出
  │ remux.js      TS → MP4 流式转封装（或原样输出 TS）
  ▼
FileSystemWritableFileStream 直接写盘
```

## 源码结构

```
src/
  userscript.meta.js   # userscript header（@version 构建时从 package.json 填入）
  main.js              # 入口：初始化状态、扫描、打开/导出、单条和批量下载流程
  parser.js            # 日期节次、排序去重、文件名模板、manifest（纯函数）
  page.js              # 教学网页面：DOM 提取、分页、课程名、定位播放列表（自动捕获，超时后手动输入）
  capture.js           # m3u8 自动捕获：列表页打开临时播放页并等待结果；播放页用 Resource Timing 发现 m3u8
  capture-context.js   # 捕获身份：URL fragment + 跨域父子 frame 握手
  batch.js             # 固定录像 worker 池、独立取消/失败、总体进度
  scheduler.js         # 全局 FIFO 请求上限，取消排队任务
  directory.js         # 选目录、直接写文件、同名避让、未完成文件清理、单条下载的内存兼容分支
  hls.js               # m3u8、EXT-X-KEY、IV、码率选择、加密方式检查（纯函数）
  downloader.js        # 请求、取消、重试、按序并发、AES-128 解密、进度、内存合并 sink
  ts-demux.js          # MPEG-TS 解复用：188 字节包、PAT/PMT、PES，增量输入
  codecs.js            # H.264 Annex B / SPS、AAC ADTS 参数解析（纯函数）
  mp4-mux.js           # MP4 box 与样本表
  remux.js             # TS → MP4 流式转封装、编码检查、MP4 / TS 输出选择、TS 回退
  ui.js                # 面板、列表、下载进度、批次结束确认、事件绑定
  storage.js           # GM storage 封装
build.mjs              # esbuild 打包脚本
tools/ts2mp4.mjs       # 离线把 .ts 无损转为 .mp4（与脚本共用 remux 模块）
dist/course-fetch.user.js  # 构建产物：可直接安装的单文件 userscript
```

`main` 组合 UI、批量调度、捕获和文件流；单条下载与批量共用 `directory` 的目录写入，`batch` 复用 `downloadHls`；`remux` 是 `downloadHls` 的 `write` 与文件流之间独立的一层；`scheduler` 限制实际请求；`downloader` 使用 `hls` 的解析和 AES 逻辑。网络、文件流和捕获方法都通过参数注入，核心流程可以在 Node 中运行。

## 脚本运行的页面

| 页面 | 行为 |
| --- | --- |
| `*.pku.edu.cn` 下 URL 含 `videoList.action` | 课堂实录列表，运行完整功能 |
| `*.pku.edu.cn` 下 URL 含 `playVideo.action`，以及 `onlineroomse.pku.edu.cn` | 播放页和播放器 iframe。只有存在未过期的捕获请求时才运行，用来捕获 m3u8；平时什么都不做 |

跨域请求（如 `resourcese.pku.edu.cn`）使用 `GM_xmlhttpRequest`，header 声明了 `@connect pku.edu.cn`。播放器若在其它域名，需要在 header 中添加对应的 `@match`。

## 安全边界

- 只请求当前登录会话本来就能访问的资源；401/403 直接失败，不重试、不绕过。
- 只支持 `METHOD=AES-128` 且 `KEYFORMAT=identity`；SAMPLE-AES、FairPlay、Widevine 等方案直接报「不支持」。
- AES key 只在下载过程中保存在内存中，从不写入 storage 或日志。
- 「观看」链接可能带临时 token，只保存在页面内存中，不写入 storage、manifest 或复制出的清单。
- 捕获到的 m3u8 地址经 GM storage 从播放页短暂传回列表页，读取后立即删除。

## 下载与并发

默认值集中在 `src/batch.js` 的 `BATCH_LIMITS`：

| 层级 | 默认上限 | 范围 |
| --- | --- | --- |
| 录像 | 3 | 固定数量 worker；槽位覆盖文件创建、捕获、下载、提交和清理 |
| 每条分片窗口 | 4 | 正在下载、已完成等待前序、解密中、正在写盘的分片都计入；写完才补充 |
| 全局请求 | 8 | 本列表页所有任务的 m3u8、variant、key、分片和重试请求，共用 FIFO 队列 |

- 只创建最多 3 个 worker，不为全部录像同时创建下载 Promise。
- 等待重试不占网络槽，排队请求可以独立取消；任何分片失败会立即结束本条，不会被卡住的前序分片遮住。
- 网络错误最多重试 3 次，4xx 和解密错误不重试。
- 视频数据最多保留 3 × 4 个分片窗口；AES 解密时临时同时持有密文和明文。内存取决于分片大小，不随录像长度或批次数量累积。
- 全局请求上限只约束脚本发起的请求；临时播放页内播放器自己的请求由浏览器管理，最多同时存在 3 个捕获页。

## 文件写入

- 单条和批量都先调用 `showDirectoryPicker({ mode: 'readwrite' })`，并且必须在点击后的第一个 `await` 调用，否则会失去用户手势。
- 每条录像在目录中创建独立文件，通过 `FileSystemWritableFileStream` 顺序写入；MP4 完成时用 `write({ type: 'write', position })` 回填文件头。
- 同名避让：已有文件或同批重名时依次尝试 `name (2).ext`、`name (3).ext`……，在 `await` 之前预留名称，并发任务不会选到同一个文件名。
- 失败或取消时 `abort()` 文件流并删除未完成的文件；`close()` 成功才计为完成。
- 单条下载在浏览器没有目录 API（Firefox），或调用时抛出 `SecurityError`（跨域 iframe）时，才退回内存合并，完成后交给浏览器下载，并在界面上说明原因。批量下载没有内存分支，不支持时直接失败。

## 并发捕获关联

- 每次捕获生成独立随机 ID，使用 `capture:pending:<id>` 和 `capture:result:<id>` 两个键。
- 临时播放页通过 URL fragment 携带 ID（不会发送给服务器）。跨域或多层 iframe 通过逐层 `postMessage` 握手继承身份：子页只接受直接父窗口的回复，父页只回复直属 frame。
- 没有任务身份的普通播放页不参与捕获。
- 播放页写回结果前会再次核对任务有效期和 pending 记录。完成、失败、超时和取消时，每个任务只删除自己的键、关闭自己的临时页；任务取消后迟到的播放器不会重建结果。
- GM storage 中的 pending 记录只有 ID 和过期时间。
- 单条下载捕获超时（20 秒）后会弹窗让用户手动粘贴 m3u8；批量下载不弹窗，直接标记该条失败。

## 批次状态

- 批次结束后保留 `state.batch`，只把 `running` 设为 `false`，界面显示结果和「确定」按钮；点击后调用 `dismissBatch()`，清除结果并恢复开始前的状态栏文字。
- 未确认时也可以直接开始新批次；新批次会记住最初的状态栏，所以确认后仍恢复到列表状态。
- 用户取消目录选择时没有开始任何任务，直接恢复，不需要确认。
- 总体百分比按录像等权计算，失败和取消也计入已处理；保留最后 1% 给文件提交。

## 命名模板与 Manifest

模板变量：

| 变量 | 含义 | 示例 |
| --- | --- | --- |
| `{index}` / `{index:02d}` | 排序后的序号，`:0Nd` 表示补零到 N 位 | `3` / `03` |
| `{date}` | 日期 | `2026-09-30` |
| `{periodStart}` / `{periodEnd}` | 起止节次 | `3` / `4` |
| `{teacher}` | 教师 | `陈向群` |
| `{course}` | 面板中的课程名 | `操作系统` |
| `{time}` | 开始时间 HHmm | `1010` |
| `{startTime}` | 完整开始时间（冒号替换成 `_`） | `2026-09-30 10_10_00` |

- 文件名中的非法字符 `\ / : * ? " < > |` 替换为 `_`，未知变量原样保留。
- 模板中的视频扩展名会按「输出格式」换成 `.mp4` 或 `.ts`。

Manifest 示例：

```json
{
  "schema": "course-fetch.manifest/v1",
  "generatedAt": "2026-10-07T08:00:00.000Z",
  "course": { "name": "操作系统", "id": "_12345_1" },
  "template": "L{index:02d}-{date}-第{periodStart}-{periodEnd}节.mp4",
  "count": 1,
  "lectures": [
    {
      "index": 1,
      "date": "2026-09-09",
      "periodStart": 3,
      "periodEnd": 4,
      "startTime": "2026-09-09 10:10:00",
      "teacher": "陈向群",
      "filename": "L01-2026-09-09-第3-4节.mp4"
    }
  ]
}
```

## 开发与构建

需要 Node 20+。

```bash
npm install      # 只安装 esbuild 一个开发依赖
npm run build    # 打包 src/ → dist/course-fetch.user.js
npm run check    # 构建并对产物做语法检查
npm run ts2mp4 -- in.ts [out.mp4]   # 离线转封装
```

- 修改 `src/` 后运行 `npm run build`，再把新的 `dist/course-fetch.user.js` 安装到 Tampermonkey。不要直接修改 `dist/`。
- 发布新版本时只需修改 `package.json` 中的 `version`；header 中的 `@version` 和启动日志会自动同步。
- 脚本 header 的 `@updateURL` / `@downloadURL` 指向 `releases/latest/download/course-fetch.user.js`，Tampermonkey 按 `@version` 判断是否更新。

发布新版本：

1. 修改 `package.json` 的 `version`，运行 `npm test` 和 `npm run build`。
2. 提交并推送，打标签：`git tag v0.3.0 && git push origin v0.3.0`。
3. 在 GitHub 上用该标签创建 Release，上传 `dist/course-fetch.user.js` 作为附件；文件名必须保持 `course-fetch.user.js`，自动更新链接才能找到它。

- 教学网页面格式变化时，优先修改 `src/parser.js` 中的 `DATE_PERIOD_RE`、`TIME_RE`、`TEACHER_RE`，以及 `src/page.js` 中的 `extractPage`。

## 技术限制

- 教学网加载了 Prototype.js，它会覆盖 `Array.from` 等全局方法。处理 DOM 集合时只用普通循环，不要使用 `Array.from(list, mapFn)`。
- 「前进」如果是 `javascript:` 跳转并且提取不出 URL，就无法自动翻页。
- 分页通过同源 `fetch` 获取，依赖当前登录状态。
- 课程名按 Blackboard 常见元素启发式识别。
- 暂不支持 `EXT-X-BYTERANGE`、`EXT-X-MAP`（fMP4）和直播（没有 `EXT-X-ENDLIST` 时只下载当时列表中的分片）。
