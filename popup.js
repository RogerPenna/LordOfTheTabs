import { getTabMeta, saveTabMeta } from './storage.js';
import { translatePage, getMessage } from './i18n.js';
import { checkPremium, activatePro, toggleDevPro } from './licensing.js';

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
  calculatedDensity: 'normal',
  narrowMode: false,
  exactSearch: false,
  setDashboardAsNewTab: true, // Default to true since manifest forces it
  primaryAction: 'switch',
  ghostHover: false,
  ghostScope: 'domain',
  startupFocus: true,
  openDashboardInitial: false,
  autoFit: false,
  panicType: 'blacklist',
  panicMethod: 'tabSwap',
  panicLandingPage: 'dashboard.html',
  panicAutoCloseHours: 24,
  autoPurgeSensitiveHistory: true
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
  translatePage();
  await refreshState();
  render();
  setupEventListeners();
  await updateLicensingUI();
  if (settings.startupFocus !== false) {
    document.getElementById('search')?.focus();
  }
});

async function loadSettings() {
  const data = await chrome.storage.local.get(['popupSettings', 'currentView', 'panicDomains', 'panicSafeDomains']);
  if (data.popupSettings) settings = { ...settings, ...data.popupSettings };
  if (data.currentView) currentView = data.currentView;
  if (data.panicDomains) settings.panicDomains = data.panicDomains;
  if (data.panicSafeDomains) settings.panicSafeDomains = data.panicSafeDomains;
  applyLayoutSettings();
  await initPanicMode();
}

async function saveSettings() {
  await chrome.storage.local.set({ popupSettings: settings, currentView: currentView });
}

function applyLayoutSettings() {
  let activeDensity = settings.density || 'normal';
  let currentCols = 5;

  if (settings.autoFit) {
    activeDensity = settings.calculatedDensity || 'normal';
    currentCols = settings.calculatedCols || 5; 
  } else if (settings.narrowMode) {
    currentCols = 3;
  }

  document.body.classList.remove('density-compact', 'density-tiny');
  if (activeDensity === 'compact') document.body.classList.add('density-compact');
  if (activeDensity === 'tiny') document.body.classList.add('density-tiny');
  
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

  const showQuickLaunchToggle = document.getElementById('show_quick_launch');
  if (showQuickLaunchToggle) showQuickLaunchToggle.checked = settings.showQuickLaunch !== false;

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

  const panicTypeSelect = document.getElementById('panic-type-select');
  if (panicTypeSelect) {
    panicTypeSelect.value = settings.panicType || 'blacklist';
  }

  const panicMethodSelect = document.getElementById('panic-method-select');
  if (panicMethodSelect) {
    panicMethodSelect.value = settings.panicMethod || 'tabSwap';
  }

  const panicLandingInput = document.getElementById('panic-landing-input');
  if (panicLandingInput) {
    panicLandingInput.value = settings.panicLandingPage || 'dashboard.html';
  }

  const panicAutoCloseInput = document.getElementById('panic-autoclose-input');
  if (panicAutoCloseInput) {
    panicAutoCloseInput.value = settings.panicAutoCloseHours || 24;
  }

  const panicManagerTitle = document.getElementById('panic-manager-title');
  if (panicManagerTitle) {
    panicManagerTitle.innerText = settings.panicType === 'whitelist' 
      ? '✅ Whitelisted Safe Domains' 
      : '🚫 Blacklisted Unsafe Domains';
  }

  const autoPurgeToggle = document.getElementById('auto-purge-sensitive-history-toggle');
  if (autoPurgeToggle) {
    autoPurgeToggle.checked = settings.autoPurgeSensitiveHistory !== false;
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
  
  const normalize = (u) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
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
    settings.calculatedDensity = config.d;
    settings.calculatedCols = config.c;
    applyLayoutSettings();

    // Force layout reflow and yield to the event loop
    canvas.getBoundingClientRect();
    await new Promise(r => setTimeout(r, 0));

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
      settings.calculatedDensity = 'normal';
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

  document.getElementById('show_quick_launch')?.addEventListener('change', (e) => {
    settings.showQuickLaunch = e.target.checked;
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

  const updateMuteButtonState = async () => {
    const btn = document.getElementById('btn-mute-all');
    if (!btn) return;
    const allTabs = await chrome.tabs.query({});
    const anyMuted = allTabs.some(t => t.mutedInfo && t.mutedInfo.muted);
    if (anyMuted) {
      btn.textContent = '🔊';
      btn.title = 'Unmute All Tabs';
    } else {
      btn.textContent = '🔇';
      btn.title = 'Mute All Tabs';
    }
  };

  updateMuteButtonState();

  document.getElementById('btn-mute-all')?.addEventListener('click', async () => {
    const allTabs = await chrome.tabs.query({});
    const mutedTabs = allTabs.filter(t => t.mutedInfo && t.mutedInfo.muted);
    if (mutedTabs.length > 0) {
      for (const t of mutedTabs) {
        await chrome.tabs.update(t.id, { muted: false });
      }
    } else {
      const audibleTabs = allTabs.filter(t => t.audible);
      for (const t of audibleTabs) {
        await chrome.tabs.update(t.id, { muted: true });
      }
    }
    await updateMuteButtonState();
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
let currentPanicSafeDomains = [];
let currentPanicPin = null;
let currentPanicEmergencyPin = null;
let isPanicUnlocked = false;
let isPanicEmergencyDecoy = false;

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
  const data = await chrome.storage.local.get(['panicPin', 'panicEmergencyPin', 'panicDomains', 'panicSafeDomains']);
  currentPanicPin = data.panicPin || null;
  currentPanicEmergencyPin = data.panicEmergencyPin || null;
  currentPanicDomains = data.panicDomains || [...DEFAULT_ADULT_DOMAINS];
  currentPanicSafeDomains = data.panicSafeDomains || [];

  const isPro = await checkPremium();
  const emergencyStatus = document.getElementById('emergency-pin-status');
  if (emergencyStatus) {
    if (currentPanicEmergencyPin) {
      emergencyStatus.textContent = '✓ Código de emergência ativo.';
      emergencyStatus.style.color = '#15803d';
    } else {
      emergencyStatus.textContent = isPro ? 'Nenhum código configurado.' : 'Disponível apenas no plano Pro.';
      emergencyStatus.style.color = '#854d0e';
    }
  }

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
    const decoySec = document.getElementById('panic-decoy-pin-section');
    if (decoySec) decoySec.style.display = isPanicEmergencyDecoy ? 'none' : 'block';
    const autoPurgeSec = document.getElementById('panic-auto-purge-section');
    if (autoPurgeSec) autoPurgeSec.style.display = isPanicEmergencyDecoy ? 'none' : 'block';
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

  if (isPanicEmergencyDecoy) {
    container.innerHTML = '<div style="font-size: 11px; color: #94a3b8; text-align: center; padding: 12px; font-style: italic;">Nenhum domínio configurado (0 domínios).</div>';
    return;
  }
  
  const query = filterQuery.trim().toLowerCase();
  const isWhitelist = settings.panicType === 'whitelist';
  const sourceList = isWhitelist ? currentPanicSafeDomains : currentPanicDomains;
  const filtered = sourceList.filter(d => d.toLowerCase().includes(query));

  if (filtered.length === 0) {
    container.innerHTML = `<div style="font-size: 11px; color: #94a3b8; text-align: center; padding: 12px;">${query ? 'No matching domains found' : (isWhitelist ? 'No safe domains configured' : 'No panic domains configured')}</div>`;
    return;
  }

  container.innerHTML = filtered.map(domain => `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; font-family: monospace; margin-bottom: 4px; box-sizing: border-box; width: 100%;">
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px;">${domain}</span>
      <button class="btn-delete-panic-domain" data-domain="${domain}" style="border: none; background: none; cursor: pointer; font-size: 13px; color: #ef4444; padding: 0; display: inline-flex;" title="Delete domain">🗑️</button>
    </div>
  `).join('');

  container.querySelectorAll('.btn-delete-panic-domain').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const targetDomain = e.currentTarget.dataset.domain;
      if (isWhitelist) {
        currentPanicSafeDomains = currentPanicSafeDomains.filter(d => d !== targetDomain);
        await chrome.storage.local.set({ panicSafeDomains: currentPanicSafeDomains });
      } else {
        currentPanicDomains = currentPanicDomains.filter(d => d !== targetDomain);
        await chrome.storage.local.set({ panicDomains: currentPanicDomains });
      }
      channel.postMessage({ action: 'update_meta' });
      renderPanicDomainsList(document.getElementById('panic-domain-filter')?.value || '');
    });
  });
}

function setupPanicModeListeners() {
  document.getElementById('btn-panic-unlock')?.addEventListener('click', async () => {
    const pin = document.getElementById('panic-pin-input')?.value?.trim();
    const isPro = await checkPremium();
    if (pin === currentPanicPin) {
      isPanicUnlocked = true;
      isPanicEmergencyDecoy = false;
      initPanicMode();
    } else if (isPro && currentPanicEmergencyPin && pin === currentPanicEmergencyPin) {
      isPanicUnlocked = true;
      isPanicEmergencyDecoy = true;
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

    // Trigger Gmail Compose Auto-Backup with user email prompt
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (userInfo) => {
      const detectedEmail = userInfo ? userInfo.email : '';
      const email = prompt("Please enter your email address to send the PIN to yourself in case you forget it:", detectedEmail || "") || '';
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent('Lord of the Tabs - Your Panic Mode PIN')}&body=${encodeURIComponent('Your registered PIN for Panic Mode is: ' + pin)}`;
      chrome.tabs.create({ url: gmailUrl });
    });

    initPanicMode();
  });

  document.getElementById('btn-panic-relock')?.addEventListener('click', () => {
    isPanicUnlocked = false;
    isPanicEmergencyDecoy = false;
    initPanicMode();
  });

  document.getElementById('btn-panic-save-emergency-pin')?.addEventListener('click', async () => {
    const isPro = await checkPremium();
    if (!isPro) {
      alert('🔒 Recurso Pro: Ative uma licença Pro para usar o Código de Emergência.');
      return;
    }
    const val = document.getElementById('panic-emergency-pin-input')?.value?.trim();
    if (!val || val.length !== 4 || isNaN(val)) {
      alert('Por favor digite um PIN numérico de 4 dígitos.');
      return;
    }
    if (val === currentPanicPin) {
      alert('O Código de Emergência não pode ser igual ao PIN real!');
      return;
    }
    await chrome.storage.local.set({ panicEmergencyPin: val });
    currentPanicEmergencyPin = val;
    const input = document.getElementById('panic-emergency-pin-input');
    if (input) input.value = '';
    const status = document.getElementById('emergency-pin-status');
    if (status) {
      status.textContent = '✓ Código de emergência ativo.';
      status.style.color = '#15803d';
    }
    alert('Código de Emergência salvo! Ao digitar esse PIN no Vault ou nas Configurações, o sistema fingirá estar destrancado com 0 itens.');
  });

  document.getElementById('btn-panic-remove-emergency-pin')?.addEventListener('click', async () => {
    await chrome.storage.local.remove('panicEmergencyPin');
    currentPanicEmergencyPin = null;
    const input = document.getElementById('panic-emergency-pin-input');
    if (input) input.value = '';
    const status = document.getElementById('emergency-pin-status');
    if (status) {
      status.textContent = 'Código de emergência removido.';
      status.style.color = '#854d0e';
    }
  });

  document.getElementById('btn-panic-change-pin')?.addEventListener('click', () => {
    const box = document.getElementById('panic-change-pin-box');
    if (box) {
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      document.getElementById('panic-new-pin-input').value = '';
    }
  });

  document.getElementById('btn-panic-cancel-change')?.addEventListener('click', () => {
    const box = document.getElementById('panic-change-pin-box');
    if (box) {
      box.style.display = 'none';
      document.getElementById('panic-new-pin-input').value = '';
    }
  });

  document.getElementById('btn-panic-save-new-pin')?.addEventListener('click', async () => {
    const newPin = document.getElementById('panic-new-pin-input')?.value?.trim();
    if (!newPin || newPin.length !== 4 || isNaN(newPin)) {
      alert('Please enter a valid 4-digit numeric PIN.');
      return;
    }

    await chrome.storage.local.set({ panicPin: newPin });
    currentPanicPin = newPin;

    // Trigger Gmail Compose Auto-Backup with user email prompt
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (userInfo) => {
      const detectedEmail = userInfo ? userInfo.email : '';
      const email = prompt("Please enter your email address to send the PIN to yourself in case you forget it:", detectedEmail || "") || '';
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent('Lord of the Tabs - Your Panic Mode PIN')}&body=${encodeURIComponent('Your registered PIN for Panic Mode is: ' + newPin)}`;
      chrome.tabs.create({ url: gmailUrl });
    });

    alert('PIN updated successfully! A backup email compose window has been opened.');
    const box = document.getElementById('panic-change-pin-box');
    if (box) box.style.display = 'none';
  });

  document.getElementById('panic-domain-filter')?.addEventListener('input', (e) => {
    renderPanicDomainsList(e.target.value);
  });

  document.getElementById('btn-panic-add')?.addEventListener('click', async () => {
    const input = document.getElementById('panic-add-input');
    const domain = cleanDomain(input?.value);
    if (!domain) return;

    const isWhitelist = settings.panicType === 'whitelist';
    if (isWhitelist) {
      if (!currentPanicSafeDomains.includes(domain)) {
        currentPanicSafeDomains.push(domain);
        await chrome.storage.local.set({ panicSafeDomains: currentPanicSafeDomains });
        channel.postMessage({ action: 'update_meta' });
      }
    } else {
      if (!currentPanicDomains.includes(domain)) {
        currentPanicDomains.push(domain);
        await chrome.storage.local.set({ panicDomains: currentPanicDomains });
        channel.postMessage({ action: 'update_meta' });
      }
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
        const isAlreadyAdded = settings.panicType === 'whitelist'
          ? currentPanicSafeDomains.includes(domain)
          : currentPanicDomains.includes(domain);
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

  document.getElementById('btn-panic-select-all')?.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.panic-tab-checkbox:not(:disabled)');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => {
      cb.checked = !allChecked;
    });
  });

  document.getElementById('btn-panic-confirm-capture')?.addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.panic-tab-checkbox:checked:not(:disabled)');
    let addedCount = 0;
    const isWhitelist = settings.panicType === 'whitelist';
    checkboxes.forEach(cb => {
      const val = cb.value;
      if (val) {
        if (isWhitelist) {
          if (!currentPanicSafeDomains.includes(val)) {
            currentPanicSafeDomains.push(val);
            addedCount++;
          }
        } else {
          if (!currentPanicDomains.includes(val)) {
            currentPanicDomains.push(val);
            addedCount++;
          }
        }
      }
    });

    if (addedCount > 0) {
      if (isWhitelist) {
        await chrome.storage.local.set({ panicSafeDomains: currentPanicSafeDomains });
      } else {
        await chrome.storage.local.set({ panicDomains: currentPanicDomains });
      }
      channel.postMessage({ action: 'update_meta' });
      renderPanicDomainsList(document.getElementById('panic-domain-filter')?.value || '');
    }

    const box = document.getElementById('panic-tab-capture-box');
    if (box) box.style.display = 'none';
  });



  document.getElementById('btn-configure-shortcuts')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  document.getElementById('panic-type-select')?.addEventListener('change', async (e) => {
    settings.panicType = e.target.value;
    await saveSettings();
    applyLayoutSettings();
    renderPanicDomainsList(document.getElementById('panic-domain-filter')?.value || '');
  });

  document.getElementById('panic-method-select')?.addEventListener('change', async (e) => {
    settings.panicMethod = e.target.value;
    await saveSettings();
  });

  document.getElementById('panic-landing-input')?.addEventListener('input', async (e) => {
    settings.panicLandingPage = e.target.value.trim() || 'dashboard.html';
    await saveSettings();
  });

  document.getElementById('panic-autoclose-input')?.addEventListener('input', async (e) => {
    let val = parseInt(e.target.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 48) val = 48;
    settings.panicAutoCloseHours = val;
    await saveSettings();
  });

  document.getElementById('auto-purge-sensitive-history-toggle')?.addEventListener('change', async (e) => {
    const isPro = await checkPremium();
    if (!isPro) {
      alert('🔒 Recurso Pro: Ative uma licença Pro para usar o Auto-Purge de Histórico Sensível.');
      e.target.checked = false;
      return;
    }
    settings.autoPurgeSensitiveHistory = e.target.checked;
    await saveSettings();
  });

  document.getElementById('btn-pro-activate')?.addEventListener('click', async () => {
    const input = document.getElementById('pro-license-input');
    const key = input ? input.value : '';
    const success = await activatePro(key);
    if (success) {
      alert(getMessage('activationSuccess') || 'Pro Activation Successful!');
      if (input) input.value = '';
      await updateLicensingUI();
      render();
    } else {
      alert(getMessage('activationFailed') || 'Invalid license key format.');
    }
  });

  document.getElementById('btn-pro-dev-toggle')?.addEventListener('click', async () => {
    const nextState = await toggleDevPro();
    alert(`Testing Mode: Switched to ${nextState ? 'PRO' : 'FREE'} tier.`);
    await updateLicensingUI();
    render();
  });
}

async function updateLicensingUI() {
  const isPro = await checkPremium();
  const proBadge = document.getElementById('pro-badge');
  const lockLabels = document.querySelectorAll('.pro-lock-label');
  
  if (proBadge) {
    if (isPro) {
      proBadge.textContent = 'Pro';
      proBadge.style.background = '#dcfce7';
      proBadge.style.color = '#15803d';
    } else {
      proBadge.textContent = 'Free';
      proBadge.style.background = '#e2e8f0';
      proBadge.style.color = '#475569';
    }
  }

  lockLabels.forEach(el => {
    el.style.display = isPro ? 'none' : 'inline';
  });

  const premiumInputs = [
    'auto-archive-days',
    'backup-interval-days',
    'backup-mode',
    'panic-type-select',
    'panic-method-select',
    'panic-landing-input',
    'panic-autoclose-input',
    'btn-panic-capture-tabs'
  ];

  premiumInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = !isPro;
      if (!isPro) {
        el.style.opacity = '0.6';
        el.style.cursor = 'not-allowed';
      } else {
        el.style.opacity = '1';
        el.style.cursor = '';
      }
    }
  });
}
