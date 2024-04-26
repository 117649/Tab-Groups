/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.1.4

// TODO: create/adapt an actual native dark style, rather than reuse FT DeepDark's one.

this.__defineGetter__('LightweightThemeManager', function() {
	delete this.LightweightThemeManager;
	return this.LightweightThemeManager = ChromeUtils.importESModule("resource://gre/modules/LightweightThemeManager.sys.mjs");
});

this.brightText = {
	dark: false,

	useDarkTheme: function() {
		return this.dark;
	},

	observe: function(aSubject, aTopic, aData) {
		// Only possibilities are forceBrightText pref changed or the lwtheme changed.
		window.requestAnimationFrame(() => {
			Windows.callOnMostRecent((aWindow) => {
				this.check(aWindow.document);
			}, 'navigator:browser');
		});
	},

	check: function(aDocument) {
		// We only need to listen for changes when a(ny) window opens up the groups view.
		Prefs.listen('forceBrightText', brightText);
		Observers.add(brightText, "lightweight-theme-styling-update");

		// The user can choose to force a theme on the frame.
		switch(Prefs.forceBrightText) {
			case 1:
				this.unload();
				break;

			case 2:
				this.load();
				break;

			case 0:
			default:
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
			Styles.load('FTDeepDark', 'compatibilityFix/FTDeepDark', false, 'author');
			this.dark = true;
			Observers.notify(objName+'-darktheme-changed', null);
		}
	},

	unload: function() {
		if(this.dark) {
			Styles.unload('FTDeepDark');
			this.dark = false;
			Observers.notify(objName+'-darktheme-changed', null);
		}
	}
};

Modules.LOADMODULE = function() {
	Styles.load('FTDeepDark-theme', 'compatibilityFix/FTDeepDark-theme', false, 'author');
};

Modules.UNLOADMODULE = function() {
	Prefs.unlisten('forceBrightText', brightText);
	Observers.remove(brightText, "lightweight-theme-styling-update");

	Styles.unload('FTDeepDark-theme');
	brightText.unload();
};
