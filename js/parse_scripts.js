function MoveCall(action) { //action: 0: map moved, 1: high zoom layer added, 2: low zoom layer added, 3: layer removed, 4: streetlights layer removed, 5: language updated
	const coords = map.getBounds();
	const lefttop = coords.getNorthWest();
	const rightbottom = coords.getSouthEast();
	loadXML(lefttop.lat,lefttop.lng,rightbottom.lat,rightbottom.lng, action);
}

// Return per-layer opacity based on whether data are shown.
function getLayerOpacity(layer, hasData) {
	try {
		if (!layer) return hasData ? OPACITY_HAS_DATA : OPACITY_NO_DATA;
		const name = layer._layerName || (layer.options && layer.options._layerName);
		if (name && window && window.L) {
			if (typeof LAYER_OPACITY_DEFAULTS !== 'undefined' && LAYER_OPACITY_DEFAULTS[name]) {
				return hasData ? LAYER_OPACITY_DEFAULTS[name].hasData : LAYER_OPACITY_DEFAULTS[name].noData;
			}
		}
	} catch (e) {}
	return hasData ? OPACITY_HAS_DATA : OPACITY_NO_DATA;
}

var g_loadedIDs = new Set();

// In-memory cache for OSM elements: key = "type:id" (e.g. "node:123" or "way:456")
// Uses Map + order array to implement a simple LRU with a cap.
var g_cache = new Map();
var g_cacheCap = 15000;
// Keep track of the latest successful AJAX call (bbox string and keys)
var g_latestCall = { bbox: "", keys: new Set() };
// request counter to identify latest initiated request and avoid race conditions
var g_requestCounter = 0;
// current pending AJAX request (so we can abort it when starting a new one)
var g_currentAjax = null;
// Safety limit to avoid parsing extremely large responses that can freeze the browser
var MAX_PARSE_ELEMENTS = 20000;

// Diagnostic logger to locate blocking stages. Enable temporarily while debugging.
var g_diagEnabled = true;
var g_diag = [];
function diag(tag, info) {
	if (!g_diagEnabled) return;
	try {
		var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		g_diag.push({ t: now, tag: tag, info: info });
		if (console && console.info) {
			console.info('DIAG', tag, Math.round(now), info || '');
		}
	} catch (e) {}
}

function cacheTouch(key) {
	// Move key to most-recent position using Map ordering: delete+set
	if (!g_cache.has(key)) return;
	const val = g_cache.get(key);
	g_cache.delete(key);
	g_cache.set(key, val);
}

function trimCache() {
	// Trim oldest entries until at or below cap, but never remove entries referenced by latestCall
	while (g_cache.size > g_cacheCap) {
		const it = g_cache.keys();
		const oldest = it.next().value;
		if (!oldest) break;
		if (g_latestCall.keys && g_latestCall.keys.has(oldest)) {
			// move it to end to keep it for now
			cacheTouch(oldest);
			// if everything is in latestCall, stop trimming
			const removable = Array.from(g_cache.keys()).find(k => !(g_latestCall.keys && g_latestCall.keys.has(k)));
			if (!removable) break;
			continue;
		}
		// try to remove any leaflet objects before deleting to free map references
		try {
			const val = g_cache.get(oldest);
			if (val) {
				if (val.markers && val.markers.length) {
					val.markers.forEach(function(m) { try { if (m.remove) m.remove(); } catch(e){} });
				}
				if (val.shape && val.shape.remove) {
					try { val.shape.remove(); } catch(e){}
				}
			}
		} catch(e) {}
		g_cache.delete(oldest);
	}
}

function cacheAdd(key, value, isLatest) {
	if (g_cache.has(key)) {
		// update stored value and touch (move to end)
		g_cache.delete(key);
		g_cache.set(key, value);
	} else {
		g_cache.set(key, value);
		trimCache();
	}
	if (isLatest) {
		if (!g_latestCall.keys) g_latestCall.keys = new Set();
		g_latestCall.keys.add(key);
	}
}

// Show cached markers/ways that fall into the given bbox immediately.
// north, west, south, east are numeric coordinates.
function showCachedForBBox(north, west, south, east) {
	diag('showCached-start', {north: north, west: west, south: south, east: east});
	// clear visible layers first so we show only items for this bbox
	StreetLightsLayer.clearLayers();
	AviationLayer.clearLayers();
	LitStreetsLayer.clearLayers();
	UnLitStreetsLayer.clearLayers();
	let showCount = 0;
	// iterate over a snapshot of cache entries to avoid mutation issues while touching entries
	const cacheEntries = Array.from(g_cache.entries());
	for (const [key, entry] of cacheEntries) {
		try {
			if (!entry) continue;
			if (entry.type === 'node' && entry.lat && entry.lon && entry.markers && entry.markers.length) {
				const lat = Number(entry.lat);
				const lon = Number(entry.lon);
				if (lat <= north && lat >= south && lon >= west && lon <= east) {
					// re-add markers to appropriate layer
					entry.markers.forEach(function(m) {
						try {
							if (!m) return;
							if (m._map) return; // already on a map
							if (entry.tags && (entry.tags.lightSource === 'aviation' || entry.tags.lightSource === 'warning')) {
								AviationLayer.addLayer(m);
							} else {
								StreetLightsLayer.addLayer(m);
							}
						} catch(e) {}
					});
					// touch so it becomes recent and protect from trimming
					cacheTouch(key);
					if (!g_latestCall.keys) g_latestCall.keys = new Set();
					g_latestCall.keys.add(key);
					showCount++;
				}
			} else if (entry.type === 'way' && entry.shape) {
				// for ways, check bounding box of coordinates if available via shape.getBounds
				try {
					const b = entry.shape.getBounds && entry.shape.getBounds();
					if (b) {
						const bNorth = b.getNorth();
						const bSouth = b.getSouth();
						const bWest = b.getWest();
						const bEast = b.getEast();
						// simple intersection test
						if (!(bNorth < south || bSouth > north || bEast < west || bWest > east)) {
							// add to correct layer depending on tag
							if (entry.tags && entry.tags.lit && entry.tags.lit != 'no') {
								LitStreetsLayer.addLayer(entry.shape);
							} else {
								UnLitStreetsLayer.addLayer(entry.shape);
							}
							cacheTouch(key);
							if (!g_latestCall.keys) g_latestCall.keys = new Set();
							g_latestCall.keys.add(key);
							showCount++;
						}
					}
				} catch(e) {}
			}
		} catch(e) {}
	}
	diag('showCached-end', {shown: showCount});
}

function loadXML(lat1,lon1,lat2,lon2, action) { //action: 0: map moved, 1: high zoom layer added, 2: low zoom layer added, 3: layer removed, 4: streetlights layer removed, 5: language updated
	
	let hasHighZoomLayer = false, hasLowZoomLayer = false, zoomWarning = 1;
	
	// Special case: Low Zoom data loaded once
	if (g_showStreetLightsLowZoomOnce && map.getZoom() < MIN_ZOOM_LOW_ZOOM) {
		hasHighZoomLayer = false;
		hasLowZoomLayer = false;
		zoomWarning = 4
	} else {
		if (map.getZoom() >= MIN_ZOOM) {
			zoomWarning = 0
			
			if (map.hasLayer(StreetLightsLayer) || map.hasLayer(AviationLayer) || map.hasLayer(LitStreetsLayer) || map.hasLayer(UnLitStreetsLayer)) {
				if (!map.hasLayer(StreetLightsLayer) && map.hasLayer(StreetLightsLowZoomLayer)) {
					hasLowZoomLayer = true;
				} else {
					hasLowZoomLayer = false;
				}
				hasHighZoomLayer = true;
			} else if (map.hasLayer(StreetLightsLowZoomLayer)) {  
				hasHighZoomLayer = false;
				hasLowZoomLayer = true;
			} else { // no map layers loaded
				hasHighZoomLayer = false;
				hasLowZoomLayer = false;
				zoomWarning = 2
			}
		} else {
			hasLowZoomLayer = false;
			if (map.hasLayer(StreetLightsLowZoomLayer)) { 
				if (map.getZoom() >= MIN_ZOOM_LOW_ZOOM) {
					hasLowZoomLayer = true;
					zoomWarning = 0;
				} else {
					hasLowZoomLayer = false;
					zoomWarning = 3;
				}
			} else {
				hasHighZoomLayer = false;
				zoomWarning = 1
				if (map.getZoom() < MIN_ZOOM_LOW_ZOOM) {
					zoomWarning = 3;
				}
			}
		}
	}
	// load data if map moved or layer added
	if (hasHighZoomLayer && (action == 0 || action == 1)) {
		loadData('[bbox:' + lat2 + ',' + lon1 + ',' + lat1 + ',' + lon2 +  '];', lat1, lon1, lat2, lon2);
	}
	if (hasLowZoomLayer && (action == 0 || action == 2 || action == 4)) {
		loadDataLowZoom('[bbox:' + lat2 + ',' + lon1 + ',' + lat1 + ',' + lon2 + '];');
	}
	
	//remove data:
	if (!hasHighZoomLayer) {
		parseOSM(false, false);
	}
	if(!hasLowZoomLayer && zoomWarning!=4) {
		parseOSMlowZoom(false, false);
		g_showStreetLightsLowZoomOnce = false;
	}
	if(!hasHighZoomLayer && !hasLowZoomLayer && zoomWarning!=4) {
		// reset loading counter
		loadingcounter = 0;		
		g_showData = false;
		// update opacity using per-layer defaults when available
		const opNoData = (typeof getLayerOpacity === 'function') ? getLayerOpacity(current_layer, false) : g_opacityNoData;
		current_layer.setOpacity(opNoData);
		$("#opacity_slider").slider("option", "value", opNoData * 100);    
	}
	
	//handle zoom warning
	if (zoomWarning)
	{
		//update zoomtext
		let textZoom = "Zoom in to load data";
		if(i18next.isInitialized && zoomWarning < 4){
			textZoom = i18next.t("zoomtext_" + zoomWarning);
		}
		$( "#zoomtext" ).text(textZoom)
		
		//show load update and clear low zoom data buttons
		if (zoomWarning == 3) {
			$( "#zoomtext" ).show();
			$( "#load_lowzoom_data" ).show();
			$( "#update_lowzoom_data" ).hide();
			$( "#clear_lowzoom_data" ).hide();

		} else if (zoomWarning == 4) {
			$( "#zoomtext" ).hide();
			$( "#load_lowzoom_data" ).hide();
			$( "#update_lowzoom_data" ).show();
			$( "#clear_lowzoom_data" ).show();
			
		} else {
			$( "#zoomtext" ).show();
			$( "#load_lowzoom_data" ).hide();
			$( "#update_lowzoom_data" ).hide();
			$( "#clear_lowzoom_data" ).hide();
			
		}
		
		// fade in zoom warning
		$( "#zoomwarning_cont" ).fadeIn(500);	

	} else {
		g_showData = true;
		$( "#zoomwarning_cont" ).fadeOut(500);
		const opHasData = (typeof getLayerOpacity === 'function') ? getLayerOpacity(current_layer, true) : g_opacityHasData;
		current_layer.setOpacity(opHasData);
		$("#opacity_slider").slider("option", "value", opHasData * 100);
	}
	
}

function loadLowZoomDataOnce() {
	
	g_showStreetLightsLowZoomOnce = true;
	g_showData = true;
	let coords = map.getBounds();
	let lefttop = coords.getNorthWest(), rightbottom = coords.getSouthEast();
	let lat1 = lefttop.lat, lon1 = lefttop.lng, lat2 = rightbottom.lat, lon2 = rightbottom.lng;
	
	map.addLayer(StreetLightsLowZoomLayer);
	loadDataLowZoom('[bbox:' + lat2 + ',' + lon1 + ',' + lat1 + ',' + lon2 + '];');
	
	$( "#zoomwarning_cont" ).fadeOut(500);
	const opHasData2 = (typeof getLayerOpacity === 'function') ? getLayerOpacity(current_layer, true) : g_opacityHasData;
	current_layer.setOpacity(opHasData2);
	$("#opacity_slider").slider("option", "value", opHasData2 * 100);
}	

function clearLowZoomData() {
	g_showStreetLightsLowZoomOnce = false;
	g_showData = false;
	map.removeLayer(StreetLightsLowZoomLayer)
}

function loadData(bbox, north, west, south, east) {
	$( "#loading_text" ).text("")
	$( "#loading" ).attr("class", "");
	$( "#loading_icon" ).attr("class", "loading_spinner")
	$( "#loading_cont" ).fadeIn(100)
	loadingcounter++;

	//CrossoverAPI XML request
	// Street Light query
	XMLRequestText = "[timeout: " + TIMEOUT + "]" + bbox + '( node["highway"="street_lamp"]; node["light_source"]; node["tower:type"="lighting"]; node["aeroway"="navigationaid"];'

	today = new Date();
	if (today.getMonth() == 11) { // show christmas trees only in December
		XMLRequestText += 'node["xmas:feature"="tree"];'
	}

	if (map.hasLayer(LitStreetsLayer) || map.hasLayer(UnLitStreetsLayer)) {
		XMLRequestText += '(way["highway"][!area]["lit"]; >;); ' +
			'(way["highway"][area]["lit"]; >;); ';
	}
	XMLRequestText += '); out qt; '
	//console.log ( XMLRequestText );

	//URL Codieren
	XMLRequestText = encodeURIComponent(XMLRequestText);

	if (location.protocol == 'https:') {
		RequestProtocol = "https://";
	} else {
		RequestProtocol = "http://";
	}

	RequestURL = RequestProtocol + "overpass-api.de/api/interpreter?data=" + XMLRequestText;
    
	// mark this request as the latest initiated request and clear keys for it
	g_requestCounter++;
	const thisRequestId = g_requestCounter;
	g_latestCall.requestId = thisRequestId;
	g_latestCall.bbox = XMLRequestText;
	g_latestCall.keys = new Set();

	// diagnostic: request started
	diag('loadData-start', { requestId: thisRequestId, zoom: map.getZoom() });

	// show cached items for this bbox immediately (and protect their keys)
	if (typeof north !== 'undefined') {
		diag('loadData-before-showCached', { requestId: thisRequestId });
		try { showCachedForBBox(north, west, south, east); } catch(e) {}
		diag('loadData-after-showCached', { requestId: thisRequestId });
	}
	// Abort any previous request still running to avoid piling up work
	try {
		if (g_currentAjax && g_currentAjax.readyState !== 4) {
			g_currentAjax.abort();
		}
	} catch(e) {}
	//AJAX REQUEST (store handle so we can abort if needed)
	g_currentAjax = $.ajax({
		url: RequestURL,
		type: 'GET',
		crossDomain: true,
		success: function(data, textStatus, jqXHR) {
			// clear current handle
			g_currentAjax = null;
			// basic validation: ensure we received an OSM XML doc or at least something containing <osm
			let isXmlDoc = false;
			let ajax_nodeCount = 0, ajax_wayCount = 0;
			try {
				isXmlDoc = (typeof data === 'object' && data !== null && data.documentElement && (data.documentElement.nodeName === 'osm' || data.documentElement.nodeName.toLowerCase && data.documentElement.nodeName.toLowerCase() === 'osm'));
			} catch(e) { isXmlDoc = false; }
			if (!isXmlDoc) {
				// sometimes servers return HTML error pages (or plain text). bail out safely.
				if (typeof data === 'string' && data.indexOf('<osm') === -1) {
					console.error('Overpass response not valid OSM XML - skipping parse');
					if (loadingcounter==1) {
						$( "#loading_text" ).html("")
						$( "#loading" ).attr("class", "error");
						$( "#loading_icon" ).attr("class", "loading_error")
					}
					loadingcounter = Math.max(0, loadingcounter - 1);
					return;
				}
			}
			// If we have XML, protect against extremely large responses
			if (isXmlDoc) {
				try {
					ajax_nodeCount = (data.getElementsByTagName('node') && data.getElementsByTagName('node').length) || 0;
					ajax_wayCount = (data.getElementsByTagName('way') && data.getElementsByTagName('way').length) || 0;
					const total = ajax_nodeCount + ajax_wayCount;
					if (total > MAX_PARSE_ELEMENTS) {
						console.error('Overpass response too large (elements=' + total + '), skipping parse to avoid freeze');
						if (loadingcounter==1) {
							$( "#loading_text" ).html("")
							$( "#loading" ).attr("class", "error");
							$( "#loading_icon" ).attr("class", "loading_error")
						}
						loadingcounter = Math.max(0, loadingcounter - 1);
						return;
					}
				} catch(e) {}
			}
			// diagnostic: AJAX success with element counts
			diag('ajax-success', { isXmlDoc: !!isXmlDoc, nodes: ajax_nodeCount, ways: ajax_wayCount });
			// only treat this response as "latest" if its id matches the most recently initiated request
			const isLatest = (thisRequestId === g_latestCall.requestId);
			if (loadingcounter==1) {
				$( "#loading_text" ).html("")
				$( "#loading" ).attr("class", "success");
				$( "#loading_icon" ).attr("class", "loading_success")
			}
			loadingcounter = Math.max(0, loadingcounter - 1);
			parseOSM(data, isLatest);
		},
		error: function(jqXHR, textStatus, errorThrown){
			// clear current handle
			g_currentAjax = null;
			// if aborted intentionally, don't spam UI
			if (textStatus === 'abort') {
				loadingcounter = Math.max(0, loadingcounter - 1);
				return;
			}
			
			if( i18next.isInitialized) {
				if (textStatus == "timeout" || textStatus == "error" || textStatus == "parseerror") {
					textStatus_value = i18next.t("ajaxerror_" + textStatus);
				} else {
					textStatus_value = i18next.t("ajaxerror_unknown");
				}
			} else { // fallback in case i18next is not initalized yet.
				textStatus_value = "Error while loading data";
			}
			
			$( "#loading" ).attr("class", "error");
			$( "#loading_icon" ).attr("class", "loading_error")
			$( "#loading_text" ).html("&nbsp;" + textStatus_value)
			loadingcounter = Math.max(0, loadingcounter - 1);
		},
		timeout: 10000 // timeout after 10s
	});
}
function loadDataLowZoom(bbox)
{
	$( "#loading_text" ).text("")
	$( "#loading" ).attr("class", "");
	$( "#loading_icon" ).attr("class", "loading_spinner")
	$( "#loading_cont" ).fadeIn(100)
	loadingcounter++;

	//CrossoverAPI XML request
	if (location.protocol == 'https:') {
		RequestProtocol = "https://";
	}
	else {
		RequestProtocol = "http://";
	}

	XMLRequestTextLowZoom = "[timeout: " + TIMEOUT + "]" + bbox + '( node["highway"="street_lamp"]; node["light_source"];); out skel;'
	RequestURLlowZoom = RequestProtocol + "overpass-api.de/api/interpreter?data=" + XMLRequestTextLowZoom;
    
	// mark this low-zoom request as latest and clear keys
	g_requestCounter++;
	const thisLowRequestId = g_requestCounter;
	g_latestCall.requestId = thisLowRequestId;
	g_latestCall.bbox = XMLRequestTextLowZoom;
	g_latestCall.keys = new Set();
	// Abort any previous request still running to avoid piling up work
	try {
		if (g_currentAjax && g_currentAjax.readyState !== 4) {
			g_currentAjax.abort();
		}
	} catch(e) {}
	//AJAX REQUEST (store handle so we can abort if needed)
	g_currentAjax = $.ajax({
		url: RequestURLlowZoom,
		type: 'GET',
		crossDomain: true,
		success: function(data, textStatus, jqXHR){
			g_currentAjax = null;
			// validate response similarly to high-zoom
			let isXmlDoc = false;
			try { isXmlDoc = (typeof data === 'object' && data !== null && data.documentElement && (data.documentElement.nodeName === 'osm' || (data.documentElement.nodeName.toLowerCase && data.documentElement.nodeName.toLowerCase() === 'osm'))); } catch(e) { isXmlDoc = false; }
			if (!isXmlDoc) {
				if (typeof data === 'string' && data.indexOf('<osm') === -1) {
					console.error('Overpass low-zoom response not valid OSM XML - skipping parse');
					if (loadingcounter==1) {
						$( "#loading_text" ).html("")
						$( "#loading" ).attr("class", "error");
						$( "#loading_icon" ).attr("class", "loading_error")
					}
					loadingcounter = Math.max(0, loadingcounter - 1);
					return;
				}
			}
			// element size guard
			if (isXmlDoc) {
				try {
					const nodeCount = (data.getElementsByTagName('node') && data.getElementsByTagName('node').length) || 0;
					if (nodeCount > MAX_PARSE_ELEMENTS) {
						console.error('Overpass low-zoom response too large (nodes=' + nodeCount + '), skipping parse');
						if (loadingcounter==1) {
							$( "#loading_text" ).html("")
							$( "#loading" ).attr("class", "error");
							$( "#loading_icon" ).attr("class", "loading_error")
						}
						loadingcounter = Math.max(0, loadingcounter - 1);
						return;
					}
				} catch(e) {}
			}
			const isLatest = (thisLowRequestId === g_latestCall.requestId);
			if (loadingcounter==1) {
				$( "#loading_text" ).html("")
				$( "#loading" ).attr("class", "success");
				$( "#loading_icon" ).attr("class", "loading_success")
			}
			loadingcounter = Math.max(0, loadingcounter - 1);
			parseOSMlowZoom(data, isLatest);
		},
		error: function(jqXHR, textStatus, errorThrown) {
			g_currentAjax = null;
			if (textStatus === 'abort') { loadingcounter = Math.max(0, loadingcounter - 1); return; }
			if (i18next.isInitialized) {
				if (textStatus == "timeout" || textStatus == "error" || textStatus == "parseerror") {
					textStatus_value = i18next.t("ajaxerror_" + textStatus);
				} else {
					textStatus_value = i18next.t("ajaxerror_unknown");
				}
			} else {
				textStatus_value = "Error while loading data";
			}
			$( "#loading" ).attr("class", "error");
			$( "#loading_icon" ).attr("class", "loading_error")
			$( "#loading_text" ).html("&nbsp;" + textStatus_value)
			loadingcounter = Math.max(0, loadingcounter - 1);
		},
		timeout: 10000 // timeout after 10s
	});
}

function parseOSM(data, isLatest)
{
	//console.log(data);
	let MarkerArray = new Array();
	let CoordObj = new Object();
	StreetLightsLayer.clearLayers();
	AviationLayer.clearLayers();
	LitStreetsLayer.clearLayers();
	UnLitStreetsLayer.clearLayers();

	// Defensive guard: if data is present but not an OSM XML document, skip heavy parsing
	if (data && typeof data === 'object' && data.documentElement && data.documentElement.nodeName && data.documentElement.nodeName.toLowerCase() !== 'osm') {
		console.error('parseOSM: invalid XML document, skipping parse');
		if (isLatest) {
			g_latestCall.keys = new Set();
		}
		return;
	}
	// If XML, guard against extremely large responses
	let parse_nodes = 0, parse_ways = 0;
	if (data && typeof data === 'object' && data.getElementsByTagName) {
		try {
			parse_nodes = (data.getElementsByTagName('node') && data.getElementsByTagName('node').length) || 0;
			parse_ways = (data.getElementsByTagName('way') && data.getElementsByTagName('way').length) || 0;
			if ((parse_nodes + parse_ways) > MAX_PARSE_ELEMENTS) {
				console.error('parseOSM: response too large (elements=' + (parse_nodes + parse_ways) + '), skipping parse');
				if (isLatest) g_latestCall.keys = new Set();
				return;
			}
		} catch(e) {}
	}
	// diagnostic: parse starting
	diag('parseOSM-start', { nodes: parse_nodes, ways: parse_ways });

	if (data === false) {
		// when asked to remove data we also clear latestCall keys
		if (isLatest) {
			g_latestCall.keys = new Set();
		}
		return;
	}

	$(data).find('node,way').each(function() {
		let EleID = $(this).attr("id");
		let EleCoordArray = new Array();
		let EleType = "";
		let EleLat, EleLon, EleObj;

		if ($(this).attr("lat")) { // Node
			EleType = "node"
			EleLat = $(this).attr("lat");
			EleLon = $(this).attr("lon");
			EleObj = new Object();
			EleObj["lat"] = EleLat;
			EleObj["lon"] = EleLon;
			CoordObj[EleID] = EleObj;
		} else { // Way
			EleType = "way";
			$(this).find('nd').each(function() {
				let NdRefID = $(this).attr("ref");
				EleCoordArray.push([CoordObj[NdRefID]["lat"], CoordObj[NdRefID]["lon"]]);
			});
		}

		let EleText = "";
		let tagHighway, tagAeroway, tagOperator, tagRef, tagStartDate, tagManufacturer, tagModel, tagHeight, tagWidth, tagLightColour, tagLightCount, tagLightDirection, tagLightFlash, tagLightHeight, tagLightLit, tagLightShape, tagLightMethod, tagLampMount, tagLightSource, tagNavigationaid, tagLit, tagArea;

		$(this).find('tag').each(function(){
			let EleKey = $(this).attr("k");
			let EleValue = $(this).attr("v");
			if ( EleKey == "highway") {
				tagHighway = EleValue;
			} else if (EleKey == "aeroway") {
				tagAeroway = EleValue;
			} else if ((EleKey == "operator" && !tagOperator) || EleKey == "lamp_operator") {
				tagOperator = EleValue;
			} else if ((EleKey == "ref" && !tagRef) || EleKey == "lamp_ref") {
				tagRef = EleValue;
			} else if (EleKey == "start_date") {
				tagStartDate = EleValue;
			} else if (EleKey == "manufacturer") {
				tagManufacturer = EleValue;
			} else if (EleKey == "lamp_model" || EleKey == "lamp_model:de" || EleKey == "model") {
				tagModel = EleValue;
			} else if (EleKey == "height") {
				tagHeight = EleValue;
			} else if (EleKey == "width") {
				tagWidth = EleValue;
			} else if (EleKey == "light:count") {
				tagLightCount = EleValue;
			} else if (EleKey == "light:colour") {
				tagLightColour = EleValue;
			} else if ((EleKey == "direction" && !tagLightDirection) || EleKey == "light:direction") {
				tagLightDirection = EleValue;
			} else if (EleKey == "light:height") {
				tagLightHeight = EleValue;
			} else if (EleKey == "light:method" || EleKey == "lamp_type") {
				tagLightMethod = EleValue;
			} else if (EleKey == "light:mount" || EleKey == "lamp_mount" || EleKey == "support") {
				tagLampMount = EleValue;
			} else if (EleKey == "light:lit") {
				tagLightLit = EleValue;
			} else if (EleKey == "light:shape") {
				tagLightShape = EleValue;
			} else if (EleKey == "light:flash") {
				tagLightFlash = EleValue;
			} else if (EleKey == "light:character" && EleValue != "fixed") {
				tagLightFlash = "yes";
			} else if (EleKey == "light_source") {
				tagLightSource = EleValue;
			} else if (EleKey == "tower:type" && !tagLightSource) {
				if (EleValue == "lighting")
				{
					tagLightSource = "floodlight";
				}
			} else if (EleKey == "navigationaid") {
				tagNavigationaid = EleValue;
			} else if (EleKey == "xmas:feature") {
				tagLightSource = "xmas";
			} else if (EleKey == "area") {
				tagArea = EleValue;
			} else if (EleKey == "lit") {
				tagLit = EleValue
			}

		});

		if (tagHighway == "street_lamp" && !tagLightSource) {
			tagLightSource = "lantern";
		}

		if (tagAeroway == "navigationaid" && !tagLightSource) {
			tagLightSource = "aviation";
			if (!tagNavigationaid){ // unknown navigationaid
				tagNavigationaid = "unknown";
			}
		}
		
		if (!tagLightCount) {
			tagLightCount = 1;
		}

		if (tagLightSource) {
			
			let textLightType = "", textStartDate = "", textManufacturer = "", textModel = "", textHeight = "", textLightHeight = "", textWidth = "", textLightMethod = "", textLampMount = "", textLightLit = "", textLightCount = "";
			
			if(tagLightSource == "lantern") {
				textLightType = i18next.t("lamp_lantern");
			} else if(tagLightSource == "floodlight") {
				textLightType = i18next.t("lamp_floodlight");
			} else if(tagLightSource == "warning") {
				textLightType = i18next.t("lamp_warning");
			} else if(tagLightSource == "aviation") {
				if(tagNavigationaid == "als") { // Approach Lighting System
					textLightType = i18next.t("lamp_aviation_als");
				} else if(tagNavigationaid == "papi") { // Precision Approach Path Indicator
					textLightType = i18next.t("lamp_aviation_papi");
				} else if(tagNavigationaid == "vasi") { // Visual Approach Slope Indicator
					textLightType = i18next.t("lamp_aviation_vasi");
				} else if(tagNavigationaid == "txe") { // Taxiway Edge Light
					textLightType = i18next.t("lamp_aviation_txe");
				} else if(tagNavigationaid == "txc") { // Taxiway Centre Light
					textLightType = i18next.t("lamp_aviation_txc");
				} else if(tagNavigationaid == "rwe") { // Runway Edge Light
					textLightType = i18next.t("lamp_aviation_rwe");
				} else if(tagNavigationaid == "rwc") { // Runway Centre Light
					textLightType = i18next.t("lamp_aviation_rwc");
				} else if(tagNavigationaid == "tdz") { // Touchdown Zone
					textLightType = i18next.t("lamp_aviation_tdz");
				} else if(tagNavigationaid == "rgl") { // Runway Guard Light
					textLightType = i18next.t("lamp_aviation_rgl");
				} else if(tagNavigationaid == "beacon") { // Aerodrome Beacon
					textLightType = i18next.t("lamp_aviation_beacon");
				} else {
					textLightType = i18next.t("lamp_aviation");
				}
			} else {
				textLightType = i18next.t("lamp_unknown");
			}

			if (!tagOperator) {
				tagOperator = "<i>" + i18next.t("unknown") + "</i>";
			}
			

			//Tags that are only shown when available
			if (tagStartDate) {
				textStartDate = "<tr><td><b>" + i18next.t("lamp_start_date") + ": </b></td><td>" + tagStartDate + "</td></tr>";
			}
			if (tagManufacturer) {
				textManufacturer = "<tr><td><b>" + i18next.t("lamp_manufacturer") + ": </b></td><td>" + tagManufacturer + "</td></tr>";
			}
			if (tagModel) {
				textModel = "<tr><td><b>" + i18next.t("lamp_model") + ": </b></td><td>" + tagModel + "</td></tr>";
			}
			if (tagHeight) {
				textHeight = "<tr><td><b>" + i18next.t("lamp_height") + ": </b></td><td>" + tagHeight + " m</td></tr>";
			}
			if (tagLightHeight) {
				textLightHeight = "<tr><td><b>" + i18next.t("lamp_light_height") + ": </b></td><td>" + tagLightHeight + " m</td></tr>";
			}
			if (tagWidth) {
				textWidth = "<tr><td><b>" + i18next.t("lamp_width") + ": </b></td><td>" + tagWidth + "</td></tr>";
			}
			if (tagLightMethod) {
				textLightMethod = "<tr><td><b>" + i18next.t("lamp_method") + ": </b></td><td>" + getLightMethod(tagLightMethod) + "</td></tr>";
			}
			if (tagLampMount) {
				textLampMount = "<tr><td><b>" + i18next.t("lamp_mount") + ": </b></td><td>" + getLightMount(tagLampMount) + "</td></tr>";
			}
			if (tagLightLit) {
				textLightLit = "<tr><td><b>" + i18next.t("lamp_time") + ": </b></td><td>" + getLightLit(tagLightLit) + "</td></tr>";
			}
			if (tagLightCount > 1) {
				textLightCount = "<tr><td><b>" + i18next.t("lamp_count") + ": </b></td><td>" + tagLightCount + "</td></tr>";
			}
			
			// Restrict number of shown light sources for single points to reduce clutter
			if (tagLightCount > 1) {
				tagLightCount = Math.min(tagLightCount, LIGHT_COUNT_MAX)
			}
			if (!tagRef && tagRef !== 0) {
				tagRef = ""
			}
			EleText =
				"<b>" + textLightType + " " + tagRef + "</b><br>" +
				"<div class='infoblock'><table>" +
				"<tr><td><b>" + i18next.t("lamp_operator") + ": </b></td><td>" + tagOperator + "</td></tr>" +
				textLightMethod +
				textLampMount +
				textStartDate +
				textManufacturer +
				textModel +
				textHeight +
				textWidth +
				textLightHeight +
				textLightLit +
				textLightCount +
				"</table></div>" +
				"<br><a href='#' onclick='openinJOSM(\""+EleType+"\",\""+EleID+"\")'>edit in JOSM</a> | <a href='https://www.openstreetmap.org/"+EleType+"/"+EleID+"'>show in OSM</a>"
				;
			
			if (!tagLightHeight && tagHeight) {
				tagLightHeight = tagHeight;
			}

			if($.inArray(EleID, MarkerArray) == -1) {
				let lightDirectionArray = [], refArray = []
				let createdMarkers = [];
				let createdMarkerInfos = [];
				let cacheKey = EleType + ':' + EleID;
				// Try to reuse cached markers/shapes
				if (g_cache.has(cacheKey)) {
					const cached = g_cache.get(cacheKey);
					cacheTouch(cacheKey);
					// re-add or refresh cached markers if available (cache hit)
					if (cached.markers && cached.markers.length) {
						// if we have per-marker infos, update icon/position per info
						if (cached.markerInfos && cached.markerInfos.length && cached.markerInfos.length === cached.markers.length) {
							for (let mi = 0; mi < cached.markers.length; mi++) {
								const m = cached.markers[mi];
								const info = cached.markerInfos[mi];
								try {
									if (m.setLatLng && info && info.lat && info.lon) m.setLatLng(new L.LatLng(info.lat, info.lon));
									// recompute icon for current zoom/state
									const Icon = getMarkerIcon(L, cached.tags.lightSource, cached.tags.lightMethod, cached.tags.lightColour, cached.tags.lightFlash, info.direction, cached.tags.lightShape, cached.tags.lightHeight, cached.tags.navigationaid, info.ref);
									if (m.setIcon) m.setIcon(Icon);
									if (EleText) {
										if (m.getPopup && m.getPopup()) {
											m.getPopup().setContent(EleText);
										} else if (m.bindPopup) {
											m.bindPopup(EleText);
										}
									}
									if(cached.tags.lightSource == "aviation" || cached.tags.lightSource == "warning") {
										AviationLayer.addLayer(m);
									} else {
										StreetLightsLayer.addLayer(m);
									}
								} catch(e) {}
							}
						} else {
							// no per-marker infos — fall back to re-adding existing markers and updating popup
							cached.markers.forEach(function(m) {
								try {
									if (m.getPopup) {
										if (EleText && m.getPopup()) {
											m.getPopup().setContent(EleText);
										} else if (EleText && !m.getPopup()) {
											m.bindPopup(EleText);
										}
									}
									if(cached.tags.lightSource == "aviation" || cached.tags.lightSource == "warning") {
										AviationLayer.addLayer(m);
									} else {
										StreetLightsLayer.addLayer(m);
									}
								} catch(e) {}
							});
						}
						// mark as part of latest if applicable
						if (isLatest) {
							if (!g_latestCall.keys) g_latestCall.keys = new Set();
							g_latestCall.keys.add(cacheKey);
						}
						MarkerArray.push(EleID);
						// skip creating new markers
						return;
					}
				}
				if (tagLightDirection) {
					lightDirectionArray = tagLightDirection.split(";");
				}
				if (tagRef) {
					refArray = tagRef.split(";")
				}
 
				// Handle lights with only one direction given
				let isSingleDir = false;
				let posDirection0 = 0;
				if (lightDirectionArray.length == 1 && tagLightCount > 1 && (lightDirectionArray[0] > 0 || lightDirectionArray[0] === 0))
				{
					isSingleDir = true;
					posDirection0 = lightDirectionArray[0] // keep first value in memory
				}
				
				let i = tagLightCount; 
				let j = 0;
				let posDirection = new Array();
				while (i > 0) {
					let EleLatNew, EleLonNew;
					// Positioning of multiple lights at same spot (tagLightCount > 1)
					if (tagLightCount > 1) {
						let posDistance = 0;
						if (isSingleDir) { //only one direction value given -> assume all lights are parallel:		
							posDirection[j] = posDirection0 * 1 + 90;
							posDistance = 1.5 * j - ( (1.5 * tagLightCount) / 2 );
							if ( posDirection[j] > 360 ) {
								posDirection[j] = posDirection[j] - 360;
							}
						} else if (lightDirectionArray[j] === 0 || (lightDirectionArray[j] > 0 && lightDirectionArray[j] <= 360 )) {
							posDirection[j] = lightDirectionArray[j];
							posDistance = 1.5;
						} else if (j > 0) {
							posDirection[j] = posDirection[j-1] * 1 + 360 / tagLightCount;
							posDistance = 1.5 ;
							if ( posDirection[j] > 360 ) {
								posDirection[j] = posDirection[j] - 360;
							}
						} else {
							posDirection[j] = 0;
							posDistance = 1.5;
						}
						[EleLatNew,EleLonNew] = addLatLngDistanceM(EleLat,EleLon,(posDirection[j]),posDistance);
					} else {
						[EleLatNew,EleLonNew] = [EleLat,EleLon];
					}

					if (!lightDirectionArray[j]) {
						lightDirectionArray[j] = lightDirectionArray[j-1];
					}
					if (!refArray[j]) {
						refArray[j] = "";
					}

					let markerLocation = new L.LatLng(EleLatNew,EleLonNew);
					
					let Icon = getMarkerIcon(L,tagLightSource, tagLightMethod, tagLightColour, tagLightFlash, lightDirectionArray[j], tagLightShape, tagLightHeight, tagNavigationaid, refArray[j]);
					let marker = new L.Marker(markerLocation,{icon : Icon});

					if(EleText!="")
					{
						marker.bindPopup(EleText);
					}
						
					if(tagLightSource == "aviation" || tagLightSource == "warning") {
						AviationLayer.addLayer(marker);
					} else {
						StreetLightsLayer.addLayer(marker);
					}

					// record marker for caching/reuse
					if (typeof createdMarkers !== 'undefined') createdMarkers.push(marker);
					if (typeof createdMarkerInfos !== 'undefined') createdMarkerInfos.push({ lat: EleLatNew, lon: EleLonNew, direction: lightDirectionArray[j], ref: refArray[j] });

					i = i - 1;
					j = j + 1;
				}
				// finished creating markers for this element — record once and cache
				MarkerArray.push(EleID);
				let cacheKey2 = EleType + ':' + EleID;
				let cacheValue2 = {
					type: EleType,
					lat: EleLat,
					lon: EleLon,
					text: EleText,
					tags: {
						lightSource: tagLightSource,
						lightMethod: tagLightMethod,
						lightColour: tagLightColour,
						lightFlash: tagLightFlash,
						lightDirection: tagLightDirection,
						lightShape: tagLightShape,
						lightHeight: tagLightHeight,
						navigationaid: tagNavigationaid,
						ref: tagRef
					},
					markers: createdMarkers,
					markerInfos: createdMarkerInfos
				};
				cacheAdd(cacheKey2, cacheValue2, !!isLatest);

			}

		} else if (tagLit == "no" || tagLit == "disused") {
			// Draw ways, which have no popup
			let cacheKeyWay = "way:" + EleID;
			if (g_cache.has(cacheKeyWay)) {
				const cachedWay = g_cache.get(cacheKeyWay);
				cacheTouch(cacheKeyWay);
				if (cachedWay.shape) {
					UnLitStreetsLayer.addLayer(cachedWay.shape);
				}
			} else {
				if(tagArea) {
					let shape = L.polygon(EleCoordArray.map(p => new L.LatLng(p[0], p[1])), {
						stroke: false, fillColor: '#000000', fillOpacity: 0.4,
						weight: 3
					})
					UnLitStreetsLayer.addLayer(shape);
					cacheAdd(cacheKeyWay, { type: 'way', shape: shape, tags: { lit: tagLit, area: tagArea } }, !!isLatest);
				} else {
					let line = L.polyline(EleCoordArray.map(p => new L.LatLng(p[0], p[1])), {
						color: '#111111',
						weight: 3
					})
					UnLitStreetsLayer.addLayer(line)
					cacheAdd(cacheKeyWay, { type: 'way', shape: line, tags: { lit: tagLit } }, !!isLatest);
				}
			}
		} else if (tagLit == "yes" || tagLit == "24/7" || tagLit == "automatic" || tagLit == "limited" || tagLit == "sunset-sunrise" || tagLit == "dusk-dawn" || tagLit == "interval") {
			// Draw ways, which have no popup
			if (tagLit == "automatic") {
				strokeDashArray = "2 3";
				strokeColor = "#BBBBBB";
			} else if (tagLit == "limited" || tagLit == "interval") {
				strokeDashArray = "8";
				strokeColor = "#BBBBBB";
			} else {
				strokeDashArray = "0";
				strokeColor = "#BBBBBB";
			}
			let cacheKeyWay2 = "way:" + EleID;
			if (g_cache.has(cacheKeyWay2)) {
				const cachedWay2 = g_cache.get(cacheKeyWay2);
				cacheTouch(cacheKeyWay2);
				if (cachedWay2.shape) {
					LitStreetsLayer.addLayer(cachedWay2.shape);
				}
			} else {
				if (tagArea) {
					let shape = L.polygon(EleCoordArray.map(p => new L.LatLng(p[0], p[1])), {
						stroke: false, fillColor: strokeColor, fillOpacity: 0.4,
						weight: 3,
						dashArray: strokeDashArray
					})
					LitStreetsLayer.addLayer(shape);
					cacheAdd(cacheKeyWay2, { type: 'way', shape: shape, tags: { lit: tagLit, area: tagArea } }, !!isLatest);
				} else {
					let line = L.polyline(EleCoordArray.map(p => new L.LatLng(p[0], p[1])), {
						color: strokeColor,
						weight: 3,
						dashArray: strokeDashArray
					})
					LitStreetsLayer.addLayer(line)
					cacheAdd(cacheKeyWay2, { type: 'way', shape: line, tags: { lit: tagLit } }, !!isLatest);
					
					if (tagLit == "24/7") { // dotted outline for 24/7
						let line2 = L.polyline(EleCoordArray.map(p => new L.LatLng(p[0], p[1])), {
							color: strokeColor,
							weight: 5,
							dashArray: "1 6"
						})
						LitStreetsLayer.addLayer(line2)
						// optionally cache the thicker outline too (skip to save mem)
					}
				}
			}
		}
	});

	// fadeout loading icon and reset loading counter
	// diagnostic: parse finished
	diag('parseOSM-end', { nodes: parse_nodes, ways: parse_ways });
	if (loadingcounter<=0) {
		loadingcounter = 0;
		$( "#loading_cont" ).delay(500).fadeOut(100);
	};
}


function parseOSMlowZoom(data, isLatest)
{
	StreetLightsLowZoomLayer.setData({max: 8, data:[]});
	//console.log(data);
	let MarkerArray = new Array();
	let CoordObj = new Object();
	
	let iconClass = "light_13";
	let iconSize = 8;
	let LightsData = []
	
	if (data === false) {
		// clear low zoom cache reference if requested
		if (isLatest) {
			g_latestCall.keys = new Set();
		}
		return;
	}

	// Defensive guard: skip if response is not XML or excessively large
	if (data && typeof data === 'object' && data.documentElement && data.documentElement.nodeName && data.documentElement.nodeName.toLowerCase() !== 'osm') {
		console.error('parseOSMlowZoom: invalid XML document, skipping parse');
		if (isLatest) g_latestCall.keys = new Set();
		return;
	}
	if (data && typeof data === 'object' && data.getElementsByTagName) {
		try {
			const nodeCount = (data.getElementsByTagName('node') && data.getElementsByTagName('node').length) || 0;
			if (nodeCount > MAX_PARSE_ELEMENTS) {
				console.error('parseOSMlowZoom: response too large (nodes=' + nodeCount + '), skipping parse');
				if (isLatest) g_latestCall.keys = new Set();
				return;
			}
		} catch(e) {}
	}
	// diagnostic for low-zoom parse
	let low_nodes = 0;
	try { if (data && data.getElementsByTagName) low_nodes = (data.getElementsByTagName('node') && data.getElementsByTagName('node').length) || 0; } catch(e) {}
	diag('parseOSMlowZoom-start', { nodes: low_nodes });
	$(data).find('node').each(function(){
		let EleID = $(this).attr("id");
		let EleCoordArray = new Array();
		let EleLat, EleLon, EleType;
		let EleObj = new Object();

		//Node
		if ($(this).attr("lat"))
		{
			EleLat = $(this).attr("lat");
			EleLon = $(this).attr("lon");
			EleType = "node";
			EleObj["lat"] = EleLat;
			EleObj["lon"] = EleLon;
			CoordObj[EleID] = EleObj;
			let markerLocation = new L.LatLng(EleLat,EleLon);
			let markerIcon = L.divIcon({
				className: iconClass,
				html: '<div style="background-image: url(\'./img/electric_white.svg\');background-repeat: no-repeat;"> </div>',
				iconSize: [iconSize, iconSize],
				iconAnchor:   [0, 0],
				});
			let marker = new L.Marker(markerLocation,{icon : markerIcon});
			// we don't add marker to layer for low zoom here (heatmap uses the LightsData)
			
				// Cache the low-zoom element to avoid duplicate memory entries
				let cacheKey = "node:" + EleID;
				let cacheValue = { type: "node", lat: EleLat, lon: EleLon, count: 1, markers: [], placeholder: true };
				// Do not overwrite an existing full (high-zoom) cache entry with a lightweight placeholder
				if (g_cache.has(cacheKey)) {
					const existing = g_cache.get(cacheKey);
					if (!(existing && existing.markers && existing.markers.length)) {
						cacheAdd(cacheKey, cacheValue, !!isLatest);
					} else {
						if (isLatest) {
							if (!g_latestCall.keys) g_latestCall.keys = new Set();
							g_latestCall.keys.add(cacheKey);
						}
					}
				} else {
					cacheAdd(cacheKey, cacheValue, !!isLatest);
				}
		}
		LightsData.push({"lat" : EleLat, "lng" : EleLon, "count" : 1, "id": EleID});
	});

	//console.log(LightsData)
	let lowZoomData = {
    max: 8,
    data: LightsData
    };
	StreetLightsLowZoomLayer.setData(lowZoomData)
	diag('parseOSMlowZoom-end', { returned: LightsData.length || 0 });

	// fadeout loading icon and reset loading counter
	if (loadingcounter<=0) {
		loadingcounter = 0;
		$( "#loading_cont" ).delay(500).fadeOut(100);
	};
}

function addLatLngDistanceM(EleLat,EleLon,angleDeg,distance) {
	const latRad = EleLat * Math.PI / 180;
	const degLatPerM = 1 / ( 111132.92 - 559.82 * Math.cos( 2 * latRad ) + 1.175 * Math.cos( 4 * latRad ) - 0.0023 * Math.cos( 6 * latRad ) );
	const degLonPerM = 1 / ( 111412.84 * Math.cos ( latRad ) - 93.5 * Math.cos ( 3 * latRad ) + 0.118 * Math.cos ( 5 * latRad ) );
	const angleRad = angleDeg * Math.PI / 180;
	
	let latDistM = 0, lonDistM = 0; // Default fallback values

	
	latDistM = Math.cos ( angleRad ) * distance;
	lonDistM = Math.sin ( angleRad ) * distance;

	EleLat = EleLat * 1 + latDistM * degLatPerM;
	EleLon = EleLon * 1 + lonDistM * degLonPerM;

	return [EleLat , EleLon];
}

function isNumeric(n) {
	return !isNaN(parseFloat(n)) && isFinite(n);
}

function getLightLit(value) {
	let result;
	if (value == "dusk-dawn") {
		result = i18next.t("lamp_time_duskdawn");
	} else if (value == "demand") {
		result = i18next.t("lamp_time_demand");
	} else {
		result = value;
	}
	return result;
}

function getLightMethod(value) {
	let result;
	if (value == "high_pressure_sodium" || value == "high-pressure_sodium" || value == "HPSV" || value == "SON") {
		result =  i18next.t("lamp_method_high_presssure_sodium");
	} else if (value == "low_pressure_sodium" || value == "low-pressure_sodium" || value == "SOX") {
		result =  i18next.t("lamp_method_low_presssure_sodium");
	} else if (value == "sodium" || value == "sodium_vapor") {
		result =  i18next.t("lamp_method_sodium");
	} else if (value == "LED" || value == "led") {
		result =  i18next.t("lamp_method_led");
	} else if (value == "metal_halide" || value == "metal-halide") {
		result =  i18next.t("lamp_method_metal_halide");
	} else if (value == "fluorescent") {
		result =  i18next.t("lamp_method_fluorescent");
	} else if (value == "incandescent") {
		result =  i18next.t("lamp_method_incandescent");
	} else if (value == "mercury") {
		result =  i18next.t("lamp_method_mercury");
	} else if (value == "electric" || value == "electrical") {
		result =  i18next.t("lamp_method_electric");
	} else if (value == "gas" || value == "gaslight") {
		result =  i18next.t("lamp_method_gas");
	} else {
		result = value;
	}
	return result;
}

function getLightMount(value) {
	let result;
	if (value == "straight mast" || value == "straight_mast") {
		result =  i18next.t("lamp_mount_straight_mast");
	} else if (value == "bent mast" || value == "bent_mast") {
		result =  i18next.t("lamp_mount_bent_mast");
	} else if (value == "cast steel mast" || value == "cast_steel_mast") {
		result =  i18next.t("lamp_mount_cast_steel_mast");
	} else if (value == "mast" || value == "pole") {
		result =  i18next.t("lamp_mount_mast");
	} else if (value == "power_pole") {
		result =  i18next.t("lamp_mount_power_pole");
	} else if (value == "wall_mounted" || value == "wall") {
		result =  i18next.t("lamp_mount_wall");
	} else if (value == "suspended" || value == "wire") {
		result =  i18next.t("lamp_mount_wire");
	} else if (value == "ceiling") {
		result =  i18next.t("lamp_mount_ceiling");
	} else if (value == "ground") {
		result =  i18next.t("lamp_mount_ground");
	} else {
		result = value;
	}
	return result;
}

function getMarkerIcon(L,lightSource,lightMethod,lightColour,lightFlash,lightDirection,lightShape,lightHeight,navigationaid,ref) {
	let symbolURL = "electric";
	if (lightSource == "xmas") {
		symbolURL = "xmastree";
	} else if (navigationaid == "beacon") {
		symbolURL = "beacon";
	} else if (lightSource == "floodlight") {
		symbolURL = "floodlight";
		if (lightDirection) {
			symbolURL = "floodlight_directed";
		}
	} else if ((lightSource == "lantern" || lightSource == "aviation") && lightShape == "directed" && lightDirection) {
		symbolURL = "electric_directed";
		if (lightFlash && lightFlash != "no") {
			symbolURL = "electric_directed_flashing";
		}
	} else {
		if (lightFlash && lightFlash != "no") {
			symbolURL = "electric_flashing";
		}
	}

	let colourURL = "";
	
	if (lightColour) {
		// convert Kelvin light temperatures to colour values
		if (lightColour.substr(-1) == "K") {
			let KelvinLength = lightColour.indexOf("K");
			let lightColourK = Number(lightColour.substr(0,KelvinLength));
			if (!lightColourK.isNaN) {
				if (lightColourK <= 2000) {
					colourURL = "_gas";
				} else if (lightColourK <= 2600) {
					colourURL = "_orange";
				} else if (lightColourK <= 3000) {
					colourURL = "_fluorescent";
				} else if (lightColourK <= 4000) {
					colourURL = "_led";
				} else if (lightColourK > 5600) {
					colourURL = "_mercury";
				} else {
					colourURL = "_white";
				}
			}
		}   
		// add verbal colours:
		if (lightColour == "white") {
			colourURL = "_white";
		} else if (lightColour == "orange") {
			colourURL = "_orange";
		} else if (lightColour == "blue") {
			colourURL = "_blue";
		} else if (lightColour == "red") {
			colourURL = "_red";
		} else if (lightColour == "green") {
			colourURL = "_green";
		} else if (lightColour == "yellow") {
			colourURL = "_yellow";
		}
	}
	
	// default/adapted light colours for different light methods:
	if (lightMethod == "LED" || lightMethod == "led") {
		if (!colourURL || colourURL == "_white") {
			colourURL = "_led";
		}
	} else if (lightMethod == "fluorescent") {
		if (!colourURL || colourURL == "_white") {
			colourURL = "_fluorescent"
		}
	} else if (lightMethod == "gas" || lightMethod == "gaslight") {
		if (!colourURL || colourURL == "_orange" || colourURL == "_red") {
			colourURL = "_gas";
		}
	} else if (lightMethod == "metal_halide" || lightMethod == "metal-halide") {
		if (!colourURL) {
			colourURL = "_white";
		}
	} else if (lightMethod == "incandescent") {
		if (!colourURL) {
			colourURL = "_white";
		}
	} else if (lightMethod == "high_pressure_sodium" || lightMethod == "high-pressure_sodium" || lightMethod == "sodium_vapor" || lightMethod == "sodium") {
		if (!colourURL) {
			colourURL = "_orange";
		}
	} else if (lightMethod == "mercury") {
		if (!colourURL && colourURL!="white") {
			colourURL = "_mercury";
		}
	}
	// default light colour for warning lights if unset:
	if (lightSource == "warning") {
		if (!colourURL) {
			colourURL = "_red";
		}
	}
	// default light colours for aviation lights if unset:
	if(navigationaid == "txe") {
		if (!colourURL) {
			colourURL = "_blue";
		}
	} else if(navigationaid == "txc") {
		if (!colourURL) {
			colourURL = "_green";
		}
	} else if(navigationaid == "rwe") {
		if (!colourURL) {
			colourURL = "_white";
		}
	} else if(navigationaid == "rwc") {
		if (!colourURL) {
			colourURL = "_white";
		}
	} else if(navigationaid == "tdz") {
		if (!colourURL) {
			colourURL = "_white";
		}
	} else if(navigationaid == "rgl") {
		if (!colourURL) {
			colourURL = "_yellow";
		}
	} else if(navigationaid == "vasi" || navigationaid == "papi") {
		if (!colourURL) {
			colourURL = "_redwhite";
		}
	} else if(navigationaid == "beacon") {
		colourURL = "_white";
	}
	
	let directionCSS, directionDeg;
	let rotate = 0;
	let iconOffset = 0, iconSize = 0, iconClass = "";
	let zoomClass = 0;
	let refClass = "";
	
	if (map.getZoom() == 19) {
		//if (lightHeight > 10)
		zoomClass = 19;
		refClass = "lamp_ref_19_text";
		if (navigationaid == "beacon") {
			zoomClass = 21;
		} else if (navigationaid == "als" || navigationaid == "papi" || navigationaid == "vasi" || navigationaid == "rwe" || navigationaid == "rwc" || navigationaid == "tdz" || navigationaid == "rgl" || lightSource == "warning") {
			zoomClass = 17;
		} else if (navigationaid) {
			zoomClass = 16
		} else if (lightHeight >= 10) {
			zoomClass = 21;
		} else if (lightHeight >= 7) {
			zoomClass = 20;
		} else if (lightHeight <= 4) {
			zoomClass = 18;
		} else if (lightHeight <= 2) {
			zoomClass = 17;
		}
	} else if (map.getZoom() == 18) {  
		zoomClass = 18;
		refClass = "lamp_ref_18_text";
		if (navigationaid == "beacon") {
			zoomClass = 21;
		} else if (navigationaid == "als" || navigationaid == "papi" || navigationaid == "vasi" || navigationaid == "rwe" || navigationaid == "rwc" || navigationaid == "tdz" || navigationaid == "rgl" || lightSource == "warning") {
			zoomClass = 16;
		} else if (navigationaid) {
			zoomClass = 15
		} else if (lightHeight >= 10) {
			zoomClass = 20;
		} else if (lightHeight >= 7) {
			zoomClass = 19;
		} else if (lightHeight <= 4) {
			zoomClass = 17;
		} else if (lightHeight <= 2) {
			zoomClass = 16;
		}
	} else if (map.getZoom() == 17) {
		zoomClass = 17;
		refClass = "lamp_ref_17_text";
		if (navigationaid == "beacon") {
			zoomClass = 20;
		} else if (navigationaid == "als" || navigationaid == "papi" || navigationaid == "vasi" || navigationaid == "rwe" || navigationaid == "rwc" || navigationaid == "tdz" || navigationaid == "rgl" || lightSource == "warning") {
			zoomClass = 15;
		} else if (navigationaid) {
			zoomClass = 14;
		} else if (lightHeight >= 10) {
			zoomClass = 19;
		} else if (lightHeight >= 7) {
			zoomClass = 18;
		} else if (lightHeight <= 4) {
			zoomClass = 16;
		} else if (lightHeight <= 2) {
			zoomClass = 15;
		}
	} else if (map.getZoom() == 16) {
		zoomClass = 16;
		refClass = "lamp_ref_none";
		if (navigationaid == "beacon") {
			zoomClass = 19;
		} else if (navigationaid == "als" || navigationaid == "papi" || navigationaid == "vasi" || navigationaid == "rwe" || navigationaid == "rwc" || navigationaid == "tdz" || navigationaid == "rgl" || lightSource == "warning") {
			zoomClass = 14;
		} else if (navigationaid) {
			zoomClass = 13;
		} else if (lightHeight >= 10) {
			zoomClass = 18;
		} else if (lightHeight >= 7) {
			zoomClass = 17;
		} else if (lightHeight <= 4) {
			zoomClass = 15;
		} else if (lightHeight <= 2) {
			zoomClass = 14;
		}
	} else if (map.getZoom() <= 15) {
		zoomClass = 15;
		refClass = "lamp_ref_none";
		if (navigationaid == "beacon") {
			zoomClass = 18;
		} else if (navigationaid == "als" || navigationaid == "papi" || navigationaid == "vasi" || navigationaid == "rwe" || navigationaid == "rwc" || navigationaid == "tdz" || navigationaid == "rgl" || lightSource == "warning") {
			zoomClass = 13;
		} else if (navigationaid) {
			zoomClass = 12;
		} else if (lightHeight > 0) {
			if (lightHeight >= 10) {
				zoomClass = 17;
			} else if (lightHeight >= 7) {
				zoomClass = 16;
			} else if (lightHeight <= 4) {
				zoomClass = 14;
			} else if (lightHeight <= 2) {
				zoomClass = 13;
			}
		}
	}
	if (zoomClass == 21) {
		iconClass = "light_21 " + iconClass;
		iconOffset = 52;
		iconSize = 104;
		refClass = "lamp_ref_21 " + refClass;
	} else if (zoomClass == 20) {
		iconClass = "light_20 " + iconClass;
		iconOffset = 46;
		iconSize = 92;
		refClass = "lamp_ref_20 " + refClass;
	} else if (zoomClass == 19) {
		iconClass = "light_19 " + iconClass;
		iconOffset = 40;
		iconSize = 80;
		refClass = "lamp_ref_19 " + refClass;
	} else if (zoomClass == 18) {
		iconClass = "light_18 " + iconClass;
		iconOffset = 34;
		iconSize = 68;
		refClass = "lamp_ref_18 " + refClass;
	} else if (zoomClass == 17) {
		iconClass = "light_17 " + iconClass;
		iconOffset = 28;
		iconSize = 56;
		refClass = "lamp_ref_17 " + refClass;
	} else if (zoomClass == 16) {
		iconClass = "light_16 " + iconClass;
		iconOffset = 22;
		iconSize = 44;
		refClass = "lamp_ref_16 " + refClass;
	} else if (zoomClass == 15) {
		iconClass = "light_15 " + iconClass;
		iconOffset = 16;
		iconSize = 32;
		refClass = "lamp_ref_15 " + refClass;
	} else if (zoomClass == 14) {
		iconClass = "light_14 " + iconClass;
		iconOffset = 10;
		iconSize = 20;
		refClass = "lamp_ref_14 " + refClass;
	} else if (zoomClass == 13) {
		iconClass = "light_13 " + iconClass;
		iconOffset = 4;
		iconSize = 8;
		refClass = "lamp_ref_13 " + refClass;
	}

	if (lightDirection || lightDirection === 0) {
		let cardinal = new Object();
		cardinal['N'] = 0;
		cardinal['NNE'] = 22.5;
		cardinal['NE'] = 45;
		cardinal['ENE'] = 67.5;
		cardinal['E'] = 90;
		cardinal['ESE'] = 112.5;
		cardinal['SE'] = 135;
		cardinal['SSE'] = 157.5;
		cardinal['S'] = 180;
		cardinal['SSW'] = 202.5;
		cardinal['SW'] = 225;
		cardinal['WSW'] = 247.5;
		cardinal['W'] = 270;
		cardinal['WNW'] = 292.5;
		cardinal['NW'] = 315;
		cardinal['NNW'] = 337.5;

		if (cardinal.hasOwnProperty(lightDirection)) {
			directionDeg = cardinal[lightDirection];
		} else if (lightDirection > 0 && lightDirection <= 360) { // exclude 0 as it is used as fallback anyway
			directionDeg = lightDirection;
		} else {/* ignore to_street  to_crossing */
			directionDeg = 0
		}
	}
	if (directionDeg >= 0 && lightSource == "floodlight") {
		if(directionDeg >= 135 && directionDeg <=360) {
			rotate = directionDeg - 135;
		} else if(directionDeg >= 0 && directionDeg < 135) {
			rotate = directionDeg - 135 + 360;
		}
		let translateX = Math.cos( ( 45 + rotate ) * 2 * Math.PI / 360 ) * Math.sqrt( 2 * iconOffset * iconOffset );
		let translateY = Math.sin( ( 45 + rotate ) * 2 * Math.PI / 360 ) * Math.sqrt( 2 * iconOffset * iconOffset );
		directionCSS = '-ms-transform: translate(' + translateX + 'px,' + translateY + 'px) rotate(' + rotate + 'deg); -webkit-transform: translate(' + translateX + 'px,' + translateY + 'px) rotate(' + rotate + 'deg); transform: translate(' + translateX + 'px,' + translateY + 'px) rotate(' + rotate + 'deg); ';
	} else if (directionDeg >= 0 && (lightSource == "lantern" || lightSource == "aviation")){
		if(directionDeg >= 0 && directionDeg <=360) {
				rotate = directionDeg - 0;
		}
		let translateX = 0;//Math.cos( ( 45 + rotate ) * 2 * Math.PI / 360 ) * Math.sqrt( 2 * 24 * 24 );
		let translateY = 0;//Math.sin( ( 45 + rotate ) * 2 * Math.PI / 360 ) * Math.sqrt( 2 * 24 * 24 );
		directionCSS = '-ms-transform: translate(' + translateX + 'px,' + translateY + 'px) rotate(' + rotate + 'deg); -webkit-transform: translate(' + translateX + 'px,' + translateY + 'px) rotate(' + rotate + 'deg); transform: translate(' + translateX + 'px,' + translateY + 'px) rotate(' + rotate + 'deg); ';
	}
	if ( map.getZoom() < 17)
	{
		ref = "";
	}
	let Icon = L.divIcon({
		className: iconClass,
		html: '<div style="background-image: url(\'./img/' + symbolURL + colourURL + '.svg\');background-repeat: no-repeat;' + directionCSS + '"> </div><span class="' + refClass + '">' + ref + '</span>',
		iconSize: [iconSize, iconSize],
		iconAnchor:   [iconOffset, iconOffset],
		popupAnchor:  [0, -5]
	});
	return Icon;
}
