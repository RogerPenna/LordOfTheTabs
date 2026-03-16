// gemini_content_script.js - Optimized & Quiet Extraction

let lastSavedTitle = "";
let lastUrl = location.href;

const BLACKLIST = [
  "google gemini", "gemini", "conversas", "conversas recentes", 
  "nova conversa", "novo chat", "chat", "untitled", "configurações", "ajuda"
];

function isTitleValid(title) {
  if (!title) return false;
  const t = title.toLowerCase().trim();
  if (t.length < 3) return false;
  return !BLACKLIST.some(bad => t === bad || t === "gemini: conversas");
}

function updateGeminiTitle(force = false) {
  const titleEl = document.querySelector('span[data-test-id="conversation-title"]');
  if (!titleEl) return;

  const cleanTitle = titleEl.innerText.trim();
  
  // SÓ envia se o título for válido E for diferente do último enviado (nesta instância da URL)
  if (isTitleValid(cleanTitle) && (cleanTitle !== lastSavedTitle || force)) {
    lastSavedTitle = cleanTitle;
    
    chrome.runtime.sendMessage({
      action: "UPDATE_GEMINI_TITLE",
      title: `Gemini: ${cleanTitle}`,
      url: window.location.href
    }, (response) => {
      if (chrome.runtime.lastError) return;
    });
  }
}

const observer = new MutationObserver(() => updateGeminiTitle());
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// Monitor de mudança de URL (Troca de Chat no Gemini)
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastSavedTitle = ""; // RESET: Força o script a re-validar o título para a nova URL
    updateGeminiTitle(true);
  }
}, 1000);

updateGeminiTitle();
