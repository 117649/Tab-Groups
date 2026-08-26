/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// VERSION 2.7.7

// This will be the GroupDrag object created when a group is dragged or resized.
this.DraggingGroup = null;

// Called to create a Drag in response to a <GroupItem> draggable "start" event.
// Parameters:
//   item - The <Item> being dragged
//   e - The DOM event that kicks off the drag
//   resizing - whether the groupitem is being resized rather than repositioned
//   callback - a method that will be called when the drag operation ends
this.GroupDrag = function(item, e, resizing, callback) {
	if(DraggingGroup?.external) { DraggingGroup.end(); }
	GroupDrag.clearExternal();
	DraggingGroup = this;
	this.item = item;
	this.container = item.container;
	this.callback = callback;
	this.started = false;
	this.native = !!e?.dataTransfer;

	// Grid mode already uses native DnD; classic mode keeps its mouse drag and relays it between windows.
	if(this.native) {
		// A native tab node survives the cross-window drag boundary; a sandbox GroupItem does not.
		e.dataTransfer.mozSetDataAt(GroupDrag.TYPE, item.children[0]?.tab ?? item.container, 0);
		e.dataTransfer.effectAllowed = "move";
		this.item.isDragging = true;
		this.start();
		this.toggleDropListeners(true);
		return;
	}

	Listeners.add(gWindow, 'mousemove', this);
	Listeners.add(gWindow, 'mouseup', this);

	this.startBounds = this.item.getBounds();
	if(e) {
		this.startMouse = new Point(e.clientX, e.clientY);
		if(!resizing) {
			e.preventDefault();
			if(this.item.isAFauxItem) {
				this.item.setBounds(new Rect(this.startMouse.y, this.startMouse.x, 0, 0));
			}
		}
	}

	if(resizing) {
		this.item.isResizing = true;
		this.start();
	}
};

this.GroupDrag.TYPE = "application/x-tabgroups-group";

this.GroupDrag.clearExternal = function() {
	for(let preview of document.querySelectorAll('.external-group-preview')) { preview.remove(); }
	document.body.classList.remove('DraggingGroup', 'ReceivingGroup');
};

// Create the receiver in its own TabView sandbox so identity checks stay valid across windows.
this.GroupDrag.receive = function(item, offsetX, offsetY) {
	if(DraggingGroup?.external) { DraggingGroup.end(); }
	GroupDrag.clearExternal();
	DraggingGroup = Object.create(GroupDrag.prototype);
	Object.assign(DraggingGroup, { item, offsetX, offsetY, dropTarget: null, external: true });
	if(UI.classic) { DraggingGroup.previewBounds = new Rect(item.getBounds({ classic: true })); DraggingGroup.safeWindowBounds = GroupItems.getSafeWindowBounds(); }
	DraggingGroup.preview = document.createElement('div');
	DraggingGroup.preview.className = 'external-group-preview';
	document.body.appendChild(DraggingGroup.preview);
	document.body.classList.add('DraggingGroup', 'ReceivingGroup');
};

this.GroupDrag.handleEvent = function(e) {
	let isGroupDrag = false;
	try { isGroupDrag = e.dataTransfer?.mozTypesAt(0).contains(GroupDrag.TYPE); } catch(ex) {}
	switch(e.type) {
		case 'dragenter': {
			let group;
			try {
				if(!isGroupDrag) { if(DraggingGroup?.external) { DraggingGroup.end(); } return; }
				group = e.dataTransfer.mozGetDataAt(GroupDrag.TYPE, 0);
				group = group?._tabViewTabItem?.parent ?? group?._item ?? group?.groupItem;
			} catch(ex) { return; }
			let sourceWindow = group?.children[0]?.tab?.documentGlobal ?? group?.container.ownerDocument.defaultView.parent;
			if(!group?.isAGroupItem || !sourceWindow || sourceWindow == gWindow
			|| PrivateBrowsing.isPrivate(sourceWindow) != PrivateBrowsing.isPrivate(gWindow)) { return; }
			// Native dragexit is unreliable between windows, so only the current receiver keeps a preview.
			for(let frame of sourceWindow.tabGroups.TabView._window.tabGroups.DraggingGroup?.dropWindows || sourceWindow.tabGroups.TabView._window.tabGroups.DraggingGroupSelector?.dropWindows || []) { if(frame != window && frame.tabGroups.DraggingGroup?.external) { frame.tabGroups.DraggingGroup.end(); } }
			if(DraggingGroup) {
				if(!DraggingGroup.external) { return; }
				if(DraggingGroup.item == group) { e.preventDefault(); return; }
				DraggingGroup.end();
			}
			GroupDrag.receive(group);
			// no break; accepting dragenter also makes the window a valid drop target
		}
		case 'dragover':
			if(isGroupDrag && DraggingGroup?.external) { DraggingGroup.receiveMove(e); e.dataTransfer.dropEffect = "move"; e.preventDefault(); }
			else if(isGroupDrag && DraggingGroup?.native && !UI.grid) { DraggingGroup.drag(e); e.dataTransfer.dropEffect = "move"; e.preventDefault(); }
			break;

		case 'drop':
			if(isGroupDrag && DraggingGroup?.external) {
				e.preventDefault();
				DraggingGroup.receiveDrop();
			}
			else if(DraggingGroup?.external) { DraggingGroup.end(); }
			break;

		case 'dragexit':
			if(e.target != e.currentTarget) { return; }
			// no break; leaving the TabView document clears stale external state
		case 'dragend':
			if(DraggingGroup?.external) { DraggingGroup.end(); }
			break;
	}
};

this.GroupDrag.prototype = {
	minDragDistance: 3,
	_stoppedMoving: null,

	check: function() {
		return DraggingGroup == this;
	},

	toggleDropListeners: function(add) {
		if(add) {
			this.dropWindows = [];
			let ctypes, getAncestor;
			if(!this.native && Services.appinfo.OS == 'WINNT') {
				try {
					({ ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs"));
					this.user32 = ctypes.open("user32.dll");
					let POINT = ctypes.StructType("POINT", [{ x: ctypes.long }, { y: ctypes.long }]);
					let getCursorPos = this.user32.declare("GetCursorPos", ctypes.winapi_abi, ctypes.int, POINT.ptr);
					let windowFromPoint = this.user32.declare("WindowFromPoint", ctypes.winapi_abi, ctypes.voidptr_t, POINT);
					getAncestor = this.user32.declare("GetAncestor", ctypes.winapi_abi, ctypes.voidptr_t, ctypes.voidptr_t, ctypes.unsigned_int);
					this.dropWindowHandles = new Map();
					// Win32 cursor coordinates avoid CSS/DPI conversion and identify the real top window, including other applications.
					this.windowAtCursor = () => { let point = POINT(); return getCursorPos(point.address()) && getAncestor(windowFromPoint(point), 2).toString(); };
				} catch(ex) { Cu.reportError(ex); }
			}
			if(this.native) { Listeners.add(window, 'dragover', GroupDrag.handleEvent, true); }
			for(let browserWindow of Services.wm.getEnumerator('navigator:browser')) {
				let frame = browserWindow.tabGroups?.TabView?._window;
				if(frame && browserWindow != gWindow && browserWindow.tabGroups.TabView.isVisible()
				&& PrivateBrowsing.isPrivate(browserWindow) == PrivateBrowsing.isPrivate(gWindow)) {
					this.dropWindows.push(frame);
					if(this.dropWindowHandles) {
						try { this.dropWindowHandles.set(frame, getAncestor(ctypes.voidptr_t(ctypes.UInt64(browserWindow.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIBaseWindow).nativeHandle)), 2).toString()); }
						catch(ex) { Cu.reportError(ex); }
					}
					let target = frame.tabGroups;
					if(this.native) {
						target.Listeners.add(frame, 'dragenter', target.GroupDrag.handleEvent, true);
						target.Listeners.add(frame.document.documentElement, 'dragexit', target.GroupDrag.handleEvent, true);
						target.Listeners.add(frame, 'dragover', target.GroupDrag.handleEvent, true);
						for(let type of [ 'dragend', 'drop' ]) { target.Listeners.add(frame, type, target.GroupDrag.handleEvent); }
					}
					else {
						target.Listeners.add(frame, 'mousemove', this, true);
						target.Listeners.add(frame, 'mouseup', this, true);
					}
				}
			}
			return;
		}
		if(this.native) { Listeners.remove(window, 'dragover', GroupDrag.handleEvent, true); }
		for(let frame of this.dropWindows || []) {
			try {
				let target = frame.tabGroups;
				if(this.native) {
					target.Listeners.remove(frame, 'dragenter', target.GroupDrag.handleEvent, true);
					target.Listeners.remove(frame.document.documentElement, 'dragexit', target.GroupDrag.handleEvent, true);
					target.Listeners.remove(frame, 'dragover', target.GroupDrag.handleEvent, true);
					for(let type of [ 'dragend', 'drop' ]) { target.Listeners.remove(frame, type, target.GroupDrag.handleEvent); }
				}
				else {
					target.Listeners.remove(frame, 'mousemove', this, true);
					target.Listeners.remove(frame, 'mouseup', this, true);
				}
				if(target.DraggingGroup?.external) { target.DraggingGroup.end(); }
			} catch(ex) {
				// A destination window may close before the source drag ends.
			}
		}
		this.windowAtCursor = null;
		this.dropWindowHandles = null;
		try { this.user32?.close(); } catch(ex) {}
		this.user32 = null;
		this.dropWindows = null;
		this.dropFrame = null;
	},

	// Mouse capture varies by platform, so source and destination events are matched in screen space.
	relayToWindow: function(e) {
		let frame = e.screenX < gWindow.screenX || e.screenX >= gWindow.screenX + gWindow.outerWidth
		|| e.screenY < gWindow.screenY || e.screenY >= gWindow.screenY + gWindow.outerHeight
			? (this.dropWindows || []).find(frame => e.screenX >= frame.mozInnerScreenX && e.screenX < frame.mozInnerScreenX + frame.innerWidth
				&& e.screenY >= frame.mozInnerScreenY && e.screenY < frame.mozInnerScreenY + frame.innerHeight) : null;
		// Do not fall through a window covering the destination TabView.
		if(frame && this.dropWindowHandles?.has(frame) && this.windowAtCursor() != this.dropWindowHandles.get(frame)) { frame = null; }
		if(this.dropFrame != frame) {
			try { this.dropFrame?.tabGroups.DraggingGroup?.end(); } catch(ex) {}
			this.dropFrame = frame;
			if(frame) {
				frame.tabGroups.GroupDrag.receive(this.item, this.startMouse.x - this.startBounds.left, this.startMouse.y - this.startBounds.top);
			}
		}
		if(!frame) { return false; }
		frame.tabGroups.DraggingGroup.receiveMove(e);
		return true;
	},

	start: function(isAuto) {
		if(!this.check()) { return; }

		if(UI.grid) {
			this.dropTarget = this.item;
			this.container.classList.add('dragging');

			Listeners.add(this.container, 'drop', this);
			Listeners.add(this.container, 'dragend', this);

			document.body.classList.add('DraggingGroup');
			return;
		}

		if(!this.item.isResizing) {
			// show a dragging cursor while the item is being dragged
			this.container.classList.add('dragging');
			document.body.classList.add('DraggingGroup');

			if(!this.item.isAFauxItem) {
				if(!isAuto) {
					UI.setActive(this.item);
				}
				this.item._unfreezeItemSize(true);
			}

			this.started = true;
			if(!isAuto && !this.item.isAFauxItem) { this.toggleDropListeners(true); }
		}
		else {
			this.container.classList.add('resizing');
		}

		this.item.isDragging = true;

		this.safeWindowBounds = GroupItems.getSafeWindowBounds();

		Trenches.activateOthersTrenches(this.container);
	},

	handleEvent: function(e) {
		if(!this.check()) { return; }

		switch(e.type) {
			case 'mousemove':
				// global drag tracking
				UI.lastMoveTime = Date.now();

				let mouse = new Point(e.clientX, e.clientY);

				if(this.item.isResizing) {
					// Forcing a reflush to get the real dimensions on each mousemove lags a lot.
					// So simply update the item's .bounds property for now with the calc'ed dimensions.
					let x = this.startBounds.width + (mouse.x - this.startMouse.x);
					let y = this.startBounds.height + (mouse.y - this.startMouse.y);
					let validSize = GroupItems.calcValidSize({ x, y });
					let bounds = this.item.getBounds({ real: true });
					bounds.width = validSize.x;
					bounds.height = validSize.y;
					this.item.setSize(bounds);
					this.snapGetBounds();

					// If we stop dragging for a bit, reaarange the items immediately,
					// makes it seem snappier without sacrificing responsiveness.
					if(this._stoppedMoving) {
						this._stoppedMoving.cancel();
					}
					this._stoppedMoving = aSync(() => {
						this.item.setSize(bounds, true);
					}, 100);
					break;
				}

				// positioning
				if(!this.started && this.startMouse) {
					if(Math.abs(mouse.x - this.startMouse.x) > this.minDragDistance
					|| Math.abs(mouse.y - this.startMouse.y) > this.minDragDistance) {
						this.start();
					}
				}

				if(!this.relayToWindow(e)) { this.drag(e); }

				e.preventDefault();
				break;

			case 'mouseup': {
				this.relayToWindow(e);
				let receiver = this.dropFrame?.tabGroups.DraggingGroup;
				if(receiver?.receiveDrop()) { break; }
				this.stop();
				break;
			}

			case 'drop':
				this.drop(e);
				// no break; end the drag now

			// If this fires, it means no valid drop occurred, so just end the drag as if nothing happened in the first place.
			case 'dragend':
				if(this.native && !UI.grid && !this.item._uninited) { this.stop(); }
				else { this.end(); }
				break;
		}
	},

	// Adjusts the given bounds according to the currently active trenches. Used by <Drag.snap>
	// Parameters:
	//   bounds             - (<Rect>) bounds
	//   stationaryCorner   - which corner is stationary? by default, the top left in LTR mode, and top right in RTL mode.
	//                        "topleft", "bottomleft", "topright", "bottomright"
	//   assumeConstantSize - (boolean) whether the bounds' dimensions are sacred or not.
	snapBounds: function(bounds, stationaryCorner, assumeConstantSize) {
		if(!stationaryCorner) {
			stationaryCorner = RTL ? 'topright' : 'topleft';
		}
		let update = false; // need to update
		let newRect;
		let snappedTrenches = new Map();

		// OH SNAP!

		// if we aren't holding down the meta key or have trenches disabled...
		if(!Keys.meta && !Trenches.disabled) {
			newRect = Trenches.snap(bounds, stationaryCorner, assumeConstantSize);
			// might be false if no changes were made
			if(newRect) {
				update = true;
				if(newRect.snappedTrenches) {
					snappedTrenches = newRect.snappedTrenches;
				}
				bounds = newRect;
			}
		}

		// make sure the bounds are in the window.
		newRect = this.snapToEdge(bounds, stationaryCorner, assumeConstantSize);
		if(newRect) {
			update = true;
			bounds = newRect;
			for(let [ edge, trench ] of newRect.snappedTrenches) {
				snappedTrenches.set(edge, trench);
			}
		}

		Trenches.hideGuides();
		for(let trench of snappedTrenches.values()) {
			if(typeof(trench) == 'object') {
				trench.showGuide = true;
				trench.show();
			}
		}

		return update ? bounds : false;
	},

	// Called when a drag or mousemove occurs. Set the bounds based on the mouse move first, then call snap and it will adjust the item's bounds if appropriate.
	// Parameters:
	//   stationaryCorner   - which corner is stationary? by default, the top left in LTR mode, and top right in RTL mode.
	//                        "topleft", "bottomleft", "topright", "bottomright"
	//   assumeConstantSize - (boolean) whether the bounds' dimensions are sacred or not.
	snap: function(stationaryCorner, assumeConstantSize) {
		if(!this.check()) { return; }

		let bounds = this.snapGetBounds(stationaryCorner, assumeConstantSize);
		if(bounds) {
			this.item.setBounds(bounds, true);
			return true;
		}
		return false;
	},

	// Select the trenches to snap the item to and returns a bounds object of the target dimensions.
	// Also triggers the display of trenches that it snapped to.
	// Parameters: same as above for snap.
	snapGetBounds: function(stationaryCorner, assumeConstantSize) {
		let bounds = this.item.getBounds();
		return this.snapBounds(bounds, stationaryCorner, assumeConstantSize);
	},

	// Returns a version of the bounds snapped to the edge if it is close enough. If not, returns false.
	// If <Keys.meta> is true, this function will simply enforce the window edges.
	// Parameters:
	//   rect - (<Rect>) current bounds of the object
	//   stationaryCorner   - which corner is stationary? by default, the top left in LTR mode, and top right in RTL mode.
	//                        "topleft", "bottomleft", "topright", "bottomright"
	//   assumeConstantSize - (boolean) whether the rect's dimensions are sacred or not
	snapToEdge: function(rect, stationaryCorner, assumeConstantSize) {
		let swb = this.safeWindowBounds;
		let update = false;
		let updateX = false;
		let updateY = false;
		let snappedTrenches = new Map();

		let snapRadius = (Keys.meta ? 0 : Trenches.defaultRadius);
		if(rect.left < swb.left + snapRadius ) {
			if(stationaryCorner.indexOf('right') > -1 && !assumeConstantSize) {
				rect.width = rect.right - swb.left;
			}
			rect.left = swb.left;
			update = true;
			updateX = true;
			snappedTrenches.set('left', 'edge');
		}

		if(rect.right > swb.right - snapRadius) {
			if(updateX || !assumeConstantSize) {
				let newWidth = swb.right - rect.left;
				rect.width = newWidth;
				update = true;
			}
			else if(!updateX || !Trenches.preferLeft) {
				rect.left = swb.right - rect.width;
				update = true;
			}
			snappedTrenches.set('right', 'edge');
			snappedTrenches.delete('left');
		}
		if(rect.top < swb.top + snapRadius) {
			if(stationaryCorner.indexOf('bottom') > -1 && !assumeConstantSize) {
				rect.height = rect.bottom - swb.top;
			}
			rect.top = swb.top;
			update = true;
			updateY = true;
			snappedTrenches.set('top', 'edge');
		}
		if(rect.bottom > swb.bottom - snapRadius) {
			if(updateY || !assumeConstantSize) {
				let newHeight = swb.bottom - rect.top;
				rect.height = newHeight;
				update = true;
			}
			else if(!updateY || !Trenches.preferTop) {
				rect.top = swb.bottom - rect.height;
				update = true;
			}
			snappedTrenches.set('top', 'edge');
			snappedTrenches.delete('bottom');
		}

		if(update) {
			rect.snappedTrenches = snappedTrenches;
			return rect;
		}
		return false;
	},

	getStationaryCorner: function(coords, box) {
		let stationaryCorner = "";
		if(coords.y == box.top) {
			stationaryCorner += "top";
		} else {
			stationaryCorner += "bottom";
		}
		if(coords.x == box.left) {
			stationaryCorner += "left";
		} else {
			stationaryCorner += "right";
		}
		return stationaryCorner;
	},

	// Called in response to an <Item> draggable "drag" event.
	drag: function(e) {
		if(!this.started) { return; }

		let stationaryCorner = "";

		// Faux-items can be resized beyond their boundaries.
		if(this.item.isAFauxItem) {
			let box = new Rect();
			box.left = Math.min(this.startMouse.x, e.clientX);
			box.right = Math.max(this.startMouse.x, e.clientX);
			box.top = Math.min(this.startMouse.y, e.clientY);
			box.bottom = Math.max(this.startMouse.y, e.clientY);
			this.item.setBounds(box);

			this.container.classList.toggle("activeGroupItem", box.width > GroupItems.minGroupWidth && box.height > GroupItems.minGroupHeight);
		}
		else {
			let mouse = new Point(e.clientX, e.clientY);
			let box = this.item.getBounds();
			box.left = this.startBounds.left + (mouse.x - this.startMouse.x);
			box.top = this.startBounds.top + (mouse.y - this.startMouse.y);
			this.item.setBounds(box, true);
		}

		this.snapGetBounds(stationaryCorner, true);
	},

	// Called in response to an <Item> draggable "stop" event.
	// Parameters:
	//  immediately - bool for doing the pushAway immediately, without animation
	stop: function(immediately) {
		if(!this.check()) { return; }

		Listeners.remove(gWindow, 'mousemove', this);
		Listeners.remove(gWindow, 'mouseup', this);

		// We only snap the groups to a trench when it's finished dragging.
		if(!this.item.isResizing) {
			if(!this.started) {
				this.end();
				return;
			}

			if(this.item.isAFauxItem) {
				let box = this.item.getBounds();
				let stationaryCorner = this.getStationaryCorner(this.startMouse, box);
				this.snap(stationaryCorner);
			} else {
				this.snap(null, true);
			}
		} else {
			if(this._stoppedMoving) {
				this._stoppedMoving.cancel();
				this._stoppedMoving = null;
			}
			this.item.setSize(null, true);
			this.snap();

			// Remembers the current size as one the user has chosen.
			this.item.userSize = new Point(this.item.bounds.width, this.item.bounds.height);
			this.item.save();

			this.item.pushAway();
		}

		Trenches.hideGuides();
		this.item.isDragging = false;
		this.item.isResizing = false;
		this.container.classList.remove('dragging');
		this.container.classList.remove('resizing');

		this.item.pushAway(immediately);

		Trenches.disactivate();

		this.end();
	},

	clearDropTarget: function() {
		if(!this.dropTarget) { return; }
		this.dropTarget.container.classList.remove('dragOver');
		Listeners.remove(this.dropTarget.container, 'drop', this);
		this.dropTarget = null;
	},

	receiveMove: function(e) {
		let node = document.elementFromPoint(e.screenX - window.mozInnerScreenX, e.screenY - window.mozInnerScreenY);
		let target = node?.closest?.('.groupItem')?._item ?? node?.closest?.('.groupSelector')?.groupItem;
		e.preventDefault();
		UI.lastMoveTime = Date.now();
		if(UI.classic || target != this.dropTarget || !this.previewBounds) { this.showPreview(e, target); }
		if(target) { this._setDropTarget(target); } else { this.clearDropTarget(); }
	},

	receiveDrop: function() {
		let sourceWindow = this.item.children[0]?.tab?.documentGlobal ?? this.item.container.ownerDocument.defaultView.parent;
		// Hide feedback immediately, but keep receiver state intact until adoption finishes.
		this.preview.hidden = true;
		document.body.classList.remove('ReceivingGroup');
		this.dropTarget?.container.classList.remove('dragOver');
		let moved;
		try { moved = ItemMove.moveGroup(this.item, this.dropTarget, this.previewBounds); }
		finally {
			this.end();
			if(moved !== false && sourceWindow && !sourceWindow.closed) {
				let source = sourceWindow.tabGroups.TabView._window.tabGroups;
				source.DraggingGroup?.end();
				source.DraggingGroupSelector?.end();
			}
			// A missed dragexit may leave an older destination receiver alive; completion clears every preview now.
			for(let browserWindow of Services.wm.getEnumerator('navigator:browser')) { let drag = browserWindow.tabGroups?.TabView?._window?.tabGroups?.DraggingGroup; if(drag?.external) { drag.end(); } }
		}
		return moved;
	},

	showPreview: function(e, target) {
		let bounds = UI.classic ? this.previewBounds : UI.single ? iQ(target?.selector ?? UI.singleNewGroupBtn).bounds() : target ? target.getBounds({ real: true }) : iQ(UI.gridNewGroupBtn).bounds();
		if(UI.classic) {
			bounds.left = e.screenX - window.mozInnerScreenX - (this.offsetX ?? bounds.width / 2);
			bounds.top = e.screenY - window.mozInnerScreenY - (this.offsetY ?? bounds.height / 2);
			bounds.left = Math.max(this.safeWindowBounds.left, Math.min(bounds.left, this.safeWindowBounds.right - bounds.width));
			bounds.top = Math.max(this.safeWindowBounds.top, Math.min(bounds.top, this.safeWindowBounds.bottom - bounds.height));
		}
		this.previewBounds = bounds;
		iQ(this.preview).css(bounds);
	},

	canDrop: function(e, dropTarget) {
		e.preventDefault();
		if(this.external || this.native && !UI.grid) { return; }

		// global drag tracking
		UI.lastMoveTime = Date.now();
		this._setDropTarget(dropTarget);
	},

	_setDropTarget: function(dropTarget) {
		if(this.dropTarget != dropTarget) {
			this.clearDropTarget();

			this.dropTarget = dropTarget;
			this.dropTarget.container.classList.add('dragOver');
			if(!this.external) { Listeners.add(this.dropTarget.container, 'drop', this); }
		}
	},

	drop: function(e) {
		if(!this.check()) { return; }
		// A local classic drag moves freely; only another window may accept it as a drop.
		if(this.native && !UI.grid) { return; }

		// No-op, shouldn't happen though.
		if(!this.dropTarget) { return; }

		// Don't need to do anything.
		if(this.dropTarget == this.item) {
			this.end();
			return;
		}

		// Move the dragged group to the slot and shift everything in between
		// There's no need to recalc the grid dimensions, they should
		// stay the same, only the groups that change row change size

		let groups = GroupItems.sortBySlot();
		let itemBounds = this.item._gridBounds;
		let itemRow = this.item.row;
		let carry = null;

		// Start at the end of the groups and work your way up
		let direction = -1;
		let i = groups.length - 1;

		// Unless you're dragging upwards, then work your way down
		if(this.item.slot > this.dropTarget.slot) {
			direction = 1;
			i = 0;
		}

		while(i < groups.length && i >= 0) {
			let nextElement = groups[i];

			// If the element is the drop target, start the carry
			if(nextElement === this.dropTarget) {
				carry = this.item;
			}

			// If we're carrying a group, swap the group with the next one
			if(carry !== null) {
				let elem = nextElement;
				nextElement = carry;
				carry = elem;

				// Store the bounds and row in case we need to change the next element
				let lastBounds = carry._gridBounds;
				let lastRow = carry.row;

				// If the carry is the item we're dragging, end the carry and
				// set the bounds the item originally had
				if(carry === this.item) {
					carry = null;
					lastBounds = itemBounds;
					lastRow = itemRow;
				}

				// Rearrange if this element changed row
				if(lastRow != nextElement.row) {
					nextElement._gridBounds = lastBounds;
					nextElement.row = lastRow;
					nextElement.arrange();
				}
			}

			// Set the slot and save
			nextElement.slot = i + 1;
			nextElement.save();
			i += direction;
		}

		this.end();
	},

	end: function() {
		if(this.external) {
			this.clearDropTarget();
			GroupDrag.clearExternal();
			if(DraggingGroup == this) { DraggingGroup = null; }
			return;
		}
		if(this.dropWindows) { this.toggleDropListeners(false); }
		if(this.native) {
			this.clearDropTarget();
			Listeners.remove(this.container, 'dragend', this);
		}
		else {
			Listeners.remove(gWindow, 'mousemove', this);
			Listeners.remove(gWindow, 'mouseup', this);
		}
		this.container.classList.remove('dragging');
		this.item.isDragging = false;
		Trenches.disactivate();
		document.body.classList.remove('DraggingGroup');

		DraggingGroup = null;
		if(this.callback) {
			this.callback();
		}
	}
};

// This will be the GroupSelectorDrag object created when a group selector is dragged.
this.DraggingGroupSelector = null;

this.GroupSelectorDrag = function(e, item) {
	DraggingGroupSelector = this;
	this.item = item;
	this.sorted = GroupItems.sortBySlot();
	this.i = this.sorted.indexOf(this.item.groupItem);
	this.started = false;

	// Carry a native tab node across windows; the private type keeps other drop targets out.
	e.dataTransfer.mozSetDataAt(GroupDrag.TYPE, item.groupItem.children[0]?.tab ?? item, 0);
	this.native = true;
	GroupDrag.prototype.toggleDropListeners.call(this, true);

	this.item.groupItem.isDragging = true;
	Listeners.add(this.item, 'dragend', this);

	// Hide async so that the translucent image that follows the cursor actually shows something.
	this.delayedStart = aSync(() => { this.finishDragStart(); });
};

this.GroupSelectorDrag.prototype = {
	delayedStart: null,

	check: function() {
		return DraggingGroupSelector == this;
	},

	handleEvent: function(e) {
		if(!this.check()) { return; }

		switch(e.type) {
			case 'drop':
				this.drop(e);
				// no break; end the drag now

			// If this fires, it means no valid drop occurred, so just end the drag as if nothing happened in the first place.
			case 'dragend':
				this.end();
				break;
		}
	},

	finishDragStart: function() {
		if(!this.check()) { return; }

		// In single mode we're just dragging the group selector item, not the actual group.
		if(this.delayedStart) {
			this.delayedStart.cancel();
			this.delayedStart = null;
		}
		this.item.hidden = true;

		Listeners.add(UI.groupSelector, 'drop', this);

		let si = this.i +1;
		if(si < this.sorted.length) {
			this.dropHere(this.sorted[si].selector);
		}

		// force a flush before animating the transitions, so that it seems like this first space appears immediately
		if(this.dropTarget) {
			this.dropTarget.clientTop;
		}

		document.body.classList.add('DraggingGroupSelector');
	},

	canDrop: function(e) {
		e.preventDefault();

		if(this.delayedStart) {
			this.delayedStart.cancel();
			this.finishDragStart();
		}

		// global drag tracking
		UI.lastMoveTime = Date.now();
	},

	dropHere: function(dropTarget) {
		// This shouldn't happen, but still better make sure.
		if(dropTarget == this.item) { return; }

		// If we're hovering over a group that's already shifted, it can only shift to the other side.
		if(dropTarget && this.dropTarget == dropTarget) {
			if(dropTarget.classList.contains('space-before')) {
				dropTarget.classList.remove('space-before');
				dropTarget.classList.add('space-after');
			} else {
				dropTarget.classList.add('space-before');
				dropTarget.classList.remove('space-after');
			}
			return;
		}

		if(this.dropTarget != dropTarget) {
			let si = -1;
			if(this.dropTarget) {
				this.dropTarget.classList.remove('space-before');
				this.dropTarget.classList.remove('space-after');
				si = this.sorted.indexOf(this.dropTarget.groupItem);
			}

			// When dragging over another selector, we need to make sure the behavior is predictable
			if(dropTarget) {
				let ti = this.sorted.indexOf(dropTarget.groupItem);
				if(si > -1 && si < ti) {
					ti++;
					if(ti == this.i) {
						ti++;
					}
					if(ti < this.sorted.length) {
						dropTarget = this.sorted[ti].selector;
					} else {
						dropTarget = null;
					}
				}
			}

			this.dropTarget = dropTarget;
			if(dropTarget) {
				dropTarget.classList.add('space-before');
			}
		}
	},

	drop: function() {
		let slot, changedGroups = [ this.item.groupItem ];
		let dropTarget = this.dropTarget;
		if(dropTarget) {
			if(dropTarget.classList.contains('space-after')) {
				let ti = this.sorted.indexOf(dropTarget.groupItem) +1;
				if(ti == this.i) {
					ti++;
				}
				if(ti < this.sorted.length) {
					dropTarget = this.sorted[ti].selector;
				} else {
					dropTarget = null;
				}
			}

			// We could not have a dropTarget anymore if we're moving to the last slot.
			if(dropTarget) {
				slot = dropTarget.groupItem.slot;

				// make sure the relative order of the groups remains unchanged, we don't want doubled slots
				for(let group of GroupItems) {
					if(group != this.item.groupItem && group.slot >= slot) {
						group.slot++;
						changedGroups.push(group);
					}
				}
			}
		}

		// default moving to the last slot on every valid drop.
		if(!slot) {
			slot = GroupItems.nextSlot();
		}

		this.item.groupItem.slot = slot;
		Storage.saveGroupItems(gWindow, changedGroups.map(group => group.getStorageData()));
	},

	end: function() {
		if(this.dropWindows) { GroupDrag.prototype.toggleDropListeners.call(this, false); }
		if(this.dropTarget) {
			this.dropTarget.classList.remove('space-before');
			this.dropTarget.classList.remove('space-after');
		}

		this.item.hidden = false;
		this.item.groupItem.isDragging = false;
		Listeners.remove(this.item, 'dragend', this);
		Listeners.remove(UI.groupSelector, 'drop', this);
		document.body.classList.remove('DraggingGroupSelector');

		DraggingGroupSelector = null;
	}
};

// This will be the TabDrag object created when a tab is dragged.
this.DraggingTab = null;

this.TabDrag = function(e, tabItem) {
	if(DraggingGroup?.external) { DraggingGroup.end(); }
	if(DraggingTab) { DraggingTab.end(); }
	DraggingTab = this;
	this.item = tabItem;
	if(!TabItems.selectedItems.has(tabItem)) { TabItems.clearSelection(); TabItems._selectionAnchor = tabItem; }
	// A split tile carries its partner even without multiselect.
	this.items = (TabItems.selectedItems.has(tabItem) ? Array.from(TabItems.selectedItems) : [ tabItem, TabItems.getSplitSibling(tabItem.tab)?._tabViewTabItem ].filter(Boolean)).sort((a, b) => a.tab._tPos - b.tab._tPos);
	this.tabs = this.items.map(item => item.tab);
	this.draggedTab = tabItem.tab;
	this.container = tabItem.container;
	// Privileged drag data keeps the actual tab nodes available to another browser window.
	e.dataTransfer.mozSetDataAt(TabDrag.TYPE, this.draggedTab, 0);
	let index = 1;
	for(let tab of this.tabs) { if(tab != this.draggedTab) { e.dataTransfer.mozSetDataAt(TabDrag.TYPE, tab, index++); } }
	e.dataTransfer.setData("text/plain", "tabview-tab");

	this.updateTarget(tabItem.parent);
	if(this.dropTarget.expanded) {
		Listeners.add(this.dropTarget.expanded.shield, 'dragenter', this);
	}
	Listeners.add(this.container, 'dragend', this);

	// Hide async so that the translucent image that follows the cursor actually shows something.
	this.delayedStart = aSync(() => { this.finishDragStart(); });
};

this.TabDrag.TYPE = "application/x-tabgroups-tab";

this.TabDrag.handleEvent = function(e) {
	switch(e.type) {
		case 'dragenter':
			if(!e.dataTransfer.mozTypesAt(0).contains(TabDrag.TYPE)) { return; }
			if(DraggingGroup?.external) { DraggingGroup.end(); }

			let draggedTab = e.dataTransfer.mozGetDataAt(TabDrag.TYPE, 0);
			let sourceWindow = draggedTab?.documentGlobal;
			// Ignore the real source drag and repeated destination events, but replace stale source state left by the previous transfer.
			if(sourceWindow == gWindow || DraggingTab?.external && DraggingTab.draggedTab == draggedTab) { return; }
			let tabs = [ draggedTab ];
			for(let i = 1; i < e.dataTransfer.mozItemCount; i++) {
				let tab = e.dataTransfer.mozGetDataAt(TabDrag.TYPE, i);
				if(tab) { tabs.push(tab); }
			}
			let tabSet = new Set(tabs);
			if(!sourceWindow?.tabGroups?.TabView?._window || sourceWindow == gWindow || PrivateBrowsing.isPrivate(sourceWindow) != PrivateBrowsing.isPrivate(gWindow)
			|| tabSet.size != tabs.length || tabs.some(tab => tab.documentGlobal != sourceWindow || tab.splitview?.tabs.some(splitTab => !tabSet.has(splitTab)))) { return; }
			// Native dragexit is unreliable between windows, so only the current receiver keeps drag feedback.
			for(let browserWindow of Services.wm.getEnumerator('navigator:browser')) { let frame = browserWindow.tabGroups?.TabView?._window; if(frame != window && frame?.tabGroups.DraggingTab?.external) { frame.tabGroups.DraggingTab.end(); } }
			if(DraggingTab) { DraggingTab.end(); }

			DraggingTab = Object.create(TabDrag.prototype);
			DraggingTab.tabs = tabs.sort((a, b) => a._tPos - b._tPos);
			DraggingTab.draggedTab = draggedTab;
			DraggingTab.items = [];
			DraggingTab.external = true;
			document.body.classList.add('DraggingTab');
			break;

		case 'dragexit':
			if(e.target != e.currentTarget) { return; }
			// no break; leaving the TabView document ends its external drag state
		case 'dragend':
		case 'drop':
			for(let browserWindow of Services.wm.getEnumerator('navigator:browser')) { let drag = browserWindow.tabGroups?.TabView?._window?.tabGroups?.DraggingTab; if(drag?.external) { drag.end(); } }
			break;
	}
};

this.TabDrag.prototype = {
	sibling: null,
	delayedStart: null,

	check: function() {
		return DraggingTab == this;
	},

	handleEvent: function(e) {
		if(!this.check()) { return; }

		switch(e.type) {
			case 'drop':
				this.drop(e);
				// no break; end the drag now

			// If this fires, it means no valid drop occurred, so just end the drag as if nothing happened in the first place.
			case 'dragend':
				this.end();
				break;

			// Leaving a group's expanded tray.
			case 'dragenter':
				// Something went wrong...
				if(!this.dropTarget.expanded) { break; }

				Listeners.remove(this.dropTarget.expanded.tray, 'drop', this);
				Listeners.remove(this.dropTarget.expanded.shield, 'dragenter', this);
				Listeners.add(this.dropTarget.container, 'drop', this);
				this.dropTarget.collapse();

				// collapsing the tray will have unhidden the dragged item
				this.item.hidden = true;
				break;
		}
	},

	finishDragStart: function() {
		if(!this.check()) { return; }

		if(this.delayedStart) {
			this.delayedStart.cancel();
			this.delayedStart = null;
		}
		this.item.hidden = true;

		let sibling;
		if(this.item.isATabItem) {
			sibling = !this.item.isStacked && this.item.parent.children.slice(this.item.parent.children.indexOf(this.item) +1).find(item => !this.items.includes(item));
		} else if(this.item.isAnAppItem) {
			sibling = this.item.nextSibling;
		}
		if(sibling) {
			this.dropHere(sibling);

			// force a flush before animating the transitions, so that it seems like this first space appears immediately
			sibling.container.clientTop;
		}

		document.body.classList.add('DraggingTab');
	},

	getDropTargetNode: function() {
		if(!this.dropTarget) { return null; }

		if(this.dropTarget.isAGroupItem) {
			if(this.dropTarget.expanded) {
				return this.dropTarget.expanded.tray;
			}
			return this.dropTarget.container;
		}
		if(this.dropTarget._appTabsContainer) {
			return this.dropTarget.parentNode;
		}
		return this.dropTarget;
	},

	canDrop: function(e, dropTarget) {
		e.preventDefault();

		if(this.delayedStart) {
			this.delayedStart.cancel();
			this.finishDragStart();
		}

		// global drag tracking
		UI.lastMoveTime = Date.now();

		this.updateTarget(dropTarget);
	},

	updateTarget: function(dropTarget) {
		if(this.dropTarget != dropTarget) {
			// If the drop target changed, we absolutely need to reset the sibling as well.
			if(this.sibling && this.sibling.parent != dropTarget) {
				this.dropHere(null);
			}

			this.updateDropTargetNode(false);
			this.dropTarget = dropTarget;
			this.updateDropTargetNode(true);
		}
	},

	updateDropTargetNode: function(dragOver) {
		let node = this.getDropTargetNode();
		if(node) {
			let method = (dragOver) ? 'add' : 'remove';
			node.classList[method]('dragOver');
			Listeners[method](node, 'drop', this);
		}
	},

	dropHere: function(sibling) {
		// This shouldn't happen, but still better make sure.
		if(sibling == this.item) { return; }

		let siblingToBe = sibling;
		let i = -1;
		let ii = -1;
		let si = -1;
		let dir = 'before';

		if(sibling) {
			// When hovering the previously hovered item, all it can do is shift to the other side.
			if(this.sibling == sibling && sibling.container.classList.contains('space-before')) {
				sibling.container.classList.remove('space-before');
				sibling.container.classList.add('space-after');
				return;
			}

			if(!sibling.isAnAppItem) {
				i = sibling.parent.children.indexOf(sibling);
				ii = sibling.parent.children.indexOf(this.item);
				if(this.sibling) {
					si = sibling.parent.children.indexOf(this.sibling);

					// If the currently spaced item is set in the same group before the just hovered item,
					// the space should be set on the item immediately after.
					if(si > -1 && si < i) {
						i++;
						siblingToBe = sibling.parent.children[i];
					}
				}
			}
			else if(this.sibling && this.sibling.isAnAppItem) {
				let next = this.sibling.nextSibling;
				while(next) {
					if(next == siblingToBe) {
						siblingToBe = siblingToBe.nextSibling;
						break;
					}
					next = next.nextSibling;
				}
			}
		}

		// Hovering the last item of a row should set the space an item next to it instead,
		// as margins of items in flexboxes are still rendered next to the items as usual.
		let columns = (siblingToBe && !siblingToBe.isAnAppItem && sibling.parent._lastTabSize) ? sibling.parent._lastTabSize.columns : 0;
		if(columns > 1) {
			// Don't forget arrays are 0-based
			let c = i +1;

			// Don't count the item currently being dragged, it's invisible.
			if(ii > -1 && ii < i) {
				c--;
			}

			// Is this item the last one in the row?
			if(c % columns == 0) {
				let p = i -1;
				let n = i +1;

				if(ii > -1) {
					if(ii == p) {
						p--;
					} else if(ii == n) {
						n++;
					}
				}

				if(si > -1 && si < p) {
					siblingToBe = sibling.parent.children[n] || null;
				} else {
					siblingToBe = sibling.parent.children[p];
					dir = 'after';
				}
			}
		}

		// Make sure spaces around any previously hovered item are reset.
		if(this.sibling) {
			this.sibling.container.classList.remove('space-before');
			this.sibling.container.classList.remove('space-after');

			let sibling = this.sibling;
			window.requestAnimationFrame(() => {
				sibling.parent.arrange();
			});
		}

		this.sibling = siblingToBe;
		if(this.sibling) {
			this.sibling.container.classList.add('space-'+dir);

			let sibling = this.sibling;
			window.requestAnimationFrame(() => {
				sibling.parent.arrange();
			});
		}
	},

	drop: function(e) {
		return ItemMove.moveTabs(this, e);
	},

	end: function() {
		this.updateDropTargetNode(false);
		if(this.dropTarget && this.dropTarget.expanded) {
			Listeners.remove(this.dropTarget.expanded.shield, 'dragenter', this);
			Listeners.remove(this.dropTarget.expanded.tray, 'drop', this);
		}

		if(this.sibling) {
			this.sibling.container.classList.remove('space-before');
			this.sibling.container.classList.remove('space-after');
		}

		if(!this.external) {
			Listeners.remove(this.container, 'dragend', this);
			if(this.item.tab?._tabViewTabItem == this.item) { this.item.hidden = this.item.isStacked && !this.item._inVisibleStack; }
		}
		document.body.classList.remove('DraggingTab');

		DraggingTab = null;
	}
};

// This will be the HighlighterDrag object created when a group is dragged or resized.
this.DraggingHighlighter = null;

// Called to create a Drag in response to dragging the search box when in highlight mode.
// Parameters:
//   e - The DOM event that kicks off the drag
this.HighlighterDrag = function(e, callback) {
	DraggingHighlighter = this;
	this.item = Search.searchbox;
	this.$item = iQ(this.item);
	this.callback = callback;
	this.started = false;

	Listeners.add(gWindow, 'mousemove', this);
	Listeners.add(gWindow, 'mouseup', this);

	this.startBounds = this.$item.bounds();
	this.startMouse = new Point(e.clientX, e.clientY);
};

this.HighlighterDrag.prototype = {
	minDragDistance: 3,
	_stoppedMoving: null,

	check: function() {
		return DraggingHighlighter == this;
	},

	start: function(isAuto) {
		if(!this.check()) { return; }

		this.started = true;
	},

	handleEvent: function(e) {
		if(!this.check()) { return; }

		switch(e.type) {
			case 'mousemove':
				let mouse = new Point(e.clientX, e.clientY);

				// positioning
				if(!this.started) {
					if(Math.abs(mouse.x - this.startMouse.x) > this.minDragDistance
					|| Math.abs(mouse.y - this.startMouse.y) > this.minDragDistance) {
						this.start();
					}
				}

				this.drag(e);

				e.preventDefault();
				break;

			case 'mouseup':
				this.stop();
				break;
		}
	},

	drag: function(e) {
		if(!this.check() || !this.started) { return; }

		let mouse = new Point(e.clientX, e.clientY);
		let css = {
			left: this.startBounds.left + (mouse.x - this.startMouse.x),
			top: this.startBounds.top + (mouse.y - this.startMouse.y)
		};
		this.$item.css(css);
	},

	stop: function(immediately) {
		if(!this.check()) { return; }

		Listeners.remove(gWindow, 'mousemove', this);
		Listeners.remove(gWindow, 'mouseup', this);

		if(this.callback) {
			this.callback();
		}

		DraggingHighlighter = null;
	}
};
