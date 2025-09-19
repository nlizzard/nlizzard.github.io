/**
 * Butterfly
 * Lazyload filter
 * Replace src with data-lazy-src for lazy loading
 */

'use strict'

const urlFor = require('hexo-util').url_for.bind(hexo)

const lazyload = htmlContent => {
  if (hexo.theme.config.lazyload.native) {
    // Use more precise replacement: only replace img tags in HTML, not content inside script tags
    return htmlContent.replace(/(<img(?![^>]*?\bloading=)(?:\s[^>]*?)?>)(?![^<]*<\/script>)/gi, match => {
      return match.replace(/>$/, ' loading=\'lazy\'>')
    })
  }

  const bg = hexo.theme.config.lazyload.placeholder ? urlFor(hexo.theme.config.lazyload.placeholder) : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

  // Use more precise replacement: handle src attributes with double and single quotes, but avoid replacing content inside script tags
  let result = htmlContent

  // Handle src attributes with double quotes
  result = result.replace(/(<img(?![^>]*?\bdata-lazy-src=)(?:\s[^>]*?)?\ssrc="([^"]+)")(?![^<]*<\/script>)/gi, (match, tag, src) => {
    return tag.replace(`src="${src}"`, `src="${bg}" data-lazy-src="${src}"`)
  })

  // Handle src attributes with single quotes
  result = result.replace(/(<img(?![^>]*?\bdata-lazy-src=)(?:\s[^>]*?)?\ssrc='([^']+)')(?![^<]*<\/script>)/gi, (match, tag, src) => {
    return tag.replace(`src='${src}'`, `src='${bg}' data-lazy-src='${src}'`)
  })

  return result
}

hexo.extend.filter.register('after_render:html', data => {
  const { enable, field } = hexo.theme.config.lazyload
  if (!enable || field !== 'site') return
  return lazyload(data)
})

hexo.extend.filter.register('after_post_render', data => {
  const { enable, field } = hexo.theme.config.lazyload
  if (!enable || field !== 'post') return
  data.content = lazyload(data.content)
  return data
})
