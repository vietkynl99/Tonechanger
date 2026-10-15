(function () {
  const SITES_KEY = 'sites';
  const MUTATION_DEBOUNCE_MS = 250;
  const SLOW_SCAN_INTERVAL_MS = 5000;

  let semitones = 0;
  let hostname = null;
  let ctx = null;
  let shifter = null;
  let mutationDebounce = null;
  let slowScanId = null;
  let active = false;
  const routes = new WeakMap();
  const trackedElements = new Set();

  function reportEngineError(error) {
    const message = (error && error.message) || String(error);
    console.error('[Tone Changer] pitch engine failed:', error);
    chrome.runtime.sendMessage({ type: 'ENGINE_ERROR', message });
  }

  // Until the worklet is ready (or if it fails), audio plays unshifted rather
  // than going silent.
  function loadEngine() {
    ctx.audioWorklet
      .addModule(chrome.runtime.getURL('pitch-worklet.js'))
      .then(() => {
        const node = new AudioWorkletNode(ctx, 'pitch-shifter', {
          channelCount: 2,
          channelCountMode: 'explicit',
          outputChannelCounts: [2],
        });
        node.connect(ctx.destination);
        shifter = node;
        applyRatio();
        trackedElements.forEach((el) => routes.has(el) && connectRoute(routes.get(el)));
      })
      .catch(reportEngineError);
  }

  function applyRatio() {
    if (shifter) shifter.parameters.get('ratio').value = Math.pow(2, semitones / 12);
  }

  function ensureContext() {
    if (ctx) return true;
    try {
      ctx = new AudioContext();
    } catch (e) {
      reportEngineError(e);
      return false;
    }
    loadEngine();
    return true;
  }

  function resumeContext() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // createMediaElementSource() on a cross-origin resource without CORS yields
  // silence, so such elements are left untouched rather than muted.
  function isRoutable(el) {
    const src = el.currentSrc || el.src;
    if (!src || /^(blob|data):/.test(src)) return true;
    try {
      return new URL(src, location.href).origin === location.origin || el.crossOrigin !== null;
    } catch (e) {
      return false;
    }
  }

  function connectRoute(route) {
    route.source.disconnect();
    if (semitones === 0 || !shifter) route.source.connect(ctx.destination);
    else route.source.connect(shifter);
  }

  function trackElement(el) {
    if (routes.has(el)) return;
    if (!isRoutable(el)) return;
    if (!ensureContext()) return;
    try {
      const route = { source: ctx.createMediaElementSource(el) };
      routes.set(el, route);
      trackedElements.add(el);
      connectRoute(route);
      el.addEventListener('play', resumeContext);
    } catch (e) {
      /* element already captured by the page's own AudioContext */
    }
  }

  function collectMediaElements(root, out) {
    root.querySelectorAll('audio, video').forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collectMediaElements(el.shadowRoot, out);
    });
  }

  function scanDeep() {
    const elements = [];
    collectMediaElements(document, elements);
    elements.forEach(trackElement);
  }

  // Shadow-DOM walks are expensive on mutation-heavy pages, so the hot path
  // only does the cheap tag query (debounced) and the deep walk stays on a
  // slow timer.
  const observer = new MutationObserver(() => {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => {
      mutationDebounce = null;
      document.querySelectorAll('audio, video').forEach(trackElement);
    }, MUTATION_DEBOUNCE_MS);
  });

  function observeDom() {
    const root = document.documentElement || document.body;
    if (root) observer.observe(root, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', observeDom, { once: true });
  }

  function onUserGesture() {
    resumeContext();
  }

  function startWatching() {
    if (active) return;
    active = true;
    scanDeep();
    observeDom();
    slowScanId = setInterval(scanDeep, SLOW_SCAN_INTERVAL_MS);
    window.addEventListener('pointerdown', onUserGesture, true);
    window.addEventListener('keydown', onUserGesture, true);
  }

  // Once an element has been captured by createMediaElementSource it cannot
  // be released, so "off" means routing it straight to the destination and
  // halting the scans, not tearing the AudioContext down.
  function stopWatching() {
    if (!active) return;
    active = false;
    observer.disconnect();
    clearTimeout(mutationDebounce);
    mutationDebounce = null;
    clearInterval(slowScanId);
    slowScanId = null;
    window.removeEventListener('pointerdown', onUserGesture, true);
    window.removeEventListener('keydown', onUserGesture, true);
  }

  function applyPitch(value) {
    semitones = value;
    if (semitones === 0) {
      if (ctx) {
        trackedElements.forEach((el) => {
          const route = routes.get(el);
          if (route) connectRoute(route);
        });
      }
      stopWatching();
      return;
    }
    if (!ensureContext()) return;
    applyRatio();
    startWatching();
    trackedElements.forEach((el) => {
      if (!el.isConnected) {
        trackedElements.delete(el);
        return;
      }
      connectRoute(routes.get(el));
    });
    resumeContext();
  }

  function pitchFromSiteEntry(entry) {
    return entry && typeof entry.pitch === 'number' ? entry.pitch : 0;
  }

  chrome.runtime.sendMessage({ type: 'GET_TAB_HOSTNAME' }, (response) => {
    hostname = (response && response.hostname) || null;
    if (!hostname) return;
    chrome.storage.sync.get([SITES_KEY], (result) => {
      applyPitch(pitchFromSiteEntry((result[SITES_KEY] || {})[hostname]));
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[SITES_KEY] && hostname) {
      applyPitch(pitchFromSiteEntry((changes[SITES_KEY].newValue || {})[hostname]));
    }
  });
})();
