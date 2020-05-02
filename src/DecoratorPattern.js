/* global L */

const isTrue = require('./isTrue')
const styleToLeaflet = require('./styleToLeaflet')
const parseLength = require('./parseLength')

class DecoratorPattern {
  constructor (layer) {
    this.layer = layer

    this.layer.on('update', this.processObject.bind(this))
    this.layer.on('remove', this.removeObject.bind(this))
  }

  parseType (key, value, twigData) {
    switch (key) {
      case 'polygon':
      case 'rotate':
        return isTrue(value)
      case 'pixelSize':
      case 'repeat':
      case 'offset':
      case 'endOffset':
      case 'lineOffset':
        return parseLength(value, twigData.map.metersPerPixel)
      case 'angleCorrection':
      case 'headAngle':
        return parseFloat(value)
      default:
        return value
    }
  }

  processObject (object, data) {
    if (!data.patternFeatures) {
      data.patternFeatures = {}
    }

    for (var k in data.features) {
      const def = k === 'default' ? data.data.style : data.data['style:' + k]

      if (data.styles.includes(k)) {
        let patternTypes = {}
        let patternOptions = []
        let symbolOptions = {}

        for (const k in def) {
          const m = k.match(/^pattern([^-]*)$/)
          if (m) {
            patternTypes[m[1]] = def[k]
            patternOptions[m[1]] = {}
            symbolOptions[m[1]] = {}
          }
        }

        for (const k in def) {
          const m1 = k.match(/^pattern([^-]*)-path-(.*)$/)
          const m2 = k.match(/^pattern([^-]*)-(.*)$/)

          if (m1) {
            symbolOptions[m1[1]][m1[2]] = def[k]
          } else if (m2) {
            patternOptions[m2[1]][m2[2]] = this.parseType(m2[2], def[k], data.twigData)
          }
        }

        let patternIds = Object.keys(patternTypes)
        let patterns = []
        patternIds.forEach(patternId => {
          let symbol
          let options = patternOptions[patternId]
          options.pathOptions = styleToLeaflet(symbolOptions[patternId], data.twigData)

          switch (patternTypes[patternId]) {
            case 'dash':
              symbol = L.Symbol.dash(options)
              break
            case 'arrowHead':
              symbol = L.Symbol.arrowHead(options)
              break
            case 'marker':
              symbol = L.Symbol.marker(options)
              break
            default:
              // TODO
          }

          if (symbol) {
            patternOptions[patternId].symbol = symbol
            patterns.push(patternOptions[patternId])
          }
        })

        if (!data.patternFeatures[k]) {
          data.patternFeatures[k] = L.polylineDecorator(data.features[k])
          data.patternFeatures[k].addTo(this.layer.map)
        }

        data.patternFeatures[k].setPatterns(patterns)

        if (this.layer._shallBindPopupToStyle(k)) {
          data.patternFeatures[k].bindPopup(data.popup)
        }
      } else {
        if (data.patternFeatures[k]) {
          this.layer.map.removeLayer(data.patternFeatures[k])
          delete data.patternFeatures[k]
        }
      }
    }
  }

  removeObject (object, data) {
    if (!data.patternFeatures) {
      return
    }

    for (var k in data.features) {
      if (data.patternFeatures[k]) {
        this.layer.map.removeLayer(data.patternFeatures[k])
        delete data.patternFeatures[k]
      }
    }
  }
}

module.exports = DecoratorPattern
