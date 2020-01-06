export function makeKeyChain(path) {
  let chain = path.toString().split(/\.|\[|\]/).filter(item => !!item)
  return chain
}
export function parse(obj, path) {
  if (Array.isArray(path)) {
    for (let i = 0, len = path.length; i < len; i ++) {
      const item = path[i]
      const res = parse(obj, item)
      if (res !== undefined) {
        return res
      }
    }
    return
  }

  let chain = makeKeyChain(path)

  if (!chain.length) {
    return obj
  }

  let target = obj
  for (let i = 0, len = chain.length; i < len; i ++) {
    let key = chain[i]
    if (target[key] === undefined) {
      return
    }
    target = target[key]
  }
  return target
}

export function modifyError(e) {
  const { message } = e
  e.message = message.indexOf('[IndexedDB]') === -1 ? '[IndexedDB]: ' + message : message
  return e
}
