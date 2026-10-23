import GDPRConfig from './GDPRConfig.js';
import Language from './Language.js';

let frontTab = document.querySelector(".fronttab");
if (frontTab){
    // The master switch: off means no rules and no Clippit pass on any page. Wired up on its own, so it
    // works even when the tab's address can't be read (a new tab, a browser page, Safari without access).
    let enabledInput = document.querySelector("#enabled");
    GDPRConfig.getGeneralSettings().then((general) => {
        enabledInput.checked = general.enabled !== false;
        document.body.classList.toggle("off", !enabledInput.checked);
        enabledInput.addEventListener("input", async () => {
            // Read again: the options page may have changed other settings since the popup opened.
            const current = await GDPRConfig.getGeneralSettings();
            current.enabled = enabledInput.checked;
            document.body.classList.toggle("off", !enabledInput.checked);
            GDPRConfig.setGeneralSettings(current);
        });
    });

    document.querySelector("#settings").addEventListener("click", function () {
        chrome.runtime.openOptionsPage();
        window.close();
    });

    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, (tabs) => {
        let url = null;
        try { url = new URL(tabs[0].url).host || null; } catch (e) { /* no address we can read */ }
        let activeInput = document.querySelector(".sitepart input");
        if (!url) {
            document.querySelector(".sitepart").style.display = "none";
            return;
        }
        document.querySelector("#site").textContent = url;

        GDPRConfig.isActive(url).then((active) => {
            activeInput.checked = active;
        });
        activeInput.addEventListener("input", () => {
            GDPRConfig.setPageActive(url, activeInput.checked);
        });
    });

    window.addEventListener("DOMContentLoaded", ()=>{
        Language.doLanguage();
    });
}
