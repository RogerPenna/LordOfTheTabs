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
  await initPanicMode();
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

  const showGoogleSearchToggle = document.getElementById('show-google-search-toggle');
  if (showGoogleSearchToggle) {
    showGoogleSearchToggle.checked = settings.showGoogleSearch !== false;
  }

  const supportModeSelect = document.getElementById('support-mode-select');
  if (supportModeSelect) {
    supportModeSelect.value = settings.supportMode || 'shortcuts';
  }

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

  document.getElementById('show-google-search-toggle')?.addEventListener('change', (e) => {
    settings.showGoogleSearch = e.target.checked;
    saveSettings();
    channel.postMessage({ action: 'update_meta' });
  });

  document.getElementById('support-mode-select')?.addEventListener('change', (e) => {
    settings.supportMode = e.target.value;
    saveSettings();
    channel.postMessage({ action: 'update_meta' });
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

  document.getElementById('bmc-popup-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://buymeacoffee.com/rogerpenna' });
  });

  setupPanicModeListeners();

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

let currentPanicDomains = [...DEFAULT_ADULT_DOMAINS];
let currentPanicPin = null;
let isPanicUnlocked = false;

function cleanDomain(input) {
  if (!input) return '';
  let str = input.trim().toLowerCase();
  str = str.replace(/^https?:\/\//i, '');
  str = str.replace(/^www\./i, '');
  str = str.split('/')[0];
  str = str.split('?')[0];
  str = str.split(':')[0];
  return str;
}

async function initPanicMode() {
  const data = await chrome.storage.local.get(['panicPin', 'panicDomains']);
  currentPanicPin = data.panicPin || null;
  currentPanicDomains = data.panicDomains || [...DEFAULT_ADULT_DOMAINS];

  const pinBox = document.getElementById('panic-pin-box');
  const managerPanel = document.getElementById('panic-manager-panel');
  const lockStatus = document.getElementById('panic-lock-status');
  const promptText = document.getElementById('panic-pin-prompt-text');
  const unlockBtn = document.getElementById('btn-panic-unlock');
  const setPinBtn = document.getElementById('btn-panic-set-pin');
  const pinInput = document.getElementById('panic-pin-input');

  if (isPanicUnlocked) {
    if (pinBox) pinBox.style.display = 'none';
    if (managerPanel) managerPanel.style.display = 'block';
    if (lockStatus) lockStatus.innerText = '🔓 Unlocked';
    renderPanicDomainsList();
    return;
  }

  if (managerPanel) managerPanel.style.display = 'none';
  if (pinBox) pinBox.style.display = 'block';
  if (pinInput) pinInput.value = '';

  if (!currentPanicPin) {
    if (lockStatus) lockStatus.innerText = '🔓 Unset';
    if (promptText) promptText.innerText = 'Create a 4-Digit PIN to protect Panic Mode:';
    if (unlockBtn) unlockBtn.style.display = 'none';
    if (setPinBtn) setPinBtn.style.display = 'inline-block';
  } else {
    if (lockStatus) lockStatus.innerText = '🔒 Locked';
    if (promptText) promptText.innerText = 'Enter 4-Digit PIN to unlock Panic Mode settings:';
    if (unlockBtn) unlockBtn.style.display = 'inline-block';
    if (setPinBtn) setPinBtn.style.display = 'none';
  }
}

function renderPanicDomainsList(filterQuery = '') {
  const container = document.getElementById('panic-domains-list');
  if (!container) return;
  
  const query = filterQuery.trim().toLowerCase();
  const filtered = currentPanicDomains.filter(d => d.toLowerCase().includes(query));

  if (filtered.length === 0) {
    container.innerHTML = `<div style="font-size: 11px; color: #94a3b8; text-align: center; padding: 12px;">${query ? 'No matching domains found' : 'No panic domains configured'}</div>`;
    return;
  }

  container.innerHTML = filtered.map(domain => `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; font-family: monospace;">
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${domain}</span>
      <button class="btn-delete-panic-domain" data-domain="${domain}" style="border: none; background: none; cursor: pointer; font-size: 12px; color: #ef4444;" title="Delete domain">🗑️</button>
    </div>
  `).join('');

  container.querySelectorAll('.btn-delete-panic-domain').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const targetDomain = e.currentTarget.dataset.domain;
      currentPanicDomains = currentPanicDomains.filter(d => d !== targetDomain);
      await chrome.storage.local.set({ panicDomains: currentPanicDomains });
      channel.postMessage({ action: 'update_meta' });
      renderPanicDomainsList(document.getElementById('panic-domain-filter')?.value || '');
    });
  });
}

function setupPanicModeListeners() {
  document.getElementById('btn-panic-unlock')?.addEventListener('click', () => {
    const pin = document.getElementById('panic-pin-input')?.value?.trim();
    if (pin === currentPanicPin) {
      isPanicUnlocked = true;
      initPanicMode();
    } else {
      alert('Incorrect PIN! Please try again.');
    }
  });

  document.getElementById('btn-panic-set-pin')?.addEventListener('click', async () => {
    const pin = document.getElementById('panic-pin-input')?.value?.trim();
    if (!pin || pin.length !== 4 || isNaN(pin)) {
      alert('Please enter a valid 4-digit numeric PIN.');
      return;
    }

    await chrome.storage.local.set({ panicPin: pin });
    currentPanicPin = pin;
    isPanicUnlocked = true;

    // Trigger Gmail Compose Auto-Backup
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent('Lord of the Tabs - Seu PIN do Panic Mode')}&body=${encodeURIComponent('Seu PIN cadastrado para o Panic Mode eh: ' + pin)}`;
    chrome.tabs.create({ url: gmailUrl });

    initPanicMode();
  });

  document.getElementById('btn-panic-relock')?.addEventListener('click', () => {
    isPanicUnlocked = false;
    initPanicMode();
  });

  document.getElementById('panic-domain-filter')?.addEventListener('input', (e) => {
    renderPanicDomainsList(e.target.value);
  });

  document.getElementById('btn-panic-add')?.addEventListener('click', async () => {
    const input = document.getElementById('panic-add-input');
    const domain = cleanDomain(input?.value);
    if (!domain) return;

    if (!currentPanicDomains.includes(domain)) {
      currentPanicDomains.push(domain);
      await chrome.storage.local.set({ panicDomains: currentPanicDomains });
      channel.postMessage({ action: 'update_meta' });
    }
    input.value = '';
    renderPanicDomainsList(document.getElementById('panic-domain-filter')?.value || '');
  });

  document.getElementById('btn-panic-capture-tabs')?.addEventListener('click', async () => {
    const box = document.getElementById('panic-tab-capture-box');
    if (!box) return;
    const isHidden = box.style.display === 'none';
    if (!isHidden) {
      box.style.display = 'none';
      return;
    }

    const tabs = await chrome.tabs.query({});
    const domainsSet = new Set();
    tabs.forEach(t => {
      if (t.url) {
        const domain = cleanDomain(t.url);
        if (domain && !domain.startsWith('chrome') && domain.includes('.')) {
          domainsSet.add(domain);
        }
      }
    });

    const listContainer = document.getElementById('panic-tab-capture-list');
    if (!listContainer) return;

    if (domainsSet.size === 0) {
      listContainer.innerHTML = `<div style="font-size: 10px; color: #64748b;">No eligible web tab domains found.</div>`;
    } else {
      listContainer.innerHTML = Array.from(domainsSet).map(domain => {
        const isAlreadyAdded = currentPanicDomains.includes(domain);
        return `
          <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: monospace;">
            <input type="checkbox" value="${domain}" class="panic-tab-checkbox" ${isAlreadyAdded ? 'disabled checked' : 'checked'}>
            <span style="${isAlreadyAdded ? 'color: #94a3b8;' : 'color: #1e293b;'}">${domain} ${isAlreadyAdded ? '(Added)' : ''}</span>
          </label>
        `;
      }).join('');
    }
    box.style.display = 'block';
  });

  document.getElementById('btn-panic-confirm-capture')?.addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.panic-tab-checkbox:checked:not(:disabled)');
    let addedCount = 0;
    checkboxes.forEach(cb => {
      const val = cb.value;
      if (val && !currentPanicDomains.includes(val)) {
        currentPanicDomains.push(val);
        addedCount++;
      }
    });

    if (addedCount > 0) {
      await chrome.storage.local.set({ panicDomains: currentPanicDomains });
      channel.postMessage({ action: 'update_meta' });
      renderPanicDomainsList(document.getElementById('panic-domain-filter')?.value || '');
    }

    const box = document.getElementById('panic-tab-capture-box');
    if (box) box.style.display = 'none';
  });
}
