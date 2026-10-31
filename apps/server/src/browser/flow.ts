import { CAPTURE_LIMITS, CaptureError, type PageSession } from './capture.js';
import { isLocalUrl } from './urls.js';

/**
 * Browser flows: a list of steps (open a page, click, type, choose, press a key, check what the
 * page shows) run in a fresh page on a local site, with a screenshot, the page address and the
 * console errors and failed requests of every step. Elements are found the way a person would
 * name them (a button's text, a field's label), waited for until they can be used, and clicked
 * with real mouse events at their centre.
 */

/** How a step names an element: exactly one of role, label, text, placeholder, test_id, css. */
export interface Target {
  role?: string;
  /** Accessible name, with `role`. */
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  test_id?: string;
  css?: string;
  /** Whole-text match instead of "contains" (case-insensitive either way). */
  exact?: boolean;
  /** Which match, 1 = first, when several elements fit. */
  nth?: number;
}

export const FLOW_KEYS = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];

interface StepBase {
  /** Per-step wait limit (ms) for elements, text and page loads. */
  timeout_ms?: number;
}

export type FlowStep = StepBase &
  (
    | { action: 'goto'; url: string }
    | { action: 'click'; target: Target; accept_dialog?: boolean }
    | { action: 'fill'; target: Target; value: string }
    | { action: 'select'; target: Target; option: string }
    | { action: 'check'; target: Target }
    | { action: 'uncheck'; target: Target }
    | { action: 'press'; key: FlowKey; target?: Target; accept_dialog?: boolean }
    | { action: 'wait'; ms: number }
    | {
        action: 'expect';
        text?: string;
        target?: Target;
        /** The page address contains this (a path such as "/cart" or a full URL). */
        url?: string;
        /** With target: the field's value. */
        value?: string;
        /** The text or element must not be visible. */
        absent?: boolean;
      }
  );

export const FLOW_LIMITS = {
  maxSteps: 30,
  defaultStepTimeoutMs: 5_000,
  maxStepTimeoutMs: 30_000,
  maxWaitMs: 10_000,
  maxTotalMs: 180_000,
  maxValueLength: 2_000,
  /** Network-quiet wait after an action (the page reacting). */
  settleMs: 3_000,
  jpegQuality: 80,
} as const;

export interface StepResult {
  /** 0 is opening the start page; 1 and on are the flow's steps. */
  index: number;
  label: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  url: string | null;
  title: string | null;
  /** Console errors, uncaught exceptions and failed requests during the step. */
  problems: string[];
  /** Dialogs answered, navigations blocked, other things worth knowing. */
  notes: string[];
  error: string | null;
  image: Buffer | null;
}

export interface FlowResult {
  status: 'passed' | 'failed' | 'cancelled';
  steps: StepResult[];
  durationMs: number;
  /** Elements on the page when the flow failed (to fix a step's target). */
  outline: PageOutline | null;
}

export interface PageControl {
  role: string;
  name: string;
  /** A target that finds exactly this element. */
  target: Target;
  state: string[];
}

export interface PageOutline {
  title: string;
  url: string;
  headings: Array<{ level: number; text: string }>;
  controls: PageControl[];
  /** More controls than listed. */
  more: number;
  /** The start of the page's visible text. */
  text: string;
}

// ------------------------------------------------------------------ descriptions

const q = (s: string) => `"${s.length > 80 ? `${s.slice(0, 77)}…` : s}"`;

export function describeTarget(t: Target): string {
  const nth = t.nth ? ` (match ${t.nth})` : '';
  const exact = t.exact ? ' (exact)' : '';
  if (t.role) return `${t.role}${t.name !== undefined ? ` ${q(t.name)}` : ''}${exact}${nth}`;
  if (t.label !== undefined) return `field labelled ${q(t.label)}${exact}${nth}`;
  if (t.placeholder !== undefined)
    return `field with placeholder ${q(t.placeholder)}${exact}${nth}`;
  if (t.text !== undefined) return `text ${q(t.text)}${exact}${nth}`;
  if (t.test_id !== undefined) return `test id ${q(t.test_id)}${nth}`;
  return `element ${t.css ?? '?'}${nth}`;
}

export function describeStep(s: FlowStep): string {
  switch (s.action) {
    case 'goto':
      return `Go to ${s.url}`;
    case 'click':
      return `Click ${describeTarget(s.target)}${s.accept_dialog ? ', accepting the dialog it opens' : ''}`;
    case 'fill':
      return s.value === ''
        ? `Clear ${describeTarget(s.target)}`
        : `Type ${q(s.value)} into ${describeTarget(s.target)}`;
    case 'select':
      return `Choose ${q(s.option)} in ${describeTarget(s.target)}`;
    case 'check':
      return `Check ${describeTarget(s.target)}`;
    case 'uncheck':
      return `Uncheck ${describeTarget(s.target)}`;
    case 'press':
      return `Press ${s.key}${s.target ? ` in ${describeTarget(s.target)}` : ''}${s.accept_dialog ? ', accepting the dialog it opens' : ''}`;
    case 'wait':
      return `Wait ${s.ms} ms`;
    case 'expect': {
      const not = s.absent ? 'not ' : '';
      if (s.url !== undefined) return `Expect the address ${not}to contain ${q(s.url)}`;
      if (s.target && s.value !== undefined)
        return `Expect ${describeTarget(s.target)} ${not}to have the value ${q(s.value)}`;
      if (s.target)
        return `Expect ${describeTarget(s.target)} ${s.absent ? 'not ' : ''}to be shown`;
      return `Expect the page ${s.absent ? 'not ' : ''}to show ${q(s.text ?? '')}`;
    }
  }
}

/** Whether a step changes anything on the page (as opposed to looking at it). */
export const actsOnPage = (s: FlowStep) =>
  s.action !== 'goto' && s.action !== 'wait' && s.action !== 'expect';

// ------------------------------------------------------------------ in-page helpers

/**
 * Functions evaluated in the page. Plain JavaScript in a raw string, so no build step can change
 * it. Element names follow the accessible-name rules closely enough for real apps: aria-labelledby,
 * aria-label, <label>, placeholder and title for fields; the text inside for buttons, links and
 * headings.
 */
const HELPERS = String.raw`
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const all = () => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.visibility === 'collapse' || st.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const shown = (el) =>
    visible(el) || (el.labels && Array.from(el.labels).some((l) => visible(l)));
  const NOT_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color'];
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r.split(' ')[0];
    const t = el.tagName.toLowerCase();
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (ty === 'search') return 'searchbox';
      if (ty === 'hidden' || ty === 'file' || ty === 'color') return null;
      return 'textbox';
    }
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img') return 'img';
    if (t === 'option') return 'option';
    if (t === 'li') return 'listitem';
    if (t === 'dialog') return 'dialog';
    if (t === 'nav') return 'navigation';
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return null;
  };
  const textOf = (el) => {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1) {
        const tag = n.tagName;
        if (tag === 'IMG') out += ' ' + (n.getAttribute('alt') || '') + ' ';
        else if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT' && tag !== 'TEMPLATE' && getComputedStyle(n).display !== 'none')
          out += ' ' + textOf(n) + ' ';
      }
    }
    return out;
  };
  const byIds = (ids) =>
    norm(ids.split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? textOf(e) : ''; }).join(' '));
  const labelOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const n = byIds(lb); if (n) return n; }
    const al = el.getAttribute('aria-label');
    if (al && norm(al)) return norm(al);
    if (el.labels && el.labels.length) return norm(Array.from(el.labels).map(textOf).join(' '));
    return '';
  };
  const FROM_CONTENT = ['button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'listitem', 'cell', 'treeitem', 'gridcell', 'columnheader', 'rowheader', 'tooltip'];
  const nameOf = (el) => {
    const l = labelOf(el);
    if (l) return l;
    const t = el.tagName.toLowerCase();
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'submit' || ty === 'reset' || ty === 'button')
        return norm(el.value || (ty === 'submit' ? 'Submit' : ty === 'reset' ? 'Reset' : ''));
      if (ty === 'image') return norm(el.getAttribute('alt') || 'Submit');
    }
    if (t === 'input' || t === 'textarea' || t === 'select')
      return norm(el.getAttribute('placeholder') || el.getAttribute('title') || '');
    if (t === 'img') return norm(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (FROM_CONTENT.includes(roleOf(el))) { const tx = norm(textOf(el)); if (tx) return tx; }
    return norm(el.getAttribute('title') || '');
  };
  const fits = (have, want, exact) => exact ? lower(have) === lower(want) : lower(have).includes(lower(want));
  const FIELD_ROLES = ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'spinbutton', 'switch'];
  const describe = (el) => {
    const role = roleOf(el);
    const name = nameOf(el);
    if (role) return role + (name ? ' "' + name.slice(0, 60) + '"' : '');
    let d = '<' + el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) d += '.' + cls.join('.');
    d += '>';
    const tx = norm(textOf(el)).slice(0, 40);
    return tx ? d + ' "' + tx + '"' : d;
  };
  // Where an element is, to tell apart several with the same name: the nearest ancestor with more text.
  const context = (el) => {
    const own = norm(textOf(el));
    let p = el.parentElement;
    for (let i = 0; p && i < 5; i++, p = p.parentElement) {
      const t = norm(textOf(p));
      if (t && t !== own) return ' in "' + (t.length > 60 ? t.slice(0, 57) + '…' : t) + '"';
    }
    return '';
  };
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy'];
  const matches = (spec) => {
    const ex = !!spec.exact;
    if (spec.css !== undefined) return Array.from(document.querySelectorAll(spec.css));
    const els = all();
    if (spec.role !== undefined)
      return els.filter((el) => roleOf(el) === spec.role && (spec.name === undefined || fits(nameOf(el), spec.name, ex)));
    if (spec.label !== undefined)
      return els.filter((el) => FIELD_ROLES.includes(roleOf(el)) && fits(labelOf(el), spec.label, ex) && labelOf(el) !== '');
    if (spec.placeholder !== undefined)
      return els.filter((el) => el.hasAttribute('placeholder') && fits(el.getAttribute('placeholder'), spec.placeholder, ex));
    if (spec.test_id !== undefined)
      return els.filter((el) => TEST_ATTRS.some((a) => el.getAttribute(a) === spec.test_id));
    if (spec.text !== undefined) {
      const want = lower(spec.text);
      const hits = els.filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'HEAD'].includes(el.tagName) &&
        lower(el.textContent).includes(want) && fits(textOf(el), spec.text, ex));
      // The innermost elements with the text: a match whose child also matches is dropped.
      return hits.filter((el) => !Array.from(el.children).some((c) => hits.includes(c)));
    }
    return [];
  };
`;

/** Find one element: returns it, or a JSON string {error, retry, candidates}. */
const LOCATE = String.raw`(function (spec) {
  ${HELPERS}
  let found;
  try { found = matches(spec); }
  catch (e) { return JSON.stringify({ error: 'is not a valid CSS selector (' + e.message + ')', retry: false }); }
  const vis = found.filter(shown);
  if (spec.nth) {
    const pool = vis.length ? vis : found;
    if (pool.length >= spec.nth) return pool[spec.nth - 1];
    return JSON.stringify({ error: 'has only ' + pool.length + ' match' + (pool.length === 1 ? '' : 'es'), retry: true });
  }
  if (vis.length === 1) return vis[0];
  if (vis.length > 1) {
    const list = vis.slice(0, 6).map((el, i) => (i + 1) + '. ' + describe(el) + context(el));
    return JSON.stringify({ error: 'matches ' + vis.length + ' elements; add nth (1 = first) or name it more precisely', retry: false, candidates: list });
  }
  if (found.length) return JSON.stringify({ error: 'is on the page but hidden', retry: true });
  // Not found: elements with a similar name, to fix the step.
  const want = lower(spec.name || spec.label || spec.text || spec.placeholder || '');
  const words = want.split(' ').filter((w) => w.length > 2);
  const near = [];
  if (words.length)
    for (const el of all()) {
      if (near.length >= 6) break;
      const role = roleOf(el);
      if (!role || !visible(el) || role === 'listitem') continue;
      const n = lower(nameOf(el) + ' ' + (el.getAttribute('placeholder') || ''));
      if (words.some((w) => n.includes(w))) near.push(describe(el));
    }
  return JSON.stringify({ error: 'was not found', retry: true, candidates: near });
})`;

const OUTLINE = String.raw`(function (limit) {
  ${HELPERS}
  const INTERACTIVE = ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio'];
  const els = all();
  const list = els.filter((el) => INTERACTIVE.includes(roleOf(el)) && shown(el));
  const seen = new Map();
  for (const el of list) {
    const key = roleOf(el) + '\u0000' + lower(nameOf(el));
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const index = new Map();
  const controls = [];
  for (const el of list) {
    const role = roleOf(el);
    const name = nameOf(el);
    const key = role + '\u0000' + lower(name);
    const k = (index.get(key) || 0) + 1;
    index.set(key, k);
    if (controls.length >= limit) continue;
    let target;
    const tid = TEST_ATTRS.map((a) => el.getAttribute(a)).find((v) => v);
    if (name && seen.get(key) === 1) target = { role: role, name: name };
    else if (tid) target = { test_id: tid };
    else if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) target = { css: '#' + CSS.escape(el.id) };
    else target = name ? { role: role, name: name, nth: k } : { role: role, nth: k };
    if (target.name !== undefined && seen.get(key) === 1 && list.filter((o) => roleOf(o) === role && fits(nameOf(o), name, false)).length > 1)
      target.exact = true;
    const state = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') state.push('disabled');
    if (role === 'checkbox' || role === 'radio' || role === 'switch')
      state.push((el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true') ? 'checked' : 'not checked');
    if (el.required) state.push('required');
    if (seen.get(key) > 1 && context(el)) state.push(context(el).trim());
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password')
      state.push(el.value ? 'password field, filled' : 'password field, empty');
    else if (tag === 'textarea' || (tag === 'input' && role !== 'checkbox' && role !== 'radio'))
      state.push(el.value ? 'value "' + norm(el.value).slice(0, 60) + '"' : 'empty');
    else if (tag === 'select' && el.selectedOptions && el.selectedOptions[0])
      state.push('selected "' + norm(el.selectedOptions[0].text).slice(0, 60) + '"');
    if (role === 'link') { const h = el.getAttribute('href'); if (h) state.push('href ' + h.slice(0, 80)); }
    controls.push({ role: role, name: name.slice(0, 120), target: target, state: state });
  }
  const headings = els.filter((el) => /^H[1-6]$/.test(el.tagName) && visible(el)).slice(0, 40)
    .map((el) => ({ level: Number(el.tagName[1]), text: norm(textOf(el)).slice(0, 120) }));
  const text = document.body ? document.body.innerText.split('\n').map(norm).filter(Boolean).join('\n').slice(0, 2000) : '';
  return JSON.stringify({ title: document.title, url: location.href, headings: headings, controls: controls, more: Math.max(0, list.length - controls.length), text: text });
})`;

/** Called on the element (`this`): scroll it into view and say where to click, or why not. */
const CLICK_POINT = String.raw`function () {
  let el = this;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: 'is disabled', retry: true };
  let r = el.getBoundingClientRect();
  // A styled checkbox or radio is often hidden behind its label: click the label.
  if ((!r.width || !r.height || getComputedStyle(el).opacity === '0') && el.labels && el.labels.length) el = el.labels[0];
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { error: 'has no size on the page', retry: true };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit) return { error: 'is outside the visible page', retry: true };
  const ok = hit === el || el.contains(hit) || (this.labels && Array.from(this.labels).some((l) => l === hit || l.contains(hit)));
  if (!ok) {
    const d = hit.id ? '<' + hit.tagName.toLowerCase() + '#' + hit.id + '>' : '<' + hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className.trim() ? '.' + hit.className.trim().split(/\s+/)[0] : '') + '>';
    return { error: 'is covered by ' + d, retry: true };
  }
  return { x: x, y: y, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
}`;

const FOCUS_FIELD = String.raw`function () {
  const el = this;
  const t = el.tagName.toLowerCase();
  const ty = (el.getAttribute('type') || 'text').toLowerCase();
  if (el.disabled) return { error: 'is disabled', retry: true };
  if (el.readOnly) return { error: 'is read-only', retry: false };
  if (t === 'input' && ['date', 'datetime-local', 'month', 'time', 'week', 'range', 'color'].includes(ty)) return { mode: 'set' };
  const text = t === 'textarea' || (t === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(ty));
  if (!text && !el.isContentEditable)
    return { error: 'is not a text field (use select for a drop-down, check for a checkbox, click for anything else)', retry: false };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  if (typeof el.select === 'function') el.select();
  else {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const active = document.activeElement;
  if (active !== el && !el.contains(active) && !(el.shadowRoot && el.shadowRoot.activeElement)) return { error: 'could not be focused', retry: true };
  return { mode: 'type', password: ty === 'password' };
}`;

/** Set a value the way a person's input would, past framework value tracking. */
const SET_VALUE = String.raw`function (value) {
  const proto = this.tagName === 'SELECT' ? HTMLSelectElement.prototype : this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.value;
}`;

const READ_VALUE = String.raw`function () {
  return this.value !== undefined && this.tagName !== 'LI' && this.tagName !== 'BUTTON' ? String(this.value) : String(this.innerText || '');
}`;

const SELECT_OPTION = String.raw`function (want) {
  const n = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (this.tagName !== 'SELECT') return { error: 'is not a <select> drop-down; click it, then click the option', retry: false };
  if (this.disabled) return { error: 'is disabled', retry: true };
  const opts = Array.from(this.options);
  const o =
    opts.find((o) => n(o.label || o.text) === n(want)) ||
    opts.find((o) => o.value === want) ||
    opts.find((o) => n(o.label || o.text).toLowerCase() === n(want).toLowerCase()) ||
    opts.find((o) => n(o.label || o.text).toLowerCase().includes(n(want).toLowerCase()));
  if (!o) return { error: 'has no option "' + want + '" (options: ' + opts.slice(0, 15).map((o) => '"' + n(o.label || o.text) + '"').join(', ') + ')', retry: true };
  if (o.disabled) return { error: 'has the option "' + n(o.text) + '" disabled', retry: true };
  this.focus();
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(this, o.value);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: n(o.label || o.text) };
}`;

const IS_CHECKED = String.raw`function () {
  if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) return this.checked;
  return this.getAttribute('aria-checked') === 'true' || this.getAttribute('aria-pressed') === 'true';
}`;

/**
 * Resolves once the page has painted two more frames (or after 500 ms). Input that arrives
 * before a new page's first frames can be dropped by the browser.
 */
const FRAMES = String.raw`new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 500);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve(true); }));
})`;

/** Note whether the next press reaches the page (checked with PRESSED right after it). */
const ARM = String.raw`function () {
  const k = Symbol.for('friday.pressed');
  window[k] = false;
  // Any of these counts, so a page that stops one of them early is not clicked twice.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'])
    window.addEventListener(type, () => { window[k] = true; }, { capture: true, once: true });
  return true;
}`;
const PRESSED = String.raw`window[Symbol.for('friday.pressed')]`;

const FOCUS = String.raw`function () { this.scrollIntoView({ block: 'center', behavior: 'instant' }); this.focus(); return true; }`;

const PAGE_TEXT = String.raw`(document.body ? document.body.innerText : '')`;

const KEYS: Record<
  FlowKey,
  { key: string; code: string; keyCode: number; text?: string; modifiers?: number }
> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  'Shift+Tab': { key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 8 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

// ------------------------------------------------------------------ the driver

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CaptureError('Cancelled.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CaptureError('Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A step could not do what it says (shown to the model with the reason). */
class StepFailure extends Error {}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string; retry: boolean };

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  objectId?: string;
}

interface Located {
  objectId: string;
}

/** A page being driven: its events (requests, loads, console, dialogs) and the step actions. */
export class PageDriver {
  private mainFrame = '';
  private loading = false;
  private loadSettledAt = 0;
  private lastNetworkAt = 0;
  private readonly inflight = new Set<string>();
  private readonly requestUrls = new Map<
    string,
    { url: string; type: string | undefined; frameId: unknown }
  >();
  /** The page itself tried to go to another site (and is now an error page). */
  private blockedPage: string | null = null;
  private problems: string[] = [];
  private notes: string[] = [];
  private acceptDialog = false;
  private status: number | null = null;

  constructor(
    private readonly page: PageSession,
    private readonly signal?: AbortSignal,
  ) {
    page.on((method, params) => this.onEvent(method, params));
  }

  async start(): Promise<void> {
    await Promise.all([
      this.page.send('Page.enable'),
      this.page.send('Runtime.enable'),
      this.page.send('Network.enable'),
    ]);
    const tree = (await this.page.send('Page.getFrameTree')) as {
      frameTree: { frame: { id: string } };
    };
    this.mainFrame = tree.frameTree.frame.id;
  }

  private problem(p: string) {
    // The desktop app's development build warns every page about its own settings.
    if (p.includes('Electron Security Warning')) return;
    if (this.problems.length < CAPTURE_LIMITS.maxProblems) this.problems.push(p.slice(0, 500));
  }

  private note(n: string) {
    if (this.notes.length < CAPTURE_LIMITS.maxProblems) this.notes.push(n.slice(0, 500));
  }

  /** Problems and notes since the last call. */
  takeReports(): { problems: string[]; notes: string[] } {
    const out = { problems: this.problems, notes: this.notes };
    this.problems = [];
    this.notes = [];
    return out;
  }

  private onEvent(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const id = p.requestId as string;
        const request = p.request as { url: string };
        this.inflight.add(id);
        this.requestUrls.set(id, {
          url: request.url,
          type: p.type as string | undefined,
          frameId: p.frameId,
        });
        this.lastNetworkAt = Date.now();
        break;
      }
      case 'Network.responseReceived': {
        const response = p.response as { status: number; url: string };
        if (p.type === 'Document' && p.frameId === this.mainFrame) this.status = response.status;
        // The browser asks for /favicon.ico by itself; a missing one is not the page's problem.
        if (response.status >= 400 && !/\/favicon\.ico$/.test(response.url))
          this.problem(`HTTP ${response.status}: ${response.url}`);
        this.lastNetworkAt = Date.now();
        break;
      }
      case 'Network.loadingFinished':
        this.inflight.delete(p.requestId as string);
        this.lastNetworkAt = Date.now();
        break;
      case 'Network.loadingFailed': {
        const id = p.requestId as string;
        const req = this.requestUrls.get(id);
        this.inflight.delete(id);
        this.lastNetworkAt = Date.now();
        if (p.errorText === 'net::ERR_BLOCKED_BY_CLIENT' && (p.type ?? req?.type) === 'Document') {
          if (req?.frameId === this.mainFrame) this.blockedPage = req.url;
          else
            this.note(
              `blocked: a frame of ${req?.url ?? 'another site'} (only pages on this machine are opened)`,
            );
        } else if (!p.canceled && p.errorText !== 'net::ERR_ABORTED')
          this.problem(`failed: ${req?.url ?? 'request'} (${String(p.errorText)})`);
        break;
      }
      case 'Page.frameStartedLoading':
        if (p.frameId === this.mainFrame) this.loading = true;
        break;
      case 'Page.frameStoppedLoading':
      case 'Page.loadEventFired':
        if (method === 'Page.loadEventFired' || p.frameId === this.mainFrame) {
          this.loading = false;
          this.loadSettledAt = Date.now();
        }
        break;
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'warning' || p.type === 'assert')
          this.problem(
            `console.${p.type === 'warning' ? 'warn' : String(p.type)}: ${(
              (p.args as Array<{ value?: unknown; description?: string }>) ?? []
            )
              .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
              .join(' ')}`,
          );
        break;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails as { text: string; exception?: { description?: string } };
        this.problem(`uncaught: ${d.exception?.description?.split('\n')[0] ?? d.text}`);
        break;
      }
      case 'Page.javascriptDialogOpening': {
        const type = String(p.type);
        const accept = type === 'alert' || type === 'beforeunload' || this.acceptDialog;
        this.note(
          `${type} dialog "${String(p.message).slice(0, 200)}" ${accept ? 'accepted' : 'dismissed (the step did not say to accept it)'}`,
        );
        void this.page.send('Page.handleJavaScriptDialog', { accept }).catch(() => undefined);
        break;
      }
    }
  }

  /** Wait for a page load in progress, then for the network to go quiet (bounded). */
  async settle(maxMs: number = FLOW_LIMITS.settleMs): Promise<void> {
    const start = Date.now();
    const deadline = start + CAPTURE_LIMITS.loadTimeoutMs;
    await sleep(60, this.signal);
    while (Date.now() < deadline) {
      const now = Date.now();
      if (!this.loading) {
        const quiet = now - Math.max(this.lastNetworkAt, this.loadSettledAt);
        if (this.inflight.size === 0 ? quiet >= 150 : quiet >= 500) return;
        // Long polls and streams never finish: stop waiting after a while.
        if (now - Math.max(start, this.loadSettledAt) > maxMs) return;
      }
      await sleep(50, this.signal);
    }
    this.note(`the page did not finish loading within ${CAPTURE_LIMITS.loadTimeoutMs / 1000}s`);
  }

  /** After an action: wait for the page to react; fail if it tried to leave this machine. */
  async afterAction(): Promise<void> {
    await this.settle();
    const blocked = this.blockedPage;
    this.blockedPage = null;
    if (blocked)
      throw new StepFailure(
        `This led to ${blocked}, which is not on this machine; only local pages are opened, so the flow cannot go on there.`,
      );
  }

  async navigate(url: string): Promise<void> {
    if (!isLocalUrl(url))
      throw new StepFailure(`${url} is not on this machine; only local pages are opened.`);
    this.status = null;
    this.blockedPage = null;
    this.loading = true;
    const nav = (await this.page.send('Page.navigate', { url })) as {
      errorText?: string;
      loaderId?: string;
    };
    // A change of the #fragment only loads nothing.
    if (!nav.loaderId) this.loading = false;
    if (nav.errorText) {
      this.loading = false;
      throw new StepFailure(
        nav.errorText === 'net::ERR_CONNECTION_REFUSED'
          ? `Nothing is listening at ${url} (connection refused). Is the dev server running?`
          : nav.errorText === 'net::ERR_BLOCKED_BY_CLIENT'
            ? `${url} redirects to a page that is not on this machine; only local pages are opened.`
            : `Could not open ${url}: ${nav.errorText}`,
      );
    }
    await this.settle();
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: RemoteObject; exceptionDetails?: { text: string } };
    if (r.exceptionDetails)
      throw new CaptureError(`The page script failed: ${r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  private async callOn<T>(objectId: string, fn: string, args: unknown[] = []): Promise<T> {
    const r = (await this.page.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    })) as { result: RemoteObject; exceptionDetails?: { text: string } };
    if (r.exceptionDetails)
      throw new CaptureError(`The page script failed: ${r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  private async locateOnce(target: Target): Promise<Attempt<Located> & { candidates?: string[] }> {
    const r = (await this.page.send('Runtime.evaluate', {
      expression: `${LOCATE}(${JSON.stringify(target)})`,
      returnByValue: false,
    })) as { result: RemoteObject; exceptionDetails?: { text: string } };
    if (r.exceptionDetails) return { ok: false, error: 'could not be searched for', retry: true };
    if (r.result.subtype === 'node' && r.result.objectId)
      return { ok: true, value: { objectId: r.result.objectId } };
    try {
      const e = JSON.parse(String(r.result.value)) as {
        error: string;
        retry: boolean;
        candidates?: string[];
      };
      return { ok: false, error: e.error, retry: e.retry, candidates: e.candidates ?? [] };
    } catch {
      return { ok: false, error: 'was not found', retry: true };
    }
  }

  /**
   * Find the element and run `act` on it, retrying both until the step's time runs out (the
   * element may not be there yet, may be disabled or covered for a moment).
   */
  private async withElement<T>(
    target: Target,
    timeoutMs: number,
    act: (el: Located) => Promise<Attempt<T>>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: string;
    let candidates: string[];
    for (;;) {
      const found = await this.locateOnce(target);
      let retry: boolean;
      if (found.ok) {
        candidates = [];
        const r = await act(found.value).catch((err: unknown) => {
          if (err instanceof StepFailure) throw err;
          // The element went away (re-rendered, page changed): look it up again.
          return { ok: false, error: 'changed while being used', retry: true } as const;
        });
        void this.page
          .send('Runtime.releaseObject', { objectId: found.value.objectId })
          .catch(() => undefined);
        if (r.ok) return r.value;
        last = r.error;
        retry = r.retry;
      } else {
        last = found.error;
        retry = found.retry;
        candidates = found.candidates ?? [];
      }
      if (!retry || Date.now() >= deadline) break;
      await sleep(100, this.signal);
    }
    const listed = candidates.length
      ? `\n${last.startsWith('matches') ? 'Matches' : 'Similar elements on the page'}:\n${candidates.map((c) => `  ${c}`).join('\n')}`
      : '';
    throw new StepFailure(`${describeTarget(target)} ${last}.${listed}`);
  }

  private async mouseClick(x: number, y: number): Promise<void> {
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async click(target: Target, timeoutMs: number): Promise<void> {
    let dropped = 0;
    await this.withElement(target, timeoutMs, async (el) => {
      const a = await this.callOn<{
        x?: number;
        y?: number;
        box?: number[];
        error?: string;
        retry?: boolean;
      }>(el.objectId, CLICK_POINT);
      if (a.error) return { ok: false, error: a.error, retry: !!a.retry };
      // Wait until it stops moving (animations, layout shifts) over two painted frames.
      await this.evaluate<boolean>(FRAMES);
      const b = await this.callOn<{ box?: number[] }>(el.objectId, CLICK_POINT);
      if (!b.box || b.box.join() !== a.box!.join())
        return { ok: false, error: 'kept moving', retry: true };
      await this.callOn(el.objectId, ARM);
      await this.mouseClick(a.x!, a.y!);
      // The browser answers once the page handled the press; false means it never arrived (a
      // new page not ready for input). Anything else, a new page included, counts as received.
      const pressed = await this.evaluate<boolean | undefined>(PRESSED).catch(() => undefined);
      if (pressed === false) {
        dropped++;
        return {
          ok: false,
          error: 'did not receive the click (the page was not ready)',
          retry: true,
        };
      }
      return { ok: true, value: undefined };
    });
    if (dropped)
      this.note(
        `the page did not receive the first click${dropped > 1 ? `s (${dropped})` : ''}; clicked again`,
      );
  }

  /** Clear the field and type the value (or set it, for date and range inputs). */
  async fill(target: Target, value: string, timeoutMs: number): Promise<{ password: boolean }> {
    return this.withElement(target, timeoutMs, async (el) => {
      const before = await this.callOn<string>(el.objectId, READ_VALUE);
      const f = await this.callOn<{
        mode?: 'type' | 'set';
        password?: boolean;
        error?: string;
        retry?: boolean;
      }>(el.objectId, FOCUS_FIELD);
      if (f.error) return { ok: false, error: f.error, retry: !!f.retry };
      if (f.mode === 'set') await this.callOn(el.objectId, SET_VALUE, [value]);
      else if (value === '') {
        await this.key(KEYS.Delete);
      } else {
        await this.page.send('Input.insertText', { text: value });
      }
      const now = await this.callOn<string>(el.objectId, READ_VALUE);
      // Nothing changed at all: the typing never arrived (a page not ready for input); retry.
      if (now === before && now !== value) {
        await this.evaluate<boolean>(FRAMES);
        return { ok: false, error: 'did not receive the typed text', retry: true };
      }
      if (now !== value && now.trim() !== value.trim())
        throw new StepFailure(
          f.password
            ? `${describeTarget(target)} did not take the typed value (password field, value not shown); a length limit or input filter may have changed it.`
            : `${describeTarget(target)} shows ${q(now)} instead of ${q(value)} after typing; a length limit, mask or input filter may have changed it.`,
        );
      return { ok: true, value: { password: !!f.password } };
    });
  }

  async select(target: Target, option: string, timeoutMs: number): Promise<string> {
    return this.withElement(target, timeoutMs, async (el) => {
      const r = await this.callOn<{ selected?: string; error?: string; retry?: boolean }>(
        el.objectId,
        SELECT_OPTION,
        [option],
      );
      return r.error
        ? { ok: false, error: r.error, retry: !!r.retry }
        : { ok: true, value: r.selected! };
    });
  }

  /** Check or uncheck; already in that state is fine (noted). */
  async setChecked(target: Target, checked: boolean, timeoutMs: number): Promise<void> {
    const already = await this.withElement(target, timeoutMs, async (el) => ({
      ok: true,
      value: (await this.callOn<boolean>(el.objectId, IS_CHECKED)) === checked,
    }));
    if (already) {
      this.note(`${describeTarget(target)} was already ${checked ? 'checked' : 'unchecked'}`);
      return;
    }
    await this.click(target, timeoutMs);
    await sleep(60, this.signal);
    const now = await this.withElement(target, timeoutMs, async (el) => ({
      ok: true,
      value: await this.callOn<boolean>(el.objectId, IS_CHECKED),
    }));
    if (now !== checked)
      throw new StepFailure(
        `${describeTarget(target)} is still ${now ? 'checked' : 'unchecked'} after clicking it.`,
      );
  }

  private async key(k: (typeof KEYS)[FlowKey]): Promise<void> {
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
      modifiers: k.modifiers ?? 0,
    };
    await this.page.send('Input.dispatchKeyEvent', {
      ...base,
      type: k.text ? 'keyDown' : 'rawKeyDown',
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });
    await this.page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async press(key: FlowKey, target: Target | undefined, timeoutMs: number): Promise<void> {
    if (target)
      await this.withElement(target, timeoutMs, async (el) => {
        await this.callOn(el.objectId, FOCUS);
        return { ok: true, value: undefined };
      });
    await this.key(KEYS[key]);
  }

  /** Poll a condition until it holds or the time runs out; the last reason is returned. */
  private async until(
    timeoutMs: number,
    check: () => Promise<string | null>,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const why = await check();
      if (why === null || Date.now() >= deadline) return why;
      await sleep(100, this.signal);
    }
  }

  async expect(step: Extract<FlowStep, { action: 'expect' }>, timeoutMs: number): Promise<void> {
    const absent = !!step.absent;
    let why: string | null;
    if (step.url !== undefined) {
      const want = step.url;
      why = await this.until(timeoutMs, async () => {
        const href = await this.evaluate<string>('location.href');
        return href.includes(want) !== absent ? null : `the address is ${href}`;
      });
    } else if (step.target) {
      const target = step.target;
      why = await this.until(timeoutMs, async () => {
        const found = await this.locateOnce(target);
        if (found.ok)
          void this.page
            .send('Runtime.releaseObject', { objectId: found.value.objectId })
            .catch(() => undefined);
        if (absent) return found.ok ? `${describeTarget(target)} is still shown` : null;
        if (!found.ok) return `${describeTarget(target)} ${found.error}`;
        if (step.value === undefined) return null;
        const value = await this.callOn<string>(found.value.objectId, READ_VALUE).catch(() => '');
        return value === step.value ? null : `${describeTarget(target)} has the value ${q(value)}`;
      });
    } else {
      const want = (step.text ?? '').replace(/\s+/g, ' ').trim();
      let caseOnly = false;
      why = await this.until(timeoutMs, async () => {
        const text = (await this.evaluate<string>(PAGE_TEXT)).replace(/\s+/g, ' ');
        const has = text.includes(want);
        caseOnly = !has && text.toLowerCase().includes(want.toLowerCase());
        if (has !== absent) return null;
        return absent ? `the page still shows ${q(want)}` : `the page does not show ${q(want)}`;
      });
      if (why && caseOnly) why += ' (it does with different capitalisation)';
    }
    if (why) throw new StepFailure(`Expectation failed: ${why}.`);
  }

  async screenshot(): Promise<Buffer | null> {
    try {
      const shot = (await this.page.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: FLOW_LIMITS.jpegQuality,
      })) as { data: string };
      return Buffer.from(shot.data, 'base64');
    } catch {
      return null;
    }
  }

  async where(): Promise<{ url: string | null; title: string | null }> {
    try {
      const [title, url] = JSON.parse(
        await this.evaluate<string>('JSON.stringify([document.title, location.href])'),
      ) as [string, string];
      return { url, title };
    } catch {
      return { url: null, title: null };
    }
  }

  async outline(limit = 120): Promise<PageOutline> {
    return JSON.parse(await this.evaluate<string>(`${OUTLINE}(${limit})`)) as PageOutline;
  }

  get pageStatus(): number | null {
    return this.status;
  }

  setAcceptDialog(accept: boolean): void {
    this.acceptDialog = accept;
  }
}

/** Resolve a goto step's URL against the current page; local pages only. */
export function stepUrl(url: string, base: string): string {
  return new URL(url, base).toString();
}

/**
 * Run the steps in a fresh page. Stops at the first failing step (the rest are skipped); every
 * step that ran has a screenshot.
 */
export async function runFlow(
  page: PageSession,
  startUrl: string,
  steps: FlowStep[],
  opts: {
    signal?: AbortSignal;
    /** Refuse a page address (e.g. Friday's own server); returns the reason. */
    refuseUrl?: (url: string) => string | null;
    onStep?: (s: StepResult) => void;
  } = {},
): Promise<FlowResult> {
  const started = Date.now();
  const driver = new PageDriver(page, opts.signal);
  const results: StepResult[] = [];
  let status: FlowResult['status'] = 'passed';
  let outline: PageOutline | null = null;
  await driver.start();
  // The start page is step 0 in effect: opening it is part of the first step.
  const all: FlowStep[] = [{ action: 'goto', url: startUrl }, ...steps];
  for (let i = 0; i < all.length; i++) {
    const step = all[i]!;
    const t0 = Date.now();
    const timeout = Math.min(
      step.timeout_ms ?? FLOW_LIMITS.defaultStepTimeoutMs,
      FLOW_LIMITS.maxStepTimeoutMs,
    );
    let error: string | null = null;
    try {
      if (Date.now() - started > FLOW_LIMITS.maxTotalMs)
        throw new StepFailure(`The flow took longer than ${FLOW_LIMITS.maxTotalMs / 1000}s.`);
      driver.setAcceptDialog(
        (step.action === 'click' || step.action === 'press') && !!step.accept_dialog,
      );
      switch (step.action) {
        case 'goto': {
          const current = (await driver.where()).url;
          const url = stepUrl(step.url, current && isLocalUrl(current) ? current : startUrl);
          const refused = opts.refuseUrl?.(url);
          if (refused) throw new StepFailure(refused);
          await driver.navigate(url);
          const code = driver.pageStatus;
          if (code !== null && code >= 400)
            throw new StepFailure(`The page answered HTTP ${code}.`);
          break;
        }
        case 'click':
          await driver.click(step.target, timeout);
          await driver.afterAction();
          break;
        case 'fill':
          await driver.fill(step.target, step.value, timeout);
          await driver.afterAction();
          break;
        case 'select':
          await driver.select(step.target, step.option, timeout);
          await driver.afterAction();
          break;
        case 'check':
        case 'uncheck':
          await driver.setChecked(step.target, step.action === 'check', timeout);
          await driver.afterAction();
          break;
        case 'press':
          await driver.press(step.key, step.target, timeout);
          await driver.afterAction();
          break;
        case 'wait':
          await sleep(Math.min(step.ms, FLOW_LIMITS.maxWaitMs), opts.signal);
          break;
        case 'expect':
          await driver.expect(step, timeout);
          break;
      }
    } catch (err) {
      if (opts.signal?.aborted) {
        status = 'cancelled';
        error = 'Cancelled.';
      } else if (err instanceof StepFailure || err instanceof CaptureError) {
        error = err.message;
      } else throw err;
    }
    const reports = driver.takeReports();
    const cancelled = status === 'cancelled';
    const where = cancelled ? { url: null, title: null } : await driver.where();
    const result: StepResult = {
      index: i,
      label: i === 0 ? `Open ${startUrl}` : describeStep(step),
      status: error ? 'failed' : 'passed',
      durationMs: Date.now() - t0,
      ...where,
      problems: reports.problems,
      notes: reports.notes,
      error,
      image: cancelled ? null : await driver.screenshot(),
    };
    results.push(result);
    opts.onStep?.(result);
    if (error) {
      if (!cancelled) {
        status = 'failed';
        outline = await driver.outline(60).catch(() => null);
      }
      for (let j = i + 1; j < all.length; j++)
        results.push({
          index: j,
          label: describeStep(all[j]!),
          status: 'skipped',
          durationMs: 0,
          url: null,
          title: null,
          problems: [],
          notes: [],
          error: null,
          image: null,
        });
      break;
    }
  }
  return { status, steps: results, durationMs: Date.now() - started, outline };
}

/** Open a page and describe what is on it (inspect_page). */
export async function inspect(
  page: PageSession,
  url: string,
  signal?: AbortSignal,
): Promise<{ outline: PageOutline; status: number | null; problems: string[]; notes: string[] }> {
  const driver = new PageDriver(page, signal);
  await driver.start();
  try {
    await driver.navigate(url);
  } catch (err) {
    if (err instanceof StepFailure) throw new CaptureError(err.message);
    throw err;
  }
  const outline = await driver.outline();
  return { outline, status: driver.pageStatus, ...driver.takeReports() };
}
