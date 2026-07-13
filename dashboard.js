import { 
  getTabMeta, saveTabMeta, getArchivedTabs, 
  deleteArchivedTab, saveWorkspace, getAllWorkspaces, 
  deleteWorkspace 
} from './storage.js';

const channel = new BroadcastChannel('tab_sync');
let allTabs = [];
let archivedTabs = [];
let savedWorkspaces = [];
let recentWindows = [];
const AFFILIATE_LINKS = {
  amazon: 'https://www.amazon.com.br/?tag=lordoftabs-20',
  mercadolivre: 'https://mercadolivre.com.br/seu-link-de-afiliado',
  aliexpress: 'https://s.click.aliexpress.com/e/seu-id'
};
let enableAffiliateSpeedDial = true;
let sortConfig = { key: 'importance', direction: 'desc' };
let filters = { title: '', url: '', age: 0, importance: 0, exactUrl: false };
let groupBy = 'window'; 
let selectedIds = new Set();
let selectedGroupKeys = new Set();
let windowCollapseStates = {};
let activeTabId = null;
let activeWindowId = null;
let currentView = 'table';
let settings = {};
let vaultGroupBy = 'date';
let lastVaultAccessTime = 0;

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(['popupSettings', 'lastVaultAccessTime']);
  settings = data.popupSettings || {};
  lastVaultAccessTime = data.lastVaultAccessTime || 0;
  
  if (settings.setDashboardAsNewTab === false) {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('manual')) {
      window.location.href = "chrome-search://local-ntp/local-ntp.html"; 
      return;
    }
  }

  await loadData();
  setupEventListeners();
  setupViewNavigation();
  render();
});

channel.onmessage = (msg) => {
  if (msg.data.action === 'update_meta' || msg.data.action === 'workspace_update') {
    loadData().then(render);
  }
};

async function loadData() {
  const [tabs, windows, archived, workspaces, activeTabs, data, recentSessions, syncData] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll(),
    getArchivedTabs(),
    getAllWorkspaces(),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    chrome.storage.local.get('popupSettings'),
    new Promise((resolve) => {
      if (chrome.sessions && chrome.sessions.getRecentlyClosed) {
        chrome.sessions.getRecentlyClosed({ maxResults: 25 }, resolve);
      } else {
        resolve([]);
      }
    }),
    chrome.storage.sync.get('enableAffiliateSpeedDial')
  ]);
  
  settings = data.popupSettings || {};
  enableAffiliateSpeedDial = syncData.enableAffiliateSpeedDial !== false;
  
  const activeTab = activeTabs[0];
  if (activeTab) {
    activeTabId = activeTab.id;
    activeWindowId = activeTab.windowId;
  }

  archivedTabs = archived;
  savedWorkspaces = workspaces;
  recentWindows = (recentSessions || []).filter(s => s.window);
  const windowMap = new Map();
  windows.forEach((win, idx) => windowMap.set(win.id, idx + 1));

  allTabs = [];
  for (const tab of tabs) {
    if (tab.url) {
      const meta = await getTabMeta(tab.url);
      allTabs.push({
        id: tab.id,
        windowId: tab.windowId,
        windowIndex: windowMap.get(tab.windowId) || '?',
        title: tab.title || '',
        url: tab.url,
        domain: new URL(tab.url).hostname.replace('www.', ''),
        favIconUrl: tab.favIconUrl,
        meta: meta,
        ageMins: Math.floor((Date.now() - meta.data_abertura) / 60000),
        memory: tab.discarded ? 15 : 80 + (tab.url.length % 200)
      });
    }
  }
}

function setupEventListeners() {
  document.getElementById('group-by-select').addEventListener('change', (e) => {
    groupBy = e.target.value;
    selectedGroupKeys.clear();
    render();
  });

  document.getElementById('exact-url-toggle').addEventListener('change', (e) => {
    filters.exactUrl = e.target.checked;
    render();
  });

  document.getElementById('select-all').addEventListener('change', (e) => {
    const processed = getProcessedData();
    if (e.target.checked) processed.forEach(t => selectedIds.add(t.id));
    else {
      selectedIds.clear();
      selectedGroupKeys.clear();
    }
    render();
  });

  document.getElementById('btn-close-selected').addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: 'triggerPanic' }, () => {
      loadData().then(render);
    });
  });

  document.getElementById('btn-close-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    if (confirm(`Close ${selectedIds.size} tabs?`)) {
      await chrome.tabs.remove(Array.from(selectedIds));
      selectedIds.clear();
      selectedGroupKeys.clear();
      await loadData();
      render();
    }
  });

  document.getElementById('btn-delete-history-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;

    const selectedTabs = allTabs.filter(t => selectedIds.has(t.id));
    const urls = selectedTabs.map(t => t.url);
    const domains = new Set(selectedTabs.map(t => t.domain));

    const choice = prompt(
      `Delete history for ${selectedIds.size} selected tabs?\n\n` +
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
    await loadData();
    render();
  });

  document.getElementById('btn-merge-duplicates').addEventListener('click', async () => {
    const urlGroups = {};
    allTabs.forEach(tab => {
      if (!urlGroups[tab.url]) urlGroups[tab.url] = [];
      urlGroups[tab.url].push(tab);
    });
    for (const url in urlGroups) {
      if (urlGroups[url].length > 1) {
        const group = urlGroups[url].sort((a, b) => b.meta.ultimo_acesso - a.meta.ultimo_acesso);
        await chrome.tabs.remove(group.slice(1).map(t => t.id));
      }
    }
    await loadData();
    render();
  });

  document.querySelectorAll('.sortable').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.sort;
      if (sortConfig.key === key) sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
      else { sortConfig.key = key; sortConfig.direction = 'desc'; }
      render();
    });
  });

  document.querySelectorAll('.col-filter').forEach(input => {
    input.addEventListener('input', (e) => {
      const col = e.target.dataset.col;
      const val = e.target.value.toLowerCase();
      filters[col] = (col === 'age' || col === 'importance') ? parseInt(val) || 0 : val;
      render();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  });

  document.getElementById('exact-url-toggle')?.addEventListener('click', (e) => e.stopPropagation());

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    await loadData();
    render();
  });

  document.getElementById('btn-help')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'help.html' });
  });

  document.getElementById('vault-group-by-select')?.addEventListener('change', (e) => {
    vaultGroupBy = e.target.value;
    render();
  });

  document.getElementById('sd-amazon')?.addEventListener('click', () => {
    chrome.tabs.create({ url: AFFILIATE_LINKS.amazon });
  });

  document.getElementById('sd-mercadolivre')?.addEventListener('click', () => {
    chrome.tabs.create({ url: AFFILIATE_LINKS.mercadolivre });
  });

  document.getElementById('sd-aliexpress')?.addEventListener('click', () => {
    chrome.tabs.create({ url: AFFILIATE_LINKS.aliexpress });
  });

  document.getElementById('btn-bundle-selected')?.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const name = prompt("Enter a name for this workspace:");
    if (!name) return;
    
    const selectedTabs = allTabs.filter(t => selectedIds.has(t.id));
    const workspace = {
      name: name,
      tabCount: selectedTabs.length,
      tabs: selectedTabs.map(t => ({ title: t.title || t.url, url: t.url })),
      createdAt: Date.now()
    };
    
    await saveWorkspace(workspace);
    
    if (confirm(`Workspace "${name}" saved! Do you want to close these ${selectedTabs.length} tabs now?`)) {
      await chrome.tabs.remove(Array.from(selectedIds));
      selectedIds.clear();
      selectedGroupKeys.clear();
    }
    
    await loadData();
    render();
  });

  document.getElementById('btn-pull-url-header')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('pull-dropdown-menu')?.classList.toggle('show');
  });

  document.getElementById('btn-pull-domain')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const firstSelectedId = Array.from(selectedIds)[0];
    const tab = allTabs.find(t => t.id === firstSelectedId);
    if (tab) {
      try {
        const url = new URL(tab.url);
        const domain = url.hostname.replace('www.', '');
        const input = document.querySelector('.col-filter[data-col="url"]');
        if (input) {
          input.value = domain;
          filters.url = domain;
          render();
        }
      } catch(err) {
        const input = document.querySelector('.col-filter[data-col="url"]');
        if (input) {
          input.value = tab.url;
          filters.url = tab.url;
          render();
        }
      }
    }
    document.getElementById('pull-dropdown-menu')?.classList.remove('show');
  });

  document.getElementById('btn-pull-full-url')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const firstSelectedId = Array.from(selectedIds)[0];
    const tab = allTabs.find(t => t.id === firstSelectedId);
    if (tab) {
      const input = document.querySelector('.col-filter[data-col="url"]');
      if (input) {
        input.value = tab.url;
        filters.url = tab.url;
        render();
      }
    }
    document.getElementById('pull-dropdown-menu')?.classList.remove('show');
  });

  document.addEventListener('click', () => {
    document.getElementById('pull-dropdown-menu')?.classList.remove('show');
  });

  document.querySelectorAll('.btn-clear-filter').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const col = btn.dataset.col;
      const input = document.querySelector(`.col-filter[data-col="${col}"]`);
      if (input) {
        input.value = '';
        filters[col] = (col === 'age' || col === 'importance') ? 0 : '';
        render();
      }
    });
  });
}

function setupViewNavigation() {
  const switchView = (name) => {
    currentView = name;
    if (name === 'vault') {
      lastVaultAccessTime = Date.now();
      chrome.storage.local.set({ lastVaultAccessTime });
    }
    ['table', 'charts', 'vault', 'workspaces'].forEach(v => {
      const btn = document.getElementById(`btn-view-${v}`);
      const view = document.getElementById(`${v}-view`);
      if (btn) btn.classList.toggle('active', v === name);
      if (view) view.style.display = v === name ? 'block' : 'none';
    });
    render();
  };

  ['table', 'charts', 'vault', 'workspaces'].forEach(v => {
    const btn = document.getElementById(`btn-view-${v}`);
    if (btn) btn.addEventListener('click', () => switchView(v));
  });
}

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
    return url1.toLowerCase().includes(url2.toLowerCase()) || url2.toLowerCase().includes(url1.toLowerCase());
  }
}

function getProcessedData() {
  const normalize = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const normalizedQuery = normalize(filters.url);

  let filtered = allTabs.filter(tab => {
    const titleMatch = (tab.meta.customTitle || tab.title).toLowerCase().includes(filters.title);
    
    let urlMatch = false;
    if (filters.url === '') {
      urlMatch = true;
    } else if (filters.exactUrl) {
      const scope = settings.ghostScope || 'domain';
      urlMatch = matchGhost(tab.url, filters.url, scope) || tab.url.toLowerCase() === filters.url.toLowerCase();
    } else {
      urlMatch = tab.url.toLowerCase().includes(filters.url);
    }

    const ageMatch = filters.age === 0 || tab.ageMins >= filters.age;
    const starMatch = filters.importance === 0 || tab.meta.importancia >= filters.importance;
    return titleMatch && urlMatch && ageMatch && starMatch;
  });

  filtered.sort((a, b) => {
    const valA = a.meta[sortConfig.key] || a[sortConfig.key];
    const valB = b.meta[sortConfig.key] || b[sortConfig.key];
    if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
    if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });
  return filtered;
}

function render() {
  const processed = getProcessedData();
  document.getElementById('tab-count').innerText = `${processed.length} / ${allTabs.length} Tabs`;
  
  const hasSelection = selectedIds.size > 0;
  const bulkButtons = [
    'btn-close-selected', 
    'btn-discard-selected', 
    'btn-move-selected', 
    'btn-bundle-selected', 
    'btn-delete-history-selected',
    'btn-pull-url-header'
  ];
  bulkButtons.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !hasSelection;
  });

  const hasNewVaultItems = archivedTabs.some(t => t.archivedAt && t.archivedAt > lastVaultAccessTime);
  const vaultBtn = document.getElementById('btn-view-vault');
  if (vaultBtn) {
    vaultBtn.classList.toggle('has-unread', hasNewVaultItems);
  }

  const speedDialSection = document.getElementById('speed-dial-section');
  if (speedDialSection) {
    speedDialSection.style.display = enableAffiliateSpeedDial ? 'flex' : 'none';
  }
  
  if (currentView === 'table') renderTable(processed); 
  else if (currentView === 'charts') renderCharts();
  else if (currentView === 'vault') {
    renderVault();
    renderRecentWindows();
  }
  else if (currentView === 'workspaces') renderWorkspaces();
}

function renderTable(processed) {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  
  if (groupBy === 'none') {
    processed.forEach(tab => renderRow(tbody, tab));
  } else {
    const groups = {};
    processed.forEach(tab => {
      let key = 'Other';
      if (groupBy === 'window') key = `Window ${tab.windowIndex}`;
      else if (groupBy === 'domain') key = tab.domain;
      else if (groupBy === 'url') key = tab.url;
      else if (groupBy === 'importance') key = `${tab.meta.importancia || 0} Stars`;
      
      if (!groups[key]) groups[key] = [];
      groups[key].push(tab);
    });

    for (const [key, tabs] of Object.entries(groups)) {
      const isGroupActive = tabs.some(t => t.id === activeTabId);
      const isGroupSelected = selectedGroupKeys.has(key);

      const headerTr = document.createElement('tr');
      headerTr.className = `group-header ${isGroupActive ? 'group-active' : ''} ${isGroupSelected ? 'group-selected' : ''}`;
      
      const mode = windowCollapseStates[key] || 'full';
      
      headerTr.innerHTML = `
        <td colspan="10" style="padding: 8px 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: bold;">${key} (${tabs.length})</span>
            <div class="collapse-controls" style="display: flex; gap: 4px; align-items: center;">
              <button class="btn-collapse ${mode === 'full' ? 'active' : ''}" data-win="${key}" data-mode="full" title="Expand all tabs">📜 List</button>
              <button class="btn-collapse ${mode === 'domain' ? 'active' : ''}" data-win="${key}" data-mode="domain" title="Collapse by Domain">🌐 Domain</button>
              <button class="btn-collapse ${mode === 'url' ? 'active' : ''}" data-win="${key}" data-mode="url" title="Collapse by Exact URL">🔗 URL</button>
            </div>
          </div>
        </td>
      `;

      headerTr.addEventListener('click', (e) => {
        if (e.target.closest('.collapse-controls')) return;
        if (selectedGroupKeys.has(key)) {
          selectedGroupKeys.delete(key);
          tabs.forEach(t => selectedIds.delete(t.id));
        } else {
          selectedGroupKeys.add(key);
          tabs.forEach(t => selectedIds.add(t.id));
        }
        render();
      });

      headerTr.querySelectorAll('.btn-collapse').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const winKey = btn.dataset.win;
          const targetMode = btn.dataset.mode;
          windowCollapseStates[winKey] = targetMode;
          render();
        });
      });

      tbody.appendChild(headerTr);

      if (mode === 'full') {
        tabs.forEach(tab => renderRow(tbody, tab));
      } else if (mode === 'domain') {
        const domainGroups = {};
        tabs.forEach(t => {
          let cleanDomain = 'Other';
          try {
            const url = new URL(t.url);
            cleanDomain = url.hostname.replace(/^www\d*\./, '').replace(/^m\./, '');
          } catch(err) {
            cleanDomain = t.url || 'Other';
          }
          if (!domainGroups[cleanDomain]) domainGroups[cleanDomain] = [];
          domainGroups[cleanDomain].push(t);
        });
        
        for (const [dom, subTabs] of Object.entries(domainGroups)) {
          renderRollupRow(tbody, key, dom, subTabs, 'Domain');
        }
      } else if (mode === 'url') {
        const urlGroups = {};
        tabs.forEach(t => {
          const urlKey = t.url;
          if (!urlGroups[urlKey]) urlGroups[urlKey] = [];
          urlGroups[urlKey].push(t);
        });
        
        for (const [url, subTabs] of Object.entries(urlGroups)) {
          if (subTabs.length > 1) {
            renderRollupRow(tbody, key, url, subTabs, 'URL');
          } else {
            renderRow(tbody, subTabs[0]);
          }
        }
      }
    }
  }
}

function renderRollupRow(tbody, groupKey, label, tabList, type) {
  const tr = document.createElement('tr');
  tr.className = 'rollup-row';
  
  const totalMemory = tabList.reduce((sum, t) => sum + (t.memory || 0), 0);
  const maxAge = Math.max(...tabList.map(t => t.ageMins || 0));
  const maxImportance = Math.max(...tabList.map(t => t.meta.importancia || 0));
  const firstTab = tabList[0] || {};
  const faviconUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(firstTab.url)}&size=32`;
  
  const selectedCount = tabList.filter(t => selectedIds.has(t.id)).length;
  const allSelected = selectedCount === tabList.length;
  const partiallySelected = selectedCount > 0 && selectedCount < tabList.length;
  
  const isRowActive = tabList.some(t => t.id === activeTabId);
  if (isRowActive) tr.classList.add('row-active');
  if (allSelected) tr.classList.add('row-selected');
  
  tr.innerHTML = `
    <td>
      <label class="rollup-checkbox-label">
        <input type="checkbox" class="rollup-select" ${allSelected ? 'checked' : ''}>
        <span class="group-badge">${tabList.length}</span>
      </label>
    </td>
    <td><button class="goto-btn">↗️</button></td>
    <td><img src="${faviconUrl}" width="16"></td>
    <td class="truncate" style="font-weight: bold; color: #1e293b;">${label}</td>
    <td class="truncate" style="color: #64748b; font-size: 11px;">(${tabList.length} tabs collapsed by ${type})</td>
    <td>${firstTab.windowIndex}</td>
    <td>${totalMemory}MB</td>
    <td>${maxAge}m</td>
    <td></td>
    <td>
      <div class="star-rating">
        ${[1,2,3,4,5].map(i => `<span class="star ${i <= maxImportance ? 'active' : ''}">★</span>`).join('')}
      </div>
    </td>
  `;
  
  const checkbox = tr.querySelector('.rollup-select');
  if (partiallySelected) checkbox.indeterminate = true;
  
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    if (e.target.checked) {
      tabList.forEach(t => selectedIds.add(t.id));
    } else {
      tabList.forEach(t => selectedIds.delete(t.id));
    }
    render();
  });
  
  tr.querySelector('.goto-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (firstTab.id) {
      chrome.tabs.update(firstTab.id, { active: true }); 
      chrome.windows.update(firstTab.windowId, { focused: true });
    }
  });
  
  tbody.appendChild(tr);
}

function renderRow(tbody, tab) {
  const tr = document.createElement('tr');
  if (selectedIds.has(tab.id)) tr.classList.add('row-selected');
  if (tab.id === activeTabId) tr.classList.add('row-active');
  
  const displayTitle = tab.meta.customTitle || tab.title;
  const faviconUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`;

  tr.innerHTML = `
    <td><input type="checkbox" class="tab-select" ${selectedIds.has(tab.id) ? 'checked' : ''}></td>
    <td><button class="goto-btn">↗️</button></td>
    <td><img src="${faviconUrl}" width="16"></td>
    <td class="truncate">${displayTitle}</td>
    <td class="truncate">${tab.url}</td>
    <td>${tab.windowIndex}</td>
    <td>${tab.memory}MB</td>
    <td>${tab.ageMins}m</td>
    <td style="font-size: 11px;">${new Date(tab.meta.ultimo_acesso).toLocaleString()}</td>
    <td><div class="star-rating">${[1,2,3,4,5].map(i => `<span class="star ${i <= tab.meta.importancia ? 'active' : ''}" data-val="${i}">★</span>`).join('')}</div></td>
  `;
  
  tr.querySelector('.tab-select').addEventListener('change', (e) => { 
    if (e.target.checked) selectedIds.add(tab.id); else selectedIds.delete(tab.id); 
    render(); 
  });
  tr.querySelector('.goto-btn').addEventListener('click', () => { 
    chrome.tabs.update(tab.id, { active: true }); 
    chrome.windows.update(tab.windowId, { focused: true }); 
  });
  
  tr.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', async (e) => {
      const val = parseInt(e.target.dataset.val);
      tab.meta.importancia = tab.meta.importancia === val ? 0 : val;
      await saveTabMeta(tab.meta);
      channel.postMessage({ action: 'update_meta', url: tab.url, meta: tab.meta });
      render();
    });
  });
  tbody.appendChild(tr);
}

function renderCharts() {
  try {
    const containerDomains = document.getElementById('chart-domains');
    const containerMemory = document.getElementById('chart-memory-window');
    const containerMixed = document.getElementById('chart-mixed');
    if (!containerDomains || !containerMemory || !containerMixed) return;

    const domainCounts = {};
    allTabs.forEach(t => {
      const d = t.domain || 'Other';
      domainCounts[d] = (domainCounts[d] || 0) + 1;
    });
    const sortedDomains = Object.entries(domainCounts).sort((a,b) => b[1] - a[1]).slice(0, 10);
    containerDomains.innerHTML = createBarChart(sortedDomains, '#3b82f6');

    const windowMemory = {};
    allTabs.forEach(t => {
      const idx = t.windowIndex || '?';
      windowMemory[idx] = (windowMemory[idx] || 0) + (t.memory || 0);
    });
    const sortedMemory = Object.entries(windowMemory).sort((a,b) => b[1] - a[1]);
    containerMemory.innerHTML = createBarChart(sortedMemory, '#10b981', 'MB');

    let accumulatedPercent = 0;
    const gradientSlices = [];
    const colors = ['#3b82f6', '#10b981', '#fbbf24', '#ef4444', '#8b5cf6', '#ec4899', '#f97316', '#06b6d4', '#14b8a6', '#64748b'];

    sortedDomains.forEach(([domain, count], idx) => {
      const percent = (count / allTabs.length) * 100;
      const start = accumulatedPercent;
      const end = accumulatedPercent + percent;
      accumulatedPercent = end;
      const color = colors[idx % colors.length];
      gradientSlices.push(`${color} ${start}% ${end}%`);
    });

    if (accumulatedPercent < 100) {
      gradientSlices.push(`#cbd5e1 ${accumulatedPercent}% 100%`);
    }

    const conicGradient = `conic-gradient(${gradientSlices.join(', ')})`;

    containerMixed.innerHTML = `
      <div style="padding: 10px; text-align: center; width: 100%; display: flex; flex-direction: column; align-items: center;">
        <h4 style="margin: 0 0 10px 0; color: #475569; font-size: 15px;">Top Domains Distribution</h4>
        
        <div style="display: flex; align-items: center; justify-content: center; gap: 40px; margin-top: 15px; flex-wrap: wrap; width: 100%;">
          <!-- The Donut Pie -->
          <div style="position: relative; width: 150px; height: 150px; border-radius: 50%; background: ${conicGradient}; box-shadow: 0 4px 10px rgba(0,0,0,0.06); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
            <div style="width: 96px; height: 96px; border-radius: 50%; background: white; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: inset 0 2px 5px rgba(0,0,0,0.04);">
              <span style="font-size: 24px; font-weight: bold; color: #1e293b;">${allTabs.length}</span>
              <span style="font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Tabs</span>
            </div>
          </div>
          
          <!-- Legend -->
          <div style="display: flex; flex-direction: column; gap: 6px; text-align: left; min-width: 220px; max-width: 320px;">
            ${sortedDomains.map(([domain, count], idx) => {
              const color = colors[idx % colors.length];
              const pct = ((count / allTabs.length) * 100).toFixed(0);
              return `
                <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #334155;">
                  <div style="width: 12px; height: 12px; border-radius: 3px; background: ${color}; flex-shrink: 0;"></div>
                  <span style="font-weight: 600; min-width: 30px; text-align: right;">${pct}%</span>
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;" title="${domain}">${domain}</span>
                  <span style="color: #94a3b8; font-size: 10px;">(${count})</span>
                </div>
              `;
            }).join('')}
            ${accumulatedPercent < 99.9 ? `
              <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #334155;">
                <div style="width: 12px; height: 12px; border-radius: 3px; background: #cbd5e1; flex-shrink: 0;"></div>
                <span style="font-weight: 600; min-width: 30px; text-align: right;">${(100 - accumulatedPercent).toFixed(0)}%</span>
                <span>Other Domains</span>
                <span style="color: #94a3b8; font-size: 10px;">(${allTabs.length - sortedDomains.reduce((sum, d) => sum + d[1], 0)})</span>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    console.error("Error rendering charts:", err);
    const containerMixed = document.getElementById('chart-mixed');
    if (containerMixed) {
      containerMixed.innerHTML = `
        <div style="padding: 20px; color: #ef4444; background: #fee2e2; border-radius: 8px; margin: 10px; text-align: left; width: 100%;">
          <h4>Failed to render charts:</h4>
          <pre style="font-size: 11px; white-space: pre-wrap; font-family: monospace;">${err.stack || err.message || err}</pre>
        </div>
      `;
    }
  }
}

function createBarChart(data, color, unit = 'tabs') {
  if (data.length === 0) return '<div style="padding:20px; text-align:center;">No data</div>';
  const max = Math.max(...data.map(d => d[1]));
  return `
    <div style="display: flex; flex-direction: column; gap: 8px; padding: 10px; width: 100%;">
      ${data.map(([label, val]) => `
        <div style="display: flex; align-items: center; gap: 10px; width: 100%;">
          <div style="width: 100px; text-align: right; font-size: 11px; overflow: hidden; text-overflow: ellipsis;">${label}</div>
          <div style="flex-grow: 1; height: 12px; background: #f1f5f9; border-radius: 6px; overflow: hidden;">
            <div style="height: 100%; width: ${(val/max)*100}%; background: ${color};"></div>
          </div>
          <div style="width: 40px; font-size: 11px;">${val}${unit === 'tabs' ? '' : unit}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderVault() {
  const tbody = document.getElementById('vault-table-body');
  if (!tbody) return;
  tbody.innerHTML = archivedTabs.length ? '' : '<tr><td colspan="3" style="text-align:center; color:#64748b; padding:20px;">Vault is empty</td></tr>';
  if (archivedTabs.length === 0) return;

  const renderVaultRow = (rowContainer, tab) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${tab.title || 'Untitled'}</td>
      <td class="truncate" style="max-width: 400px;"><a href="${tab.url}" target="_blank" style="color: #2563eb; text-decoration: none;">${tab.url}</a></td>
      <td style="text-align: center;"><button class="btn-restore primary" style="padding: 4px 8px; font-size: 11px;">Restore</button></td>
    `;
    tr.querySelector('.btn-restore').addEventListener('click', async () => {
      await chrome.tabs.create({ url: tab.url });
      await deleteArchivedTab(tab.url);
      await loadData();
      render();
    });
    rowContainer.appendChild(tr);
  };

  if (vaultGroupBy === 'none') {
    archivedTabs.forEach(tab => renderVaultRow(tbody, tab));
  } else {
    const groups = {};
    const todayStr = new Date().toDateString();
    const yesterdayStr = new Date(Date.now() - 86400000).toDateString();

    archivedTabs.forEach(tab => {
      let key = 'Other';
      if (vaultGroupBy === 'date') {
        if (!tab.archivedAt) {
          key = 'Unknown Date';
        } else {
          const d = new Date(tab.archivedAt);
          const dStr = d.toDateString();
          if (dStr === todayStr) key = 'Today';
          else if (dStr === yesterdayStr) key = 'Yesterday';
          else key = d.toLocaleDateString();
        }
      } else if (vaultGroupBy === 'title') {
        const char = (tab.title || 'Untitled').trim().charAt(0).toUpperCase();
        key = /[A-Z]/.test(char) ? char : '#';
      } else if (vaultGroupBy === 'domain') {
        try {
          key = new URL(tab.url).hostname.replace(/^www\d*\./, '').replace(/^m\./, '');
        } catch(e) {
          key = tab.url || 'Other';
        }
      } else if (vaultGroupBy === 'url') {
        key = tab.url;
      } else if (vaultGroupBy === 'window') {
        key = tab.windowIndex ? `Window ${tab.windowIndex}` : 'Unknown Window';
      }
      
      if (!groups[key]) groups[key] = [];
      groups[key].push(tab);
    });

    let sortedKeys = Object.keys(groups);
    if (vaultGroupBy === 'date') {
      sortedKeys.sort((a, b) => {
        if (a === 'Today') return -1;
        if (b === 'Today') return 1;
        if (a === 'Yesterday') return -1;
        if (b === 'Yesterday') return 1;
        if (a === 'Unknown Date') return 1;
        if (b === 'Unknown Date') return -1;
        return new Date(b) - new Date(a);
      });
    } else {
      sortedKeys.sort((a, b) => a.localeCompare(b));
    }

    for (const key of sortedKeys) {
      const headerTr = document.createElement('tr');
      headerTr.className = 'group-header';
      headerTr.innerHTML = `
        <td colspan="3" style="font-weight: bold; padding: 6px 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; color: #475569;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>${key} (${groups[key].length})</span>
            <button class="primary btn-restore-vault-group" style="padding: 3px 8px; font-size: 10px; font-weight: 600; cursor: pointer; border-radius: 4px; border: 1px solid #2563eb;">Restore Group</button>
          </div>
        </td>
      `;
      headerTr.querySelector('.btn-restore-vault-group').addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabsToRestore = groups[key];
        if (confirm(`Restore all ${tabsToRestore.length} tabs in this group?`)) {
          for (const tab of tabsToRestore) {
            await chrome.tabs.create({ url: tab.url, active: false });
            await deleteArchivedTab(tab.url);
          }
          await loadData();
          render();
        }
      });
      tbody.appendChild(headerTr);
      groups[key].forEach(tab => renderVaultRow(tbody, tab));
    }
  }
}

function renderWorkspaces() {
  const container = document.getElementById('workspaces-list');
  if (!container) return;
  container.innerHTML = savedWorkspaces.length ? '' : '<div style="padding:20px; text-align:center; color:#64748b; width:100%;">No workspaces saved yet.</div>';
  
  savedWorkspaces.forEach(ws => {
    const card = document.createElement('div');
    card.className = 'workspace-card';
    
    const faviconsHTML = ws.tabs.slice(0, 10).map(t => {
      const favUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(t.url)}&size=32`;
      return `<img src="${favUrl}" class="preview-fav" title="${t.title || t.url}" width="20" height="20">`;
    }).join('');
    
    const dateStr = ws.createdAt ? new Date(ws.createdAt).toLocaleString() : 'N/A';
    
    card.innerHTML = `
      <div class="workspace-header">
        <div class="workspace-title-group">
          <span class="workspace-name">${ws.name}</span>
          <span class="workspace-date">Created: ${dateStr}</span>
        </div>
      </div>
      <div class="workspace-stats">
        <span><b>${ws.tabCount}</b> Tabs Total</span>
      </div>
      <div class="workspace-tabs-preview">
        ${faviconsHTML}
        ${ws.tabs.length > 10 ? `<span style="font-size:11px; color:#64748b; align-self:center; margin-left:4px;">+${ws.tabs.length - 10} more</span>` : ''}
      </div>
      <div class="workspace-actions">
        <button class="primary btn-restore-ws" style="padding: 6px 12px; font-size: 12px;">Restore Workspace</button>
        <button class="danger btn-delete-ws" style="padding: 6px 12px; font-size: 12px;">Delete</button>
      </div>
    `;
    
    card.querySelector('.btn-restore-ws').addEventListener('click', async () => {
      for (const t of ws.tabs) {
        await chrome.tabs.create({ url: t.url, active: false });
      }
    });
    
    card.querySelector('.btn-delete-ws').addEventListener('click', async () => {
      if (confirm(`Delete workspace "${ws.name}"?`)) {
        await deleteWorkspace(ws.id);
        await loadData();
        render();
      }
    });
    
    container.appendChild(card);
  });
}

function renderRecentWindows() {
  const container = document.getElementById('recent-windows-list');
  if (!container) return;
  
  container.innerHTML = recentWindows.length ? '' : '<div style="padding:20px; text-align:center; color:#64748b; width:100%;">No recently closed windows found in Chrome sessions.</div>';
  
  recentWindows.forEach(session => {
    const win = session.window;
    const card = document.createElement('div');
    card.className = 'workspace-card';
    
    const faviconsHTML = win.tabs.slice(0, 10).map(t => {
      const favUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(t.url)}&size=32`;
      return `<img src="${favUrl}" class="preview-fav" title="${t.title || t.url}" width="20" height="20">`;
    }).join('');
    
    const dateStr = session.lastModified ? new Date(session.lastModified * 1000).toLocaleString() : 'N/A';
    
    card.innerHTML = `
      <div class="workspace-header">
        <div class="workspace-title-group">
          <span class="workspace-name">Closed Window</span>
          <span class="workspace-date">Closed: ${dateStr}</span>
        </div>
      </div>
      <div class="workspace-stats">
        <span><b>${win.tabs.length}</b> Tabs</span>
      </div>
      <div class="workspace-tabs-preview">
        ${faviconsHTML}
        ${win.tabs.length > 10 ? `<span style="font-size:11px; color:#64748b; align-self:center; margin-left:4px;">+${win.tabs.length - 10} more</span>` : ''}
      </div>
      <div class="workspace-actions">
        <button class="primary btn-restore-window" style="padding: 6px 12px; font-size: 12px;">Restore Window</button>
      </div>
    `;
    
    card.querySelector('.btn-restore-window').addEventListener('click', async () => {
      if (chrome.sessions && chrome.sessions.restore) {
        await chrome.sessions.restore(session.sessionId);
        await loadData();
        render();
      }
    });
    
    container.appendChild(card);
  });
}
