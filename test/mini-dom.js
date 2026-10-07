// 极简假 DOM：只实现 parser 用到的 API（textContent / getAttribute / querySelector(All) / closest / children）。
// 选择器支持：tag、.class、[attr="value"] 的组合，以及空格分隔的后代选择器。

export function h(tag, attrs, ...children) {
  const node = {
    tagName: tag.toUpperCase(),
    attrs: attrs || {},
    parent: null,
    children: [],
    childNodes: [],
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
    },
    get textContent() {
      return this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    },
    querySelectorAll(sel) {
      return all(this).filter((n) => matches(n, sel, this));
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    closest(sel) {
      for (let n = this; n; n = n.parent) if (matchCompound(n, sel)) return n;
      return null;
    },
    toString() {
      return `[object HTML${tag}Element]`;
    },
  };
  for (const c of children.flat()) {
    node.childNodes.push(c);
    if (typeof c !== 'string') {
      c.parent = node;
      node.children.push(c);
    }
  }
  return node;
}

function all(root) {
  const out = [];
  (function walk(n) {
    for (const c of n.children) {
      out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

function matchCompound(node, sel) {
  const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+="[^"]*"\])*)$/i.exec(sel);
  if (!m) throw new Error(`mini-dom: unsupported selector ${sel}`);
  if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
  const classes = (node.attrs.class || '').split(/\s+/);
  for (const c of m[2].split('.').filter(Boolean)) if (!classes.includes(c)) return false;
  for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
    const [, k, v] = /\[([\w-]+)="([^"]*)"\]/.exec(a);
    if (node.attrs[k] !== v) return false;
  }
  return true;
}

function matches(node, sel, scope) {
  const parts = sel.trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (!matchCompound(node, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let n = node.parent; n && n !== scope.parent && i >= 0; n = n.parent) {
    if (matchCompound(n, parts[i])) i--;
  }
  return i < 0;
}

export function doc(...children) {
  return h('html', {}, ...children);
}
