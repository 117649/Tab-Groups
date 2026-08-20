/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 1.0.5

// Keep adoption, source fallback, native-group restoration, and rollback in one transaction.
// Firefox creates replacement tab nodes, so split views stay atomic and the selected tab moves last.
this.ItemMove = {
	moveGroup: function(sourceGroup, dropTarget, previewBounds) {
		let tabs = sourceGroup.children.map(item => item.tab), sourceWindow = tabs[0]?.documentGlobal ?? sourceGroup.container.ownerDocument.defaultView.parent, selectedTab = tabs.find(tab => tab.selected);
		let sourceFrame = sourceWindow?.tabGroups?.TabView?._window, tabSet = new Set(tabs);
		if(sourceGroup._uninited || !sourceGroup.container.isConnected || sourceGroup.children.some(item => item.parent != sourceGroup)
		|| !sourceFrame || sourceWindow == gWindow || PrivateBrowsing.isPrivate(sourceWindow) != PrivateBrowsing.isPrivate(gWindow)
		|| tabs.some(tab => tab.documentGlobal != sourceWindow || tab.splitview?.tabs.some(splitTab => !tabSet.has(splitTab)))) { return false; }
		sourceFrame = Cu.waiveXrays(sourceFrame);

		// Group options come from another TabView sandbox, so clone them into this one.
		let options = Cu.cloneInto(sourceGroup.getStorageData(), window), adoptedTabs = new Array(tabs.length), sourceBrowser = sourceWindow.gBrowser, targetGroup = null, targetBounds, shiftedGroups = [];
		let activeIndex = sourceGroup.children.indexOf(sourceGroup._activeTab), selectedIndex = tabs.indexOf(selectedTab), nativeGroups = this._nativeGroups(tabs);
		let resumeAutoclose = !sourceFrame.tabGroups.GroupItems._autoclosePaused;
		let sourceSelectedTab = sourceBrowser.selectedTab, needsFallback = sourceFrame.tabGroups.GroupItems.getActiveGroupItem() == sourceGroup || selectedTab;
		let restore = action => { try { return action(); } catch(rollbackEx) { Cu.reportError(rollbackEx); } };
		let fallbackGroup = needsFallback ? this._fallbackTab(sourceFrame, group => group.id != sourceGroup.id && !group.hidden && group.children[0]?.tab)?._tabViewTabItem.parent : null, fallbackTab = null;
		delete options.id;
		delete options.displayID;
		options.dontSetActive = true;
		options.slot = dropTarget?.slot ?? GroupItems.nextSlot();
		if(UI.classic && previewBounds) { options.bounds = previewBounds; }
		try {
			if(resumeAutoclose) { sourceFrame.tabGroups.GroupItems.pauseAutoclose(); }
			// Never let Firefox choose a pinned tab or an empty group after moving the selected group.
			if(needsFallback) {
				sourceFrame.tabGroups.UI._dontHideTabView = true;
				if(!fallbackGroup) { fallbackGroup = sourceFrame.tabGroups.GroupItems.newGroup(); fallbackGroup.newTab(); fallbackTab = fallbackGroup.getActiveTab().tab; }
				sourceFrame.tabGroups.GroupItems.updateActiveGroupItemAndTabBar(fallbackGroup);
				sourceBrowser.selectedTab = fallbackGroup.getActiveTab().tab;
			}
			// The source already has a fallback; do not replace the destination selection.
			adoptedTabs = this._adopt(tabs, selectedTab, gBrowser, adoptedTabs, false);
			let items = adoptedTabs.map(tab => tab?._tabViewTabItem);
			this._applyNativeGroups(gBrowser, nativeGroups, adoptedTabs);
			if(dropTarget) { for(let group of GroupItems) { if(group.slot >= options.slot) { shiftedGroups.push(group); group.slot++; } } if(shiftedGroups.length) { Storage.saveGroupItems(gWindow, shiftedGroups.map(group => group.getStorageData())); } }
			if(UI.classic) { targetBounds = new Map([...GroupItems].map(group => [ group, group.getBounds() ])); }
			targetGroup = new GroupItem(items, options);
			if(selectedTab || activeIndex > -1) { targetGroup.setActiveTab(items[selectedTab ? selectedIndex : activeIndex]); }
			for(let item of items) { item.save(); }
			targetGroup.reorderTabsBasedOnTabItemOrder(adoptedTabs);
			if(!sourceWindow.closed && !sourceGroup.children.length) { sourceGroup.close({ immediately: true }); }
		}
		catch(ex) {
			// Adoption is not atomic: move any replacement tabs back before exposing failure.
			let restoredTabs = new Array(tabs.length);
			if(targetGroup) { restore(() => targetGroup.close({ immediately: true })); }
			if(targetBounds) { for(let [group, bounds] of targetBounds) { restore(() => { if(!group.getBounds().equals(bounds)) { group.setBounds(bounds, true, true); } }); } }
			for(let group of shiftedGroups) { restore(() => group.slot--); }
			if(shiftedGroups.length) { restore(() => Storage.saveGroupItems(gWindow, shiftedGroups.map(group => group.getStorageData()))); }
			// Rollback is the same adoption in reverse, using the replacement selected tab.
			if(needsFallback) { restore(() => sourceFrame.tabGroups.UI._dontHideTabView = true); }
			restore(() => restoredTabs = this._adopt(adoptedTabs, adoptedTabs[selectedIndex], sourceBrowser, restoredTabs));
			for(let [index, tab] of tabs.entries()) {
				let tabItem;
				restore(() => { tab = restoredTabs[index] || tab.isConnected && tab; if(tab) { restoredTabs[index] = tab; tabItem = tab._tabViewTabItem; } });
				if(!tab) { continue; }
				if(tabItem) { restore(() => sourceGroup.add(tabItem, { index, dontArrange: true, dontSetActive: true })); }
			}
			if(activeIndex > -1) { restore(() => { let item = restoredTabs[activeIndex]?._tabViewTabItem; if(item?.parent == sourceGroup) { sourceGroup.setActiveTab(item); } }); }
			for(let tab of restoredTabs) { restore(() => tab?._tabViewTabItem?.save()); }
			restore(() => this._applyNativeGroups(sourceBrowser, nativeGroups, restoredTabs, true));
			restore(() => sourceFrame.tabGroups.GroupItems.reorderTabsBasedOnGivenOrder(nativeGroups.windowOrder.map(tab => restoredTabs[nativeGroups.indexes.get(tab)] || tab)));
			for(let tab of nativeGroups.windowOrder) { restore(() => { tab = restoredTabs[nativeGroups.indexes.get(tab)] || tab; if(tab.pinned) { sourceFrame.tabGroups.PinnedItems.arrange(tab); } }); }
			restore(() => sourceGroup.reorderTabsBasedOnTabItemOrder());
			restore(() => sourceGroup.arrange());
			let recovered = restore(() => tabs.every((tab, index) => { tab = restoredTabs[index]; return tab?.isConnected && tab.documentGlobal == sourceWindow; }));
			if(needsFallback && recovered) {
				restore(() => sourceFrame.tabGroups.GroupItems.updateActiveGroupItemAndTabBar(sourceGroup));
				restore(() => { let tab = selectedTab ? restoredTabs[selectedIndex] : sourceSelectedTab; if(tab?.isConnected && tab.documentGlobal == sourceWindow) { sourceBrowser.selectedTab = tab; } });
			}
			if(fallbackTab && recovered) {
				let removed = restore(() => { sourceBrowser.removeTab(fallbackTab, { animate: false }); return true; });
				if(removed && !fallbackGroup.children.length) { restore(() => fallbackGroup.close({ immediately: true })); }
			}
			Cu.reportError(ex);
			return false;
		}
		finally {
			restore(() => { if(!sourceWindow.closed) { sourceFrame.tabGroups.UI._dontHideTabView = false; } });
			if(resumeAutoclose) { restore(() => { if(!sourceWindow.closed) { sourceFrame.tabGroups.GroupItems.resumeAutoclose(); } }); }
		}
		return true;
	},

	moveTabs: function(tabs, transaction) {
		let adoptedTabs = new Array(tabs.length), selectedTab = tabs.find(tab => tab.selected), selectedIndex = tabs.indexOf(selectedTab), sourceWindow = tabs[0].documentGlobal;
		let sourceBrowser = sourceWindow.gBrowser, sourceFrame = Cu.waiveXrays(sourceWindow.tabGroups.TabView._window), tabSet = new Set(tabs), sourceItems = tabs.map(tab => ({ parent: tab._tabViewTabItem?.parent, index: tab._tabViewTabItem?.parent?.children.indexOf(tab._tabViewTabItem), pinned: tab.pinned, active: tab._tabViewTabItem?.parent?._activeTab == tab._tabViewTabItem }));
		let sourceGroups = new Set(sourceItems.map(item => item.parent).filter(Boolean)), nativeGroups = this._nativeGroups(tabs);
		let sourceActiveTab = sourceFrame.tabGroups.UI.getActiveTab(), sourceActiveGroup = sourceFrame.tabGroups.GroupItems.getActiveGroupItem(), sourceSelectedTab = sourceBrowser.selectedTab;
		let needsFallback = selectedTab || tabSet.has(sourceActiveTab?.tab) || sourceActiveGroup && !sourceActiveGroup.children.some(item => !tabSet.has(item.tab));
		// Preserve the fallback group's active tab unless that tab is also being moved.
		let fallbackItem = needsFallback && this._fallbackTab(sourceFrame, group => !group.hidden && (!tabSet.has(group.getActiveTab()?.tab) ? group.getActiveTab() : group.children.find(item => !tabSet.has(item.tab)))?.tab)?._tabViewTabItem;
		let fallbackGroup = fallbackItem?.parent, fallbackCreated = false, resumeAutoclose = !sourceFrame.tabGroups.GroupItems._autoclosePaused;
		let restore = action => { try { return action(); } catch(rollbackEx) { Cu.reportError(rollbackEx); } };
		try {
			if(resumeAutoclose) { sourceFrame.tabGroups.GroupItems.pauseAutoclose(); }
			// Select a remaining unpinned tab before Firefox removes the source selection.
			if(needsFallback) {
				sourceFrame.tabGroups.UI._dontHideTabView = true;
				if(!fallbackItem) { fallbackGroup = sourceFrame.tabGroups.GroupItems.newGroup(); fallbackCreated = true; fallbackGroup.newTab(); fallbackItem = fallbackGroup.getActiveTab(); }
				sourceFrame.tabGroups.GroupItems.updateActiveGroupItemAndTabBar(fallbackItem);
				sourceBrowser.selectedTab = fallbackItem.tab;
			}
			adoptedTabs = this._adopt(tabs, selectedTab, gBrowser, adoptedTabs, false);
			this._applyNativeGroups(gBrowser, nativeGroups, adoptedTabs);
			if(transaction) { transaction.commit(adoptedTabs); }
		}
		catch(ex) {
			let restoredTabs = new Array(tabs.length);
			if(needsFallback) { restore(() => sourceFrame.tabGroups.UI._dontHideTabView = true); }
			restore(() => restoredTabs = this._adopt(adoptedTabs, adoptedTabs[selectedIndex], sourceBrowser, restoredTabs));
			for(let [index, tab] of tabs.entries()) {
				let tabItem;
				restore(() => { tab = restoredTabs[index] || tab.isConnected && tab; if(tab) { restoredTabs[index] = tab; tabItem = tab._tabViewTabItem; } });
				if(!tab) { continue; }
				if(sourceItems[index].pinned) { restore(() => sourceBrowser.pinTab(tab)); }
				else if(sourceItems[index].parent && tabItem) {
					restore(() => sourceItems[index].parent.add(tabItem, { index: sourceItems[index].index, dontArrange: true, dontSetActive: true }));
					if(sourceItems[index].active) { restore(() => { if(tabItem.parent == sourceItems[index].parent) { sourceItems[index].parent.setActiveTab(tabItem); } }); }
				}
			}
			for(let tab of restoredTabs) { restore(() => tab?._tabViewTabItem?.save()); }
			restore(() => this._applyNativeGroups(sourceBrowser, nativeGroups, restoredTabs, true));
			restore(() => sourceFrame.tabGroups.GroupItems.reorderTabsBasedOnGivenOrder(nativeGroups.windowOrder.map(tab => restoredTabs[nativeGroups.indexes.get(tab)] || tab)));
			for(let tab of nativeGroups.windowOrder) { restore(() => { tab = restoredTabs[nativeGroups.indexes.get(tab)] || tab; if(tab.pinned) { sourceFrame.tabGroups.PinnedItems.arrange(tab); } }); }
			for(let group of sourceGroups) { restore(() => group.reorderTabsBasedOnTabItemOrder()); restore(() => group.arrange()); }
			let recovered = restore(() => tabs.every((tab, index) => { tab = restoredTabs[index]; return tab?.isConnected && tab.documentGlobal == sourceWindow; }));
			if(needsFallback && recovered) {
				restore(() => {
					let active = restoredTabs[tabs.indexOf(sourceActiveTab?.tab)]?._tabViewTabItem;
					if(!active && sourceActiveTab?.tab?.isConnected && sourceActiveTab.tab.documentGlobal == sourceWindow) { active = sourceActiveTab; }
					if(!active && !sourceActiveGroup?._uninited && sourceActiveGroup?.container?.isConnected) { active = sourceActiveGroup; }
					active ? sourceFrame.tabGroups.GroupItems.updateActiveGroupItemAndTabBar(active) : sourceFrame.tabGroups.GroupItems._updateTabBar();
				});
				restore(() => { let tab = restoredTabs[selectedIndex] || sourceSelectedTab; if(tab?.isConnected && tab.documentGlobal == sourceWindow) { sourceBrowser.selectedTab = tab; } });
			}
			if(transaction?.rollback) { restore(() => transaction.rollback()); }
			if(fallbackCreated && !fallbackGroup._uninited && recovered
			&& restore(() => { sourceBrowser.removeTab(fallbackItem.tab, { animate: false }); return true; })
			&& !fallbackGroup.children.length && !fallbackGroup._uninited) {
				restore(() => fallbackGroup.close({ immediately: true }));
			}
			Cu.reportError(ex);
			return null;
		}
		finally {
			restore(() => { if(!sourceWindow.closed) { sourceFrame.tabGroups.UI._dontHideTabView = false; } });
			if(resumeAutoclose) { restore(() => { if(!sourceWindow.closed) { sourceFrame.tabGroups.GroupItems.resumeAutoclose(); } }); }
		}
		if(!sourceWindow.closed) { sourceFrame.tabGroups.DraggingTab?.end(); }
		for(let group of sourceGroups) { group.getActiveTab()?.save(); if(!group.closeIfEmpty()) { group.arrange(); } }
		return adoptedTabs;
	},

	// GroupItems are rewrapped on return; carry their native tab node across the sandbox boundary instead.
	_fallbackTab: function(sourceFrame, find) {
		let tab = null;
		sourceFrame.tabGroups.GroupItems._lastActiveList.peek(group => !!(tab = find(Cu.waiveXrays(group))));
		return tab;
	},

	_adopt: function(tabs, selectedTab, browser = gBrowser, adopted = new Array(tabs.length), selectTab = true) {
		let indexes = new Map();
		for(let [index, tab] of tabs.entries()) { if(tab) { indexes.set(tab, index); } }
		let selectedIndex = indexes.get(selectedTab);
		let adopt = (tab, index, select) => {
			if(tab.splitview && browser.adoptSplitView) {
				let splitTabs = [...tab.splitview.tabs];
				if(tab != selectedTab && (tab != splitTabs[0] || splitTabs.includes(selectedTab))) { return; }
				let splitview = browser.adoptSplitView(tab.splitview, { tabIndex: browser.tabs.length, selectTab: select });
				if(!splitview) { throw new Error(`Could not adopt ${tab == selectedTab ? "selected " : ""}split view`); }
				for(let [i, splitTab] of splitTabs.entries()) { adopted[indexes.get(splitTab)] = splitview.tabs[i]; }
			}
			else {
				// Adopt pinned tabs beyond Firefox's pinned boundary so TabOpen creates the TabItem before the drop target applies pinning.
				adopted[index] = browser.adoptTab(tab, browser.adoptTab.length == 1 ? { tabIndex: browser.tabs.length + (tab.pinned ? 1 : 0), selectTab: select } : browser.tabs.length, select);
				if(!adopted[index]) { throw new Error(`Could not adopt ${tab == selectedTab ? "selected " : ""}tab`); }
			}
		};
		for(let [index, tab] of tabs.entries()) {
			// adoptSplitView fills both slots and detaches both original tabs.
			if(!tab || tab == selectedTab || adopted[index]) { continue; }
			adopt(tab, index, false);
		}
		if(selectedTab && !adopted[selectedIndex]) { adopt(selectedTab, selectedIndex, selectTab); }
		if(adopted.filter(Boolean).length != tabs.filter(Boolean).length || adopted.some(tab => !tab._tabViewTabItem)) { throw new Error("Adopted tab has no TabItem"); }
		return adopted;
	},

	_nativeGroups: function(tabs) {
		let indexes = new Map(tabs.map((tab, index) => [tab, index]));
		return { indexes, windowOrder: tabs.length ? [...tabs[0].documentGlobal.gBrowser.tabs] : [], groups: [...new Set(tabs.map(tab => tab.group).filter(Boolean))].map(group => ({ group, tabs: group.tabs.filter(tab => indexes.has(tab)), order: [...group.tabs], id: group.tabs.every(tab => indexes.has(tab)) && group.id, label: group.label, color: group.color, collapsed: group.collapsed })) };
	},

	// Firefox discards native tab-group wrappers during adoption; recreate them,
	// or reuse a surviving source wrapper while rolling back.
	_applyNativeGroups: function(browser, snapshot, replacements, reuse) {
		if(!browser.addTabGroup) { return; }
		for(let nativeGroup of snapshot.groups) {
			let restored = nativeGroup.tabs.map(tab => replacements[snapshot.indexes.get(tab)] || tab);
			if(reuse && nativeGroup.group.isConnected) {
				for(let tab of restored) { browser.moveTabToExistingGroup(tab, nativeGroup.group); }
				let start = nativeGroup.group.tabs[0]._tPos;
				for(let tab of new Set(nativeGroup.order.map(tab => { tab = replacements[snapshot.indexes.get(tab)] || tab; return tab.splitview || tab; }))) { browser.moveTabTo(tab, browser.moveTabTo.length == 1 ? { tabIndex: start } : start); start += tab.tabs?.length || 1; }
			}
			else {
				let group = browser.addTabGroup(restored, { id: nativeGroup.id, label: nativeGroup.label, color: nativeGroup.color, isAdoptingGroup: true });
				group.collapsed = nativeGroup.collapsed;
			}
		}
	}
};
