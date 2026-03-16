import { 
  getTabMeta, saveTabMeta, getArchivedTabs, 
  deleteArchivedTab, saveWorkspace, getAllWorkspaces, 
  deleteWorkspace 
} from './storage.js';

const channel = new BroadcastChannel('tab_sync');
let allTabs = [];
let archivedTabs = [];
let savedWorkspaces = [];
let sortConfig = { key: 'importance', direction: 'desc' };
let filters = { title: '', url: '', age: 0, importance: 0 };
let groupBy = 'window'; 
let selectedIds = new Set();
let currentView = 'table';

document.addEventListener('DOMContentLoaded', async () => {
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
  const [tabs, windows, archived, workspaces] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll(),
    getArchivedTabs(),
    getAllWorkspaces()
  ]);
  
  archivedTabs = archived;
  savedWorkspaces = workspaces;
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
    render();
  });

  document.getElementById('select-all').addEventListener('change', (e) => {
    const processed = getProcessedData();
    if (e.target.checked) processed.forEach(t => selectedIds.add(t.id));
    else processed.forEach(t => selectedIds.delete(t.id));
    render();
  });

  document.getElementById('btn-close-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    if (confirm(`Close ${selectedIds.size} tabs?`)) {
      await chrome.tabs.remove(Array.from(selectedIds));
      selectedIds.clear();
      await loadData();
      render();
    }
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

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
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
  });

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    await loadData();
    render();
  });
}

function setupViewNavigation() {
  const switchView = (name) => {
    currentView = name;
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

function getProcessedData() {
  let filtered = allTabs.filter(tab => {
    const titleMatch = (tab.meta.customTitle || tab.title).toLowerCase().includes(filters.title);
    const urlMatch = tab.url.toLowerCase().includes(filters.url);
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
  
  if (currentView === 'table') renderTable(processed); 
  else if (currentView === 'vault') renderVault();
  else if (currentView === 'workspaces') renderWorkspaces();
}

function renderTable(processed) {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  
  processed.forEach(tab => {
    const tr = document.createElement('tr');
    if (selectedIds.has(tab.id)) tr.classList.add('row-selected');
    
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
  });
}

function renderVault() {
  const tbody = document.getElementById('vault-table-body');
  if (!tbody) return;
  tbody.innerHTML = archivedTabs.length ? '' : '<tr><td colspan="5" style="text-align:center;">Vault is empty</td></tr>';
  
  archivedTabs.forEach(tab => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><img src="logo_transparent.png" width="16"></td>
      <td>${tab.title}</td>
      <td class="truncate">${tab.url}</td>
      <td>${new Date(tab.archivedAt).toLocaleString()}</td>
      <td><button class="btn-restore primary">Restore</button></td>
    `;
    tr.querySelector('.btn-restore').addEventListener('click', async () => {
      await chrome.tabs.create({ url: tab.url });
      await deleteArchivedTab(tab.url);
      await loadData();
      render();
    });
    tbody.appendChild(tr);
  });
}

function renderWorkspaces() {
  const container = document.getElementById('workspaces-list');
  if (!container) return;
  container.innerHTML = savedWorkspaces.length ? '' : '<div style="padding:20px;">No workspaces</div>';
  
  savedWorkspaces.forEach(ws => {
    const card = document.createElement('div');
    card.className = 'workspace-card';
    card.innerHTML = `
      <div class="workspace-header"><b>${ws.name}</b> <button class="danger btn-delete-ws">Delete</button></div>
      <div class="workspace-stats">${ws.tabCount} Tabs</div>
      <button class="primary btn-restore-ws">Restore All</button>
    `;
    card.querySelector('.btn-restore-ws').addEventListener('click', async () => {
      for (const t of ws.tabs) await chrome.tabs.create({ url: t.url, active: false });
    });
    card.querySelector('.btn-delete-ws').addEventListener('click', async () => {
      if (confirm('Delete?')) { await deleteWorkspace(ws.id); await loadData(); render(); }
    });
    container.appendChild(card);
  });
}
