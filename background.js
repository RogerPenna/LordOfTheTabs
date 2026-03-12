import { getTabMeta, saveTabMeta, getAllTabMeta } from './storage.js';

// Track tab access
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
  if (changeInfo.status === 'complete' && tab.url) {
    const meta = await getTabMeta(tab.url);
    if (!meta.data_abertura) meta.data_abertura = Date.now();
    meta.ultimo_acesso = Date.now();
    await saveTabMeta(meta);
  }
});

// Broadcast channel for background if needed, but background can listen to messages for Sheet backup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'backupToSheets') {
    pushToSheets(request.data).then(sendResponse).catch(err => sendResponse({error: err.message}));
    return true; // Keep channel open for async response
  }
});

async function pushToSheets(data) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async function(token) {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      
      try {
        // Create spreadsheet
        const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: { title: `Lord of the Tabs Backup - ${new Date().toLocaleDateString()}` }
          })
        });
        const sheetData = await createRes.json();
        const spreadsheetId = sheetData.spreadsheetId;

        if (!spreadsheetId) {
          throw new Error('Failed to create spreadsheet');
        }

        // Prepare data
        const values = [
          ['Title', 'URL', 'Date Opened', 'Last Access', 'Importance']
        ];
        
        data.forEach(item => {
          values.push([
            item.title,
            item.url,
            new Date(item.meta.data_abertura).toLocaleString(),
            new Date(item.meta.ultimo_acesso).toLocaleString(),
            item.meta.importancia
          ]);
        });

        // Update sheet
        const updateRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:E${values.length}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values })
        });
        
        resolve(sheetData.spreadsheetUrl);
      } catch (e) {
        reject(e);
      }
    });
  });
}
