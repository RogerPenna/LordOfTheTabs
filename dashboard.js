import { getTabMeta, saveTabMeta } from './storage.js';

const channel = new BroadcastChannel('tab_sync');
let allTabs = [];
let sortConfig = { key: 'importance', direction: 'desc' };
let filters = { title: '', url: '', age: 0, importance: 0 };
let groupBy = 'window'; 
let selectedIds = new Set();
let currentView = 'table';
let drillPath = []; // Array of { type, value }

document.addEventListener('DOMContentLoaded', async () => {
  // Check if we should be here (New Tab Override logic)
  const settings = await chrome.storage.sync.get({ dashboard_as_newtab: false });
  // If this is a new tab (no history state or specific URL params) and setting is OFF
  // Redirect to default new tab.
  if (!settings.dashboard_as_newtab && !window.location.search.includes('source=extension')) {
    // Only redirect if we are actually the "newtab" override
    // We can check if history.length is 1 or similar, but the safest is to let user toggle.
    // However, if they opened it from the popup, we should stay.
    // We'll use a simple heuristic: if it's the only page in history and setting is off.
    if (window.history.length <= 1) {
      window.location.href = 'chrome://new-tab-page';
      return;
    }
  }

  await loadData();
  setupEventListeners();
  setupViewNavigation();
  render();
});

channel.onmessage = (msg) => {
  if (msg.data.action === 'update_meta') {
    const tab = allTabs.find(t => t.url === msg.data.url);
    if (tab) {
      tab.meta = msg.data.meta;
      render();
    }
  }
};

async function loadData() {
  const [tabs, windows] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll()
  ]);
  
  const windowMap = new Map();
  windows.forEach((win, idx) => windowMap.set(win.id, idx + 1));

  allTabs = [];
  for (const tab of tabs) {
    if (tab.url) {
      const meta = await getTabMeta(tab.url);
      let estMem = tab.discarded ? 15 : 80 + (tab.url.length % 200);
      if (tab.url.includes('youtube.com') || tab.url.includes('facebook.com')) estMem += 150;

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
        memory: estMem,
        discarded: tab.discarded
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
    const isChecked = e.target.checked;
    const processed = getProcessedData();
    if (isChecked) {
      processed.forEach(t => selectedIds.add(t.id));
    } else {
      processed.forEach(t => selectedIds.delete(t.id));
    }
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

  document.getElementById('btn-discard-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    await Promise.all(Array.from(selectedIds).map(id => chrome.tabs.discard(id)));
    selectedIds.clear();
    await loadData();
    render();
  });

  document.getElementById('btn-move-selected').addEventListener('click', async () => {
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
    await loadData();
    render();
  });

  document.getElementById('btn-delete-history-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    
    const selectedTabs = allTabs.filter(t => selectedIds.has(t.id));
    const domains = new Set(selectedTabs.map(t => t.domain));
    const domainList = Array.from(domains).join(', ');
    
    if (confirm(`Delete ALL browser history for these domains?\n${domainList}`)) {
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
  });

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

  document.getElementById('btn-export-csv').addEventListener('click', () => {
    const processed = getProcessedData();
    const rows = [['Title', 'URL', 'Window', 'Memory (MB)', 'Age (Mins)', 'Last Access', 'Importance']];
    processed.forEach(t => {
      rows.push([`"${t.title.replace(/"/g, '""')}"`, `"${t.url}"`, t.windowIndex, t.memory, t.ageMins, `"${new Date(t.meta.ultimo_acesso).toLocaleString()}"`, t.meta.importancia]);
    });
    const csvContent = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `lord_of_the_tabs_export_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
  });

  document.getElementById('btn-backup').addEventListener('click', async () => {
    const btn = document.getElementById('btn-backup');
    btn.innerText = 'Backing up...';
    btn.disabled = true;
    const visibleData = getProcessedData().map(t => ({ title: t.title, url: t.url, meta: t.meta }));
    chrome.runtime.sendMessage({ action: 'backupToSheets', data: visibleData }, (response) => {
      btn.disabled = false;
      btn.innerText = 'Backup';
      if (response && response.error) alert('Error: ' + response.error);
      else if (response) window.open(response, '_blank');
    });
  });
}

function setupViewNavigation() {
  const btnTable = document.getElementById('btn-view-table');
  const btnCharts = document.getElementById('btn-view-charts');
  const tableView = document.getElementById('table-view');
  const chartsView = document.getElementById('charts-view');
  const btnBack = document.getElementById('btn-charts-back');

  btnTable.addEventListener('click', () => {
    currentView = 'table';
    btnTable.classList.add('active');
    btnCharts.classList.remove('active');
    tableView.style.display = 'block';
    chartsView.style.display = 'none';
    render();
  });

  btnCharts.addEventListener('click', () => {
    currentView = 'charts';
    btnCharts.classList.add('active');
    btnTable.classList.remove('active');
    tableView.style.display = 'none';
    chartsView.style.display = 'block';
    render();
  });

  btnBack.addEventListener('click', () => {
    drillPath.pop();
    render();
  });
}

function drillDown(type, value) {
  if (drillPath.length === 0) {
    drillPath.push({ type, value });
    render();
  } else {
    if (type === 'url') {
      filters.url = value;
      const urlInput = document.querySelector('[data-col="url"]');
      if (urlInput) urlInput.value = value;
    }
    currentView = 'table';
    document.getElementById('btn-view-table').click();
  }
}

function selectTabsByCategory(allTabs, type, value) {
  let ids = [];
  if (type === 'domain') ids = allTabs.filter(t => t.domain === value).map(t => t.id);
  else if (type === 'window') ids = allTabs.filter(t => t.windowIndex == value).map(t => t.id);
  else if (type === 'url') ids = allTabs.filter(t => t.url === value).map(t => t.id);
  else if (type === 'domain-in-window') ids = allTabs.filter(t => t.windowIndex == value.win && t.domain === value.dom).map(t => t.id);

  const allAlreadySelected = ids.length > 0 && ids.every(id => selectedIds.has(id));
  if (allAlreadySelected) ids.forEach(id => selectedIds.delete(id));
  else ids.forEach(id => selectedIds.add(id));
  render();
}

// --- Charting Engine ---
function createSVGElement(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }
const COLORS = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#71717a'];

function renderPieChart(containerId, data, allTabs, groupType, unit = '') {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const sortedEntries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const total = sortedEntries.reduce((a, b) => a + b[1], 0);

  const card = container.parentElement;
  card.querySelectorAll('.chart-total').forEach(el => el.remove());
  const totalDiv = document.createElement('div');
  totalDiv.className = 'chart-total';
  totalDiv.innerText = `Total: ${total}${unit}`;
  card.insertBefore(totalDiv, container);

  const size = 200;
  const radius = size / 2;
  const svg = createSVGElement('svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  let currentAngle = -Math.PI / 2;

  sortedEntries.forEach(([label, value], idx) => {
    const color = COLORS[idx % COLORS.length];
    const sliceAngle = (value / total) * 2 * Math.PI;
    const pathId = `${containerId}-slice-${idx}`;
    if (total > 0 && sliceAngle > 0) {
      const x1 = radius + radius * Math.cos(currentAngle);
      const y1 = radius + radius * Math.sin(currentAngle);
      const x2 = radius + radius * Math.cos(currentAngle + sliceAngle);
      const y2 = radius + radius * Math.sin(currentAngle + sliceAngle);
      const largeArc = sliceAngle > Math.PI ? 1 : 0;
      const path = createSVGElement('path');
      const d = sliceAngle >= 2 * Math.PI - 0.01 ? `M ${radius} 0 A ${radius} ${radius} 0 1 1 ${radius - 0.01} 0 Z` : `M ${radius} ${radius} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      path.setAttribute('d', d); path.setAttribute('fill', color); path.setAttribute('stroke', 'white'); path.setAttribute('stroke-width', '1');
      path.id = pathId;
      path.innerHTML = `<title>${label}: ${value}${unit}</title>`;
      path.addEventListener('click', () => selectTabsByCategory(allTabs, groupType, label));
      path.addEventListener('dblclick', () => drillDown(groupType, label));
      svg.appendChild(path);
    }
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-color" style="background:${color}"></span><span class="legend-text" title="${label}">${label.length > 30 ? label.substring(0,30)+'...' : label} (${value}${unit})</span>`;
    item.addEventListener('mouseenter', () => document.getElementById(pathId)?.classList.add('slice-highlight'));
    item.addEventListener('mouseleave', () => document.getElementById(pathId)?.classList.remove('slice-highlight'));
    item.addEventListener('click', () => selectTabsByCategory(allTabs, groupType, label));
    item.addEventListener('dblclick', () => drillDown(groupType, label));
    legend.appendChild(item);
    currentAngle += sliceAngle;
  });
  container.appendChild(svg);
  container.appendChild(legend);
}

function renderMixedChart(containerId, allTabs) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const size = 320; const center = size / 2; const innerR = 60; const middleR = 100; const outerR = 140;
  const svg = createSVGElement('svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  const winDataMap = {};
  allTabs.forEach(t => {
    if (!winDataMap[t.windowIndex]) winDataMap[t.windowIndex] = { total: 0, domains: {} };
    winDataMap[t.windowIndex].total += t.memory;
    if (!winDataMap[t.windowIndex].domains[t.domain]) winDataMap[t.windowIndex].domains[t.domain] = 0;
    winDataMap[t.windowIndex].domains[t.domain] += t.memory;
  });

  const sortedWindows = Object.entries(winDataMap).sort((a, b) => b[1].total - a[1].total);
  const grandTotal = sortedWindows.reduce((a, b) => a + b[1].total, 0);

  const card = container.parentElement;
  card.querySelectorAll('.chart-total').forEach(el => el.remove());
  const totalDiv = document.createElement('div');
  totalDiv.className = 'chart-total';
  totalDiv.innerText = `Total Memory: ${grandTotal}MB`;
  card.insertBefore(totalDiv, container);

  let currentAngle = -Math.PI / 2;
  sortedWindows.forEach(([winIdxLabel, winInfo], winIdx) => {
    const winColor = COLORS[winIdx % COLORS.length];
    const winAngle = (winInfo.total / grandTotal) * 2 * Math.PI;
    if (winAngle > 0) {
      const winPath = createDonutSegment(center, center, innerR, middleR, currentAngle, winAngle, winColor, `Window ${winIdxLabel}: ${winInfo.total}MB`);
      winPath.addEventListener('click', () => selectTabsByCategory(allTabs, 'window', winIdxLabel));
      winPath.addEventListener('dblclick', () => drillDown('window', winIdxLabel));
      svg.appendChild(winPath);
      let domainAngleStart = currentAngle;
      const sortedDomains = Object.entries(winInfo.domains).sort((a, b) => b[1] - a[1]);
      sortedDomains.forEach(([domain, mem], domIdx) => {
        const domAngle = (mem / winInfo.total) * winAngle;
        const domColor = COLORS[(winIdx + domIdx + 1) % COLORS.length]; 
        if (domAngle > 0) {
          const domPath = createDonutSegment(center, center, middleR + 2, outerR, domainAngleStart, domAngle, domColor, `${domain}: ${mem}MB (Win ${winIdxLabel})`);
          domPath.addEventListener('click', () => selectTabsByCategory(allTabs, 'domain-in-window', { win: winIdxLabel, dom: domain }));
          domPath.addEventListener('dblclick', () => drillDown('domain', domain));
          svg.appendChild(domPath);
        }
        domainAngleStart += domAngle;
      });
    }
    currentAngle += winAngle;
  });
  container.appendChild(svg);
}

function createDonutSegment(cx, cy, rIn, rOut, startAngle, sliceAngle, color, tooltip) {
  const endAngle = startAngle + sliceAngle;
  const x1In = cx + rIn * Math.cos(startAngle); const y1In = cy + rIn * Math.sin(startAngle);
  const x2In = cx + rIn * Math.cos(endAngle);   const y2In = cy + rIn * Math.sin(endAngle);
  const x1Out = cx + rOut * Math.cos(startAngle); const y1Out = cy + rOut * Math.sin(startAngle);
  const x2Out = cx + rOut * Math.cos(endAngle);   const y2Out = cy + rOut * Math.sin(endAngle);
  const largeArc = sliceAngle > Math.PI ? 1 : 0;
  const path = createSVGElement('path');
  const d = sliceAngle >= 2 * Math.PI - 0.01 
    ? `M ${cx} ${cy - rOut} A ${rOut} ${rOut} 0 1 1 ${cx - 0.01} ${cy - rOut} M ${cx} ${cy - rIn} A ${rIn} ${rIn} 0 1 0 ${cx - 0.01} ${cy - rIn} Z`
    : `M ${x1In} ${y1In} L ${x1Out} ${y1Out} A ${rOut} ${rOut} 0 ${largeArc} 1 ${x2Out} ${y2Out} L ${x2In} ${y2In} A ${rIn} ${rIn} 0 ${largeArc} 0 ${x1In} ${y1In} Z`;
  path.setAttribute('d', d); path.setAttribute('fill', color); path.setAttribute('stroke', 'white'); path.setAttribute('stroke-width', '1');
  path.innerHTML = `<title>${tooltip}</title>`;
  return path;
}

function getProcessedData() {
  let filtered = allTabs.filter(tab => {
    const titleMatch = tab.title.toLowerCase().includes(filters.title);
    const urlMatch = tab.url.toLowerCase().includes(filters.url);
    const ageMatch = filters.age === 0 || tab.ageMins >= filters.age;
    const starMatch = filters.importance === 0 || tab.meta.importancia >= filters.importance;
    return titleMatch && urlMatch && ageMatch && starMatch;
  });

  filtered.sort((a, b) => {
    if (groupBy !== 'none') {
      let groupA, groupB;
      if (groupBy === 'window') { groupA = a.windowIndex; groupB = b.windowIndex; }
      else if (groupBy === 'domain') { groupA = a.domain; groupB = b.domain; }
      else if (groupBy === 'url') { groupA = a.url; groupB = b.url; }
      else if (groupBy === 'importance') { groupA = a.meta.importancia; groupB = b.meta.importancia; }
      if (groupA !== groupB) {
        if (groupA < groupB) return groupBy === 'importance' ? 1 : -1;
        if (groupA > groupB) return groupBy === 'importance' ? -1 : 1;
      }
    }
    let valA, valB;
    switch(sortConfig.key) {
      case 'title': valA = a.title; valB = b.title; break;
      case 'url': valA = a.url; valB = b.url; break;
      case 'windowIndex': valA = a.windowIndex; valB = b.windowIndex; break;
      case 'memory': valA = a.memory; valB = b.memory; break;
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
  const countEl = document.getElementById('tab-count');
  const processed = getProcessedData();
  countEl.innerText = `${processed.length} / ${allTabs.length} Tabs`;
  if (currentView === 'table') renderTable(processed); else renderCharts(processed);
}

function renderTable(processed) {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  document.getElementById('select-all').checked = processed.length > 0 && processed.every(t => selectedIds.has(t.id));
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('active-asc', 'active-desc');
    if (th.dataset.sort === sortConfig.key) th.classList.add(sortConfig.direction === 'asc' ? 'active-asc' : 'active-desc');
  });

  let currentGroupValue = null;
  processed.forEach(tab => {
    if (groupBy !== 'none') {
      let val;
      if (groupBy === 'window') val = `Window ${tab.windowIndex}`;
      else if (groupBy === 'domain') val = tab.domain;
      else if (groupBy === 'url') val = `URL: ${tab.url}`;
      else if (groupBy === 'importance') val = `${tab.meta.importancia} Stars`;
      if (val !== currentGroupValue) {
        currentGroupValue = val;
        const headerTr = document.createElement('tr');
        headerTr.className = 'window-group-header';
        headerTr.innerHTML = `<td colspan="10">${val}</td>`;
        tbody.appendChild(headerTr);
      }
    }
    const tr = document.createElement('tr');
    if (selectedIds.has(tab.id)) tr.classList.add('row-selected');
    tr.innerHTML = `
      <td><input type="checkbox" class="tab-select" ${selectedIds.has(tab.id) ? 'checked' : ''}></td>
      <td><button class="goto-btn" title="Go to Tab">↗️</button></td>
      <td><img src="${tab.favIconUrl || 'icons/icon16.png'}" width="16"></td>
      <td class="truncate" title="${tab.title}">${tab.title}</td>
      <td class="truncate" title="${tab.url}">${tab.url}</td>
      <td>${tab.windowIndex}</td>
      <td>${tab.memory}MB</td>
      <td>${tab.ageMins}m</td>
      <td style="font-size: 11px;">${new Date(tab.meta.ultimo_acesso).toLocaleString()}</td>
      <td><div class="star-rating" data-url="${tab.url}">${[1,2,3,4,5].map(i => `<span class="star ${i <= tab.meta.importancia ? 'active' : ''}" data-val="${i}">★</span>`).join('')}</div></td>
    `;
    tr.querySelector('.tab-select').addEventListener('change', (e) => { if (e.target.checked) selectedIds.add(tab.id); else selectedIds.delete(tab.id); render(); });
    tr.querySelector('.goto-btn').addEventListener('click', () => { chrome.tabs.update(tab.id, { active: true }); chrome.windows.update(tab.windowId, { focused: true }); });
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

function renderCharts(processed) {
  const nav = document.getElementById('charts-nav');
  const pathLabel = document.getElementById('charts-path');
  const memoryCard = document.getElementById('chart-card-memory');
  const mixedCard = document.getElementById('chart-card-mixed');
  const domainTitle = document.getElementById('chart-title-domains');
  const memoryTitle = document.getElementById('chart-title-memory');

  if (drillPath.length === 0) {
    nav.style.display = 'none';
    memoryCard.style.display = 'flex';
    mixedCard.style.display = 'flex';
    domainTitle.innerText = 'Tabs by Domain';
    memoryTitle.innerText = 'Memory per Window (MB)';
    const domainCounts = {}; processed.forEach(t => { domainCounts[t.domain] = (domainCounts[t.domain] || 0) + 1; });
    renderPieChart('chart-domains', domainCounts, processed, 'domain');
    const windowMem = {}; processed.forEach(t => { windowMem[t.windowIndex] = (windowMem[t.windowIndex] || 0) + t.memory; });
    renderPieChart('chart-memory-window', windowMem, processed, 'window', 'MB');
    renderMixedChart('chart-mixed', processed);
  } else {
    nav.style.display = 'flex';
    mixedCard.style.display = 'none';
    const drill = drillPath[0];
    pathLabel.innerText = `${drill.type === 'domain' ? 'Domain' : 'Window'}: ${drill.value}`;
    let filtered = processed;
    if (drill.type === 'domain') {
      filtered = processed.filter(t => t.domain === drill.value);
      domainTitle.innerText = 'Tabs in Domain (grouped by URL)';
      memoryTitle.innerText = 'Memory in Domain (grouped by URL)';
      const urlCounts = {}; const urlMem = {};
      filtered.forEach(t => { urlCounts[t.url] = (urlCounts[t.url] || 0) + 1; urlMem[t.url] = (urlMem[t.url] || 0) + t.memory; });
      renderPieChart('chart-domains', urlCounts, filtered, 'url');
      renderPieChart('chart-memory-window', urlMem, filtered, 'url', 'MB');
    } else {
      filtered = processed.filter(t => t.windowIndex == drill.value);
      domainTitle.innerText = 'Tabs in Window (by Domain)';
      memoryTitle.innerText = 'Tabs in Window (by Memory)';
      const domCounts = {}; const tabMem = {};
      filtered.forEach(t => { domCounts[t.domain] = (domCounts[t.domain] || 0) + 1; tabMem[t.title || t.url] = t.memory; });
      renderPieChart('chart-domains', domCounts, filtered, 'domain');
      renderPieChart('chart-memory-window', tabMem, filtered, 'url');
    }
  }
}
