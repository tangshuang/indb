import { parse, modifyError, pipeline } from './utils'

export class InDB {
	constructor(options = {}) {
		let { name, version = 1, stores } = options

		if (!name) {
			throw new Error('[InDB]: you should pass `name` option.')
		}

		if (!stores || !Array.isArray(stores) || !stores.length) {
			throw new Error('[InDB]: you should pass `stores` option.')
		}

		this.name = name
		this.version = version
		this.stores = stores

		// update database structure
		const request = indexedDB.open(name, version)
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

		this.using = {}
	}
	db() {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.name, this.version)
			request.onerror = (e) => {
				reject(modifyError(e))
			}
			request.onsuccess = (e) => {
				resolve(e.target.result)
			}
		})
	}
	use(name) {
		const currentStore = this.stores.find(item => item.name === name)

		if (!currentStore) {
			throw new Error(`[InDB]: store ${name} is not existing.`)
		}

		// use connected store
		if (this.using[name]) {
			return this.using[name]
		}

		const store = new InDB_Store({
			store: currentStore,
			connection: this,
		})

		// if it is a key-value store, append special methods
		if (currentStore.isKeyValue) {
			store.key = i => store.keys().then(keys => keys && keys[i])
			store.getItem = key => store.get(key).then(obj => obj && obj.value)
			store.setItem = (key, value) => store.put({ key, value })
			store.removeItem = key => store.delete(key)
		}

		this.using[name] = store

		return store
	}
	close() {
		this.using = null
		this.stores = null

		return this.db().then((db) => {
			db.close()
		})
	}
}

export class InDB_Store {
	constructor(options = {}) {
		const { store, connection } = options

		if (typeof store !== 'object' || !store.name || typeof store.name !== 'string') {
			throw new Error(`[InDB_Store]: options.store should be a store config object.`)
		}

		if (!(connection instanceof InDB)) {
			throw new Error(`[InDB_Store]: options.connection should be an instanceof InDB.`)
		}

		this.store = store
		this.connection = connection

		this.runtime = null
	}

	transaction(writable = false) {
		const { name } = this.store
		const mode = writable ? 'readwrite' : 'readonly'

		const create = () => this.connection.db().then(db => db.transaction(name, mode))
		const response = (tx) => new Promise((resolve, reject) => {
			tx.oncomplete = () => {
				resolve()
			}
			tx.onerror = (e) => {
				reject(modifyError(e))
			}
			tx.onabort = (e) => {
				reject(modifyError(e))
			}
		})
		const request = () => create().then((tx) => {
			const deferer = response(tx)
			this.runtime = deferer

			const release = () => {
				this.runtime = null
			}
			deferer.then(release).catch(release)

			return tx
		})

		const deferer = this.runtime ? this.runtime.then(request).catch(request) : request()
		return deferer
	}
	// =======================================
	objectStore() {
		const { name } = this.store
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
		const { name } = this.store
		return this.transaction(writable).then((tx) => {
			return new Promise((resolve, reject) => {
				const objectStore = tx.objectStore(name)
				const request = prepare(objectStore)
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
	cursor({ index, range, direction, onTouch, onDone, onError, writable }) {
		const { name } = this.store
		return this.transaction(writable).then((tx) => {
			const objectStore = tx.objectStore(name)
			const owner = index ? objectStore.index(index) : objectStore
			const request = owner.openCursor(range, direction)

			request.onsuccess = (e) => {
				const cursor = e.target.result
				if (cursor) {
					onTouch(cursor, tx, owner)
				}
				else {
					onDone(cursor, tx, owner)
				}
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
					fn(cursor.value, i)
					i ++
					cursor.continue()
				},
				onDone: () => {
					resolve()
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
					fn(cursor.value, i)
					i ++
					cursor.continue()
				},
				onDone: () => {
					resolve()
				},
				onError: (e) => {
					reject(modifyError(e))
				},
			})
		})
	}
	modify(fn) {
		return new Promise((resolve, reject) => {
			let i = 0
			const res = {
				success: [],
				failure: [],
			}
			this.keyPath().then((keyPah) => {
				this.cursor({
					writable: true,
					onTouch: (cursor) => {
						const value = cursor.value
						const bool = fn(value, i)

						if (bool) {
							const request = cursor.update(value)
							const key = parse(value, keyPah)
							request.onsuccess = () => {
								res.success.push(key)
							}
							request.onerror = (e) => {
								res.failure.push(key)
							}
						}

						i ++
						cursor.continue()
					},
					onDone: () => {
						resolve(res)
					},
					onError: (e) => {
						reject(modifyError(e))
					},
				})
			})
		})
	}
	eliminate(fn) {
		return new Promise((resolve, reject) => {
			let i = 0
			const res = {
				success: [],
				failure: [],
			}
			this.cursor({
				writable: true,
				onTouch: (cursor) => {
					const value = cursor.value
					const bool = fn(value, i)

					if (bool) {
						const request = cursor.delete()
						const key = parse(value, keyPah)
						request.onsuccess = () => {
							res.success.push(key)
						}
						request.onerror = (e) => {
							res.failure.push(key)
						}
					}

					i ++
					cursor.continue()
				},
				onDone: () => {
					resolve(res)
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
				start = -(offset + count) || 0
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
					if (i < start) {
						i ++
						cursor.continue()
					}
					else if (i < end) {
						results.push(cursor.value)
						i ++
						cursor.continue()
					}
					else {
						success(results)
						tx.abort()
					}
				},
				onDone: () => {
					success(results)
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

					i ++
					cursor.continue()
				},
				onDone: () => {
					resolve(results)
				},
				onError: (e) => {
					reject(modifyError(e))
				},
			})
		})
	}
	select(conditions) {
		let currentStore = this.store
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
		// delete multiple
		if (Array.isArray(key)) {
			const keys = key
			return pipeline(keys, (key) => this.delete(key))
		}

		return this.request(objectStore => objectStore.delete(key), 'readwrite')
	}
	remove(obj) {
		// remove multiple
		if (Array.isArray(obj)) {
			const objs = obj
			return pipeline(objs, (obj) => this.remove(obj))
		}

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
