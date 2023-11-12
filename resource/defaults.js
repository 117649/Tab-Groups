/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.4.24

objName = 'tabGroups';
objPathString = 'tabgroups';
addonUUID = 'd9d0e890-860a-11e5-a837-0800200c9a66';

addonUris = {
	homepage: 'https://addons.mozilla.org/firefox/addon/tab-groups-panorama/',
	support: 'https://github.com/Quicksaver/Tab-Groups/issues',
	fullchangelog: 'https://github.com/Quicksaver/Tab-Groups/commits/master',
	email: 'mailto:quicksaver@gmail.com',
	profile: 'https://addons.mozilla.org/firefox/user/quicksaver/',
	api: 'http://fasezero.com/addons/api/tabgroups',
	development: 'http://fasezero.com/addons/'
};

prefList = {
	quickAccessButton: true,
	groupTitleInButton: true,

	displayMode: 'single',
	searchMode: 'highlight',

	showGroupThumbs: true,
	gridDynamicSize: true,
	closeIfEmpty: true,
	sortGroupsByName: false,

	showTabCounter: true,
	stackTabs: true,
	showThumbs: true,
	showUrls: true,
	tileIcons: true,

	tabViewKeycode: 'E',
	tabViewAccel: true,
	tabViewShift: true,
	tabViewAlt: false,
	tabViewCtrl: false,

	quickAccessKeycode: 'none',
	quickAccessAccel: true,
	quickAccessShift: true,
	quickAccessAlt: false,
	quickAccessCtrl: false,

	nextGroupKeycode: '`',
	nextGroupAccel: !DARWIN,
	nextGroupShift: false,
	nextGroupAlt: false,
	nextGroupCtrl: DARWIN,

	previousGroupKeycode: '~',
	previousGroupAccel: !DARWIN,
	previousGroupShift: true,
	previousGroupAlt: false,
	previousGroupCtrl: DARWIN,

	SessionSnapshotEnable: false,
	SessionSnapshotInterval: 15,

	noWarningsAboutSession: false,

	// hidden prefs
	forceBrightText: 0,
	overrideViewportRatio: "",

	// for internal use
	pageAutoChanged: false,
	migratedKeysets: false
};

// If we're initializing in a content process, we don't care about the rest
if (isContent) { throw 'isContent'; }

paneList = [
	["paneTabGroups", true],
	["paneHowTo", true],
	["paneSession", true]
];

function startAddon(window) {
	prepareObject(window);
	window[objName].Modules.load('TabView', window.gBrowserInit);
}

function stopAddon(window) {
	window[objName].Modules.unload('TabView', window.gBrowserInit);
	removeObject(window);
}

// Don't rely on other modules being loaded here, make sure this can do the backup by itself.
async function backupCurrentSession(prefixSeg = '-update.js-', timesuffix = null) {
	let tmp = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs");
	let window = Windows.getEnumerator('navigator:browser').getNext()

	Cu.importGlobalProperties(['TextEncoder'])

	let prefix = objName + prefixSeg;

	// We can use the initTime as a seed/identifier to make sure every file has a unique name.
	// This is the same suffix syntax as the automated backups created by Firefox upgrades, except it uses a buildID instead
	// (which we don't have for the add-on, hence initTime instead).
	let filename = prefix + (timesuffix ?? AddonData.initTime);

	// This is the folder where the automated backups created by Firefox upgrades are saved.
	let profileDir = window.PathUtils?.profileDir ?? await window.PathUtils?.getProfileDir();
	let backupsDir = window.PathUtils.join(profileDir, "sessionstore-backups");
	let filepath = window.PathUtils.join(backupsDir, filename);

	let saveState = tmp.SessionStore.getCurrentState();
	window.IOUtils.writeJSON(filepath + '.jsonlz4', saveState, {
		tmpPath: filepath + ".tmp",
		compress: true,
	}).then(async () => {
		// Don't keep backups indefinitely, follow the same rules as Firefox does, keep a limited number and rotate them out.
		let existingBackups = [];
		let iterator = await window.IOUtils.getChildren(backupsDir);
		iterator.forEach((file) => {
			// a copy of the current session, for crash-protection
			if (window.PathUtils.filename(file).startsWith(prefix)) {
				let val = window.PathUtils.filename(file).substr(prefix.length);
				existingBackups.push(val);
			}
		});

		let max = Services.prefs.getIntPref('browser.sessionstore.upgradeBackup.maxUpgradeBackups');
		if (existingBackups.length > max) {
			// keep the most recently created files
			existingBackups.sort(function (a, b) { return parseInt(b.replace(/\D/g,'')) - parseInt(a.replace(/\D/g,'')); });
			let toRemove = existingBackups.splice(3);
			for (let seed of toRemove) {
				let name = prefix + seed;
				let path = window.PathUtils.join(backupsDir, name);
				window.IOUtils.remove(path);
			}
		}
	});
}

function onInstall(aData) {
}

async function onStartup(aData) {
	// If this is the first startup after installing or updating the add-on, make a backup of the session, just in case.
	if (STARTED == ADDON_INSTALL || STARTED == ADDON_UPGRADE || STARTED == ADDON_DOWNGRADE) {
		// Don't block add-on startup if it fails to create the backup for some reason.
		try { backupCurrentSession(); }
		catch (ex) { Cu.reportError(ex); }
	}

	Modules.load('Utils');
	Modules.load('Storage');
	Modules.load('nativePrefs');
	Modules.load('compatibilityFix/sandboxFixes');
	Modules.load('keysets');

	// Scrollbar CSS code needs to be loaded as an AGENT sheet, otherwise it won't apply to scrollbars in non-xul documents.
	Styles.load('scrollbars', 'scrollbars', false, 'agent');

	// Apply the add-on to every window opened and to be opened
	Windows.callOnAll(startAddon, 'navigator:browser');
	Windows.register(startAddon, 'domwindowopened', 'navigator:browser');

	SSSEobs();
	Services.prefs.addObserver("extensions." + objPathString + ".SessionSnapshotEnable", SSSEobs);
	Services.prefs.addObserver("extensions." + objPathString + ".SessionSnapshotInterval", SSSIobs);
	
	try {
		Services.prefs.getBoolPref("extensions." + objPathString + ".hide_warning") ?
			(await AddonManager.getAddonByID(`${aData.id}`)).__AddonInternal__.signedState = AddonManager.SIGNEDSTATE_NOT_REQUIRED
			: (await AddonManager.getAddonByID(`${aData.id}`)).__AddonInternal__.signedState === AddonManager.SIGNEDSTATE_NOT_REQUIRED ? (await AddonManager.getAddonByID(`${aData.id}`)).__AddonInternal__.signedState = AddonManager.SIGNEDSTATE_MISSING : '';
	} catch (error) { }
}

branch = Services.prefs.getBranch("extensions" + objPathString);

function onShutdown() {
	// remove the add-on from all windows
	Windows.callOnAll(stopAddon, null, null, true);

	Styles.unload('scrollbars');

	Modules.unload('keysets');
	Modules.unload('compatibilityFix/sandboxFixes');
	Modules.unload('nativePrefs');
	Modules.unload('Storage');
	Modules.unload('Utils');

	this.SSSTimer?.cancel();
	delete this.SSSTimer;
	Services.prefs.removeObserver("extensions." + objPathString + ".SessionSnapshotEnable", SSSEobs);
	Services.prefs.removeObserver("extensions." + objPathString + ".SessionSnapshotInterval", SSSIobs);
}

function SSSCallback(){
	let date = new Date();
	let y = date.getFullYear();
	let m = (date.getMonth() +1); if(m < 10) { m = "0"+m; }
	let d = date.getDate(); if(d < 10) { d = "0"+d; }
	let h = date.getHours(); if(h < 10) { h = "0"+h; }
	let mm = date.getMinutes(); if(mm < 10) { mm = "0"+mm; }
	let s = date.getSeconds(); if(s < 10) { s = "0"+s; }
	let dateStr = ""+y+m+d+"-"+h+mm+s;
	try { backupCurrentSession('-SSS-', dateStr); }
	catch (ex) { Cu.reportError(ex); }
}

SSSEobs = (() => {
	if(Services.prefs.getBoolPref("extensions." + objPathString + ".SessionSnapshotEnable")){
		this.SSSTimer?.cancel();
		delete this.SSSTimer;
		this.SSSTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		this.SSSTimer.initWithCallback(SSSCallback, Services.prefs.getIntPref("extensions." + objPathString + ".SessionSnapshotInterval") * 60000, Ci.nsITimer.TYPE_REPEATING_SLACK);
	} else
		this.SSSTimer?.cancel();
}).bind(this);

SSSIobs = ((subject, topic, data) => {
	if(Services.prefs.getBoolPref("extensions." + objPathString + ".SessionSnapshotEnable")){
		this.SSSTimer?.cancel();
		this.SSSTimer.initWithCallback(SSSCallback, Services.prefs.getIntPref(data) * 60000, Ci.nsITimer.TYPE_REPEATING_SLACK);
	} else
		this.SSSTimer?.cancel();
}).bind(this);