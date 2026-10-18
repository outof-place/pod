// Fork-only (Pod): what co-browse tells an agent about a marked element, read in the page by one
// read-only function (Runtime.callFunctionOn) and checked again here before it leaves the runtime.
import { COBROWSE_LIMITS, type CobrowseElement } from '../../../shared/browser-cobrowse-types'
import { GRAB_SECRET_PATTERNS } from '../../../shared/browser-grab-types'
import { grabContainsSecret, sanitizeGrabUrl } from '../../browser/browser-grab-payload'
import { rec, str, type CobrowseCdp } from './pod-browser-cobrowse-cdp'

// Runs on the element itself (Runtime.callFunctionOn), returns plain data and changes nothing.
export const COBROWSE_READ_ELEMENT = `function (limits) {
  var el = this && this.nodeType === 1 ? this : this && this.parentElement;
  if (!el) return null;
  var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
  function esc(v) { return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; }); }
  function stable(v) { return v && v.length < 40 && !/[0-9]{3,}|[0-9a-f]{8,}|^css-|^sc-|__/i.test(v); }
  function part(e) {
    var tag = e.tagName.toLowerCase();
    if (stable(e.id)) return tag + '#' + esc(e.id);
    var classes = Array.prototype.filter.call(e.classList || [], stable).slice(0, 2);
    return tag + classes.map(function (c) { return '.' + esc(c); }).join('');
  }
  function unique(selector) { try { return root.querySelectorAll(selector).length === 1; } catch (e) { return false; } }
  function nth(e) {
    var index = 1, s = e.previousElementSibling, more = false;
    while (s) { if (s.tagName === e.tagName) index++; s = s.previousElementSibling; }
    s = e.nextElementSibling;
    while (s) { if (s.tagName === e.tagName) { more = true; break; } s = s.nextElementSibling; }
    return index > 1 || more ? ':nth-of-type(' + index + ')' : '';
  }
  var path = [], current = el;
  while (current && current.nodeType === 1 && path.length < 12) {
    var plain = part(current);
    if (unique([plain].concat(path).join(' > '))) { path.unshift(plain); break; }
    path.unshift(plain + nth(current));
    if (unique(path.join(' > '))) break;
    current = current.parentElement;
  }
  // Text and excerpt by one walk over the live nodes (no clone: it would run custom element
  // constructors): no script, style, noscript or template content, no event handlers, no values
  // of password or hidden inputs, secret-looking attribute values redacted, URLs without query.
  var SKIP = { script: 1, style: 1, noscript: 1, template: 1 };
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var INLINE = { a: 1, abbr: 1, b: 1, code: 1, em: 1, i: 1, kbd: 1, label: 1, mark: 1, s: 1, small: 1, span: 1, strong: 1, sub: 1, sup: 1, u: 1 };
  var secrets = limits.secrets || [];
  function secret(v) { var l = v.toLowerCase(); for (var i = 0; i < secrets.length; i++) { if (l.indexOf(secrets[i]) !== -1) return true; } return false; }
  function bare(v) { var i = v.search(/[?#]/); return i === -1 ? v : v.slice(0, i); }
  function escText(v) { return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function open(e, tag) {
    var out = '<' + tag, type = String(e.getAttribute('type') || '').toLowerCase();
    for (var i = 0; i < e.attributes.length; i++) {
      var a = e.attributes[i], n = a.name.toLowerCase(), v = a.value;
      if (n.slice(0, 2) === 'on') continue;
      if (n === 'value' && tag === 'input' && (type === 'password' || type === 'hidden')) v = '';
      else if (secret(v)) v = '[redacted]';
      else if (n === 'href' || n === 'src' || n === 'action') v = bare(v);
      out += ' ' + n + '="' + escText(v).replace(/"/g, '&quot;') + '"';
    }
    return out + '>';
  }
  var parts = [], textLength = 0, textBudget = 4 * limits.text, html = '', full = false, visits = 0;
  function emit(v) {
    if (full) return;
    if (html.length + v.length > limits.html) { html += v.slice(0, limits.html - html.length) + '...'; full = true; } else html += v;
  }
  function walk(node) {
    if ((full && textLength >= textBudget) || ++visits > 20000) return;
    if (node.nodeType === 3) {
      if (textLength < textBudget) { parts.push(node.data); textLength += node.data.length; }
      emit(escText(node.data));
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = String(node.localName || node.nodeName).toLowerCase();
    if (SKIP[tag]) return;
    emit(open(node, tag));
    if (VOID[tag]) return;
    if (!INLINE[tag]) parts.push(' ');
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
    if (!INLINE[tag]) parts.push(' ');
    emit('</' + tag + '>');
  }
  walk(el);
  var text = parts.join('').replace(/\\s+/g, ' ').trim().slice(0, limits.text);
  var win = el.ownerDocument && el.ownerDocument.defaultView;
  var frameUrl = null;
  try { if (win && win !== win.top) frameUrl = String(win.location.href); } catch (e) {}
  var inShadowRoot = !!(root && root.nodeType === 11 && root.host);
  return { tag: el.tagName.toLowerCase(), selector: path.join(' > ').slice(0, limits.selector), text: text, html: html, frameUrl: frameUrl, inShadowRoot: inShadowRoot };
}`

// Main side again, as Grab's payload check does (the page could lie): no handlers, secret values out.
export function redactExcerpt(html: string): string {
  return html.replace(/\s([^\s"'<>/=]+)="([^"]*)"/g, (whole, name: string, value: string) =>
    /^on/i.test(name) ? '' : grabContainsSecret(value) ? ` ${name}="[redacted]"` : whole
  )
}

/** What the element is, for an agent: a selector, its role and name, text and a DOM excerpt. */
export async function readElement(
  cdp: CobrowseCdp,
  backendNodeId: number
): Promise<CobrowseElement | null> {
  let objectId: string | undefined
  try {
    objectId = str(rec(rec(await cdp('DOM.resolveNode', { backendNodeId })).object).objectId)
    if (!objectId) {
      return null
    }
    const [read, ax] = await Promise.all([
      cdp('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: COBROWSE_READ_ELEMENT,
        arguments: [{ value: { ...COBROWSE_LIMITS, secrets: GRAB_SECRET_PATTERNS } }],
        returnByValue: true,
        silent: true
      }),
      cdp('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }).catch(
        () => null
      )
    ])
    const value = rec(rec(rec(read).result).value)
    const selector = str(value.selector)
    if (!selector) {
      return null
    }
    const nodes = rec(ax).nodes
    const node = rec(
      Array.isArray(nodes)
        ? nodes.find((n) => rec(n).ignored !== true && rec(n).backendDOMNodeId === backendNodeId)
        : undefined
    )
    const role = str(rec(node.role).value) ?? null
    const name = str(rec(node.name).value) || null
    const text = str(value.text) ?? ''
    const frameUrl = str(value.frameUrl)
    return {
      tag: str(value.tag) ?? '',
      selector,
      text: grabContainsSecret(text) ? '[redacted]' : text,
      html: redactExcerpt(str(value.html) ?? ''),
      frameUrl: frameUrl ? sanitizeGrabUrl(frameUrl) || null : null,
      inShadowRoot: value.inShadowRoot === true,
      role,
      name: name ? name.slice(0, COBROWSE_LIMITS.label) : null
    }
  } catch {
    return null
  } finally {
    if (objectId) {
      void cdp('Runtime.releaseObject', { objectId }).catch(() => {})
    }
  }
}
