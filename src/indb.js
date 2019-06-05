import { parse, modifyError } from './utils'

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
	connect() {
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

		const store = new InDBStore({
			db: this,
			store: currentStore,
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

		return this.connect().then((db) => {
			db.close()
		})
	}
}

export class InDBStore {
	constructor(options = {}) {
		const { store, db } = options

		if (typeof store !== 'object' || !store.name || typeof store.name !== 'string') {
			throw new Error(`[InDBStore]: options.store should be a store config object.`)
		}

		if (!(db instanceof InDB)) {
			throw new Error(`[InDBStore]: options.db should be an instanceof InDB.`)
		}

		this.store = store
		this.db = db
		this.name = store.name
		this.keyPath = store.isKeyValue ? 'key' : store.keyPath
	}

	transaction(writable = false) {
		const name = this.name
		const mode = writable ? 'readwrite' : 'readonly'
		return this.db.connect().then(db => db.transaction(name, mode))
	}
	objectStore(writable = false) {
		const name = this.name
		return this.transaction(writable).then(tx => tx.objectStore(name))
	}
	request(create, writable = false) {
		return new Promise((resolve, reject) => {
			this.objectStore(writable).then((objectStore) => {
				const request = create(objectStore)
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
	cursor(options, writable = false) {
		const { index, range, direction, onTouch, onDone, onError } = options
		return this.objectStore(writable).then((objectStore) => {
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
				onError(modifyError(e))
			}
		})
	}

	// =======================================

	each(fn) {
		return new Promise((resolve, reject) => {
			this.cursor({
				onTouch: (cursor) => {
					const obj = cursor.value
					fn(obj)
					cursor.continue()
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
	reverse(fn) {
		return new Promise((resolve, reject) => {
			this.cursor({
				direction: 'prev',
				onTouch: (cursor) => {
					const obj = cursor.value
					fn(obj)
					cursor.continue()
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
	iterate(fn, writable = true) {
		return new Promise((resolve, reject) => {
			this.cursor({
				onTouch: (cursor, tx) => {
					const next = () => cursor.continue()
					const stop = () => tx.abort()
					fn(cursor, next, stop)
				},
				onDone: () => {
					resolve()
				},
				onError: (e) => {
					reject(e)
				},
			}, writable)
		})
	}
	batch(fns, writable = true) {
		return this.transaction(writable).then((tx) => {
			const name = this.name
			const promises = []
			fns.forEach((fn) => {
				const deferer = new Promise((resolve, reject) => {
					const objectStore = tx.objectStore(name)
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

	get(key) {
		const keyPah = this.keyPath

		// single key
		if (!Array.isArray(key)) {
			return this.request(objectStore => objectStore.get(key))
		}

		// multiple keys
		const keys = key
		const fns = keys.map(key => objectStore => objectStore.get(key))
		return this.batch(fns, false)
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
					reject(e)
				},
			})
		})
	}
	first() {
		return this.some(1).then(items => items[0])
	}
	last() {
		return this.some(1, -1).then(items => items[0])
	}
	// =========================
	find(key, value) {
		return this.request(objectStore => objectStore.index(key).get(value))
	}
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
	select(conditions) {
		const currentStore = this.store
		const indexes = currentStore.indexes || []
		const indexesMapping = {}
		indexes.forEach((item) => {
			let { name, keyPath } = item
			indexesMapping[name] = keyPath
		})

		const or_conditions = []
		const and_conditions = []
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
		const determine = function(obj) {
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

		const results = []
		return this.each((value) => {
			if (determine(value)) {
				results.push(value)
			}
		}).then(() => {
			return results
		})
	}

	// =====================================

	add(obj) {
		return this.request(objectStore => objectStore.add(obj), 'readwrite')
	}
	put(obj) {
		// single object
		if (!Array.isArray(obj)) {
			return this.request(objectStore => objectStore.put(obj), 'readwrite')
		}

		// multiple objects
		const objs = obj
		const fns = objs.map(obj => objectStore => objectStore.put(obj))
		return this.batch(fns)
	}
	delete(key) {
		// single key
		if (!Array.isArray(key)) {
			return this.request(objectStore => objectStore.delete(key), 'readwrite')
		}

		// multiple keys
		const keys = key
		const fns = keys.map(key => objectStore => objectStore.delete(key))
		return this.batch(fns)
	}
	remove(obj) {
		const keyPah = this.keyPath

		// single obj
		if (!Array.isArray(obj)) {
			const key = parse(obj, keyPah)
			return this.delete(key)
		}

		// multiple objects
		const objs = obj
		const fns = objs.map(obj => {
			const key = parse(obj, keyPah)
			return objectStore => objectStore.delete(key)
		})
		return this.batch(fns)
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
