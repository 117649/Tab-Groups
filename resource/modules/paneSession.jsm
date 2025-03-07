/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.1.14

this.paneSession = {
	manualAction: false,
	migratedBackupFile: null,
	_deferredPromises: new Set(),
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

					case this.restoreHereBtn:
						Storage._scope.SessionStore.setBrowserState(JSON.stringify(this.State))
						break;

					case this.restoreInNewBtn:
						this.restoreInNewWindow();
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
		controllers.showFilePicker(Ci.nsIFilePicker.modeSave, this.filestrings.manual, (aFile) => {
			let state = SessionStore.getCurrentState();
			let save;

			// if backing up all session data it's simple, just save everything
			if(this.alldata) {
				save = state;
			}
			// otherwise we'll need to build a new object containing only the relevant information
			else {
				// We'll skip closed windows and tabs, at least for now, I think this will work for most use cases though.
				let saveData = {
					version: [ objName, 1 ],
					session: state.session,
					windows: []
				};

				let anonGroupId = 0;
				if(state.windows) {
					for(let win of state.windows) {
						let winData = {
							tabs: [],
							extData: {}
						};

						if(Array.isArray(win.tabs)) {
							for(let tab of win.tabs) {
								try {
									// don't save tab history, only the latest (current) visible entry
									let i = tab.index -1;
									let current = tab.entries[i];

									let saveTab = {
										entries: [ {
											url: current.url,
											title: current.title,
											charset: current.charset,
											ID: current.ID,
											persist: current.persist
										} ],
										lastAccessed: "0",
										hidden: tab.hidden,
										attributes: {},
										extData: {},
										index: 1
									};

									if(tab.lastAccessed) {
										saveTab.lastAccessed = tab.lastAccessed;
									}
									if(tab.pinned) {
										saveTab.pinned = tab.pinned;
									}
									if(tab.extData) {
										for(let x in tab.extData) {
											saveTab.extData[x] = tab.extData[x];
										}
									}
									if(tab.attributes) {
										for(let x in tab.attributes) {
											saveTab.attributes[x] = tab.attributes[x];
										}
									}
									if(tab.image) {
										saveTab.image = tab.image;
									}

									winData.tabs.push(saveTab);
								}
								catch(ex) { Cu.reportError(ex); }
							}
						}

						if(win.extData) {
							if(win.extData[Storage.kGroupIdentifier]) {
								winData.extData[Storage.kGroupIdentifier] = win.extData[Storage.kGroupIdentifier];
							}
							if(win.extData[Storage.kGroupsIdentifier]) {
								winData.extData[Storage.kGroupsIdentifier] = win.extData[Storage.kGroupsIdentifier];
							}
						}

						saveData.windows.push(winData);
					}
				}

				save = saveData;
			}

			window.IOUtils.writeJSON(aFile.path, save, aFile.path.endsWith(".jsonlz4") ? {
				tmpPath: aFile.path.replace(".jsonlz4",".tmp"),
				compress: true,
			} : undefined).then(() => {
				// Load the newly created file in the Restore Tab Groups block,
				// so that the user can confirm all the tabs and groups were backed up properly.
				// We read from the newly created file so that we're sure to show the info that was actually saved,
				// and not the info that's still in memory.
				this.loadSessionFile(aFile, false);
			});
		}, this.backupsPath, true);
	},

	// If at any point this fails, it simply doesn't add the corresponding item to the menu
	// (if it fails here it's unlikely it will work when actually loading groups from these files anyway).
	buildBackupsMenu: async function() {
		// Reject any pending tasks, we'll reschedule these ops again.
		// There's no need to clear afterwards, rejecting the promise removes it from the Set.
		for(let deferred of this._deferredPromises) {
			deferred.resolve();
		}
		this._quickaccess = new Set();

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

		// Don't throw immediately if any iteration fails, run all it can to add all the possible (valid) items.
		let exn = null;

		// iterate through all files in sessionstore-backups folder and add an item for each (valid) one
		let iterator;
		try {
			iterator = await window.IOUtils.getChildren(this.backupsPath);
			iterator.forEach((file) => {
				// a copy of the current session, for crash-protection
				if(this.filenames.recovery.test(window.PathUtils.filename(file))) {
					this.deferredPromise((deferred) => {
						this.checkRecoveryFile(deferred, file, 'sessionRecovery', 'recovery');
					});
				}
				// another crash-protection of the current session
				else if(this.filenames.recoveryBackup.test(window.PathUtils.filename(file)) || this.filenames.SSS.test(window.PathUtils.filename(file))) {
					this.deferredPromise((deferred) => {
						this.checkRecoveryFile(deferred, file, 'recoveryBackup', 'recovery');
					});
				}
				// the previous session
				else if(this.filenames.previous.test(window.PathUtils.filename(file))) {
					this.deferredPromise((deferred) => {
						this.checkRecoveryFile(deferred, file, 'previousSession', 'recovery');
					});
				}
				// backups made when Firefox updates itself
				else if(this.filenames.upgrade.test(window.PathUtils.filename(file))) {
					this.deferredPromise((deferred) => {
						this.checkRecoveryFile(deferred, file, 'upgradeBackup', 'upgrade');
					});
				}
				// backups created when the add-on is updated
				else if(this.filenames.update.test(window.PathUtils.filename(file))) {
					this.deferredPromise((deferred) => {
						this.checkRecoveryFile(deferred, file, 'addonUpdateBackup', 'upgrade');
					});
				}
				// this could be one of the backups manually created by the user, try to load it and see if we recognize it
				else if(this.filenames.manual.test(window.PathUtils.filename(file))) {
					this.deferredPromise((deferred) => {
						this.checkRecoveryFile(deferred, file, 'manualBackup', 'manual');
					});
				}
			});
		}
		catch(ex) {
			exn = exn || ex;
		}

		// Let's look for Tab Mix Plus's sessions and try to import from those as well.
		AddonManager.getAddonByID('{dc572301-7619-498c-a57d-39143191b318}', async (addon) => {
			if(addon && addon.isActive) {
				if(!this.TabmixSessionManager) {
					this.TabmixSessionManager = gWindow.TabmixSessionManager;
					this.TabmixConvertSession = gWindow.TabmixConvertSession;
					this.RDFService = Cc["@mozilla.org/rdf/rdf-service;1"].getService(Ci.nsIRDFService);
				}

				let tmpiterator;
				let tmpdir = window.PathUtils.join(profileDir, "sessionbackups");
				try {
					tmpiterator = await window.IOUtils.getChildren(tmpdir);
					tmpiterator.forEach((file) => {
						if(this.filenames.tabMixPlus.test(window.PathUtils.filename(file))) {
							this.checkTabMixPlusFile(file);
						}
					});
				}
				catch(ex) {
					exn = exn || ex;
				}
			}
		});

		if(exn) { throw exn; }
	},

	// Constructs a deferred promise object to be stored in a Set() that either self-removes or can be rejected and cleaned from the outside.
	// The executor is passed this deferred object as its single argument.
	deferredPromise: function(executor) {
		// This is the basis of this deferred object, with accessor methods for resolving and rejecting its promise.
		let deferred = {
			resolve: function() {
				paneSession._deferredPromises.delete(this);
				this._resolve();
			},

			reject: function(r) {
				paneSession._deferredPromises.delete(this);
				this._reject(r);
			}
		};

		// Init the actual promise.
		deferred.promise = new Promise((resolve, reject) => {
			// Store the resolve and reject methods in the deferred object.
			deferred._resolve = resolve;
			deferred._reject = reject;

			// Pass the deferred object to the executor, so it can resolve itself as well.
			executor(deferred);
		});

		// Add this deferred promise to the Set() so we can keep track of it.
		this._deferredPromises.add(deferred);

		return deferred;
	},

	checkRecoveryFile: async function(aDeferred, aPath, aName, aWhere) {
		let state = await window.IOUtils.readJSON(aPath, (aPath.includes(".jsonlz4") || aPath.includes(".baklz4")) ? { decompress: true } : null);
		this.verifyState(aDeferred, state, aPath, aName, aWhere);
	},

	checkTabMixPlusFile: function(aFile) {
		let tmpDATASource;

		try {
			tmpDATASource = this.TabmixSessionManager.DATASource;

			let path = window.PathUtils.toFileURI(aFile);
			this.TabmixSessionManager.DATASource = this.RDFService.GetDataSourceBlocking(path);

			// Each TMP file can hold several sessions.
			let sessions = this.TabmixSessionManager.getSessionList();
			for(let x of sessions.path) {
				let session = x;
				this.deferredPromise((deferred) => {
					let state = this.getStateForTabMixPlusData(session);
					this.verifyState(deferred, state, { path, session }, 'tabMixPlus', 'tabMixPlus');
				});
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

	verifyState: function(aDeferred, aState, aFile, aName, aWhere) {
		if(aState.session) {
			// Some sessions may not be modified between files, so they're essentially duplicates spread out over several files.
			// There's no need to show these in the quick access menu.
			let stateStr = JSON.stringify(aState);
			if(!this._quickaccess.has(stateStr)) {
				let date = aState.session.lastUpdate;
				this.createBackupEntry(aFile, aName, date, aWhere);
				this._quickaccess.add(stateStr);
			}
		}
		aDeferred.resolve();
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

	loadSessionFile: function(aFile, aManualAction, aSpecial) {
		if(aSpecial == 'tabMixPlus') {
			let tmpDATASource;
			try {
				tmpDATASource = this.TabmixSessionManager.DATASource;
				this.TabmixSessionManager.DATASource = this.RDFService.GetDataSourceBlocking(aFile.path);

				let state = this.getStateForTabMixPlusData(aFile.session);
				this.readState(state);
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
			return;
		}

		let p = aFile.path || aFile;
		window.IOUtils.readUTF8(p, p.match(".(bak|json)lz4")?.[0] ? { decompress: true } : null).then(async (savedState) => {

			this.manualAction = aManualAction;

			let state;
			try {
				state = this.getStateForData(savedState);
			}
			catch(ex) {
				Cu.reportError(ex);

				this.invalidNotice.hidden = false;
				this.tabList.hidden = true;
				return;
			}
			await Promise.allSettled(state.windows.flatMap(w=>w?.tabs).map(async tabData=>{
				function base64EncodeString(aString) {
					let stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
						Ci.nsIStringInputStream
					);
					stream.setData(aString, aString.length);
					let encoder = Cc["@mozilla.org/scriptablebase64encoder;1"].createInstance(
						Ci.nsIScriptableBase64Encoder
					);
					return encoder.encodeToString(stream, aString.length);
				}
	
				let LOCAL_PROTOCOLS = ["chrome:", "about:", "resource:", "data:"];
				if (tabData?.image && !LOCAL_PROTOCOLS.some(protocol => tabData?.image.startsWith(protocol))){
					let favicon;
					let faviconContents;
					try {
						favicon = await PlacesUtils.promiseFaviconData(tabData.entries[0].url); 
						faviconContents =
							"data:image/png;base64," +
							base64EncodeString(String.fromCharCode.apply(String, favicon.data))
					} catch (ex) {
						Cu.reportError("Unexpected Error trying to fetch icon data");
					};
					if(faviconContents) tabData.image = faviconContents;
				}
			}));
			this.State = window.structuredClone(state);
			this.readState(state);
		});
	},

	getStateForData: function(data) {
		return JSON.parse(data);
	},

	readState: function(state) {
		let pinnedGroupIdx = 0;
		let tabGroupIdx = 0;

		treeView.data = [];
		for(let win of state.windows) {
			if(!win.tabs) { continue; }

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
				let groupData = this.createGroupItem(pinnedGroupIdx, label);
				for(let tab of pinned) {
					this.createTabItem(groupData, tab);
				}
				treeView.data.push(groupData);
				for(let tab of groupData.tabs) {
					treeView.data.push(tab);
				}
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
						let groupData = this.createGroupItem(tabGroupIdx, label, group);
						for(let tab of groupTabs) {
							this.createTabItem(groupData, tab);
						}
						treeView.data.push(groupData);
						for(let tab of groupData.tabs) {
							treeView.data.push(tab);
						}
					}
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

	createGroupItem: function(aIdx, aLabel, aGroup) {
		let group = {
			label: aLabel,
			open: true,
			checked: this.manualAction,
			ix: aIdx,
			tabs: []
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

	importSelected: function() {
		let importGroups = treeView.data.filter(function(item, idx) { return treeView.isContainer(idx) && item.checked !== false; });

		// no items are selected, no-op
		if(!importGroups.length) { return; }

		// first make sure the TabView frame isn't initialized, we don't want it interfering
		gWindow[objName].TabView._deinitFrame();

		// If TMP is initialized, it could reverse the order of the imported tabs, we flip its preference temporarily to make sure it doesn't.
		let restoreTMP = Prefs.openTabNext;
		if(restoreTMP) {
			Prefs.openTabNext = false;
		}

		// initialize window if necessary, just in case
		Storage._scope.SessionStore.ensureInitialized(gWindow);

		// get the next id to be used for the imported groups
		let groupItems = Storage.readGroupItemsData(gWindow) || {};
		if(!groupItems.nextID) {
			groupItems.nextID = 1;
		}
		if(!groupItems.totalNumber) {
			groupItems.totalNumber = 0;
		}

		let restoreTabs = [];

		for(let group of importGroups) {
			// pinned tabs are direct, just append and restore
			if(group.pinned) {
				for(let tab of group.tabs) {
					if(!tab.checked) { continue; }

					// these tabs are pinned, so they can't be hidden, make sure this is respected
					tab._tab.pinned = true;
					tab._tab.hidden = false;

					restoreTabs.push(tab._tab);
				}
				continue;
			}

			let groupID = groupItems.nextID++;
			let groupData = group._group;
			groupData.id = groupID;

			// first append the imported group into the session data
			Storage.saveGroupItem(gWindow, groupData);
			groupItems.totalNumber++;

			for(let tab of group.tabs) {
				if(!tab.checked) { continue; }

				// we are creating a new id for this group, make sure its tabs know this
				tab._tab._tabData.groupID = groupID;

				// force these tabs hidden, since they belong to newly creative (inactive) groups
				delete tab._tab.pinned;
				tab._tab.hidden = true;

				restoreTabs.push(tab._tab);
			}
		}
		
		Storage._scope.SessionStore.setWindowState(gWindow, {
			windows: [{
				tabs: restoreTabs.map(tabData => {
					if (!tabData.extData) {
						tabData.extData = {};
					}
					tabData.extData[Storage.kTabIdentifier] = JSON.stringify(tabData._tabData);
					delete tabData._tabData;
					return tabData;
				})
			}]
		}, false);

		// don't forget to insert back the updated data
		Storage.saveGroupItemsData(gWindow, {
			nextID: groupItems.nextID,
			activeGroupId: groupItems.activeGroupId || null,
			totalNumber: groupItems.totalNumber
		});

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

		gWindow[objName].TabView._initFrame(() => {
			gWindow[objName].TabView._window[objName].GroupItems.resumeArrange();
			gWindow[objName].TabView._window[objName].TabItems.resumePainting();
			gWindow[objName].TabView._window[objName].GroupItems.pauseArrange();
			gWindow[objName].TabView._window[objName].TabItems.pausePainting();
			gWindow[objName].TabView._window[objName].TabItems.startHeartbeatHidden();
		});
	},

	restoreInNewWindow: async function() {
		let win = gWindow.OpenBrowserWindow();
		let promise = new Promise(resolve => {
        Services.obs.addObserver(function obs(subject, topic) {
			if (win == subject) {
				Services.obs.removeObserver(obs, topic);
				resolve();
			}
        }, "browser-delayed-startup-finished");
		});
		await promise;
		Storage._scope.SessionStore.setWindowState(win,this.State,true);

		this.autoloadedNotice.hidden = true;
		this.invalidNotice.hidden = true;
		this.tabList.hidden = true;
		this.importBtn.hidden = true;
		this.restoreHereBtn.hidden = true;
		this.restoreInNewBtn.hidden = true;
	},

	toggleRowChecked: function(aIx) {
		let isChecked = function(aItem) { return aItem.checked; }

		let item = treeView.data[aIx];
		item.checked = !item.checked;
		treeView.treeBox.invalidateRow(aIx);

		if(treeView.isContainer(aIx)) {
			// (un)check all tabs of this window as well
			for(let tab of item.tabs) {
				tab.checked = item.checked;
				treeView.treeBox.invalidateRow(treeView.data.indexOf(tab));
			}
		}
		else {
			// update the window's checkmark as well (0 means "partially checked")
			item.parent.checked = item.parent.tabs.every(isChecked) ? true : item.parent.tabs.some(isChecked) ? 0 : false;
			treeView.treeBox.invalidateRow(treeView.data.indexOf(item.parent));
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
				if(state.windows) {
					for(let win of state.windows) {
						this.eraseDataFromWindow(win);
					}
				}
				if(state._closedWindows) {
					for(let win of state._closedWindows) {
						this.eraseDataFromWindow(win);
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

	eraseDataFromWindow: function(win) {
		let activeGroupId;
		if(win.extData) {
			try {
				let groupData = JSON.parse(win.extData[Storage.kGroupsIdentifier]);
				activeGroupId = groupData.activeGroupId;
			}
			catch(ex) { /* don't care, just consider all hidden tabs as belonging to non-active groups and remove them */ }

			delete win.extData[Storage.kGroupsIdentifier];
			delete win.extData[Storage.kGroupIdentifier];
			delete win.extData[Storage.kUIIdentifier];
		}

		if(win.tabs) {
			for(let tab of win.tabs.concat()) {
				if(!this.eraseDataFromTab(activeGroupId, tab, win.tabs)) {
					this.removeTabFromWindow(tab, win.tabs, win);
				}
			}
		}

		if(win._closedTabs) {
			for(let tab of win._closedTabs.concat()) {
				if(!this.eraseDataFromTab(activeGroupId, tab, win._closedTabs)) {
					this.removeTabFromWindow(tab, win._closedTabs);
				}
			}
		}
	},

	eraseDataFromTab: function(activeGroupId, tab, tabs) {
		if(!tab.pinned && tab.hidden) {
			if(!activeGroupId) {
				return false;
			}

			if(tab.extData) {
				let tabGroupId;
				try {
					let tabData = JSON.parse(tab.extData[Storage.kTabIdentifier]);
					tabGroupId = tabData.groupID;
				}
				catch(ex) { /* don't care, just consider all hidden tabs as belonging to non-active groups and remove them */ }

				if(!tabGroupId || tabGroupId != activeGroupId) {
					return false;
				}
			}

			// we're keeping this tab around, so make sure it's visible
			tab.hidden = false;
		}

		if(tab.extData) {
			delete tab.extData[Storage.kTabIdentifier];
		}
		return true;
	},

	removeTabFromWindow: function(tab, tabs, win) {
		let i = tabs.indexOf(tab);

		// if we're removing a tab before the currently selected tab, we need to make sure the window's selected index is updated,
		// so that when it's reopened, it selectes the correct tab.
		// We should never remove the selected tab (likely the tab groups preferences tab), because if it's selected then it's in the current group, which is never removed.
		// (remember the array index is 0-based and win.selected is 1-based)
		if(win && i < win.selected) {
			win.selected--;
		}

		tabs.splice(i, 1);
	}
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
	getLevel: function(idx) { return this.isContainer(idx) ? 0 : 1; },

	getParentIndex: function(idx) {
		if(!this.isContainer(idx)) {
			for(let t = idx -1; t >= 0; t--) {
				if(this.isContainer(t)) {
					return t;
				}
			}
		}
		return -1;
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
			// add this group's tab rows to the view
			let toinsert = this.data[idx].tabs;
			for(let i = 0; i < toinsert.length; i++) {
				this.data.splice(idx +i +1, 0, toinsert[i]);
			}
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
		let groupState = this.data[idx].parent || this.data[idx];
		if(groupState.ix % 2 != 0) {
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
	paneSession.init();
};

Modules.UNLOADMODULE = function() {
	paneSession.uninit();
};
