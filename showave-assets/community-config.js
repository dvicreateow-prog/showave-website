/* Curated public registry. Empty until records have been checked by a maintainer.
 * A source URL and verified:true are required; the UI never treats browser drafts
 * as verified. Publish names only with visibility:'named' and consent:true.
 * Never put emails, account credentials, donation amounts or private links here.
 */
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// Project destinations must stay on GitHub over HTTPS. Keep this separate from
// evidence URLs and local guide links so a configuration typo cannot redirect it.
export function githubLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null;
    if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export const communityConfig = freeze({
  version: 1,
  records: {
    // contributors: { id, name, visibility:'anonymous'|'named', consent:boolean }
    contributors: [],
    // contributions: { id, contributorId, type, date:'YYYY-MM-DD', description,
    //                  sourceUrl:'https://…', verified:true, verifiedAt:'YYYY-MM-DD' }
    contributions: [],
    // sponsors: { id, name, visibility, consent, tierId, date, sourceUrl,
    //             verified:true, verifiedAt }
    sponsors: []
  },
  links: {
    contributionGuide: '/manuals?article=contribute',
    sponsorship: '/foundation#support',
    // Owner-supplied destinations. The repository is temporary; no migration or
    // automatic contributor import is implied by these navigation links.
    repository: 'https://github.com/dvicreateow-prog/openlive',
    issues: 'https://github.com/dvicreateow-prog/openlive/issues',
    pullRequests: 'https://github.com/dvicreateow-prog/openlive/pulls',
    futureHome: 'https://github.com/afrounity256-hub?tab=repositories'
  },
  tiers: [
    { id: 'supporter', name: 'Supporter', description: 'Individual support for development, testing and documentation. Recognition terms are being prepared.', status: 'preview' },
    { id: 'crew', name: 'Crew', description: 'Teams helping sustain shared production tools. No paid access to software or project decisions.', status: 'preview' },
    { id: 'partner', name: 'Partner', description: 'Organizations contributing funding, infrastructure or expertise. Recognition is agreed before publication.', status: 'preview' }
  ]
});
