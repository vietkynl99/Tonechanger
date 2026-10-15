const slider = document.getElementById('slider');
const val = document.getElementById('val');
const subtitle = document.getElementById('subtitle');
const footerHint = document.getElementById('footerHint');
const buttons = ['downBtn', 'upBtn', 'resetBtn'].map((id) => document.getElementById(id));
const [downBtn, upBtn, resetBtn] = buttons;

const SITES_KEY = 'sites';
const MIN = Number(slider.min);
const MAX = Number(slider.max);
let hostname = null;
let sites = {};

function setDisplay(semitones) {
  slider.value = semitones;
  val.textContent = (semitones > 0 ? '+' : '') + semitones;
}

function savePitch(semitones) {
  const clamped = Math.min(MAX, Math.max(MIN, semitones));
  setDisplay(clamped);
  if (clamped === 0) delete sites[hostname];
  else sites[hostname] = { pitch: clamped };
  chrome.storage.sync.set({ [SITES_KEY]: sites });
}

function showUnsupported() {
  subtitle.textContent = 'Not available on this page';
  footerHint.textContent = 'Open a regular website tab to change its tone.';
  slider.disabled = true;
  buttons.forEach((b) => (b.disabled = true));
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  let url = null;
  try {
    url = tab && tab.url ? new URL(tab.url) : null;
  } catch (e) {
    url = null;
  }

  if (!url || !/^https?:$/.test(url.protocol)) {
    showUnsupported();
    return;
  }

  hostname = url.hostname;
  subtitle.textContent = hostname;

  chrome.storage.session.get(['engineErrors'], (session) => {
    const error = (session.engineErrors || {})[tab.id];
    if (!error) return;
    footerHint.textContent = 'Pitch engine failed on this page: ' + error;
    footerHint.style.color = '#e5322a';
  });

  chrome.storage.sync.get([SITES_KEY], (result) => {
    sites = result[SITES_KEY] || {};
    const entry = sites[hostname];
    setDisplay(entry && typeof entry.pitch === 'number' ? entry.pitch : 0);
  });
});

slider.addEventListener('input', () => hostname && savePitch(Number(slider.value)));
downBtn.addEventListener('click', () => hostname && savePitch(Number(slider.value) - 1));
upBtn.addEventListener('click', () => hostname && savePitch(Number(slider.value) + 1));
resetBtn.addEventListener('click', () => hostname && savePitch(0));
