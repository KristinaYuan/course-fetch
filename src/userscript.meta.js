// ==UserScript==
// @name         Course Fetch
// @namespace    https://github.com/MiniYuanBot/course-fetch
// @version      {{version}}
// @description  北大教学网课堂实录：枚举整门课程录像、排序、命名、导出 manifest，支持单条和批量下载，无损保存为 MP4。
// @homepageURL  https://github.com/MiniYuanBot/course-fetch
// @supportURL   https://github.com/MiniYuanBot/course-fetch/issues
// @updateURL    https://github.com/MiniYuanBot/course-fetch/releases/latest/download/course-fetch.user.js
// @downloadURL  https://github.com/MiniYuanBot/course-fetch/releases/latest/download/course-fetch.user.js
// @match        *://*.pku.edu.cn/*videoList.action*
// @match        *://*.pku.edu.cn/*playVideo.action*
// @match        *://onlineroomse.pku.edu.cn/*
// @include      /^https?:\/\/[^/]*pku\.edu\.cn\/.*videoList\.action.*/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      pku.edu.cn
// @connect      self
// @run-at       document-idle
// ==/UserScript==

/*
 * 功能：课程录像枚举、metadata 解析、排序、命名、工作流辅助；单条和批量录像下载（标准 HLS AES-128）。
 * 下载只使用当前浏览器登录会话本来就能访问的 m3u8 / key / 分片：遇到 401/403 直接失败，
 * 不做任何登录或权限绕过；不支持 SAMPLE-AES、非 identity KEYFORMAT 等 DRM 方案。
 * “观看”链接和 AES key 只保存在内存中，不写入 storage / manifest / 剪贴板清单。
 * m3u8 地址由临时打开的播放页自动捕获，经 GM storage 短暂传回列表页，读取后立即删除。
 * 播放页 / 播放器 iframe 上只在下载时存在未过期的 capture 请求时才运行捕获，平时什么都不做。
 *
 * 本文件由 src/ 下的模块经 esbuild 打包生成，请修改 src/ 后运行 npm run build。
 */
