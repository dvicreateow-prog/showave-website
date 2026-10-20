/* Researched user guidance, not connector capabilities. Availability comes only
   from the local accounts service. Restream sources describe Restream behavior;
   they do not grant SHOWAVE access to another product's integrations. */
(function (root) {
  'use strict';
  const help = (slug) => 'https://support.restream.io/en/articles/' + slug;
  const guide = (connection, details, start, url, source = 'Restream workflow reference', checked = '2026-09-08') =>
    Object.freeze({ connection, details, start, url, source, checked });
  const guides = Object.freeze({
    youtube: guide('Choose your Google account in the same browser and approve access. An existing Google sign-in can be reused; no SHOWAVE account or copied stream key is needed. Live streaming must be enabled on your YouTube channel.',
      'SHOWAVE supports title, description, category, privacy and supported broadcast settings. Portrait is an orientation choice for the same channel.',
      'The connected workflow creates a broadcast, provisions and binds its incoming stream, then starts sending media. YouTube must receive the stream before viewers can watch.',
      'https://developers.google.com/youtube/v3/live/getting-started', 'YouTube Live API'),
    twitch: guide('Authorize your Twitch account using the device sign-in flow.',
      'SHOWAVE supports title, category, tags and language. Twitch does not provide a separate stream-description field in this workflow.',
      'SHOWAVE retrieves your ingest details and starts the encoder. The platform receives the stream before it becomes viewable.',
      'https://dev.twitch.tv/docs/video-broadcast/', 'Twitch broadcasting documentation'),
    kick: guide('Authorize your Kick account. SHOWAVE publisher setup must be complete before sign-in is available.',
      'SHOWAVE supports title, category and tags. Set a valid title and category before starting. Description and language cannot be updated through this connector.',
      'The account connector retrieves the channel ingest details and applies supported settings before sending media. This connector still needs live-account verification.',
      'https://docs.kick.com/apis/channels', 'Kick Channels API'),
    facebook: guide('Restream supports account authorization and selection of managed Pages. Facebook Groups use a separate manual Live Producer workflow.',
      'Page and Profile events can have titles and descriptions. Permissions and live eligibility depend on the selected destination.',
      'SHOWAVE needs its own Facebook integration. Group RTMP streams still need Live Producer setup and a final start action, or scheduled automatic start.',
      help('6158091-stream-to-a-facebook-page')),
    linkedin: guide('Restream authorizes a LinkedIn profile or managed Page with Live access.',
      'LinkedIn streaming uses an event. Configure the event title, description, visibility and schedule before publishing.',
      'SHOWAVE needs an approved LinkedIn integration. A manual RTMP event has separate ingest preparation and a Go live action in LinkedIn.',
      'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/live-video/', 'LinkedIn Live API'),
    instagram: guide('The documented Live Producer workflow uses a fresh stream key for each broadcast.',
      'Set the title and audience in Instagram. Account eligibility is checked by Instagram.',
      'Send the encoder preview, click Go live on Instagram, and end the broadcast there first. A verified automatic SHOWAVE login workflow is not available.',
      help('6379108-stream-to-instagram')),
    x: guide('Restream offers X account authorization. The separate manual Producer workflow uses a Source URL and key.',
      'Restream supports a stream title; it does not provide a separate X description field. Live eligibility is controlled by X.',
      'SHOWAVE needs its own verified X integration. A manual Source requires a Broadcast and a final start action in Producer.',
      'https://help.x.com/en/using-x/x-live', 'X live broadcasting help', '2026-09-10'),
    tiktok: guide('Restream offers TikTok login and authorization for accounts approved for its LIVE integration.',
      'Choose the title and topic before starting. Restream documents a 32-byte title limit and no title or thumbnail changes during a live stream.',
      'SHOWAVE needs verified TikTok LIVE integration access. Ordinary TikTok sign-in alone does not establish permission to create a LIVE broadcast.',
      help('6721574-stream-to-tiktok'), 'Restream workflow reference', '2026-09-10'),
    rumble: guide('Restream offers Rumble authorization and profile or channel selection. Rumble also provides static stream keys.',
      'A Rumble static-key template supplies the broadcast details used when a stream is created automatically.',
      'With an assigned static-key template, starting the encoder can create the broadcast. SHOWAVE account login remains a separate integration to implement.',
      'https://rumble.support/help/static-stream-key-instructions', 'Rumble static stream keys'),
    'custom-rtmp': guide('Configure an RTMP or RTMPS receiving endpoint in Custom Output.',
      'The receiving service controls key lifetime, titles, privacy and stream limits. A generic endpoint cannot promise automatic metadata updates.',
      'SHOWAVE sends media through its local relay. Some receiving services require a separate publish action after the preview arrives.',
      help('369436-stream-to-a-custom-rtmp-channel')),
    'custom-whip': guide('Configure a WHIP endpoint and its required authorization in Custom Output.',
      'WHIP carries WebRTC media. Titles and other publishing details depend on the receiving service.',
      'SHOWAVE negotiates a WebRTC session with the endpoint. Receiver support and network connectivity still need verification.',
      'https://www.rfc-editor.org/rfc/rfc9725.html', 'WHIP protocol specification'),
    'custom-srt': guide('SRT requires an SRT sender and a compatible receiver.',
      'The receiver supplies connection mode, address and any stream ID or passphrase.',
      'SRT output is not implemented in this SHOWAVE build.',
      'https://github.com/Haivision/srt', 'Haivision SRT project'),
    'custom-hls': guide('HLS delivery requires a packager and a compatible publishing or storage service.',
      'An HLS playback address is not an RTMP ingest address.',
      'Custom HLS publishing is not implemented in this SHOWAVE build.',
      'https://developer.apple.com/streaming/', 'Apple HTTP Live Streaming'),
    'embed-player': guide('An embedded player displays a hosted stream on a website.',
      'A public playback service, access controls and hosting are required.',
      'The public Embed Player service is not implemented in this SHOWAVE build.'),
    slack: guide('Restream connects a Slack workspace and selects a channel for a webinar.',
      'Slack receives a webinar event and player. Private channels require the integration to be added to that channel.',
      'SHOWAVE needs a hosted webinar service and Slack integration. Slack is not a generic RTMP destination.',
      help('16012759-stream-to-slack')),
    mux: guide('Create a Mux live stream using the Mux dashboard or API, then obtain its stream key.',
      'Mux supports reusable keys. Its API credentials belong in a trusted service, and usage can incur Mux charges.',
      'SHOWAVE can send to an explicitly configured custom endpoint; a Mux account connector has not been implemented.',
      help('11464405-stream-to-mux')),
    patreon: guide('For an eligible published Patreon page, create a Live and select Other streaming service to obtain this session\'s server URL and key.',
      'Set the title and member or paid-tier audience on Patreon. SHOWAVE has no automatic Patreon account or audience adapter.',
      'Send a preview, then press Start Live on Patreon. Stop the encoder first, then end the Live on Patreon. New sessions require new credentials.',
      'https://support.patreon.com/hc/en-us/articles/35597591801997-Going-Live-on-Patreon-through-OBS',
      'Patreon external-encoder guide and Live FAQ', '2026-09-10'),
    vimeo: guide('A Vimeo plan with live events is required. Select an event, choose Use an external encoder, and copy its RTMP/RTMPS URL and stream key into Custom Output.',
      'Manage event details and audience on Vimeo. This manual route does not provide SHOWAVE account login, metadata updates or chat.',
      'Use Vimeo\'s preview setting to check the incoming feed, then press Go Live there. Encoder connection is not proof that the event is visible to viewers.',
      'https://help.vimeo.com/hc/en-us/articles/35016852545297-How-to-stream-a-live-event-over-RTMP-RTMPS',
      'Vimeo external-encoder guide', '2026-09-10'),
    'amazon-ivs': guide('Create an Amazon IVS low-latency channel and obtain its ingest endpoint and stream key. Use its RTMPS connection in Custom Output, not its playback URL.',
      'AWS channel configuration, access and playback stay managed in AWS; charges may apply. Amazon IVS is separate from Amazon Live shopping streams.',
      'Start the encoder and verify the channel\'s playback. Stopping media can take up to 30 seconds to disconnect. SHOWAVE does not provide an AWS account or player-hosting adapter.',
      'https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/getting-started-set-up-streaming.html',
      'Amazon IVS streaming guide', '2026-09-10'),
    'zoom-incoming': guide('Zoom Events or Webinars Plus and a host/co-host are required. Enable Incoming livestream for the intended session and copy its stream URL/key into Custom Output.',
      'Use Zoom desktop 6.2.0 or later. This sends media into an eligible webinar, not a normal Zoom Meeting; audience and event details stay in Zoom.',
      'Start the webinar and encoder, then More > Incoming live stream > Send live in Zoom. Stop sending removes that feed; ending the webinar is a separate action.',
      'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0077038',
      'Zoom incoming RTMP webinar guide', '2026-09-10'),
    substack: guide('Eligible creators create a new live video from their Substack publication dashboard and generate a key.',
      'Set the title and audience in Substack. Availability depends on the creator account.',
      'The documented Restream workflow uses a manual stream key. SHOWAVE has no verified account connector yet.',
      help('11421657-stream-to-substack')),
    'amazon-live': guide('Eligible creators select an external camera in Amazon Live Creator and obtain the ingest details.',
      'Set the title, thumbnail and featured products in the Creator app.',
      'Send a preview, then press Go Live in the Creator app. End there before stopping the encoder.',
      help('6959322-stream-to-amazon-live')),
    telegram: guide('A group or channel administrator opens the external-stream option in Telegram to obtain its ingest details.',
      'The broadcast uses the group or channel title. Each group or channel has its own key.',
      'After sending media, click Start Streaming in Telegram. End the video chat there before stopping the encoder.',
      help('6061986-stream-to-telegram')),
    mixcloud: guide('The documented workflow uses a reusable stream key from a Mixcloud Pro account.',
      'Set the title, description and tags on Mixcloud before streaming.',
      'SHOWAVE has no account connector yet. A saved custom output can send media; stream metadata still belongs in Mixcloud.',
      help('4179344-stream-to-mixcloud')),
    steam: guide('Configure Steam broadcasting and obtain its RTMP token and server address.',
      'Choose the correct game App ID and viewer access in Steam. Account and game eligibility apply.',
      'The documented workflow uses an encoder connection. SHOWAVE account login is not implemented.',
      help('1846325-stream-to-steam')),
    dailymotion: guide('Restream offers Dailymotion sign-in. Live streaming requires an eligible paid Dailymotion plan.',
      'Restream exposes a per-stream category setting.',
      'SHOWAVE needs its own account and live-event integration before offering automatic setup.',
      help('73033-stream-to-dailymotion')),
    'picarto-tv': guide('Restream redirects to Picarto authorization to connect an account.',
      'Restream exposes the category in the channel settings.',
      'SHOWAVE needs its own Picarto connector before offering account login.',
      help('73178-stream-to-picarto')),
    'nimo-tv': guide('The documented workflow obtains a server URL and stream key from the Nimo TV Streamer Dashboard.',
      'Set the title and category in Nimo TV before starting.',
      'SHOWAVE has no verified Nimo TV account connector. The reference describes manual encoder setup.',
      help('3112026-stream-to-nimo-tv')),
    'fc2-live': guide('The documented workflow enables broadcast software on FC2 Live and obtains the channel URL and key.',
      'Set the title, description, preview image and category in FC2 Live.',
      'SHOWAVE has no verified FC2 account connector. The reference describes manual encoder setup.',
      help('1553568-stream-to-fc2-live')),
    'vaughn-live': guide('The documented workflow uses a Vaughn Live server, channel URL and stream key.',
      'Set the title and category on Vaughn Live.',
      'SHOWAVE has no verified Vaughn Live account connector. The reference describes manual encoder setup.',
      help('73107-stream-to-vaughn-live')),
    soop: guide('SOOP documents obtaining the server URL and stream name/key in External Device Broadcast Settings.',
      'Configure the stream details in the SOOP dashboard.',
      'Configure an external encoder and start sending media. A public SHOWAVE account-login integration has not been verified.',
      'https://sooplive.helpshift.com/hc/en/3-soop/faq/180-how-can-i-stream-on-soop-using-a-mac/', 'SOOP external-encoder guide'),
    'naver-tv': guide('Naver TV has announced service closure on September 30, 2026. New signups and channel creation ended September 3.',
      'Existing creators should follow Naver’s closure and content guidance.',
      'New channel onboarding is unavailable. SHOWAVE has no Naver TV account connector.',
      'https://help.naver.com/service/17223/contents/25393?lang=ko&osType=COMMONOS', 'Naver TV closure notice'),
    'breakers-tv': guide('Legacy Breakers.TV help describes an RTMP URL and key under My Account → Edit Channel.',
      'The help page is undated. Current onboarding, key lifetime and automatic metadata are unverified.',
      'SHOWAVE has no verified account connector. The legacy instructions do not establish present streaming availability.',
      'https://breakers.tv/howto', 'Breakers.TV legacy help'),
    kakaotv: guide('kakaoTV ended service on June 30, 2026.',
      'Its older encoder setup instructions are obsolete.',
      'This destination is unavailable and cannot be connected in SHOWAVE.',
      'https://kakao-tv.tistory.com/323', 'kakaoTV closure announcement'),
    douyu: guide('Douyu documents an OBS helper with QR login and start/stop controls, plus a companion-app broadcast-code workflow.',
      'The documented setup depends on Douyu’s own helper or companion and broadcaster eligibility.',
      'This does not establish an account API for SHOWAVE. A verified SHOWAVE connector still needs implementation.',
      'https://www.douyu.com/cms/detail/gong/18192.shtml', 'Douyu OBS helper guide'),
    huya: guide('Huya’s guide enables remote broadcasting in the personal center, then obtains a push address and key for an encoder.',
      'Select the content category and prepare the broadcast in Huya.',
      'Complete the platform-side start setup, then send encoder media. Key reuse and a SHOWAVE account API are unverified.',
      'https://help.huya.com/355', 'Huya OBS guide'),
    'zhanqi-tv': guide('Legacy Zhanqi help describes obtaining an RTMP address and broadcast code from the channel’s Live controls.',
      'Current onboarding, key lifetime and automatic metadata are unverified.',
      'The guide describes external encoder setup. SHOWAVE has no verified account connector, and current service availability needs confirmation.',
      'https://m.zhanqi.tv/common/toolfaq.html', 'Zhanqi legacy encoder help'),
    bilibili: guide('Bilibili documents obtaining a push address and key from its live-stream settings for external encoders.',
      'Choose the title, cover and content section on Bilibili. Eligibility and available tools depend on the account.',
      'SHOWAVE has no verified Bilibili account connector; automatic login and publishing remain unverified.',
      'https://live.bilibili.com/blackboard/era/u4EPvXpDYUMv7hYJ.html', 'Bilibili creator broadcasting guide')
  });
  function get(id) {
    return Object.prototype.hasOwnProperty.call(guides, id) ? guides[id] : Object.freeze({
      connection: 'A current account-login and publishing workflow has not been verified for this platform.',
      details: 'Automatic metadata, eligibility and key lifetime are not confirmed.',
      start: 'SHOWAVE must verify the platform documentation and implement its connector before enabling automatic connection.',
      source: '', url: '', checked: '', unverified: true
    });
  }
  // Catalogue ids are stable document identities, unlike translated display names.
  const platformIds = Object.freeze({
    5:'youtube', 37:'facebook', 59:'linkedin', 1:'twitch', 75:'kick', 73:'instagram',
    71:'x', 67:'tiktok', 77:'rumble', 29:'custom-rtmp', 78:'custom-srt', 81:'custom-whip',
    82:'custom-hls', 83:'embed-player', 76:'slack', 80:'mux', 84:'patreon', 79:'substack',
    74:'amazon-live', 72:'telegram', 68:'mixcloud', 40:'soop', 61:'naver-tv', 10:'vaughn-live',
    49:'steam', 66:'dailymotion', 60:'nimo-tv', 24:'picarto-tv', 48:'fc2-live',
    26:'breakers-tv', 43:'bilibili', 70:'nonolive', 62:'kakaotv', 15:'mlg',
    16:'douyu', 51:'huya', 58:'zhanqi-tv'
  });
  // These are named instructions for the EXISTING Custom RTMP route, not new
  // platform/account identities. Never allocate synthetic ids in Restream's
  // numeric namespace or mark a preset ready independently of catalogue rows.
  const manualRoutes = Object.freeze([
    Object.freeze({ id:'vimeo', label:'Vimeo', search:'Custom RTMP RTMPS', platformId:29,
      action:'rtmp', badge:'MANUAL', mark:'Vimeo', color:'#1ab7ea' }),
    Object.freeze({ id:'amazon-ivs', label:'Amazon IVS', search:'AWS Interactive Video Service Custom RTMP RTMPS', platformId:29,
      action:'rtmp', badge:'MANUAL', mark:'Amazon IVS', color:'#ff9900' }),
    Object.freeze({ id:'zoom-incoming', label:'Zoom incoming stream', search:'Zoom Events Webinars Plus Custom RTMP RTMPS', platformId:29,
      action:'rtmp', badge:'MANUAL', mark:'Zoom', color:'#2d8cff' })
  ]);
  function manualPresets() { return manualRoutes; }
  function forPlatform(platformId) { return get(platformIds[platformId]); }
  function resolve(rows, platformId, connectionKind) {
    const matching = platformId == null || String(platformId).trim() === '' ? []
      : (Array.isArray(rows) ? rows : []).filter(r => r && r.platformId != null &&
          String(r.platformId) === String(platformId));
    const channels = matching.filter(r => r.kind === 'channel');
    const login = matching.find(r => r.kind === 'connect');
    const blocked = matching.find(r => r.kind === 'blocked');
    // A manually stored key must never inherit an account connector's guarantees.
    // An explicit platform refusal also overrides stale ready account rows.
    const account = !blocked && connectionKind !== 'key' && (login || channels[0]);
    const target = account || blocked || matching.find(r => r.kind === 'key' || r.kind === 'whip');
    const clean = value => value != null && !/^(undefined|null)$/i.test(String(value).trim())
      ? String(value).trim() : '';
    const label = matching.map(r => clean(r.platform) || (r.kind !== 'channel' && clean(r.displayName)))
      .find(Boolean) || 'Platform';
    const kind = account ? 'account' : target ? target.kind : 'unknown';
    return { kind, label, target: target || null, channels,
      note: clean(target && (target.error || target.reason || target.note)) };
  }
  root.OpenLivePlatformWorkflows = Object.freeze({ get, forPlatform, resolve, manualPresets });
})(typeof window === 'undefined' ? globalThis : window);
