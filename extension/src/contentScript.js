import GDPRConfig from "./GDPRConfig.js";
import ConsentEngine from "./ConsentEngine.js";
import clippitConsent, { isCmpFrame } from "./clippitFallback.js";

// When no rule knew the page, Clippit has a go himself, in the top frame or a consent manager's own iframe:
// every two seconds for a minute,
// the reject / "only necessary" button of any cookie box, else its settings with everything off, else
// close or hide it. Never accept.
// afterRule: a rule already clicked its way through, so three empty looks in a row are enough.
function clippitFallback({ afterRule = false } = {}) {
    if ((window !== window.top && !isCmpFrame()) || window.__clippitFallback || window.__clippitOff) return;
    const started = Date.now();
    let quiet = 0;
    window.__clippitFallback = setInterval(() => {
        let res;
        if (Date.now() - started > 65000) { clearInterval(window.__clippitFallback); return; }   // a minute, whatever the page does
        // Popups drawn in an iframe get ten seconds for the rules and Clippit inside that frame; after
        // that the top frame may hide the frame's container.
        try { res = JSON.parse(clippitConsent({ framed: Date.now() - started > 10000 })); } catch (e) { return; }
        if (ConsentEngine.debugValues && ConsentEngine.debugValues.debugLog) console.log("Clippit fallback:", location.host + location.pathname, res.action, res.how);
        if (["rejected", "closed", "hidden"].includes(res.action)) {
            clearInterval(window.__clippitFallback);
            chrome.runtime.sendMessage("ClippitHandled|" + JSON.stringify(res));
        } else if (res.how === "nothing found on this page" || res.how === "already handled" || (afterRule && res.how === "no popup" && ++quiet >= 3)) {
            clearInterval(window.__clippitFallback);
        }
    }, 2000);
}

// Switched off in the popup while a page is open: stop Clippit's pass there too.
chrome.storage.onChanged.addListener((changes, area) => {
    const now = area === "sync" && changes.generalSettings && changes.generalSettings.newValue;
    if (now && now.enabled === false) {
        window.__clippitOff = true;
        clearInterval(window.__clippitFallback);
    }
});

async function contentScriptRunner() {
    if (document.contentType!=="text/html") return;

    // Figure out the URL
    let url = location.href;
    let insideIframe = window !== window.parent;
    if(insideIframe) {
        //We are inside an iframe, request the actual tab url to check if we are active
        url = await new Promise((resolve, reject)=>{
            chrome.runtime.sendMessage("GetTabUrl", (response)=>{
                resolve(response);
            });
        });
    }
    const urlObj = new URL(url);
    url = urlObj.host;

    const settings = await GDPRConfig.getGeneralSettings();
    if (settings.enabled === false) return;

    GDPRConfig.isActive(url).then(async (active) => {
        if (active) {
            chrome.runtime.sendMessage("GetRuleList", (fetchedRules)=>{
                if (!fetchedRules) {
                    console.log("Failed to connect with service worker for getRuleList msg", fetchedRules);
                } else {
                    GDPRConfig.getCustomRuleLists().then((customRules)=>{
                        fetchedRules.forEach((ruleObj)=>{
                            delete ruleObj["$schema"];
                        });
                        delete customRules["$schema"];
        
                        // Concat rule-lists to engine config in order
                        let config = Object.assign({}, ...fetchedRules, customRules);
        
                        GDPRConfig.getConsentValues().then((consentTypes)=>{
                            GDPRConfig.getDebugValues().then((debugValues)=>{
                                GDPRConfig.getGeneralSettings().then((generalSettings)=>{
                                    if(debugValues.debugLog) {
                                        console.log("FetchedRules:", fetchedRules);
                                        console.log("CustomRules:", customRules);
                                    }
                    
                                    ConsentEngine.debugValues = debugValues;
                                    ConsentEngine.generalSettings = generalSettings;
                                    ConsentEngine.topFrameUrl = url;
            
                                    chrome.runtime.sendMessage("Searching");
                                    let engine = new ConsentEngine(config, consentTypes, (evt)=>{
                                        let result = {
                                            "handled": evt.handled
                                        };
    
                                        if(evt.handled) {
                                            result.cmp = evt.cmpName;
                                            result.clicks = evt.clicks;
                                            result.url = url;
        
                                            chrome.runtime.sendMessage("HandledCMP|"+JSON.stringify(result));
                                            // Clippit looks once more after a rule, too: one that ran without clicking
                                            // anything didn't really manage (old layouts, like Sourcepoint's on Blocket),
                                            // and one that clicked can leave a settings pane open (Sourcepoint on BBC).
                                            // If the popup is gone he finds nothing and stops after a minute.
                                            if (generalSettings.clippitFallback !== false) clippitFallback({ afterRule: evt.clicks > 0 });
                                        } else if(evt.error) {
                                            chrome.runtime.sendMessage("CMPError");
                                            if (generalSettings.clippitFallback !== false) clippitFallback();
                                        } else {
                                            chrome.runtime.sendMessage("NothingFound");
                                            if (generalSettings.clippitFallback !== false) clippitFallback();
                                        }
                                    });
            
                                    ConsentEngine.singleton = engine;
            
                                    if(debugValues.debugLog) {
                                        console.log("ConsentEngine loaded " + engine.cmps.length + " of " + Object.keys(config).length + " rules");
                                    }
                                });
                            });
                        });
                    });
                }
            });
        }
    });
}

window.consentScrollBehaviours = {};
function getCalculatedStyles() {
    ["html","html body"].forEach(element=>{
        let node = document.querySelector(element);
        if (node) {
            let styles = window.getComputedStyle(node);
            window.consentScrollBehaviours[element+".consent-scrollbehaviour-override"] = ["position","overflow","overflow-y"].map(property=>{
                return {property:property, value:styles[property]}
            });
        }
    });
}

// Observe styles in order to temporarily restore them if a popup kills them
let topContentTag = document.querySelector("html");
if (topContentTag){
    let observer = new MutationObserver((mutations)=>{
        mutations.forEach((mutation)=>{
            mutation.addedNodes.forEach((node)=>{
                if(node.matches != null && node.matches("body")) {
                    getCalculatedStyles();
                    observer.disconnect();
                }
            })
        });
    });

    observer.observe(topContentTag, {
        childList: true
    });
}
window.addEventListener("message", (event)=>{
    try {
        if(event.data?.enforceScrollBehaviours != null) {
            ConsentEngine.enforceScrollBehaviours(event.data.enforceScrollBehaviours);
        }
    }catch(e) {
        console.error("Error inside message listener:", e);
    }
});

contentScriptRunner().catch((e)=>{
    console.error(e);
});
