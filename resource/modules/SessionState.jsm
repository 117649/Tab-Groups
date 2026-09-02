/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.0.1

this.SessionState = (() => {
	let clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

	function normalizeSplitViews(win) {
		let ids = new Set(), counts = new Map();
		for(let tab of win.tabs || []) { if("splitViewId" in tab) { counts.set(tab.splitViewId, (counts.get(tab.splitViewId) || 0) + 1); } }
		if(Array.isArray(win.splitViews)) {
			win.splitViews = win.splitViews.filter(splitView => {
				let count = counts.get(splitView.id);
				if(ids.has(splitView.id) || !count || count != splitView.numberOfTabs) { return false; }
				ids.add(splitView.id);
				return true;
			});
		}
		else { delete win.splitViews; }
		for(let tab of win.tabs || []) { if(!ids.has(tab.splitViewId)) { delete tab.splitViewId; } }
	}

	function normalizeGroups(win) {
		let ids = new Set(), tabIds = new Set();
		for(let tab of win.tabs || []) { if("groupId" in tab) { tabIds.add(tab.groupId); } }
		if(Array.isArray(win.groups)) {
			win.groups = win.groups.filter(group => {
				if(ids.has(group.id) || !tabIds.has(group.id)) { return false; }
				ids.add(group.id);
				return true;
			});
		}
		else { delete win.groups; }
		for(let tab of win.tabs || []) { if(!ids.has(tab.groupId)) { delete tab.groupId; } }
	}

	function eraseTab(activeGroupId, tab) {
		if(!tab.pinned && tab.hidden) {
			let tabGroupId;
			try { tabGroupId = JSON.parse(tab.extData[Storage.kTabIdentifier]).groupID; }
			catch(ex) {}
			if(tabGroupId) {
				if(!activeGroupId || tabGroupId != activeGroupId) { return false; }
				tab.hidden = false;
			}
		}
		if(tab.extData) { delete tab.extData[Storage.kTabIdentifier]; }
		return true;
	}

	function removeTab(tab, tabs, win) {
		let index = tabs.indexOf(tab);
		if(win && index < win.selected) { win.selected--; }
		tabs.splice(index, 1);
	}

	function eraseWindow(win) {
		let activeGroupId;
		if(win.extData) {
			try { activeGroupId = JSON.parse(win.extData[Storage.kGroupsIdentifier]).activeGroupId; }
			catch(ex) {}
			delete win.extData[Storage.kGroupsIdentifier];
			delete win.extData[Storage.kGroupIdentifier];
			delete win.extData[Storage.kUIIdentifier];
		}
		for(let tab of (win.tabs || []).concat()) { if(!eraseTab(activeGroupId, tab)) { removeTab(tab, win.tabs, win); } }
		normalizeSplitViews(win);
		normalizeGroups(win);
		for(let closed of (win._closedTabs || []).concat()) { if(!eraseTab(activeGroupId, closed.state || closed)) { removeTab(closed, win._closedTabs); } }
		for(let group of win.closedGroups || []) {
			for(let closed of group.tabs || []) {
				let tab = closed.state || closed;
				if(tab.extData) { delete tab.extData[Storage.kTabIdentifier]; }
			}
		}
	}

	return {
		createBackup: function(state, includeAll) {
			let errors = [];
			if(includeAll) { return { state: clone(state), errors }; }
			let save = { version: [ objName, 1 ], session: clone(state.session), windows: [] };
			if("maxSplitViewId" in state) { save.maxSplitViewId = state.maxSplitViewId; }
			for(let win of state.windows || []) {
				let winData = { selected: 0, tabs: [], extData: {} };
				for(let property of [ "splitViews", "groups", "width", "height", "screenX", "screenY", "sizemode", "sizemodeBeforeMinimized" ]) {
					if(property in win) { winData[property] = clone(win[property]); }
				}
				for(let [index, tab] of (win.tabs || []).entries()) {
					try {
						let current = tab.entries[tab.index -1];
						let saveTab = {
							entries: [ { url: current.url, title: current.title, charset: current.charset, ID: current.ID, persist: current.persist } ],
							lastAccessed: "0",
							hidden: tab.hidden,
							attributes: {},
							extData: {},
							index: 1
						};
						for(let property of [ "triggeringPrincipal_base64", "principalToInherit_base64", "policyContainer", "csp" ]) {
							if(property in current) { saveTab.entries[0][property] = clone(current[property]); }
						}
						for(let property of [ "userContextId", "splitViewId", "groupId" ]) {
							if(property in tab) { saveTab[property] = tab[property]; }
						}
						if(tab.lastAccessed) { saveTab.lastAccessed = tab.lastAccessed; }
						if(tab.pinned) { saveTab.pinned = tab.pinned; }
						if(tab.extData) { saveTab.extData = clone(tab.extData); }
						if(tab.attributes) { saveTab.attributes = clone(tab.attributes); }
						if(tab.image) { saveTab.image = tab.image; }
						winData.tabs.push(saveTab);
						if(index < win.selected) { winData.selected = winData.tabs.length; }
					}
					catch(ex) { errors.push(ex); }
				}
				if(!winData.selected) { winData.selected = 1; }
				normalizeSplitViews(winData);
				normalizeGroups(winData);
				if(win.extData) {
					if(win.extData[Storage.kGroupIdentifier]) { winData.extData[Storage.kGroupIdentifier] = win.extData[Storage.kGroupIdentifier]; }
					if(win.extData[Storage.kGroupsIdentifier]) { winData.extData[Storage.kGroupsIdentifier] = win.extData[Storage.kGroupsIdentifier]; }
				}
				save.windows.push(winData);
			}
			return { state: save, errors };
		},

		prepareRestore: function(state, ids = {}) {
			state = clone(state);
			for(let win of state.windows || []) {
				normalizeSplitViews(win);
				if(Array.isArray(win.splitViews) && typeof ids.nextSplitViewId == "function") {
					let splitViewIds = new Map();
					win.splitViews = win.splitViews.map(splitView => {
						let id = ids.nextSplitViewId();
						splitViewIds.set(splitView.id, id);
						return { ...splitView, id };
					});
					for(let tab of win.tabs || []) { if("splitViewId" in tab) { tab.splitViewId = splitViewIds.get(tab.splitViewId); } }
				}
				else {
					delete win.splitViews;
					for(let tab of win.tabs || []) { delete tab.splitViewId; }
				}
				normalizeGroups(win);
				let groupIds = new Map();
				for(let group of win.groups || []) {
					let id = ids.nextNativeGroupId();
					groupIds.set(group.id, id);
					group.id = id;
				}
				for(let tab of win.tabs || []) { if("groupId" in tab) { tab.groupId = groupIds.get(tab.groupId); } }
			}
			return state;
		},

		prepareImport: function(rows, groupItems, ids = {}) {
			let importGroups = rows.flatMap(item => item.groups || []).filter(item => item.checked !== false);
			if(!importGroups.length) { return null; }
			groupItems = clone(groupItems || {});
			if(!groupItems.nextID) { groupItems.nextID = 1; }
			if(!groupItems.totalNumber) { groupItems.totalNumber = 0; }
			let tabs = [], groups = [], selectedByWindow = new Map();
			for(let group of importGroups) {
				let groupID;
				if(!group.pinned) {
					groupID = groupItems.nextID++;
					let data = clone(group._group);
					data.id = groupID;
					groups.push(data);
					groupItems.totalNumber++;
				}
				let sourceWindow = group.parent._window;
				if(!selectedByWindow.has(sourceWindow)) { selectedByWindow.set(sourceWindow, new Map()); }
				let selected = selectedByWindow.get(sourceWindow);
				for(let item of group.tabs) {
					if(!item.checked) { continue; }
					let tab = clone(item._tab);
					if(group.pinned) { tab.pinned = true; tab.hidden = false; }
					else { delete tab.pinned; tab.hidden = true; tab._tabData = tab._tabData || {}; tab._tabData.groupID = groupID; }
					tabs.push(tab);
					selected.set(item._tab, tab);
				}
			}
			let windowState = { tabs }, splitViews = [], nativeGroups = [];
			for(let [sourceWindow, selected] of selectedByWindow) {
				let preserved = new Set();
				if(typeof ids.nextSplitViewId == "function") {
					for(let splitView of sourceWindow.splitViews || []) {
						let members = sourceWindow.tabs.filter(tab => "splitViewId" in tab && tab.splitViewId === splitView.id);
						if(members.length && members.length == splitView.numberOfTabs && members.every(tab => selected.has(tab))) {
							let id = ids.nextSplitViewId();
							for(let tab of members) { selected.get(tab).splitViewId = id; preserved.add(tab); }
							splitViews.push({ ...clone(splitView), id });
						}
					}
				}
				for(let [source, tab] of selected) { if(!preserved.has(source)) { delete tab.splitViewId; } }
				preserved.clear();
				for(let group of sourceWindow.groups || []) {
					let members = sourceWindow.tabs.filter(tab => "groupId" in tab && tab.groupId === group.id);
					if(members.length && members.every(tab => selected.has(tab))) {
						let id = ids.nextNativeGroupId();
						for(let tab of members) { selected.get(tab).groupId = id; preserved.add(tab); }
						nativeGroups.push({ ...clone(group), id });
					}
				}
				for(let [source, tab] of selected) { if(!preserved.has(source)) { delete tab.groupId; } }
			}
			if(splitViews.length) { windowState.splitViews = splitViews; }
			if(nativeGroups.length) { windowState.groups = nativeGroups; }
			for(let tab of tabs) {
				tab.extData = tab.extData || {};
				tab.extData[Storage.kTabIdentifier] = JSON.stringify(tab._tabData);
				delete tab._tabData;
			}
			return { windowState, groups, groupItems: { nextID: groupItems.nextID, activeGroupId: groupItems.activeGroupId || null, totalNumber: groupItems.totalNumber } };
		},

		removeTabGroups: function(state) {
			state = clone(state);
			for(let win of state.windows || []) { eraseWindow(win); }
			for(let win of state._closedWindows || []) { eraseWindow(win); }
			for(let group of state.savedGroups || []) {
				for(let closed of group.tabs || []) {
					let tab = closed.state || closed;
					if(tab.extData) { delete tab.extData[Storage.kTabIdentifier]; }
				}
			}
			return state;
		}
	};
})();
