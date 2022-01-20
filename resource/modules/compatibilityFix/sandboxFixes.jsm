/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.0.5

Modules.LOADMODULE = function() {
	AddonManager.getAddonByID('{dc572301-7619-498c-a57d-39143191b318}').then(async function(addon) {
		if(addon){
			await addon.startupPromise;
			Modules.loadIf('compatibilityFix/TabMixPlus', addon.isActive);
		}
	});

	Modules.load('compatibilityFix/CCK2');
	Modules.load('compatibilityFix/SessionManager');
	Modules.load('compatibilityFix/brighttext');
};

Modules.UNLOADMODULE = function() {
	Modules.unload('compatibilityFix/TabMixPlus');
	Modules.unload('compatibilityFix/CCK2');
	Modules.unload('compatibilityFix/SessionManager');
	Modules.unload('compatibilityFix/brighttext');
};
