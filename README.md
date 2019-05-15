# InDB

A library to operate IndexedDB easily.

## Install

```
npm install --save indb
```

## Usage

ES6:

```js
import InDB from 'indb'
```

CommonJS:

```js
const { InDB } = require('indb')
```

AMD:

```html
<script src="dist/indb.js"></script>
<script>
define(function(require) {
  const { InDB } = require('indb')
  // ...
})
</script>
```

Normal Browsers:

```html
<script src="dist/indb.js"></script>
<script>
const { InDB } = window['indb']
</scirpt>
```

How to use:

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
      isKeyValue: true,
    },
  ],
})

const store1 = idb.use('store1')
const store2 = idb.use('store2')

;(async function() {
  await store1.put({ id: 'key1', value: 'value2' })
  let obj = await store1.get('key1')

  await store2.setItem('key', 'value')
})()
```

## InDB

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
      isKeyValue: true,
    },
  ],
})
```

**options**

- name: the name of a indexedDB database. You can see it in your browser dev-tools.
- version: the version of this indexedDB instance.
- stores: an array to define objectStores. At least one store config should be passed.
- timeout: timeout of execute, if an execution out of time, the request throw rejection

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
  isKeyValue: true, // make this store to be key-value store, which can use get(key) to return value directly.
}
// an example of options
const options = {
  name: 'my_indexeddb',
  version: 1,
  stores: [
    store1,
    store2,
  ],
  use: 'store1',
}
const idb = new InDB(options)
```

### db()

Get current database.

```js
let db = await idb.db()
```

### close()

Close current connect.

```js
await idb.close()
```

After you close current connect, all data operation will throw error.

Remember to close database connect if you do not use it any more.

### use(objectStoreName)

_not async function_

Switch to another store, return a new instance of InDB.

```js
let store2 = idb.use('store2')
```

`use` method is the only method which is not an async function.
Here, you will get an instance of `InDBStore`.

## InDBStore

After you create an InDB instance, you should use a store to operate data.

```js
const store = idb.use('storeName')
```

### get(key)

Get a object from indexedDB by its keyPath.

```js
let obj = await store.get('key1')
// { id: 'key1', value: 'value1' }
```

### add(obj)

Append a object into your database.
Notice, obj's properties should contain keyPath.
If obj's keyPath exists in the objectStore, an error will be thrown.
So use `put` instead as possible.

### put(obj)

Update a object in your database.
Notice, your item's properties should contain keyPath.
If the object does not exist, it will be added into the database.
So it is better to use `put` instead of `add` unless you know what you are doing.

### delete(key)

Delete a object by its keyPath.

```js
await store.delete('1000')
```

### clear()

Delete all data. Remember to backup your data before you clean.

### find(indexName, value)

Get the first object whose index name is `key` and value is `value`.
Notice, `key` is a indexName.

```js
let obj = await store.find('name', 'tomy')
// { id: '1001', name: 'tomy', age: 10 }
```

If you find a key which is not in indexes, no results will return.

### query(indexName, value, compare)

Get objects by one name of its indexes key and certain value.
Notice, `key` is a indexName.
i.e.

```js
let objs = await store.query('name', 'GoFei')
// [{ id: '1002', name: 'GoFei', age: 10 }]
// if there are some other records with name equals GoFei, they will be put in the array
```

In which, `name` is an index name in your `options.indexes`, not index key, remember this. So you'd better to pass the name and the key same value when you creat database.

Return an array, which contains objects with key equals value.
If you give a index name which is not in indexes options, no results will return.

**compare**

Choose from `>` `>=` `<` `<=` `=` `!=` `%` `in`.
`%` means 'LIKE', only used for string search.
`in` means 'IN', value should be an array.

Notice `!=` will use `!==`, `=` will use `===`, so you should pass right typeof of value.

### select([{ key, value, compare, optional }])

Select objects with multiple conditions. Pass conditions as an array, each condition item contains:

- key: an object property
- value: the value to be found
- compare: `>` `>=` `<` `<=` `!=` `=` `%`
- optional: wether to make this condition to be an optional, default 'false' which means 'AND' in SQL.

Examples:

```js
// to find objects which amount>10 AND color='red'
let objs = await store.select([
  { key: 'amount', value: 10, compare: '>' },
  { key: 'color', value: 'red' },
])

// to find objects which amount>10 OR amount<6
let objs = await store.select([
  { key: 'amount', value: 10, compare: '>', optional: true },
  { key: 'amount', value: 6, compare: '<', optional: true },
])

// to find objects which amount>10 AND (color='red' OR color='blue')
let objs = await store.select([
  { key: 'amount', value: 10, compare: '>' },
  { key: 'color', value: 'red', optional: true },
  { key: 'color', value: 'blue', optional: true },
])
```

NOTICE: the final logic is `A AND B AND C AND (D OR E OR F)`.

NOTICE: `select` do NOT use index to query data, it will traserve all data in database.

### all()

Get all records from your objectStore.

### first()

Get the first record from current objectStore.

### last()

Get the last record from current objectStore.

### some(count, offset)

Get some records from your objectStore by count.

- count: the count to be return
- offset: from which index to find, default 0, if you set it to be smaller then 0, it will find from the end

```js
let objs = await store.some(3) // get the first 3 records from db
let objs = await store.some(3, 5) // get records whose index in [5, 6, 7] from db
let objs = await store.some(2, -3) // get records whose index in [-3, -2] from db
```

### keys()

Get all primary keys from your objectStore.

### count()

Get all records count.

## Special Methods

### each(fn)

Iterate with cursor:

```js
await store.each((item, i) => {
})
```

- item: the object at the position of cursor
- i

### reverse(fn)

Very like `each` method, but iterate from end to begin.

### objectStore()

Get current objectStore with 'readonly' mode.

```js
let objectStore = await store.objectStore()
let name = objectStore.name
```

### keyPath()

Get keyPath.

```js
let keyPath = await store.keyPath()
```

## Storage

Use like a pure key-value Storage such as localStorage:

```js
await InDB.setItem('name', 'tomy')
let name = await InDB.getItem('name')
await InDB.removeItem('name')
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
