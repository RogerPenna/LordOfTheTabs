// licensing.js - Premium Tier Management

export async function checkPremium() {
  const data = await chrome.storage.local.get('isPremium');
  return !!data.isPremium;
}

export function validateLicenseKey(key) {
  if (!key) return false;
  const trimmed = key.trim().toUpperCase();
  // Valid pattern: LOTT-PRO-XXXX-XXXX where X is alphanumeric
  const pattern = /^LOTT-PRO-[A-Z0-9]{4,}-[A-Z0-9]{4,}$/;
  return pattern.test(trimmed);
}

export async function activatePro(key) {
  if (validateLicenseKey(key)) {
    await chrome.storage.local.set({ isPremium: true, licenseKey: key });
    return true;
  }
  return false;
}

export async function deactivatePro() {
  await chrome.storage.local.set({ isPremium: false, licenseKey: null });
}

export async function toggleDevPro() {
  const isPremium = await checkPremium();
  const nextState = !isPremium;
  await chrome.storage.local.set({ isPremium: nextState });
  return nextState;
}
