// GM storage 封装：不可用或出错时静默退回默认值。
// 保存课程名、模板、面板折叠状态；以及下载时短暂使用的 capture 记录（见 capture.js）。

export const store = {
  get(k, d) {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(k, d) : d;
    } catch (_) {
      return d;
    }
  },
  set(k, v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(k, v);
    } catch (_) {
      /* ignore */
    }
  },
  delete(k) {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(k);
    } catch (_) {
      /* ignore */
    }
  },
  /** 监听其它标签页 / frame 对 k 的修改，cb(newValue)。返回取消监听的函数。 */
  onChange(k, cb) {
    if (typeof GM_addValueChangeListener !== 'function') return () => {};
    let id;
    try {
      id = GM_addValueChangeListener(k, (name, oldValue, newValue) => cb(newValue));
    } catch (_) {
      return () => {};
    }
    return () => {
      try {
        if (typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(id);
      } catch (_) {
        /* ignore */
      }
    };
  },
};
