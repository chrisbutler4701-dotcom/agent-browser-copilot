(() => {
  const excludedSelector = 'input, textarea, select, option, [contenteditable], script, style, noscript';
  const mailboxListMarkers = /\b1[–-]50 of\b|Conversationsunread|AllNoneReadUnread|LabelsInbox/;

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function composedText(node) {
    const parts = [];
    const append = (value) => {
      const text = String(value || '').trim();
      if (text) parts.push(text);
    };
    const visit = (current) => {
      if (!current) return;
      if (current.nodeType === Node.TEXT_NODE) {
        append(current.nodeValue);
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE && current.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      const element = current.nodeType === Node.ELEMENT_NODE ? current : null;
      if (element && (!isVisible(element) || element.matches(excludedSelector))) return;
      for (const child of current.childNodes) visit(child);
      // cloneNode(...).innerText omits shadow trees. Fluent/Outlook renders
      // virtualized mail rows in open shadow roots, so compose their text too.
      if (element?.shadowRoot) visit(element.shadowRoot);
    };
    visit(node);
    return parts.join('\n').trim();
  }

  function sanitizedText(element) {
    // Traverse the composed tree so open shadow roots are included while form
    // controls, editable regions, hidden, and aria-hidden nodes stay excluded.
    return composedText(element);
  }

  function hasMessageSurface(main) {
    return main.querySelectorAll('[role="document"], [role="article"], article, [data-message-id], [data-app-section="ReadingPane"], [aria-label*="Reading Pane" i], [aria-label*="Message body" i], [data-testid*="reading" i], [data-automationid*="ReadingPane" i], .adn, .a3s, .ii.gt').length > 0;
  }

  function gmailThreadText() {
    // Gmail leaves its mailbox list mounted while a conversation is open. Its
    // message-body nodes are much narrower and safer than cloning main/article.
    const bodies = Array.from(document.querySelectorAll('.a3s, .ii.gt'))
      .filter(isVisible)
      .map(sanitizedText)
      .filter((text) => text.length >= 12 && !mailboxListMarkers.test(text));
    const uniqueBodies = [...new Set(bodies)];
    if (!uniqueBodies.length) return '';

    const usableHeading = (element) => {
      const text = sanitizedText(element);
      return text.length >= 3 && text.length <= 500 && !mailboxListMarkers.test(text) ? text : '';
    };
    const gmailSubjects = Array.from(document.querySelectorAll('h2.hP, h1.hP'))
      .filter(isVisible)
      .map(usableHeading)
      .filter(Boolean);
    const headings = gmailSubjects.length ? gmailSubjects : Array.from(document.querySelectorAll('h2, h1, [role="heading"]'))
      .filter(isVisible)
      .map(usableHeading)
      .filter(Boolean);
    // Gmail's hP heading is the conversation subject. The first usable heading
    // remains a resilient fallback for layout variants.
    const subject = headings[0] || '';
    return [subject, ...uniqueBodies].filter(Boolean).join('\n');
  }

  function preferredMessageSurface() {
    // These combine durable accessibility semantics with Gmail's message-body
    // markers. A main region alone is only used when it contains a message-like
    // child; mail applications commonly keep the mailbox list mounted beside it.
    const candidates = [
      // Outlook's Fluent layouts vary by tenant and rollout. Prefer its
      // narrow reading-pane/body containers so an open message beats the
      // still-mounted folder list or its "Nothing is selected" empty pane.
      ['[data-app-section="ReadingPane"]', 140],
      ['[aria-label*="Reading Pane" i], [aria-label*="Message body" i]', 140],
      ['[data-automationid*="ReadingPane" i]', 135],
      ['[data-testid*="reading" i]', 130],
      ['[role="document"]', 95],
      ['[role="article"], article', 90],
      ['[data-message-id]', 100],
      ['.adn', 110],
      ['.a3s, .ii.gt', 120],
      ['[role="main"], main', 20]
    ];
    let selected = null;
    for (const [selector, score] of candidates) {
      for (const element of document.querySelectorAll(selector)) {
        if (!isVisible(element) || ((selector === '[role="main"], main') && !hasMessageSurface(element))) continue;
        const text = sanitizedText(element);
        // A short label, empty pane, or hidden template is not enough evidence
        // to discard the complete page context.
        if (text.length < 12) continue;
        // A nested message can sometimes inherit an outer Gmail shell. Never
        // let that beat a clean message surface merely because it is larger.
        const candidate = { element, score: score - (mailboxListMarkers.test(text) ? 200 : 0), textLength: text.length };
        if (!selected || candidate.score > selected.score || (candidate.score === selected.score && candidate.textLength > selected.textLength)) selected = candidate;
      }
    }
    return selected?.element || null;
  }

  const gmailText = gmailThreadText();
  const readable = gmailText ? null : (preferredMessageSurface() || document.body);
  const visibleText = (gmailText || sanitizedText(readable) || '').slice(0, 20000);
  // These are signal names only. Values, labels tied to controls, and the
  // controls themselves never cross this boundary.
  const sensitiveSignals = [
    /\b(?:password|passcode)\b/i.test(visibleText) && 'password',
    /\b(?:mfa|two[- ]factor|verification code|one[- ]time code|authenticator)\b/i.test(visibleText) && 'mfa',
    /\b(?:sign in|log in|login|account security)\b/i.test(visibleText) && 'account'
  ].filter(Boolean);
  return {
  title: document.title,
  url: location.href,
  text: visibleText,
  // Deliberately omit form values, cookies, storage, and network data.
  // Form controls are excluded completely, including hidden and password inputs.
  elementSummary: Array.from(document.querySelectorAll('a, button'))
    .slice(0, 250)
    .map((element) => ({ tag: element.tagName.toLowerCase(), text: (element.innerText || element.getAttribute('aria-label') || '').slice(0, 200) })),
  sensitiveSignals
  };
})();
