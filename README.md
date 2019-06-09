# InDB

A library to operate IndexedDB easily.

## Install

```
npm i indb
```

ES:

```js
import InDB from '../node_modules/indb/src/indb.js'
```

Webpack:

```js
import InDB from 'indb'
```

CommonJS:

```js
const { InDB } = require('indb')
```

UMD:

```html
<script src="node_modules/indb/dist/indb.js"></script>
<script>
const { InDB } = window['indb']
</script>
```

## Usage

```js
const idb = new InDB({
  name: 'mydb',
  version: 1,
  stores: [
    {
      name: 'store1',
      keyPath: 'id',
    },
    {
      name: 'store2',
      isKv: true,
    },
  ],
})

const store1 = idb.use('store1')
const store2 = idb.use('store2')

;(async function() {
  // put and get data
  await store1.put({ id: 'key1', value: 'value2' })
  const obj = await store1.get('key1')

  // use like key-value storage (as localStorage do)
  await store2.setItem('key', 'value')
})()
```

## InDB

```js
const idb = new InDB(options)
```

**options**

- name: string, the name of a indexedDB database
- version: positive int, the version of this indexedDB instance.
- stores: array, to define objectStores
  - name: string, store name
  - keyPath: string, store primary keyPath
  - autoIncrement
  - indexes: array, to define store index
    - name: string, index name
    - keyPath: string, index keyPath
    - unique: boolean, whether the keyPath value should be unique
  - isKv: boolean, whether to make it a key-value store, if set true, other options will be ignored

Example:

```js
// an example of index config
const index1 = {
  name: 'id', // required
  keyPath: 'id', // optional
  unique: true, // optional
}
const index2 = ...
const index3 = ...
// an example of store config which has indexes
const store1 = {
  name: 'store1', // required, objectStore name
  keyPath: 'id', // required, objectStore keyPath
  indexes: [ // optional
    index1,
    index2,
    index3,
  ],
}
// an example of key-value store config
const store2 = {
  name: 'store2',
  isKv: true, // make this store to be key-value store, which can use get(key) to return value directly.
}
// an example of options
const options = {
  name: 'my_indexeddb',
  version: 1,
  stores: [
    store1,
    store2,
  ],
}
const idb = new InDB(options)
```

### connect()

Connect and get current database.

```js
let db = await idb.connect()
```

### close()

Close current connect.

```js
await idb.close()
```

You do always not need to close connection.
Only be used when different connection come up with conflicts.

### use(objectStoreName)

_not async function_

Return an instance of InDBStore.

```js
const store2 = idb.use('store2')
```

### static deleteDatabase(dbname)

This is a static method of InDB, which is to delete a database from indexedDB.

```js
InDB.deleteDatabase('mydb').then(...)
```

### static databases()

It's a static method to get databases list in a promise.

```js
InDB.databases().then(dbs => ...)
```

## InDBStore

After you create an InDB instance, you should use a store to operate data.

```js
const store = idb.use('storeName')
```

### GET DATA

This part help you to get data from indexedDB.

#### get

Get an object by its keyPath.

```js
const obj = await store.get('keyPath')
// { id: 'keyPath', value: 'value' }
```

#### find

Find an object by `index` (based) and value.

```js
const obj = await store.find('indexName', 'targetValue')
// { id: 'keyPath', indexName: 'targetValue' }
```

#### query

Get objects by `index` (based) and value and comparation symbol.

```js
const objs = await store.query('age', 10, '>')
// [
//   { id: '1002', name: 'GoFei', age: 10 },
//   { id: '1003', name: 'Ximen', age: 11 },
// ]
```

Supported symbols:

- '>'
- '>='
- '<'
- '<='
- '=': equal, default
- '!=': not equal
- '%': contains substring, LIKE in sql
- 'in': one of the given values, the second parameter should be an array

```js
store.query('name', 'Go', '%') // obj.name.indexOf('Go') > -1
store.query('age', [10, 11], 'in') // [10, 11].includes(obj.age)
```

#### select

Select objects with multiple conditions. Pass conditions as an array, each condition item contains:

- keyPath: an object property key path
- value: the value to be found/compared
- compare: `>` `>=` `<` `<=` `!=` `=` `%` `in`
- optional: wether to make this condition to be an optional, default 'false' which means 'AND' in SQL.

Examples:

```js
// to find objects which amount>10 AND color='red'
store.select([
  { keyPath: 'amount', value: 10, compare: '>' },
  { keyPath: 'color', value: 'red' },
])

// to find objects which amount>10 OR amount<6
store.select([
  { keyPath: 'amount', value: 10, compare: '>', optional: true },
  { keyPath: 'amount', value: 6, compare: '<', optional: true },
])

// to find objects which amount>10 AND (color='red' OR color='blue')
store.select([
  { keyPath: 'amount', value: 10, compare: '>' },
  { keyPath: 'color', value: 'red', optional: true },
  { keyPath: 'color', value: 'blue', optional: true },
])
```

NOTICE: the final logic is `A AND B AND C AND (D OR E OR F)`.
NOTICE: `select` do NOT use index to query data, it will traserve all data in database.

#### all

Get all records.

#### first

Get the first record.

#### last

Get the last record.

#### some

Get some records from your objectStore by count.

- count: the count to be return
- offset: from which index to find, default 0, if you set it to be smaller then 0, it will find from the end

```js
store.some(3) // get the first 3 records
store.some(3, 5) // get records whose index in [5, 6, 7]
store.some(2, -3) // get records whose index in [-3, -2]
```

#### keys

Get all primary keys.

#### count

Get all records count.

### MODIFY DATA

#### add

Append an object into your database.
Notice, obj's properties should contain keyPath.
If obj's keyPath does not exist in the objectStore, an error will be thrown.
Use `put` instead as possible.

#### put

Update an object in your database.
Notice, your item's properties should contain keyPath.
If the object does not exist, it will be added into the database.

#### delete

Delete an object by its keyPath.

```js
await store.delete('1000')
```

#### remove

Delete an object by an object.

```js
await store.remove({ id: '1000' })
```

Use it when you do not know which is its keyPath.

#### clear

Delete all data.
Remember to backup your data before you clean.

### TRASERVE DATA

#### each

Traserve data from begin to end.

```js
store.each((obj) => {
  // ...
})
```

#### reverse

Traserve data from end to begin.

### BATCH MODIFY

`add` `put` `delete` and `remove` have batch ability. You just need to pass an array.

```js
store.put([
  { id: '1', name: 'a' },
  { id: '2', name: 'b' },
])
```

### ATOMIC OPERATION

Some methods are provided to help developers to get atomic API of indexedDB.
However, if you do not know what it do, don't use it.

#### transaction

Create a transaction.

```js
const tx = await store.transaction()
```

### objectStore

Get the objectStore so that you can create a request.

```js
const objectStore = await store.objectStore()
const request = objectStore.put({ ... })
```

#### cursor

Create a cursor to traserve data.

```js
await store.cursor({
  index: 'indexName',
  ranage: null, // [IDBKeyRange](https://developer.mozilla.org/en-US/docs/Web/API/IDBKeyRange)
  direction: 'next', // next or prev
  writable: false, // true or false
  onTouch, // function, (cursor, owner) => {}, `owner` is the owner of cursor (objectStore or index)
  onDone, // function
  onError, // function
})
```

#### iterate

Create a iterator to traserve data.

```js
await store.iterate((cursor, next, stop) => {
  // ...
}, {
  writable: false,
  direction: 'next',
})
```

When you invoke `stop`, the promise resolve.

#### request

Create a request.

```js
await store.request(objectStore => objectStore.add(obj), { writable: true }) // the second parameter is writable
```

#### batch

Create a task to run batch requests.

```js
store.batch([
  objectStore => objectStore.put(obj1),
  objectStore => objectStore.put(obj2),
  objectStore => objectStore.remove(obj3),
], {
  writable: true,
})
```

### KEY-VALUE STORE

If a store is defined as a key-value store by InDB options, it will have Storage APIs: `setItem` `getItem` `removeItem` `key`.

```js
const idb = new InDB({
  name: 'SOME_DB',
  version: 1,
  stores: [
    {
      name: 'kv_store',
      isKv: true, // notice here
    },
  ],
})
const kv = idb.use('kv_store')

kv.setItem('a', 'xxxx')
```

Notice, normal stores do not have these apis.

## Storage

Use like a pure key-value Storage such as localStorage:

```js
const store = new InDB() // do not pass any arguments
await store.setItem('name', 'tomy')
const name = await store.getItem('name')
await store.removeItem('name')
```

## test

To test whether it works, after you clone this repo, run:

```
npm install
npm test
```

Then you can see an opened page and find it works.
The test cases are in [examples/test.html](.examples/test.html).
Notice: you should not open the file directly, or the last test case will fail.
