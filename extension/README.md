# Clippit Says No

Clippit's browser extension for Chromium browsers and Safari. It says no to cookie popups for you.

Consent-O-Matic's engine and rules turn down consent popups on the consent managers they know (OneTrust,
Cookiebot, Didomi, Sourcepoint, Usercentrics, TrustArc and about 200 more). Clippit's own pass
(`src/clippitFallback.js`) handles the rest, and anything a rule left half done:

1. the consent manager's own reject button, for the common ones;
2. the reject or "only necessary" button of any box that talks about cookies (English, Swedish, Danish,
   Norwegian, Finnish, German, French, Spanish, Italian, Dutch, Polish and Portuguese wordings);
3. a settings pane with one "Reject" per purpose: each of them, then save;
4. when a box only offers accept and settings: the settings, every optional purpose switched off, save;
5. when there is no way to say no: its close button, or the box is hidden and the page scrolls again.

It never presses accept: "Accept all", "I agree", "OK" and the like are never pressed, and neither is a
button that says so only in its label, like an icon × named "Accept and close". (It does press "Accept only
necessary", and "Accept selection" after switching everything off.) It only acts on a box that floats over the page and
looks like a popup, not on an app that happens to mention cookies, and it doesn't follow links. Each page
gets one minute. All rules ship inside the extension; nothing is fetched or reported anywhere. The toolbar
popup has the on/off switch, and a switch per site.

## Build

```
cd extension
npm install
npm run build          # build/chromium and build/safari
```

Clippy's face becomes the icon when Clippit's frames have been decoded (`npm run setup` in the Clippit
folder); otherwise it keeps Consent-O-Matic's icon. Those frames are Microsoft's artwork, so share a build
with Clippy's face only the way you'd share Clippit himself.

## Install

**Chrome, Brave, Edge, Arc:** `chrome://extensions` → Developer mode → Load unpacked → `extension/build/chromium`.

**Safari 26 or later, no Xcode:** Safari → Settings → Advanced → "Show features for web developers";
then Settings → Developer → "Add Temporary Extension…" → pick `extension/build/safari`. Safari drops a
temporary extension when it quits, so you add it again after that.

**Safari, to keep it installed:** needs Xcode (free in the App Store). Then

```
xcrun safari-web-extension-packager extension/build/safari --project-location extension/xcode \
  --app-name "Clippit Says No" --bundle-identifier se.karlsson.clippit.saysno --macos-only --no-open --force
xcodebuild -project "extension/xcode/Clippit Says No/Clippit Says No.xcodeproj" -scheme "Clippit Says No (macOS)" \
  -configuration Release CONFIGURATION_BUILD_DIR="$PWD/extension/xcode/build" build
open "extension/xcode/build/Clippit Says No.app"
```

and turn it on in Safari → Settings → Extensions. Without a developer account the app is unsigned, so
Safari also needs Develop → "Allow Unsigned Extensions" (once per Safari launch).

## Test

`test/fixtures.html` has a page per case Clippit's pass must get right (a reject that says "without
accepting", an × that accepts, a sign-in dialog and an app that mention consent, a settings pane, a
popup with no way out, and more). With the build loaded in a Chromium browser that has its DevTools port
open:

```
msedge --user-data-dir=<a throwaway folder> --remote-debugging-port=9333 --load-extension=<full path>/build/chromium
node test/run-fixtures.mjs
```

Google Chrome 137 and later ignore `--load-extension`; use Edge, Brave or Chromium for this.

## Credits

Built on [Consent-O-Matic](https://github.com/cavi-au/Consent-O-Matic) (v1.1.5) by Janus Bager Kristensen
and Rolf Bagge, CAVI, Aarhus University, under the MIT license (`LICENSE-Consent-O-Matic`). The rules in
`rules/` and most of `src/` are theirs, unchanged; `src/clippitFallback.js`, the build and the changes to
the popup, settings and background are Clippit's.
