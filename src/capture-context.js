// URL fragment 不发送给服务器；跨域 iframe 通过逐层父子握手继承 capture ID。
const PARAM = 'course-fetch-capture';
const REQUEST = 'course-fetch:capture-context-request';
const RESPONSE = 'course-fetch:capture-context-response';

export function captureTabUrl(watchUrl, id) {
  const url = new URL(watchUrl);
  const fragment = url.hash.slice(1);
  url.hash = `${fragment ? `${fragment}&` : ''}${PARAM}=${encodeURIComponent(id)}`;
  return url.href;
}

export function captureIdFromUrl(url) {
  try {
    return new URLSearchParams(new URL(url).hash.slice(1)).get(PARAM);
  } catch (_) {
    return null;
  }
}

/** 只接受直接父窗口的回复；无标记的普通顶层播放页不会参与捕获。 */
export function resolveCaptureId(win, timeoutMs = 3000) {
  const ownId = captureIdFromUrl(win.location.href);
  if (ownId) return Promise.resolve(ownId);
  if (win.parent === win) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (id) => {
      clearTimeout(timeout);
      clearInterval(retry);
      win.removeEventListener('message', receive);
      win.removeEventListener('pagehide', leave);
      resolve(id);
    };
    const receive = (event) => {
      if (event.source === win.parent && event.data?.type === RESPONSE && typeof event.data.id === 'string') finish(event.data.id);
    };
    const leave = () => finish(null);
    const ask = () => win.parent.postMessage({ type: REQUEST }, '*');
    win.addEventListener('message', receive);
    win.addEventListener('pagehide', leave, { once: true });
    const timeout = setTimeout(() => finish(null), timeoutMs);
    const retry = setInterval(ask, 100);
    ask();
  });
}

/** 回应本页面直属 iframe；每个 iframe 建立自己的桥，支持多层及跨域播放器。 */
export function bridgeCaptureId(win, id, valid) {
  const receive = (event) => {
    if (event.data?.type !== REQUEST || !valid()) return;
    for (let i = 0; i < win.frames.length; i++) {
      if (event.source === win.frames[i]) {
        event.source.postMessage({ type: RESPONSE, id }, event.origin === 'null' ? '*' : event.origin);
        break;
      }
    }
  };
  win.addEventListener('message', receive);
  return () => win.removeEventListener('message', receive);
}
