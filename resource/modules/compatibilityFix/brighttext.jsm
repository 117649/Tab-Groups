/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.1.4

// TODO: create/adapt an actual native dark style, rather than reuse FT DeepDark's one.

this.__defineGetter__('LightweightThemeManager', function() {
	delete this.LightweightThemeManager;
	Cu.import("resource://gre/modules/LightweightThemeManager.jsm", this);
	return this.LightweightThemeManager;
});

this.brightText = {
	permanent: false,
	dark: false,

	useDarkTheme: function() {
		return this.permanent || this.dark;
	},

	observe: function(aSubject, aTopic, aData) {
		// Only possibilities are forceBrightText pref changed or the lwtheme changed.
		aSync(() => {
			Windows.callOnMostRecent((aWindow) => {
				this.check(aWindow.document);
			}, 'navigator:browser');
		}, 100);
	},

	check: function(aDocument) {
		if(this.permanent) { return; }

		// We only need to listen for changes when a(ny) window opens up the groups view.
		Prefs.listen('forceBrightText', brightText);
		Observers.add(brightText, "lightweight-theme-styling-update");

		// The user can choose to force a theme on the frame.
		switch(Prefs.forceBrightText) {
			case 1:
				Styles.unload('brightText');
				this.unload();
				break;

			case 2:
				Styles.unload('brightText');
				this.load();
				break;

			case 0:
			default:
				Styles.unload('brightText');

				if(Services.appinfo.chromeColorSchemeIsDark) {
					this.load();
				} else {
					this.unload();
				}
				break;
		}
	},

	load: function() {
		if(!this.dark) {
			Styles.load('FTDeepDark', 'compatibilityFix/FTDeepDark');
			Styles.load('FTDeepDark-scrollbars', 'compatibilityFix/FTDeepDark-scrollbars', false, 'agent');
			this.dark = true;
			Observers.notify(objName+'-darktheme-changed', null);
		}
	},

	unload: function() {
		if(this.dark) {
			Styles.unload('FTDeepDark');
			Styles.unload('FTDeepDark-scrollbars');
			this.dark = false;
			Observers.notify(objName+'-darktheme-changed', null);
		}
	}
};

Modules.LOADMODULE = function() {
	AddonManager.getAddonByID('{77d2ed30-4cd2-11e0-b8af-0800200c9a66}', function(addon) {
		brightText.permanent = !!(addon && addon.isActive);
		if(brightText.permanent) {
			Modules.load('compatibilityFix/FTDeepDark');
		}
	});
};

Modules.UNLOADMODULE = function() {
	Prefs.unlisten('forceBrightText', brightText);
	Observers.remove(brightText, "lightweight-theme-styling-update");

	Modules.unload('compatibilityFix/FTDeepDark');
	brightText.unload();
	Styles.unload('brightText');
};
