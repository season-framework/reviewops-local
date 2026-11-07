'use strict';

// Runtime policy, not a claim that the presence of a binary qualifies a provider.
// The public factory supplies only the real Electron app and safeStorage objects.
function identityRuntimeAllowed({app, commandLine, platform}) {
  if (!['darwin', 'win32'].includes(platform) || !app.isReady()) return false;
  // Chromium's mock keychain uses a testing password, not the user's OS vault.
  if (commandLine.hasSwitch('use-mock-keychain') ||
      commandLine.hasSwitch('disable-encryption') ||
      commandLine.getSwitchValue('password-store') === 'basic') return false;
  return true;
}

module.exports = {identityRuntimeAllowed};
