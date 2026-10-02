'use strict';

// A minimal stand-in for the browser DOM, enough for the panel renderers
// to run under node:test with the real dashboard modules. Elements are
// created on first lookup by id; `el(id)` returns the same element the
// renderer wrote to. Installs `window` (= globalThis) and `document`.

class FakeElement {
  constructor(tag, id) {
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.textContent = '';
    this.title = '';
    this.className = '';
    this.dataset = {};
    this.hidden = false;
    this.style = {};
    this.attributes = {};
  }
  get classList() {
    const element = this;
    const list = () => element.className.split(/\s+/).filter(Boolean);
    const set = (names) => { element.className = names.join(' '); };
    return {
      add: (...names) => set([...new Set([...list(), ...names])]),
      remove: (...names) => set(list().filter(n => !names.includes(n))),
      toggle: (name, on) => {
        const want = on === undefined ? !list().includes(name) : on;
        if (want) set([...new Set([...list(), name])]);
        else set(list().filter(n => n !== name));
      },
      contains: (name) => list().includes(name),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  set innerHTML(_) { this.children = []; }
  get innerHTML() { return ''; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  hasAttribute(k) { return k in this.attributes; }
  closest() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
}

const elements = new Map();

function el(id) {
  if (!elements.has(id)) elements.set(id, new FakeElement('div', id));
  return elements.get(id);
}

globalThis.window = globalThis;
globalThis.document = {
  getElementById: el,
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => ({ textContent: String(text) }),
  querySelector: () => null,
  querySelectorAll: () => [],
};

// Each row of a table body as the text of its cells.
function rowTexts(bodyId) {
  return el(bodyId).children.map(tr => tr.children.map(td => td.textContent));
}

module.exports = { FakeElement, el, rowTexts };
