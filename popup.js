import { getTabMeta, saveTabMeta } from './storage.js';

let allWindows = [];
let currentView = 'grid'; 
let selectedIds = new Set();
let selectedWindowIds = new Set();
let activeTabId = null;
let activeWindowId = null;
let tabMetas = {};
let isAutoFitting = false;
let settings = {
  density: 'normal', 
  calculatedCols: 5,
  narrowMode: false,
  exactSearch: false,
  setDashboardAsNewTab: true, // Default to true since manifest forces it
  primaryAction: 'switch',
  ghostHover: false,
  ghostScope: 'domain',
  startupFocus: true,
  openDashboardInitial: false,
  autoFit: false
};

const channel = new BroadcastChannel('tab_sync');

const DEFAULT_ADULT_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'youporn.com', 
  'redtube.com', 'onlyfans.com', 'chaturbate.com', 'bongacams.com', 
  'livejasmin.com', 'stripchat.com', 'cam4.com', 'xhamster live'
];

window.addEventListener('unload', () => {
  if (channel) channel.close();
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  if (settings.openDashboardInitial) {
    chrome.tabs.create({ url: 'dashboard.html' });
    window.close();
    return;
  }
  await refreshState();
  render();
  setupEventListeners();
  if (settings.startupFocus !== false) {
    document.getElementById('search')?.focus();
  }
});

async function loadSettings() {
  const data = await chrome.storage.local.get(['popupSettings', 'currentView', 'panicDomains']);
  if (data.popupSettings) settings = { ...settings, ...data.popupSettings };
  if (data.currentView) currentView = data.currentView;
  if (data.panicDomains) settings.panicDomains = data.panicDomains;
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

  const primaryClickSelect = document.getElementById('primary_click_action');
  if (primaryClickSelect) primaryClickSelect.value = settings.primaryAction || 'switch';

  const ghostFilterToggle = document.getElementById('ghost_filter_enabled');
  if (ghostFilterToggle) ghostFilterToggle.checked = !!settings.ghostHover;

  const ghostScopeSelect = document.getElementById('ghost_filter_scope');
  if (ghostScopeSelect) ghostScopeSelect.value = settings.ghostScope || 'domain';

  const startupFocusToggle = document.getElementById('startup_focus');
  if (startupFocusToggle) startupFocusToggle.checked = settings.startupFocus !== false;

  const openDashboardToggle = document.getElementById('open_dashboard_initial');
  if (openDashboardToggle) openDashboardToggle.checked = !!settings.openDashboardInitial;

  const dashboardAsNewtabToggle = document.getElementById('dashboard_as_newtab');
  if (dashboardAsNewtabToggle) dashboardAsNewtabToggle.checked = settings.setDashboardAsNewTab !== false;

  const autoArchiveDaysInput = document.getElementById('auto-archive-days');
  if (autoArchiveDaysInput) {
    autoArchiveDaysInput.value = settings.autoArchiveDays || 3;
  }

  chrome.storage.sync.get('enableAffiliateSpeedDial', (res) => {
    const toggle = document.getElementById('affiliate_speed_dial_toggle');
    if (toggle) {
      toggle.checked = res.enableAffiliateSpeedDial !== false;
    }
  });

  const backupIntervalDaysInput = document.getElementById('backup-interval-days');
  if (backupIntervalDaysInput) {
    backupIntervalDaysInput.value = settings.backupIntervalDays || 7;
  }

  const backupModeSelect = document.getElementById('backup-mode');
  if (backupModeSelect) {
    backupModeSelect.value = settings.backupMode || 'alert';
  }

  const panicDomainsTextarea = document.getElementById('panic-domains');
  if (panicDomainsTextarea) {
    const list = settings.panicDomains || DEFAULT_ADULT_DOMAINS;
    panicDomainsTextarea.value = list.join(', ');
  }
}

channel.onmessage = (msg) => {
  if (msg.data.action === 'update_meta') {
    if (msg.data.url) tabMetas[msg.data.url] = msg.data.meta;
    loadSettings().then(render);
  }
};

function matchGhost(url1, url2, scope) {
  if (!url1 || !url2) return false;
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    if (scope === 'url') {
      return u1.href === u2.href;
    }
    const cleanHost = (host) => host.replace(/^www\d*\./, '').replace(/^m\./, '');
    const host1 = cleanHost(u1.hostname);
    const host2 = cleanHost(u2.hostname);
    if (scope === 'subdomain') {
      return host1 === host2;
    }
    // Default is 'domain' (match whole hostname)
    return u1.hostname === u2.hostname;
  } catch (e) {
    return url1 === url2;
  }
}

async function refreshState() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) {
    activeTabId = activeTab.id;
    activeWindowId = activeTab.windowId;
  }

  allWindows = await chrome.windows.getAll({ populate: true });
  for (const win of allWindows) {
    for (const tab of win.tabs) {
      if (tab.url) tabMetas[tab.url] = await getTabMeta(tab.url);
    }
  }
}

function render(skipAutoFit = false) {
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
    if (win.id === activeWindowId) pane.classList.add('active-window');
    if (selectedWindowIds.has(win.id)) pane.classList.add('selected-window');
    
    const winHeader = document.createElement('div');
    winHeader.className = 'window-header';
    winHeader.innerHTML = `<span>Window ${index + 1}</span><span class="count-badge">${win.tabs.length}</span>`;
    
    winHeader.addEventListener('click', () => {
      if (selectedWindowIds.has(win.id)) selectedWindowIds.delete(win.id);
      else selectedWindowIds.add(win.id);
      render(true); // Skip auto-fit on selection
    });

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
      el.dataset.url = tab.url;
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

        if (settings.ghostHover) {
          const scope = settings.ghostScope || 'domain';
          const currentUrl = tab.url;
          document.querySelectorAll('.tab-element').forEach(otherEl => {
            const otherUrl = otherEl.dataset.url;
            if (!matchGhost(currentUrl, otherUrl, scope)) {
              otherEl.style.opacity = '0.15';
            } else {
              otherEl.style.opacity = '1';
            }
          });
        }
      });
      el.addEventListener('mousemove', (e) => {
        const tooltip = document.getElementById('tooltip');
        tooltip.style.left = (e.clientX + 15) + 'px';
        tooltip.style.top = (e.clientY + 15) + 'px';
      });
      el.addEventListener('mouseleave', () => {
        document.getElementById('tooltip').style.display = 'none';
        if (settings.ghostHover) {
          document.querySelectorAll('.tab-element').forEach(otherEl => {
            otherEl.style.opacity = '1';
          });
        }
      });
      
      el.addEventListener('click', async (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (selectedIds.has(tab.id)) selectedIds.delete(tab.id); else selectedIds.add(tab.id);
          render(true); // Skip auto-fit on selection
        } else {
          if (settings.primaryAction === 'filter') {
            try {
              const url = new URL(tab.url);
              const val = url.hostname.replace('www.', '');
              document.getElementById('search').value = val;
              render();
            } catch(err) {
              document.getElementById('search').value = tab.url;
              render();
            }
          } else {
            chrome.tabs.update(tab.id, { active: true });
            chrome.windows.update(win.id, { focused: true });
          }
        }
      });

      el.addEventListener('keydown', async (e) => {
        if (e.altKey && e.key >= '1' && e.key <= '5') {
          const val = parseInt(e.key);
          meta.importancia = meta.importancia === val ? 0 : val;
          await saveTabMeta(meta);
          channel.postMessage({ action: 'update_meta', url: tab.url, meta: meta });
          render(true); // Rating doesn't change layout dimensions
        }
      });
      el.tabIndex = 0; 

      container.appendChild(el);
    });
    
    scrollArea.appendChild(container);
    pane.appendChild(scrollArea);
    canvas.appendChild(pane);
  });

  if (settings.autoFit && !isAutoFitting && !skipAutoFit) {
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

  document.getElementById('dashboard_as_newtab')?.addEventListener('change', (e) => {
    settings.setDashboardAsNewTab = e.target.checked;
    saveSettings();
  });

  document.getElementById('primary_click_action')?.addEventListener('change', (e) => {
    settings.primaryAction = e.target.value;
    saveSettings();
  });

  document.getElementById('ghost_filter_enabled')?.addEventListener('change', (e) => {
    settings.ghostHover = e.target.checked;
    saveSettings();
  });

  document.getElementById('ghost_filter_scope')?.addEventListener('change', (e) => {
    settings.ghostScope = e.target.value;
    saveSettings();
  });

  document.getElementById('startup_focus')?.addEventListener('change', (e) => {
    settings.startupFocus = e.target.checked;
    saveSettings();
  });

  document.getElementById('open_dashboard_initial')?.addEventListener('change', (e) => {
    settings.openDashboardInitial = e.target.checked;
    saveSettings();
  });

  document.getElementById('auto-archive-days')?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value) || 3;
    settings.autoArchiveDays = val;
    saveSettings();
    channel.postMessage({ action: 'update_meta' });
  });

  document.getElementById('affiliate_speed_dial_toggle')?.addEventListener('change', (e) => {
    chrome.storage.sync.set({ enableAffiliateSpeedDial: e.target.checked }, () => {
      channel.postMessage({ action: 'update_meta' });
    });
  });

  document.getElementById('backup-interval-days')?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value) || 7;
    settings.backupIntervalDays = val;
    saveSettings();
    channel.postMessage({ action: 'update_meta' });
  });

  document.getElementById('backup-mode')?.addEventListener('change', (e) => {
    settings.backupMode = e.target.value;
    saveSettings();
    channel.postMessage({ action: 'update_meta' });
  });

  document.getElementById('panic-domains')?.addEventListener('input', async (e) => {
    const rawValue = e.target.value;
    const array = rawValue.split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0);
    settings.panicDomains = array;
    await chrome.storage.local.set({ panicDomains: array });
    
    // Broadcast a change so background or dashboard syncs
    channel.postMessage({ action: 'update_meta' });
  });

  document.getElementById('star-filter').addEventListener('change', render);

  document.getElementById('view-toggle').addEventListener('click', () => {
    currentView = currentView === 'list' ? 'grid' : 'list';
    saveSettings();
    render();
  });

  document.getElementById('btn-expand').addEventListener('click', () => {
    chrome.tabs.create({ url: 'dashboard.html?manual=1' });
  });

  document.getElementById('btn-help')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'help.html' });
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
  const btnClose = document.getElementById('btn-close');
  if (btnClose) {
    btnClose.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      if (confirm(`Close ${selectedIds.size} tabs?`)) {
        await chrome.tabs.remove(Array.from(selectedIds));
        selectedIds.clear();
        await refreshState();
        render();
      }
    });
    
    // Panic Trigger on right-click
    btnClose.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ action: 'triggerPanic' }, (response) => {
        if (response) window.close();
      });
    });
  }

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

  const historyBtn = document.getElementById('btn-delete-history');
  if (historyBtn) {
    historyBtn.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;

      const selectedTabs = allWindows.flatMap(w => w.tabs).filter(t => selectedIds.has(t.id));
      const urls = selectedTabs.map(t => t.url);
      const domains = new Set(urls.map(u => {
        try { return new URL(u).hostname.replace('www.', ''); } catch(e) { return null; }
      }).filter(d => d));

      const choice = prompt(
        `Delete history for ${selectedIds.size} tabs?\n\n` +
        `Type '1' to delete ONLY these specific URLs.\n` +
        `Type '2' to delete ALL history for these domains: ${Array.from(domains).join(', ')}`
      );

      if (choice === '1') {
        for (const url of urls) {
          await chrome.history.deleteUrl({ url });
        }
        alert(`History cleared for ${urls.length} specific URLs.`);
      } else if (choice === '2') {
        for (const domain of domains) {
          const historyItems = await chrome.history.search({ text: domain, maxResults: 10000, startTime: 0 });
          const itemsToRemove = historyItems.filter(item => {
            try { return new URL(item.url).hostname.replace('www.', '') === domain; } catch(e) { return false; }
          });
          for (const item of itemsToRemove) {
            await chrome.history.deleteUrl({ url: item.url });
          }
        }
        alert(`History cleared for ${domains.size} domains.`);
      }
      
      selectedIds.clear();
      render();
    });
  }
}
