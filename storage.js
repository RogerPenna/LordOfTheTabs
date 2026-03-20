// storage.js - IndexedDB Wrapper
const DB_NAME = 'LordOfTheTabsDB';
const DB_VERSION = 3;
const STORE_NAME = 'tabMetadata';
const ARCHIVE_STORE_NAME = 'archivedTabs';
const WORKSPACE_STORE_NAME = 'workspaces';

export function openDB() {
  return new Promise((resolve, reject) => {
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getTabMeta(url) {
  if (!url) return { url: '', importancia: 0, customTitle: '' };
  const db = await openDB();
  return new Promise((resolve, reject) => {
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
    request.onerror = () => reject(request.error);
  });
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
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getArchivedTabs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ARCHIVE_STORE_NAME, 'readonly');
    const store = transaction.objectStore(ARCHIVE_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(WORKSPACE_STORE_NAME, 'readonly');
    const store = transaction.objectStore(WORKSPACE_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
