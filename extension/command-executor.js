// This function is injected into the active tab. It deliberately never reads a
// control's value: remote control may write, but cannot use form contents as
// an input channel.
export function executeBrowserCommand(command) {
  const textOf = (element) => [element?.innerText, element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('placeholder'), element?.getAttribute?.('name'), element?.getAttribute?.('id')].filter(Boolean).join(' ').toLowerCase();
  const dangerous = /(?:password|passcode|mfa|2fa|otp|verification|verify|one[ -]?time|security.?code)/i;
  const finalAction = /(?:save|submit|send|delete|archive|remove|upload|e-?sign|sign(?:\s|$)|buy|purchase|checkout|place order|confirm)/i;
  const simpleLiveSelector = /^(?:\*|[a-z][a-z0-9-]*|\[(?:role|aria-label|data-automationid)(?:\*?=(?:"[^"]{1,120}"|'[^']{1,120}'|[a-z0-9_ -]{1,120}))?\])$/i;
  const pressKeys = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace']);
  const cssEscape = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const isActionControl = (element) => Boolean(element?.matches?.('button,a,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'));
  const actionControlFor = (element) => isActionControl(element) ? element : element?.closest?.('button,a,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]');
  const isVisible = (element) => {
    if (!element || element.hidden || element.getAttribute?.('hidden') !== null || element.getAttribute?.('aria-hidden') === 'true') return false;
    const style = globalThis.getComputedStyle?.(element);
    return style?.display !== 'none' && style?.visibility !== 'hidden';
  };
  const isFormOrEditable = (element) => Boolean(element?.matches?.('input,textarea,select,option,[contenteditable="true"]'));
  const liveText = (element) => String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const findLive = (selector) => {
    if (typeof selector !== 'string' || selector.length > 256 || !simpleLiveSelector.test(selector)) return { ok: false, error: 'Live element discovery accepts only a bounded simple selector.' };
    let elements;
    try { elements = document.querySelectorAll(selector); } catch { return { ok: false, error: 'Live element discovery rejected the selector.' }; }
    const matches = [];
    for (const element of elements) {
      if (matches.length >= 25 || !isVisible(element) || isFormOrEditable(element)) continue;
      const unsafe = Boolean(actionControlFor(element) && finalAction.test(textOf(actionControlFor(element))));
      const match = { tag: String(element.tagName || '').toLowerCase().slice(0, 40), text: liveText(element), ...(unsafe ? { unsafe: true } : {}) };
      if (!unsafe) {
        const ref = `work-edge-${Date.now().toString(36)}-${matches.length}`;
        element.setAttribute?.('data-work-edge-ref', ref);
        match.ref = ref;
      }
      matches.push(match);
    }
    return { ok: true, result: { selector, matches } };
  };
  const keyCode = (key) => ({ Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Backspace: 'Backspace' })[key];
  const dispatch = (target, type, init, Constructor) => {
    const EventConstructor = Constructor || globalThis.Event;
    let event;
    try { event = new EventConstructor(type, init); } catch { event = new Event(type, init); }
    return target.dispatchEvent?.(event);
  };
  const activate = (element) => {
    try { element.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch { /* A detached or shimmed element can reject scrolling. */ }
    let rect = null;
    try { rect = element.getBoundingClientRect?.(); } catch { /* Coordinate fallback below is safe for detached elements. */ }
    const finite = (value) => Number.isFinite(value) ? value : 0;
    const left = finite(rect?.left);
    const top = finite(rect?.top);
    const width = Math.max(0, finite(rect?.width));
    const height = Math.max(0, finite(rect?.height));
    const clientX = Math.max(0, Math.round(left + (width / 2)));
    const clientY = Math.max(0, Math.round(top + (height / 2)));
    const pageX = clientX + Math.max(0, finite(globalThis.scrollX));
    const pageY = clientY + Math.max(0, finite(globalThis.scrollY));
    const screenX = clientX + Math.max(0, finite(globalThis.screenX));
    const screenY = clientY + Math.max(0, finite(globalThis.screenY));
    element.focus?.();
    const coordinates = { clientX, clientY, pageX, pageY, screenX, screenY };
    const pointerInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...coordinates };
    const mouseInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, detail: 1, ...coordinates };
    dispatch(element, 'pointerdown', pointerInit, globalThis.PointerEvent || globalThis.MouseEvent);
    dispatch(element, 'mousedown', mouseInit, globalThis.MouseEvent);
    dispatch(element, 'pointerup', { ...pointerInit, buttons: 0 }, globalThis.PointerEvent || globalThis.MouseEvent);
    dispatch(element, 'mouseup', { ...mouseInit, buttons: 0 }, globalThis.MouseEvent);
    dispatch(element, 'click', { ...mouseInit, buttons: 0 }, globalThis.MouseEvent);
    // Older test/page shims may not implement dispatchEvent. Native click is
    // only a compatibility fallback; browsers receive the full SPA sequence.
    if (!element.dispatchEvent && typeof element.click === 'function') element.click();
  };
  const press = (element, key) => {
    const init = { key, code: keyCode(key), bubbles: true, cancelable: true, composed: true };
    for (const type of ['keydown', 'keypress', 'keyup']) dispatch(element, type, init, globalThis.KeyboardEvent);
  };
  const locate = (target) => {
    if (!target) return null;
    if (target.ref) return document.querySelector(`[data-work-edge-ref="${cssEscape(target.ref)}"]`) || document.querySelector(`#${cssEscape(target.ref)}`);
    if (target.selector) return document.querySelector(target.selector);
    const wanted = target.targetText.toLowerCase();
    // Gmail renders inbox subjects inside table/ARIA rows rather than a
    // clickable link or button. Include row containers so targetText can open
    // a read-only thread without relying on Gmail-specific private selectors.
    return [...document.querySelectorAll('button,a,label,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="row"],[role="listitem"],tr,[data-thread-id],[data-automationid*="row" i]')].find((element) => textOf(element).includes(wanted)) || null;
  };
  const refuse = (element, action) => {
    const descriptor = textOf(element);
    if (element?.matches?.('input[type="password"],input[type="hidden"], [hidden]') || dangerous.test(descriptor)) return 'Refused: password, hidden, MFA, or verification fields cannot be controlled remotely.';
    const actionControl = actionControlFor(element);
    if ((action === 'click' || action === 'press') && actionControl && finalAction.test(textOf(actionControl))) return 'Refused: final action controls are blocked by Work Edge.';
    return null;
  };
  try {
    if (!command || typeof command.type !== 'string') throw new Error('Invalid command.');
    if (command.type === 'find') return findLive(command.selector);
    if (command.type === 'scroll') { const amount = Number(command.amount) || 400; const axis = command.direction === 'left' || command.direction === 'right' ? { left: command.direction === 'left' ? -amount : amount } : { top: command.direction === 'up' ? -amount : amount }; window.scrollBy({ ...axis, behavior: 'smooth' }); return { ok: true, result: { scrolled: true } }; }
    if (command.type === 'wait') return new Promise((resolve) => setTimeout(() => resolve({ ok: true, result: { waitedMs: command.ms } }), command.ms));
    if (command.type === 'navigate') { if (/(?:save|submit|send|delete|archive|remove|upload|e-?sign|sign(?:\s|$)|buy|purchase|checkout|place order|confirm)/i.test(command.url)) return { ok: false, error: 'Refused: this navigation appears to be a blocked final action.' }; location.assign(command.url); return { ok: true, result: { navigating: true } }; }
    const element = command.type === 'press' && !command.target ? document.activeElement || document : locate(command.target);
    if (!element) return { ok: false, error: 'Target element was not found.' };
    const refusal = refuse(element, command.type);
    if (refusal) return { ok: false, error: refusal };
    if (command.type === 'click') { activate(element); return { ok: true, result: { clicked: true } }; }
    if (command.type === 'press') {
      if (!pressKeys.has(command.key)) return { ok: false, error: 'Unsupported key.' };
      element.focus?.(); press(element, command.key); return { ok: true, result: { pressed: command.key } };
    }
    if (command.type === 'type') {
      if (!element.matches('input,textarea,[contenteditable="true"]')) return { ok: false, error: 'Target is not a writable text field.' };
      element.focus();
      if (element.isContentEditable) element.textContent = command.text;
      else { element.value = command.text; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }
      return { ok: true, result: { typed: true, characters: command.text.length } };
    }
    if (command.type === 'select') {
      if (!(element instanceof HTMLSelectElement)) return { ok: false, error: 'Target is not a select element.' };
      const option = [...element.options].find((item) => command.value !== undefined ? item.value === command.value : item.textContent.trim() === command.optionText);
      if (!option) return { ok: false, error: 'Requested option was not found.' };
      element.value = option.value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, result: { selected: true } };
    }
    return { ok: false, error: 'Unsupported command.' };
  } catch (error) { return { ok: false, error: error.message || 'Command execution failed.' }; }
}

// This function is injected as a self-contained verified-action executor. It
// may read current form values only inside the page execution world to compute
// a state hash. Pre-action values are never returned to the extension or broker.
export async function executeVerifiedActionCommand(command) {
  const descriptor = (element) => [element?.innerText, element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('placeholder'), element?.getAttribute?.('name'), element?.getAttribute?.('id')].filter(Boolean).join(' ');
  const dangerous = /(?:password|passcode|mfa|2fa|otp|verification|one[ -]?time|security.?code)/i;
  const finalAction = /(?:save|submit|send|archive|upload|e-?sign|sign(?:\s|$)|confirm)/i;
  const cssEscape = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const locate = (target) => {
    if (!target || typeof target !== 'object') return null;
    if (target.ref) return document.querySelector(`[data-work-edge-ref="${cssEscape(target.ref)}"]`) || document.querySelector(`#${cssEscape(target.ref)}`);
    if (target.selector) { try { return document.querySelector(target.selector); } catch { return null; } }
    if (target.targetText) {
      const wanted = target.targetText.toLowerCase();
      return [...document.querySelectorAll('button,input,textarea,select,[contenteditable="true"],[role="button"]')].find((element) => descriptor(element).toLowerCase().includes(wanted)) || null;
    }
    return null;
  };
  const valueOf = (element) => element?.isContentEditable ? String(element.textContent || '') : String(element?.value ?? '');
  const assertField = (step) => {
    const element = locate(step.locator);
    if (!element) throw new Error(`Verified field was not found: ${step.field}`);
    if (element.matches?.('input[type="password"],input[type="hidden"],[hidden]') || dangerous.test(descriptor(element))) throw new Error(`Sensitive field cannot be used in a verified action: ${step.field}`);
    if (!element.matches?.('input,textarea,select,[contenteditable="true"]')) throw new Error(`Verified target is not a supported field: ${step.field}`);
    return element;
  };
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  const hash = async (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const observe = () => [...command.steps]
    .map((step) => ({ field: step.field, value: valueOf(assertField(step)) }))
    .sort((left, right) => left.field.localeCompare(right.field));
  const setValue = (element, step) => {
    const value = step.to === null ? '' : String(step.to);
    if (element.matches?.('select')) {
      const option = [...element.options].find((item) => item.value === value || item.textContent?.trim() === value);
      if (!option) throw new Error(`Verified option was not found: ${step.field}`);
      element.value = option.value;
    } else if (element.isContentEditable) element.textContent = value;
    else element.value = value;
    element.dispatchEvent?.(new Event('input', { bubbles: true }));
    element.dispatchEvent?.(new Event('change', { bubbles: true }));
  };
  try {
    if (!command || !['verified_preflight', 'verified_apply', 'verified_verify'].includes(command.type) || !Array.isArray(command.steps) || !command.steps.length) throw new Error('Invalid verified action command.');
    const current = observe();
    const currentBeforeHash = await hash(current);
    if (command.type === 'verified_preflight') return { ok: true, result: { currentBeforeHash, fields: current.map((item) => item.field) } };
    if (!/^[a-f0-9]{64}$/.test(command.proposalHash || '') || command.approval?.proposalHash !== command.proposalHash) throw new Error('Verified approval binding is invalid.');
    if (command.type === 'verified_verify') {
      return { ok: true, result: { persistedChanges: current.map((item) => ({ field: item.field, to: item.value })), method: 'dom-value-after-commit' } };
    }
    if (currentBeforeHash !== command.expectedBeforeHash) throw new Error('Pre-action state changed after approval.');
    for (const step of command.steps) setValue(assertField(step), step);
    const commit = locate(command.commit);
    if (!commit || !commit.matches?.('button,input[type="submit"],[role="button"]') || !finalAction.test(descriptor(commit))) throw new Error('Verified commit control was not found or is not an explicit final action.');
    commit.click?.();
    return { ok: true, result: { currentBeforeHash, committed: true } };
  } catch (error) { return { ok: false, error: error.message || 'Verified action failed.' }; }
}
