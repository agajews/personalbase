const defaults = { baseUrl: "https://nc-main-ui-bzsz6.sprites.app", mark: "saved" };

const baseUrlInput = document.getElementById("baseUrl");
const markSelect = document.getElementById("mark");
const status = document.getElementById("status");

chrome.storage.sync.get(["baseUrl", "mark"]).then((stored) => {
  baseUrlInput.value = stored.baseUrl || defaults.baseUrl;
  markSelect.value = stored.mark || defaults.mark;
});

document.getElementById("save").addEventListener("click", () => {
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, "");
  void chrome.storage.sync.set({ baseUrl, mark: markSelect.value }).then(() => {
    status.textContent = "saved";
    setTimeout(() => (status.textContent = ""), 2000);
  });
});
