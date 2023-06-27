export class InDB {
	/**
	 * InDB
	 * @param {object} [options]
	 * @param {string} [options.name] database name
	 * @param {number} [options.version] database version
	 * @param {object[]} [options.stores]
	 * @param {string} [options.stores[].name] store name
	 * @param {string} [options.stores[].primaryKeyPath] store primary keyPath
	 * @param {boolean} [options.stores[].autoIncrement] is store primary keyPath autoIncrement, if true, primary key will be number
	 * @param {boolean} [options.stores[].isKv] is store set to be Key-Value mode, if true, the store will have Storage methods, and `primaryKeyPath` `autoIncrement` not working
	 * @param {object[]} [options.stores[].indexes]
	 * @param {string} [options.stores[].indexes[].name] index name
	 * @param {string} [options.stores[].indexes[].keyPath] index keyPath
	 * @param {boolean} [options.stores[].indexes[].unique] should index value be unique
	 * @returns
	 */
	constructor(options = {}) {
		let { name, version = 1, stores } = options
		const asStorage = !name

		if (!name) {
			name = '__indb__'
		}

		if (!stores || !Array.isArray(stores) || !stores.length) {
			stores = [
				{
					name: '__indb__',
					isKv: true,
				},
			]
		}

		this.cache = {}
		this.connection = null

		this.name = name
		this.version = version
		this.stores = stores

		// update database structure
		const request = indexedDB.open(name, version)
		request.onupgradeneeded = (e) => {
			// @ts-ignore
			const db = e.target.result
			const existStoreNames = Array.from(db.objectStoreNames)
			const passStoreNames = []

			stores.forEach((item) => {
				let objectStore = null
				if (existStoreNames.indexOf(item.name) > -1) {
					// @ts-ignore
					objectStore = e.target.transaction.objectStore(item.name)
				}
				else {
					const keyPath = item.isKv ? 'key' : item.primaryKeyPath
					const autoIncrement = item.isKv ? false : item.autoIncrement
					objectStore = db.createObjectStore(item.name, { keyPath, autoIncrement })
				}

				// delete old indexes
				const indexNames = objectStore.indexNames
				if (indexNames && indexNames.length) {
					Array.from(indexNames).forEach((item) => objectStore.deleteIndex(item))
				}

				// add new indexes
				if (item.indexes && item.indexes.length) {
					item.indexes.forEach((item) => {
						objectStore.createIndex(item.name, item.keyPath || item.name, { unique: item.unique, multiEntry: Array.isArray(item.keyPath) })
					})
				}

				passStoreNames.push(item.name)
			})

			// delete objectStores which is not in config information
			// notice, developers should backup data firstly
			if (existStoreNames) {
				existStoreNames.forEach((item) => {
					if (passStoreNames.indexOf(item) === -1) {
						db.deleteObjectStore(item)
					}
				})
			}
		}
		request.onblocked = (e) => {
			console.error(modifyError(new Error('indexedDB ' + name + ' is blocked')))
		}

		// use as a storage like:
		// const store = new InDB()
		// store.setItem('key', 'value')
		if (asStorage) {
			// @ts-ignore
			return this.use(name)
		}
	}

	connect() {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.name, this.version)
			request.onerror = (e) => {
				reject(modifyError(e))
			}
			request.onsuccess = (e) => {
				// @ts-ignore
				resolve(e.target.result)
			}
		})
	}

	/**
	 *
	 * @param {string} name
	 * @returns {InDBStore}
	 */
	use(name) {
		const currentStore = this.stores.find(item => item.name === name)

		if (!currentStore) {
			throw new Error(`[InDB]: store ${name} is not existing.`)
		}

		// use connected store
		if (this.cache[name]) {
			return this.cache[name]
		}

		const store = new InDBStore({
			db: this,
			store: currentStore,
		})

		// if it is a key-value store, append special methods
		if (currentStore.isKv) {
			Object.defineProperties(store, {
				key: {
					value: i => store.keys().then(keys => keys && keys[i]),
				},
				getItem: {
					value: key => store.get(key).then(obj => obj && obj.value),
				},
				setItem: {
					value: (key, value) => store.put({ key, value }),
				},
				removeItem: {
					value: key => store.delete(key),
				},
			})
		}

		this.cache[name] = store

		return store
	}

	close() {
		this.cache = null
		this.stores = null

		return this.connect().then((db) => {
			db.close()
		})
	}

	static deleteDatabase(name) {
		return new Promise((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name)
			request.onsuccess = () => {
				resolve()
			}
			request.onerror = (e) => {
				reject(e)
			}
		})
	}

	static databases() {
		return indexedDB.databases()
	}
}

export default InDB

class InDBStore {
	constructor(options = {}) {
		const { store, db } = options

		if (typeof store !== 'object' || !store.name || typeof store.name !== 'string') {
			throw new Error(`[InDBStore]: options.store should be a store config object.`)
		}

		if (!(db instanceof InDB)) {
			throw new Error(`[InDBStore]: options.db should be an instanceof InDB.`)
		}

		this.db = db

		this.store = store
		this.name = store.name
		this.primaryKeyPath = store.isKv ? 'key' : store.primaryKeyPath

		this._queue = []
	}

	transaction(writable = false) {
		const create = () => {
			const name = this.name
			const mode = writable ? 'readwrite' : 'readonly'

			// share the same connection
			const connection = this.db.connection
			const deferer = connection ? Promise.resolve(connection) : this.db.connect()
			return deferer.then((db) => {
				this.db.connection = db
				const tx = db.transaction(name, mode)
				const disconnect = () => {
					this.db.connection = null
					this._queue.shift()
				}
				tx.oncomplete = disconnect
				tx.onabort = disconnect
				tx.onerror = disconnect
				return tx
			})
		}

		const latest = this._queue[this._queue.length - 1]
		const deferer = latest ? latest.then(() => create()) : create()
		this._queue.push(deferer)
		return deferer
	}

	objectStore(writable = false) {
		const name = this.name
		return this.transaction(writable).then(tx => tx.objectStore(name))
	}

	cursor(options) {
		const { index, range, direction, onTouch, onDone, onError, writable = false } = options
		return this.objectStore(writable).then((objectStore) => {
			const owner = index ? objectStore.index(index) : objectStore
			const request = owner.openCursor(range, direction)
			request.onsuccess = (e) => {
				const cursor = e.target.result
				if (cursor) {
					onTouch(cursor, owner)
				}
				else {
					onDone(cursor, owner)
				}
			}
			request.onerror = (e) => {
				onError(modifyError(e))
			}
		})
	}

	request(fn, options = {}) {
		const { writable = false } = options
		return new Promise((resolve, reject) => {
			this.objectStore(writable).then((objectStore) => {
				const request = fn(objectStore)
				request.onsuccess = (e) => {
					const result = e.target.result
					resolve(result)
				}
				request.onerror = (e) => {
					reject(modifyError(e))
				}
			})
		})
	}

	iterate(fn, options = {}) {
		const { index, range, writable = false, direction = 'next' } = options
		return new Promise((resolve, reject) => {
			this.cursor({
				index,
				range,
				writable,
				direction,
				onTouch: (cursor, owner) => {
					const next = () => cursor.continue()
					const stop = () => {
						// should commit when writable is true
						owner.transaction.commit()
						resolve()
					}
					fn(cursor, next, stop)
				},
				onDone: () => {
					resolve()
				},
				onError: (e) => {
					reject(e)
				},
			})
		})
	}

	batch(fns, options = {}) {
		const { writable = true } = options
		return this.transaction(writable).then((tx) => {
			const name = this.name
			const promises = []
			const objectStore = tx.objectStore(name)
			fns.forEach((fn) => {
				const deferer = new Promise((resolve, reject) => {
					const request = fn(objectStore)
					request.onsuccess = (e) => {
						const result = e.target.result
						resolve(result)
					}
					request.onerror = (e) => {
						reject(modifyError(e))
					}
				})
				promises.push(deferer)
			})
			return Promise.all(promises)
		})
	}

	// ==========================================

	/**
	 *
	 * @param {string} key
	 * @returns
	 */
	get(key) {
		// single key
		if (!Array.isArray(key)) {
			return this.request(objectStore => objectStore.get(key))
		}

		// multiple keys
		const keys = key
		const fns = keys.map(key => objectStore => objectStore.get(key))
		return this.batch(fns, { writable: false })
	}

	keys() {
		const keyPath = this.primaryKeyPath
		const results = []
		return this.each((obj) => {
			const key = parse(obj, keyPath)
			results.push(key)
		}).then(() => {
			return results
		})
	}

	all() {
		const results = []
		return this.each((obj) => {
			results.push(obj)
		}).then(() => {
			return results
		})
	}

	count() {
		return this.request(objectStore => objectStore.count())
	}

	// ==========================================

	each(fn) {
		return this.iterate((cursor, next) => {
			const obj = cursor.value
			fn(obj)
			next()
		})
	}

	reverse(fn) {
		return this.iterate((cursor, next) => {
			const obj = cursor.value
			fn(obj)
			next()
		}, { direction: 'prev' })
	}

	some(count = 10, offset = 0) {
		return new Promise((resolve, reject) => {
			const results = []
			let i = 0
			let start = offset
			let end = offset + count
			let direction

			// offset < 0, means begining from the latest item,
			// for example, offset = -1, means begining from the last item
			if (offset < 0) {
				direction = 'prev'
				count = Math.min(count, -offset)
				start = -(offset + count) || 0
				end = start + count
			}

			this.iterate((cursor, next, stop) => {
				if (i < start) {
					i ++
					next()
				}
				else if (i < end) {
					results.push(cursor.value)
					i ++
					next()
				}
				else {
					stop()
				}
			}, { direction }).then(() => {
				if (offset < 0) {
					results.reverse()
				}
				resolve(results)
			}).catch(reject)
		})
	}

	first() {
		return this.some(1).then(items => items[0])
	}

	last() {
		return this.some(1, -1).then(items => items[0])
	}

	// =========================

	/**
	 * find a record with given index
	 * @param {string} key index name
	 * @param {*} value
	 * @returns
	 */
	find(key, value) {
		return this.request(objectStore => objectStore.index(key).get(value))
	}
	/**
	 * query several records with given index and compare condition
	 * @param {string} key index name
	 * @param {*} value
	 * @param {string} [compare]
	 * @returns
	 */
	query(key, value, compare) {
		const range = (function() {
			switch (compare) {
				case '>':
					return IDBKeyRange.lowerBound(value, true)
				case '>=':
					return IDBKeyRange.lowerBound(value)
				case '<':
					return IDBKeyRange.upperBound(value, true)
				case '<=':
					return IDBKeyRange.upperBound(value)
				case '%':
				case '!=':
				case 'in':
					return undefined
				default:
					return IDBKeyRange.only(value)
			}
		}())

		const results = []
		return new Promise((resolve, reject) => {
			this.cursor({
				index: key,
				range,
				onTouch: (cursor, owner) => {
					const targetObj = cursor.value
					const keyPath = owner.keyPath
					const targetValue = parse(targetObj, keyPath)

					if (compare === '!=') {
						if (targetValue !== value) {
							results.push(targetObj)
						}
					}
					else if (compare === '%') {
						if (typeof targetValue == 'string' && targetValue.indexOf(value) > -1) {
							results.push(targetObj)
						}
					}
					else if (compare === 'in') {
						if (Array.isArray(value) && value.indexOf(targetValue) > -1) {
							results.push(targetObj)
						}
					}
					else {
						results.push(targetObj)
					}

					cursor.continue()
				},
				onDone: () => {
					resolve(results)
				},
				onError: (e) => {
					reject(e)
				},
			})
		})
	}

	/**
	 * query several records with conditions,
	 * notice that, it works with iterator not with index.
	 * @param {...object[]} rules
	 * @param {string} rules[][].key index name or any keyPath.
	 * @param {*} rules[][].value
	 * @param {string=} rules[][].compare
	 * @param {boolean=} rules[][].optional whether this condition is optional
	 * @returns
	 */
	select(...rules) {
		const currentStore = this.store
		const indexes = currentStore.indexes || []
		const indexesMapping = {}
		indexes.forEach((item) => {
			const { name, keyPath } = item
			indexesMapping[name] = keyPath
		})

		const compareAandB = function(a, b, compare) {
			if (a === undefined) {
				return false
			}
			switch (compare) {
				case '>':
					return a > b
				case '>=':
					return a >= b
				case '<':
					return a < b
				case '<=':
					return a <= b
				case '!=':
					return a !== b
				case '%':
					return typeof a === 'string' && a.indexOf(b) > -1
				case 'in':
					return Array.isArray(b) && b.indexOf(a) > -1
				default:
					return a === b
			}
		}

		const determine = function(obj, and_conditions, or_conditions) {
			if (!and_conditions.length && !or_conditions.length) {
				return false
			}

			for (let i = 0, len = and_conditions.length; i < len; i ++) {
				const { keyPath, value, compare } = and_conditions[i]
				const current = parse(obj, keyPath)
				if (!compareAandB(current, value, compare)) {
					return false
				}
			}

			if (!or_conditions.length) {
				return true
			}

			for (let i = 0, len = or_conditions.length; i < len; i ++) {
				const { keyPath, value, compare } = or_conditions[i]
				const current = parse(obj, keyPath)
				if (compareAandB(current, value, compare)) {
					return true
				}
			}

			return false
		}

		const groups = []
		rules.forEach((conditions) => {
			const or_conditions = []
			const and_conditions = []
			for (let i = 0, len = conditions.length; i < len; i ++) {
				const { key, value, compare, optional } = conditions[i]
				const keyPath = indexesMapping[key] || key // if there is not such index, use original key as keyPath
				if (optional) {
					or_conditions.push({ keyPath, value, compare })
				}
				else {
					and_conditions.push({ keyPath, value, compare })
				}
			}
			groups.push([and_conditions, or_conditions])
		})

		const isOk = (obj) => {
			for (let i = 0, len = groups.length; i < len; i ++) {
				const [and_conditions, or_conditions] = groups[i]
				const res = determine(obj, and_conditions, or_conditions)
				if (res) {
					return true
				}
			}
			return false
		}

		const results = []
		return this.each((obj) => {
			if (isOk(obj)) {
				results.push(obj)
			}
		}).then(() => {
			return results
		})
	}

	// =====================================

	/**
	 * add a record into store
	 * @param {*} obj
	 * @param {string} [key]
	 * @returns
	 */
	add(obj, key) {
		if (Array.isArray(obj)) {
			const objs = obj
			if (objs.length < 2) {
				return this.add(obj[0], key)
			}

			const fns = objs.map(obj => objectStore => objectStore.add(obj, key))
			return this.batch(fns)
		}

		if (!obj) {
			return Promise.resolve()
		}

		return this.request(objectStore => objectStore.add(obj, key), { writable: true })
	}

	/**
	 *
	 * @param {*} obj
	 * @param {string} [key] if not pass, primaryKey will read from obj
	 * @returns
	 */
	put(obj, key) {
		if (Array.isArray(obj)) {
			const objs = obj
			if (objs.length < 2) {
				return this.put(objs[0], key)
			}

			const fns = objs.map(obj => objectStore => objectStore.put(obj, key))
			return this.batch(fns)
		}

		if (!obj) {
			return Promise.resolve()
		}

		return this.request(objectStore => objectStore.put(obj, key), { writable: true })
	}

	delete(key) {
		if (Array.isArray(key)) {
			const keys = key
			if (keys.length < 2) {
				return this.delete(keys[0])
			}

			const fns = keys.map(key => objectStore => objectStore.delete(key))
			return this.batch(fns)
		}

		if (!key) {
			return Promise.resolve()
		}

		return this.request(objectStore => objectStore.delete(key), { writable: true })
	}

	remove(obj) {
		const keyPath = this.primaryKeyPath

		if (Array.isArray(obj)) {
			const objs = obj
			if (objs.length < 2) {
				return this.remove(objs[0])
			}

			const fns = objs.map(obj => {
				const key = parse(obj, keyPath)
				return objectStore => objectStore.delete(key)
			})
			return this.batch(fns)
		}

		if (!obj) {
			return Promise.resolve()
		}

		const key = parse(obj, keyPath)
		if (!key) {
			return Promise.resolve()
		}

		return this.delete(key)
	}

	clear() {
		return this.request(objectStore => objectStore.clear(), { writable: true })
	}
}

function makeKeyChain(path) {
	let chain = path.toString().split(/\.|\[|\]/).filter(item => !!item)
	return chain
}

function parse(obj, path) {
	if (typeof path === 'undefined' || path === null) {
	  return;
	}

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

function modifyError(e) {
	const { message } = e
	e.message = message.indexOf('[IndexedDB]') === -1 ? '[IndexedDB]: ' + message : message
	return e
}
