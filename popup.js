import { getTabMeta, saveTabMeta } from './storage.js';

let allWindows = [];
let currentView = 'grid'; 
let selectedIds = new Set();
let tabMetas = {};
let isAutoFitting = false;
let settings = {
  density: 'normal', // normal, compact, tiny
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
  document.body.classList.remove('density-compact', 'density-tiny', 'force-narrow');
  if (settings.density === 'compact') document.body.classList.add('density-compact');
  if (settings.density === 'tiny') document.body.classList.add('density-tiny');
  if (settings.narrowMode) document.body.classList.add('force-narrow');
  
  // Update UI state
  const densitySelect = document.getElementById('density-select');
  if (densitySelect) {
    densitySelect.value = settings.density;
    densitySelect.disabled = settings.autoFit;
  }
  const narrowCheck = document.getElementById('narrow-toggle');
  if (narrowCheck) {
    narrowCheck.checked = settings.narrowMode;
    narrowCheck.disabled = settings.autoFit;
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
  
  const query = document.getElementById('search').value.toLowerCase();
  
  allWindows.forEach((win, index) => {
    const pane = document.createElement('div');
    pane.className = 'window-pane';
    
    const winHeader = document.createElement('div');
    winHeader.className = 'window-header';
    winHeader.innerText = `Window ${index + 1} (${win.tabs.length})`;
    pane.appendChild(winHeader);
    
    const container = document.createElement('div');
    container.className = currentView === 'list' ? 'tab-list' : 'grid-container';
    
    const scrollArea = document.createElement('div');
    scrollArea.className = 'scroll-area';
    
    win.tabs.forEach(tab => {
      const meta = tabMetas[tab.url] || {};
      const title = (meta.customTitle || tab.title || "").toLowerCase();
      
      let match = false;
      if (query === '') {
        match = true;
      } else if (settings.exactSearch) {
        const domain = new URL(tab.url).hostname.replace('www.', '');
        match = tab.url.toLowerCase() === query || domain.toLowerCase() === query;
      } else {
        match = title.includes(query) || tab.url.toLowerCase().includes(query);
      }

      if (!match) return;

      const el = document.createElement('div');
      el.className = `tab-element ${currentView === 'list' ? 'list-item' : 'grid-tile'}`;
      if (selectedIds.has(tab.id)) el.classList.add('selected');
      
      const faviconUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`;
      const displayTitle = meta.customTitle || tab.title;

      el.title = displayTitle; // Native tooltip as fallback

      el.innerHTML = currentView === 'list' ? `
        <img class="favicon" src="${faviconUrl}">
        <span class="tab-title">${displayTitle}</span>
      ` : `
        <img class="tile-favicon" src="${faviconUrl}">
        ${tab.audible ? '<div class="grid-audio">🔊</div>' : ''}
        ${meta.importancia > 0 ? `<div class="grid-star">★${meta.importancia}</div>` : ''}
      `;

      // Custom Tooltip Logic
      el.addEventListener('mouseenter', (e) => {
        const tooltip = document.getElementById('tooltip');
        tooltip.innerHTML = `<strong>${displayTitle}</strong><br><small>${tab.url}</small>`;
        tooltip.style.display = 'block';
      });

      el.addEventListener('mousemove', (e) => {
        const tooltip = document.getElementById('tooltip');
        tooltip.style.left = (e.clientX + 15) + 'px';
        tooltip.style.top = (e.clientY + 15) + 'px';
      });

      el.addEventListener('mouseleave', () => {
        document.getElementById('tooltip').style.display = 'none';
      });

      el.addEventListener('click', async (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (selectedIds.has(tab.id)) selectedIds.delete(tab.id); else selectedIds.add(tab.id);
          render();
        } else {
          chrome.tabs.update(tab.id, { active: true });
          chrome.windows.update(win.id, { focused: true });
        }
      });

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

  const configs = [
    { density: 'normal', narrowMode: false },
    { density: 'normal', narrowMode: true },
    { density: 'compact', narrowMode: false },
    { density: 'compact', narrowMode: true },
    { density: 'tiny', narrowMode: false },
    { density: 'tiny', narrowMode: true },
  ];

  for (const config of configs) {
    settings.density = config.density;
    settings.narrowMode = config.narrowMode;
    applyLayoutSettings();
    render();

    // Give the browser a moment to layout
    await new Promise(r => requestAnimationFrame(r));

    const canvas = document.getElementById('canvas');
    const hasHorizontal = canvas.scrollWidth > canvas.clientWidth;
    
    const scrollAreas = document.querySelectorAll('.scroll-area');
    let hasVertical = false;
    for (const sa of scrollAreas) {
      if (sa.scrollHeight > sa.clientHeight) {
        hasVertical = true;
        break;
      }
    }

    if (!hasHorizontal && !hasVertical) {
      break; // Found a fit!
    }
  }
  isAutoFitting = false;
  saveSettings();
}

function setupEventListeners() {
  document.getElementById('search').addEventListener('input', render);
  document.getElementById('clear-search').addEventListener('click', () => {
    document.getElementById('search').value = '';
    render();
  });

  document.getElementById('auto-fit-toggle')?.addEventListener('change', (e) => {
    settings.autoFit = e.target.checked;
    if (settings.autoFit) {
      autoFit();
    } else {
      applyLayoutSettings();
    }
    saveSettings();
  });

  document.getElementById('exact-toggle').addEventListener('change', (e) => {
    settings.exactSearch = e.target.checked;
    saveSettings();
    render();
  });

  document.getElementById('view-toggle').addEventListener('click', () => {
    currentView = currentView === 'list' ? 'grid' : 'list';
    saveSettings();
    render();
  });

  document.getElementById('btn-expand').addEventListener('click', () => {
    chrome.tabs.create({ url: 'dashboard.html' });
  });

  // Settings Pane
  document.getElementById('settings-toggle').addEventListener('click', () => {
    document.getElementById('settings-pane').classList.add('open');
  });

  document.getElementById('close-settings').addEventListener('click', () => {
    document.getElementById('settings-pane').classList.remove('open');
  });

  // Wiring up new settings elements (I'll need to add them to popup.html too)
  const densitySelect = document.getElementById('density-select');
  if (densitySelect) {
    densitySelect.addEventListener('change', (e) => {
      settings.density = e.target.value;
      saveSettings();
      applyLayoutSettings();
      render();
    });
  }

  const narrowToggle = document.getElementById('narrow-toggle');
  if (narrowToggle) {
    narrowToggle.addEventListener('change', (e) => {
      settings.narrowMode = e.target.checked;
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
    for (const id of selectedIds) {
      await chrome.tabs.discard(id);
    }
    selectedIds.clear();
    render();
  });

  document.getElementById('btn-mute-all')?.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ audible: true });
    for (const t of tabs) {
      await chrome.tabs.update(t.id, { muted: true });
    }
  });
}
