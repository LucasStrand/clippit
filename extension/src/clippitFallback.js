// Clippit's own pass, for pages none of the rules know: finds a cookie or consent popup and says no to it. Known consent managers first, by their own buttons; then
// any dialog-like box that talks about cookies and has a reject / "only necessary" button; then, when a
// box only offers settings, the settings pane with every optional purpose switched off. If there is no
// way to say no, the box is closed or hidden and the page is scrollable again. It never clicks accept.
//
// clippitConsent() returns a JSON string: {action: 'rejected'|'closed'|'hidden'|'step'|'none', how, host}.
// State lives on window.__clippitConsent, so a page is handled once and stops being scanned after a minute.
// { framed: false } leaves popups drawn in an iframe alone (the extension's rules run inside those frames).

// An iframe that belongs to a consent manager, judging by its address: cmp.aftonbladet.se/privacy-manager,
// sourcepoint.theguardian.com, consent.trustarc.com and the like. Not any frame with "consent" in its path:
// a medical or banking consent form in an iframe is not a cookie popup.
const CMP_HOST = /^(cmp|cmpv2|consent|consent-cdn|sourcepoint|sp-[\w-]+|cdn\.privacy-mgmt|privacy-mgmt)\.|(^|\.)(privacy-mgmt\.com|trustarc\.com|cookielaw\.org|consensu\.org)$/i;
export function isCmpFrame() {
  return window !== window.top && (CMP_HOST.test(location.hostname) || /\/(privacy-manager|sp_message)\b/i.test(location.pathname));
}

export default function clippitConsent({ framed: hideFramed = true } = {}) {
  const W = window, D = document;
  const host = location.hostname.replace(/^www\./, '');
  const out = (action, how) => JSON.stringify({ action, how: how || '', host });
  if (!/^https?:$/.test(location.protocol)) return out('none', 'not a web page');

  // One go per page, not per address: single-page apps change the URL all the time, and each change
  // must not give a login or checkout modal a fresh chance to be closed.
  const page = location.origin + location.pathname;
  let st = W.__clippitConsent;
  if (!st || st.page !== page) st = W.__clippitConsent = { page, t0: Date.now(), done: false, steps: 0 };
  if (st.done) return out('none', 'already handled');
  if (Date.now() - st.t0 > 60000) return out('none', 'nothing found on this page');

  // ---------------------------------------------------------------- helpers

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = e => {
    if (!e || !e.getClientRects) return false;
    // display: contents (Reddit's dialog draws everything from its shadow root and slots)
    if (!e.getClientRects().length) return getComputedStyle(e).display === 'contents' && [...e.children, ...(e.shadowRoot ? e.shadowRoot.children : [])].some(visible);
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const label = e => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.title || '');
  // Every name a button goes by: an icon button's text is "×" but its aria-label may say "Accept and close".
  const names = e => [e.innerText, e.value, e.getAttribute('aria-label'), e.title].map(norm).filter(Boolean);

  // Open shadow roots, found once per round (Usercentrics and friends live in one).
  const shadows = [];
  (function collect(root) {
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { shadows.push(e.shadowRoot); collect(e.shadowRoot); }
  })(D);
  // Is shadow root sr somewhere below root, however many shadow trees deep?
  const inside = (root, sr) => {
    if (root === D) return true;
    for (let h = sr.host; h; h = h.getRootNode().host) if (h === root || root.contains(h)) return true;
    return false;
  };
  // Every element matching sel under root, through the open shadow roots below it.
  function all(root, sel) {
    const acc = [...root.querySelectorAll(sel)];
    for (const sr of shadows) if (sr !== root && inside(root, sr)) acc.push(...sr.querySelectorAll(sel));
    return acc;
  }
  // What a box says in its own words, not in its links and buttons (so a header with a "Cookies" link
  // isn't a cookie popup), shadow roots included (Reddit keeps its words in one).
  const prose = e => {
    let t = '';
    for (const root of [e, ...shadows.filter(sr => inside(e, sr))]) {
      const w = D.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode()) && t.length < 6000;) {
        const p = n.parentElement;
        if (p && !p.closest('a, button, [role="button"], script, style, noscript')) t += n.data + ' ';
      }
    }
    return t;
  };
  const onScreen = e => [...e.getClientRects(), ...(e.getClientRects().length ? [] : [...e.children].map(c => c.getBoundingClientRect()))]
    .some(r => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth);
  const describe = e => (e.id ? `#${e.id}` : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : ''));

  const first = sel => all(D, sel).find(visible);
  // A box's buttons, real buttons first; a heading that happens to be focusable is not one.
  // Amazon and others lay a see-through <input> over a styled span: it is the button you press.
  const overlay = b => b.matches('input, button') && b.parentElement && visible(b.parentElement) && (() => {
    const cs = getComputedStyle(b), r = b.getBoundingClientRect();
    return Number(cs.opacity) <= 0.05 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.width >= 2 && r.height >= 2;
  })();
  const buttonsIn = box => all(box, BUTTONS).filter(b => (visible(b) || overlay(b)) && !b.matches('h1, h2, h3, h4, h5, h6, [role="heading"]'))
    .sort((a, b) => (a.matches('button, [role="button"]') ? 0 : 1) - (b.matches('button, [role="button"]') ? 0 : 1));
  // A link that goes somewhere (the cookie policy, a settings page) would take you off the page you're reading.
  const staysHere = b => !b.matches('a[href]') || /^(#|javascript:)/i.test(b.getAttribute('href') || '#');
  const click = (e, how) => { e.click(); return how; };

  const finish = (action, how) => { st.done = true; return out(action, how); };

  // ---------------------------------------------------------------- 1. known consent managers

  // Each selector is the manager's own "reject" button, scoped to its own container where the id is generic.
  const KNOWN = [
    ['OneTrust', '#onetrust-reject-all-handler, .ot-pc-refuse-all-handler'],
    ['Cookiebot', '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'],
    ['Didomi', '#didomi-notice-disagree-button, .didomi-continue-without-agreeing'],
    ['Usercentrics', '[data-testid="uc-deny-all-button"]'],
    ['Google', '.fc-cta-do-not-consent'],
    ['CookieYes', '.cky-btn-reject'],
    ['Complianz', '.cmplz-deny'],
    ['iubenda', '.iubenda-cs-reject-btn'],
    ['Osano', '.osano-cm-denyAll'],
    ['Termly', '[data-tid="banner-decline"]'],
    ['Klaro', '.klaro .cm-btn-decline, .klaro .cn-decline'],
    ['Axeptio', '#axeptio_btn_dismiss'],
    ['CookieConsent', '.cc-window .cc-deny, #cc-main .cm__btn[data-role="necessary"]'],
    ['Borlabs', '#BorlabsCookieBox [data-cookie-refuse], a._brlbs-refuse-btn'],
    ['TrustArc', '#truste-consent-required'],
    ['Shopify', '#shopify-pc__banner__btn-decline'],
    ['HubSpot', '#hs-eu-decline-button'],
    ['Cookie Information', '#coiOverlay #declineButton, #cookie-information-template-wrapper #declineButton, .coi-banner__decline'],
  ];
  for (const [name, sel] of KNOWN) {
    const b = first(sel);
    if (b) return finish('rejected', click(b, name));
  }

  // ---------------------------------------------------------------- 2. anything that looks like a cookie box

  const TOPIC = /cookie|kakor|samtyck|samtykke|consent|gdpr|einwilligung|datenschutz|consenso|toestemming|evästeet|rgpd/i;
  const REJECT = [
    /^(reject|decline|deny|refuse|disagree)( all| all cookies| cookies| optional( cookies)?| additional cookies| non-?essential( cookies)?| and close)?$/,
    /^(only|use only|allow only|accept only|use|allow|accept) (strictly )?(necessary|essential|required)( cookies)?( only)?$/,
    /^(only )?allow (strictly )?(necessary|essential|required) cookies( only)?$/,
    /^(strictly )?(necessary|essential|required) (cookies )?only$/,
    /^continue without (accepting|agreeing|consent)/,
    /^(i )?do not (accept|agree|consent)/, /^(i )?don'?t (accept|agree)/, /^no,? thanks$/,
    /^(avvisa|neka|avböj|avslå)( alla| alla cookies| alla kakor| cookies| kakor| valfria cookies| valfria kakor| ytterligare cookies| icke[- ]nödvändiga( cookies| kakor)?)?$/,
    /^(godkänn|acceptera|tillåt|använd|spara) (bara |endast |enbart )?(strikt )?(nödvändiga|nödvändig|obligatoriska)( cookies| kakor)?$/,
    /^(bara|endast|enbart) (nödvändiga|nödvändig|obligatoriska)( cookies| kakor)?$/,
    /^(nödvändiga|nödvändig) (cookies|kakor) (bara|endast)$/, /^fortsätt utan att (godkänna|acceptera|samtycka)/,
    /^(afvis|afvis alle|avvis|avvis alle|avslå alle|hylkää|hylkää kaikki|kiellä)$/,
    /^(kun|bare) (nødvendige|nødvendig|nödvändiga)( cookies)?$/, /^(vain|ainoastaan) välttämättömät( evästeet)?$/,
    /^(alle )?ablehnen$|^nur (notwendige|essenzielle|erforderliche)|^optionale cookies ablehnen$|^weiter ohne (einwilligung|zustimmung)/,
    /^(tout )?refuser|^continuer sans accepter/,
    /^rechazar|^(solo|sólo) (las )?(necesarias|esenciales)/, /^rifiuta|^(solo|accetta solo) (i )?(necessari|essenziali)/,
    /^(alles )?(afwijzen|weigeren)|^alleen (noodzakelijke|essentiële)/, /^odrzuć/, /^rejeitar|^recusar/,
  ];
  // Word-anchored, so "Facebook" or "Outlook" isn't an "ok" and "Close account" isn't a close button.
  const ACCEPT = /\b(accept|agree|allow all|got it|akzeptieren|accepter|aceptar|accetta)|godkänn|acceptera|tillåt|jag förstår|^(ok|okay|okej)$/;
  const NECESSARY = /necessary|essential|required|nödvändig|obligatorisk|notwendig|nødvendig|välttämät|noodzakelijk|necesari|necessari/;
  // "Continue without accepting", "Disagree", "I do not accept": a reject that says the word "accept".
  const NEGATED = /without|\bdo not\b|\bdon'?t\b|\bdis(agree)|\butan\b|\bsans\b|\bohne\b|\bnicht\b/;
  const isReject = t => t && t.length < 60 && REJECT.some(r => r.test(t)) && (!ACCEPT.test(t) || NECESSARY.test(t) || NEGATED.test(t));
  // "Accept selection" in a settings pane saves what's switched on, which by then is nothing.
  const isAccept = t => t.length < 60 && ACCEPT.test(t) && !NECESSARY.test(t) && !NEGATED.test(t) && !SAVE.test(t);
  const SETTINGS = /^(cookie )?(settings|preferences|options|customi[sz]e|manage( cookies| options| preferences| settings)?|more options|let me choose|(manage|customi[sz]e) or reject)$|^show purposes$|^(inställningar|cookie-?inställningar|(anpassa|hantera)( cookies| kakor| inställningar| val| mina val| eller avvisa)?|fler alternativ|visa (detaljer|alternativ|syften|ändamål)|välj själv)$|^(einstellungen|cookie-einstellungen|anpassen|paramétrer|personnaliser|configurar|personalizar|impostazioni|instellingen)$/;
  const SAVE = /^(save|confirm|submit)( my)?( choices| preferences| settings| selection)?( and close| and exit| & close| & exit)?$|^(allow|accept) (selection|selected)$|^(spara|bekräfta)( mina)?( val| inställningar| urval)?( och stäng)?$|^(auswahl )?(speichern|bestätigen)$|^auswahl (speichern|bestätigen|erlauben)$|^(enregistrer|valider)( mes choix)?$/;
  const CLOSE = /^(close|stäng|dismiss|schließen|fermer|cerrar|chiudi|sluiten|×|✕|✖|x)$|^(close|stäng) (the )?(banner|dialog|popup|notice|meddelande|meddelandet|rutan)$/;

  const BUTTONS = 'button, a, [role="button"], input[type="button"], input[type="submit"], [tabindex="0"]';

  // A box Clippit may act on is a popup, not the page: an app whose root is position: fixed and mentions
  // cookies somewhere in its footer must not have its own settings opened, its switches turned off or
  // itself hidden.
  const consentNamed = e => e.matches('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="cmp" i]');
  function popupSized(e) {
    if (consentNamed(e)) return true;
    const r = e.getBoundingClientRect();
    if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) return true;
    // As big as the screen: a cookie wall has a backdrop and a short text; an app has a main part and more to say.
    return !all(e, 'main, [role="main"]').length && prose(e).length < 3000 && all(e, BUTTONS).length <= 30;
  }

  // The boxes: dialogs, banners pinned to the screen, consent-ish ids, that mention cookies.
  function boxes() {
    const found = new Set();
    for (const e of all(D, '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="cmp" i]')) {
      if (visible(e) && onScreen(e)) found.add(e);
    }
    for (const e of all(D, 'body *')) {
      if (found.size > 40) break;
      const p = getComputedStyle(e).position;
      if ((p === 'fixed' || p === 'sticky') && visible(e) && onScreen(e)) found.add(e);
    }
    return [...found]
      .filter(e => e !== D.body && e !== D.documentElement && TOPIC.test(prose(e)))
      .filter(e => all(e, BUTTONS).some(visible) || e.matches('[class*="cookie" i], [id*="cookie" i]'))
      // the outermost box wins, so hiding it takes the whole popup and its backdrop
      .filter((e, _i, arr) => !arr.some(o => o !== e && o.contains(e)));
  }

  // Floating: a dialog, or pinned to the screen. Only those get their settings opened, or get closed or
  // hidden; a "cookie settings" link in a footer is left alone.
  function floating(e) {
    if (e === D.body) return wholePage;
    for (let n = e; n && n !== D.body && n !== D.documentElement; n = n.parentElement || (n.getRootNode().host || null)) {
      if (n.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog')) return true;
      if (n.shadowRoot && n.shadowRoot.querySelector('dialog[open]')) return true;
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') return true;
    }
    return false;
  }

  let list = boxes();
  // consent.google.com and the like, or a consent manager's own iframe (Sourcepoint draws its box and its
  // settings in one): the whole page is the question.
  const wholePage = /^consent\./.test(location.hostname) || isCmpFrame();
  // The whole page goes first: a section of it with one "Reject" is one purpose, not the answer.
  if (wholePage && D.body) list.unshift(D.body);
  // Sourcepoint, TrustArc and Google draw their box in an iframe we can't reach: only hiding works there.
  const framed = hideFramed ? all(D, '[id^="sp_message_container"], .truste_overlay, .truste_box_overlay, #truste-consent-track, .fc-consent-root').filter(visible) : [];
  if (!list.length && !framed.length) return out('none', 'no popup');

  for (const box of list) {
    const noes = buttonsIn(box).filter(b => isReject(label(b)) && !names(b).some(isAccept));
    if (!noes.length) continue;
    // One "Reject all" is the answer. The same "Reject" over and over is a settings pane with one per
    // purpose (Schibsted's Sourcepoint): say no to each, then save.
    const count = {};
    for (const b of noes) count[label(b)] = (count[label(b)] || 0) + 1;
    const one = noes.find(b => count[label(b)] === 1);
    if (one) return finish('rejected', click(one, `"${label(one)}"`));
    const save = buttonsIn(box).find(b => staysHere(b) && SAVE.test(label(b)) && !names(b).some(isAccept));
    if (save) {
      for (const b of noes) b.click();
      return finish('rejected', click(save, `said no to ${noes.length} purposes and pressed "${label(save)}"`));
    }
  }

  // From here on Clippit opens settings, closes or hides, so only for a box that is really asking: it floats,
  // is popup-sized and has an accept button. A "cookie settings" link in a footer, or the little cookie badge
  // some sites leave in a corner after you've chosen, stays put.
  const asking = box => floating(box) && (box === D.body || popupSized(box)) && buttonsIn(box).some(b => isAccept(label(b)));

  // Second layer: we opened the settings last time. In the pane that has a save button, switch every
  // optional purpose off and save; without a save button nothing is touched.
  // (A settings pane often has no accept button of its own, so any floating popup will do here.)
  if (st.steps > 0) {
    for (const box of list.filter(b => floating(b) && (b === D.body || popupSized(b)))) {
      const save = buttonsIn(box).find(b => staysHere(b) && SAVE.test(label(b)) && !names(b).some(isAccept));
      if (!save) continue;
      let flipped = 0;
      for (const c of all(box, 'input[type="checkbox"]:checked:not(:disabled)')) { c.click(); flipped++; }
      for (const s of all(box, '[role="switch"][aria-checked="true"]:not([aria-disabled="true"])')) { s.click(); flipped++; }
      return finish('rejected', click(save, `turned off ${flipped} and pressed "${label(save)}"`));
    }
  }

  list = list.filter(asking).concat(framed);
  if (!list.length) return out(st.steps ? 'step' : 'none', st.steps ? 'waiting for the settings' : 'no popup');

  // Only "accept" and "settings" on offer: open the settings once and come back next round.
  if (st.steps < 1) {
    for (const box of list) {
      const s = buttonsIn(box).find(b => staysHere(b) && SETTINGS.test(label(b)));
      if (s) { st.steps++; click(s, ''); return out('step', `opened "${label(s)}"`); }
    }
  }
  // Settings opened but no way to save after a few rounds: fall through to close or hide.
  if (st.steps > 0 && st.steps++ < 4) return out('step', 'waiting for the settings');

  // No way to say no: close the box, or hide it, and let the page scroll again.
  for (const box of list) {
    const x = buttonsIn(box).find(b => {
      const n = names(b);
      return staysHere(b) && n.some(t => t.length < 30 && CLOSE.test(t)) && !n.some(t => ACCEPT.test(t));
    });
    if (x) { x.click(); unlock(); return finish('closed', `"${label(x) || 'close'}"`); }
  }
  if (wholePage) return finish('none', 'a consent page with no way to say no');   // hiding the page itself helps nobody
  const hidden = list.filter(box => box !== D.body);
  for (const box of hidden) box.style.setProperty('display', 'none', 'important');
  // Backdrops left behind: full-screen, see-through fixed layers with nothing in them.
  for (const e of D.body.querySelectorAll('div, span, section')) {
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    if (cs.position !== 'fixed' || r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) continue;
    if ((e.innerText || '').trim() || e.querySelector('img, video, canvas, iframe, svg, input')) continue;
    const bg = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const alpha = bg ? Number((bg[1].split(',')[3] ?? '1').trim()) : 1;
    if ((alpha > 0 && alpha < 1) || Number(cs.opacity) < 1 || cs.backdropFilter !== 'none') e.style.setProperty('display', 'none', 'important');
  }
  unlock();
  return finish('hidden', hidden.map(describe).join(', '));

  function unlock() {
    for (const e of [D.documentElement, D.body]) {
      if (!e) continue;
      const cs = getComputedStyle(e);
      if (cs.overflowY === 'hidden') e.style.setProperty('overflow-y', 'auto', 'important');
      if (cs.position === 'fixed') e.style.setProperty('position', 'static', 'important');
    }
  }
}
