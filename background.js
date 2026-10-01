import { getTabMeta, saveTabMeta, archiveTab, cleanupOldMeta, saveSensitiveHistory } from './storage.js';
import { checkPremium } from './licensing.js';

const DEFAULT_ADULT_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'youporn.com', 
  'redtube.com', 'onlyfans.com', 'chaturbate.com', 'bongacams.com', 
  'livejasmin.com', 'stripchat.com', 'cam4.com', 'xhamster live'
];

// Open side panel on extension icon click
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  ?.catch((error) => console.error("SidePanel setup error:", error));

// Auto-Purge Sensitive History from Chrome to Protected Vault (Pro)
chrome.history.onVisited.addListener(async (item) => {
  try {
    const isPro = await checkPremium();
    if (!isPro) return;

    const [settingsData, data] = await Promise.all([
      chrome.storage.local.get('popupSettings'),
      chrome.storage.local.get(['panicDomains', 'panicSafeDomains'])
    ]);
    const settings = settingsData.popupSettings || {};
    if (settings.autoPurgeSensitiveHistory === false) return;

    const blacklist = data.panicDomains || DEFAULT_ADULT_DOMAINS;
    const whitelist = data.panicSafeDomains || [];
    const panicType = settings.panicType || 'blacklist';

    const urlStr = item.url;
    if (!urlStr || urlStr.startsWith('chrome') || urlStr.startsWith('about') || urlStr.startsWith('edge')) return;

    let domain = '';
    try {
      domain = new URL(urlStr).hostname.replace(/^www\./, '').toLowerCase().trim();
    } catch(e) { return; }

    let isSensitive = false;
    if (panicType === 'blacklist') {
      isSensitive = blacklist.some(d => domain.includes(d.toLowerCase().trim()));
    } else {
      isSensitive = !whitelist.some(d => domain.includes(d.toLowerCase().trim()));
    }

    if (isSensitive) {
      // 1. Delete from Chrome history immediately (clears omnibox autocomplete & chrome://history)
      await chrome.history.deleteUrl({ url: urlStr });

      // 2. Save in protected internal storage
      await saveSensitiveHistory({
        url: urlStr,
        title: item.title || domain,
        visitTime: item.lastVisitTime || Date.now(),
        domain: domain
      });

      // 3. Notify dashboard
      const channel = new BroadcastChannel('tab_sync');
      channel.postMessage({ action: 'sensitive_history_updated' });
      channel.close();
    }
  } catch (err) {
    console.error('Auto-purge history error:', err);
  }
});

// --- Panic Logic (Shared) ---
async function executePanicClose() {
  const [allTabs, activeWindow, data] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getLastFocused({ populate: false }),
    chrome.storage.local.get(['panicDomains', 'panicSafeDomains', 'popupSettings'])
  ]);

  const settings = data.popupSettings || {};
  const panicType = settings.panicType || 'blacklist';     // 'blacklist' or 'whitelist'
  const panicMethod = settings.panicMethod || 'tabSwap';    // 'tabSwap' or 'windowSwap'
  const landingPage = settings.panicLandingPage || 'dashboard.html';

  const blacklist = data.panicDomains || DEFAULT_ADULT_DOMAINS;
  const whitelist = data.panicSafeDomains || [];

  const isSystemUrl = (urlStr) => {
    if (!urlStr) return true;
    return urlStr.startsWith('chrome://') || 
           urlStr.startsWith('chrome-extension://') || 
           urlStr.startsWith('about:') || 
           urlStr.startsWith('edge://');
  };

  const getDomain = (urlStr) => {
    try {
      return new URL(urlStr).hostname.replace('www.', '').toLowerCase().trim();
    } catch(e) { return ''; }
  };

  const tabsToClose = [];
  const tabsToKeep = [];

  allTabs.forEach(tab => {
    if (isSystemUrl(tab.url)) {
      tabsToKeep.push(tab);
      return;
    }

    const domain = getDomain(tab.url);
    if (panicType === 'blacklist') {
      const isUnsafe = blacklist.some(d => domain.includes(d.toLowerCase().trim()));
      if (isUnsafe) {
        tabsToClose.push(tab);
      } else {
        tabsToKeep.push(tab);
      }
    } else {
      const isSafe = whitelist.some(d => domain.includes(d.toLowerCase().trim()));
      if (isSafe) {
        tabsToKeep.push(tab);
      } else {
        tabsToClose.push(tab);
      }
    }
  });

  if (tabsToClose.length === 0) {
    console.log("Panic aborted: No target tabs to close.");
    return;
  }

  const activeWinId = activeWindow ? activeWindow.id : null;

  const now = Date.now();
  const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const windowMap = new Map();
  normalWindows.forEach((win, idx) => windowMap.set(win.id, idx + 1));

  await Promise.all(tabsToClose.map(async (t) => {
    try {
      const meta = await getTabMeta(t.url);
      await archiveTab({
        url: t.url,
        title: meta.customTitle || t.title || '',
        favIconUrl: t.favIconUrl || '',
        archivedAt: now,
        windowIndex: windowMap.get(t.windowId) || '?',
        tabIndex: t.index
      });
    } catch (e) {
      console.error("Error archiving panic tab:", e);
    }
  }));

  const channel = new BroadcastChannel('tab_sync');
  channel.postMessage({ action: 'update_meta' });
  channel.close();

  if (panicMethod === 'tabSwap') {
    if (activeWinId) {
      await chrome.tabs.create({
        windowId: activeWinId,
        url: landingPage,
        active: true
      });
    } else {
      await chrome.tabs.create({
        url: landingPage,
        active: true
      });
    }

    await chrome.tabs.remove(tabsToClose.map(t => t.id));
  } else {
    const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const win1 = normalWindows.sort((a, b) => a.id - b.id)[0] || activeWindow;

    const newWin = await chrome.windows.create({ 
      url: landingPage,
      focused: true, 
      state: 'maximized' 
    });

    const win1Tabs = allTabs.filter(t => t.windowId === win1.id);
    const win1SafeTabs = win1Tabs.filter(t => tabsToKeep.find(kt => kt.id === t.id));

    if (win1SafeTabs.length > 0) {
      await chrome.tabs.move(win1SafeTabs.map(t => t.id), { windowId: newWin.id, index: -1 });
    }

    await chrome.tabs.move(tabsToClose.map(t => t.id), { windowId: win1.id, index: -1 });
    await chrome.windows.update(win1.id, { state: 'minimized' });
    await chrome.tabs.remove(tabsToClose.map(t => t.id));
  }
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
        const isPro = await checkPremium();
        if (!isPro) {
          return { status: "error", error: "Pro license required for Sheets backup." };
        }
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
    const windows = await chrome.windows.getAll();
    const windowMap = new Map();
    windows.forEach((win, idx) => windowMap.set(win.id, idx + 1));

    const [settingsData, data] = await Promise.all([
      chrome.storage.local.get('popupSettings'),
      chrome.storage.local.get(['panicDomains', 'panicSafeDomains'])
    ]);

    const settings = settingsData.popupSettings || {};
    const blacklist = data.panicDomains || DEFAULT_ADULT_DOMAINS;
    const whitelist = data.panicSafeDomains || [];
    const panicType = settings.panicType || 'blacklist';

    const archiveDays = settings.autoArchiveDays || 3;
    const archiveThresholdMs = archiveDays * 24 * 60 * 60 * 1000;

    const panicAutoCloseHours = settings.panicAutoCloseHours || 24;
    const panicThresholdMs = panicAutoCloseHours * 60 * 60 * 1000;
    const now = Date.now();

    const getDomain = (urlStr) => {
      try {
        return new URL(urlStr).hostname.replace('www.', '').toLowerCase().trim();
      } catch(e) { return ''; }
    };

    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
      
      const meta = await getTabMeta(tab.url);
      const domain = getDomain(tab.url);
      
      let isPanicTab = false;
      if (panicType === 'blacklist') {
        isPanicTab = blacklist.some(d => domain.includes(d.toLowerCase().trim()));
      } else {
        const isSafe = whitelist.some(d => domain.includes(d.toLowerCase().trim()));
        isPanicTab = !isSafe;
      }

      const threshold = isPanicTab ? panicThresholdMs : archiveThresholdMs;
      const shouldArchive = isPanicTab 
        ? (now - meta.ultimo_acesso > threshold)
        : (now - meta.ultimo_acesso > threshold && meta.importancia < 4);

      if (shouldArchive) {
        await archiveTab({
          url: tab.url,
          title: meta.customTitle || tab.title,
          favIconUrl: tab.favIconUrl,
          archivedAt: now,
          windowIndex: windowMap.get(tab.windowId) || '?',
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
