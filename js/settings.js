// Disable Geolocate button e.g. for non-SSL servers
const SHOW_GEOLOCATE_BUTTON = true;

// Limit the number of lights shown per light_source to reduce clutter e.g. for big flood lights
const LIGHT_COUNT_MAX = 10;

// Set minimum zoom levels for rendering street lights and the lowzoom street lights layer			
const MIN_ZOOM = 15;
const MIN_ZOOM_LOW_ZOOM = 11;

// set default opacity levels;
const OPACITY_NO_DATA = 1.0;
const OPACITY_HAS_DATA = 0.2;
const TIMEOUT = 3600;

// Per-base-layer default opacities when data present / absent.
// Use the layer variables' keys from index.html (e.g. 'OSM_carto').
const LAYER_OPACITY_DEFAULTS = {
	OSM_carto: { hasData: 0.2, noData: 1.0 },
	OSM_hot: { hasData: 0.2, noData: 1.0 },
	OSM_carto_dark: { hasData: 1.0, noData: 1.0 },
	OpenTopoMap: { hasData: 0.2, noData: 1.0 }
};