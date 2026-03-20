import { getTabMeta, saveTabMeta } from './storage.js';

let allWindows = [];
let currentView = 'grid'; 
let selectedIds = new Set();
let activeTabId = null;
let tabMetas = {};
let isAutoFitting = false;
let settings = {
  density: 'normal', 
  calculatedCols: 5,
  narrowMode: false,
  exactSearch: false,
  primaryAction: 'switch',
  ghostHover: false,
  autoFit: false
};

const channel = new BroadcastChannel('tab_sync');

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshState();
  render();
  setupEventListeners();
});

async function loadSettings() {
  const data = await chrome.storage.local.get(['popupSettings', 'currentView']);
  if (data.popupSettings) settings = { ...settings, ...data.popupSettings };
  if (data.currentView) currentView = data.currentView;
  applyLayoutSettings();
}

async function saveSettings() {
  await chrome.storage.local.set({ popupSettings: settings, currentView: currentView });
}

function applyLayoutSettings() {
  document.body.classList.remove('density-compact', 'density-tiny');
  if (settings.density === 'compact') document.body.classList.add('density-compact');
  if (settings.density === 'tiny') document.body.classList.add('density-tiny');
  
  let currentCols = 5;
  if (settings.autoFit) {
    currentCols = settings.calculatedCols || 5; 
  } else if (settings.narrowMode) {
    currentCols = 3;
  }
  
  document.documentElement.style.setProperty('--cols', currentCols);
  
  const densitySelect = document.getElementById('density-select');
  if (densitySelect) {
    densitySelect.value = settings.density;
    densitySelect.disabled = settings.autoFit;
  }
  const narrowToggle = document.getElementById('narrow-toggle');
  if (narrowToggle) {
    narrowToggle.checked = settings.narrowMode;
    narrowToggle.disabled = settings.autoFit;
  }
  const autoFitToggle = document.getElementById('auto-fit-toggle');
  if (autoFitToggle) autoFitToggle.checked = settings.autoFit;

  const exactCheck = document.getElementById('exact-toggle');
  if (exactCheck) exactCheck.checked = settings.exactSearch;
}

channel.onmessage = (msg) => {
  if (msg.data.action === 'update_meta') {
    tabMetas[msg.data.url] = msg.data.meta;
    render();
  }
};

async function refreshState() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) activeTabId = activeTab.id;

  allWindows = await chrome.windows.getAll({ populate: true });
  for (const win of allWindows) {
    for (const tab of win.tabs) {
      if (tab.url) tabMetas[tab.url] = await getTabMeta(tab.url);
    }
  }
}

function render() {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  
  const query = document.getElementById('search').value.toLowerCase().trim();
  const starFilter = parseInt(document.getElementById('star-filter')?.value || '0');
  
  const normalize = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const normalizedQuery = normalize(query);

  allWindows.forEach((win, index) => {
    const pane = document.createElement('div');
    pane.className = 'window-pane';
    
    const winHeader = document.createElement('div');
    winHeader.className = 'window-header';
    winHeader.innerHTML = `<span>Window ${index + 1}</span><span class="count-badge">${win.tabs.length}</span>`;
    pane.appendChild(winHeader);
    
    const container = document.createElement('div');
    container.className = currentView === 'list' ? 'tab-list' : 'grid-container';
    
    const scrollArea = document.createElement('div');
    scrollArea.className = 'scroll-area';
    
    win.tabs.forEach(tab => {
      const meta = tabMetas[tab.url] || {};
      const title = (meta.customTitle || tab.title || "").toLowerCase();
      
      if (starFilter > 0 && (meta.importancia || 0) < starFilter) return;

      let match = false;
      if (query === '') {
        match = true;
      } else if (settings.exactSearch) {
        match = normalize(tab.url) === normalizedQuery;
      } else {
        match = title.includes(query) || tab.url.toLowerCase().includes(query);
      }

      if (!match) return;

      const el = document.createElement('div');
      el.className = `tab-element ${currentView === 'list' ? 'list-item' : 'grid-tile'}`;
      if (selectedIds.has(tab.id)) el.classList.add('selected');
      if (tab.id === activeTabId) el.classList.add('active-tab');
      
      const faviconUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`;
      const displayTitle = meta.customTitle || tab.title;

      el.innerHTML = currentView === 'list' ? `
        <img class="favicon" src="${faviconUrl}">
        <span class="tab-title">${displayTitle}</span>
        ${meta.importancia > 0 ? `<span style="color:#fbbf24; margin-left: auto;">★${meta.importancia}</span>` : ''}
      ` : `
        <img class="tile-favicon" src="${faviconUrl}">
        ${tab.audible ? '<div class="grid-audio">🔊</div>' : ''}
        ${meta.importancia > 0 ? `<div class="grid-star">★${meta.importancia}</div>` : ''}
      `;

      el.addEventListener('mouseenter', (e) => {
        const tooltip = document.getElementById('tooltip');
        tooltip.innerHTML = `<strong>${displayTitle}</strong><br><small>${tab.url}</small><br><span style="color:#fbbf24;">${'★'.repeat(meta.importancia || 0)}</span> <small>(Alt+1-5 to rate)</small>`;
        tooltip.style.display = 'block';
      });
      el.addEventListener('mousemove', (e) => {
        const tooltip = document.getElementById('tooltip');
        tooltip.style.left = (e.clientX + 15) + 'px';
        tooltip.style.top = (e.clientY + 15) + 'px';
      });
      el.addEventListener('mouseleave', () => { document.getElementById('tooltip').style.display = 'none'; });
      
      el.addEventListener('click', async (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (selectedIds.has(tab.id)) selectedIds.delete(tab.id); else selectedIds.add(tab.id);
          render();
        } else {
          chrome.tabs.update(tab.id, { active: true });
          chrome.windows.update(win.id, { focused: true });
        }
      });

      el.addEventListener('keydown', async (e) => {
        if (e.altKey && e.key >= '1' && e.key <= '5') {
          const val = parseInt(e.key);
          meta.importancia = meta.importancia === val ? 0 : val;
          await saveTabMeta(meta);
          channel.postMessage({ action: 'update_meta', url: tab.url, meta: meta });
          render();
        }
      });
      el.tabIndex = 0; 

      container.appendChild(el);
    });
    
    scrollArea.appendChild(container);
    pane.appendChild(scrollArea);
    canvas.appendChild(pane);
  });

  if (settings.autoFit && !isAutoFitting) {
    autoFit();
  }
}

async function autoFit() {
  if (isAutoFitting) return;
  isAutoFitting = true;

  const canvas = document.getElementById('canvas');
  if (!canvas) { isAutoFitting = false; return; }

  const configs = [
    { d: 'normal', c: 5 },
    { d: 'normal', c: 4 },
    { d: 'normal', c: 3 },
    { d: 'compact', c: 3 },
    { d: 'tiny', c: 3 },
  ];

  for (const config of configs) {
    settings.density = config.d;
    settings.calculatedCols = config.c;
    applyLayoutSettings();

    await new Promise(r => requestAnimationFrame(r));

    const hasHorizontal = canvas.scrollWidth > canvas.clientWidth;
    if (!hasHorizontal) break;
  }
  
  isAutoFitting = false;
  saveSettings();
}

function setupEventListeners() {
  const pullUrl = async (mode = 'domain') => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.url) {
      try {
        const url = new URL(tab.url);
        let val = "";
        if (mode === 'domain') {
          val = url.hostname.replace('www.', '');
        } else {
          val = tab.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
        }
        document.getElementById('search').value = val;
        render();
      } catch(e) {
        document.getElementById('search').value = tab.url;
        render();
      }
    }
  };

  const btnPull = document.getElementById('btn-pull');
  if (btnPull) {
    btnPull.addEventListener('click', (e) => {
      e.preventDefault();
      pullUrl('domain');
    });
    btnPull.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      pullUrl('full');
    });
    btnPull.title = "Click: Pull Domain\nRight-Click: Pull Full URL";
  }

  document.getElementById('search').addEventListener('input', render);
  document.getElementById('clear-search').addEventListener('click', () => {
    document.getElementById('search').value = '';
    render();
  });

  document.getElementById('auto-fit-toggle')?.addEventListener('change', (e) => {
    settings.autoFit = e.target.checked;
    if (settings.autoFit) autoFit();
    else {
      settings.calculatedCols = 5; 
      applyLayoutSettings();
      render();
    }
    saveSettings();
  });

  document.getElementById('narrow-toggle')?.addEventListener('change', (e) => {
    settings.narrowMode = e.target.checked;
    applyLayoutSettings();
    render();
    saveSettings();
  });

  document.getElementById('exact-toggle').addEventListener('change', (e) => {
    settings.exactSearch = e.target.checked;
    saveSettings();
    render();
  });

  document.getElementById('star-filter').addEventListener('change', render);

  document.getElementById('view-toggle').addEventListener('click', () => {
    currentView = currentView === 'list' ? 'grid' : 'list';
    saveSettings();
    render();
  });

  document.getElementById('btn-expand').addEventListener('click', () => {
    chrome.tabs.create({ url: 'dashboard.html' });
  });

  document.getElementById('settings-toggle').addEventListener('click', () => {
    document.getElementById('settings-pane').classList.add('open');
  });

  document.getElementById('close-settings').addEventListener('click', () => {
    document.getElementById('settings-pane').classList.remove('open');
  });

  const densitySelect = document.getElementById('density-select');
  if (densitySelect) {
    densitySelect.addEventListener('change', (e) => {
      settings.density = e.target.value;
      saveSettings();
      applyLayoutSettings();
      render();
    });
  }

  // Footer Actions
  document.getElementById('btn-close')?.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    if (confirm(`Close ${selectedIds.size} tabs?`)) {
      await chrome.tabs.remove(Array.from(selectedIds));
      selectedIds.clear();
      await refreshState();
      render();
    }
  });

  document.getElementById('btn-discard')?.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    for (const id of selectedIds) { await chrome.tabs.discard(id); }
    selectedIds.clear();
    render();
  });

  document.getElementById('btn-mute-all')?.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ audible: true });
    for (const t of tabs) { await chrome.tabs.update(t.id, { muted: true }); }
  });
}
