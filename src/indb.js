import { parse, modifyError } from './utils'

export class InDB {
	constructor(options = {}) {
		let { name, version = 1, stores, timeout } = options

		if (!name) {
			throw new Error('[InDB]: you should pass `name` option.')
		}

		if (!stores || !Array.isArray(stores) || !stores.length) {
			throw new Error('[InDB]: you should pass `stores` option.')
		}

		this.name = name
		this.version = version
		this.stores = stores

		let request = indexedDB.open(name, version)
		// update database structure
		request.onupgradeneeded = (e) => {
			let db = e.target.result
			let existStoreNames = Array.from(db.objectStoreNames)
			let passStoreNames = []

			stores.forEach((item) => {
				let objectStore = null
				if (existStoreNames.indexOf(item.name) > -1) {
					objectStore = e.target.transaction.objectStore(item.name)
				}
				else {
					let keyPath = item.isKeyValue ? 'key' : item.keyPath
					let autoIncrement = item.isKeyValue ? false : item.autoIncrement
					objectStore = db.createObjectStore(item.name, { keyPath, autoIncrement })
				}

				// delete old indexes
				let indexNames = objectStore.indexNames
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
			if (existStoreNames) {
				existStoreNames.forEach((item) => {
					if (passStoreNames.indexOf(item) === -1) {
						db.deleteObjectStore(item)
					}
				})
			}
		}

		this.runtimes = [] // the writable transaction queue
		this.timeout = timeout || 0
		this.used = {}
	}
	db() {
		return new Promise((resolve, reject) => {
			let request = indexedDB.open(this.name, this.version)
			request.onerror = (e) => {
				reject(modifyError(e))
			}
			request.onsuccess = (e) => {
				resolve(e.target.result)
			}
		})
	}
	use(storeName) {
		const { stores, version, name } = this
		const currentStore = stores.find(item => item.name === storeName)

		if (!currentStore) {
			throw new Error(`[InDB]: store ${storeName} is not existing.`)
		}

		// use connected store
		if (this.used[storeName]) {
			return this.used[storeName]
		}

		const store = new InDBStore({
			name,
			version,
			stores,
		})

		store.currentStore = currentStore

		// if it is a key-value store, append special methods
		if (currentStore.isKeyValue) {
			store.key = i => store.keys().then(keys => keys && keys[i])
			store.getItem = key => store.get(key).then(obj => obj && obj.value)
			store.setItem = (key, value) => store.put({ key, value })
			store.removeItem = key => store.delete(key)
		}

		this.used[storeName] = store

		return store
	}
	close() {
		this.runtimes = null
		this.used = null
		this.stores = null

		return this.db().then((db) => {
			db.close()
		})
	}
}

export class InDBStore extends InDB {
	use() {
		throw new Error('[InDBStore]: you can not use `use` method on InDBStore')
	}
	close() {
		throw new Error('[InDBStore]: you can not use `close` method on InDBStore')
	}

	transaction(writable = false) {
		let name = this.currentStore.name
		let mode = writable ? 'readwrite' : 'readonly'
		let runtimes = this.runtimes
		const createRuntime = () => {
			let runtime = {
				mode,
				status: 1,
				resolve: () => {},
				reject: () => {},
				complete: () => {
					let index = runtimes.indexOf(runtime)
					if (index > -1) {
						// delete this runtime from the queue
						runtime.status = 0
						runtimes.splice(index, 1)
					}
				},
			}
			runtime.deferer = new Promise((resolve, reject) => {
				runtime.resolve = resolve
				runtime.reject = reject
			})
			return runtime
		}
		const request = (runtime) => () => {
			return this.db().then((db) => {
				let tx = db.transaction(name, mode)
				tx.oncomplete = () => {
					runtime.resolve()
					runtime.complete()
				}
				tx.onerror = (e) => {
					runtime.reject(modifyError(e))
					runtime.complete()
				}
				tx.onabort = (e) => {
					runtime.resolve() // abort to finish the task
					runtime.complete()
				}
				if (this.timeout > 0) {
					setTimeout(() => {
						if (runtime && runtime.status) {
							runtime.reject(new Error('[InDB]: transaction timeout'))
							runtime.complete()
						}
					}, this.timeout)
				}
				return tx
			})
		}

		let runtime = createRuntime()
		if (writable) {
			let prevRuntime = runtimes.length ? runtimes[runtimes.length - 1] : null
			// push into queue when it is a writable transaction
			runtimes.push(runtime)

			if (!prevRuntime) {
				return request(runtime)()
			}
			// if there is a runtime in queue, wait until it finish
			return prevRuntime.deferer.then(request(runtime)).catch(request(runtime))
		}
		return request(runtime)()
	}
	// =======================================
	objectStore() {
		let name = this.currentStore.name
		return this.transaction().then(tx => tx.objectStore(name))
	}
	keyPath() {
		return this.objectStore().then(objectStore => objectStore.keyPath)
	}
	/**
	 * create a IDB request
	 * @param {function} prepare use current objectStore to return a request
	 * @param {boolean} direct whether to return the request self, if false, will return the request success result, default false
	 * @param {boolean} writable
	 * @example
	 * idb.request(objectStore => objectStore.get(key)).then(obj => console.log(obj))
	 */
	request(prepare, writable = false) {
		let name = this.currentStore.name
		return this.transaction(writable).then((tx) => {
			return new Promise((resolve, reject) => {
				let objectStore = tx.objectStore(name)
				let request = prepare(objectStore)
				request.onsuccess = (e) => {
					let result = e.target.result
					resolve(result)
				}
				request.onerror = (e) => {
					reject(modifyError(e))
				}
			})
		})
	}
	cursor({ index, range, direction, onTouch, onError, writable }) {
		let name = this.currentStore.name
		return this.transaction(writable).then((tx) => {
			let objectStore = tx.objectStore(name)
			let owner = index ? objectStore.index(index) : objectStore
			let request = owner.openCursor(range, direction)

			request.onsuccess = (e) => {
				let result = e.target.result
				onTouch(result, tx, owner)
			}
			request.onerror = (e) => {
				onError(e)
			}
		})
	}
	each(fn) {
		return new Promise((resolve, reject) => {
			let i = 0
			this.cursor({
				onTouch: (cursor) => {
					if (cursor) {
						fn(cursor.value, i)
						i ++
						cursor.continue()
					}
					else {
						resolve(i)
					}
				},
				onError: (e) => {
					reject(modifyError(e))
				},
			})
		})
	}
	reverse(fn) {
		return new Promise((resolve, reject) => {
			let i = 0
			this.cursor({
				direction: 'prev',
				onTouch: (cursor) => {
					if (cursor) {
						fn(cursor.value, i)
						i ++
						cursor.continue()
					}
					else {
						resolve(i)
					}
				},
				onError: (e) => {
					reject(modifyError(e))
				},
			})
		})
	}
	// ==========================================
	get(key) {
		return this.request(objectStore => objectStore.get(key))
	}
	keys() {
		return this.request(objectStore => objectStore.getAllKeys())
	}
	all() {
		return this.request(objectStore => objectStore.getAll())
	}
	count() {
		return this.request(objectStore => objectStore.count())
	}
	// ==========================================
	first() {
		return new Promise((resolve, reject) => {
			this.some(1).then((items) => resolve(items[0])).catch(reject)
		})
	}
	last() {
		return new Promise((resolve, reject) => {
			this.some(1, -1).then((items) => resolve(items[0])).catch(reject)
		})
	}
	some(count = 10, offset = 0) {
		return new Promise((resolve, reject) => {
			let results = []
			let i = 0
			let start = offset
			let end = offset + count
			let direction

			// offset < 0, means begining from the latest item,
			// for example, offset = -1, means begining from the last item
			if (offset < 0) {
				direction = 'prev'
				count = Math.min(count, -offset)
				start = -(offset + count)
				end = start + count
			}

			const success = (results) => {
				if (offset < 0) {
					results.reverse()
				}
				resolve(results)
			}

			this.cursor({
				direction,
				onTouch: (cursor, tx) => {
					if (cursor) {
						if (i < start) {
							cursor.continue()
						}
						else if (i < end) {
							results.push(cursor.value)
							cursor.continue()
						}
						else {
							success(results)
							tx.abort()
						}
						i ++
					}
					else {
						success(results)
					}
				},
				onError: (e) => {
					reject(modifyError(e))
				},
			})
		})
	}
	find(key, value) {
		return this.request(objectStore => objectStore.index(key).get(value))
	}
	query(key, value, compare) {
		let range = (function() {
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
		let results = []
		let i = 0
		return new Promise((resolve, reject) => {
			this.cursor({
				index: key,
				range,
				onTouch: (cursor, tx, owner) => {
					if (cursor) {
						let targetObj = cursor.value
						let keyPath = owner.keyPath
						let targetValue = parse(targetObj, keyPath)
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
						i ++
					}
					else {
						resolve(results)
					}
				},
				onError: (e) => {
					reject(modifyError(e))
				},
			})
		})
	}
	select(conditions) {
		let currentStore = this.currentStore
		let indexes = currentStore.indexes || []
		let indexesMapping = {}
		indexes.forEach((item) => {
			let { name, keyPath } = item
			indexesMapping[name] = keyPath
		})

		let or_conditions = []
		let and_conditions = []
		for (let i = 0, len = conditions.length; i < len; i ++) {
			let { key, value, compare, optional } = conditions[i]
			let keyPath = indexesMapping[key] || key // if there is not such index, use original key as keyPath
			if (optional) {
				or_conditions.push({ keyPath, value, compare })
			}
			else {
				and_conditions.push({ keyPath, value, compare })
			}
		}
		let determine = function(obj) {
			let compareAandB = function(a, b, compare) {
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
			for (let i = 0, len = and_conditions.length; i < len; i ++) {
				let { keyPath, value, compare } = and_conditions[i]
				let current = parse(obj, keyPath)
				if (!compareAandB(current, value, compare)) {
					return false
				}
			}
			for (let i = 0, len = or_conditions.length; i < len; i ++) {
				let { keyPath, value, compare } = or_conditions[i]
				let current = parse(obj, keyPath)
				if (compareAandB(current, value, compare)) {
					return true
				}
			}
			return false
		}
		let results = []
		return this.each((value) => {
			if (determine(value)) {
				results.push(value)
			}
		}).then(() => results)
	}
	// =====================================
	add(obj) {
		return this.request(objectStore => objectStore.add(obj), 'readwrite')
	}
	put(obj) {
		return this.request(objectStore => objectStore.put(obj), 'readwrite')
	}
	delete(key) {
		return this.request(objectStore => objectStore.delete(key), 'readwrite')
	}
	remove(obj) {
		return this.keyPath().then((keyPah) => {
			let key = parse(obj, keyPah)
			if (key === undefined) {
				throw new Error(`[InDB]: your passed object to remove() does not contain keyPath '${keyPah}'.`)
			}
			return this.delete(key)
		})
	}
	clear() {
		return this.request(objectStore => objectStore.clear(), 'readwrite')
	}
}

const idb = new InDB({
	name: 'InDB',
	stores: [
		{
			name: 'InDB',
			isKeyValue: true,
		},
	],
})
const store = idb.use('InDB')

InDB.setItem = store.setItem.bind(store)
InDB.getItem = store.getItem.bind(store)
InDB.removeItem = store.removeItem.bind(store)
InDB.key = store.key.bind(store)

export default InDB
