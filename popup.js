import { getTabMeta, saveTabMeta } from './storage.js';

// --- State Management ---
let allWindows = [];
let currentView = 'grid'; 
let selectedIds = new Set();
let exactMatch = false;
let starFilter = 0;
let tabMetas = {}; // Cache for synchronous rendering

const channel = new BroadcastChannel('tab_sync');

// Settings State (with defaults)
let settings = {
  primary_click_action: 'switch',
  ghost_filter_enabled: true,
  ghost_filter_scope: 'subdomain',
  startup_focus: false
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  
  if (settings.startup_focus) {
    document.getElementById('search').focus();
  } else {
    document.getElementById('search').value = '';
  }
  
  await refreshState();
  render();
  setupEventListeners();
  setupSettingsListeners();
});

channel.onmessage = (msg) => {
  if (msg.data.action === 'update_meta') {
    tabMetas[msg.data.url] = msg.data.meta;
    render();
  }
};

// --- Settings Logic ---
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(settings, (items) => {
      settings = items;
      
      document.getElementById('primary_click_action').value = settings.primary_click_action;
      document.getElementById('ghost_filter_enabled').checked = settings.ghost_filter_enabled;
      document.getElementById('ghost_filter_scope').value = settings.ghost_filter_scope;
      document.getElementById('startup_focus').checked = settings.startup_focus;
      
      resolve();
    });
  });
}

function saveSetting(key, value) {
  settings[key] = value;
  chrome.storage.sync.set({ [key]: value });
}

// --- Core Data ---
async function refreshState() {
  allWindows = await chrome.windows.getAll({ populate: true });
  for (const win of allWindows) {
    for (const tab of win.tabs) {
      if (tab.url) tabMetas[tab.url] = await getTabMeta(tab.url);
    }
  }
}

// --- Rendering ---
function render() {
  const canvas = document.getElementById('canvas');
  canvas.innerHTML = '';
  
  const query = document.getElementById('search').value.toLowerCase();
  
  allWindows.forEach((win, index) => {
    const pane = document.createElement('div');
    pane.className = 'window-pane';
    
    const winHeader = document.createElement('div');
    winHeader.className = 'window-header';
    winHeader.innerText = `Window ${index + 1} (${win.tabs.length})`;
    winHeader.title = "Click to focus window";
    winHeader.addEventListener('click', () => {
      chrome.windows.update(win.id, { focused: true });
    });
    pane.appendChild(winHeader);
    
    const scrollArea = document.createElement('div');
    scrollArea.className = 'scroll-area';
    
    const container = document.createElement('div');
    container.className = currentView === 'list' ? 'tab-list' : 'grid-container';
    
    win.tabs.forEach(tab => {
      const isVisible = checkVisibility(tab, query);
      
      // Prune selection if hidden by search
      if (!isVisible && selectedIds.has(tab.id)) selectedIds.delete(tab.id);
      
      const el = createTabElement(tab, isVisible, win.id);
      container.appendChild(el);
    });
    
    scrollArea.appendChild(container);
    pane.appendChild(scrollArea);
    canvas.appendChild(pane);
  });

  if (currentView === 'grid') {
    autoAdjustDensity();
  } else {
    // Reset density for list view
    document.body.classList.remove('density-compact', 'density-tiny', 'force-narrow');
  }
}

function autoAdjustDensity() {
  const body = document.body;
  const canvas = document.getElementById('canvas');
  
  // Reset to standard
  body.classList.remove('density-compact', 'density-tiny', 'force-narrow');
  
  // Heuristic check: if many windows or many tabs, start compact
  const totalTabs = allWindows.reduce((sum, win) => sum + win.tabs.length, 0);
  if (allWindows.length > 4 || totalTabs > 50) {
    body.classList.add('density-compact');
  }

  // Refine based on actual dimensions
  // Chrome popups hit 800x600 limit. 
  // We check if content would exceed these limits.
  const checkOverflow = () => {
    return canvas.scrollWidth > 800 || canvas.scrollHeight > 600;
  };

  if (checkOverflow()) {
    if (!body.classList.contains('density-compact')) {
      body.classList.add('density-compact');
    }
    
    if (checkOverflow()) {
      body.classList.remove('density-compact');
      body.classList.add('density-tiny');
      
      if (checkOverflow()) {
        body.classList.add('force-narrow');
      }
    }
  }
}

// --- Element Creation & Interaction ---
function createTabElement(tab, isVisible, windowId) {
  const el = document.createElement('div');
  const isSelected = selectedIds.has(tab.id);
  const meta = tabMetas[tab.url] || { importancia: 0 };
  
  const baseClass = currentView === 'list' ? 'list-item' : 'grid-tile';
  el.className = `tab-element ${baseClass} ${isSelected ? 'selected' : ''} ${isVisible ? '' : 'hidden'}`;
  el.dataset.url = tab.url;
  
  const starsHtml = `<div class="star-rating" data-url="${tab.url}">
      ${[1,2,3,4,5].map(i => `<span class="star ${i <= meta.importancia ? 'active' : ''}" data-val="${i}">★</span>`).join('')}
    </div>`;
  
  if (currentView === 'list') {
    el.innerHTML = `
      <img class="favicon" src="${tab.favIconUrl || 'icons/icon16.png'}">
      <span class="tab-title">${tab.title}</span>
      <div class="list-stars">${starsHtml}</div>
    `;
  } else {
    el.innerHTML = `
      <img class="tile-favicon" src="${tab.favIconUrl || 'icons/icon16.png'}">
      ${meta.importancia > 0 ? `<div class="grid-star">★${meta.importancia}</div>` : ''}
    `;
  }

  // Star Click Logic (List mode only, as grid tile is too small)
  if (currentView === 'list') {
    el.querySelectorAll('.star').forEach(star => {
      star.addEventListener('click', async (e) => {
        e.stopPropagation(); // Don't trigger tab selection/filter
        const val = parseInt(e.target.dataset.val);
        meta.importancia = meta.importancia === val ? 0 : val;
        tabMetas[tab.url] = meta;
        await saveTabMeta(meta);
        channel.postMessage({ action: 'update_meta', url: tab.url, meta });
        render();
      });
    });
  }
  
  // --- Tooltip & Ghosting Hover ---
  el.addEventListener('mouseenter', (e) => {
    const tooltip = document.getElementById('tooltip');
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<strong>${tab.title}</strong><br>${tab.url}`;
    
    if (settings.ghost_filter_enabled) {
      applyGhosting(tab.url, el);
    }
  });

  el.addEventListener('mousemove', (e) => {
    const tooltip = document.getElementById('tooltip');
    tooltip.style.left = (e.clientX + 15) + 'px';
    tooltip.style.top = (e.clientY + 15) + 'px';
  });
  
  el.addEventListener('mouseleave', () => {
    document.getElementById('tooltip').style.display = 'none';
    if (settings.ghost_filter_enabled) removeGhosting();
  });
  
  // --- Click Behavior Logic ---
  el.addEventListener('click', async (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (selectedIds.has(tab.id)) selectedIds.delete(tab.id);
      else selectedIds.add(tab.id);
      render();
      return;
    }

    if (settings.primary_click_action === 'switch') {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(windowId, { focused: true });
      window.close();
    } else {
      document.getElementById('search').value = tab.url;
      render();
    }
  });

  // --- Right Click (Context Menu) Logic ---
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    document.getElementById('search').value = tab.url;
    render();
  });
  
  return el;
}

// --- Ghosting Helper Functions ---
function getScopeMatchString(urlStr, scope) {
  if (!urlStr) return '';
  try {
    const url = new URL(urlStr);
    if (scope === 'url') {
      return url.href.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    if (scope === 'domain') {
      return url.hostname;
    }
    if (scope === 'subdomain') {
      let host = url.hostname;
      if (host.startsWith('www.')) host = host.substring(4);
      if (host.startsWith('m.')) host = host.substring(2);
      return host;
    }
  } catch (e) {
    return urlStr;
  }
}

function applyGhosting(hoveredUrl, hoveredElement) {
  if (!hoveredUrl) return;
  const canvas = document.getElementById('canvas');
  canvas.classList.add('ghosting-active');
  
  const targetScopeString = getScopeMatchString(hoveredUrl, settings.ghost_filter_scope);
  
  const allElements = document.querySelectorAll('.tab-element');
  allElements.forEach(el => {
    const elUrl = el.dataset.url;
    const elScopeString = getScopeMatchString(elUrl, settings.ghost_filter_scope);
    
    if (elScopeString === targetScopeString) {
      el.classList.add('ghost-match');
    }
  });
  hoveredElement.classList.add('ghost-hovered');
}

function removeGhosting() {
  const canvas = document.getElementById('canvas');
  canvas.classList.remove('ghosting-active');
  document.querySelectorAll('.ghost-match').forEach(el => el.classList.remove('ghost-match'));
  document.querySelectorAll('.ghost-hovered').forEach(el => el.classList.remove('ghost-hovered'));
}

// --- Search / Filter Logic ---
function checkVisibility(tab, query) {
  const meta = tabMetas[tab.url] || { importancia: 0 };
  
  // Star filter
  if (starFilter > 0 && meta.importancia < starFilter) {
    return false;
  }

  if (!query) return true;
  
  const cleanUrl = tab.url ? tab.url.replace(/^https?:\/\//, '').toLowerCase() : '';
  const cleanQuery = query.replace(/^https?:\/\//, '').toLowerCase();
  const title = (tab.title || '').toLowerCase();

  if (exactMatch) {
    return cleanUrl === cleanQuery || title === query;
  }
  return cleanUrl.includes(cleanQuery) || title.includes(query);
}

// --- Event Listeners ---
function setupEventListeners() {
  const searchInput = document.getElementById('search');
  searchInput.addEventListener('input', render);

  document.getElementById('clear-search').addEventListener('click', () => {
    searchInput.value = '';
    render();
  });
  
  document.getElementById('btn-pull').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      searchInput.value = tabs[0].url;
      render();
    }
  });
  
  document.getElementById('exact-toggle').addEventListener('change', (e) => {
    exactMatch = e.target.checked;
    render();
  });
  
  document.getElementById('star-filter').addEventListener('change', (e) => {
    starFilter = parseInt(e.target.value);
    render();
  });

  document.getElementById('view-toggle').addEventListener('click', (e) => {
    currentView = currentView === 'list' ? 'grid' : 'list';
    e.target.innerText = currentView === 'list' ? '≣' : '⊞';
    render();
  });
  
  document.getElementById('btn-expand').addEventListener('click', () => {
    chrome.tabs.create({ url: 'dashboard.html' });
  });

  // Action Buttons
  document.getElementById('btn-close').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    if (confirm(`Close ${selectedIds.size} tabs?`)) {
      await chrome.tabs.remove(Array.from(selectedIds));
      selectedIds.clear();
      await refreshState();
      render();
    }
  });
  
  document.getElementById('btn-discard').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    await Promise.all(Array.from(selectedIds).map(id => chrome.tabs.discard(id)));
    selectedIds.clear();
    await refreshState();
    render();
  });

  document.getElementById('btn-move-tabs').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    
    const windows = await chrome.windows.getAll();
    const options = windows.map((win, idx) => `${idx + 1}: Window ${idx + 1}`).join('\n');
    const choice = prompt(`Move ${selectedIds.size} tabs to?\n${options}\nOr type "new" for a new window:`);
    
    if (!choice) return;
    
    const tabIds = Array.from(selectedIds);
    if (choice.toLowerCase() === 'new') {
      const firstId = tabIds.shift();
      const newWin = await chrome.windows.create({ tabId: firstId });
      if (tabIds.length > 0) {
        await chrome.tabs.move(tabIds, { windowId: newWin.id, index: -1 });
      }
    } else {
      const idx = parseInt(choice) - 1;
      if (windows[idx]) {
        await chrome.tabs.move(tabIds, { windowId: windows[idx].id, index: -1 });
      } else {
        alert('Invalid window number');
        return;
      }
    }
    
    selectedIds.clear();
    await refreshState();
    render();
  });

  document.getElementById('btn-delete-history').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    
    const selectedTabs = allWindows.flatMap(w => w.tabs).filter(t => selectedIds.has(t.id));
    const domains = new Set(selectedTabs.map(t => new URL(t.url).hostname));
    const domainList = Array.from(domains).join(', ');
    
    if (confirm(`Delete ALL browser history for these domains?\n${domainList}`)) {
      for (const domain of domains) {
        const historyItems = await chrome.history.search({ text: domain, maxResults: 10000, startTime: 0 });
        const itemsToRemove = historyItems.filter(item => {
          try { return new URL(item.url).hostname === domain; } catch(e) { return false; }
        });
        
        for (const item of itemsToRemove) {
          await chrome.history.deleteUrl({ url: item.url });
        }
      }
      alert(`History cleared for ${domains.size} domains.`);
    }
  });
}

function setupSettingsListeners() {
  const pane = document.getElementById('settings-pane');
  
  document.getElementById('settings-toggle').addEventListener('click', () => {
    pane.classList.add('open');
  });
  
  document.getElementById('close-settings').addEventListener('click', () => {
    pane.classList.remove('open');
  });

  // Sync inputs to storage
  document.getElementById('primary_click_action').addEventListener('change', (e) => {
    saveSetting('primary_click_action', e.target.value);
  });
  
  document.getElementById('ghost_filter_enabled').addEventListener('change', (e) => {
    saveSetting('ghost_filter_enabled', e.target.checked);
  });
  
  document.getElementById('ghost_filter_scope').addEventListener('change', (e) => {
    saveSetting('ghost_filter_scope', e.target.value);
  });
  
  document.getElementById('startup_focus').addEventListener('change', (e) => {
    saveSetting('startup_focus', e.target.checked);
  });
}