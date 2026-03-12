import { getTabMeta, saveTabMeta, getAllTabMeta } from './storage.js';

// Track tab access and refresh title enhancement on activation
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      const meta = await getTabMeta(tab.url);
      meta.ultimo_acesso = Date.now();
      await saveTabMeta(meta);
      
      // Re-trigger title check on activation
      tryEnhanceTitle(tab.id, tab.url, tab.title);
    }
  } catch(e) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Trigger on ANY change if it's Gemini (to catch SPA navigation) or on completion for others
  if (tab.url && (changeInfo.status === 'complete' || tab.url.includes('gemini.google.com'))) {
    const meta = await getTabMeta(tab.url);
    if (!meta.data_abertura) meta.data_abertura = Date.now();
    meta.ultimo_acesso = Date.now();
    await saveTabMeta(meta);

    tryEnhanceTitle(tabId, tab.url, tab.title);
  }
});

async function tryEnhanceTitle(tabId, url, currentTitle) {
  // Don't run on internal chrome pages
  if (url.startsWith('chrome://') || url.startsWith('edge://')) return;

  chrome.scripting.executeScript({
    target: { tabId },
    func: (targetUrl) => {
      const isGemini = targetUrl.includes('gemini.google.com');
      
      const updateTitle = () => {
        let newTitle = null;

        if (isGemini) {
          // 1. Try active conversation in sidebar (strongest)
          const activeLink = document.querySelector('nav a[aria-current="page"], .history-item.active, a[href*="/app/"][aria-current="page"]');
          if (activeLink) {
            // Usually there's a div or span inside with the text
            const textEl = activeLink.querySelector('div, span') || activeLink;
            if (textEl.innerText && textEl.innerText.length > 2) newTitle = textEl.innerText;
          }

          // 2. Try the chat header/h1
          if (!newTitle) {
            const h1 = document.querySelector('h1');
            if (h1 && h1.innerText && !h1.innerText.includes('Gemini')) newTitle = h1.innerText;
          }
          
          if (newTitle && !document.title.includes(newTitle)) {
            document.title = `Gemini: ${newTitle.trim()}`;
          }
        } else {
          // Generic logic for other sites
          const genericTitles = ['Untitled', 'New Tab', 'Home', 'Index', 'Welcome', 'Loading...'];
          const isGeneric = genericTitles.includes(document.title) || document.title.length < 4;
          
          if (isGeneric) {
            const h1 = document.querySelector('h1');
            if (h1 && h1.innerText && h1.innerText.length > 3) {
              document.title = h1.innerText.trim();
            }
          }
        }
      };

      // Run once immediately
      updateTitle();

      // If Gemini, use observer because it's an SPA and content loads late
      if (isGemini && !window._titleObserver) {
        window._titleObserver = new MutationObserver(() => updateTitle());
        window._titleObserver.observe(document.body, { childList: true, subtree: true });
        
        // Also clean up old ones if this script re-runs? 
        // Actually executeScript doesn't persist window variables across re-runs easily 
        // unless we use a specific pattern, but for this it's fine.
      }
    },
    args: [url]
  }).catch(() => {});
}

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
