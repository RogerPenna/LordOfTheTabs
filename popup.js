import { getTabMeta, saveTabMeta } from './storage.js';

let allWindows = [];
let currentView = 'grid'; 
let selectedIds = new Set();
let tabMetas = {};

const channel = new BroadcastChannel('tab_sync');

document.addEventListener('DOMContentLoaded', async () => {
  await refreshState();
  render();
  setupEventListeners();
});

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
    
    win.tabs.forEach(tab => {
      const meta = tabMetas[tab.url] || {};
      const title = (meta.customTitle || tab.title || "").toLowerCase();
      if (query && !title.includes(query) && !tab.url.toLowerCase().includes(query)) return;

      const el = document.createElement('div');
      el.className = `tab-element ${currentView === 'list' ? 'list-item' : 'grid-tile'}`;
      if (selectedIds.has(tab.id)) el.classList.add('selected');
      
      const faviconUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`;
      const displayTitle = meta.customTitle || tab.title;

      el.innerHTML = currentView === 'list' ? `
        <img class="favicon" src="${faviconUrl}">
        <span class="tab-title">${displayTitle}</span>
      ` : `
        <img class="tile-favicon" src="${faviconUrl}">
      `;

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
    
    pane.appendChild(container);
    canvas.appendChild(pane);
  });
}

function setupEventListeners() {
  document.getElementById('search').addEventListener('input', render);
  document.getElementById('view-toggle').addEventListener('click', () => {
    currentView = currentView === 'list' ? 'grid' : 'list';
    render();
  });
  document.getElementById('btn-expand').addEventListener('click', () => {
    chrome.tabs.create({ url: 'dashboard.html' });
  });
}
