/**
 * In-browser JavaScript snippets for DOM operations.
 *
 * These scripts are injected via Runtime.evaluate (CDP) or script.evaluate (BiDi).
 * They run in the page context and must be self-contained.
 */

/**
 * Element picker — returns a Promise that resolves when the user clicks an element.
 * The result is a JSON string with tag, attributes, selector, text, and bounding box.
 */
export const ELEMENT_PICKER_JS = `
(function() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = '__bc_picker_overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;cursor:crosshair;';

    const highlight = document.createElement('div');
    highlight.id = '__bc_picker_highlight';
    highlight.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #4A90D9;background:rgba(74,144,217,0.15);z-index:2147483646;display:none;';
    document.body.appendChild(highlight);

    let lastTarget = null;

    overlay.addEventListener('mousemove', (e) => {
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'auto';
      if (el && el !== overlay && el !== highlight) {
        lastTarget = el;
        const rect = el.getBoundingClientRect();
        highlight.style.left = rect.left + 'px';
        highlight.style.top = rect.top + 'px';
        highlight.style.width = rect.width + 'px';
        highlight.style.height = rect.height + 'px';
        highlight.style.display = 'block';
      }
    });

    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.remove();
      highlight.remove();

      if (!lastTarget) {
        resolve(JSON.stringify({ error: 'No element selected' }));
        return;
      }

      const el = lastTarget;
      const rect = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;

      // Generate CSS selector
      let selector = el.tagName.toLowerCase();
      if (el.id) selector += '#' + el.id;
      for (const cls of el.classList) selector += '.' + cls;

      // If selector is not unique, add nth-child
      if (!el.id && document.querySelectorAll(selector).length > 1) {
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const idx = siblings.indexOf(el) + 1;
          selector += ':nth-child(' + idx + ')';
        }
      }

      resolve(JSON.stringify({
        tagName: el.tagName.toLowerCase(),
        attributes: attrs,
        textContent: (el.textContent || '').trim().slice(0, 200),
        cssSelector: selector,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        nodeId: 0
      }));
    });

    document.body.appendChild(overlay);
  });
})()
`;

/**
 * Get the bounding box of an element as a JSON string.
 * Returns null if the element is not found.
 */
export function getBoundingBoxScript(selector: string): string {
  return `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    })()
  `;
}

/**
 * Get rendered DOM HTML, with shadow DOM support.
 *
 * Uses Element.getHTML({ shadowRoots }) when available (Chrome 124+, Firefox 128+).
 * Falls back to outerHTML for older browsers.
 *
 * @param selector - CSS selector for a specific element (optional)
 * @param depth - Maximum depth to traverse (optional)
 */
export function getRenderedDomScript(selector?: string, depth?: number): string {
  // Helper function that serializes an element, flattening shadow roots inline.
  // Injected as a string so it runs in the page context.
  const serializerFn = `
    function __bcSerialize(el, maxDepth) {
      // Try Element.getHTML with shadow DOM support (Chrome 124+, Firefox 128+)
      if (typeof el.getHTML === 'function') {
        try {
          // Collect all shadow roots in the subtree
          function collectShadowRoots(node) {
            const roots = [];
            if (node.shadowRoot) roots.push(node.shadowRoot);
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
            let current = walker.nextNode();
            while (current) {
              if (current.shadowRoot) roots.push(current.shadowRoot);
              current = walker.nextNode();
            }
            // Also walk into existing shadow roots
            for (const root of [...roots]) {
              const innerWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let inner = innerWalker.nextNode();
              while (inner) {
                if (inner.shadowRoot) roots.push(inner.shadowRoot);
                inner = innerWalker.nextNode();
              }
            }
            return roots;
          }
          const shadowRoots = collectShadowRoots(el);
          return el.getHTML({ shadowRoots: shadowRoots, serializableShadowRoots: true });
        } catch (e) {
          // getHTML failed, fall through to depth-limited outerHTML
        }
      }

      // Fallback: depth-limited outerHTML clone
      if (maxDepth !== undefined && maxDepth > 0) {
        function limitDepth(node, d) {
          if (d <= 0) return document.createTextNode('');
          const clone = node.cloneNode(false);
          if (d > 1) {
            for (const child of node.children) {
              clone.appendChild(limitDepth(child, d - 1));
            }
          }
          return clone;
        }
        const limited = limitDepth(el, maxDepth);
        const wrap = document.createElement('div');
        wrap.appendChild(limited);
        return wrap.innerHTML;
      }

      return el.outerHTML;
    }
  `;

  if (selector && depth) {
    return `
      (function() {
        ${serializerFn}
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'Element not found: ${selector}';
        return __bcSerialize(el, ${depth});
      })()
    `;
  }

  if (selector) {
    return `
      (function() {
        ${serializerFn}
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'Element not found: ${selector}';
        return __bcSerialize(el);
      })()
    `;
  }

  // Full document — use getHTML on documentElement with shadow DOM, truncate to 100KB
  return `
    (function() {
      ${serializerFn}
      return __bcSerialize(document.documentElement).slice(0, 100000);
    })()
  `;
}
