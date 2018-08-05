/* global overpassFrontend:false, L */
require('./overpass-layer.css')

const ee = require('event-emitter')
var BoundingBox = require('boundingbox')
var twig = require('twig')
var OverpassFrontend = require('overpass-frontend')
var escapeHtml = require('html-escape')
var isTrue = require('./isTrue')
var Sublayer = require('./Sublayer')
var Memberlayer = require('./Memberlayer')
var compileFeature = require('./compileFeature')

function OverpassLayer (options) {
  var template

  if (!options) {
    options = {}
  }

  this.options = options

  this.overpassFrontend = 'overpassFrontend' in this.options ? this.options.overpassFrontend : overpassFrontend
  this.options.minZoom = 'minZoom' in this.options ? this.options.minZoom : 16
  this.options.maxZoom = 'maxZoom' in this.options ? this.options.maxZoom : null
  this.options.feature = 'feature' in this.options ? this.options.feature : {}
  this.options.feature.style = 'style' in this.options.feature ? this.options.feature.style : {}
  this.options.feature.title = 'title' in this.options.feature ? this.options.feature.title : function (ob) { return escapeHtml(ob.tags.name || ob.tags.operator || ob.tags.ref || ob.id) }
  this.options.feature.body = 'body' in this.options.feature ? this.options.feature.body : ''
  this.options.feature.markerSymbol = 'markerSymbol' in this.options.feature ? this.options.feature.markerSymbol : '<img anchorX="13" anchorY="42" width="25" height="42" signAnchorX="0" signAnchorY="-30" src="img/map_pointer.png">'
  this.options.feature.markerSign = 'markerSign' in this.options.feature ? this.options.feature.markerSign : null
  this.options.queryOptions = 'queryOptions' in this.options ? this.options.queryOptions : {}
  if (!('properties' in this.options.queryOptions)) {
    this.options.queryOptions.properties = OverpassFrontend.ALL
  }
  this.options.styleNoBindPopup = this.options.styleNoBindPopup || []
  this.options.stylesNoAutoShow = this.options.stylesNoAutoShow || []

  compileFeature(this.options.feature, twig)

  this.currentRequest = null
  this.lastZoom = null

  this.mainlayer = new Sublayer(this, options)

  this.subLayers = {
    main: this.mainlayer
  }

  if (this.options.members) {
    this.options.queryOptions.properties = OverpassFrontend.TAGS | OverpassFrontend.META | OverpassFrontend.MEMBERS | OverpassFrontend.BBOX
    this.options.queryOptions.memberProperties = OverpassFrontend.ALL
    this.options.queryOptions.members = true

    let memberOptions = {
      id: this.options.id,
      sublayer_id: 'member',
      minZoom: this.options.minZoom,
      maxZoom: this.options.maxZoom,
      feature: this.options.memberFeature,
      styleNoBindPopup: this.options.styleNoBindPopup || [],
      stylesNoAutoShow: this.options.stylesNoAutoShow || [],
      const: this.options.const
    }
    if (this.options.updateAssets) {
      memberOptions.updateAssets = this.options.updateAssets
    }
    compileFeature(memberOptions.feature, twig)

    this.memberlayer = new Memberlayer(this, memberOptions)
    this.subLayers.member = this.memberlayer
  }
}

OverpassLayer.prototype.addTo = function (map) {
  this.map = map
  this.map.on('moveend', this.check_update_map, this)
  for (let k in this.subLayers) {
    this.subLayers[k].addTo(map)
  }
  this.check_update_map()

  this.map.createPane('hover')
  this.map.getPane('hover').style.zIndex = 499
}

OverpassLayer.prototype.remove = function () {
  var k

  for (let k in this.subLayers) {
    this.subLayers[k].hideAll(true)
    this.subLayers[k].remove()
  }

  this.abortRequest()

  this.map.off('moveend', this.check_update_map, this)
  this.map = null
}

OverpassLayer.prototype.abortRequest = function () {
  if (this.currentRequest) {
    if (this.onLoadEnd) {
      this.onLoadEnd({
        request: this.currentRequest,
        error: 'abort'
      })
    }

    this.currentRequest.abort()
    this.currentRequest = null
  }
}

OverpassLayer.prototype.check_update_map = function () {
  var bounds = new BoundingBox(this.map.getBounds())
  var k
  var ob

  if (this.map.getZoom() < this.options.minZoom ||
     (this.options.maxZoom !== null && this.map.getZoom() > this.options.maxZoom)) {
    for (let k in this.subLayers) {
      this.subLayers[k].hideAll()
    }

    // abort remaining request
    this.abortRequest()

    return
  }

  for (let k in this.subLayers) {
    this.subLayers[k].hideNonVisible(bounds)
  }

  // When zoom level changed, update visible objects
  if (this.lastZoom !== this.map.getZoom()) {
    for (let k in this.subLayers) {
      this.subLayers[k].zoomChange()
    }
    this.lastZoom = this.map.getZoom()
  }

  // Abort current requests (in case they are long-lasting - we don't need them
  // anyway). Data which is being submitted will still be loaded to the cache.
  this.abortRequest()

  var query = this.options.query
  if (typeof query === 'object') {
    query = query[Object.keys(query).filter(function (x) { return x <= this.map.getZoom() }.bind(this)).reverse()[0]]
  }

  if (!query) {
    return
  }

  for (let k in this.subLayers) {
    this.subLayers[k].startAdding()
  }

  if (this.options.members) {
    this.options.queryOptions.memberBounds = bounds
    this.options.queryOptions.memberCallback = (err, ob) => {
      if (err) {
        return console.error('unexpected error', err)
      }

      this.memberlayer.add(ob)
    }
  }

  this.currentRequest = this.overpassFrontend.BBoxQuery(query, bounds,
    this.options.queryOptions,
    function (err, ob) {
      if (err) {
        console.log('unexpected error', err)
      }

      this.mainlayer.add(ob)

    }.bind(this),
    function (err) {
      if (err === 'abort') {
        return
      }

      if (this.onLoadEnd) {
        this.onLoadEnd({
          request: this.currentRequest,
          error: err
        })
      }

      for (let k in this.subLayers) {
        this.subLayers[k].finishAdding()
      }

      this.currentRequest = null
    }.bind(this)
  )

  if (this.onLoadStart) {
    this.onLoadStart({
      request: this.currentRequest
    })
  }
}

OverpassLayer.prototype.recalc = function () {
  for (let k in this.subLayers) {
    this.subLayers[k].recalc()
  }
}

OverpassLayer.prototype.scheduleReprocess = function (id) {
  for (let k in this.subLayers) {
    this.subLayers[k].scheduleReprocess(id)
  }
}

OverpassLayer.prototype.updateAssets = function (div, objectData) {
  for (let k in this.subLayers) {
    this.subLayers[k].updateAssets(div, objectData)
  }
}

OverpassLayer.prototype.get = function (id, callback) {
  var done = false

  this.overpassFrontend.get(id,
    {
      properties: OverpassFrontend.ALL
    },
    function (err, ob) {
      if (err === null) {
        callback(err, ob)
      }

      done = true
    }.bind(this),
    function (err) {
      if (!done) {
        callback(err, null)
      }
    }
  )
}

OverpassLayer.prototype.show = function (id, options, callback) {
  let sublayer = this.mainlayer
  if (options.sublayer_id) {
    sublayer = this.subLayers[options.sublayer_id]
  }

  let request = sublayer.show(id, options, callback)
  let result = {
    id: id,
    sublayer_id: options.sublayer_id,
    options: options,
    hide: request.hide
  }

  return result
}

OverpassLayer.prototype.hide = function (id) {
  this.mainlayer.hide(id)
}

OverpassLayer.prototype.openPopupOnObject = function (ob, sublayer='main') {
  this.subLayers[sublayer].openPopupOnObject(ob)
}

ee(OverpassLayer.prototype)

// to enable extending twig
OverpassLayer.twig = twig

module.exports = OverpassLayer
