/* ===========================================================================
   arena-help.js - Arena's own contextual help, and a map from it to this clone.
   ---------------------------------------------------------------------------
   Source: C:\Program Files\Resolume Arena\docs\help\English.xml (102,234 bytes,
   Arena 7.27.1). 411 <help> entries plus one <default>, embedded verbatim here
   because the page cannot read Program Files at runtime. Titles and text are
   Resolume's, character for character, typos included ("crossafder", "Set
   Valuee", "shapped", "Clear All of theLayers"). They are load-bearing for
   matching and they are not ours to correct.

   WHY THE SHAPE IS WHAT IT IS
   The XML's `components` attribute is a SELECTOR, not a name:

       components  ::= alternative ( '|' alternative )*
       alternative ::= token ( ' ' token )*     <- an ancestor chain, CHILD FIRST
       token       ::= "'" name "'" | "''" | "'*'"

   `''` is an anonymous ancestor, `'*'` is any one ancestor. The parent chain is
   the only thing that disambiguates: 'speedSlider' is Speed, but
   'speedSlider' 'compositionControlComponent' is Master Speed and
   'speedSlider' 'layerGroupControlComponent' is Group Speed. Three entries carry
   the chain 'volumeSlider' 'Layer Control Component', all titled Audio Volume,
   and they are told apart only by a further propertyHeader chain: one says
   "the layer", another "the composition". So this file indexes by CHAIN, never
   by leaf token and never by title. Flattening the chain - which
   tools/extract-components.py does - merges controls that Arena keeps apart.

   Lookup is first-match-wins, top to bottom. That is inferred from the file's
   own tail block (lines 1471-1650), which re-declares ~30 earlier entries with
   their original selector PLUS a deep properties-panel chain, byte-identical
   title and text. Those duplicated leading selectors are only reachable if the
   scan stops at the first hit. Arena was not run to confirm this.

   DEFECTS IN THE SHIPPED FILE, carried here rather than hidden
   - 5 entries have unbalanced quotes (`repaired:true` marks them, `raw` keeps
     the original attribute). Four are recoverable unambiguously; the fifth,
     'velocityValueLabel', needed an inferred repair - see the note on it.
   - 13 entries ship <text/> empty. forElement still returns them; a consumer
     should fall back to the title rather than print "no help available".
   - 22 entries use `||`; one, 'Group' | | '*' 'Group', has a genuinely empty
     alternative. Whether Arena's parser treats `||` differently from `|` is
     unknown from the file alone, so empty alternatives are simply dropped.

   VERIFIED COUNTS (measured, not quoted from the repo's own docs, which
   disagree with each other and with the file - FILE-FORMATS.md says 234
   entries, DECODE-REPORT.md and panel-kit.js say 402 components,
   BUTTON-INVENTORY.md says 484/384):
       411 <help> entries        (grep -c "<help " and ElementTree agree)
       386 unique titles         (24 titles repeat; "Audio Volume" appears 3x)
       512 unique tokens         (the familiar 484 comes from a regex that both
                                  drops 30 real tokens and invents 2 fake ones
                                  out of the pipe separators)
       661 chains across the 411 entries

     window.ArenaHelp.forComponent(name)  - by token, chain array, or "a>b>c"
     window.ArenaHelp.forElement(el)      - walk up the DOM, null if unknown
     window.ArenaHelp.INDEX               - all 411, source order
     window.ArenaHelp.UNMATCHED           - entries with no clone control
     window.ArenaHelp.audit()             - coverage against the live DOM

   forElement returns null rather than a near-miss. #cSolo and the clone's
   first/last-column buttons have no entry in the 411 - there is no
   composition-level solo component in Arena's help at all - and .comp-row has
   no container rule, so they resolve to null instead of borrowing someone
   else's copy. #tPlay and #tStop likewise have no entry of their own, but they
   sit inside #transport and so inherit its BPM Clock entry, the same way a
   nameless child inherits its nearest named ancestor in Arena.
   =========================================================================== */
(() => {
'use strict';

/* ===== DEFAULT ===== the <default> node, shown when the cursor is over
   nothing recognised. Not one of the 411. */
const DEFAULT = {"title": "Help", "text": "Move your mouse over the interface element that you would like more info about."};

/* ===== INDEX ===== the 411 <help> entries, source order preserved.
   chains: alternatives, each an ancestor chain read child-first.
   raw/repaired: present only on the 5 entries whose quoting is broken. */
const INDEX = [
{"chains": [["Clear All Layers Button"]], "title": "Clear All Layers", "text": "Eject ALL the clips. From ALL the layers."},
{"chains": [["Bypass All Layers Button"]], "title": "Master Bypass", "text": "Makes all output go black."},
{"chains": [["selectCompositionEventButton"]], "title": "Composition", "text": "Previews the composition in the preview window, and brings the composition panel to focus."},
{"chains": [["compositionMasterSlider"]], "title": "Master Opacity", "text": "Fade all output to black."},
{"chains": [["speedSlider", "compositionControlComponent"]], "title": "Master Speed", "text": "Speed all the clips up or down."},
{"chains": [["forwardButton", "compositionControlComponent"]], "title": "Global Play Forward", "text": "Set all clips currently playing to play forward."},
{"chains": [["backwardsButton", "compositionControlComponent"]], "title": "Global Play Backward", "text": "Set all clips currently playing to play backward."},
{"chains": [["pauseButton", "compositionControlComponent"]], "title": "Global Pause", "text": "Pause all clips currently playing."},
{"chains": [["randomButton", "compositionControlComponent"]], "title": "Global Play Random", "text": "Set all clips currently playing to jump to random frames."},
{"chains": [["connectPrevColumn"]], "title": "Trigger Previous Column", "text": "Step backwards through the columns."},
{"chains": [["connectNextColumn"]], "title": "Trigger Next Column", "text": "Step forwards through the columns."},
{"chains": [["vuBar"], ["fftBarsComponent"]], "title": "Equalizer", "text": "To fill up this empty space we added a FFT visualizer, allowing you to see the audio. But how can you actually 'see' audio? Can you then also 'hear' video? Is our planet just a fly on the back of a giant bear?"},
{"chains": [["columnTriggerComponent", "groupedComponent", "", "columnsViewport"]], "title": "Column Trigger", "text": "Start all clips in this column at once."},
{"chains": [["clearLayerButton"]], "title": "Clear Layer", "text": "Clear the playing clip from this layer."},
{"chains": [["soloLayerButton"]], "title": "Layer Solo", "text": "Show this layer, the whole layer and nothing but this layer."},
{"chains": [["bypassLayerButton"]], "title": "Bypass Layer", "text": "Make this layer invisible."},
{"chains": [["blendModeComboboxLabel", "blendModeCombobox", "Layer Control Component"]], "title": "Select Layer Blend Mode", "text": "Select one of the many, many blend modes."},
{"chains": [["volumeSlider", "Layer Control Component"]], "title": "Audio Volume", "text": "Adjust the volume of the layer."},
{"chains": [["masterSlider", "Layer Control Component"]], "title": "Layer Master", "text": "Adjust the opacity and volume of the layer in one fell swoop."},
{"chains": [["opacitySlider", "Layer Control Component"]], "title": "Video Opacity", "text": "Adjust the opacity of the layer. Depending on the blend mode this slider will have different visual results."},
{"chains": [["clipTriggerComponent", "Layer Control Component"]], "title": "Current Clip", "text": "This clip is currently playing in the layer. Click to adjust its properties in the Clip Properties panel."},
{"chains": [["speedSlider"], ["n", "speedSlider"]], "title": "Speed", "text": "Set the playback speed of the timeline. 1 is the normal rate, 2 is twice as fast."},
{"chains": [["timelineSlider", "*", "Layer Control Component"]], "title": "Timeline", "text": "This timeline indicates the playback position of the clip. Grab the playhead to scrub."},
{"chains": [["", "clipTriggerComponent", "groupedComponent"]], "title": "Clip", "text": "Trigger this clip. Go for it! It's the right clip for this moment."},
{"chains": [["clipTriggerComponent", "groupedComponent"]], "title": "Clip Handle", "text": "Click the name of the clip to preview it and to drag the clip to a different position in the deck."},
{"chains": [["relocateButton"]], "title": "Relocate Clip", "text": "Click to find this file again somewhere in the darkest depths of your computer."},
{"chains": [["Layer Control Component", "groupedComponent"]], "title": "Select and Preview Layer", "text": "Click to select, configure and preview this layer."},
{"chains": [["groupAButton"], ["groupBButton"]], "title": "Assign to Crossfader Bus", "text": "This will assign this group or layer to the corresponding bus of the crossfader."},
{"chains": [["AVsliderTrans T"], ["Duration", "transitionParamsComponent"], ["*", "spinner", "paramBaseComponent", "Duration", "transitionParamsComponent"]], "title": "Transition Time", "text": "Control the duration of the transition between 0-10 sec."},
{"chains": [["transitionBlendModeButton"], ["Blend Mode", "transitionMixerParamsComponent"], ["", "", "paramBaseComponent", "Blend Mode", "transitionMixerParamsComponent"]], "title": "Select Transition", "text": "Select a transition from the list, or go for the random option."},
{"chains": [["connectPrevClip"]], "title": "Trigger Previous Clip", "text": "Step backwards through the clips."},
{"chains": [["connectNextClip"]], "title": "Trigger Next Clip", "text": "Step forwards through the clips."},
{"chains": [["layerGroupControlComponent", "groupedComponent"]], "title": "Select and Preview Group", "text": "Click to select, configure and preview this group."},
{"chains": [["clearLayerGroupButton"]], "title": "Clear Group", "text": "Clear all the playing clips from this group."},
{"chains": [["soloLayerGroupButton"]], "title": "Group Solo", "text": "Show this group, the whole group and nothing but this group."},
{"chains": [["bypassLayerGroupButton"]], "title": "Bypass Group", "text": "Make this entire group invisible."},
{"chains": [["speedSlider", "layerGroupControlComponent"]], "title": "Group Speed", "text": "Set the playback speed of all clips in the group."},
{"chains": [["forwardsButton", "layerGroupControlComponent"]], "title": "Group Play Forward", "text": "Set all clips in this group to play forward."},
{"chains": [["backwardsButton", "layerGroupControlComponent"]], "title": "Group Play Backward", "text": "Set all clips in this group to play backward."},
{"chains": [["pauseButton", "layerGroupControlComponent"]], "title": "Group Pause", "text": "Pause all clips in this group."},
{"chains": [["randomButton", "layerGroupControlComponent"]], "title": "Group Play Random", "text": "Set all clips in this group to jump to random frames."},
{"chains": [["connectPrevColumn", "layerGroupControlComponent"]], "title": "Trigger Previous Group Column", "text": "Step backwards through the columns in this group."},
{"chains": [["connectNextColumn", "layerGroupControlComponent"]], "title": "Trigger Next Group Column", "text": "Step forwards through the columns in this group."},
{"chains": [["columnTriggerComponent", "groupedComponent", "groupedComponent", "", "clipsAndGroupsViewport"]], "title": "Group Column Trigger", "text": "Start all clips in this group column at once."},
{"chains": [["crossFaderSlider"]], "title": "Crossfader", "text": "First assign layers to bus A and B of the crossfader and then move the fader left to right, right to left *wicka* *wicka*"},
{"chains": [["fadeToAButton"], ["fadeToBButton"]], "title": "Fade to Bus", "text": "Click to switch the crossfader to this bus. The behaviour can be changed in the composition panel."},
{"chains": [["", "", "", "", "", "LayersAndClips"]], "title": "Decks", "text": "Decks contain all your clips. A composition can contain multiple decks. Decks are like your records, and your composition is your record bag."},
{"chains": [["*", "", "", "", "", "", "LayersAndClips"]], "title": "Deck", "text": "Switch to this deck."},
{"chains": [["selectPrevDeckButton"]], "title": "Select Previous Deck", "text": "Step backwards through the decks."},
{"chains": [["selectNextDeckButton"]], "title": "Select Next Deck", "text": "Step forwards through the decks."},
{"chains": [["barHighlightComponent"]], "title": "Beat Indicator", "text": "A visual representation of the beat of the music. 4 beats to a measure and flashes a yellow outline every 4 measures. Now dance!"},
{"chains": [["linkToggle"]], "title": "Toggle Link", "text": "This will let Resolume join or leave available Ableton Link sessions."},
{"chains": [["toolbarTempoComponent"]], "title": "BPM Clock", "text": "The Beats Per Minute (BPM) clock can be used to run everything in Resolume to the beat of the music."},
{"chains": [["bpmValueLabel"]], "title": "BPM Value", "text": "The current Beats per Minute."},
{"chains": [["bpmIncButton"], ["bpmDecButton"]], "title": "BPM Adjust", "text": "Adjust the BPM with single increments."},
{"chains": [["bpmPullButton"], ["bpmPushButton"]], "title": "BPM Nudge Up / Down", "text": "Nudge the BPM up or down temporarily. The nudge percentage can be set in the Preferences."},
{"chains": [["bpmDivideButton"], ["bpmMultiplyButton"]], "title": "BPM Divide / Multiply", "text": "Quickly half or double the current BPM."},
{"chains": [["bpmTapButton"]], "title": "BPM Tapper", "text": "Tap along to the music to set the BPM. Click at least 2 times, click 4 times or more for more accurate results."},
{"chains": [["bpmResyncButton"]], "title": "Re-Synchronize BPM clock", "text": "Resets the BPM clock to the first bar. Use this to re-align the BPM clock."},
{"chains": [["bpmPauseButton"]], "title": "Pause BPM clock", "text": "Pause the BPM clock."},
{"chains": [["metronomeButton"]], "title": "Metronome", "text": "Tick tock goes the click clock."},
{"chains": [["smpteLabel"]], "title": "SMPTE", "text": "SMPTE can be used to synchronize video playback to an external clock."},
{"chains": [["ToolbarSMPTEComponent"]], "title": "SMPTE Input", "text": "Resolume Arena has two SMPTE inputs for dual deck wielding DJ action."},
{"chains": [["SMPTEInputLabel1"], ["SMPTEInputLabel2"]], "title": "SMPTE In", "text": "Current timecode of the incoming SMPTE signal."},
{"chains": [["smpteDelayCompensationSlider"], ["smpteDelayCompensationSlider1"], ["*", "smpteDelayCompensationSlider"], ["*", "smpteDelayCompensationSlider1"], ["delayLabel"], ["delayLabel2"]], "title": "SMPTE Input Delay Compensation", "text": "Allows for an offset in frames to compensate for any delays in the incoming SMPTE signal."},
{"chains": [["fftLabelComponent"], ["FFT Gain"]], "title": "FFT Gain", "text": "Adjust the master gain for FFT input. Use this to boost the level of the incoming audio signal."},
{"chains": [["recordButton"]], "title": "Record", "text": "Record the current video output to disk. Click to start recording, click again to stop and the recorded clip is added to the deck, ready to be used again."},
{"chains": [["monitor", "Output Monitor"], ["Output Monitor"]], "title": "Monitors", "text": "These monitors can be used to keep track of what's going on. The Output Monitor previews the main mix. The Preview Monitor can be used to preview a layer, group or file before its sent to the mix."},
{"chains": [["menuButton", "Output Monitor"]], "title": "Monitor Setup", "text": "Click to change the arrangement of the monitors."},
{"chains": [["*", "panelMonitorComponent"], ["foldComponentHeader", "groupedComponent"], ["monitor", "groupedComponent"]], "title": "Panel Monitor", "text": "A live preview of what's currently selected in this panel."},
{"chains": [["*", "dashboardComponent"], ["dashboardComponent"], ["*", "paramBaseComponent", "dashboardComponent"]], "title": "Dashboard", "text": "The Dashboard gives you quick access to parameters you change a lot. Grab a parameter by it's name and drop it onto one of the dials to link it. You can drop more parameters on one dial to control multiple parameters at once."},
{"chains": [["*", "commonParamsComponent"], ["commonParamsComponent"]], "title": "Common", "text": "Here you can adjust properties that affect both the audio and video playing in this panel."},
{"chains": [["*", "audioParamsComponent"], ["audioParamsComponent"]], "title": "Audio", "text": "Control the audio for this panel."},
{"chains": [["*", "videoParamsComponent"], ["videoParamsComponent"], ["*", "*", "videoParamsComponent"]], "title": "Video", "text": "Control the video for this panel."},
{"chains": [["*", "crossFaderParamsComponent"], ["crossFaderParamsComponent"], ["*", "*", "crossFaderParamsComponent"]], "title": "Crossfader", "text": "Adjust the behaviour of the crossafder."},
{"chains": [["renderPassComponent"], ["*", "renderPassComponent"], ["*", "*", "renderPassComponent"], ["*", "groupedComponent", "", "renderPassComponent"]], "title": "Video Effects", "text": "Adjust the video properties of whatever is selected in this panel."},
{"chains": [["audioEffectComponent"], ["*", "audioEffectComponent"], ["*", "*", "audioEffectComponent"]], "title": "Audio Effects", "text": "Adjust the audio properties of whatever is selected in this panel."},
{"chains": [["uiButton", "audioEffectComponent"]], "title": "VST", "text": "Open the custom UI for this VST plugin."},
{"chains": [["PresetsButton"]], "title": "Presets", "text": "Manage your presets."},
{"chains": [["bypassButton"]], "title": "Bypass Effect", "text": "Disables the effect without removing it."},
{"chains": [["removeButton"]], "title": "Remove Effect", "text": ""},
{"chains": [["paramColorPickerComponent"], ["*", "paramColorPickerComponent"], ["*", "*", "*", "*", "paramColorComponent"], ["*", "*", "*", "*", "*", "paramColorPickerComponent"]], "title": "Color Picker", "text": "Select colors from the full spectrum, via HSB sliders, via RGB sliders or even from a Palette of your favorite swatches."},
{"chains": [["Composition"]], "title": "Composition Panel", "text": "All the info on your composition can be found here. Masks, effects, you name it. Everything you do here is applied on the whole composition."},
{"chains": [["nameLabel", "Composition"]], "title": "Composition Name", "text": "The name and resolution of the current comp."},
{"chains": [["menuButton", "", "Composition"]], "title": "Composition Menu", "text": "Open the composition menu."},
{"chains": [["Layer"], ["layerPropertiesComponent"], ["layerPropertiesHeaderComponent", "Layer"]], "title": "Active Layer Panel", "text": "All the info on the active layer can be found here. Masks, effects, you name it. Everything you do here is applied on the current layer."},
{"chains": [["nameLabel", "layerPropertiesHeaderComponent"]], "title": "Layer Name", "text": "The name of this layer. Click to change."},
{"chains": [["menuButton", "layerPropertiesHeaderComponent"]], "title": "Layer Menu", "text": "Open the layer menu."},
{"chains": [["foldComponentHeader", "layerAutoPilotComponent"], ["layerAutoPilotComponent"]], "title": "Auto Pilot", "text": "The Auto Pilot can be used to play back all the clips in a layer. How's about you let Resolume steer for a while, while you go for that well deserved drink?"},
{"chains": [["backwardsButton2", "layerAutoPilotComponent"]], "title": "Auto Pilot Play Backwards", "text": "Plays the clips in the current layer in reverse sequence."},
{"chains": [["forwardsButton2", "layerAutoPilotComponent"]], "title": "Auto Pilot Play Forwards", "text": "Plays the clips in the current layer in sequence."},
{"chains": [["pauseButton2", "layerAutoPilotComponent"]], "title": "Auto Pilot Pause", "text": "Turns off the Auto Pilot. You are back in command now."},
{"chains": [["randomButton2", "layerAutoPilotComponent"]], "title": "Auto Pilot Play Random", "text": "Plays the clips in the current layer in random order."},
{"chains": [["*", "transitionParamsComponent"]], "title": "Transition", "text": "Adjust the transition properties. These controls mirror the ones on the layer."},
{"chains": [["Group"], ["*", "Group"]], "title": "Active Group Panel", "text": "All the info on the active group can be found here. Masks, effects, you name it. Everything you do here is applied on the current group."},
{"chains": [["nameLabel", "", "Group"]], "title": "Group Name", "text": "The name of this group. Click to change."},
{"chains": [["menuButton", "", "Group"]], "title": "Group Menu", "text": "Open the group menu."},
{"chains": [["Clip"], ["", "SingleClipPropertiesComponent", "Clip"]], "title": "Active Clip Tab", "text": "All the info on the active clip can be found here. Masks, effects, you name it. Everything you do here is affects the currently selected clip."},
{"chains": [["nameLabel", "", "SingleClipPropertiesComponent", "Clip"]], "title": "Clip Name", "text": "Click here to change the name of the clip."},
{"chains": [["menuButton", "", "SingleClipPropertiesComponent", "Clip"]], "title": "Clip Menu", "text": "Open the clip menu."},
{"chains": [["transportTypeComboBoxLabel"]], "title": "Transport Mode", "text": "Select the timing your clip uses for play back. Timeline let you control the speed manually, BPM Sync matches the clip to the master BPM. On Arena you can also choose the SMPTE source your clip should listen to."},
{"chains": [["*", "clipProperties"], ["foldComponentHeader", "*", "clipProperties"]], "title": "Clip Transport Controls", "text": "Here you can control how your clip should play back. Forward, backward, quicker, slower, you decide."},
{"chains": [["timeLabelButton"]], "title": "Clip Time", "text": "Time in seconds of the current frame. CLick to switch to remaining time.", "raw": "'timeLabelButton", "repaired": true},
{"chains": [["paramSlider", "*", "clipProperties"]], "title": "Timeline", "text": "This timeline indicates the playback position of the clip. Grab the playhead to scrub. Move the in- and out-point to trim the clip."},
{"chains": [["*", "*", "clipTransportTimelineComponent"], ["*", "*", "*", "*", "*", "clipTransportTimelineComponent"], ["*", "*", "*", "*", "clipTransportTimelineComponent"]], "title": "Timeline Speed", "text": "Control how quickly this clip plays back."},
{"chains": [["*", "*", "clipTransportVideoComponent"], ["*", "*", "*", "clipTransportVideoComponent"], ["*", "*", "*", "*", "clipTransportVideoComponent"]], "title": "BPM Speed", "text": "Control how quickly this clip plays back, using BPM and Beats to decide the tempo."},
{"chains": [["", "groupedComponent", "clipTransportSMPTEComponent"], ["*", "", "groupedComponent", "clipTransportSMPTEComponent"]], "title": "Setup SMPTE Input", "text": "Quickly switch which SMPTE input this clip should listen to. Also you can adjust its offset here."},
{"chains": [["forwardButton"]], "title": "Play Forwards", "text": ""},
{"chains": [["backwardsButton"]], "title": "Play Backwards", "text": ""},
{"chains": [["pauseButton"]], "title": "Pause Playback", "text": ""},
{"chains": [["randomButton"]], "title": "Random Playback", "text": "Jumps to random places on the timeline. When the timeline is in BPM Sync mode, it will jump to a random beat and play, jump to a random beat and play, jump to a random beat and play."},
{"chains": [["loopButton"]], "title": "Loop", "text": "Starts the clip at the beginning when it has reached the end. Starts the clip at the beginning when it has reached the end. Starts the clip at the beginning when it has reached the end."},
{"chains": [["bounceButton"]], "title": "Bounce", "text": "Plays the timeline forwards, backwards, forwards, backwards, forwards, backwards, forwards, backwards, ..."},
{"chains": [["playOnceButton"]], "title": "Play Once", "text": "Plays the timeline once and then disappears."},
{"chains": [["playOnceAndHoldButton"]], "title": "Play Once and Hold", "text": "Plays the timeline once and then keeps the last frame on screen."},
{"chains": [["rewindButton"]], "title": "Restart", "text": "Plays the timeline from the beginning when it is triggered."},
{"chains": [["continueButton"]], "title": "Continue", "text": "Continues playback from the position it was left."},
{"chains": [["playRelativeButton"]], "title": "Relative", "text": "Continues playback from the position of the previous clip. Because why not eh?"},
{"chains": [["beatLooperComponent"], ["foldComponentHeader", "beatLooperComponent"], ["*", "beatLooperComponent", "clipProperties"]], "title": "BeatLoopr", "text": "Instantly loop the clip to a beat quantized length. This is fun fun fun!"},
{"chains": [["cuePointsComponent"], ["foldComponentHeader", "cuePointsComponent"]], "title": "Cue Points", "text": "Use these six cue points to jump to different positions in the clip. Press one of the small arrow shapped buttons so set a cue point. Use the corresponding button to jump to that cue point."},
{"chains": [["cueSetButton"]], "title": "Set Cue Point", "text": "Sets a cue point at the moment you press it. Use the bigger button right of it to jump to that position again."},
{"chains": [["cueJumpButton"]], "title": "Jump to Cue Point", "text": "Jumps to the position set by the small set cue point button on the left."},
{"chains": [["AudioTrackInfoComponent"]], "title": "Clip Audio", "text": "Info on the audio track of the active clip."},
{"chains": [["VideoTrackInfoComponent"]], "title": "Clip Video", "text": "Info on the video track of the active clip. Here you can find the codec, resolution, framerate and duration of the active clip. Drag a file onto this area to replace the video track, while keeping all the properties and effects in place."},
{"chains": [["removeButton", "AudioTrackInfoComponent"]], "title": "Remove Audio", "text": "Remove the audio from the clip."},
{"chains": [["removeButton", "VideoTrackInfoComponent"]], "title": "Remove Video", "text": "Remove the video from the clip."},
{"chains": [["scaleToFitButton"]], "title": "Maximize Video", "text": "Scale the video to the size of the composition."},
{"chains": [["colorsRButton"], ["colorsGButton"], ["colorsBButton"]], "title": "Toggle Color Channel", "text": "Switch the R, G and B color channels in the video on or off. Right click to see only this channel."},
{"chains": [["colorsAButton"]], "title": "Alpha Channel", "text": "If the video has an alpha channel you can use this button to switch it on or off."},
{"chains": [["Blend Mode", "videoMixerParamsComponent", "trackSettingsComponent"]], "title": "Override Layer Blend Mode", "text": "Using this dropdown, you can force a clip to always use a specific blend mode, regardless of what the layer is set to."},
{"chains": [["*", "renderPassGeneratorComponent"], ["*", "*", "renderPassGeneratorComponent"]], "title": "Generator Parameter", "text": "Adjust the look and feel of this generative source."},
{"chains": [["Duration", "groupedComponent"]], "title": "Duration", "text": "This is how long this clip will play when the autopilot is active. The time is set in seconds."},
{"chains": [["Input", "videoSettingsComponent"]], "title": "Video Router Input", "text": "Select the input for this Video Router. You can choose a specific layer, group or the result of the layers below the Router. Also you can select the Preview."},
{"chains": [["Input Opacity", "groupedComponent"]], "title": "Video Router Input Opacity", "text": "Choose whether or not this Router should take the opacity of its source into account. Basically this is a pre-fader / post-fader toggle."},
{"chains": [["Input Bypass/Solo", "groupedComponent"]], "title": "Video Router Bypass Solo", "text": "Choose whether or not this Router should take the bypass and solo switches of its source into account."},
{"chains": [["Alpha Type"]], "title": "Alpha Channel Interpretation", "text": "Choose how Resolume should interpret the alpha channel of this clip. Premultiplied is usually the way to go. If you see weird halos around your content, switch to Straight."},
{"chains": [["Servers", "videoSettingsComponent"], ["Syphon Servers", "videoSettingsComponent"]], "title": "Select Server", "text": "Available Servers will show up in this list. You can pick one from the list."},
{"chains": [["*", "videoSettingsComponent"]], "title": "Camera Input Settings", "text": "Here you can adjust settings for this particular live camera input. If the device supports it, the Video Format will automatically update itself to the correct setting."},
{"chains": [["*", "paramBaseComponent"]], "title": "Parameter", "text": "Right-click the name of this parameter to reset it. Grab the name of this parameter and drop it onto a dial on the dashboard to control this parameter with a dial. Click the black arrow to select one of the many parameter animation controls."},
{"chains": [["*", "spinner", "paramBaseComponent"]], "title": "Spinner Parameter", "text": "Hit the + and - buttons to change the parameter incrementally. Click and drag to change it witch coarser adjustments. Right click to reset to the default."},
{"chains": [["toggleButton", "paramBaseComponent"]], "title": "Toggle Parameter", "text": "Have you tried turning it off and on again?"},
{"chains": [["choiceButton1", "paramBaseComponent"], ["choiceButton2", "paramBaseComponent"], ["choiceButton3", "paramBaseComponent"], ["choiceButton4", "paramBaseComponent"], ["choiceButton5", "paramBaseComponent"]], "title": "Choice Parameter", "text": "This will let you set the control to various states."},
{"chains": [["paramSliderLabel", "paramSlider", "paramBaseComponent"], ["colorSliderLabel", "colorSlider", "paramBaseComponent"], ["", "", "paramBaseComponent"], ["spinnerLabel", "spinner", "paramBaseComponent"], ["colorDisplay", "paramColorComponent"]], "title": "Parameter Value", "text": "The actual value of this parameter, expressed in meaningful units where applicable. So rotation will be in degrees, scale in percentage, audio level in dBs etc."},
{"chains": [["paramSlider", "paramTimelineComponent", "paramBaseComponent"], ["paramTimelineComponent", "paramBaseComponent"]], "title": "Timeline Parameter Animation", "text": "Animate the parameter with a timeline, set the speed, loop, direction, etc."},
{"chains": [["paramRangeSlider", "paramLinkComponent", "paramBaseComponent"], ["speedDialsComboBoxLabel", "speedDialsComboBox", "paramLinkComponent", "paramBaseComponent"], ["linkRangeSliderText", "paramLinkComponent", "paramBaseComponent"], ["linkRangeSlider", "paramLinkComponent", "paramBaseComponent"]], "title": "Link to dashboard dial", "text": "The value of this parameter will be determined by the dial it is linked to. Note that one dial can be used to control multiple parameters! So you can control a parameter of a video effect AND an audio effect at the same time. Whuuuuut?"},
{"chains": [["parameterTimelineSliderBpm"], ["*", "ParamLinkBPMComponent", "paramBaseComponent"], ["*", "parameterBeatSpinner", "ParamLinkBPMComponent", "paramBaseComponent"], ["ParamLinkBPMComponent", "paramBaseComponent"]], "title": "BPM Parameter Animation", "text": "Animates the parameter synchronized to the global BPM clock."},
{"chains": [["invertToggleButton"], ["toggleButton", "parameterBaseComponent"]], "title": "Invert Value", "text": "Maps the value in reverse. Example: A low input value will result in a high parameter value."},
{"chains": [["ParamLinkFFTBasicComponent"], ["*", "ParamLinkFFTBasicComponent", "paramBaseComponent"], ["*", "ParamLinkFFTExtendedComponent", "paramBaseComponent", "paramBaseComponent"], ["ParamLinkFFTExtendedComponent"]], "title": "FFT Parameter", "text": "Animate this paramater to the peak value of the selected audio source. Bouncy bouncy to the bass."},
{"chains": [["", "paramEnvelopeComponent", "paramBaseComponent"], ["", "", "paramEnvelopeComponent", "paramBaseComponent"]], "title": "Envelope", "text": "Remap the output of this parameter using your own custom curves. Double click to add and remove keyframes, right click each keyframe to change its interpolation."},
{"chains": [["searchBar"], ["*", "searchBar"], ["clearFilterButton"]], "title": "Search", "text": "Start typing to narrow down the list of results to the entered text. Hit CTRL-? to quickly jump to the search box."},
{"chains": [["Slices"], ["", "", "", "treeView", "Slices"], ["treeView", "Slices"]], "title": "Slice Browser", "text": "All the slices currently active in the Advanced Output show up here. You can drag them onto the Composition, Group, Layer or Clip panels to create effects that use these Slices as input. Drag whole screens for quick results or individual slices for finer selection."},
{"chains": [["Files"], ["", "Files"], ["", "", "", "", "Files"]], "title": "File Browser", "text": "Drag files from this browser to one of the clips in the deck to load it. Double click a file to preview it in the preview monitor."},
{"chains": [["upButton", "Files"]], "title": "Directory Up", "text": "Go up one directory in the file system."},
{"chains": [["*", "currentDirectoryComboBox", "Files"], ["currentDirectoryComboBox", "Files"]], "title": "Directory Chooser", "text": "Select a different drive or directory here."},
{"chains": [["favouriteButton", "Files"]], "title": "Best Directory Forever!", "text": "Add or remove the current directory to your list of favorite directories. All directories are equal, but some are more equal than others."},
{"chains": [["listTypeButton", "Files"]], "title": "Show Previews", "text": "When activated the browser will show previews for pictures and video files. This can slow things down a bit when showing a file for the first time."},
{"chains": [["Compositions"], ["ComponentTVIComposition"], ["ComponentTVIDeck"]], "title": "Compositions / Decks", "text": "This list contains all your saved compositions with their included decks. Double click a composition or a deck to load. You can load a deck from any composition into your current composition."},
{"chains": [["Effects"], ["videoEffectsButton"], ["audioEffectsButton"], ["", "", "", "treeView", "*", "effectListsComponent", "Effects"], ["treeView", "*", "effectListsComponent", "Effects"]], "title": "Audio and Video Effects", "text": "List of audio and video effects with their presets. Drag the effect or the preset to a clip, layer, group or composition. or double click to preview it on the current selection."},
{"chains": [["Sources"], ["Sources Tree View"], ["", "", "", "Sources Tree View"]], "title": "Sources", "text": "Various types of video and audio sources. All the capture devices available on your computer, NDI and Spout/Syphon servers, generative FFGL plugins, Feedback fun times and the magical Video Router. Drag to a clip to use or double click to preview."},
{"chains": [["*", "*", "Help"]], "title": "Help! Help!", "text": "Don't point that cursor at me!"},
{"chains": [["closeHelpButton"]], "title": "Close Help", "text": "If you think you know it all you can close me, go ahead. I'll see you in the view menu!"},
{"chains": [["currentTimeLabel"]], "title": "Current Time", "text": "I'm late! I'm late! For a very important date! No time to say hello, goodbye! I'm late! I'm late! I'm late!"},
{"chains": [["statusbarLabel"]], "title": "Current Version", "text": "Are you up to date?"},
{"chains": [["Shortcuts"]], "title": "Keyboard, MIDI, OSC and DMX Shortcuts", "text": "Every colored interface element can have a shortcut assigned to it. Simply click it and press the keyboard key or Midi message you want to use to control it. Press delete or backspace to remove a shortcut."},
{"chains": [["", "", "shortcutXmlStatesPickerComponent", "ShortcutsTreeViewComponent"]], "title": "Shortcut Presets", "text": "Here you can change which shortcuts are currently active. Shortcut presets are super handy! You can have different presets for different Midi controllers, or for instance use different presets for different VJ styles."},
{"chains": [["", "", "", "treeView", "ShortcutsTreeViewComponent"], ["treeView", "ShortcutsTreeViewComponent"]], "title": "Shortcut List", "text": "A list of every shortcut currently active in this preset. If a certain shortcut is used twice, it's shown in red. Shortcuts that are currently unavailble are shown in grey. Right click to change the sorting."},
{"chains": [["targetTypeComboboxLabel"], ["targetLabel"]], "title": "Shortcut Target", "text": "This is where you decide what this shortcut actually controls. \"Selected...\" means the shortcut works for the currently selected clip, layer, or group. \"This...\" means you always control this particular clip, layer or group, regardless of where you move it in the composition. \"By Position\" means the shorcut is assigned by index. So it for instance will always control the first layer, regardless of how you re-arrange the layers."},
{"chains": [["modeLabel"], ["modeComboBoxLabel"]], "title": "Shortcut Mode", "text": "Here you can change the mode for this shortcut. The two most important ones to know about are Toggle and Value. Toggle will let you switch between two values with each press. Value will always set the parameter to a fixed value. For a wholesome explaination of all the other modes, check the manual. Ugh... Reading...."},
{"chains": [["pianoButton"]], "title": "Piano Mode", "text": "On key down the parameter will jump to the max value. When the key is released the parameter will jump back to the min value."},
{"chains": [["rangeLabel"], ["rangeSlider"], ["midiRangeSlider"], ["midiRangeLabel"]], "title": "Set Range", "text": "Set the minimum and maximum value of the parameter."},
{"chains": [["mouseXButton"]], "title": "Mouse Left to Right", "text": "Control the parameter by holding a key and moving the mouse left to right."},
{"chains": [["mouseYButton"]], "title": "Mouse Up and Down", "text": "Control the parameter by holding a key and moving the mouse up and down."},
{"chains": [["invertButton"]], "title": "Invert Mouse Behaviour", "text": "Up means down and down means up. Left means right and right means left. Turn those frowns upside down."},
{"chains": [["valueSlider"], ["valueLabel"]], "title": "Set Valuee", "text": "Use this to set the parameter to a specific value."},
{"chains": [["midiChannelLabel"], ["midiChannelComboBoxLabel"], ["midiKeyLabel"], ["midiNoteComboBoxLabel"], ["midiControllerNumberLabel"], ["midiControllerNumberComboBoxLabel"]], "title": "MIDI Message", "text": "When using MIDI learn these are automatically selected but they can be changed manually here."},
{"chains": [["midiControllerTypeLabel"], ["midiControllerTypeComboBoxLabel"]], "title": "MIDI Controller Mode", "text": "Endless dials should be set to 'Relative'. Fixed MIDI controllers to 'Absolute'. Buttons that send out CCs are a crime against nature, but you can use them when set to 'Button'."},
{"chains": [["invertValueToggle"]], "title": "Invert Value", "text": "Make the parameter go from high to low instead of low to high."},
{"chains": [["stepLabel"], ["*", "Step Slider"], ["stepSizeLabel"]], "title": "Step Size", "text": "Make the parameter value changes really fine or rough.", "raw": "'stepLabel' | '*' Step Slider' | 'stepSizeLabel'", "repaired": true},
{"chains": [["loopValueToggle"]], "title": "Loop Parameter Value", "text": "Loop the parameter value when the maximum or minimum value is reached."},
{"chains": [["midiOutVelocityLabel"]], "title": "MIDI Out Velocity", "text": "Here you can define what velocity this MIDI note sends back to the controller. This well let you choose custom colors on controllers that support it."},
{"chains": [["velocityStatusLabel"], ["velocityStatusComboBoxLabel"]], "title": "MIDI Out Status", "text": "A dropdown that lets you choose what velocity to send out for each state of the button. For most buttons this is simply a choice between colors for On and Off. But for instance clip triggers can have 5 different states! Colors galore!"},
{"chains": [["velocityValueLabel"], ["", "", "*", "shortcutEditorMIDINoteComponent"]], "title": "MIDI Out Velocity", "text": "The actual velocity you'd like to send out for this state. This will set the color of the pad. Each controller will use its own color scheme, but to help you get started we have preview swatches for the APC40Mk2 and the APC Mini.", "raw": "'velocityValueLabel' | ' '' '' '*' 'shortcutEditorMIDINoteComponent''", "repaired": true, "note": "INFERRED repair: the shipped alternative is \" '' '' '*' 'shortcutEditorMIDINoteComponent''\" - a stray space after the opening quote and a stray trailing quote slide every pair one position. Removing both gives the shape every neighbouring MIDI-out entry uses. Not verified against a running Arena."},
{"chains": [["oscInputLabel"], ["shortcutInputAddressLabel"]], "title": "OSC Input", "text": "OSC input address of the currently selected interface element. The first address is the absolute address and is always valid. The second address will control differnt elements depending on what's currently selected. The incoming address cannot be changed."},
{"chains": [["shortcutEditorOSCComponent"], ["typeTagLabel"]], "title": "OSC Type Tag", "text": "This tells you what type of argument (float, integer or string) to send to this address, and what range to send it in."},
{"chains": [["enableOutputButton"], ["oscOutputLabel"]], "title": "OSC Output", "text": "Check this box to enable OSC output from the currently selected interface element."},
{"chains": [["wildcardComboBoxLabel"]], "title": "OSC Output Wildcard", "text": "Use this dropdown to quickly enable OSC output for just this particular element, or for all similar elements in one fell swoop. You can also choose to output a custom address."},
{"chains": [["shortcutOutputAddressLabel"]], "title": "OSC Output Address", "text": "Change the OSC address that this interface elements sends to."},
{"chains": [["universeLabel"], ["universeComboBoxLabel"]], "title": "DMX Lumiverse", "text": "Choose which internal Resolume universe this DMX shortcut is part of. You can assign Lumiverses to an actual physical DMX input in the DMX tab of the Preferences."},
{"chains": [["dmxChannelLabel"], ["*", "dmxChannelSlider"]], "title": "DMX Channel", "text": "Manually adjust the Channel you want this shortcut to use."},
{"chains": [["", "Preferences"]], "title": "Preferences Window", "text": "Select one of the tabs to adjust your preferences."},
{"chains": [["GeneralPreferencesComponent"], ["generalTabButton"], ["GeneralPreferencesComponentHeader"]], "title": "General Preferences", "text": ""},
{"chains": [["recordDirectoryLabel"]], "title": "Record Directory", "text": "Location where the recorded files are saved."},
{"chains": [["browseRecordDirectoryButton"]], "title": "Choose Directory", "text": "Click to set a custom location."},
{"chains": [["RecordVideoButton"]], "title": "Record Video", "text": "Choose whether or not you want to include the video output when using the record feature."},
{"chains": [["RecordAudioButton"]], "title": "Record Audio", "text": "Choose whether or not you want to record the audio output when using the record feature."},
{"chains": [["audioTabButton"], ["AudioPreferencesComponent"], ["*", "AudioPreferencesComponent"]], "title": "Audio Preferences", "text": ""},
{"chains": [["AudioOutputDeviceLabel"], ["OutputDeviceComboBoxLabel"]], "title": "Audio Output Device", "text": "Choose the device on which you want to hear the audio."},
{"chains": [["AudioInputDeviceLabel"], ["InputDeviceComboBoxLabel"]], "title": "Audio Input Device", "text": "Choose the device that you want to use for all audio input."},
{"chains": [["MasterOutputChannelsLabel"], ["masterOutputChannelsComboBoxLabel"]], "title": "Master Output Channels", "text": "Choose the channels on which you want to hear the master audio output."},
{"chains": [["MasterOutputDelayLabel"], ["masterOutputDelaySlider"], ["masterOutputDelaySliderLabel"]], "title": "Master Output Delay", "text": "Slightly delay the audio coming out of Resolume to compensate for any delays in the video signal flow."},
{"chains": [["PreviewOutputChannelsLabel"], ["previewOutputChannelsComboBoxLabel"]], "title": "Preview Output Channels", "text": "Choose the channels on which you want to hear the preview audio output."},
{"chains": [["refreshButton", "AudioPreferencesComponent"]], "title": "Refresh Audio Devices", "text": "Click to check for newly attached audio interfaces."},
{"chains": [["SampleRateLabel"], ["sampleRateComboBoxLabel"]], "title": "Sample Rate", "text": "Higher sample rates provide higher quality audio but will require more processing, especially if audio effects are in use. The default will usually be okay."},
{"chains": [["BufferSizeLabel"], ["blockSizeSlider"], ["blockSizeSliderLabel"]], "title": "Buffer Size", "text": "Higher buffer sizes will introduce more latency into the system but setting the buffer size too low may cause glitches in the audio. When in doubt, 1024 is a good choice."},
{"chains": [["ExternalAudioFFTInputLabel"], ["fftInputChannelsComboBoxLabel"]], "title": "External Audio FFT Input", "text": "Choose the inputs you want to use for audio analysis."},
{"chains": [["AudioFFTInputGainLabel"], ["fftInputGainSlider"], ["fftInputGainSliderLabel"]], "title": "Audio FFT Input Gain", "text": "Boost the volume of the audio signal coming in."},
{"chains": [["SMPTEInput1Label"], ["smpteInput1ComboBoxLabel"], ["SMPTEInput2Label"], ["smpteInput2ComboBoxLabel"]], "title": "SMPTE Inputs", "text": "Choose which audio inputs you would like to use for SMPTE control."},
{"chains": [["SMPTETimecodeFramerate"], ["smpteFramerateComboBoxLabel"]], "title": "SMPTE Timecode Framerate", "text": "This should match the framerate of the SMPTE signal that you are receiving."},
{"chains": [["VSTPluginDirectoriesLabel"], ["DirectoryListTreeViewItemComponent", "", "", "", "vstDirsTreeView"], ["vstDirsTreeView"]], "title": "VST Plugin Directories", "text": "Directories where Resolume will look for VST plugins. Check the manual for the location of the default plugins."},
{"chains": [["chooseDirectoryButton"]], "title": "Choose Directory", "text": "Click to browse for a custom location."},
{"chains": [["vstDirAddButton"]], "title": "Add a VST Directory", "text": ""},
{"chains": [["vstDirRemoveButton"]], "title": "Remove the selected VST Directory", "text": ""},
{"chains": [["videoTabButton"], ["*", "VideoPreferencesComponent"], ["VideoPreferencesComponent"]], "title": "Video Preferences", "text": ""},
{"chains": [["ffglDirsTreeView"], ["DirectoryListTreeViewItemComponent", "", "", "", "ffglDirsTreeView"]], "title": "FFGL Plugin Directories", "text": "Directories where Resolume will look for additional FFGL plugins."},
{"chains": [["addDirectoryButton"]], "title": "Add Directory", "text": "Click to add a directory."},
{"chains": [["removeDirectoryButton"]], "title": "Remove Directory", "text": "Click to remove the selected directory."},
{"chains": [["radioDarkGrid"], ["radioLightGrid"], ["radioBlack"]], "title": "Dark Transparency Grid", "text": "Change the background to show when previewing content with an alpha channel."},
{"chains": [["midiTabButton"], ["*", "MidiPreferencesComponent"], ["MidiPreferencesComponent"]], "title": "MIDI Preferences", "text": ""},
{"chains": [["refreshListButton"]], "title": "Refresh Devices", "text": "Click to refresh the list of devices."},
{"chains": [["", "", "", "", "midiDevicesTreeView"], ["midiDevicesTreeView"]], "title": "MIDI Devices", "text": "List of all the connected MIDI devices and their available inputs and outputs."},
{"chains": [["expandButton"]], "title": "Show Traffic", "text": "Expand the view to show a list of incoming messages."},
{"chains": [["clearButton", "MidiMonitorComponent"], ["MidiMonitorComponent"], ["table", "", "MidiMonitorComponent"], ["", "", "", "", "", "table", "", "MidiMonitorComponent"]], "title": "MIDI Traffic", "text": "A list of the last 200 received MIDI messages."},
{"chains": [["oscTabButton"], ["oscPreferencesTitleLabel"], ["OscPreferencesComponent"]], "title": "OSC Preferences", "text": ""},
{"chains": [["oscInputToggle"]], "title": "Enable OSC Input", "text": "Toggle this to listen for incoming OSC messages on the selected port."},
{"chains": [["oscInputPortLabel"]], "title": "OSC Input Port", "text": "This is the port on which Resolume will listen for incoming OSC messages."},
{"chains": [["oscOutputToggle"]], "title": "Enable OSC Output", "text": "Toggle this to send OSC messages to the selected destination."},
{"chains": [["", "OutputComboBox"]], "title": "OSC Output Selection", "text": "Select where to send your OSC messages."},
{"chains": [["oscOutputPortLabel"]], "title": "OSC Output Port", "text": "This is the port to which Resolume will send OSC messages."},
{"chains": [["oscOutputAddressLabel"]], "title": "OSC Output IP Address", "text": "This is the IP address of the computer or mobile device to which Resolume will send OSC messages."},
{"chains": [["oscBundleToggle"]], "title": "Use Bundles", "text": "Select whether or not Resolume should bundle the OSC messages before sending them. Most OSC applications will work fine without bundles, but some prefer it."},
{"chains": [["*", "", "OscPreferencesComponent"], ["OscPreferencesComponent"], ["table", "", "", "OscPreferencesComponent"], ["", "table", "", "", "OscPreferencesComponent"], ["", "", "", "", "", "table", "", "", "OscPreferencesComponent"]], "title": "OSC Traffic", "text": "A list of the last 200 received OSC messages."},
{"chains": [["dmxTabButton"], ["msgLabel", "DMXPreferencesComponent"], ["DMXPreferencesComponent"]], "title": "DMX Preferences", "text": ""},
{"chains": [["Input Button", "DMXPreferencesComponent"]], "title": "Add Art-Net Input", "text": "Add an input device to receive DMX from."},
{"chains": [["deleteButton", "InputHeader", "groupedComponent", "groupedComponent", "", "Interface List", "DMXPreferencesComponent"]], "title": "Delete Art-Net Input", "text": "Delete this device."},
{"chains": [["nodeNameEditor", "DMXPreferencesComponent"]], "title": "Art-Net Node Name", "text": "Set the name this Resolume instance will appear as on your Art-Net network."},
{"chains": [["InputHeader", "groupedComponent", "groupedComponent", "", "Interface List", "DMXPreferencesComponent"]], "title": "Art-Net Input Settings", "text": "Adjust the Channel Offset and Universe for this input."},
{"chains": [["Subnet", "groupedComponent", "groupedComponent", "", "Interface List", "DMXPreferencesComponent"]], "title": "Subnet Number", "text": "Subnet ranges from 0-15. Together with the Universe number, this forms the Art-Net universe this input is listening on."},
{"chains": [["Universe", "groupedComponent", "groupedComponent", "", "Interface List", "DMXPreferencesComponent"]], "title": "Universe", "text": "Universe ranges from 0-15. Together with the Subnet number, this forms the Art-Net universe this input is listening on."},
{"chains": [["Channel Offset", "groupedComponent", "groupedComponent", "", "Interface List", "DMXPreferencesComponent"]], "title": "DMX Channel Offset", "text": "With the DMX channel offset number you can shift all the assigned DMX channels up or down."},
{"chains": [["Bind IP Label", "DMXPreferencesComponent"], ["bindIPComboLabel", "bindIPCombo", "DMXPreferencesComponent"]], "title": "Select Network Adapter", "text": "Choose which network interface Resolume should use for Art-Net. This will let you make sure you're using the wired network instead of the wireless card."},
{"chains": [["DmxMonitor"]], "title": "Art-Net Monitor", "text": "Here you can monitor all the Art-Net traffic on your network. Active Subnets and Universes will light up. You can then select a Subnet and Universe and see the received values for all 512 channels."},
{"chains": [["defaultsTabButton"], ["msgLabel", "DefaultPreferencesComponent"], ["DefaultPreferencesComponent"], ["*", "DefaultPreferencesComponent"], ["*", "*", "DefaultPreferencesComponent"]], "title": "Set Defaults", "text": "Here you can change the values Resolume should use as defaults. Clip defaults are applied when adding new clips to your composition. They do not affect clips that are already there."},
{"chains": [["TempoNudgeLabel", "DefaultPreferencesComponent"], ["TempoNudgeRangeSlider", "DefaultPreferencesComponent"]], "title": "Tempo Nudge Value", "text": "This is the percentage that the BPM will shift up or down while holding down the nudge buttons."},
{"chains": [["*", "", "Composition Settings"], ["", "Composition Settings"]], "title": "Composition Settings", "text": "Set things like the compositon name, description and size in this window."},
{"chains": [["widthLabel"], ["heightLabel"], ["resolutionsComboBox"]], "title": "Composition Size in Pixels", "text": "You can type any size you like here or select one of the predefined resolutions from the dropdown menu."},
{"chains": [["addItemButton"]], "title": "Add Items", "text": "Add new screens, slices and fixtures to your output setup."},
{"chains": [["", "", "xmlStatesPickerComponent"]], "title": "Preset Menu", "text": "Save, load and manage different output setups."},
{"chains": [["addScreen"]], "title": "Add Screen", "text": "Create a new screen. A screen can be assigned to any physical or virtual output."},
{"chains": [["addSlice"]], "title": "Add Slice", "text": "Add another slice to the current screen."},
{"chains": [["addPolygon"]], "title": "Add Polygon", "text": "Add a Polygon Slice to the current screen."},
{"chains": [["addSliceTriangle"]], "title": "Add Triangle Polygon", "text": "Quickly add a Polygon Slice that's shaped like a triangle."},
{"chains": [["addSlicePolygon"]], "title": "Draw Polygon", "text": "Add a Polygon slice, you can create any shape by drawing points on the composition."},
{"chains": [["addMask"], ["addMaskSquare"], ["addMaskCircle"], ["addMaskTriangle"], ["addMaskHexagon"]], "title": "Add Mask", "text": "Add a new output mask to the current screen."},
{"chains": [["addMaskPolygon"]], "title": "Draw Mask", "text": "Create a mask shape that's limited only by your imagination. Add points by drawing on the composition."},
{"chains": [["addLumiverse"]], "title": "Add Lumiverse", "text": "Create a new Lumiverse. This is like the Big Bang for DMX fixtures."},
{"chains": [["addFixture"]], "title": "Add Fixture", "text": "Add a new fixture to the current Lumiverse."},
{"chains": [["Screen"]], "title": "Screen", "text": "Select this screen for editing. Right click to quickly assign an output."},
{"chains": [["X", "Screen"]], "title": "Delete Screen", "text": "Whoah there, Flash. This deletes this screen and everything in it!"},
{"chains": [["enableButton", "Screen"]], "title": "Enable Screen", "text": "Enable or disable all the slices and masks in this screen in one fell swoop."},
{"chains": [["foldButton", "Screen"]], "title": "Fold Screen", "text": "Fold up all the slices in this screen. This also hides these slices on the Input Selection tab, so it becomes less cluttered."},
{"chains": [["sliceToggle"]], "title": "Enable Slice", "text": "Turn this slice on or off in the output."},
{"chains": [["Slice"]], "title": "Slice", "text": "Select this slice for editing. Right click it for more options or double click to rename it."},
{"chains": [["X", "Slice"]], "title": "Delete Slice", "text": "Remove this slice completely."},
{"chains": [["Input Mask"]], "title": "Input Mask", "text": "Select this input mask for editing."},
{"chains": [["sliceMaskToggleButton", "Input Mask"]], "title": "Enable Input Mask", "text": "Enable or disable the input mask for this slice."},
{"chains": [["X", "Input Mask"]], "title": "Delete Slice Input Mask", "text": "Reveal the true nature of this slice.", "raw": "'X' 'Input Mask", "repaired": true},
{"chains": [["Polygon"]], "title": "Polygon Slice", "text": "Select this polygon for editing."},
{"chains": [["sliceToggle", "Polygon"]], "title": "Enable Polygon", "text": "Show or hide this polygon in the output."},
{"chains": [["X", "Polygon"]], "title": "Delete Polygon", "text": "Poly-gone!"},
{"chains": [["Mask"]], "title": "Mask", "text": "Select this mask for editing."},
{"chains": [["sliceToggle", "Mask"]], "title": "Enable Mask", "text": "Show or hide this mask in the output."},
{"chains": [["X", "Mask"]], "title": "Delete Mask", "text": "Remove this mask completely."},
{"chains": [["Lumiverse"]], "title": "Lumiverse", "text": "Select this Lumiverse for editing. Right click to send it to an Art-Net node directly."},
{"chains": [["enableButton", "Lumiverse"]], "title": "Enable Lumiverse", "text": "Turn off the fixtures in this Lumiverse in one fell swoop."},
{"chains": [["foldButton", "Lumiverse"]], "title": "Fold Lumiverse", "text": "Fold up this Lumiverse. This also hides the fixtures on the Input Selection tab, so it becomes less cluttered."},
{"chains": [["X", "Lumiverse"]], "title": "Delete Lumiverse", "text": "Smite this Lumiverse with the force of nine thousand suns."},
{"chains": [["DmxSlice"]], "title": "Fixture Slice", "text": "Select this fixture for editing."},
{"chains": [["sliceToggle", "DmxSlice"]], "title": "Enable Fixture", "text": "Disable the output to this fixture. This will stop Resolume from sending DMX data to this fixture."},
{"chains": [["X", "DmxSlice"]], "title": "Delete Fixture", "text": "Remove this fixture completely."},
{"chains": [["Input Selection"], ["ScreenSetup", "InputAdvancedScreenSetupComponent"]], "title": "Input Selection", "text": "Here you can define which part of the composition should be used as input for your slices. Right click for preset options. Use the common ALT/SHIFT/CTRL(CMD) modifiers to constrain and copy."},
{"chains": [["Output Transformation"], ["ScreenSetup", "OutputAdvancedScreenSetupComponent"]], "title": "Output Transformation", "text": "Change the shape or position of your slices in your output. Each slice can be individually moved and reshaped to line up with your output. Right click for preset options. Use the common ALT/SHIFT/CTRL(CMD) modifiers to constrain and copy."},
{"chains": [["DMX Output"], ["ScreenSetup", "DMXOutputAdvancedScreenSetupComponent"]], "title": "DMX Output", "text": "Here you can visually re-arrange the start channels of your fixtures or check for any overlap."},
{"chains": [["zoomComboBoxLabel"], ["zoomComboBox"]], "title": "Zoom", "text": "Zoom the current view in or out, or fit the view to the current selection or composition."},
{"chains": [["panMode"]], "title": "Pan Tool", "text": "Use this to pan around. Hold down the spacebar as a quick way to toggle the pan tool."},
{"chains": [["undoButton"]], "title": "Undo", "text": "Don't just do it. Undo it."},
{"chains": [["redoButton"]], "title": "Redo", "text": "Undo it what you just undid."},
{"chains": [["snapButton"]], "title": "Toggle Snapping", "text": "Disable or enable that hot slice on slice action."},
{"chains": [["showGrid"]], "title": "Show Grid", "text": "Shows the name and bounds of the currently active slice in the output, so you can quickly locate your slice in a complex output setup. It also shows a perspective grid for the slice surface and a big red cross where your cursor is."},
{"chains": [["showLedGrid"]], "title": "Show LED Grid", "text": "Shows a 8x8 pixel grid and snaps all slices to it. This is helpful when arranging slices for output to a LED processor."},
{"chains": [["compositionSizeLabel"]], "title": "Composition Resolution", "text": "Width and height of the composition that is currently used as input."},
{"chains": [["editPointsButton"]], "title": "Edit Points Mode", "text": "In Edit Points Mode you can change the position or curve of every point on the current slice. Hit T to quickly switch between Edit Points and Transform mode."},
{"chains": [["transformButton"]], "title": "Transform Mode", "text": "Change the position, rotation or scale of the entire slice. Hit T to quickly switch between Edit Points and Transform mode."},
{"chains": [["foldComponentHeader", "*", "groupedComponent", "", "dataViewport"]], "title": "Name", "text": "Everything you wanted to know about your current selection, but were afraid to ask."},
{"chains": [["Device"]], "title": "Select Device", "text": "Choose which physical or virtual output this screen should be sent to. Physical outputs are the external displays connected to the computer. Virtual outputs can include Syphon/Spout and NDI, or even screens internally routed within the advanced output."},
{"chains": [["Width", "Screen"], ["Height", "Screen"]], "title": "Screen Width and Height", "text": "Set the width and height of your virtual output."},
{"chains": [["Opacity", "Screen"], ["Opacity", "Lumiverse"]], "title": "Opacity", "text": "Fades the active screen or Lumiverse in and out."},
{"chains": [["Brightness", "Screen"], ["Contrast", "Screen"], ["Red", "Screen"], ["Green", "Screen"], ["Blue", "Screen"], ["Brightness", "Lumiverse"], ["Contrast", "Lumiverse"], ["Red", "Lumiverse"], ["Green", "Lumiverse"], ["Blue", "Lumiverse"]], "title": "Color Compensation", "text": "Use this to adjust for mismatched projectors or differences between LED screens."},
{"chains": [["*", "Output Guide"], ["*", "*", "Output Guide"], ["*", "*", "*", "Output Guide"], ["*", "Input Guide"], ["*", "*", "Input Guide"], ["*", "*", "*", "Input Guide"]], "title": "Guide", "text": "Load an image file to act as a visual guide for your pixel map."},
{"chains": [["Delay", "*", "groupedComponent", "", "dataViewport", "*"]], "title": "Screen Delay", "text": "Add a delay in milliseconds to this screen, to compensate for any delay appearing in other outputs."},
{"chains": [["TargetIP", "Lumiverse"]], "title": "Target IP", "text": "The IP address of the Art-Net node that this Lumiverse is sending to."},
{"chains": [["Subnet", "Lumiverse"], ["Universe", "Lumiverse"]], "title": "Subnet and Universe", "text": "The Subnet and Universe of the Art-Net node that this Lumiverse is sending to."},
{"chains": [["Framerate", "Lumiverse"]], "title": "DMX Framerate", "text": "Choose how often this Lumiverse should spam your network with those nasty DMX packets."},
{"chains": [["Input Source"]], "title": "Input Source", "text": "Drop down that allows you to choose the input for a slice. There are quite a few options here. You can choose the composition or access a layer directly, bypassing the composition. Also the preview window is available as an input. Even more fun can be had by routing Virtual Screens back into a slice."},
{"chains": [["Input Opacity"]], "title": "Input Opacity", "text": "Toggle that tells the slice to follow the layer's opacity value, or to always show it, regardless of the layer's opacity value. This is useful when you want to warp a layer in the final output, but not have it show up in the composition."},
{"chains": [["Input Bypass/Solo"]], "title": "Input Bypass/Solo", "text": "Toggle that tells the slice to follow the layer's bypass and solo switches, or to ingore them. This is useful when you want to warp a layer in the final output, but not have it show up in the composition."},
{"chains": [["X", "*", "*", "*", "*", "InputAdvancedScreenSetupComponent"], ["Y", "*", "*", "*", "*", "InputAdvancedScreenSetupComponent"]], "title": "Slice Input X and Y Position", "text": "Position of the middle point of the slice, slice mask or fixture, relative to the composition. This defines which area of the composition you will use for its input."},
{"chains": [["Left", "*", "*", "*", "*", "InputAdvancedScreenSetupComponent"], ["Top", "*", "*", "*", "*", "InputAdvancedScreenSetupComponent"]], "title": "Slice Input Left and Top Position", "text": "Position of the left and top edges of the slice, slice mask or fixture, relative to the composition."},
{"chains": [["Width", "ScreenLayerInputParams"], ["Height", "ScreenLayerInputParams"]], "title": "Slice Input Width and Height", "text": "Input width and height of the current slice, slice mask or fixture in pixels. This defines the size of the area of the composition you will use for input."},
{"chains": [["Rotation", "*", "*", "*", "*", "InputAdvancedScreenSetupComponent"]], "title": "Slice Input Rotation", "text": "Rotate the input of this slice, slice mask or fixture, for instance so you can work with rotated LED screens."},
{"chains": [["toggleButton", "Soft Edge"]], "title": "Enable Soft Edge", "text": "Check this box to turn soft edging on or off for the current slice. Use this to blend the output where two or more projectors are overlapping. The output will be masked in the area where the slices overlap."},
{"chains": [["label", "Soft Edge"]], "title": "Soft Edge", "text": "Information on the soft edge settings of the current slice."},
{"chains": [["Power"]], "title": "Soft Edge Power", "text": "Use this to control the steepness of the curve of the soft edge in the blending area."},
{"chains": [["Luminance"]], "title": "Soft Edge Luminance", "text": "Use this to control the brightness of the center point of the soft edge curve in the blending area."},
{"chains": [["Gamma"]], "title": "Soft Edge Gamma", "text": "Use this to control the overall brightness of the soft edge in the blending area."},
{"chains": [["Gamma Red"], ["Gamma Green"], ["Gamma Blue"]], "title": "RGB Gamma Compensation", "text": "Control the color channels in the blending area."},
{"chains": [["foldComponentHeader", "InputMask"]], "title": "Slice Input Mask", "text": "Add a mask to the input of this slice, so you can create transparency."},
{"chains": [["addLoveMask"]], "title": "Add Heart Input Mask", "text": "Because only love can fill the void."},
{"chains": [["addSquareMask"], ["addCircleMask"], ["addTriangleMask"], ["addHexagonMask"]], "title": "Add Input Mask", "text": "Quickly add a preset mask shape to this slice."},
{"chains": [["addPolygonMask"]], "title": "Draw Input Mask", "text": "Draw your own input mask shape on this slice."},
{"chains": [["Flip"]], "title": "Flip", "text": "Flip the output of this slice or fixture horizontally, vertically or both."},
{"chains": [["Is Key"]], "title": "Toggle Key Channel", "text": "Renders alpha channels as black and white for use with broadcast mixers."},
{"chains": [["Black BG"]], "title": "Black Background", "text": "Renders this slice on a solid black background, even when its opacity is fully down. Useful when objects are partially covering each other in a projection mapping setup."},
{"chains": [["", "", "FixtureChoiceDropdown"]], "title": "Select Fixture", "text": "Select the personality to use for this fixture slice."},
{"chains": [["FixtureChoiceEdit"]], "title": "Open Fixture Editor", "text": "Edit the current personality or create a new one from scratch."},
{"chains": [["Start Channel", "Fixture"]], "title": "Start Channel", "text": "First channel in your Lumiverse that this fixture will send to."},
{"chains": [["GenericFixtureChoiceParam"], ["GenericFixtureRangeParam"]], "title": "DMX Parameter", "text": "Controls specific functionality of this fixture."},
{"chains": [["paramBaseComponent", "DipSwitches"], ["onButton"], ["offButton"]], "title": "Dip Switches", "text": "There are 10 kind of people in this world. Those who understand binary, and those who don't."},
{"chains": [["FixturePixelsParam"]], "title": "Fixture Output Preview", "text": "Preview of the RGB data that this fixture is sending out."},
{"chains": [["Width", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Height", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"]], "title": "Output Width and Height", "text": "Output width and height of the current slice or mask in pixels. This defines the size in the output."},
{"chains": [["X", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Y", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["X", "*", "*", "*", "*", "DMXOutputAdvancedScreenSetupComponent"], ["Y", "*", "*", "*", "*", "DMXOutputAdvancedScreenSetupComponent"]], "title": "Output X and Y Position", "text": "Position of the middle point of the slice or mask, relative to the output. This defines where you will see the slice in the output."},
{"chains": [["Left", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Top", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Left", "*", "*", "*", "*", "DMXOutputAdvancedScreenSetupComponent"], ["Top", "*", "*", "*", "*", "DMXOutputAdvancedScreenSetupComponent"]], "title": "Output Left and Top Position", "text": "Position of the left and top edges of the slice or mask, relative to the output."},
{"chains": [["Brightness", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Contrast", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Red", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Green", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Blue", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"]], "title": "Color Compensation", "text": "Use this to adjust individual slices or fixtures. In a pinch, ramping up the brightness will also help you locate a slice or fixture on the stage."},
{"chains": [["Rotation", "*", "*", "*", "*", "OutputAdvancedScreenSetupComponent"], ["Rotation", "*", "*", "*", "*", "DMXOutputAdvancedScreenSetupComponent"]], "title": "Output Rotation", "text": "Rotate the slice or mask around its center in the final output. Don't rotate it too much, or it will vomit pixels."},
{"chains": [["Point Mode"]], "title": "Slice Point Mode", "text": "Choose between linear and bezier interpolation modes for slice points."},
{"chains": [["Subdivisions X"]], "title": "Horizontal Slice Warp Points", "text": "Add or remove horizontal warp points to the current slice."},
{"chains": [["Subdivisions Y"]], "title": "Vertical Slice Warp Points", "text": "Add or remove vertical warp points to the current slice."},
{"chains": [["foldComponentHeader", "Point"]], "title": "Current Point", "text": "X and Y position information of the currently selected point."},
{"chains": [["X", "Point", "*", "*", "*", "*", "*"], ["X", "ToolsParams", "*", "*", "*", "*", "*"]], "title": "Point X Position", "text": "Position of currently selected point along the x-axis in pixels."},
{"chains": [["Y", "Point", "*", "*", "*", "*", "*"], ["Y", "ToolsParams", "*", "*", "*", "*", "*"]], "title": "Point Y Position", "text": "Position of currently selected point along the y-axis in pixels."},
{"chains": [["foldComponentHeader", "Black Level Compensation"]], "title": "Black Level Compensation", "text": "Adjust the black level of this slice. This will let you match the brightness of an edge blended slice, by adjusting the perceived difference between the non-overlapping and the overlapping area."},
{"chains": [["Red", "Black Level Compensation"], ["Green", "Black Level Compensation"], ["Blue", "Black Level Compensation"]], "title": "Channel Compensation", "text": "Increase the amount of red, green or blue in the black of this slice."},
{"chains": [["Invert", "MaskParams"]], "title": "Invert Mask", "text": "This will switch between masking the inside or the outside of the mask shape."},
{"chains": [["cancelButton"]], "title": "Cancel", "text": "Cancels all the hard work you did just now. Closes the Advanced Output, and brings things back to how they were before. Only use this when your middle name is Nostalgia."},
{"chains": [["okButton"]], "title": "Save and Close", "text": "Confirms all the hard work you did just now. Closes the Advanced Output, applies all the changes and saves the current setup. Use this when your middle name is Pixel Perfect."},
{"chains": [["GenericFixtureName"], ["Fixtures"], ["filesList"]], "title": "Personality Library", "text": "List of all the fixture personalities in your library."},
{"chains": [["createFixtureButton"]], "title": "Create Fixture", "text": "Create a new personality from scratch."},
{"chains": [["deleteFixtureButton"]], "title": "Delete Fixture", "text": "Delete the selected personality from the list."},
{"chains": [["addPixelParameterButton"]], "title": "Add Parameter", "text": "Add a new parameter to this personality."},
{"chains": [["removePixelParameterButton"]], "title": "Delete Parameter", "text": "Delete the selected parameter from the list."},
{"chains": [["closeButton", "", "Fixture Editor"]], "title": "Close Editor", "text": "Closes the editor and saves all your changes."},
{"chains": [["FixtureParameters"]], "title": "Fixture Parameters", "text": "Parameters that control the features of this personality."},
{"chains": [["foldComponentHeader", "PixelsParam"]], "title": "Pixel Block", "text": "Block of pixels that can be used to send color data to your fixture."},
{"chains": [["foldComponentHeader", "GenericParam"]], "title": "DMX Parameter", "text": "Controls specific functionality of this personality. You can drag parameters around to change their order."},
{"chains": [["Default"]], "title": "Default Value", "text": "Here you can set the default DMX value that this parameter should send out."},
{"chains": [["Width", "PixelsParam"], ["Height", "PixelsParam"]], "title": "Pixel Width", "text": "Set how many pixels this fixture contains."},
{"chains": [["Color Space", "PixelsParam"]], "title": "Color Space", "text": "Choose which channels this fixture can receive and the order they are in."},
{"chains": [["Gamma", "PixelsParam"]], "title": "Gamma", "text": "Adjust the gamma correction for this personality."},
{"chains": [["Distribution", "PixelsParam"]], "title": "Distribution", "text": "Define how the channels are distributed over your personality. The open arrow signifies the first channel, the direction of the subsequent arrows define how the channels 'snake' through the fixture."},
{"chains": [["Pixels"], ["PixelGroup"]], "title": "Pixel Distribution", "text": "Visual representation of how the channels are distributed over your personality."},
{"chains": [["CollectButton", "", "Media Manager"]], "title": "Collect Media", "text": "Gather all the footage used in this composition in one neat location."},
{"chains": [["LocateMissingFilesButton", "", "Media Manager"]], "title": "Locate All", "text": "Search for all missing files by selecting a folder. This will search through any subfolders as well."},
{"chains": [["CloseButton", "", "Media Manager"]], "title": "Close", "text": "We're done here!"},
{"chains": [["", "", "", "", "", "", "TableList", "", "Media Manager"], ["", "", "", "", "", "TableList", "", "Media Manager"]], "title": "File Info", "text": "List of all the files in this composition. Missing files are marked in red."},
{"chains": [["RelocateButton", "", "", "", "", "", "", "TableList", "", "Media Manager"]], "title": "Relocate File", "text": "Relocate or replace this particular file."},
{"chains": [["UpdateCompositionToggle", "", "Collect Media"]], "title": "Update Composition", "text": "Gather all the files in one location. When done, the current composition will be updated with the new paths. Handy for consolidating your composition files in one place."},
{"chains": [["CopyCompositionToggle", "", "Collect Media"]], "title": "Copy Composition", "text": "Gather all the files in one location. When done, the current composition is copied there as well. Handy for moving your composition and files to another computer."},
{"chains": [["compositionMasterSlider"], ["propertyHeader", "Master"]], "title": "AV Master", "text": "Fade all clips to black and all sound to silence."},
{"chains": [["speedSlider", "compositionControlComponent"], ["propertyHeader", "Speed", "commonParamsComponent", "groupedComponent", "", "viewport", "Composition"]], "title": "Master Speed", "text": "Speed all the clips up or down."},
{"chains": [["forwardButton", "compositionControlComponent"], ["forwardsButton2"]], "title": "Global Play Forward", "text": "Set all clips currently playing to play forward.", "raw": "'forwardButton' 'compositionControlComponent' | ' forwardsButton2", "repaired": true},
{"chains": [["blendModeComboboxLabel", "blendModeCombobox", "Layer Control Component"], ["propertyHeader", "Blend Mode", "videoMixerParamsComponent", "videoParamsComponent", "groupedComponent", "", "viewport", "Layer"], ["propertyHeader", "Blend Mode", "transitionMixerParamsComponent", "transitionParamsComponent", "groupedComponent", "", "viewport", "Layer"]], "title": "Select Layer Blend Mode", "text": "Select one of the many, many blend modes."},
{"chains": [["volumeSlider", "Layer Control Component"], ["propertyHeader", "Volume", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Layer"]], "title": "Audio Volume", "text": "Adjust the volume of the layer."},
{"chains": [["volumeSlider", "Layer Control Component"], ["propertyHeader", "Volume", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Composition"]], "title": "Audio Volume", "text": "Adjust the volume of the composition."},
{"chains": [["propertyHeader", "Pan", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Layer"]], "title": "Audio Pan", "text": "Adjust the panning of the layer."},
{"chains": [["propertyHeader", "Pan", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Composition"]], "title": "Audio Pan", "text": "Adjust the panning of the composition."},
{"chains": [["AVsliderTrans T"], ["Duration", "transitionParamsComponent"], ["*", "spinner", "paramBaseComponent", "Duration", "transitionParamsComponent"], ["propertyHeader", "Duration", "transitionParamsComponent", "groupedComponent", "", "viewport", "Layer"]], "title": "Transition Time", "text": "Control the duration of the transition between 0-10 sec."},
{"chains": [["foldComponentHeader", "dashboardComponent", "clipProperties", "SingleClipPropertiesComponent", "Clip", "TabbedContainer"], ["*", "dashboardComponent"], ["dashboardComponent"], ["*", "paramBaseComponent", "dashboardComponent"]], "title": "Dashboard", "text": "The Dashboard gives you quick access to parameters you change a lot. Grab a parameter by it's name and drop it onto one of the dials to link it. You can drop more parameters on one dial to control multiple parameters at once."},
{"chains": [["foldComponentHeader", "layerAutoPilotComponent"], ["layerAutoPilotComponent"], ["foldComponentHeader", "autoPilotGroupComponent", "groupedComponent", "", "viewport", "Layer"]], "title": "Auto Pilot", "text": "The Auto Pilot can be used to play back all the clips in a layer. How's about you let Resolume steer for a while, while you go for that well deserved drink?"},
{"chains": [["forwardsButton2", "layerAutoPilotComponent"], ["forwardButton2", "layerAutoPilotComponent", "autoPilotGroupComponent"]], "title": "Auto Pilot Play Forwards", "text": "Plays the clips in the current layer in sequence."},
{"chains": [["*", "*", "clipTransportTimelineComponent"], ["*", "*", "*", "*", "*", "clipTransportTimelineComponent"], ["*", "*", "*", "*", "clipTransportTimelineComponent"], ["propertyHeader", "Speed", "groupedComponent", "clipTransportTimelineComponent", "clipProperties", "SingleClipPropertiesComponent", "Clip"]], "title": "Timeline Speed", "text": "Control how quickly this clip plays back."},
{"chains": [["foldComponentHeader", "cuePointsComponent", "clipProperties", "SingleClipPropertiesComponent", "Clip"], ["cuePointsComponent"], ["foldComponentHeader", "cuePointsComponent"]], "title": "Cue Points", "text": "Use these six cue points to jump to different positions in the clip. Press one of the small arrow shapped buttons so set a cue point. Use the corresponding button to jump to that cue point."},
{"chains": [["PopupComboBoxLabel", "PopupComboBox", "currentDirectoryComboBox", "Files"], ["*", "currentDirectoryComboBox", "Files"], ["currentDirectoryComboBox", "Files"]], "title": "Directory Chooser", "text": "Select a different drive or directory here."},
{"chains": [["playModeLabel", "playMode"]], "title": "Play mode", "text": "Select how Resolume plays back your clips. Loop starts the clip at the beginning when it has reached the end. Random will jump to random places on the timeline. When the timeline is in BPM Sync mode, it will jump to a random beat and play. Bounce plays the timeline forwards and backwards. Play once will, well, just do that."},
{"chains": [["playModeAwayLabel", "playModeAway"]], "title": "Trigger mode", "text": "Select how Resolume triggers your clips. Continues playback from the position it was left. Relative continues playback from the position of the previous clip."},
{"chains": [["screenPickerButton"]], "title": "Screen Picker", "text": "Select a color from anywere on your screen. Pick and choose."},
{"chains": [["pickerButton"]], "title": "Color Picker", "text": "Select colors from the full spectrum, via HSB sliders, via RGB sliders or even from a Palette of your favorite swatches."},
{"chains": [["hsbButton"]], "title": "HSB Color Space", "text": "Select colors from the full spectrum, via HSB sliders, via RGB sliders or even from a Palette of your favorite swatches."},
{"chains": [["rgbButton"]], "title": "RGB Color Space", "text": "Select colors from the full spectrum, via HSB sliders, via RGB sliders or even from a Palette of your favorite swatches."},
{"chains": [["showPaletteButton"], ["paramColorPaletteComponent"], ["paramColorButton"]], "title": "Color Pallete", "text": "Select colors from a Pallate. Right click the Pallate for additional options. Pro tip: you can animate your Pallet!"},
{"chains": [["PresetsButton"]], "title": "Presets", "text": "Manage your presets."},
{"chains": [["propertyHeader", "Curve", "crossFaderParamsComponent"]], "title": "Crossfader Curve", "text": "Adjust the Curve of the Crossfader."},
{"chains": [["propertyHeader", "Behaviour", "crossFaderParamsComponent"]], "title": "Crossfader Behaviour", "text": "Make that crossfader behave like a proper little crossfader."},
{"chains": [["propertyHeader", "Blend Mode", "crossFaderMixerParamsComponent"]], "title": "Crossfader Blend Mode", "text": "Set the Blend Mode for the crossfader."},
{"chains": [["propertyHeader", "Auto Size"]], "title": "Auto Size", "text": "This function will automatically resize all clips within this layer to either fit, fill or stretch to the composition dimensions."},
{"chains": [["-"], ["+"], ["*2"], ["/2"]], "title": "Duration Ajdustments", "text": "subtraction, addition, multiplication and division. Resolume Elementary."},
{"chains": [["propertyHeader", "Duration"]], "title": "Duration", "text": ""},
{"chains": [["foldComponentHeader", "autoPilotGroupComponent", "groupedComponent", "", "viewport", "SingleClipPropertiesComponent", "Clip"]], "title": "Autopilot", "text": "Adjust the behaviour of the clip when in Autopilot mode"},
{"chains": [["propertyHeader", "view", "layerAutoPilotComponent", "autoPilotGroupComponent", "groupedComponent", "", "viewport", "SingleClipPropertiesComponent", "Clip"]], "title": "Autopilot Action", "text": "Set the behaviour of the clip when in Autopilot mode."},
{"chains": [["propertyHeader", "AutoPilotLoopCount", "layerAutoPilotComponent", "autoPilotGroupComponent", "groupedComponent", "", "viewport", "SingleClipPropertiesComponent", "Clip"]], "title": "Loops", "text": "Determine how many times the clip repeats."},
{"chains": [["propertyHeader", "Blend Mode", "videoMixerParamsComponent", "trackSettingsComponent", "VideoTrackInfoComponent", "groupedComponent", "", "viewport", "SingleClipPropertiesComponent", "Clip"]], "title": "Clip Blend Mode", "text": "Set a custom blend mode for this clip only. This will overwrite the layer blend mode for this clip."},
{"chains": [["Clear All of theLayers Button"]], "title": "Clear All of theLayers", "text": "Eject ALL the clips. From ALL the layers."},
{"chains": [["Queue", "tabbedButtonBar"]], "title": "Render Queue", "text": "The queue contains all rendered clips. Drag and drop to use the clip in your composition"},
{"chains": [["view", "", "", "", "", "view", "Queue"]], "title": "Rendered Clip", "text": "Your Clip. Rendered just right."},
{"chains": [["openFolderButton", "view", "", "", "", "", "view", "Queue"]], "title": "View in explorer", "text": "View rendered clip in the explorer"},
{"chains": [["removeButton", "view", "", "", "", "", "view", "Queue"]], "title": "Remove from queue", "text": "Remove the clip from the queue. This does not remove the file."},
{"chains": [["newExtensionButton"]], "title": "Create Patch", "text": "Create a new source, mixer or effect in SHOWAVE Forge."},
{"chains": [["editExtensionButton"]], "title": "Edit Patch", "text": "Edit this patch in SHOWAVE Forge."},
{"chains": [["forkExtensionButton"]], "title": "Fork Patch", "text": "Create a copy of this patch and edit it in SHOWAVE Forge."},
{"chains": [["menuButton", "Composition Monitor"], ["menuButton", "Preview Monitor"], ["menuButton", "Layer Monitor"], ["menuButton", "Group Monitor"]], "title": "Monitor Options", "text": "Adjust what you want to monitor (composition, preview, group or layer) and change monitor opacity behavior."},
{"chains": [["favoriteExtensionButton"]], "title": "Favorite", "text": "Select to add or remove this source or effect to your Favorites."},
{"chains": [["panHand"]], "title": "Pan Tool", "text": "Use this to pan around."},
{"chains": [["widgetStatus"]], "title": "Widget is disabled", "text": "Transform widget is disabled because either Rotation X, Y or Anchor is not at default value, or multiple clips are selected, or the test card is enabled."},
];

/* ===== CHAIN INDEX =====
   '>' joins tokens because a token may contain spaces ("Layer Control
   Component", "Composition Settings") but never '>'. setdefault, not
   overwrite: first match wins, matching the scan order the tail block implies. */
const SEP = '>';
const chainKey = ch => ch.join(SEP);
const byChain = new Map();
const byLeaf  = new Map();
INDEX.forEach((e, i) => {
  e.index = i;
  e.chains.forEach(ch => {
    const k = chainKey(ch);
    if(!byChain.has(k)) byChain.set(k, e);
    const leaf = ch[0];
    if(leaf && leaf !== '*' && !byLeaf.has(leaf)) byLeaf.set(leaf, e);
  });
});
const at = ch => byChain.get(chainKey(ch)) || null;

/* ===== forComponent =====
   Accepts, in order of reliability: a chain array; the quoted form the XML
   itself uses ("'volumeSlider' 'Layer Control Component'"); an unambiguous
   'a>b>c' string; a bare token.

   The bare space-separated form is tried last and is genuinely lossy - tokens
   may contain spaces, so "volumeSlider Layer Control Component" cannot be
   re-tokenised. Pass the quoted or '>' form when a token has a space in it.

   Wildcards resolve to nothing on purpose: '*' and '' are match operators, not
   names. Pure containers need no guard - 'groupedComponent' and 'viewport'
   never occur in leaf position anywhere in the 411, so byLeaf simply has no
   entry for them. ('paramBaseComponent', 'treeView', 'view' and 'table' do
   occur as leaves, 1-3 times each, and resolve to those real entries.) */
function forComponent(name){
  if(Array.isArray(name)) return at(name);
  if(typeof name !== 'string') return null;
  const s = name.trim();
  if(!s || s === '*') return null;
  if(s.includes("'")){
    const toks = [], re = /'([^']*)'/g;
    let m; while((m = re.exec(s))) toks.push(m[1]);
    const e = toks.length ? at(toks) : null;
    if(e) return e;
  }
  return at([s])
      || (s.includes(SEP) ? at(s.split(SEP).map(t => t.trim())) : null)
      || (/\s/.test(s)   ? at(s.split(/\s+/)) : null)
      || byLeaf.get(s)
      || null;
}

/* ===== DOM MAP =====
   Arena's components do not appear in this clone's markup, so the bridge is a
   CSS selector per control, derived by reading index.html and app.js
   (buildLayers, buildGrid, buildDecks, EROW/ESECT/EDASH/EFX, browser wiring).
   Rules are ordered specific -> general; forElement tests every rule against
   one node before climbing, so order only matters between rules sharing a node.
   conf 'medium' means the control exists but its shape differs from Arena's. */
const STATIC = [
  {sel:"#cEject", chain:["Clear All Layers Button"], conf:"high"},
  {sel:"#cBypass", chain:["Bypass All Layers Button"], conf:"high"},
  {sel:"#cM", chain:["compositionMasterSlider"], conf:"high", note:"chain also opens entry 366 AV Master; first-match-wins gives Master Opacity"},
  {sel:"#cPause", chain:["pauseButton", "compositionControlComponent"], conf:"high"},
  {sel:"#cPrev", chain:["connectPrevColumn"], conf:"high"},
  {sel:"#cNext", chain:["connectNextColumn"], conf:"high"},
  {sel:"#pie", chain:["barHighlightComponent"], conf:"high"},
  {sel:"#bpm", chain:["bpmValueLabel"], conf:"high"},
  {sel:"#bMinus", chain:["bpmDecButton"], conf:"high"},
  {sel:"#bPlus", chain:["bpmIncButton"], conf:"high"},
  {sel:"#bNudgeD", chain:["bpmPullButton"], conf:"high", note:"pull/push vs down/up is not stated in the file; both alternatives are one entry"},
  {sel:"#bNudgeU", chain:["bpmPushButton"], conf:"high"},
  {sel:"#bHalf", chain:["bpmDivideButton"], conf:"high"},
  {sel:"#bDouble", chain:["bpmMultiplyButton"], conf:"high"},
  {sel:"#bTap", chain:["bpmTapButton"], conf:"high"},
  {sel:"#bResync", chain:["bpmResyncButton"], conf:"high"},
  {sel:"#bMetro", chain:["metronomeButton"], conf:"high"},
  {sel:"#bUndo", chain:["undoButton"], conf:"high"},
  {sel:"#bRedo", chain:["redoButton"], conf:"high"},
  {sel:"#tPause", chain:["bpmPauseButton"], conf:"medium", note:"Arena pauses the BPM clock; the clone's transport pause is a play-state control"},
  {sel:"#fftDial", chain:["fftLabelComponent"], conf:"high"},
  {sel:"#fftSwatch", chain:["vuBar"], conf:"medium", note:"clone shows one level swatch, Arena an FFT bar graph"},
  {sel:"#transport .fft", chain:["FFT Gain"], conf:"high"},
  {sel:"#transport", chain:["toolbarTempoComponent"], conf:"high", note:"container fallback for the tempo cluster"},
  {sel:".layer [data-a=\"eject\"]", chain:["clearLayerButton"], conf:"high"},
  {sel:".layer [data-a=\"byp\"]", chain:["bypassLayerButton"], conf:"high"},
  {sel:".layer [data-a=\"solo\"]", chain:["soloLayerButton"], conf:"high"},
  {sel:".layer [data-a=\"blend\"]", chain:["blendModeComboboxLabel", "blendModeCombobox", "Layer Control Component"], conf:"high"},
  {sel:".layer .vfad[data-f=\"m\"]", chain:["masterSlider", "Layer Control Component"], conf:"high"},
  {sel:".layer .vfad[data-f=\"au\"]", chain:["volumeSlider", "Layer Control Component"], conf:"high"},
  {sel:".layer .vfad[data-f=\"v\"]", chain:["opacitySlider", "Layer Control Component"], conf:"high"},
  {sel:".layer .lclip", chain:["clipTriggerComponent", "Layer Control Component"], conf:"high"},
  {sel:".layer .lname[data-a=\"select\"]", chain:["Layer Control Component", "groupedComponent"], conf:"high"},
  {sel:".layer [data-a=\"busA\"]", chain:["groupAButton"], conf:"high"},
  {sel:".layer [data-a=\"busB\"]", chain:["groupBButton"], conf:"high"},
  {sel:".layer .tfad[data-f=\"tdur\"]", chain:["AVsliderTrans T"], conf:"high"},
  {sel:".layer .lt .tval", chain:["Duration", "transitionParamsComponent"], conf:"high"},
  {sel:".layer [data-a=\"tblend\"]", chain:["transitionBlendModeButton"], conf:"high"},
  {sel:".layer [data-a=\"prevClip\"]", chain:["connectPrevClip"], conf:"high"},
  {sel:".layer [data-a=\"nextClip\"]", chain:["connectNextClip"], conf:"high"},
  {sel:".layer [data-a=\"fwd\"]", chain:["forwardButton"], conf:"high", note:"empty <text/> in the shipped file"},
  {sel:".layer [data-a=\"back\"]", chain:["backwardsButton"], conf:"high", note:"empty <text/>"},
  {sel:".layer [data-a=\"hold\"]", chain:["pauseButton"], conf:"high", note:"empty <text/>"},
  {sel:".layer [data-a=\"loop\"]", chain:["playModeLabel", "playMode"], conf:"high"},
  {sel:".layer [data-a=\"pmode\"]", chain:["playModeAwayLabel", "playModeAway"], conf:"high"},
  {sel:".layer [data-a=\"speed\"]", chain:["speedSlider"], conf:"medium", note:"clone is a 1x/2x toggle, Arena a slider"},
  {sel:".layer .lt", chain:["*", "transitionParamsComponent"], conf:"high"},
  {sel:".clip .thumb", chain:["", "clipTriggerComponent", "groupedComponent"], conf:"high", note:"the anonymous child of clipTriggerComponent is the trigger area"},
  {sel:".clip .name", chain:["clipTriggerComponent", "groupedComponent"], conf:"high"},
  {sel:".colhead", chain:["columnTriggerComponent", "groupedComponent", "", "columnsViewport"], conf:"high"},
  {sel:"#xfader", chain:["crossFaderSlider"], conf:"high"},
  {sel:".xf-left button[title=\"Previous deck\"]", chain:["selectPrevDeckButton"], conf:"high"},
  {sel:".xf-left button[title=\"Next deck\"]", chain:["selectNextDeckButton"], conf:"high"},
  {sel:".deck-tab", chain:["*", "", "", "", "", "", "LayersAndClips"], conf:"high"},
  {sel:"#deckRow", chain:["", "", "", "", "", "LayersAndClips"], conf:"high"},
  {sel:".mon-foot .ic[title=\"Transform widget\"]", chain:["widgetStatus"], conf:"medium", note:"clone's glyph is static; Arena's reports why the widget is disabled"},
  {sel:".mon", chain:["Output Monitor"], conf:"high"},
  {sel:"#propTabs .ptab[data-p=\"pComp\"]", chain:["Composition"], conf:"high"},
  {sel:"#propTabs .ptab[data-p=\"pLayer\"]", chain:["Layer"], conf:"high"},
  {sel:"#propTabs .ptab[data-p=\"pGroup\"]", chain:["Group"], conf:"high"},
  {sel:"#propTabs .ptab[data-p=\"pClip\"]", chain:["Clip"], conf:"high"},
  {sel:".prow.eb .stp", chain:["*", "spinner", "paramBaseComponent"], conf:"high"},
  {sel:".prow.eb .val.ev", chain:["paramSliderLabel", "paramSlider", "paramBaseComponent"], conf:"high"},
  {sel:".prow.eb select.ebind", chain:["choiceButton1", "paramBaseComponent"], conf:"medium", note:"Arena uses up to 5 radio buttons, the clone a <select>"},
  {sel:".prow.eb button.ebind[data-kind=\"bool\"]", chain:["toggleButton", "paramBaseComponent"], conf:"high"},
  {sel:".prow.eb label[data-ep]", chain:["*", "paramBaseComponent"], conf:"high"},
  {sel:".prow.eb", chain:["*", "paramBaseComponent"], conf:"high"},
  {sel:".dash .dial", chain:["*", "paramBaseComponent", "dashboardComponent"], conf:"high"},
  {sel:".dash", chain:["dashboardComponent"], conf:"high"},
  {sel:".fx [data-fxbyp]", chain:["bypassButton"], conf:"high"},
  {sel:".fx [data-fxrm]", chain:["removeButton"], conf:"high", note:"empty <text/>"},
  {sel:"[data-fxdrop]", chain:["renderPassComponent"], conf:"high"},
  {sel:".fx", chain:["renderPassComponent"], conf:"high"},
  {sel:".sect h3 .pbtn", chain:["PresetsButton"], conf:"high"},
  {sel:"#brTabs .ptab[data-b=\"bFiles\"]", chain:["Files"], conf:"high"},
  {sel:"#brTabs .ptab[data-b=\"bSlices\"]", chain:["Slices"], conf:"high"},
  {sel:"#brTabs .ptab[data-b=\"bComps\"]", chain:["Compositions"], conf:"high"},
  {sel:"#brTabs .ptab[data-b=\"bEffects\"]", chain:["Effects"], conf:"high"},
  {sel:"#brTabs .ptab[data-b=\"bSources\"]", chain:["Sources"], conf:"high"},
  {sel:"#brTabs .ptab[data-b=\"bRender\"]", chain:["Queue", "tabbedButtonBar"], conf:"high"},
  {sel:"#brTabs .ptab[data-b=\"bRecord\"]", chain:["recordButton"], conf:"medium", note:"Arena's is a record transport button, the clone's a browser tab"},
  {sel:"#openGSL5RightPanel", chain:["*"], conf:"low", note:"SHOWAVE extension: a launch control on the Clip Time head, not a Browser tab; opens the complete independent GSL5 Lighting Library"},
  {sel:"#brSearch", chain:["searchBar"], conf:"high"},
  {sel:".br-search", chain:["searchBar"], conf:"high"},
  {sel:".br-tools button[title=\"Up one level\"]", chain:["upButton", "Files"], conf:"high"},
  {sel:"#brRoot", chain:["currentDirectoryComboBox", "Files"], conf:"high"},
  {sel:"#brFav", chain:["favouriteButton", "Files"], conf:"high"},
  {sel:"#brThumbs", chain:["listTypeButton", "Files"], conf:"high"},
  {sel:"#brTree .titem .heart", chain:["favoriteExtensionButton"], conf:"high"},
  {sel:".hint-bar .hb-title .x", chain:["closeHelpButton"], conf:"high"},
  {sel:".hint-bar", chain:["*", "*", "Help"], conf:"high"},
  {sel:"#clipTime", chain:["timeLabelButton"], conf:"high", note:"shipped with an unterminated quote"},
  {sel:"#ctLabel", chain:["timeLabelButton"], conf:"high"},
  {sel:"#sysTime", chain:["currentTimeLabel"], conf:"high"},
  {sel:"#status", chain:["statusbarLabel"], conf:"high"},
  {sel:"#fwSlices", chain:["Slices"], conf:"high"},
  {sel:"#setSize", chain:["resolutionsComboBox"], conf:"high"},
  {sel:"#dlgSettings", chain:["", "Composition Settings"], conf:"high"},
];

/* Labelled property rows. The clone renders every parameter through one EROW
   template, so the row's section heading and label are what stand in for
   Arena's propertyHeader chain. pane restricts a rule to one properties tab -
   Audio > Volume really is a different entry with different Resolume copy on
   the Layer panel ("the layer") and the Composition panel ("the composition"). */
const ROWS = [
  {sect:"Autopilot", label:"Duration", pane:null, chain:["Duration", "groupedComponent"]},
  {sect:"Autopilot", label:"Action", pane:null, chain:["propertyHeader", "view", "layerAutoPilotComponent", "autoPilotGroupComponent", "groupedComponent", "", "viewport", "SingleClipPropertiesComponent", "Clip"]},
  {sect:"Autopilot", label:"Loops", pane:null, chain:["propertyHeader", "AutoPilotLoopCount", "layerAutoPilotComponent", "autoPilotGroupComponent", "groupedComponent", "", "viewport", "SingleClipPropertiesComponent", "Clip"]},
  {sect:"Crossfader", label:"Curve", pane:null, chain:["propertyHeader", "Curve", "crossFaderParamsComponent"]},
  {sect:"Crossfader", label:"Behaviour", pane:null, chain:["propertyHeader", "Behaviour", "crossFaderParamsComponent"]},
  {sect:"Crossfader", label:"Phase", pane:null, chain:["crossFaderSlider"]},
  {sect:"Transport", label:"Beat Loop", pane:null, chain:["beatLooperComponent"]},
  {sect:"Transport", label:"Transport", pane:null, chain:["transportTypeComboBoxLabel"]},
  {sect:"Transport", label:"Position", pane:null, chain:["paramSlider", "*", "clipProperties"]},
  {sect:"Transport", label:"Play Mode", pane:null, chain:["playModeLabel", "playMode"]},
  {sect:"Transport", label:"Playmode Away", pane:null, chain:["playModeAwayLabel", "playModeAway"]},
  {sect:"Video", label:"Auto Size", pane:null, chain:["propertyHeader", "Auto Size"]},
  {sect:"Transition", label:"Duration", pane:null, chain:["Duration", "transitionParamsComponent"]},
  {sect:"Transition", label:"Blend Mode", pane:null, chain:["Blend Mode", "transitionMixerParamsComponent"]},
  {sect:"Audio", label:"Volume", pane:"pLayer", chain:["propertyHeader", "Volume", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Layer"]},
  {sect:"Audio", label:"Volume", pane:"pComp", chain:["propertyHeader", "Volume", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Composition"]},
  {sect:"Audio", label:"Pan", pane:"pLayer", chain:["propertyHeader", "Pan", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Layer"]},
  {sect:"Audio", label:"Pan", pane:"pComp", chain:["propertyHeader", "Pan", "audioParamsComponent", "groupedComponent", "groupedComponent", "", "viewport", "Composition"]},
  {sect:"Video", label:"Blend Mode", pane:"pClip", chain:["propertyHeader", "Blend Mode", "videoMixerParamsComponent", "trackSettingsComponent", "VideoTrackInfoComponent", "groupedComponent", "", "viewport", "SingleClipPropertiesComponent", "Clip"]},
  {sect:"Video", label:"Blend Mode", pane:"pLayer", chain:["propertyHeader", "Blend Mode", "videoMixerParamsComponent", "videoParamsComponent", "groupedComponent", "", "viewport", "Layer"]},
];

/* Section headings (ESECT h3). */
const SECTS = {
  "Autopilot": ["foldComponentHeader", "layerAutoPilotComponent"],
  "Dashboard": ["dashboardComponent"],
  "Crossfader": ["crossFaderParamsComponent"],
  "Transition": ["*", "transitionParamsComponent"],
  "Audio": ["audioParamsComponent"],
  "Video": ["videoParamsComponent"],
  "Video Effects": ["renderPassComponent"],
  "Transport": ["*", "clipProperties"],
  "Source": ["*", "renderPassGeneratorComponent"],
};

const PANE_NAME = {
  "pComp": ["nameLabel", "Composition"],
  "pLayer": ["nameLabel", "layerPropertiesHeaderComponent"],
  "pGroup": ["nameLabel", "", "Group"],
  "pClip": ["nameLabel", "", "SingleClipPropertiesComponent", "Clip"],
};
const PANE_MENU = {
  "pComp": ["menuButton", "", "Composition"],
  "pLayer": ["menuButton", "layerPropertiesHeaderComponent"],
  "pGroup": ["menuButton", "", "Group"],
  "pClip": ["menuButton", "", "SingleClipPropertiesComponent", "Clip"],
};
const GEAR = {
  "comp": ["menuButton", "Composition Monitor"],
  "preview": ["menuButton", "Preview Monitor"],
  "layer": ["menuButton", "Layer Monitor"],
};
const COG = {
  "dash": ["paramRangeSlider", "paramLinkComponent", "paramBaseComponent"],
  "Timeline": ["paramTimelineComponent", "paramBaseComponent"],
  "BPM Sync": ["ParamLinkBPMComponent", "paramBaseComponent"],
  "FFT": ["ParamLinkFFTBasicComponent"],
  "Envelope": ["", "paramEnvelopeComponent", "paramBaseComponent"],
  "generic": ["*", "paramBaseComponent"],
};

/* ===== dynamic rules =====
   One element in this clone can mean several Arena components. #pTitle is the
   name field for all four properties panels; a .cog is a different entry per
   animation mode. These resolve at hover time from live DOM state, which is the
   nearest thing the clone has to Arena's ancestor chain. */
const paneNow = () => {
  const t = document.querySelector('#propTabs .ptab.on');
  return t ? t.dataset.p : null;
};
const sectOf = el => {
  const s = el.closest && el.closest('.sect');
  if(!s) return null;
  const h = s.querySelector('h3');
  if(!h) return null;
  return (h.firstChild && h.firstChild.nodeType === 3 ? h.firstChild.textContent : h.textContent)
    .replace('P.', '').trim();
};
const labelOf = row => {
  const l = row.querySelector('label');
  return l ? l.textContent.trim() : null;
};

const DYN = [
  { sel:'#pTitle',                    fn: () => at(PANE_NAME[paneNow()] || []) },
  { sel:'.pname .ic[title="Options"]', fn: () => at(PANE_MENU[paneNow()] || []) },
  { sel:'.mon-foot [data-gear]',      fn: el => at(GEAR[el.dataset.gear] || []) },
  /* animBadge() writes the mode into title=; the glyph says which kind it is */
  { sel:'.prow.eb .cog', fn: el => {
      const g = el.textContent.trim(), mode = el.getAttribute('title') || '';
      if(g === '\u25c8') return at(COG.dash);                 /* linked to a dial */
      if(g === '\u25c9'){
        if(mode === 'Timeline') return at(COG.Timeline);
        if(mode === 'BPM Sync') return at(COG['BPM Sync']);
        if(/FFT/.test(mode))    return at(COG.FFT);
        if(/Envelope/.test(mode)) return at(COG.Envelope);
      }
      return at(COG.generic);
    } },
  { sel:'.prow.eb', fn: el => {
      const s = sectOf(el), l = labelOf(el);
      if(!s || !l) return null;
      const p = paneNow();
      let hit = ROWS.find(r => r.sect === s && r.label === l && r.pane === p);
      if(!hit) hit = ROWS.find(r => r.sect === s && r.label === l && r.pane === null);
      return hit ? at(hit.chain) : null;
    } },
  { sel:'.sect > h3', fn: el => {
      const s = sectOf(el);
      return s && SECTS[s] ? at(SECTS[s]) : null;
    } },
];

/* ===== forElement =====
   Climb from the node to the root, testing the dynamic rules then the static
   ones at each level. A rule that resolves to nothing falls through to the next
   rather than ending the walk, so an unmapped child still inherits its
   container's entry. Returns null when nothing matches - a wrong entry is worse
   than no entry, because Resolume's copy is specific enough to be believed. */
function forElement(el){
  let n = el && el.nodeType === 3 ? el.parentElement : el;
  while(n && n.nodeType === 1){
    for(const r of DYN){
      if(n.matches(r.sel)){
        const e = r.fn(n);
        if(e) return e;
      }
    }
    for(const r of STATIC){
      if(n.matches(r.sel)){
        const e = at(r.chain);
        if(e) return e;
      }
    }
    n = n.parentElement;
  }
  return null;
}

/* ===== UNMATCHED =====
   Computed, not hand-listed, so it cannot drift from the map above. These are
   the Arena controls this clone has no equivalent for: the whole group strip,
   the composition transport row's forward/backward/random/speed, the audio
   path and VST, Ableton Link, the colour picker, cue points, and everything
   living in the six separate-study HTML files (preferences, shortcuts,
   advanced output, fixture editor, media manager, envelope editor). */
const mapped = new Set();
STATIC.forEach(r => { const e = at(r.chain); if(e) mapped.add(e); });
ROWS.forEach(r => { const e = at(r.chain); if(e) mapped.add(e); });
Object.keys(SECTS).forEach(k => { const e = at(SECTS[k]); if(e) mapped.add(e); });
[PANE_NAME, PANE_MENU, GEAR, COG].forEach(m =>
  Object.keys(m).forEach(k => { const e = at(m[k]); if(e) mapped.add(e); }));
const UNMATCHED = INDEX.filter(e => !mapped.has(e));

/* ===== audit ===== which rules actually find a node in the page right now.
   Same intent as ArenaRulers.audit(): turn "the mapping looks about right"
   into a list with numbers next to it. */
function audit(){
  const dead = STATIC.filter(r => !document.querySelector(r.sel)).map(r => r.sel);
  return {
    entries: INDEX.length,
    mappedEntries: mapped.size,
    unmatched: UNMATCHED.length,
    rules: STATIC.length + DYN.length + ROWS.length + Object.keys(SECTS).length,
    selectorsWithNoNode: dead
  };
}

window.ArenaHelp = { forComponent, forElement, INDEX, UNMATCHED, DEFAULT,
                     STATIC, DYN, ROWS, SECTS, byChain, audit };
})();
