const ee = require('event-emitter')

const styleToLeaflet = require('./styleToLeaflet')
const strToStyle = require('./strToStyle')
const SublayerFeature = require('./SublayerFeature')
const nearestPointOnGeometry = require('nearest-point-on-geometry')

class Sublayer {
  constructor (master, options) {
    this.master = master
    this.options = options

    this.visibleFeatures = {}
    this.shownFeatures = {} // features which are forcibly shown
    this.shownFeatureOptions = {}
    this.lastZoom = null
    this._scheduledReprocesses = {}

    if (!options.feature['style:hover']) {
      options.feature['style:hover'] = {
        color: 'black',
        width: 3,
        opacity: 1,
        radius: 12,
        pane: 'hover'
      }
    }

    if (options.styleNoBindPopup) {
      options.styleNoBindPopup.push('hover')
    } else {
      options.styleNoBindPopup = [ 'hover' ]
    }
    if (options.stylesNoAutoShow) {
      options.stylesNoAutoShow.push('hover')
    } else {
      options.stylesNoAutoShow = [ 'hover' ]
    }
  }

  addTo (map) {
    this.map = map

    this.map.on('popupopen', e => {
      if (e.popup.sublayer === this) {
        this.domUpdateHooks(e.popup._contentNode)
      }
    })
  }

  domUpdateHooks (node) {
    if (node.getAttribute) {
      let id = node.getAttribute('object')
      let sublayerId = node.getAttribute('sublayer') || 'main'

      if (id) {
        node.onmouseover = () => {
          this.master.subLayers[sublayerId].show(id, { styles: [ 'hover'] }, function () {})
        }
        node.onmouseout = () => {
          this.master.subLayers[sublayerId].hide(id)
        }
        node.onclick = () => {
          this.master.subLayers[sublayerId].openPopupOnObject(id)
        }
      }
    }

    let child = node.firstChild
    while (child) {
      this.domUpdateHooks(child)
      child = child.nextSibling
    }
  }

  remove () {
    this.map = null
  }

  startAdding () {
    this.currentRequestFeatures = {}
  }

  add (ob) {
    this.currentRequestFeatures[ob.id] = true

    if (!(ob.id in this.visibleFeatures)) {
      var data = new SublayerFeature(ob, this)

      if (ob.id in this.shownFeatures) {
        data = this.shownFeatures[ob.id]
      } else {
        this._processObject(data)

        this._show(data)
      }

      this.visibleFeatures[ob.id] = data

      if (this.master.layerList) {
        this.master.layerList.addObject(data)
      }
      if (this.master.onAppear) {
        this.master.onAppear(data)
      }

      this.emit('add', ob, data)
    }
  }

  finishAdding () {
    for (var k in this.visibleFeatures) {
      if (!(k in this.currentRequestFeatures)) {
        if (!(k in this.shownFeatures)) {
          this._hide(this.visibleFeatures[k])
        }

        delete this.visibleFeatures[k]
      }
    }
  }

  hideAll (force) {
    for (let k in this.visibleFeatures) {
      let ob = this.visibleFeatures[k]

      if (force || !(ob.id in this.shownFeatures)) {
        this._hide(ob)
      }
    }

    this.visibleFeatures = {}
  }

  // Hide loaded but non-visible objects
  hideNonVisible (bounds) {
    for (let k in this.visibleFeatures) {
      let ob = this.visibleFeatures[k]

      if (!ob.object.intersects(bounds)) {
        if (!(ob.id in this.shownFeatures)) {
          this._hide(ob)
        }

        delete this.visibleFeatures[k]
      }
    }
  }

  get (id, options, callback) {
    let isAborted = false
    let isDone = false

    let result = {
      id, options,
      abort: () => {
        if (isDone) {
          console.log('abort called, although done')
          return
        }

        isAborted = true
        isDone = true
        if (result.request) {
          result.request.abort()
        }
        callback('abort', null)
      }
    }

    if (id in this.visibleFeatures) {
      window.setTimeout(() => {
        isDone = true
        if (!isAborted) {
          callback(null, this.visibleFeatures[id])
        }
      }, 0)
      return result
    }

    if (id in this.shownFeatures) {
      window.setTimeout(() => {
        isDone = true
        if (!isAborted) {
          callback(null, this.shownFeatures[id])
        }
      }, 0)
      return result
    }

    result.request = this.master.get(id, (err, ob) => {
      isDone = true

      if (err) {
        return callback(err)
      }

      if (isAborted) {
        return
      }

      let data
      if (id in this.visibleFeatures) {
        data = this.visibleFeatures[id]
      } else if (id in this.shownFeatures) {
        data = this.shownFeatures[id]
      } else {
        data = new SublayerFeature(ob, this)
      }

      callback(null, data)
    })

    return result
  }


  show (data, options) {
    let isHidden = false
    let result = {
      options,
      hide: () => {
        isHidden = true

        if (id in this.shownFeatures) {
          var i = this.shownFeatureOptions[id].indexOf(options)
          if (i !== -1) {
            this.shownFeatureOptions[id].splice(i, 1)
          }

          if (this.shownFeatureOptions[id].length === 0) {
            this.hide(data)
          } else {
            this._processObject(this.shownFeatures[id])
          }
        }
      }
    }

    if (typeof data === 'string') {
      let request = this.get(data, options, (err, data) => {
        if (isHidden) {
          return
        }

        if (err) {
          return
        }

        let r = this.show(data, options)
        result.hide = r.hide
      })

      result.id = data
      result.hide = () => {
        request.abort()
      }

      return result
    }

    let id = data.id
    result.id = id
    this.shownFeatures[id] = data
    if (!(id in this.shownFeatureOptions)) {
      this.shownFeatureOptions[id] = []
    }

    this.shownFeatureOptions[id].push(options)
    data.isShown = true

    this._processObject(data)

    this._show(data)

    return result
  }

  hide (id) {
    if (typeof id === 'object') {
      id = id.id
    }

    if (id in this.shownFeatures) {
      let data = this.shownFeatures[id]
      delete this.shownFeatures[id]
      delete this.shownFeatureOptions[id]

      if (id in this.visibleFeatures) {
        this._processObject(data)
      } else {
        this._hide(data)
      }
    }
  }

  zoomChange () {
    this.recalc()

    for (let k in this.visibleFeatures) {
      if (this.master.onZoomChange) {
        this.master.onZoomChange(this.visibleFeatures[k])
      }
    }

    this.lastZoom = this.map.getZoom()
  }

  recalc () {
    for (var k in this.visibleFeatures) {
      this._processObject(this.visibleFeatures[k])
    }
  }

  _processObject (data) {
    var k
    var ob = data.object
    var showOptions = {
      styles: []
    }

    if (ob.id in this.shownFeatureOptions) {
      this.shownFeatureOptions[ob.id].forEach(function (opt) {
        if ('styles' in opt) {
          showOptions.styles = showOptions.styles.concat(opt.styles)
        }
      })
    }

    var objectData = this.evaluate(data)

    if (!data.feature) {
      data.feature = ob.leafletFeature({
        weight: 0,
        opacity: 0,
        fillOpacity: 0
      })
    }

    for (k in objectData) {
      var m = k.match(/^style(|:(.*))$/)
      if (m) {
        var styleId = typeof m[2] === 'undefined' ? 'default' : m[2]
        var style = styleToLeaflet(objectData[k])

        if (data.features[styleId]) {
          data.features[styleId].setStyle(style)
        } else {
          data.features[styleId] = ob.leafletFeature(style)
        }

        if ('text' in style && 'setText' in data.features[styleId]) {
          data.features[styleId].setText(null)
          data.features[styleId].setText(style.text, {
            repeat: style.textRepeat,
            offset: style.textOffset,
            below: style.textBelow,
            attributes: {
              'fill': style.textFill,
              'fill-opacity': style.textFillOpacity,
              'font-weight': style.textFontWeight,
              'font-size': style.textFontSize,
              'letter-spacing': style.textLetterSpacing
            }
          })
        }

        if ('offset' in style && 'setOffset' in data.features[styleId]) {
          data.features[styleId].setOffset(style.offset)
        }
      }
    }

    if ('styles' in showOptions) {
      objectData.styles = objectData.styles.concat(showOptions.styles)
    }

    objectData.marker = {
      html: '',
      iconAnchor: [ 0, 0 ],
      iconSize: [ 0, 0 ],
      signAnchor: [ 0, 0 ],
      popupAnchor: [ 0, 0 ]
    }
    if (objectData.markerSymbol) {
      objectData.marker.html += objectData.markerSymbol

      var div = document.createElement('div')
      div.innerHTML = objectData.markerSymbol

      if (div.firstChild) {
        var c = div.firstChild

        objectData.marker.iconSize = [ c.offsetWidth, c.offsetHeight ]
        if (c.hasAttribute('width')) {
          objectData.marker.iconSize[0] = parseFloat(c.getAttribute('width'))
        }
        if (c.hasAttribute('height')) {
          objectData.marker.iconSize[1] = parseFloat(c.getAttribute('height'))
        }

        objectData.marker.iconAnchor = [ objectData.marker.iconSize[0] / 2, objectData.marker.iconSize[1] / 2 ]
        if (c.hasAttribute('anchorx')) {
          objectData.marker.iconAnchor[0] = parseFloat(c.getAttribute('anchorx'))
        }
        if (c.hasAttribute('anchory')) {
          objectData.marker.iconAnchor[1] = parseFloat(c.getAttribute('anchory'))
        }

        if (c.hasAttribute('signanchorx')) {
          objectData.marker.signAnchor[0] = parseFloat(c.getAttribute('signanchorx'))
        }
        if (c.hasAttribute('signanchory')) {
          objectData.marker.signAnchor[1] = parseFloat(c.getAttribute('signanchory'))
        }

        if (c.hasAttribute('popupanchory')) {
          objectData.marker.popupAnchor[0] = parseFloat(c.getAttribute('popupanchorx'))
        }
        if (c.hasAttribute('popupanchory')) {
          objectData.marker.popupAnchor[1] = parseFloat(c.getAttribute('popupanchory'))
        }
      }
    }

    if (objectData.markerSign) {
      let x = objectData.marker.iconAnchor[0] + objectData.marker.signAnchor[0]
      let y = -objectData.marker.iconSize[1] + objectData.marker.iconAnchor[1] + objectData.marker.signAnchor[1]
      objectData.marker.html += '<div class="sign" style="margin-left: ' + x + 'px; margin-top: ' + y + 'px;">' + objectData.markerSign + '</div>'
    }

    if (objectData.marker.html) {
      objectData.marker.className = 'overpass-layer-icon'
      var icon = L.divIcon(objectData.marker)

      if (data.featureMarker) {
        data.featureMarker.setIcon(icon)
        if (data.featureMarker._icon) {
          this.updateAssets(data.featureMarker._icon)
        }
      } else {
        data.featureMarker = L.marker(ob.center, { icon: icon })
      }
    }

    if (data.isShown) {
      for (k in data.features) {
        data.feature.addTo(this.map)
        if (objectData.styles && objectData.styles.indexOf(k) !== -1 && data.styles && data.styles.indexOf(k) === -1) {
          data.features[k].addTo(this.map)
        }
        if (objectData.styles && objectData.styles.indexOf(k) === -1 && data.styles && data.styles.indexOf(k) !== -1) {
          this.map.removeLayer(data.features[k])
        }
      }
    }
    data.styles = objectData.styles

    var popupContent = ''
    popupContent += '<h1>' + objectData.title + '</h1>'
    popupContent += objectData.body

    if ('updateAssets' in this.options) {
      let div = document.createElement('div')
      div.innerHTML = popupContent
      this.updateAssets(div, objectData)
      popupContent = div.innerHTML
    }

    if (data.popup) {
      if (data.popup._contentNode) {
        data.popup._contentNode.innerHTML = popupContent
        this.domUpdateHooks(data.popup._contentNode)
      } else {
        data.popup = data.popup.setContent(popupContent)
      }
    } else {
      data.popup = L.popup().setContent(popupContent)
      data.popup.object = data
      data.popup.sublayer = this

      data.feature.bindPopup(data.popup)
      for (k in data.features) {
        if (this._shallBindPopupToStyle(k)) {
          data.features[k].bindPopup(data.popup)
        }
      }

      if (data.featureMarker) {
        data.featureMarker.bindPopup(data.popup)
      }
    }

    data.id = ob.id
    data.layer_id = this.options.id
    data.data = objectData

    if (this.master.layerList) {
      this.master.layerList.updateObject(data)
    }
    if (this.master.onUpdate) {
      this.master.onUpdate(data)
    }
  }

  evaluate (data) {
    var k
    var ob = data.object

    data.twigData = this.twigData(ob)

    var objectData = {}
    for (k in this.options.feature) {
      if (typeof this.options.feature[k] === 'function') {
        objectData[k] = this.options.feature[k](data.twigData)
      } else {
        objectData[k] = this.options.feature[k]
      }
    }

    var styleIds = []
    for (k in objectData) {
      var m = k.match(/^style(|:(.*))$/)
      if (m) {
        var style = objectData[k]
        var styleId = typeof m[2] === 'undefined' ? 'default' : m[2]

        if (typeof style === 'string' || 'twig_markup' in style) {
          objectData[k] = strToStyle(style)
        }

        if (this.options.stylesNoAutoShow.indexOf(styleId) === -1) {
          styleIds.push(styleId)
        }
      }
    }

    if (!('features' in data)) {
      data.features = {}
    }

    objectData.styles =
      'styles' in objectData ? objectData.styles
        : 'styles' in this.options ? this.options.styles
          : styleIds
    if (typeof objectData.styles === 'string' || 'twig_markup' in objectData.styles) {
      var styles = objectData.styles.trim()
      if (styles === '') {
        objectData.styles = []
      } else {
        objectData.styles = styles.split(/,/)
      }
    }

    return objectData
  }

  twigData (ob) {
    var result = {
      id: ob.id,
      layer_id: this.options.id,
      osm_id: ob.osm_id,
      type: ob.type,
      tags: ob.tags,
      meta: ob.meta,
      members: [],
      'const': this.options.const
    }

    if (ob.memberFeatures) {
      ob.memberFeatures.forEach((member, sequence) => {
        let r = {
          id: member.id,
          sequence,
          type: member.type,
          osm_id: member.osm_id,
          role: ob.members[sequence].role,
          tags: member.tags,
          meta: member.meta
        }

        result.members.push(r)
      })
    }

    if (this.map) {
      result.map = {
        zoom: this.map.getZoom()
      }
    }

    return result
  }

  _shallBindPopupToStyle (styleId) {
    return this.options.styleNoBindPopup.indexOf(styleId) === -1
  }

  _show (data) {
    if (!this.map) {
      return
    }

    data.feature.addTo(this.map)
    for (var i = 0; i < data.styles.length; i++) {
      var k = data.styles[i]
      if (k in data.features) {
        data.features[k].addTo(this.map)
      }
    }

    if (data.featureMarker) {
      data.featureMarker.addTo(this.map)
      this.updateAssets(data.featureMarker._icon)
    }

    data.isShown = true
  }

  _hide (data) {
    for (var k in data.features) {
      this.map.removeLayer(data.features[k])
    }

    if (data.featureMarker) {
      this.map.removeLayer(data.featureMarker)
    }

    if (this.master.layerList) {
      this.master.layerList.delObject(data)
    }
    if (this.master.onDisappear) {
      this.master.onDisappear(data)
    }

    this.emit('remove', data.object, data)

    data.isShown = false
  }

  scheduleReprocess (id) {
    if (!(id in this._scheduledReprocesses)) {
      this._scheduledReprocesses[id] = window.setTimeout(() => {
        delete this._scheduledReprocesses[id]

        if (id in this.visibleFeatures) {
          this._processObject(this.visibleFeatures[id])
        }
      }, 0)
    }
  }

  updateAssets (div, objectData) {
    if (!this.options.updateAssets) {
      return div
    }

    this.options.updateAssets(div, objectData, this)
  }

  openPopupOnObject (ob, options) {
    if (typeof ob === 'string') {
      return this.get(ob, options, (err, ob) => this.openPopupOnObject(ob, options))
    }

    // When object is quite smaller than current view, show popup on feature
    let viewBounds = new BoundingBox(this.map.getBounds())
    let obBounds = new BoundingBox(ob.object.bounds)
    if (obBounds.diagonalLength() * 0.75 < viewBounds.diagonalLength()) {
      return ob.feature.openPopup()
    }

    // otherwise, try to find point on geometry closest to center of view
    let pt = this.map.getCenter()
    let geom = ob.object.GeoJSON()
    let pos = nearestPointOnGeometry(geom, { type: 'Feature', geometry: { type: 'Point', coordinates: [ pt.lng, pt.lat ] } })
    if (pos) {
      pos = pos.geometry.coordinates
      return ob.feature.openPopup([pos[1], pos[0]])
    }

    // no point found? use normal object popup open then ...
    ob.feature.openPopup()
  }
}

ee(Sublayer.prototype)

module.exports = Sublayer
