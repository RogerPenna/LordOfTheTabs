import { getTabMeta, saveTabMeta } from './storage.js';

const channel = new BroadcastChannel('tab_sync');
let allTabs = [];
let sortConfig = { key: 'importance', direction: 'desc' };
let filters = { title: '', url: '', age: 0, importance: 0 };

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  setupEventListeners();
  render();
});

channel.onmessage = (msg) => {
  if (msg.data.action === 'update_meta') {
    // Update local data and re-render
    const tab = allTabs.find(t => t.url === msg.data.url);
    if (tab) {
      tab.meta = msg.data.meta;
      render();
    }
  }
};

async function loadData() {
  const tabs = await chrome.tabs.query({});
  allTabs = [];
  for (const tab of tabs) {
    if (tab.url) {
      const meta = await getTabMeta(tab.url);
      allTabs.push({
        id: tab.id,
        title: tab.title || '',
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        meta: meta,
        ageMins: Math.floor((Date.now() - meta.data_abertura) / 60000)
      });
    }
  }
}

function setupEventListeners() {
  // Sort Handlers
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortConfig.key === key) {
        sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
      } else {
        sortConfig.key = key;
        sortConfig.direction = 'desc';
      }
      render();
    });
  });

  // Filter Handlers
  document.querySelectorAll('.col-filter').forEach(input => {
    input.addEventListener('input', (e) => {
      const col = e.target.dataset.col;
      const val = e.target.value.toLowerCase();
      filters[col] = col === 'age' || col === 'importance' ? parseInt(val) || 0 : val;
      render();
    });
  });

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    await loadData();
    render();
  });

  document.getElementById('btn-backup').addEventListener('click', async () => {
    const btn = document.getElementById('btn-backup');
    btn.innerText = 'Backing up...';
    btn.disabled = true;
    
    const visibleData = getProcessedData().map(t => ({ title: t.title, url: t.url, meta: t.meta }));
    
    chrome.runtime.sendMessage({ action: 'backupToSheets', data: visibleData }, (response) => {
      btn.disabled = false;
      btn.innerText = 'Backup to Google Sheets';
      if (response && response.error) {
        alert('Error: ' + response.error);
      } else if (response) {
        window.open(response, '_blank');
      }
    });
  });
}

function getProcessedData() {
  // 1. Filter
  let filtered = allTabs.filter(tab => {
    const titleMatch = tab.title.toLowerCase().includes(filters.title);
    const urlMatch = tab.url.toLowerCase().includes(filters.url);
    const ageMatch = filters.age === 0 || tab.ageMins >= filters.age;
    const starMatch = filters.importance === 0 || tab.meta.importancia >= filters.importance;
    return titleMatch && urlMatch && ageMatch && starMatch;
  });

  // 2. Sort
  filtered.sort((a, b) => {
    let valA, valB;
    
    switch(sortConfig.key) {
      case 'title': valA = a.title; valB = b.title; break;
      case 'url': valA = a.url; valB = b.url; break;
      case 'age': valA = a.ageMins; valB = b.ageMins; break;
      case 'lastAccess': valA = a.meta.ultimo_acesso; valB = b.meta.ultimo_acesso; break;
      case 'importance': valA = a.meta.importancia; valB = b.meta.importancia; break;
      default: return 0;
    }

    if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
    if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  return filtered;
}

function render() {
  const tbody = document.getElementById('table-body');
  const countEl = document.getElementById('tab-count');
  tbody.innerHTML = '';
  
  const processed = getProcessedData();
  countEl.innerText = `${processed.length} / ${allTabs.length} Tabs`;

  // Update Sort Indicators
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('active-asc', 'active-desc');
    if (th.dataset.sort === sortConfig.key) {
      th.classList.add(sortConfig.direction === 'asc' ? 'active-asc' : 'active-desc');
    }
  });

  processed.forEach(tab => {
    const tr = document.createElement('tr');
    const lastAccess = new Date(tab.meta.ultimo_acesso).toLocaleString();
    
    tr.innerHTML = `
      <td><img src="${tab.favIconUrl || 'icons/icon16.png'}" width="16"></td>
      <td class="truncate" title="${tab.title}">${tab.title}</td>
      <td class="truncate" title="${tab.url}">${tab.url}</td>
      <td>${tab.ageMins}m</td>
      <td style="font-size: 11px;">${lastAccess}</td>
      <td>
        <div class="star-rating" data-url="${tab.url}">
          ${[1,2,3,4,5].map(i => `<span class="star ${i <= tab.meta.importancia ? 'active' : ''}" data-val="${i}">★</span>`).join('')}
        </div>
      </td>
    `;
    
    tr.querySelectorAll('.star').forEach(star => {
      star.addEventListener('click', async (e) => {
        const val = parseInt(e.target.dataset.val);
        const meta = tab.meta;
        meta.importancia = meta.importancia === val ? 0 : val;
        await saveTabMeta(meta);
        channel.postMessage({ action: 'update_meta', url: tab.url, meta });
        render();
      });
    });
    
    tbody.appendChild(tr);
  });
}