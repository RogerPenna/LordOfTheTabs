// storage.js - IndexedDB Wrapper
const DB_NAME = 'LordOfTheTabsDB';
const DB_VERSION = 4;
const STORE_NAME = 'tabMetadata';
const ARCHIVE_STORE_NAME = 'archivedTabs';
const WORKSPACE_STORE_NAME = 'workspaces';
const SENSITIVE_HISTORY_STORE_NAME = 'sensitiveHistory';

let dbInstance = null;
let dbOpenPromise = null;

export function openDB() {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }
  if (dbOpenPromise) {
    return dbOpenPromise;
  }

  dbOpenPromise = new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn("IndexedDB open timed out after 3.5s");
        reject(new Error("IndexedDB open timeout"));
      }
    }, 3500);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(ARCHIVE_STORE_NAME)) {
        db.createObjectStore(ARCHIVE_STORE_NAME, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(WORKSPACE_STORE_NAME)) {
        db.createObjectStore(WORKSPACE_STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(SENSITIVE_HISTORY_STORE_NAME)) {
        const store = db.createObjectStore(SENSITIVE_HISTORY_STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('url', 'url', { unique: false });
        store.createIndex('visitTime', 'visitTime', { unique: false });
      }
    };

    request.onsuccess = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        if (dbInstance) {
          dbInstance.close();
          dbInstance = null;
        }
      };
      dbInstance.onclose = () => {
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onerror = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(request.error);
    };

    request.onblocked = () => {
      console.warn("IndexedDB upgrade blocked by another open tab/worker.");
    };
  }).finally(() => {
    dbOpenPromise = null;
  });

  return dbOpenPromise;
}

export async function getTabMeta(url) {
  if (!url) return { url: '', data_abertura: Date.now(), ultimo_acesso: Date.now(), importancia: 0, customTitle: '' };
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(url);
      request.onsuccess = () => resolve(request.result || { 
        url, 
        data_abertura: Date.now(), 
        ultimo_acesso: Date.now(), 
        importancia: 0,
        customTitle: '',
        parentTitle: 'Direct Entry',
        parentUrl: ''
      });
      request.onerror = () => resolve({ 
        url, 
        data_abertura: Date.now(), 
        ultimo_acesso: Date.now(), 
        importancia: 0,
        customTitle: '',
        parentTitle: 'Direct Entry',
        parentUrl: ''
      });
    });
  } catch (err) {
    return {
      url, 
      data_abertura: Date.now(), 
      ultimo_acesso: Date.now(), 
      importancia: 0,
      customTitle: '',
      parentTitle: 'Direct Entry',
      parentUrl: ''
    };
  }
}

export async function saveTabMeta(meta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(meta);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getAllTabMeta() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

export async function getArchivedTabs() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(ARCHIVE_STORE_NAME, 'readonly');
      const store = transaction.objectStore(ARCHIVE_STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

export async function archiveTab(tabData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ARCHIVE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(ARCHIVE_STORE_NAME);
    const request = store.put(tabData);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deleteArchivedTab(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ARCHIVE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(ARCHIVE_STORE_NAME);
    const request = store.delete(url);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function saveSensitiveHistory(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SENSITIVE_HISTORY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SENSITIVE_HISTORY_STORE_NAME);
    const index = store.index('url');
    const req = index.getAll(item.url);

    req.onsuccess = () => {
      const existing = req.result || [];
      const recent = existing.find(e => Math.abs(e.visitTime - item.visitTime) < 120000);
      if (recent) {
        if (item.title && (!recent.title || recent.title === recent.domain)) {
          recent.title = item.title;
        }
        recent.visitTime = item.visitTime;
        store.put(recent);
      } else {
        store.add({
          url: item.url,
          title: item.title || item.domain || item.url,
          visitTime: item.visitTime || Date.now(),
          domain: item.domain || ''
        });
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSensitiveHistory() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(SENSITIVE_HISTORY_STORE_NAME, 'readonly');
      const store = tx.objectStore(SENSITIVE_HISTORY_STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        items.sort((a, b) => (b.visitTime || 0) - (a.visitTime || 0));
        resolve(items);
      };
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

export async function deleteSensitiveHistoryItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SENSITIVE_HISTORY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SENSITIVE_HISTORY_STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearSensitiveHistory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SENSITIVE_HISTORY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SENSITIVE_HISTORY_STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function saveWorkspace(workspace) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(WORKSPACE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(WORKSPACE_STORE_NAME);
    const request = store.put(workspace);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllWorkspaces() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(WORKSPACE_STORE_NAME, 'readonly');
      const store = transaction.objectStore(WORKSPACE_STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

export async function deleteWorkspace(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(WORKSPACE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(WORKSPACE_STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function cleanupOldMeta() {
  const db = await openDB();
  const sixMonthsAgo = Date.now() - (6 * 30 * 24 * 60 * 60 * 1000);
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const meta = cursor.value;
        if (meta.ultimo_acesso < sixMonthsAgo && (meta.importancia || 0) === 0) {
          cursor.delete();
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function exportAllData() {
  const [tabMetadata, archivedTabs, workspaces] = await Promise.all([
    new Promise(async (resolve, reject) => {
      const db = await openDB();
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }),
    getArchivedTabs(),
    getAllWorkspaces()
  ]);
  return { tabMetadata, archivedTabs, workspaces };
}

export async function importAllData(data) {
  const db = await openDB();
  
  if (data.tabMetadata) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const item of data.tabMetadata) {
      store.put(item);
    }
  }
  
  if (data.archivedTabs) {
    const tx = db.transaction(ARCHIVE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(ARCHIVE_STORE_NAME);
    store.clear();
    for (const item of data.archivedTabs) {
      store.put(item);
    }
  }
  
  if (data.workspaces) {
    const tx = db.transaction(WORKSPACE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(WORKSPACE_STORE_NAME);
    store.clear();
    for (const item of data.workspaces) {
      store.put(item);
    }
  }
}
