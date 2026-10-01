// i18n.js - Internationalization Helper

const fallbackStrings = {
  appName: "Lord of the Tabs",
  appDesc: "High-performance tab management with List/Grid views, IndexedDB history, and Google Sheets Backup.",
  searchPlaceholder: "Search by Title or URL...",
  exactLabel: "Exact",
  starFilterAll: "All ★",
  starFilterMin: "Min ★",
  muteAllTabs: "Mute/Unmute All Tabs",
  listGridToggle: "List/Grid Toggle",
  settingsLabel: "Settings",
  openDashboard: "Open Dashboard",
  helpDoc: "Help & Documentation",
  moveBtn: "Move",
  clearHistBtn: "Clear Hist",
  discardBtn: "Discard",
  closeBtn: "Close",
  proActivationTitle: "🔑 Pro License Activation",
  licenseKeyPlaceholder: "Enter License Key (LOTT-PRO-...)",
  activateBtn: "Activate",
  devToggleBtn: "Toggle Free/Pro",
  backupSettingsTitle: "💾 Backup Settings",
  panicModeDomainsTitle: "🚫 Panic Mode Domains",
  proFeatureLock: "🔒 Pro Feature",
  regularVaultTitle: "📋 Regular Archived Tabs (Inactive)",
  panicVaultTitle: "🚫 Panic-Closed Tabs (Sensitive)",
  restoreAllPanicBtn: "Restore All Panic Tabs",
  tabCountBadge: "Tabs",
  backupOverdueBadge: "⚠️ Backup Overdue!",
  tableTab: "📋 Table",
  chartsTab: "📊 Charts",
  vaultTab: "🗄️ Vault",
  workspacesTab: "📂 Saved Workspaces",
  refreshBtn: "↻ Refresh",
  exportCsvBtn: "Export CSV",
  backupBtn: "Backup",
  restoreBtn: "Restore",
  googleSearchPlaceholder: "Search Google or type a URL...",
  searchBtn: "Search",
  vaultLockBannerText: "🔒 Some items are hidden behind PIN.",
  unlockVaultBtn: "Unlock Vault",
  coffeeSupportTitle: "Support Lord of the Tabs",
  coffeeSupportText: "Enjoying Lord of the Tabs? Consider supporting independent development with a coffee!"
};

export function getMessage(key) {
  if (!key) return '';
  const cleanKey = key.replace(/^\[[a-zA-Z0-9_-]+\]/, '');
  if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
    return chrome.i18n.getMessage(cleanKey) || fallbackStrings[cleanKey] || cleanKey;
  }
  return fallbackStrings[cleanKey] || cleanKey;
}

export function translatePage() {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach(el => {
    const rawAttr = el.getAttribute('data-i18n');
    if (!rawAttr) return;

    const directives = rawAttr.split(';').map(d => d.trim()).filter(Boolean);
    for (const directive of directives) {
      const attrMatch = directive.match(/^\[([a-zA-Z0-9_-]+)\](.*)$/);
      if (attrMatch) {
        const targetAttr = attrMatch[1];
        const key = attrMatch[2];
        const msg = getMessage(key);
        if (msg) {
          el.setAttribute(targetAttr, msg);
        }
      } else {
        const msg = getMessage(directive);
        if (!msg) continue;

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.placeholder = msg;
        } else {
          el.textContent = msg;
        }
      }
    }
  });
}
