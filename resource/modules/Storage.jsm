/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.2.1

this.Storage = {
	kGroupIdentifier: "tabview-group",
	kGroupsIdentifier: "tabview-groups",
	kTabIdentifier: "tabview-tab",
	kUIIdentifier: "tabview-ui",

	_migrationScope: null,
	_scope: null,

	// Saves the data for a single tab.
	saveTab: function(tab, data) {
		SessionStore.setCustomTabValue(tab, this.kTabIdentifier, JSON.stringify(data));
	},

	// Load tab data from session store and return it.
	getTabData: function(tab) {
		try {
			let tabData = SessionStore.getCustomTabValue(tab, this.kTabIdentifier);
			if(tabData) {
				return JSON.parse(tabData);
			}
		}
		catch(ex) { /* getTabValue will fail if the property doesn't exist. */ }

		return null;
	},

	// Returns the current state of the given tab.
	getTabState: function(tab) {
		try {
			let tabState = SessionStore.getTabState(tab);
			if(tabState) {
				return JSON.parse(tabState);
			}
		}
		catch(ex) {}

		return null;
	},

	// Saves the data for a single groupItem, associated with a specific window.
	saveGroupItem: function(win, data) {
		let id = data.id;
		let existingData = this.readGroupItemData(win) || {};
		existingData[id] = data;
		this.saveData(win, this.kGroupIdentifier, existingData);
	},

	// Deletes the data for a single groupItem from the given window.
	deleteGroupItem: function(win, id) {
		let existingData = this.readGroupItemData(win) || {};
		delete existingData[id];
		this.saveData(win, this.kGroupIdentifier, existingData);
	},

	// Returns the data for all groupItems associated with the given window.
	readGroupItemData: function(win) {
		return this.readData(win, this.kGroupIdentifier);
	},

	// Returns the current busyState for the given window.
	readWindowBusyState: function(win) {
		let state;

		try {
			let data = SessionStore.getWindowState(win);
			if(data) {
				state = JSON.parse(data);
			}
		}
		catch(ex) {}

		return (state && state.windows[0].busy);
	},

	// Saves the global data for the <GroupItems> singleton for the given window.
	saveGroupItemsData: function(win, data) {
		this.saveData(win, this.kGroupsIdentifier, data);
	},

	// Reads the global data for the <GroupItems> singleton for the given window.
	readGroupItemsData: function(win) {
		return this.readData(win, this.kGroupsIdentifier);
	},

	// Saves the global data for the <UIManager> singleton for the given window.
	saveUIData: function(win, data) {
		this.saveData(win, this.kUIIdentifier, data);
	},

	// Reads the global data for the <UIManager> singleton for the given window.
	readUIData: function(win) {
		return this.readData(win, this.kUIIdentifier);
	},

	// Generic routine for saving data to a window.
	saveData: function(win, id, data) {
		try {
			SessionStore.setCustomWindowValue(win, id, JSON.stringify(data));
		}
		catch(ex) {}
	},

	// Generic routine for reading data from a window.
	readData: function(win, id) {
		try {
			let data = SessionStore.getCustomWindowValue(win, id);
			if(data) {
				return JSON.parse(data);
			}
		}
		catch(ex) {}

		return null;
	}
};

Modules.LOADMODULE = function() {
	Storage._scope = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs");
	self.SessionStore = Storage._scope.SessionStore;
	Storage._migrationScope = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
		sandboxPrototype: Storage,
		wantGlobalProperties: ['ChromeUtils'],
		wantExportHelpers: true,
	});

	Storage._prepWindowToRestoreInto = function(aWindow) {
		if(!aWindow) { return; }

		// Step 1 of processing:
		// Inspect extData for Tab Groups identifiers. If found, then we want to inspect further.
		// If there is a single group, then we can use this window. If there are multiple groups then we won't use this window.
		let groupsData = SessionStore.getCustomWindowValue(aWindow, Storage.kGroupsIdentifier);
		if(groupsData) {
			groupsData = JSON.parse(groupsData);

			// If there are multiple groups, we don't want to use this window.
			if (groupsData.totalNumber > 1) {
				if (aWindow.__SS_lastSessionWindowID) {
					aWindow["_" + objPathString + "__SS_lastSessionWindowID"] = aWindow.__SS_lastSessionWindowID;
					aWindow.__SS_lastSessionWindowID = "_" + objPathString + "_removed_" + AddonData.initTime;
					let t = Storage._scope._LastSession.getState()?.windows
						.find(w => w.__lastSessionWindowID == aWindow["_" + objPathString + "__SS_lastSessionWindowID"]);
					if (t) {
						t["_" + objPathString + "__lastSessionWindowID"] = t.__lastSessionWindowID;
						delete t.__lastSessionWindowID;
					}
				}
			} else {
				if (aWindow["_" + objPathString + "__SS_lastSessionWindowID"]) {
					aWindow.__SS_lastSessionWindowID = aWindow["_" + objPathString + "__SS_lastSessionWindowID"];
					let t = Storage._scope._LastSession.getState()?.windows
						.find(w => w["_" + objPathString + "__lastSessionWindowID"] == aWindow["_" + objPathString + "__SS_lastSessionWindowID"]);
					if (t) t.__lastSessionWindowID = t["_" + objPathString + "__lastSessionWindowID"];
				}
			}
		}
	};

	Storage._WindowRestoring = e =>{
		// Deinitialize tab view in any window that will have its session overwritten.
		// Nothing in TabView will be useful anyway, just let it reinistialize if/when necessary later by itself.
		if(window.TabView) {
			window.TabView._deinitFrame();
		}
	}

	Storage._WindowRestored = e => {
		// Update our button's label, to reflect the groups data in the new/different session.
		if(window.TabView) {
			window.TabView.setButtonLabel();
		}

		if(window.TabView && !window.TabView._iframe && window.TabView._initialized) window.TabView._initFrame(() => {
			window.TabView._window[objName].GroupItems.resumeArrange();
			window.TabView._window[objName].TabItems.resumePainting();
			window.TabView._window[objName].GroupItems.pauseArrange();
			window.TabView._window[objName].TabItems.pausePainting();
			window.gBrowser.tabs.forEach(t => t.addEventListener('SSTabRestored', _ => {
				window.TabView._window[objName].TabItems.startHeartbeatHidden();
				window.TabView._window[objName].TabItems.update(t);
			}, {once: true}));
		});
	}

	Storage._obs = function obs(subject, topic) {
		try { Storage._prepWindowToRestoreInto(window); } catch (e) { Cu.reportError(e); }
	}
	Storage._obs();
	Services.obs.addObserver(Storage._obs, "sessionstore-windows-restored");
	Services.obs.addObserver(Storage._obs, "sessionstore-initiating-manual-restore");
	window.addEventListener("SSWindowRestoring", Storage._WindowRestoring);
	window.addEventListener("SSWindowRestored", Storage._WindowRestored);

	new Promise(async r => {
		let { SessionMigration } = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionMigration.sys.mjs");
		if (SessionMigration.migrate['_Piggyback_'])
			return;
		var orig = SessionMigration.migrate;
		Cu.evalInSandbox((await (await window.fetch('resource:///modules/sessionstore/SessionMigration.sys.mjs')).text())
			.replace(`return tab;`, `
        // The tabgroup info is in the extData, so we need to get it out.
        if (oldTab.extData && tabview - tab in oldTab.extData) {
          tab.extData = { [undefined]: oldTab.extData[undefined] };
        }

        return tab;`
			).replace(`win.selected = oldWin.selected;`, `
        // There are various tabgroup-related attributes that we need to get out of the session restore data for the window, too.
      if (oldWin.extData) {
        for (let k of Object.keys(oldWin.extData)) {
          if (k.startsWith('tabview-')) {
            win.extData[k] = oldWin.extData[k];
          }
        }
      }

      win.selected = oldWin.selected;`).replace(/\nexport /, '')
			+ `\n_migrationScope.SessionMigration = SessionMigration ;`, Storage._migrationScope);
		SessionMigration.migrate = Storage._migrationScope.SessionMigration.migrate;
		SessionMigration.migrate['_Piggyback_'] = orig;
	});
};

Modules.UNLOADMODULE = function() {
	Services.obs.removeObserver(Storage._obs, "sessionstore-windows-restored");
	Services.obs.removeObserver(Storage._obs, "sessionstore-initiating-manual-restore");
	if (window["_" + objPathString + "__SS_lastSessionWindowID"]) {
		window.__SS_lastSessionWindowID = window["_" + objPathString + "__SS_lastSessionWindowID"];
		let t = Storage._scope._LastSession.getState()?.windows
			.find(w => w["_" + objPathString + "__lastSessionWindowID"] == window["_" + objPathString + "__SS_lastSessionWindowID"]);
		if (t) t.__lastSessionWindowID = t["_" + objPathString + "__lastSessionWindowID"];
	}
	window.removeEventListener("SSWindowRestoring", Storage._WindowRestoring);
	window.removeEventListener("SSWindowRestored", Storage._WindowRestored);
	let { SessionMigration } = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionMigration.sys.mjs");
	if (SessionMigration.migrate['_Piggyback_']) {
		SessionMigration.migrate = SessionMigration.migrate['_Piggyback_']
		delete SessionMigration.migrate['_Piggyback_'];
	}
	Cu.nukeSandbox(Storage._migrationScope);
};
