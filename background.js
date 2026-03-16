import { getTabMeta, saveTabMeta, archiveTab } from './storage.js';

// --- Tab Tracking & Metadata ---

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      const meta = await getTabMeta(tab.url);
      meta.ultimo_acesso = Date.now();
      await saveTabMeta(meta);
    }
  } catch(e) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Notifica a Dashboard sempre que a URL mudar (essencial para SPAs como Gemini)
  if (changeInfo.url || changeInfo.title) {
    const channel = new BroadcastChannel('tab_sync');
    channel.postMessage({ action: 'update_meta', url: tab.url });
  }

  if (tab.url && changeInfo.status === 'complete') {
    const meta = await getTabMeta(tab.url);
    if (!meta.data_abertura) meta.data_abertura = Date.now();
    meta.ultimo_acesso = Date.now();
    await saveTabMeta(meta);
  }
});

// --- Tab Lineage ---

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId) {
    try {
      const parentTab = await chrome.tabs.get(tab.openerTabId);
      if (parentTab && parentTab.url) {
        const meta = await getTabMeta(tab.pendingUrl || tab.url || '');
        meta.parentUrl = parentTab.url;
        meta.parentTitle = parentTab.title || 'Unknown Parent';
        await saveTabMeta(meta);
      }
    } catch (e) {}
  }
});

// --- Messaging & Debugging ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateActionPopup') {
    chrome.action.setPopup({ popup: request.enabled ? "" : "popup.html" });
    return;
  }
  
  if (request.action === 'updateTabMetadata' || request.action === 'UPDATE_GEMINI_TITLE') {
    const bad = ["gemini", "conversas", "google gemini", "novo chat", "chat"];
    const isBad = bad.some(b => request.title.toLowerCase().includes(b) && !request.title.toLowerCase().includes(":"));
    
    if (isBad && request.action === 'UPDATE_GEMINI_TITLE') return;

    getTabMeta(request.url).then(async (meta) => {
      // Só salva e notifica se o título realmente mudou no DB
      if (meta.customTitle !== request.title) {
        meta.customTitle = request.title;
        meta.ultimo_acesso = Date.now();
        await saveTabMeta(meta);
        
        const channel = new BroadcastChannel('tab_sync');
        channel.postMessage({ action: 'update_meta', url: request.url, meta: meta });
      }
      sendResponse({ status: "success" });
    });
    return true; 
  }

  if (request.action === 'backupToSheets') {
    pushToSheets(request.data).then(sendResponse).catch(err => {
      console.error("Backup failed:", err);
      sendResponse({error: err.message});
    });
    return true; 
  }
});

// --- Auto-Archive Logic ---

async function autoArchiveTabs() {
  const tabs = await chrome.tabs.query({ pinned: false });
  const fortyEightHours = 48 * 60 * 60 * 1000;
  const now = Date.now();

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://')) continue;
    const meta = await getTabMeta(tab.url);
    if (now - meta.ultimo_acesso > fortyEightHours && meta.importancia < 4) {
      await archiveTab({
        url: tab.url,
        title: meta.customTitle || tab.title,
        favIconUrl: tab.favIconUrl,
        archivedAt: now,
        originalMeta: meta
      });
      await chrome.tabs.remove(tab.id);
    }
  }
}

chrome.alarms.create('check_auto_archive', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check_auto_archive') autoArchiveTabs();
});

// --- Google Sheets Integration ---

async function pushToSheets(data) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async function(token) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!token) return reject(new Error("No OAuth2 token."));
      
      try {
        const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: { title: `Lord of the Tabs Backup - ${new Date().toLocaleDateString()}` } })
        });
        const sheetData = await createRes.json();
        const spreadsheetId = sheetData.spreadsheetId;
        if (!spreadsheetId) throw new Error('Failed to create spreadsheet');

        const values = [['Title', 'URL', 'Date Opened', 'Last Access', 'Importance']];
        data.forEach(item => {
          values.push([item.title, item.url, new Date(item.meta.data_abertura).toLocaleString(), new Date(item.meta.ultimo_acesso).toLocaleString(), item.meta.importancia]);
        });

        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:E${values.length}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values })
        });
        
        resolve(sheetData.spreadsheetUrl);
      } catch (e) { reject(e); }
    });
  });
}

// Extension Icon Behavior
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'dashboard.html' });
});
