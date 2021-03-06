'use strict'

const fs = require('fs')
const fp = require('fastify-plugin')
const readFile = fs.readFile
const resolve = require('path').resolve
const join = require('path').join
const HLRU = require('hashlru')
const supportedEngines = ['ejs', 'nunjucks', 'pug', 'handlebars', 'marko', 'ejs-mate', 'mustache']

function fastifyView (fastify, opts, next) {
  if (!opts.engine) {
    next(new Error('Missing engine'))
    return
  }

  const type = Object.keys(opts.engine)[0]
  if (supportedEngines.indexOf(type) === -1) {
    next(new Error(`'${type}' not yet supported, PR? :)`))
    return
  }

  const charset = opts.charset || 'utf-8'
  const engine = opts.engine[type]
  const options = opts.options || {}
  const templatesDir = resolve(opts.templates || './')
  const lru = HLRU(opts.maxCache || 100)
  const includeViewExtension = opts.includeViewExtension || false
  const prod = process.env.NODE_ENV === 'production'
  const renders = {
    marko: viewMarko,
    'ejs-mate': viewEjsMate,
    handlebars: viewHandlebars,
    mustache: viewMustache,
    nunjucks: viewNunjucks,
    _default: view
  }

  fastify.decorateReply('view', renders[type] ? renders[type] : renders._default)

  function getPage (page, extension) {
    if (includeViewExtension) {
      return `${page}.${extension}`
    }
    return page
  }

  function readCallback (that, page, data) {
    return function _readCallback (err, html) {
      if (err) {
        that.send(err)
        return
      }

      let compiledPage
      try {
        compiledPage = engine.compile(html, options)
      } catch (error) {
        that.send(error)
        return
      }
      lru.set(page, compiledPage)

      if (!that.getHeader('content-type')) {
        that.header('Content-Type', 'text/html; charset=' + charset)
      }
      let cachedPage
      try {
        cachedPage = lru.get(page)(data)
      } catch (error) {
        cachedPage = error
      }
      that.send(cachedPage)
    }
  }

  function view (page, data) {
    if (!page) {
      this.send(new Error('Missing page'))
      return
    }

    // append view extension
    page = getPage(page, type)

    const toHtml = lru.get(page)

    if (toHtml && prod) {
      if (!this.res.getHeader('content-type')) {
        this.header('Content-Type', 'text/html; charset=' + charset)
      }
      this.send(toHtml(data))
      return
    }

    // FIXED: 2018-08-02, Euiyeon Kim <ppang327@gmail.com>
    // ERROR: Promise may not be fulfilled with 'undefined' when statusCode is not 204
    // readFile(join(templatesDir, page), 'utf8', readCallback(this, page, data))
    let html
    try {
      html = fs.readFileSync(join(templatesDir, page), 'utf8')
    } catch (err) {
      this.send(err)
      return
    }

    const callback = readCallback(this, page, data)
    callback(null, html)
  }

  function viewEjsMate (page, data) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }
    const confs = Object.assign({}, options)
    if (!confs.settings) {
      confs.settings = {}
    }
    // ejs-mate use views to find layouts
    confs.settings.views = templatesDir
    // setting locals to pass data by
    confs.locals = Object.assign({}, confs.locals, data)
    // append view extension
    page = getPage(page, 'ejs')
    engine(join(templatesDir, page), confs, (err, html) => {
      if (err) return this.send(err)
      this.header('Content-Type', 'text/html; charset=' + charset).send(html)
    })
  }

  function viewNunjucks (page, data) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }
    const env = engine.configure(templatesDir, options)
    // Append view extension.
    page = getPage(page, 'njk')
    env.render(join(templatesDir, page), data, (err, html) => {
      if (err) return this.send(err)
      this.header('Content-Type', 'text/html; charset=' + charset).send(html)
    })
  }

  function viewMarko (page, data, opts) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }

    // append view extension
    page = getPage(page, type)

    const template = engine.load(join(templatesDir, page))

    if (opts && opts.stream) {
      this.send(template.stream(data))
    } else {
      template.renderToString(data, send(this))
    }

    function send (that) {
      return function _send (err, html) {
        if (err) return that.send(err)
        that.header('Content-Type', 'text/html; charset=' + charset).send(html)
      }
    }
  }

  function viewHandlebars (page, data) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }

    const toHtml = lru.get(page)

    if (toHtml && prod) {
      if (!this.res.getHeader('content-type')) {
        this.header('Content-Type', 'text/html; charset=' + charset)
      }
      this.send(toHtml(data))
      return
    }

    readFile(join(templatesDir, page), 'utf8', readCallback(this, page, data))
  }

  function viewMustache (page, data, opts) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }

    const options = Object.assign({}, opts)

    // append view extension
    page = getPage(page, 'mustache')

    readFile(join(templatesDir, page), 'utf8', (err, template) => {
      if (err) return this.send(err)
      let html = engine.render(template, data, options.partials)
      this.header('Content-Type', 'text/html; charset=' + charset).send(html)
    })
  }

  next()
}

module.exports = fp(fastifyView, { fastify: '^1.1.0' })
