'use strict';

module.exports = async context => {
  if (context.electronPlatformName === 'darwin') {
    require('./mac-release').assertMacRelease(context.packager.platformSpecificBuildOptions);
  }
  await require('./verify-practice-package')(context);
};
