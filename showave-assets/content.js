/* SHOWAVE website articles. Original copy grounded in the product's own guides:
 * showave-brand.js; DESKTOP-WORKFLOW.md; PRESENT-WORKFLOW.md;
 * SCENE-AUTHORING.md; BROADCAST-MEDIA-WORKFLOW.md; GSL5.md;
 * arena-plugin-catalog.js; devserver.py; CLONE-PROGRAM.md;
 * mobile/android/README.md; distribution/docs/{iOS-README,TEST-FEEDBACK}.md.
 * Public destinations and release guarantees are never inferred from local builds.
 */
(function installShowaveContent(window) {
  'use strict';

  const articles = {
    'getting-started': {
      category: 'Manuals',
      title: 'Your first show starts here.',
      intro: 'Install the preview, bring your own media, and learn the path from preparation to the audience picture.',
      body: `
        <h2>1. Choose your preview</h2>
        <p>Find the latest available Windows preview in <a href="/downloads">Downloads</a>. The Linux / Android preview notes cover <strong>0.1.0-preview.6</strong>; check Downloads for current installer availability. On Windows x64, run the SHOWAVE Live Preview installer and open the application from its desktop or Start menu shortcut. Close an older preview before updating. The Windows build includes the players needed for supported PowerPoint, PDF, images, audio and video; a Microsoft Office installation is not required.</p>
        <p>Linux has a portable x64 testing build. Android has an offline interface and media-player review APK with a smaller set of capabilities. Read the <a href="/manuals?article=release-notes">platform notes</a> before choosing a build.</p>
        <h2>2. Bring one original file</h2>
        <p>Start with a small image, video, PDF or modern PowerPoint deck you know well. On desktop, drop it onto an empty Clip slot or use the file picker. Wait for the first real picture and loading indicator to complete. Loading prepares the content; it does not trigger the Show.</p>
        <p>Your selected originals stay at their source location. Playback uses temporary session resources. Reopening the preview requires selecting or reconnecting those files.</p>
        <h2>3. Rehearse the presentation</h2>
        <p>For a presentation, open <strong>Present</strong> and choose <strong>Use selected Clip</strong> to pin it. Use First, Previous, Next, Last or the slide selector. Presenter Preview prepares a slide; <strong>Take slide</strong> commits it to the pinned feed. <strong>Send to Show</strong> triggers the pinned Clip. Check the composed Show monitor to see the audience picture.</p>
        <p>Supported modern PowerPoint formats are .pptx, .pptm, .ppsx and .ppsm. Legacy .ppt/.pps files, macros and some advanced slide features are unsupported. Compare your actual deck before using it in a production.</p>
        <h2>4. Build a broadcast scene</h2>
        <p>Ready to combine sources? Follow the <a href="/manuals?article=broadcast-guide">Broadcast guide</a> to build in Preview and publish to Programme with Cut/Fade. Test your actual devices, sound and destination as a separate rehearsal.</p>`
    },
    'broadcast-guide': {
      category: 'Manuals',
      title: 'Build it in Preview. Take it to Programme.',
      intro: 'A practical guide to composing your first SHOWAVE Broadcast scene and controlling the picture you take live.',
      body: `
        <h2>Start with an empty canvas</h2>
        <p>In the Scenes rail, choose <strong>New → Blank</strong> and name the scene. A Free canvas starts ready for your sources. Choose <strong>Add Source</strong> to bring in camera, screen, media, a presentation or SHOWAVE Live. Device capture depends on the permissions and capabilities of your platform.</p>
        <p>For a deck or document, choose <strong>Add Source → Present · PowerPoint / PDF</strong>. These players open supported originals directly; there is no need to export every slide as an image.</p>
        <h2>Arrange the picture</h2>
        <p>Select a picture source to move, resize or rotate it. <strong>Input Selection</strong> crops the source region; <strong>Output Transformation</strong> places that region in your scene. Fit keeps the whole selected picture visible. Fill crops it to fill the output rectangle. Stretch fills that rectangle without preserving proportions.</p>
        <p>Use <strong>Arrange</strong> for layouts such as Solo, Split, PiP or Grid. Adjust the draft, then choose <strong>Apply to Preview</strong>. Artwork, captions and other scene tools also prepare changes in Preview.</p>
        <h2>Make the Take deliberate</h2>
        <p>Review your scene and audio mixer, then choose <strong>Cut/Fade</strong> to take it to Programme. Scene selection and editing do not take automatically. Programme keeps its last taken scene configuration while you continue preparing Preview.</p>
        <p>After a Take, media and presentation controls can address either the Preview player or its independent Programme player. Select <strong>Programme</strong> when you intend to advance an on-air slide or control its playback. Stopping a shared physical capture still affects every scene using that device.</p>
        <h2>Finish with a rehearsal</h2>
        <p>Check the Programme picture, mixer levels and selected output. Taking a scene to Programme does not itself start a broadcast to an online platform; destinations and streaming have their own controls and account requirements. Reconnect live devices and original files after a session ends. The Android review build does not provide desktop capture or streaming services.</p>`
    },
    'media-present': {
      category: 'Manuals',
      title: 'Clips, media and presentations.',
      intro: 'Load an original file, prepare a slide and control the audience feed.',
      body: `
        <h2 id="load">Load one original</h2>
        <p>In <strong>SHOWAVE Live</strong>, drop a familiar image, supported video, audio, PDF or modern PowerPoint file onto an empty Clip slot. The loading indicator follows preparation; wait for the first real picture before rehearsing. Loading a Clip does not trigger it. The original stays at its source location.</p>
        <p>PowerPoint formats .pptx, .pptm, .ppsx and .ppsm use SHOWAVE’s independent player. Microsoft Office is not required. Legacy .ppt/.pps files and macros are unsupported. Review missing-font, layout and codec warnings with your actual file.</p>
        <h2 id="present">Prepare, then take a slide</h2>
        <p>Open <strong>Present → Use selected Clip</strong> to pin the intended deck. Changing the selected Clip afterward does not change that pin. First, Previous, Next, Last and the slide selector prepare navigation. <strong>Take slide</strong> commits the prepared slide to the pinned feed; <strong>Send to Show</strong> triggers the pinned Clip. Use the composed Show monitor to check the audience picture.</p>
        <h2 id="broadcast-player">Control a Broadcast player</h2>
        <p>In <strong>SHOWAVE Broadcast</strong>, choose <strong>Add Source → Present · PowerPoint / PDF</strong>, or add another supported media source. Its player controls select <strong>Preview</strong> or the independent <strong>Programme</strong> player after a Take. Choose Programme when advancing an on-air deck; changing Preview does not advance that deck.</p>
        <p>PowerPoint embedded audio is currently unavailable in the Live Show mixer. Broadcast routes available presentation media through its own mixer. Check the real meters and listening route rather than assuming a visible video also has audio. See the <a href="/manuals?article=broadcast-guide">Broadcast guide</a> for composing and taking a scene.</p>`
    },
    'mapping-output': {
      category: 'Manuals',
      title: 'Plan the picture and its output.',
      intro: 'Understand source placement, SHOWAVE Map, Grid Tool and Chaser before testing a display.',
      body: `
        <h2 id="source-placement">Start with the source</h2>
        <p>In Broadcast, select a picture source. <strong>Input Selection</strong> chooses the rectangular part of the original to sample. <strong>Output Transformation</strong> places that picture inside the scene. Fit keeps the selection visible, Fill crops to fill the rectangle, and Stretch changes its proportions. These changes prepare Preview; <strong>Cut/Fade</strong> takes the scene to Programme.</p>
        <h2 id="map">Map the audience picture</h2>
        <p><strong>SHOWAVE Map</strong> is the output-mapping workspace. Its Input Selection and Output Transformation stages separate what a slice samples from where it appears. Start with one screen and a simple slice before building a larger arrangement. Check the workspace’s connection and frame indicators when a picture is missing; an editor view alone does not confirm that a physical display is receiving output.</p>
        <h2 id="grid">Plan an LED wall</h2>
        <p><strong>SHOWAVE Grid Tool</strong> provides Setup, Routing, Signal, Power and Pixelmapper views. Enter your cabinet dimensions, pixel dimensions, columns and rows first. Then inspect the cable route and port limits against the actual sending hardware. Power planning uses the values you supply; a diagram does not measure a connected rig.</p>
        <h2 id="chaser">Give slices a rhythm</h2>
        <p><strong>SHOWAVE Chaser</strong> separates Chase, Pixel Map and Envelopes. Start with a small selection of slices, preview a short sequence, then check its direction and steps per beat. Use the Map link when checking the relationship between that sequence and the output layout.</p>
        <h2 id="rehearsal">Finish at the real display</h2>
        <p>Rehearse the intended resolution, screen arrangement and content on your actual equipment. Confirm the output destination, then inspect the audience picture. Check projector alignment, network delivery and LED processor settings on the actual rig. Follow any unavailable or session-only notice shown by the current build.</p>`
    },
    'creative-control': {
      category: 'Manuals',
      title: 'Create and sequence with SHOWAVE.',
      intro: 'Find the role of Timeline, Forge, Encode and GSL5 Lighting Library, with current preview limits.',
      body: `
        <h2 id="timeline">Sequence a show with Timeline</h2>
        <p><strong>SHOWAVE Timeline</strong> organizes tracks and timed triggers. Begin with the Internal clock and a short range. Use <strong>Add Trigger</strong> to choose a target from the current show, then rehearse Play, Pause, Stop and GO with that small sequence. A Wait for Go point holds progress for an operator decision.</p>
        <p>Keep SHOWAVE Live open for authoritative show output. If Timeline reports <strong>Local preview</strong>, its transport is previewing locally rather than confirming live execution. External clock choices require their actual input and platform support; a selected clock is not proof that timecode is arriving.</p>
        <h2 id="forge">Explore a visual patch in Forge</h2>
        <p><strong>SHOWAVE Forge</strong> is a node-creation preview. Browse or search the library, place nodes, and explore the patch layout. Its current monitor is a demonstration rather than a compiled result of your graph. Native plug-in compilation is not implemented in this preview.</p>
        <h2 id="encode">Prepare media in Encode</h2>
        <p><strong>SHOWAVE Encode</strong> lets you inspect clips, choose trim and conversion settings, and organize a queue. The current preview cannot save or export converted files. DXV, Motion JPEG and ProRes need a native encoder adapter.</p>
        <h2 id="lighting">Build a lighting rehearsal</h2>
        <p><strong>GSL5 Lighting Library</strong> has its own fixture personalities, patch, programmer, cues and playback. Begin in Preview with a small patch. Its starter personalities are vendor-neutral examples; match a real fixture’s profile and addresses before equipment testing. Selecting or editing a fixture does not arm physical output. <strong>ARM OUTPUT</strong> and its confirmation are separate actions inside GSL5, and Blackout stays latched until explicitly released.</p>
        <p>The <a href="/manuals?article=product-family">software family overview</a> explains how these workspaces fit together. Available native services vary by platform and build.</p>`
    },
    troubleshooting: {
      category: 'Manuals',
      title: 'Rehearse, diagnose and report.',
      intro: 'Check the selected file, active workspace, output and platform before sharing a reproducible issue.',
      body: `
        <h2 id="picture">A Clip is loaded, but there is no audience picture</h2>
        <p>Wait for the first decoded picture and read any loading error. Check that the intended Clip was triggered and its Layer and Show picture gates are enabled. With a presentation, confirm the pinned Clip, committed Feed slide and composed Show monitor. Reconnect the original file if the session no longer has access to it.</p>
        <h2 id="programme">Preview changed, but Programme did not</h2>
        <p>This is the normal preparation boundary in Broadcast. Check the Preview scene and mixer, then use <strong>Cut/Fade</strong> deliberately. To control a presentation or video already on Programme, select its Programme player. Taking a scene does not by itself start an online stream.</p>
        <h2 id="audio">There is a picture, but no sound</h2>
        <p>Check the selected source’s audio state and actual mixer meters. Local listening mute or volume is separate from the Programme mix. Check Audio Preferences and the chosen output device; browser playback may need a user gesture. Imported PowerPoint in Live currently has no embedded-audio mixer route.</p>
        <h2 id="availability">A device, output or save action is unavailable</h2>
        <p>Read the visible permission or capability message for that build. Camera and screen selection need the platform’s real permission. Streaming destinations need working service support and credentials. Check any session-only restriction, missing native adapter or offline-platform message, and review <a href="/downloads">current platform availability</a> before comparing two devices.</p>
        <h2 id="report">Make the next test reproducible</h2>
        <p>Record the SHOWAVE version, operating system, workspace, source format and smallest steps that reproduce the result. Include the expected picture or behavior and the exact visible error. A cropped screenshot can help; remove stream keys, account tokens, private notes and personal paths. Share through your existing project review channel or prepare a <a href="/community#community-dashboard">local contribution draft</a>.</p>`
    },
    'product-family': {
      category: 'Journal',
      title: 'One show. A family of instruments.',
      intro: 'Meet the connected SHOWAVE workspaces, from the first cue to the final output.',
      body: `
        <h2>The show and its audience</h2>
        <p id="live"><strong>SHOWAVE Live</strong> is the live show-control workspace for layers, clips, cues and creative control.</p><p id="broadcast"><strong>SHOWAVE Broadcast</strong> brings scenes, sources, Preview and Programme into a dedicated production surface. Together, they connect the work on your stage with the picture you prepare for your audience.</p>
        <h2>Shape the picture</h2>
        <p id="map"><strong>SHOWAVE Map</strong> focuses on output mapping.</p>
        <p id="grid"><strong>SHOWAVE Grid Tool</strong> supports LED wall planning and signal mapping.</p>
        <p id="chaser"><strong>SHOWAVE Chaser</strong> handles slice sequencing and pixel maps. Each gives a different production job a focused workspace.</p>
        <h2>Create, prepare and sequence</h2>
        <p id="forge"><strong>SHOWAVE Forge</strong> is the node-creation workspace. Explore nodes and visual patch layouts. The current monitor shows a demonstration; native plug-in compilation is not implemented in this preview.</p>
        <p id="encode"><strong>SHOWAVE Encode</strong> is the media-conversion and preparation workspace. Preview clips, adjust trim and conversion settings, and manage the queue. The current session-only build does not save or export converted files. DXV, Motion JPEG and ProRes encoding require a native adapter.</p>
        <p id="timeline"><strong>SHOWAVE Timeline</strong> organizes timecoded show automation. These names describe their roles in the product family; available tools and native capabilities vary in the preview.</p>
        <h2 id="gsl5">Give lighting its own home</h2>
        <p><strong>GSL5 Lighting Library</strong> is a linked, independent lighting product with its own fixture personalities, patch, programmer, cues, playback and output controls. Its starter personalities are vendor-neutral examples. A real rig needs appropriate fixture profiles and equipment testing. Physical output is explicitly armed inside GSL5.</p>
        <h2>A preview you can explore</h2>
        <p>The family is under active development. A visible control or workspace does not mean every native integration is available on every platform. Start with the <a href="/manuals?article=getting-started">first-show guide</a> and check the <a href="/manuals?article=release-notes">current platform notes</a> for your build.</p>`
    },
    plugins: {
      category: 'Developers',
      title: 'Make room for your next idea.',
      intro: 'Explore the creative tools in the preview and the direction of the SHOWAVE extension ecosystem.',
      body: `
        <h2>Create with the tools already inside</h2>
        <p>SHOWAVE includes browser-rendered effects and generators. In Broadcast, open <strong>Effects &amp; Generators</strong>, select a picture source, and choose an available effect. The source inspector lets you adjust its settings, bypass it or remove it. Changes prepare the Preview scene; Cut/Fade takes the result to Programme.</p>
        <p>SHOWAVE Forge provides the family’s node-creation workspace for exploring visual patch layouts. Its monitor currently shows a demonstration, and native plug-in compilation is not implemented in this preview.</p>
        <h2>Understand the plug-in catalogue</h2>
        <p>The current catalogue records native plug-in identities and distinguishes them from SHOWAVE’s browser equivalents. A catalogue entry is not an installed native plug-in. The preview does not provide a general native FFGL or VST host, and a browser equivalent does not run the original binary.</p>
        <h2>A marketplace is still ahead</h2>
        <p>A public SHOWAVE plug-in marketplace, submission portal and stable extension SDK are not available yet. This page will become the starting point for extension formats, compatibility guidance and publishing instructions when those services are ready.</p>
        <p>For now, useful contributions start with a clear creative workflow: the source you want to transform, the controls you need, and the result you expect. Read <a href="/manuals?article=contribute">how to prepare a contribution</a>.</p>`
    },
    api: {
      category: 'Developers',
      title: 'Connect to the local production system.',
      intro: 'A first look at SHOWAVE’s existing local helper endpoints and the boundaries of the current integration surface.',
      body: `
        <h2>Local services, current capabilities</h2>
        <p>The desktop application uses a local helper for media, lighting, accounts and relay services. These routes support the application’s own workflows. They are not a hosted public API or a promise of a stable external SDK.</p>
        <p>Develop against a controlled local test session. The packaged desktop application manages its own helper address and session access; do not assume a fixed port or expose the helper to the public internet.</p>
        <h2>Begin with read-only status</h2>
        <p>The current helper implements these GET routes. Availability depends on the running build, its session permissions and the installed service capabilities.</p>
        <ul>
          <li><code>/api/media/status</code> — original-file selection availability and session-storage behavior.</li>
          <li><code>/api/lighting/status</code> — the lighting runtime’s current status.</li>
          <li><code>/api/lighting/adapters</code> — available lighting network adapters.</li>
          <li><code>/api/relay/status</code> — the relay runtime’s current state.</li>
          <li><code>/api/relay/capability</code> — relay capabilities detected on this machine.</li>
          <li><code>/api/accounts/status</code> — account-service status, subject to local access checks.</li>
        </ul>
        <h2>Read the result before taking action</h2>
        <p>An endpoint can report that a service is unavailable. A configured account is not proof that a stream is live, and a listed adapter is not proof that equipment is receiving output. Keep readiness checks and operator controls in the workflow.</p>
        <p>This is a preview integration overview. Authentication details, mutation contracts, compatibility guarantees and a public API reference still need a dedicated developer release. The Android review APK has no desktop helper; desktop-only API requests are unavailable there.</p>
        <h2>Looking for agent control?</h2>
        <p>The planned SHOWAVE MCP service is a separate part of the roadmap. Read the <a href="/manuals?article=mcp">MCP status</a> before designing an agent integration.</p>`
    },
    mcp: {
      category: 'Developers',
      title: 'A future control surface for agents.',
      intro: 'SHOWAVE MCP is planned. The aim is useful production assistance with clear operator control.',
      body: `
        <h2>Current status: planned</h2>
        <p>A dedicated SHOWAVE Broadcast MCP server is not included in the current preview. There is no SHOWAVE MCP installer, public endpoint or connection configuration to use today.</p>
        <h2>What the roadmap describes</h2>
        <p>The proposed service would connect an agent to local production information: capability checks, account and destination status, broadcast preparation and diagnosis. These are design directions, not currently available MCP tools.</p>
        <p>The design places operator consent around actions that affect a real broadcast. Going live should remain a deliberate production decision, with capability and readiness checks before any action reaches an output.</p>
        <h2>What you can explore now</h2>
        <p>SHOWAVE already has local helper services used by the desktop application. The <a href="/manuals?article=api">local integration overview</a> describes selected existing status endpoints and their limits. Those services are distinct from the planned MCP interface.</p>
        <h2>Help define a useful assistant</h2>
        <p>Prepare a concrete example: the production task, what an assistant should be allowed to inspect, the action it would propose, and the point where an operator should decide. The <a href="/manuals?article=contribute">contribution guide</a> explains how to turn that idea into useful feedback.</p>`
    },
    'open-source': {
      category: 'Open development',
      title: 'Free and open source. Built together.',
      intro: 'SHOWAVE’s commitment is creative production software that everyone can use, study, improve and share.',
      body: `
        <h2>Software belongs in the hands of its community</h2>
        <p>Our direction is fully free and open source. Downloads and participation do not depend on making a donation. Useful work can come from an independent artist, a volunteer, a studio or a sponsored developer. The same review standards apply to everyone.</p>
        <h2 id="source">The current source home</h2>
        <p>Use <a data-community-link="repository">dvicreateow-prog/openlive on GitHub</a> for now. <strong>Repository access is currently required.</strong> The <a data-community-link="issues">issue tracker</a> and <a data-community-link="pullRequests">pull requests</a> live with that repository. The website cannot grant access; contributors without access can prepare and export a <a href="/community#community-dashboard">local contribution draft</a>.</p>
        <h2 id="license">Publishing the open-source release</h2>
        <p>The project-wide license and a source release accessible to everyone still need to be published. This page records the project’s commitment; it does not apply Blender’s license to SHOWAVE. Existing third-party code, artwork, fonts and packages retain their own licenses and attribution requirements.</p>
        <p>For the open-source release, publish the license alongside the source, identify included third-party material, document build steps and provide source references for released binaries. The current preview installers remain the existing build snapshots.</p>
        <h2>One project. Shared stewardship.</h2>
        <p>Follow the <a href="/manuals?article=contribute">contribution workflow</a>, explore <a href="/foundation">project stewardship</a> or support the <a href="/fund">development fund</a>. Support helps people do the work; it does not purchase ownership or control over project decisions.</p>
        <h2>Our reference</h2>
        <p>Blender’s <a href="https://www.blender.org/about/license/" target="_blank" rel="noopener noreferrer">software freedoms</a> and <a href="https://developer.blender.org/docs/handbook/contributing/" target="_blank" rel="noopener noreferrer">contribution handbook</a> inform this approach. SHOWAVE is an independent project by Afro Unity Group, with no Blender affiliation or endorsement.</p>`
    },
    governance: {
      category: 'Open development',
      title: 'Steward the project. Share the decisions.',
      intro: 'An operating model for the people building SHOWAVE: clear responsibilities, visible decisions and review based on the work.',
      body: `
        <h2>Creator, maintainers and contributors</h2>
        <p>Godrick Sankofa is SHOWAVE’s creator. Afro Unity Group is the project identity behind the software. The creator establishes direction; maintainers coordinate a production area and review changes; contributors bring code, design, testing, translation, documentation and practical experience.</p>
        <p>These are the responsibilities we are organizing around. A named maintainer directory and formal governance charter still need publication. We do not list unappointed boards, module owners or a registered SHOWAVE foundation.</p>
        <h2>How a decision moves forward</h2>
        <ol><li>Describe the problem and discuss significant changes before implementation.</li><li>Identify the affected production areas and ask the relevant reviewers to participate.</li><li>Compare the proposal with user needs, compatibility and the roadmap; record the rationale.</li><li>Review a focused change with reproducible tests, documentation and a release note where needed.</li><li>Resolve disagreement through further evidence and maintainer review. Record the final decision and unresolved concerns with the change.</li></ol>
        <h2>Funding and project direction</h2>
        <p>Sponsors may share feedback and offer resources. Sponsorship does not grant approval rights, exclusive features or a guaranteed place on the roadmap. Maintainers should declare relevant funding relationships and invite another reviewer where a conflict exists.</p>
        <p>Visit <a href="/foundation">project stewardship</a>, <a href="/roadmap">the roadmap</a> and the <a href="/manuals?article=contribute">contribution guide</a>. This model takes inspiration from <a href="https://developer.blender.org/docs/handbook/organization/modules/" target="_blank" rel="noopener noreferrer">Blender’s module organization</a>, adapted to SHOWAVE’s current stage.</p>`
    },
    funding: {
      category: 'Support',
      title: 'Fund the work. Keep it open.',
      intro: 'A sustainable development fund supports people, maintenance and the shared tools that make the project useful.',
      body: `
        <h2>What support is for</h2>
        <p>Our funding priorities are core development and bug fixes, production testing, documentation and translation, accessibility, and the infrastructure needed to develop and distribute the software. These are priorities, not claimed spending figures or funded commitments.</p>
        <h2>Ways to help</h2>
        <p>Individuals can make an optional donation. Organizations can prepare a sponsorship proposal or offer equipment, hosting, testing time and expertise. <a href="/fund">Explore the development fund</a> and the <a href="/manuals?article=sponsorship">sponsorship guide</a>. Recurring memberships and published sponsorship prices are not configured yet.</p>
        <h2>Independence and transparency</h2>
        <p>Support does not purchase equity, financial returns or control of the roadmap. The intended reporting practice is to publish received support, spending by purpose and progress on supported work, while respecting contributors’ choices about recognition. No financial reports or verified fundraising totals have been published here yet.</p>
        <p>The current payment destination is <strong>Novus Foundation Uganda</strong> on Flutterwave. It is an existing external donation page; a dedicated SHOWAVE recipient is planned. Read <a href="/manuals?article=donate">the recipient and payment details</a> before continuing.</p>
        <p>Our independence principles draw on <a href="https://fund.blender.org/funding-policy/" target="_blank" rel="noopener noreferrer">Blender’s funding policy</a>. SHOWAVE manages its own project and support arrangements.</p>`
    },
    sponsorship: {
      category: 'Support',
      title: 'Help sustain the tools you rely on.',
      intro: 'Corporate sponsorship and practical partnerships support the shared project while keeping its direction in the hands of maintainers and contributors.',
      body: `
        <h2>Start with a useful proposal</h2>
        <ol><li>Introduce your organization and the production workflows you care about.</li><li>Describe the funding, equipment, infrastructure or expertise you can offer.</li><li>State the intended duration and any conditions or recognition requests.</li><li>Discuss scope with the project team before making a commitment.</li></ol>
        <p>Prepare a proposal in the <a href="/community?draft=support#community-dashboard">local support workspace</a>. Share it through an existing project contact or, if you have access, the <a data-community-link="issues">current repository</a>. The website does not submit proposals to a shared inbox.</p>
        <h2>Recognition with consent</h2>
        <p>Agreed recognition may include a name or logo and a description of the supported work. Public sponsor records require verification and consent. Preview badges are concepts, not purchased membership levels; no prices, confirmed sponsors or benefits are implied.</p>
        <h2>Support does not buy governance</h2>
        <p>Sponsorship is support, not an equity investment. It promises no ownership, financial return, exclusive software access or roadmap control. Paid development proposals follow the same discussion, review and release standards as other work.</p>
        <p>Read <a href="/manuals?article=funding">funding and reporting principles</a> and <a href="/manuals?article=governance">how project decisions work</a>. Blender’s <a href="https://fund.blender.org/corporate-memberships/" target="_blank" rel="noopener noreferrer">corporate membership model</a> is a reference for sustainable support, not a SHOWAVE pricing schedule.</p>`
    },
    community: {
      category: 'Community',
      title: 'Built around the people behind the show.',
      intro: 'Build a free and open-source production project through code, design, testing, documentation, translation and shared experience.',
      body: `
        <h2>Find your first contribution</h2><p>Visit <a href="/community">Get involved</a> to choose a contribution track, understand the review workflow and prepare a draft. Code is one route; testing, design, translation, teaching and documentation are equally useful. Named and anonymous participation are welcome.</p><h2>Development channels</h2>
        <p>For this first phase, development lives in the temporary <a data-community-link="repository">dvicreateow-prog/openlive repository</a>. This repository is private: GitHub access is required to view its code, issues and pull requests. The website does not grant repository access.</p>
        <p>A public forum and community invitation link have not been configured yet. You can prepare local contribution drafts here while the shared community service takes shape.</p>
        <h2>Growing toward Afro Unity</h2>
        <p>The intended future home is the <a data-community-link="futureHome">Afro Unity GitHub account</a>. The repository migration is being planned; the current development links remain under their existing owner until a transfer is complete.</p>
        <h2>Take part through a rehearsal</h2>
        <p>The current preview is designed for review and feedback. Try a small production task with your own content: load a deck, prepare a scene, take it to Programme, or explore a lighting personality in preview. Record where the workflow helps and where it gets in the way.</p>
        <p>Test the capabilities documented for your platform. The <a href="/manuals?article=getting-started">first-show guide</a> and <a href="/manuals?article=broadcast-guide">Broadcast guide</a> offer practical starting points.</p>
        <h2>Make the next conversation useful</h2>
        <p>Keep a short note with your build version, device, task, steps, expected result and actual result. If you received the preview from the SHOWAVE team, share it through the channel used to arrange your review. This site does not submit feedback automatically.</p>
        <p>Have an idea for a tutorial, workflow or extension? Read <a href="/manuals?article=contribute">the contribution guide</a> and prepare something another creator can understand and try.</p>`
    },
    contribute: {
      category: 'Community',
      title: 'From a useful idea to a reviewed contribution.',
      intro: 'Discuss the need, make a focused change, test it together and share the result. Every contribution helps build a free and open-source SHOWAVE.',
      body: `
        <h2>1. Choose an area and discuss the need</h2>
        <p>Start with a workspace you use: Live and media, Broadcast, mapping and LED planning, sequencing, lighting, or shared documentation and accessibility. A small bug fix or documentation correction can become a focused pull request. Discuss a new feature or a change spanning several workspaces before doing substantial implementation.</p>
        <h2>2. Build a focused change</h2>
        <p>With repository access, read its setup and contribution instructions, create a branch and keep one problem per change. Explain the user need, the approach and any tradeoffs. Keep refactoring separate when it would make the review harder. Contribute only material you have the right to share; check the source and license status in <a href="/manuals?article=open-source">our open-source guide</a>.</p>
        <h2>3. Review, test and document</h2>
        <p>Open a pull request with steps to reproduce the original problem, evidence of the new behavior and relevant test results. Invite review from the people responsible for the affected area. Respond to feedback, check related workflows and update the user documentation. Reviews should explain requested changes and keep the contributor informed.</p>
        <h2>4. Merge, credit and release</h2>
        <p>A maintainer approves and integrates reviewed work. Release preparation includes regression testing, updated notes and contributor recognition by consent. A merged change is not automatically part of an existing installer; wait for a build that includes it. Follow the <a href="/roadmap">development roadmap</a> and <a href="/manuals?article=release-notes">release notes</a>.</p>
        <h2>Test a workflow you know</h2>
        <p>Use the preview with non-sensitive content you are permitted to share. Import a familiar image, video, PDF or PowerPoint file. Check playback, the audience picture and the controls you rely on. Describe one issue at a time so the team can reproduce it.</p>
        <h2>Prepare an actionable report</h2>
        <ol>
          <li>Record the SHOWAVE build, operating system and device model.</li>
          <li>Name the workspace, panel and control involved.</li>
          <li>Write the smallest sequence that reproduces the problem.</li>
          <li>Describe the expected result and what actually happened, including visible error text.</li>
          <li>Note how often it happens and whether it blocks the task.</li>
        </ol>
        <p>A cropped screenshot or short recording can help. Remove stream keys, account tokens, private notes and personal file paths before sharing. A file’s format and approximate size are often enough to begin an investigation.</p>
        <h2>Contribute knowledge and ideas</h2>
        <p>Documentation corrections, accessibility observations, repeatable test cases and clearly explained creative workflows are all useful. For a feature request, describe the production problem and the result you need rather than only naming a control.</p>
        <h2>Prepare your contribution</h2><p>The <a href="/community#community-dashboard">community workspace</a> lets you save and export a contribution draft on this device. Drafts are not sent or counted as verified contributions. Choose named or anonymous recognition when preparing your record.</p><h2>Use the current development channels</h2>
        <p>Contributors with repository access can use the temporary <a data-community-link="issues">GitHub issue tracker</a> for reproducible reports and <a data-community-link="pullRequests">pull requests</a> for proposed changes. Follow the repository’s current contribution guidance. The private repository is not accessible to every visitor.</p>
        <p>This website does not upload drafts automatically or grant repository access. Reviewers can export a draft and share it through their existing team channel. A public contributor portal remains ahead.</p>`
    },
    donate: {
      category: 'Support',
      title: 'Support the next wave.',
      intro: 'Help make room for better tools, clearer documentation and more time with real production workflows.',
      body: `
        <div class="donation-card">
          <span class="eyebrow">DONATIONS VIA FLUTTERWAVE</span>
          <h2>Back the next wave.</h2>
          <p>Thank you for supporting the people behind the project. For this first chapter, we are using an existing donation page.</p>
          <p class="donation-recipient" data-donation-recipient></p>
          <a class="button button-orange" data-flutterwave-checkout hidden target="_blank" rel="noopener noreferrer">Continue to Flutterwave <span aria-hidden="true">↗</span></a>
          <p class="donation-pending" data-donation-pending><span class="status-dot"></span> Flutterwave donations are coming soon.</p>
          <small data-donation-note>The SHOWAVE payment link is being connected. Donations are not being collected yet.</small>
        </div>
        <h2>Support the work today</h2>
        <p>Time and experience can make a useful contribution. Rehearse a small workflow in the preview, identify a confusing step in a guide, or prepare a clear example of a feature that would help your production.</p>
        <p>The <a href="/manuals?article=contribute">contribution guide</a> explains how to prepare useful feedback. If you are already reviewing a build with the team, use your existing review channel to share it.</p>
        <h2>How donations will work</h2>
        <p>Continue to Flutterwave to choose your amount and complete the payment. Our current link goes to <strong>Novus Foundation Uganda</strong>; a dedicated SHOWAVE donation page is planned. Check the recipient and details on that checkout before confirming. SHOWAVE does not collect payment details on this website.</p>`
    },
    'release-notes': {
      category: 'Journal',
      title: 'Inside the SHOWAVE preview.',
      intro: 'Check Downloads for the latest available Windows preview. These notes introduce the preview workflows and platform limits, including Linux / Android 0.1.0-preview.6.',
      body: `
        <h2>Windows x64 · desktop preview</h2>
        <p>The Windows package includes the SHOWAVE interface, local helper, presentation players and presenter support. Supported PowerPoint and PDF playback does not require Microsoft Office. The installer adds SHOWAVE Live Preview with desktop and Start menu shortcuts.</p>
        <p>This is an unsigned testing build without an automatic updater. Playback and wrapper checks have been run; actual capture equipment, clickers, streaming destinations and long-duration productions need their own rehearsal.</p>
        <h2>Linux x64 · portable preview</h2>
        <p>The Linux archive includes its browser engine and Python runtime. Extract it and launch <code>./run-showave.sh</code> from a supported graphical x86_64 Linux environment. Required desktop libraries must be supplied by the Linux distribution.</p>
        <p>Local helper tests passed under Linux. A graphical Linux desktop, capture devices and streaming hardware have not yet been validated for this build.</p>
        <h2>Android 8+ · interface and player review</h2>
        <p>The Android APK provides the offline Show and Broadcast interface plus original-file image, supported audio/video, PDF and PowerPoint players. It is intended for review, preferably on a landscape tablet with a current Android System WebView.</p>
        <p>Desktop broadcasting services, camera and microphone capture, virtual camera and DMX/MIDI/USB integrations are unavailable in this APK. Package checks and desktop Chromium checks of its web resources passed; an actual Android device or emulator has not yet been tested.</p>
        <h2>iPhone, iPad and macOS</h2>
        <p>No native iOS installer or macOS build is available in this preview set. The review kit’s iOS folder contains delivery and testing instructions only.</p>
        <h2>Before your first review</h2>
        <p>Use the platform version listed in <a href="/downloads">Downloads</a>; the earlier preview.1 package is superseded. Check the notes supplied with your platform build and keep a record of what you tested. Start with <a href="/manuals?article=getting-started">one original file and one production task</a>, then share a reproducible report through your existing team review channel.</p>
        <h2>Planned for the next Windows preview</h2>
        <p>Updates since preview.14 are being tested now: Grid Tool screen cards with mixed cabinet sizes, a cabinet library and signal plans, a shared vector calibration checker, millimetre and pixel layouts for Grid screens in Mapper, Whole / Cabinet / Section chase targets, a Multiview window, a Go Live button that starts every ready destination, and the Afro Unity globe on Home. The preview.14 installer doesn’t include them. See <a href="/downloads#whats-new">what’s coming</a> for more.</p>`
    }
  };

  Object.values(articles).forEach(Object.freeze);
  window.SHOWAVE_CONTENT = Object.freeze(articles);
})(window);
