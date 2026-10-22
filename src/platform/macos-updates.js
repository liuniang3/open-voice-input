"use strict";

// This prerelease holds only Mac channel metadata. Package URLs point at
// versioned Mac releases, never at GitHub's repository-wide latest release.
const MACOS_UPDATE_FEED = Object.freeze({
  provider: "generic",
  url: "https://github.com/liuniang3/open-voice-input/releases/download/macos-updates/",
  useMultipleRangeRequest: false
});

module.exports = { MACOS_UPDATE_FEED };
