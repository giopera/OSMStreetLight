/*
 Wrapper to migrate existing LayerGroup usage to the new
 leaflet-marker-canvas plugin when available.

 - If `L.MarkersCanvas` exists, this layer will create and manage
   an internal `L.MarkersCanvas` instance and forward add/clear calls.
 - If not available, it falls back to a regular `L.LayerGroup` so
   behavior remains unchanged.
*/
(function() {
  'use strict';

  L.CanvasMarkerLayer = L.Layer.extend({
    initialize: function(options) {
      this.options = options || {};
      this._useCanvas = !!(window.L && L.MarkersCanvas);
      if (this._useCanvas) {
        this._internal = new L.MarkersCanvas(this.options);
      } else {
        this._internal = new L.LayerGroup([], this.options);
      }
    },

    onAdd: function(map) {
      this._map = map;
      // add the internal layer to the map so it participates in events
      map.addLayer(this._internal);
    },

    onRemove: function(map) {
      map.removeLayer(this._internal);
      delete this._map;
    },

    // Keep LayerGroup-like API used across the project
    addLayer: function(layer) {
      if (this._useCanvas && this._internal && this._internal.addMarker) {
        this._internal.addMarker(layer);
      } else if (this._internal && this._internal.addLayer) {
        this._internal.addLayer(layer);
      }
      return this;
    },

    removeLayer: function(layer) {
      if (this._useCanvas && this._internal && this._internal.removeMarker) {
        this._internal.removeMarker(layer);
      } else if (this._internal && this._internal.removeLayer) {
        this._internal.removeLayer(layer);
      }
      return this;
    },

    clearLayers: function() {
      if (this._useCanvas && this._internal && this._internal.clear) {
        this._internal.clear();
      } else if (this._internal && this._internal.clearLayers) {
        this._internal.clearLayers();
      }
      return this;
    },

    // compatibility helpers
    hasLayer: function(layer) {
      if (this._useCanvas && this._internal && this._internal._positionsTree) {
        try {
          // best-effort: check positions tree for marker
          const latLng = layer.getLatLng && layer.getLatLng();
          if (!latLng) return false;
          const res = this._internal._positionsTree.search({
            minX: latLng.lng,
            minY: latLng.lat,
            maxX: latLng.lng,
            maxY: latLng.lat
          });
          return res && res.length > 0;
        } catch (e) {
          return false;
        }
      } else if (this._internal && this._internal.hasLayer) {
        return this._internal.hasLayer(layer);
      }
      return false;
    },

    // expose underlying methods if needed
    getInternalLayer: function() {
      return this._internal;
    }
  });

})();
