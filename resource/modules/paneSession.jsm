/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.1.20

this.paneSession = {
	manualAction: false,
	migratedBackupFile: null,
	_quickaccess: null,

	filestrings: {
		manual: objName+'-manual'
	},

	filenames: {
		previous: /^previous.json(lz4)$/,
		recovery: /^recovery.json(lz4)$/,
		recoveryBackup: /^recovery.bak(lz4)$/,
		upgrade: /^upgrade.jsonlz4-[0-9]{14}$/,
		tabMixPlus: /^tabmix_sessions-[0-9]{4}-[0-9]{2}-[0-9]{2}.rdf$/,
		manual: /^tabGroups-manual-[0-9]{8}-[0-9]{6}.json(lz4)?$/,
		update: /^tabGroups-update.js-[0-9]{13,14}.json(lz4)?$/,
		SSS: /^tabGroups-SSS-[0-9]{8}-[0-9]{6}.json(lz4)?$/
	},

	// some things needed to import from tab mix plus sessions
	TabmixSessionManager: null,
	TabmixConvertSession: null,
	RDFService: null,

	// backups are placed in profileDir/sessionstore-backups folder by default, where all other session-related backups are saved
	get backupsPath() { return (async ()=>{
		delete this.backupsPath;
		let profileDir = window.PathUtils?.profileDir ?? await window.PathUtils?.getProfileDir();
		this.backupsPath = window.PathUtils.join(profileDir, "sessionstore-backups");
		return this.backupsPath;
	})()},

	get alldataCheckbox() { return $('paneSession-backup-alldata'); },
	get alldata() { return this.alldataCheckbox.checked; },

	get backupBtn() { return $('paneSession-backup-button'); },
	get importBtn() { return $('paneSession-import-button'); },
	get loadFromFile() { return $('paneSession-load-from-file'); },
	get backups() { return $('paneSession-load-menu'); },
	get restoreHereBtn() { return $('paneSession-restore-here-button'); },
	get restoreInNewBtn() { return $('paneSession-restore-in-new-button'); },

	get clearBtn1() { return $('paneSession-clear-button-1'); },
	get clearBtn2() { return $('paneSession-clear-button-2'); },
	get clearBtn3() { return $('paneSession-clear-button-3'); },

	get tabList() { return $('paneSession-restore-tabList'); },
	get invalidNotice() { return $('paneSession-restore-invalid'); },
	get importfinishedNotice() { return $('paneSession-restore-finished'); },
	get autoloadedNotice() { return $('paneSession-backup-autoloaded'); },
	get clearChecklist() { return $('paneSession-clear-checklist'); },

	handleEvent: function(e) {
		switch(e.type) {
			case 'command':
				switch(e.target) {
					case this.alldataCheckbox:
						$('paneSession-backup-warning').hidden = !this.alldata;
						break;

					case this.backupBtn:
						this.backup();
						break;

					case this.loadFromFile:
						this.loadBackup();
						break;

					case this.importBtn:
						this.importSelected();
						break;

					case this.clearBtn1:
					case this.clearBtn2:
					case this.clearBtn3:
						this.clearData();
						break;

					case this.restoreHereBtn: {
						let savedGroups = Array.isArray(this.State.savedGroups) && JSON.parse(JSON.stringify(this.State.savedGroups));
						let topic = "sessionstore-browser-state-restored";
						let observer;
						let tabGroups = [];
						try {
							if(savedGroups) {
								Windows.callOnAll(win => {
									for(let group of win.gBrowser?.tabGroups || []) {
										if(group.saveOnWindowClose) {
											tabGroups.push(group);
											group.saveOnWindowClose = false;
										}
									}
								}, 'navigator:browser', null, true);
								observer = () => {
									Observers.remove(observer, topic);
									let ids = new Set();
									Windows.callOnAll(win => {
										for(let group of win.gBrowser?.tabGroups || []) { ids.add(group.id); }
									}, 'navigator:browser', null, true);
									Storage._scope.SessionStore.savedGroups.splice(0, Infinity, ...savedGroups.filter(group => !ids.has(group.id)));
								};
								Observers.add(observer, topic);
							}
							Storage._scope.SessionStore.setBrowserState(JSON.stringify(this.State));
						}
						catch(ex) {
							if(observer) { Observers.remove(observer, topic); }
							for(let group of tabGroups) { group.saveOnWindowClose = true; }
							throw ex;
						}
						break;
					}

					case this.restoreInNewBtn:
						this.restoreInNewWindow().catch(Cu.reportError);
						break;
				}
				break;

			// tree handlers
			case 'keydown':
				switch(e.key) {
					case " ":
						// Don't scroll the page when un/checking an item.
						e.preventDefault();
						// no break; continue to "Enter"

					case "Enter":
						this.toggleRowChecked(this.tabList.currentIndex);
						break;
				}
				break;

			case 'click':
			case 'dblclick':
				if(e.button != 0) { break; }

				let id = (e.type == 'click') ? "paneSession-restore-restore" : "paneSession-restore-title";
				let cell = treeView.treeBox.getCellAt(e.clientX, e.clientY);
				if(cell.col && cell.col.id == id) {
					this.toggleRowChecked(cell.row);
				}
				break;

			case 'popupshowing':
				this.buildBackupsMenu();
				break;
		}
	},

	init: function() {
		Listeners.add(this.alldataCheckbox, 'command', this);
		Listeners.add(this.backupBtn, 'command', this);
		Listeners.add(this.loadFromFile, 'command', this);
		Listeners.add(this.backups, 'popupshowing', this);
		Listeners.add(this.importBtn, 'command', this);
		Listeners.add(this.clearBtn1, 'command', this);
		Listeners.add(this.clearBtn2, 'command', this);
		Listeners.add(this.clearBtn3, 'command', this);
		Listeners.add(this.tabList, 'keydown', this, true);
		Listeners.add(this.tabList, 'click', this);
		Listeners.add(this.tabList, 'dblclick', this);
		Listeners.add(this.restoreHereBtn, 'command', this);
		Listeners.add(this.restoreInNewBtn, 'command', this);
		this.backupsPath;
	},

	uninit: function() {
		Timers.cancel('resetClear');

		Listeners.remove(this.alldataCheckbox, 'command', this);
		Listeners.remove(this.backupBtn, 'command', this);
		Listeners.remove(this.loadFromFile, 'command', this);
		Listeners.remove(this.backups, 'popupshowing', this);
		Listeners.remove(this.importBtn, 'command', this);
		Listeners.remove(this.clearBtn1, 'command', this);
		Listeners.remove(this.clearBtn2, 'command', this);
		Listeners.remove(this.clearBtn3, 'command', this);
		Listeners.remove(this.tabList, 'keydown', this, true);
		Listeners.remove(this.tabList, 'click', this);
		Listeners.remove(this.tabList, 'dblclick', this);
		Listeners.remove(this.restoreHereBtn, 'command', this);
		Listeners.remove(this.restoreInNewBtn, 'command', this);
	},

	backup: function() {
		controllers.showFilePicker(Ci.nsIFilePicker.modeSave, this.filestrings.manual, async (aFile) => {
			let backup = SessionState.createBackup(SessionStore.getCurrentState(true), this.alldata);
			for(let error of backup.errors) { Cu.reportError(error); }

			try {
				await window.IOUtils.writeJSON(aFile.path, backup.state, aFile.path.endsWith(".jsonlz4") ? {
					tmpPath: aFile.path.replace(".jsonlz4",".tmp"),
					compress: true,
				} : undefined);
				// Load the newly created file in the Restore Tab Groups block,
				// so that the user can confirm all the tabs and groups were backed up properly.
				// We read from the newly created file so that we're sure to show the info that was actually saved,
				// and not the info that's still in memory.
				this.loadSessionFile(aFile, false);
			}
			catch(ex) { Cu.reportError(ex); }
		}, this.backupsPath, true);
	},

	// If at any point this fails, it simply doesn't add the corresponding item to the menu
	// (if it fails here it's unlikely it will work when actually loading groups from these files anyway).
	buildBackupsMenu: async function() {
		let quickaccess = this._quickaccess = new Set();

		// Always clean up old entries.
		let child = this.backups.firstChild;
		while(child) {
			let next = child.nextSibling;
			if(!child.id) {
				child.remove();
			} else if(child != this.loadFromFile) {
				child.hidden = true;
			}
			child = next;
		}

		let profileDir = window.PathUtils?.profileDir ?? await window.PathUtils?.getProfileDir();
		if(this._quickaccess != quickaccess) { return; }

		// Don't throw immediately if any iteration fails, run all it can to add all the possible (valid) items.
		let exn = null;

		// iterate through all files in sessionstore-backups folder and add an item for each (valid) one
		let iterator;
		try {
			iterator = await window.IOUtils.getChildren(this.backupsPath);
			if(this._quickaccess != quickaccess) { return; }
			iterator.forEach((file) => {
				// a copy of the current session, for crash-protection
				if(this.filenames.recovery.test(window.PathUtils.filename(file))) {
					this.checkRecoveryFile(quickaccess, file, 'sessionRecovery', 'recovery');
				}
				// another crash-protection of the current session
				else if(this.filenames.recoveryBackup.test(window.PathUtils.filename(file)) || this.filenames.SSS.test(window.PathUtils.filename(file))) {
					this.checkRecoveryFile(quickaccess, file, 'recoveryBackup', 'recovery');
				}
				// the previous session
				else if(this.filenames.previous.test(window.PathUtils.filename(file))) {
					this.checkRecoveryFile(quickaccess, file, 'previousSession', 'recovery');
				}
				// backups made when Firefox updates itself
				else if(this.filenames.upgrade.test(window.PathUtils.filename(file))) {
					this.checkRecoveryFile(quickaccess, file, 'upgradeBackup', 'upgrade');
				}
				// backups created when the add-on is updated
				else if(this.filenames.update.test(window.PathUtils.filename(file))) {
					this.checkRecoveryFile(quickaccess, file, 'addonUpdateBackup', 'upgrade');
				}
				// this could be one of the backups manually created by the user, try to load it and see if we recognize it
				else if(this.filenames.manual.test(window.PathUtils.filename(file))) {
					this.checkRecoveryFile(quickaccess, file, 'manualBackup', 'manual');
				}
			});
		}
		catch(ex) {
			exn = exn || ex;
		}
		// Let's look for Tab Mix Plus's sessions and try to import from those as well.
		try {
			let addon = await AddonManager.getAddonByID('{dc572301-7619-498c-a57d-39143191b318}');
			if(this._quickaccess != quickaccess) { return; }
			if(addon && addon.isActive && Cc["@mozilla.org/rdf/rdf-service;1"]) {
				if(!this.TabmixSessionManager) {
					this.TabmixSessionManager = gWindow.TabmixSessionManager;
					this.TabmixConvertSession = gWindow.TabmixConvertSession;
					this.RDFService = Cc["@mozilla.org/rdf/rdf-service;1"].getService(Ci.nsIRDFService);
				}

				let tmpiterator;
				let tmpdir = window.PathUtils.join(profileDir, "sessionbackups");
				try {
					tmpiterator = await window.IOUtils.getChildren(tmpdir);
					if(this._quickaccess != quickaccess) { return; }
					tmpiterator.forEach((file) => {
						if(this.filenames.tabMixPlus.test(window.PathUtils.filename(file))) {
							this.checkTabMixPlusFile(quickaccess, file);
						}
					});
				}
				catch(ex) {
					exn = exn || ex;
				}
			}
		}
		catch(ex) {
			exn = exn || ex;
		}

		if(exn) { Cu.reportError(exn); }
	},

	checkRecoveryFile: async function(aQuickaccess, aPath, aName, aWhere) {
		try {
			let state = await window.IOUtils.readJSON(aPath, (aPath.includes(".jsonlz4") || aPath.includes(".baklz4")) ? { decompress: true } : null);
			this.verifyState(aQuickaccess, state, aPath, aName, aWhere);
		}
		catch(ex) {
			Cu.reportError(ex);
		}
	},

	checkTabMixPlusFile: function(aQuickaccess, aFile) {
		let tmpDATASource;

		try {
			tmpDATASource = this.TabmixSessionManager.DATASource;

			let path = window.PathUtils.toFileURI(aFile);
			this.TabmixSessionManager.DATASource = this.RDFService.GetDataSourceBlocking(path);

			// Each TMP file can hold several sessions.
			let sessions = this.TabmixSessionManager.getSessionList();
			for(let session of sessions.path) {
				try {
					this.verifyState(aQuickaccess, this.getStateForTabMixPlusData(session), { path, session }, 'tabMixPlus', 'tabMixPlus');
				}
				catch(ex) { Cu.reportError(ex); }
			}
		}
		catch(ex) {
			Cu.reportError(ex);
		}
		// Always make sure we restore TMP's current session state if there's one.
		finally {
			if(tmpDATASource) {
				this.TabmixSessionManager.DATASource = tmpDATASource;
			}
		}
	},

	getStateForTabMixPlusData: function(session) {
		let state = this.TabmixConvertSession.getSessionState(session);
		if(!state.tabsCount) { return state; }

		// TMP doesn't retrieve a lastUpdate value here, we need to get it ourselves
		let node = this.RDFService.GetResource(session);
		state.session = {
			lastUpdate: this.TabmixSessionManager.getLiteralValue(node, "timestamp", 0)
		};
		if(!state.session.lastUpdate) {
			let container = this.TabmixSessionManager.initContainer(node);
			let windowEnum = container.GetElements();
			while(windowEnum.hasMoreElements()) {
				let windowNode = windowEnum.getNext();
				let timestamp = this.TabmixSessionManager.getLiteralValue(windowNode, "timestamp", 0);
				state.session.lastUpdate = Math.max(state.session.lastUpdate, timestamp);
			}
		}

		return state;
	},

	verifyState: function(aQuickaccess, aState, aFile, aName, aWhere) {
		if(this._quickaccess != aQuickaccess) { return; }
		if(aState.session) {
			// Some sessions may not be modified between files, so they're essentially duplicates spread out over several files.
			// There's no need to show these in the quick access menu.
			let stateStr = JSON.stringify(aState);
			if(!aQuickaccess.has(stateStr)) {
				let date = aState.session.lastUpdate;
				this.createBackupEntry(aFile, aName, date, aWhere);
				aQuickaccess.add(stateStr);
			}
		}
	},

	createBackupEntry: function(aPath, aName, aDate, aWhere) {
		let date = new Date(aDate).toLocaleString();

		let item = document.createXULElement('menuitem');
		item.setAttribute('label', Strings.get('options', aName, [ [ '$date', date ] ]));
		item._date = aDate;
		item.handleEvent = (e) => {
			this.loadSessionFile(aPath, true, aWhere);
		};
		item.addEventListener('command', item);

		// make sure we unhide the separator for this category of backup entries
		let sibling = $('paneSession-load-separator-'+aWhere);
		sibling.hidden = false;

		// try to sort by date desc within this category
		while(sibling.nextSibling) {
			if(sibling.nextSibling.nodeName == 'menuseparator' || aDate <= sibling.nextSibling._date) { break; }
			sibling = sibling.nextSibling;
		}

		this.backups.insertBefore(item, sibling.nextSibling);
	},

	loadBackup: function() {
		controllers.showFilePicker(Ci.nsIFilePicker.modeOpen, null, (aFile) => {
			this.loadSessionFile(aFile, true);
		}, this.backupsPath, true);
	},

	loadSessionFile: async function(aFile, aManualAction, aSpecial) {
		let load = this._loadSessionFile = {};
		this.State = null;
		treeView.data = [];
		this.invalidNotice.hidden = true;
		this.tabList.hidden = true;
		this.importBtn.hidden = true;
		this.restoreHereBtn.hidden = true;
		this.restoreInNewBtn.hidden = true;
		this.autoloadedNotice.hidden = true;
		this.importfinishedNotice.hidden = true;
		this.manualAction = aManualAction;

		let tmpDATASource;
		try {
			if(aSpecial == 'tabMixPlus') {
				tmpDATASource = this.TabmixSessionManager.DATASource;
				this.TabmixSessionManager.DATASource = this.RDFService.GetDataSourceBlocking(aFile.path);

				let state = this.getStateForTabMixPlusData(aFile.session);
				if(!Array.isArray(state?.windows)) { throw new Error("Invalid session state"); }
				this.State = JSON.parse(JSON.stringify(state));
				this.readState(state);
				return;
			}

			let p = aFile.path || aFile;
			let state = await window.IOUtils.readJSON(p, p.match(".(bak|json)lz4")?.[0] ? { decompress: true } : null);
			if(this._loadSessionFile != load) { return; }
			if(!Array.isArray(state?.windows)) { throw new Error("Invalid session state"); }
			let LOCAL_PROTOCOLS = ["chrome:", "about:", "resource:", "data:"];
			await Promise.allSettled(state.windows.flatMap(w => w?.tabs || []).map(async tabData => {
				if (tabData?.image && !LOCAL_PROTOCOLS.some(protocol => tabData?.image.startsWith(protocol))){
					try {
						tabData.image = (await PlacesUtils.favicons.getFaviconForPage(PlacesUtils.toURI(tabData.entries[0].url))).dataURI.spec;
					} catch (ex) {
						Cu.reportError(ex);
					}
				}
			}));
			if(this._loadSessionFile != load) { return; }
			this.State = JSON.parse(JSON.stringify(state));
			this.readState(state);
		}
		catch(ex) {
			if(this._loadSessionFile != load) { return; }
			Cu.reportError(ex);
			this.invalidNotice.hidden = false;
		}
		// Always make sure we restore TMP's current session state if there's one.
		finally {
			if(tmpDATASource) {
				this.TabmixSessionManager.DATASource = tmpDATASource;
			}
		}
	},

	readState: function(state) {
		let pinnedGroupIdx = 0;
		let tabGroupIdx = 0;
		let windowIdx = 0;
		let windowStrings = new window.Localization(["browser/aboutSessionRestore.ftl"], true);

		treeView.data = [];
		for(let win of state.windows) {
			++windowIdx;
			if(!win.tabs) { continue; }
			let windowData = {
				label: windowStrings.formatValueSync("restore-page-window-label", { windowNumber: windowIdx }),
				open: true,
				checked: this.manualAction,
				groups: [],
				_window: win
			};

			let groups;
			let activeGroupId;
			try {
				let winGroups = JSON.parse(win.extData[Storage.kGroupsIdentifier]);
				groups = JSON.parse(win.extData[Storage.kGroupIdentifier]);
				if(winGroups.activeGroupId in groups) {
					activeGroupId = winGroups.activeGroupId;
				}
				// create a group specific for tabs without groups information (if any)
				else {
					let newGroupId = 1;
					while(newGroupId in groups) {
						newGroupId++;
					}
					activeGroupId = newGroupId;
					groups[activeGroupId] = { id: activeGroupId };
				}
			}
			catch(ex) {
				Services.console.logStringMessage(ex.name+': '+ex.message);

				// groups data is corrupted or missing, consider the whole window its own group
				activeGroupId = 1;
				groups = {
					1: { id: 1 }
				};
			}

			let pinned = [];
			let tabs = [];
			for(let tab of win.tabs) {
				if(tab.pinned) {
					pinned.push(tab);
				} else {
					try {
						tab._tabData = JSON.parse(tab.extData[Storage.kTabIdentifier]);
						if(!tab._tabData.groupID || !(tab._tabData.groupID in groups)) {
							// if the stored groupID does not exist in within the groups, default to the active group
							throw "Tab has an invalid groupID attached!";
						}
					}
					catch(ex) {
						Services.console.logStringMessage(ex.name+': '+ex.message);

						// I think it's possible that tabs created while TabView is closed could somehow skip the group registration.
						// Even if not, we squeeze in any ungrouped tabs into the "current" group of that window,
						// as that's the most likely case, or at least the most logical step to take in their case.
						tab._tabData = { groupID: activeGroupId };
					}
					tabs.push(tab);
				}
			}

			// show pinned tabs as if they had their own group
			if(pinned.length) {
				let label = Strings.get('TabView', 'restorePinned', [
					[ '$idx', ++pinnedGroupIdx ],
					[ '$tabs', pinned.length ]
				], pinned.length);
				let groupData = this.createGroupItem(pinnedGroupIdx, label, null, windowData);
				for(let tab of pinned) {
					this.createTabItem(groupData, tab);
				}
				windowData.groups.push(groupData);
			}

			// now divide the existing tab data into their own groups
			if(tabs.length) {
				for(let groupId in groups) {
					let groupTabs = tabs.filter(function(tab) {
						return !tab.pinned && tab._tabData.groupID == groupId;
					});
					// we only show group items for groups that actually have tabs
					if(groupTabs.length) {
						++tabGroupIdx;
						let group = groups[groupId];
						let label = group.title;
						if(label) {
							label = Strings.get('TabView', 'restoreNamedGroup', [
								[ '$name', label ],
								[ '$tabs', groupTabs.length ]
							], groupTabs.length);
						} else {
							label = Strings.get('TabView', 'restoreUnnamedGroup', [
								[ '$idx', tabGroupIdx ],
								[ '$tabs', groupTabs.length ]
							], groupTabs.length);
						}
						let groupData = this.createGroupItem(tabGroupIdx, label, group, windowData);
						for(let tab of groupTabs) {
							this.createTabItem(groupData, tab);
						}
						windowData.groups.push(groupData);
					}
				}
			}

			if(windowData.groups.length) {
				treeView.data.push(windowData);
				for(let group of windowData.groups) {
					treeView.data.push(group, ...group.tabs);
				}
			}
		}

		if(treeView.data.length) {
			this.invalidNotice.hidden = true;
			this.tabList.hidden = false;
			this.importBtn.hidden = false;
			this.restoreHereBtn.hidden = false;
			this.restoreInNewBtn.hidden = false;
			this.tabList.view = treeView;
			this.tabList.view.selection.select(0);
			if(this.manualAction) {
				this.tabList.scrollIntoView();
			}
		}
		else {
			this.invalidNotice.hidden = false;
			this.tabList.hidden = true;
			this.importBtn.hidden = true;
			this.restoreHereBtn.hidden = true;
			this.restoreInNewBtn.hidden = true;
		}
		this.autoloadedNotice.hidden = this.manualAction;
		this.importfinishedNotice.hidden = true;
	},

	createGroupItem: function(aIdx, aLabel, aGroup, aWindowData) {
		let group = {
			label: aLabel,
			open: true,
			checked: this.manualAction,
			ix: aIdx,
			tabs: [],
			parent: aWindowData
		};
		if(!aGroup) {
			group.pinned = true;
		} else {
			group._group = aGroup;
		}
		return group;
	},

	createTabItem: function(groupData, tab) {
		let entry = tab.entries && tab.entries[tab.index -1];
		if(!entry) { return; }

		let iconURL = tab.image || null;
		// don't initiate a connection just to fetch a favicon (see bug 462863)
		if(/^https?:/.test(iconURL)) {
			iconURL = "moz-anno:favicon:" + iconURL;
		}
		groupData.tabs.push({
			label: entry.title || entry.url,
			checked: this.manualAction,
			src: iconURL,
			_tab: tab,
			parent: groupData
		});
	},

	sessionIds: function() {
		return { nextSplitViewId: typeof Storage._scope.SessionStore.getNextSplitViewId == "function" ? () => Storage._scope.SessionStore.getNextSplitViewId() : null, nextNativeGroupId: () => Services.uuid.generateUUID().toString() };
	},

	importSelected: function() {
		if(!treeView.data.some(item => item.groups?.some(group => group.checked !== false))) { return; }

		// first make sure the TabView frame isn't initialized, we don't want it interfering
		gWindow[objName].TabView._deinitFrame();

		// If TMP is initialized, it could reverse the order of the imported tabs, we flip its preference temporarily to make sure it doesn't.
		let restoreTMP = Prefs.openTabNext;
		if(restoreTMP) {
			Prefs.openTabNext = false;
		}

		// initialize window if necessary, just in case
		Storage._scope.SessionStore.ensureInitialized(gWindow);
		let plan = SessionState.prepareImport(treeView.data, Storage.readGroupItemsData(gWindow), this.sessionIds());

		for(let group of plan.groups) { Storage.saveGroupItem(gWindow, group); }

		Storage._scope.SessionStore.setWindowState(gWindow, { windows: [ plan.windowState ] }, false);
		Storage.saveGroupItemsData(gWindow, plan.groupItems);

		// We can restore TMP's preferences now if it was flipped before.
		if(restoreTMP) {
			Prefs.openTabNext = true;
		}

		this.autoloadedNotice.hidden = true;
		this.invalidNotice.hidden = true;
		this.tabList.hidden = true;
		this.importBtn.hidden = true;
		this.restoreHereBtn.hidden = true;
		this.restoreInNewBtn.hidden = true;
		this.importfinishedNotice.hidden = false;
		this.importfinishedNotice.scrollIntoView();
	},

	restoreInNewWindow: async function() {
		let openerWindow = gWindow;
		let win = await ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs").BrowserWindowTracker.promiseOpenWindow({ openerWindow, private: PrivateBrowsing.isPrivate(openerWindow) });
		Storage._scope.SessionStore.setWindowState(win, SessionState.prepareRestore(this.State, this.sessionIds()), true);

		this.autoloadedNotice.hidden = true;
		this.invalidNotice.hidden = true;
		this.tabList.hidden = true;
		this.importBtn.hidden = true;
		this.restoreHereBtn.hidden = true;
		this.restoreInNewBtn.hidden = true;
	},

	toggleRowChecked: function(aIx) {
		let checkedState = function(aItems) {
			return aItems.every(function(aItem) { return aItem.checked === true; }) ? true : aItems.some(function(aItem) { return aItem.checked !== false; }) ? 0 : false;
		};
		let invalidate = function(aItem) {
			let row = treeView.data.indexOf(aItem);
			if(row != -1) { treeView.treeBox.invalidateRow(row); }
		};
		let setChecked = function(aItem, aChecked) {
			aItem.checked = aChecked;
			invalidate(aItem);
			for(let child of aItem.groups || aItem.tabs || []) {
				setChecked(child, aChecked);
			}
		};

		let item = treeView.data[aIx];
		setChecked(item, !item.checked);
		for(let parent = item.parent; parent; parent = parent.parent) {
			parent.checked = checkedState(parent.groups || parent.tabs);
			invalidate(parent);
		}
	},

	clearData: function() {
		let phase = this.clearChecklist.getAttribute('phase');
		switch(phase) {
			case '1':
				setAttribute(this.clearChecklist, 'phase', '2');
				this.resetClear();
				break;

			case '2':
				setAttribute(this.clearChecklist, 'phase', '3');
				this.resetClear();
				break;

			case '3':
				Timers.cancel('resetClear');

				let state = SessionStore.getBrowserState();
				try {
					state = JSON.parse(state);
				}
				catch(ex) {
					Cu.reportError(ex);
					return;
				}
				state = SessionState.removeTabGroups(state);
				// SessionStore.savedGroups exposes the live internal array, so scrub it before restoring the transformed browser state.
				for(let group of SessionStore.savedGroups || []) {
					for(let closed of group.tabs || []) {
						let tab = closed.state || closed;
						if(tab.extData) { delete tab.extData[Storage.kTabIdentifier]; }
					}
				}
				state = JSON.stringify(state);
				// The current window can't be closed, otherwise the new session data for other opened windows wouldn't be properly saved.
				// (http://mxr.mozilla.org/mozilla-central/source/browser/components/sessionstore/SessionStore.jsm -> SessionStoreInternal.setBrowserState())
				// Instead, we'll force an unloaded state of all tabs, since they will be forced to reload when reselected (we don't do this, SessionRestore does).
				for(let tab of gWindow.gBrowser.tabs) {
					if(!tab.pinned) {
						let browser = tab.linkedBrowser;
						// Browser freezes when trying to load a uri into a locked tab with TMP enabled;
						// see http://tabmixplus.org/forum/viewtopic.php?f=2&t=19506&sid=84a9d8b600b8df0b83196f70e547a75e&p=70286#p70286
						if(gWindow.Tabmix) {
							browser.tabmix_allowLoad = true;
						}
						browser.loadURI("about:blank",{triggeringPrincipal: browser.contentPrincipal});
					}
				}

				let wins = [];
				Windows.callOnAll(function(win) {
					// don't close the current window
					if(win != gWindow) {
						wins.unshift(win);
					}
				}, 'navigator:browser');

				// close all windows including the current one, otherwise its tabs would technically be "pending" even though their contents were already loaded
				for(let win of wins) {
					win.close();
				}

				SessionStore.setBrowserState(state);
				break;
		}
	},

	// reset the clear block after a few seconds, to ensure the user actually wants to clear the data
	resetClear: function() {
		Timers.init('resetClear', () => {
			setAttribute(this.clearChecklist, 'phase', '1');
		}, 10000);
	},

};

// adapted from http://mxr.mozilla.org/mozilla-central/source/browser/components/sessionstore/content/aboutSessionRestore.js
this.treeView = {
	data: [],
	treeBox: null,
	selection: null,

	get rowCount() { return this.data.length; },
	setTree: function(treeBox) { this.treeBox = treeBox; },
	getCellText: function(idx, column) { return this.data[idx].label; },
	isContainer: function(idx) { return "open" in this.data[idx]; },
	getCellValue: function(idx, column) { return this.data[idx].checked; },
	isContainerOpen: function(idx) { return this.data[idx].open; },
	isContainerEmpty: function(idx) { return false; },
	isSeparator: function(idx) { return false; },
	isSorted: function() { return false; },
	isEditable: function(idx, column) { return false; },
	canDrop: function(idx, orientation, dt) { return false; },
	getLevel: function(idx) {
		let level = 0;
		for(let item = this.data[idx]; item.parent; item = item.parent) { level++; }
		return level;
	},

	getParentIndex: function(idx) {
		return this.data.indexOf(this.data[idx].parent);
	},

	hasNextSibling: function(idx, after) {
		let thisLevel = this.getLevel(idx);
		for(let t = after +1; t < this.data.length; t++) {
			if(this.getLevel(t) <= thisLevel) {
				return this.getLevel(t) == thisLevel;
			}
		}
		return false;
	},

	toggleOpenState: function(idx) {
		if(!this.isContainer(idx)) { return; }

		let item = this.data[idx];
		if(item.open) {
			// remove this group's tab rows from the view
			let thisLevel = this.getLevel(idx);
			let t;
			for(t = idx +1; t < this.data.length && this.getLevel(t) > thisLevel; t++);
			let deletecount = t -idx -1;
			this.data.splice(idx +1, deletecount);
			this.treeBox.rowCountChanged(idx +1, -deletecount);
		}
		else {
			// add this item's visible descendants back to the view
			let toinsert = [];
			if(item.groups) {
				for(let group of item.groups) {
					toinsert.push(group);
					if(group.open) { toinsert.push(...group.tabs); }
				}
			}
			else {
				toinsert = item.tabs;
			}
			this.data.splice(idx +1, 0, ...toinsert);
			this.treeBox.rowCountChanged(idx +1, toinsert.length);
		}
		item.open = !item.open;
		this.treeBox.invalidateRow(idx);
	},

	getCellProperties: function(idx, column) {
		if(column.id == "paneSession-restore-restore" && this.isContainer(idx) && this.data[idx].checked === 0) {
			return "partial";
		}
		if(column.id == "paneSession-restore-title") {
			return this.getImageSrc(idx, column) ? "icon" : "noicon";
		}
		return "";
	},

	getRowProperties: function(idx) {
		let item = this.data[idx];
		let groupState = item.tabs ? item : item.parent;
		if(groupState && groupState.tabs && groupState.ix % 2 != 0) {
			return "alternate";
		}

		return "";
	},

	getImageSrc: function(idx, column) {
		if(column.id == "paneSession-restore-title") {
			return this.data[idx].src || null;
		}
		return null;
	},

	getProgressMode: function(idx, column) {},
	cycleHeader: function(column) {},
	cycleCell: function(idx, column) {},
	selectionChanged: function() {},
	performAction: function(action) {},
	performActionOnCell: function(action, index, column) {},
	getColumnProperties: function(column) { return ""; }
};


Modules.LOADMODULE = function() {
	Modules.load('SessionState');
	paneSession.init();
};

Modules.UNLOADMODULE = function() {
	paneSession.uninit();
	Modules.unload('SessionState');
};
