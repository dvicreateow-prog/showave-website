/* SHOWAVE-specific browser handoff. Ordinary top-level navigation only: never
   frame provider login, inspect its cookies, or alter the browser identity.
   The browser host chooses how to display a new tab; provider acceptance is
   not guaranteed. Authorization URLs stay in this short-lived DOM, not logs
   or storage. Google Testing access is independent of the browser handoff. */
(function (root) {
  'use strict';
  // A helper reply can arrive after the operator has moved to another attempt.
  // Only the current prompt may own the shared sign-in surface.
  const prompts = new WeakMap();
  function textNode(doc, tag, text) {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  }
  function officialLink(doc, text, href) {
    const link = textNode(doc, 'a', text);
    link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  }
  function googleGuidance(doc) {
    const customer = textNode(doc, 'div', 'You can choose an account already signed in to Google, but it must grant SHOWAVE its own access. Customers do not need to create a Google Cloud project.');
    const testing = textNode(doc, 'div', 'If Google explicitly says SHOWAVE is being tested and access is blocked, contact the SHOWAVE app owner. Being signed in does not grant test access.');
    const owner = doc.createElement('details');
    owner.open = false;
    const summary = textNode(doc, 'summary', 'For the SHOWAVE app owner');
    summary.tabIndex = 0; // Included in Studio's explicit [tabindex] modal focus trap.
    const project = textNode(doc, 'div', 'First verify that the Google Cloud project owns the exact OAuth client used by this connection. A similarly named project is not proof.');
    const development = textNode(doc, 'div', 'If that app is in Testing, add approved development accounts under Google Auth Platform → Audience → Test users. This is temporary testing access.');
    const production = textNode(doc, 'div', 'For public customers, configure production access and complete applicable Google verification. Publishing and verification are separate; customers should not join a developer test-user list.');
    const audienceLink = textNode(doc, 'div', '');
    audienceLink.replaceChildren(officialLink(doc, 'Google: Manage app audience', 'https://support.google.com/cloud/answer/15549945?hl=en'));
    const verificationLink = textNode(doc, 'div', '');
    verificationLink.replaceChildren(officialLink(doc, 'Google: Sensitive scope verification', 'https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification'));
    const errorLink = textNode(doc, 'div', '');
    errorLink.replaceChildren(officialLink(doc, 'Google: Understand sign-in errors', 'https://support.google.com/accounts/answer/16668185?hl=en'));
    owner.replaceChildren(summary, project, development, production, audienceLink, verificationLink, errorLink);
    return [customer, testing, owner];
  }

  // Static guidance only. Call after disposing the waiting prompt: no flow,
  // error body, authorization URL or device code is accepted or retained.
  // Known provider names keep even a mistakenly supplied sensitive label out
  // of recovery content. The caller owns its separate sanitized result text.
  function showRecovery({ provider, label, container, unconfirmed } = {}) {
    if (!container) return false;
    const previous = prompts.get(container);
    if (previous) previous();
    const doc = container.ownerDocument;
    const name = provider === 'youtube' ? 'YouTube' : provider === 'kick' ? 'Kick'
      : provider === 'twitch' ? 'Twitch' : 'Platform';
    const result = textNode(doc, 'div', unconfirmed === true
      ? name + ' connection was not confirmed. SHOWAVE cannot tell whether authorization is still in progress on the platform page.'
      : name + ' connection attempt returned an error. Review the connection message and the platform page for the reported reason.');
    const next = textNode(doc, 'div', 'Check the platform tab, then use Refresh channels to check for a saved connection before starting another sign-in. Closing this panel or stopping the wait does not cancel authorization.');
    const nodes = [result, next];
    if (provider === 'youtube') nodes.push(...googleGuidance(doc));
    container.replaceChildren(...nodes); container.hidden = false;
    return true;
  }

  function authorizationURL(provider, begun) {
    if (!begun || begun.browserHandoff !== 'caller' || begun.openedSystemBrowser !== false)
      throw new Error('The helper did not confirm sign-in in the current browser.');
    const raw = begun.authorizeUrl || begun.verificationUri;
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('The helper returned an invalid sign-in address.'); }
    const allowed = {
      youtube: [['accounts.google.com', '/o/oauth2/v2/auth']],
      kick: [['id.kick.com', '/oauth/authorize']],
      twitch: [['www.twitch.tv', '/activate'], ['twitch.tv', '/activate']]
    };
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(Object.prototype.hasOwnProperty.call(allowed, provider) ? allowed[provider] : []).some(([host, path]) => url.hostname === host &&
          (url.pathname === path || url.pathname === path + '/')))
      throw new Error('The helper returned an unexpected sign-in address. No page was opened.');
    return url.href;
  }

  function reserve({ provider, label, container }) {
    if (!container) throw new Error('The sign-in prompt is unavailable. Reload Studio before trying again.');
    const previous = prompts.get(container);
    if (previous) previous();
    // A new user-requested attempt owns this surface, including while the
    // helper is negotiating its browser handoff. Do not leave stale recovery.
    container.replaceChildren(); container.hidden = true;
    let tab = null, navigated = false, disposed = false;
    prompts.set(container, dispose);
    function closeUnusedTab() {
      try { if (tab && !navigated && tab.location.href === 'about:blank') tab.close(); }
      catch (_) { /* A cross-origin page may belong to the user now; leave it. */ }
    }
    // Reserve during the card's user gesture, before awaiting the helper. A
    // denied popup is normal: the explicit link below uses the same flow.
    try {
      tab = root.open('about:blank', '_blank');
      if (tab) tab.opener = null;
    } catch (_) {
      closeUnusedTab();
      tab = null;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (prompts.get(container) === dispose) {
        prompts.delete(container);
        container.replaceChildren(); container.hidden = true;
      }
      // Never close a provider page on failure/timeout: the user's consent may
      // still be in progress. Only close the blank tab owned by this request.
      closeUnusedTab();
      tab = null;
    }
    function show(begun) {
      if (disposed) throw new Error('This sign-in request is no longer waiting.');
      const url = authorizationURL(provider, begun);
      const doc = container.ownerDocument;
      const intro = doc.createElement('div');
      intro.textContent = 'Approve access in the ' + label + ' tab. SHOWAVE will check your connection and add available channels automatically when authorization finishes.';
      const link = doc.createElement('a');
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = 'Continue ' + label + ' sign-in';
      const help = doc.createElement('div');
      help.textContent = 'Choose an account already signed in to this browser, or sign in on the platform page. If no tab appeared, use the link above. Closing this panel does not cancel authorization.';
      if (begun.userCode) help.textContent += ' If prompted, enter code: ' + String(begun.userCode) + '.';
      const nodes = [intro, link, help];
      if (provider === 'youtube') {
        const consent = doc.createElement('div');
        consent.textContent = 'Google controls the consent screen. Review the permissions and approve them if you agree. You can decline. This does not start a broadcast.';
        nodes.push(consent);
      }
      container.replaceChildren(...nodes); container.hidden = false;
      if (tab) {
        try {
          if (!tab.closed && tab.location.href === 'about:blank') {
            tab.location.replace(url); navigated = true;
          }
        } catch (_) { /* The visible link remains usable if the host refuses. */ }
      }
    }
    return { show, dispose };
  }
  root.OpenLiveAccountBrowser = Object.freeze({ reserve, authorizationURL, showRecovery });
})(typeof window === 'undefined' ? globalThis : window);
