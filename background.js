import { getTabMeta, saveTabMeta, archiveTab, cleanupOldMeta } from './storage.js';

const DEFAULT_ADULT_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'youporn.com', 
  'redtube.com', 'onlyfans.com', 'chaturbate.com', 'bongacams.com', 
  'livejasmin.com', 'stripchat.com', 'cam4.com', 'xhamster live'
];

// --- Panic Logic (Shared) ---
async function executePanicClose() {
  const [allTabs, windows, data] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.storage.local.get('panicDomains')
  ]);

  const adultDomains = data.panicDomains || DEFAULT_ADULT_DOMAINS;

  const adultTabs = allTabs.filter(tab => {
    try {
      const host = new URL(tab.url).hostname.replace('www.', '').toLowerCase();
      return adultDomains.some(domain => host.includes(domain.toLowerCase().trim()));
    } catch(e) { return false; }
  });

  // CRITICAL FIX: If no adult tabs, do NOTHING. Don't swap windows.
  if (adultTabs.length === 0) {
    console.log("Panic aborted: No targets found.");
    return;
  }

  const win1 = windows.sort((a, b) => a.id - b.id)[0];
  const win1Tabs = allTabs.filter(t => t.windowId === win1.id);
  const win1SafeTabs = win1Tabs.filter(t => !adultTabs.find(at => at.id === t.id));

  // Visual Swap
  const newWin = await chrome.windows.create({ focused: true, state: 'maximized' });
  
  if (win1SafeTabs.length > 0) {
    await chrome.tabs.move(win1SafeTabs.map(t => t.id), { windowId: newWin.id, index: -1 });
    const defaultTab = (await chrome.tabs.query({ windowId: newWin.id }))[0];
    if (defaultTab) chrome.tabs.remove(defaultTab.id);
  }

  await chrome.tabs.move(adultTabs.map(t => t.id), { windowId: win1.id, index: -1 });
  await chrome.windows.update(win1.id, { state: 'minimized' });
  await chrome.tabs.remove(adultTabs.map(t => t.id));
}

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
  if (changeInfo.url || changeInfo.title) {
    const channel = new BroadcastChannel('tab_sync');
    channel.postMessage({ action: 'update_meta', url: tab.url });
    channel.close();
  }

  if (tab.url && changeInfo.status === 'complete') {
    const meta = await getTabMeta(tab.url);
    if (!meta.data_abertura) meta.data_abertura = Date.now();
    meta.ultimo_acesso = Date.now();
    await saveTabMeta(meta);
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.url.includes("gemini.google.com")) {
    chrome.tabs.sendMessage(details.tabId, { action: "SPA_NAVIGATION", url: details.url }).catch(() => {});
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

// --- Messaging & Handlers ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handleMessage = async () => {
    try {
      if (request.action === 'updateActionPopup') {
        chrome.action.setPopup({ popup: request.enabled ? "" : "popup.html" });
        return { status: "success" };
      }
      
      if (request.action === 'updateTabMetadata' || request.action === 'UPDATE_GEMINI_TITLE') {
        const bad = ["gemini", "conversas", "google gemini", "novo chat", "chat"];
        const isBad = bad.some(b => request.title.toLowerCase().includes(b) && !request.title.toLowerCase().includes(":"));
        
        if (isBad && request.action === 'UPDATE_GEMINI_TITLE') return { status: "ignored" };

        const meta = await getTabMeta(request.url);
        if (meta.customTitle !== request.title) {
          meta.customTitle = request.title;
          meta.ultimo_acesso = Date.now();
          await saveTabMeta(meta);
          
          const channel = new BroadcastChannel('tab_sync');
          channel.postMessage({ action: 'update_meta', url: request.url, meta: meta });
          channel.close();
        }
        return { status: "success" };
      }

      if (request.action === 'backupToSheets') {
        const url = await pushToSheets(request.data);
        return { status: "success", url };
      }

      if (request.action === 'triggerPanic') {
        await executePanicClose();
        return { status: "success" };
      }

      return { status: "unhandled" };
    } catch (e) {
      console.error("Handler error:", e);
      return { status: "error", message: e.message };
    }
  };

  handleMessage().then(sendResponse);
  return true; // Keep channel open
});

// --- Commands ---
chrome.commands.onCommand.addListener((command) => {
  if (command === "panic-close") {
    executePanicClose();
  } else if (command === "add-to-unsafe") {
    addCurrentDomainToUnsafe();
  }
});

async function addCurrentDomainToUnsafe() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

    const url = new URL(tab.url);
    const domain = url.hostname.replace('www.', '').toLowerCase();

    const data = await chrome.storage.local.get('panicDomains');
    let domains = data.panicDomains || [...DEFAULT_ADULT_DOMAINS];

    if (!domains.some(d => d.toLowerCase().trim() === domain)) {
      domains.push(domain);
      await chrome.storage.local.set({ panicDomains: domains });

      // Notify user via native system notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'logo_transparent.png',
        title: 'Domain Blacklisted',
        message: `"${domain}" has been added to your unsafe domains list.`
      });

      // Broadcast sync message to update UI (like the settings textarea)
      const channel = new BroadcastChannel('tab_sync');
      channel.postMessage({ action: 'update_meta' }); // triggers reload in popup/dashboard
      channel.close();
    }

    // Close the blacklisted tab
    await chrome.tabs.remove(tab.id);
  } catch (e) {
    console.error("Error blacklisting domain:", e);
  }
}

// --- Maintenance Alarms ---

async function autoArchiveTabs() {
  try {
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
  } catch (e) { console.error("Auto-archive error:", e); }
}

chrome.alarms.create('check_auto_archive', { periodInMinutes: 60 });
chrome.alarms.create('daily_cleanup', { periodInMinutes: 1440 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check_auto_archive') autoArchiveTabs();
  if (alarm.name === 'daily_cleanup') cleanupOldMeta();
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

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'dashboard.html' });
});
